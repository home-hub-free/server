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
        // unit-temp = the air coming OUT of the unit (outlet/supply probe, not outdoor).
        { key: "unit-temp", role: "sensor", kind: "number", unit: "C", writable: false },
      ];

    // Audio I/O endpoint (docs/VOICE_SATELLITE.md): both channels are `setting`s —
    // never gated by / latching the manual lock (a volume tweak must not freeze
    // automations), and `precision` (the device owns them; NVS-persisted on board,
    // reported back via /device-value-set — the hub never pushes on first ping).
    case "voice-satellite":
      return [
        { key: "volume", role: "setting", kind: "number", unit: "%", range: PCT, writable: true, precision: true },
        { key: "mic", role: "setting", kind: "boolean", writable: true, precision: true },
        // Camera 180° rotation (the board mounts its DVP connector opposite the
        // ESP32-CAM's). Only camera-equipped units ever report the key, and the
        // dashboard hides the control when it's absent from the value blob.
        { key: "flip", role: "setting", kind: "boolean", writable: true, precision: true },
        // Battery % from the board's VBAT divider, self-reported ~5-min/on-change.
        // No range on purpose: -1 = "no battery on the connector" must survive
        // reconcileValueWrite's clamp (the dashboard hides the readout for < 0).
        { key: "battery", role: "sensor", kind: "number", unit: "%", writable: false },
      ];

    // Sensor categories (Stage 4 — the unified Node world treats these the same).
    case "motion":
    case "presence":
      return [{ key: "presence", role: "sensor", kind: "boolean", writable: false }];

    // Combo board: a PIR + an on-board relay on one MCU. One node, two channels —
    // the relay is hub-authoritative (driven by a presence→relay effect, source
    // "automation"), with a firmware fail-safe that closes it locally when the hub
    // is unreachable (reported back as source "device"). See docs/DATA_CONTRACTS.md.
    case "presence-relay":
      return [
        { key: "presence", role: "sensor", kind: "boolean", writable: false },
        { key: "relay", role: "actuator", kind: "boolean", writable: true },
      ];

    case "temp/humidity":
      return [
        { key: "temperature", role: "sensor", kind: "number", unit: "C", writable: false },
        { key: "humidity", role: "sensor", kind: "number", unit: "%", writable: false },
      ];

    default:
      return null;
  }
}

/** Categories whose legacy value blob is a per-channel object (cooler,
 * presence-relay) — as opposed to a scalar or the temp/humidity "t:h" string. The
 * codec keys into these by channel; the `/set` builder emits one request per
 * changed channel. Single point of truth so a new object-blob category rides along
 * everywhere the cooler does. */
export function isObjectBlobCategory(category: string | undefined): boolean {
  return category === "evap-cooler" || category === "presence-relay" || category === "voice-satellite";
}

/**
 * Reconcile a (possibly partial) value write against the node's current value.
 *
 * For **object-blob** categories (evap-cooler, presence-relay) a whole-value write
 * is MERGED into the previous blob rather than replacing it, so a write that omits
 * a channel (e.g. a dashboard fan toggle that doesn't carry `target`) keeps the
 * prior value of every absent channel. This is the structural fix for the cooler
 * losing its `target`/`water` to a partial overwrite. Null/undefined incoming
 * channels are ignored so they can't clobber a good prior value.
 *
 * Ranged numeric channels (the cooler's `target`, 16–30 °C) are CLAMPED into their
 * schema range; a non-finite incoming value (NaN/garbage) is dropped in favour of
 * the prior value (or omitted entirely if there was none). Sensor temps have no
 * range and pass through untouched.
 *
 * Scalar (non-object-blob) categories pass the value through unchanged — a
 * whole-value write there genuinely IS the whole value, so replace is correct.
 */
