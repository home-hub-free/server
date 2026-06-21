/**
 * Channel projection — Stage 1 of the data-contract redesign (see
 * docs/DATA_CONTRACTS.md).
 *
 * The target model represents every device/sensor as a unified `Node` carrying a
 * set of typed `Channel`s (each independently an actuator, a sensor, or a setting).
 * This module is the *projection* of today's `Device`/`Sensor` classes into that
 * shape, so the new flat per-channel contract can ship on the ingestion seam
 * (LLM-only) WITHOUT touching firmware, the control plane, or the DB yet.
 *
 * These are pure functions over duck-typed inputs (no `Device`/`Sensor` import) to
 * avoid an import cycle with the class modules and to keep them trivially testable.
 */

export type ChannelRole = "actuator" | "sensor" | "setting";
export type ChannelKind = "boolean" | "number" | "enum";

/**
 * The static shape of a channel — its key/role/kind/unit/range, WITHOUT a live
 * value. This is the single source of truth for "what channels does category X
 * have", shared by:
 *  - the Stage-1 projection (`deviceToChannels`, zips in live values),
 *  - Stage-3 declare synthesis (a legacy device that doesn't self-describe), and
 *  - Stage-3 `/set` routing (which channels are writable and their keys).
 */
export interface ChannelSpec {
  /** "power" | "brightness" | "position" | "fan" | "water" | "target" | ... */
  key: string;
  role: ChannelRole;
  kind: ChannelKind;
  /** Per-channel unit ("C", "%"); omitted when dimensionless. */
  unit?: string;
  range?: { min: number; max: number; step?: number };
  options?: string[];
  writable: boolean;
  /** Device owns this value (blinds/camera position) — no first-ping push. */
  precision?: boolean;
}

/** A channel spec carrying its current value (the projected, live form). */
export interface Channel extends ChannelSpec {
  value: boolean | number | string;
}

/** Duck-typed view of a `Device` — only what the projection needs. */
export interface DeviceLike {
  id: string;
  value: any;
  zone?: string;
  unit?: string;
  name?: string;
  deviceCategory?: string;
}

/** Duck-typed view of a `Sensor`. */
export interface SensorLike {
  id: string;
  value: any;
  zone?: string;
  unit?: string;
  sensorType?: string;
}

const PCT = { min: 0, max: 100, step: 1 };

/**
 * The channel schema for a device category — the static specs, no values. Returns
 * null for unknown/legacy categories so callers can fall back to a generic,
 * value-inferred channel. Keep this in lockstep with the firmware contract in
 * docs/DATA_CONTRACTS.md.
 */
export function channelSchema(category: string | undefined): ChannelSpec[] | null {
  switch (category) {
    case "light":
    case "door":
      return [{ key: "power", role: "actuator", kind: "boolean", writable: true }];

    case "dimmable-light":
      return [{ key: "brightness", role: "actuator", kind: "number", unit: "%", range: PCT, writable: true }];

    case "blinds":
      return [{ key: "position", role: "actuator", kind: "number", unit: "%", range: PCT, writable: true, precision: true }];

    case "camera":
      return [];

    case "evap-cooler":
      return [
        { key: "fan", role: "actuator", kind: "boolean", writable: true },
        { key: "water", role: "actuator", kind: "boolean", writable: true },
        { key: "target", role: "setting", kind: "number", unit: "C", range: { min: 16, max: 30, step: 1 }, writable: true },
        { key: "room-temp", role: "sensor", kind: "number", unit: "C", writable: false },
        { key: "unit-temp", role: "sensor", kind: "number", unit: "C", writable: false },
      ];

    default:
      return null;
  }
}

/** Read one channel's live value out of a device value blob, coerced to its kind.
 * Multi-channel devices (evap-cooler) key into the blob; single-channel devices
 * carry the value directly. */
function readChannelValue(category: string | undefined, spec: ChannelSpec, deviceValue: any): boolean | number {
  const raw = category === "evap-cooler" ? (deviceValue ?? {})[spec.key] : deviceValue;
  return spec.kind === "boolean" ? toBoolean(raw) : toNumber(raw) ?? 0;
}

/** Coerce a possibly-stringy reading to a finite number, else null. */
function toNumber(v: any): number | null {
  const n = typeof v === "boolean" ? (v ? 1 : 0) : Number(v);
  return Number.isFinite(n) ? n : null;
}

/** Coerce a possibly-stringy boolean ('false'/0/'') to a real boolean. */
function toBoolean(v: any): boolean {
  return v === true || v === 1 || v === "true" || v === "1";
}

