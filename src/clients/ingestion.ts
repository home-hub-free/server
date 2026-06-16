import { EVENT_TYPES, log } from "../logger";

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
 * TRANSPORT IS DEFERRED. Per the migration decision, the MQTT publisher is not
 * implemented yet (the broker isn't installed). These functions are the stable
 * interface + hook points; `publish()` is a guarded no-op so the control plane
 * has zero dependency on the brain being up. Stage 1 implements `publish()` only
 * — call sites and payload shapes already exist.
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

interface DeviceLike {
  id: string;
  value: any;
  zone?: string;
  unit?: string;
  name?: string;
  deviceCategory?: string;
}

interface SensorLike {
  id: string;
  value: any;
  zone?: string;
  unit?: string;
  sensorType?: string;
}

export interface IngestionEvent {
  deviceId: string;
  zone: string;
  ts: string;
  value: any;
  unit: string;
  source: IngestionSource;
  channel: "state" | "sensor" | "declare";
}

// Default OFF: the seam exists but emits nothing until Stage 1 wires the broker.
const ENABLED = process.env.INGESTION_ENABLED === "true";

/**
 * Deferred transport. Intentionally a no-op until the MQTT publisher lands.
 * Never throws — ingestion must never break a device action.
 */
function publish(event: IngestionEvent): void {
  if (!ENABLED) return;
  // TODO(Stage 1): publish to MQTT topic
  //   `homehub/${event.zone || "_"}/${event.deviceId}/${event.channel}`
  // with the JSON payload. Until then this is a no-op by design.
}

function emit(event: IngestionEvent): void {
  try {
    publish(event);
  } catch (err) {
    log(EVENT_TYPES.error, [`ingestion publish failed: ${err}`]);
  }
}

/** An actor changed value (manual, auto, or boot-restore). */
export function emitDeviceState(device: DeviceLike, source: IngestionSource): void {
  emit({
    deviceId: device.id,
    zone: device.zone || "",
    ts: new Date().toISOString(),
    value: device.value,
    unit: device.unit || "",
    source,
    channel: "state",
  });
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
}

/** A device joined or its registry info (name/zone/category) changed. */
export function emitDeviceDeclare(device: DeviceLike): void {
  emit({
    deviceId: device.id,
    zone: device.zone || "",
    ts: new Date().toISOString(),
    value: device.value,
    unit: device.unit || "",
    source: "device",
    channel: "declare",
  });
}