export function reconcileValueWrite(category: string | undefined, previous: any, incoming: any): any {
  if (!isObjectBlobCategory(category)) return incoming;

  const base: any = previous && typeof previous === "object" ? { ...previous } : {};
  if (incoming && typeof incoming === "object") {
    for (const [k, v] of Object.entries(incoming)) {
      if (v !== null && v !== undefined) base[k] = v;
    }
  }

  for (const spec of channelSchema(category) ?? []) {
    if (spec.kind !== "number" || !spec.range || base[spec.key] == null) continue;
    const n = Number(base[spec.key]);
    if (Number.isFinite(n)) {
      base[spec.key] = Math.min(spec.range.max, Math.max(spec.range.min, n));
    } else if (previous && typeof previous === "object" && previous[spec.key] != null) {
      base[spec.key] = previous[spec.key];
    } else {
      delete base[spec.key];
    }
  }
  return base;
}

/** Read one channel's live value out of a legacy value blob, coerced to its kind.
 * Object-blob devices (evap-cooler, presence-relay) key into the blob; the
 * temp/humidity sensor splits its "t:h" string; single-channel devices carry the
 * value directly. */
function readChannelValue(category: string | undefined, spec: ChannelSpec, deviceValue: any): boolean | number {
  let raw: any;
  if (isObjectBlobCategory(category)) {
    raw = (deviceValue ?? {})[spec.key];
  } else if (category === "temp/humidity") {
    const [temperature, humidity] = String(deviceValue ?? "").split(":");
    raw = spec.key === "temperature" ? temperature : humidity;
  } else {
    raw = deviceValue;
  }
  return spec.kind === "boolean" ? toBoolean(raw) : toNumber(raw) ?? 0;
}

/**
 * Read a single channel's current value out of a legacy value blob, by key. The
 * channel-value codec's read half — used by the evaluator and the Node facade to
 * see channel state without caring how it's packed. Returns undefined for an
 * unknown channel/category.
 */
export function channelValue(
  category: string | undefined,
  key: string,
  deviceValue: any,
): boolean | number | undefined {
  const spec = (channelSchema(category) ?? []).find((s) => s.key === key);
  if (!spec) return undefined;
  return readChannelValue(category, spec, deviceValue);
}

/**
 * Write a single channel's value back into the legacy value blob, returning the new
 * blob (the codec's write half). Multi-channel devices key into the object; the
 * temp/humidity sensor rebuilds its "t:h" string; single-channel devices become the
 * scalar value. Pure — does not mutate the input.
 */
export function withChannelValue(
  category: string | undefined,
  deviceValue: any,
  key: string,
  newValue: boolean | number,
): any {
  if (isObjectBlobCategory(category)) {
    return { ...(deviceValue ?? {}), [key]: newValue };
  }
  if (category === "temp/humidity") {
    const [temperature, humidity] = String(deviceValue ?? "").split(":");
    const t = key === "temperature" ? newValue : temperature ?? "";
    const h = key === "humidity" ? newValue : humidity ?? "";
    return `${t}:${h}`;
  }
  return newValue;
}

/** Coerce a possibly-stringy reading to a finite number, else null. */
function toNumber(v: any): number | null {
  const n = typeof v === "boolean" ? (v ? 1 : 0) : Number(v);
  return Number.isFinite(n) ? n : null;
}

/** Coerce a possibly-stringy boolean ('false'/0/'') to a real boolean. */
export function toBoolean(v: any): boolean {
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

  if (isObjectBlobCategory(opts.category)) {
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
  const specs = channelSchema(sensor.sensorType);
  if (specs) {
    return specs.map((spec) => ({
      ...spec,
      value: readChannelValue(sensor.sensorType, spec, sensor.value),
    }));
  }

  // Unknown sensor: emit one generic channel preserving the raw value.
  const kind: ChannelKind = typeof sensor.value === "boolean" ? "boolean" : "number";
  const value = kind === "boolean" ? toBoolean(sensor.value) : toNumber(sensor.value) ?? 0;
  return [
    { key: "value", role: "sensor", kind, writable: false, value, ...(sensor.unit ? { unit: sensor.unit } : {}) },
  ];
}
