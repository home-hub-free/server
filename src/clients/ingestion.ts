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
  | "automation" // an effect/closed-loop rule firing (not a live device report)
  | "dashboard" // user action via the UI
  | "system" // hub-internal (boot restore, schedules)
  | "voice"
  | "llm";

// DeviceLike / SensorLike are the duck-typed inputs shared with the channel
// projection — imported from ./channels to keep a single definition.

/**
 * Reaction-plane hints + audit links carried alongside the TRUE provenance
 * (`source`). The observation plane stores these but NEVER lets them override
 * `source` (see docs/PATTERN_LIFECYCLE.md §D2). Both fields are optional and
 * additive — existing consumers ignore them.
 */
export interface EventMeta {
  /** Set when an enabled effect's WHEN matches this trigger (static coverage,
   * D3). The reaction plane drops the event; memory keeps it for mining. A
   * covered motion trigger stays `source:"device"` — we do NOT relabel it. */
  coveredByEffect?: boolean;
  /** On an effect-driven actuation (`source:"automation"`): the trigger that
   * caused it, so memory/Discovery can reconstruct the exact chain (D6). */
  causedBy?: { nodeId: string; channel: string; correlationId: string };
}

export interface IngestionEvent extends EventMeta {
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
export interface ChannelEvent extends EventMeta {
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

// Per-channel thresholding (Stage 4c, see docs/DATA_CONTRACTS.md). This replaces
// the old blanket per-category mute (`SUPPRESSED_CATEGORIES`, which silenced the
// whole evap-cooler because its continuously-drifting temps woke the agent to
// evaluate-then-do-nothing). Instead we gate PER CHANNEL: a number channel emits
// only when it moves by ≥ threshold since its last emit; boolean/enum channels
// emit only on change. So the cooler regains LLM visibility (fan/water toggles,
// meaningful temp swings) without the sub-0.5°C noise. Override the band via env.
const NUMBER_THRESHOLD = Number(process.env.INGESTION_NUMBER_THRESHOLD ?? 0.5);

// Last value emitted per `${nodeId}:${channel}` — the change/threshold baseline.
const lastEmitted = new Map<string, boolean | number | string>();

/** A number reading is worth emitting if it's the first seen or has moved by at
 * least `threshold` since the last emit. Pure — exported for testing. */
export function crossesThreshold(
  prev: number | undefined,
  next: number,
  threshold: number,
): boolean {
  return prev === undefined || Math.abs(next - prev) >= threshold;
}

/** Test seam: clear the threshold baselines so specs start from a clean slate. */
export function __resetThresholds(): void {
  lastEmitted.clear();
}

/** Decide whether a channel's current value clears its emit gate, and (when it
 * does) advance the baseline. Numbers use the threshold band; everything else
 * emits only on change. */
function shouldEmitChannel(nodeId: string, ch: Channel): boolean {
  const key = `${nodeId}:${ch.key}`;
  const prev = lastEmitted.get(key);
  if (ch.kind === "number") {
    const prevNum = typeof prev === "number" ? prev : undefined;
    if (!crossesThreshold(prevNum, ch.value as number, NUMBER_THRESHOLD)) return false;
  } else if (prev === ch.value) {
    return false;
  }
  lastEmitted.set(key, ch.value);
  return true;
}

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
    // Reaction-plane hints / audit links — only present when set (D2/D6).
    ...(event.coveredByEffect !== undefined ? { coveredByEffect: event.coveredByEffect } : {}),
    ...(event.causedBy ? { causedBy: event.causedBy } : {}),
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
 * Project a node's channels and emit one flat event per channel that clears its
 * threshold gate. Returns the channels actually emitted (so the caller can gate
 * the legacy blob on "did anything meaningful change"). Never throws — channel
 * emits are additive telemetry and must not break a device action.
 */
function emitChannels(
  nodeId: string,
  zone: string,
  channels: Channel[],
  source: IngestionSource,
  meta: EventMeta = {},
): Channel[] {
  const ts = new Date().toISOString();
  const emitted: Channel[] = [];
  for (const ch of channels) {
    if (!shouldEmitChannel(nodeId, ch)) continue;
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
        ...meta,
      });
      emitted.push(ch);
    } catch (err) {
      log(EVENT_TYPES.error, [`ingestion channel publish failed: ${err}`]);
    }
  }
  return emitted;
}

/**
 * Emit a node's per-channel events (threshold-gated) plus the legacy whole-value
 * blob — but only emit the blob when at least one channel cleared its gate (or the
 * node has no scalar channels, e.g. camera, where the blob is the only signal).
 * This is what lets us drop the old per-category mute: a sub-threshold cooler temp
 * tick now emits nothing, a fan toggle or a real temp swing emits both.
 */
function emitNode(
  id: string,
  zone: string,
  value: any,
  unit: string,
  source: IngestionSource,
  channel: IngestionEvent["channel"],
  channels: Channel[],
  meta: EventMeta = {},
): void {
  const emitted = emitChannels(id, zone, channels, source, meta);
  if (channels.length === 0 || emitted.length > 0) {
    emit({ deviceId: id, zone, ts: new Date().toISOString(), value, unit, source, channel, ...meta });
  }
}

/** An actor changed value (manual, auto, or boot-restore). `meta.causedBy` links
 * an effect-driven actuation back to its trigger (D6). */
export function emitDeviceState(device: DeviceLike, source: IngestionSource, meta: EventMeta = {}): void {
  emitNode(device.id, device.zone || "", device.value, device.unit || "", source, "state", deviceToChannels(device), meta);
}

/** A sensor reported a reading / state transition. `meta.coveredByEffect` marks a
 * trigger already crystallized into an effect (D2) — true provenance stays in `source`. */
export function emitSensorEvent(sensor: SensorLike, source: IngestionSource, meta: EventMeta = {}): void {
  emitNode(sensor.id, sensor.zone || "", sensor.value, sensor.unit || "", source, "sensor", sensorToChannels(sensor), meta);
}

/** A device joined or its registry info (name/zone/category) changed. */
export function emitDeviceDeclare(device: DeviceLike): void {
  emitNode(device.id, device.zone || "", device.value, device.unit || "", "device", "declare", deviceToChannels(device));
}
