import mqtt, { MqttClient } from "mqtt";
import { EVENT_TYPES, log } from "../logger";
import {
  Channel,
  ChannelKind,
  ChannelRole,
  DeviceLike,
  SensorLike,
  deviceToChannels,
  sensorToChannels,
} from "./channels";

/**
 * Ingestion seam — the hub's producer-side feed into the memory/LLM layer.
 *
 * DESIGN (see PROJECT_STATE.md §7 + the "all memory R/W goes through
 * memory-service" invariant): live device/sensor state is the single most
 * valuable signal for LLM inference, so every authoritative state change is
 * emitted from here. The hub is a *producer only* — it publishes to MQTT
 * (`homehub/<zone>/<deviceId>/<channel>`, payload `{deviceId, zone, ts, value,
 * unit, source}`); Node-RED (mqtt-to-memory / device-registry-sync) translates
 * that into memory-service writes. The hub never touches memory-service or its
 * Postgres/Kuzu directly.
 *
 * TRANSPORT (Stage 1): `publish()` ships events to Mosquitto over MQTT, but only
 * when `INGESTION_ENABLED=true`. The whole seam stays a guarded no-op otherwise,
 * so the control plane has ZERO runtime dependency on the broker/brain being up:
 *  - with the flag unset no client is ever created (tests + default deploys);
 *  - publishes are fire-and-forget QoS 0, gated on a live connection (events are
 *    dropped, never buffered, if the broker is down — this is best-effort
 *    telemetry, not control traffic);
 *  - nothing here ever throws into a device action (`emit` swallows + logs).
 *
 * Params are duck-typed (not `Device`/`Sensor`) to avoid an import cycle with the
 * device/sensor classes.
 */

export type IngestionSource =
  | "device" // an ESP device/sensor event (autonomous)
  | "dashboard" // user action via the UI
  | "system" // hub-internal (boot restore, schedules)
  | "voice"
  | "llm";

// DeviceLike / SensorLike are the duck-typed inputs shared with the channel
// projection — imported from ./channels to keep a single definition.

export interface IngestionEvent {
  deviceId: string;
  zone: string;
  ts: string;
  value: any;
  unit: string;
  source: IngestionSource;
  channel: "state" | "sensor" | "declare";
}

/**
 * The Stage-1 flat per-channel event (see docs/DATA_CONTRACTS.md). One node-state
 * change projects to one of these PER CHANNEL — atomic, typed, unit-tagged, and
 * self-describing, which is what the memory/LLM layer consumes. Published to
 * `homehub/<zone>/<nodeId>/<channel>` alongside the legacy blob event until
 * Node-RED is cut over.
 */
export interface ChannelEvent {
  nodeId: string;
  zone: string;
  channel: string;
  role: ChannelRole;
  kind: ChannelKind;
  value: boolean | number | string;
  unit: string;
  source: IngestionSource;
  ts: string;
}

// Default OFF: the seam exists but emits nothing unless explicitly enabled.
const ENABLED = process.env.INGESTION_ENABLED === "true";
const MQTT_URL = process.env.MQTT_URL || "mqtt://127.0.0.1:1883";

// Per-category mute list. Some devices (notably `evap-cooler`) report
// continuously-changing inside/outside temperatures; feeding every reading to
// the memory/LLM layer just wakes the agent to evaluate-then-do-nothing. We
// suppress those device-state/declare emits here until cooling telemetry is
// redesigned (debounced/threshold-gated). Override via env (comma-separated
// categories); set to empty to re-enable everything.
const SUPPRESSED_CATEGORIES = new Set(
  (process.env.INGESTION_SUPPRESSED_CATEGORIES ?? "evap-cooler")
    .split(",")
    .map((c) => c.trim())
    .filter(Boolean),
);

// Shared client + liveness flag. The client is created lazily the first time the
// seam is used while enabled, so disabled deploys (and the Jest suite) never open
// a socket or keep the event loop alive.
let client: MqttClient | null = null;
let connected = false;

/**
 * ensureClient lazily connects to Mosquitto the first time it's needed while
 * enabled. Returns null when disabled. mqtt.js reconnects on its own; we only
 * track liveness so publishes are dropped (not queued) while the broker is down.
 */
function ensureClient(): MqttClient | null {
  if (!ENABLED) return null;
  if (client) return client;

  client = mqtt.connect(MQTT_URL, {
    clientId: `home-hub-server-${process.pid}`,
    reconnectPeriod: 5000, // retry every 5s; never give up
    connectTimeout: 10_000,
    queueQoSZero: false, // do not buffer telemetry while offline
    clean: true,
  });

  client.on("connect", () => {
    connected = true;
    log(EVENT_TYPES.info, [`ingestion: MQTT connected (${MQTT_URL})`]);
  });
  client.on("reconnect", () => {
    connected = false;
  });
  client.on("close", () => {
    connected = false;
  });
  // Never let a broker error bubble up; just note it and let mqtt.js retry.
  client.on("error", (err) => {
    connected = false;
    log(EVENT_TYPES.error, [`ingestion: MQTT error: ${err.message}`]);
  });

  return client;
}