/**
 * Project a device into its channels. Returns [] for categories with no scalar
 * channels (e.g. camera). The category drives the shape; unknown categories fall
 * back to a single generic channel inferred from the value type.
 */
export function deviceToChannels(device: DeviceLike): Channel[] {
  const specs = channelSchema(device.deviceCategory);
  if (specs) {
    return specs.map((spec) => ({
      ...spec,
      value: readChannelValue(device.deviceCategory, spec, device.value),
    }));
  }

  // Unknown/legacy category: infer a single generic actuator channel from the value.
  const kind: ChannelKind = typeof device.value === "boolean" ? "boolean" : "number";
  const value = kind === "boolean" ? toBoolean(device.value) : toNumber(device.value) ?? 0;
  return [
    { key: "value", role: "actuator", kind, writable: true, value, ...(device.unit ? { unit: device.unit } : {}) },
  ];
}

/** One outbound device request. `channel` is set for channel-addressed requests so
 * the caller can revert just that channel on failure; absent for the legacy
 * whole-value request. */
export interface SetRequest {
  url: string;
  channel?: string;
}

/** Encode a channel value for the `/set?...&value=` query. Booleans go to 1/0 to
 * match the firmware contract; numbers/strings pass through. */
function encodeSetValue(v: any): string | number {
  if (typeof v === "boolean") return v ? 1 : 0;
  return v;
}

/**
 * Build the outbound `/set` request(s) for a device write — the Stage-3
 * compatibility shim's core, isolated here as a pure function so it can be tested
 * without importing the device/socket/camera side-effect modules.
 *
 *  - **legacy** (`channelAware:false`): byte-identical to the historical wire —
 *    `/set?fan=&water=` for the cooler, `/set?value=` otherwise. One request, no
 *    `channel` (so a failure reverts the whole value, as before).
 *  - **channel-aware**: one channel-addressed request per WRITABLE channel. The
 *    multi-channel cooler emits only the channels that changed vs `previous`;
 *    single-channel devices emit their one channel. Camera (no writable channels)
 *    emits nothing.
 */
export function buildSetRequests(opts: {
  ip: string;
  category: string | undefined;
  channelAware: boolean;
  value: any;
  previous?: any;
}): SetRequest[] {
  const base = `http://${opts.ip}`;

  if (!opts.channelAware) {
    if (opts.category === "evap-cooler") {
      return [{ url: `${base}/set?fan=${opts.value.fan}&water=${opts.value.water}` }];
    }
    return [{ url: `${base}/set?value=${opts.value}` }];
  }

  const specs = (channelSchema(opts.category) ?? []).filter((s) => s.writable);

  if (opts.category === "evap-cooler") {
    const next = opts.value ?? {};
    const prev = opts.previous ?? {};
    return specs
      .filter((s) => prev[s.key] !== next[s.key]) // only changed channels
      .map((s) => ({
        url: `${base}/set?ch=${s.key}&value=${encodeSetValue(next[s.key])}`,
        channel: s.key,
      }));
  }

  // Single-value device: its lone writable channel carries the scalar value.
  return specs.map((s) => ({
    url: `${base}/set?ch=${s.key}&value=${encodeSetValue(opts.value)}`,
    channel: s.key,
  }));
}

/**
 * Project a sensor into its channels. The temp/humidity sensor's colon-packed
 * "t:h" reading becomes two separate, unit-tagged number channels.
 */
export function sensorToChannels(sensor: SensorLike): Channel[] {
  switch (sensor.sensorType) {
    case "motion":
    case "presence":
      return [
        { key: "presence", role: "sensor", kind: "boolean", writable: false, value: toBoolean(sensor.value) },
      ];

    case "temp/humidity": {
      const [t, h] = String(sensor.value ?? "").split(":");
      return [
        { key: "temperature", role: "sensor", kind: "number", unit: "C", writable: false, value: toNumber(t) ?? 0 },
        { key: "humidity", role: "sensor", kind: "number", unit: "%", writable: false, value: toNumber(h) ?? 0 },
      ];
    }

    default: {
      // Unknown sensor: emit one generic channel preserving the raw value.
      const kind: ChannelKind = typeof sensor.value === "boolean" ? "boolean" : "number";
      const value = kind === "boolean" ? toBoolean(sensor.value) : toNumber(sensor.value) ?? 0;
      return [
        { key: "value", role: "sensor", kind, writable: false, value, ...(sensor.unit ? { unit: sensor.unit } : {}) },
      ];
    }
  }
}