/**
 * Connect eagerly at boot so the first device event isn't dropped waiting on the
 * handshake. Safe to call when disabled (no-op). Idempotent.
 */
export function initIngestion(): void {
  ensureClient();
}

/**
 * Close the MQTT client (graceful shutdown / test teardown). No-op when nothing
 * was ever opened.
 */
export function closeIngestion(): void {
  if (client) {
    client.end(true);
    client = null;
    connected = false;
  }
}

/**
 * Publish one event to `homehub/<zone>/<deviceId>/<channel>`. Fire-and-forget
 * QoS 0, gated on a live connection — best-effort telemetry, never control
 * traffic. Returns immediately and never throws.
 */
function publish(event: IngestionEvent): void {
  if (!ENABLED) return;
  const c = ensureClient();
  if (!c || !connected) return; // broker not up yet — drop, don't buffer

  const topic = `homehub/${event.zone || "_"}/${event.deviceId}/${event.channel}`;
  const payload = JSON.stringify({
    deviceId: event.deviceId,
    zone: event.zone,
    ts: event.ts,
    value: event.value,
    unit: event.unit,
    source: event.source,
  });
  c.publish(topic, payload, { qos: 0 }, (err) => {
    if (err) log(EVENT_TYPES.error, [`ingestion: publish to ${topic} failed: ${err.message}`]);
  });
}

function emit(event: IngestionEvent): void {
  try {
    publish(event);
  } catch (err) {
    log(EVENT_TYPES.error, [`ingestion publish failed: ${err}`]);
  }
}

/**
 * Publish one flat channel event to `homehub/<zone>/<nodeId>/<channel>`. Same
 * fire-and-forget QoS-0, drop-don't-buffer semantics as `publish()`.
 */
function publishChannel(event: ChannelEvent): void {
  if (!ENABLED) return;
  const c = ensureClient();
  if (!c || !connected) return;

  const topic = `homehub/${event.zone || "_"}/${event.nodeId}/${event.channel}`;
  const payload = JSON.stringify(event);
  c.publish(topic, payload, { qos: 0 }, (err) => {
    if (err) log(EVENT_TYPES.error, [`ingestion: publish to ${topic} failed: ${err.message}`]);
  });
}

/**
 * Project a node's channels and emit one flat event each. Never throws — channel
 * emits are additive telemetry and must not break a device action.
 */
function emitChannels(
  nodeId: string,
  zone: string,
  channels: Channel[],
  source: IngestionSource,
): void {
  const ts = new Date().toISOString();
  for (const ch of channels) {
    try {
      publishChannel({
        nodeId,
        zone: zone || "",
        channel: ch.key,
        role: ch.role,
        kind: ch.kind,
        value: ch.value,
        unit: ch.unit || "",
        source,
        ts,
      });
    } catch (err) {
      log(EVENT_TYPES.error, [`ingestion channel publish failed: ${err}`]);
    }
  }
}

/** An actor changed value (manual, auto, or boot-restore). */
export function emitDeviceState(device: DeviceLike, source: IngestionSource): void {
  if (device.deviceCategory && SUPPRESSED_CATEGORIES.has(device.deviceCategory)) return;
  emit({
    deviceId: device.id,
    zone: device.zone || "",
    ts: new Date().toISOString(),
    value: device.value,
    unit: device.unit || "",
    source,
    channel: "state",
  });
  emitChannels(device.id, device.zone || "", deviceToChannels(device), source);
}

/** A sensor reported a reading / state transition. */
export function emitSensorEvent(sensor: SensorLike, source: IngestionSource): void {
  emit({
    deviceId: sensor.id,
    zone: sensor.zone || "",
    ts: new Date().toISOString(),
    value: sensor.value,
    unit: sensor.unit || "",
    source,
    channel: "sensor",
  });
  emitChannels(sensor.id, sensor.zone || "", sensorToChannels(sensor), source);
}

/** A device joined or its registry info (name/zone/category) changed. */
export function emitDeviceDeclare(device: DeviceLike): void {
  if (device.deviceCategory && SUPPRESSED_CATEGORIES.has(device.deviceCategory)) return;
  emit({
    deviceId: device.id,
    zone: device.zone || "",
    ts: new Date().toISOString(),
    value: device.value,
    unit: device.unit || "",
    source: "device",
    channel: "declare",
  });
  emitChannels(device.id, device.zone || "", deviceToChannels(device), "device");
}
