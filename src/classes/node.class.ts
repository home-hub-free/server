import axios from "axios";
import { EVENT_TYPES, log } from "../logger";
import { dailyEvents } from "../handlers/daily-events.handler";
import { io } from "../handlers/websockets.handler";
import { emitDeviceState, emitSensorEvent, EventMeta, IngestionSource } from "../clients/ingestion";
import {
  ChannelSpec,
  buildSetRequests,
  channelSchema,
  channelValue,
  isObjectBlobCategory,
  reconcileValueWrite,
  toBoolean,
  withChannelValue,
} from "../clients/channels";

/**
 * Node — the unified entity merging the legacy `Device` and `Sensor` classes
 * (Stage 4a, see docs/DATA_CONTRACTS.md). One class; the actuator-vs-sensor
 * distinction lives per-channel (`role`). Behaviour is a faithful 1:1 port of the
 * two old classes:
 *  - actuator/setting channels carry the device behaviours (optimistic-commit +
 *    per-channel revert, `manual` lock, `operationalRanges`, precision, auto-off);
 *  - sensor channels carry the sensor behaviours (grace period, false→true
 *    edge-trigger, value updates).
 *
 * The legacy `value` blob is still the internal source of truth (Stage 4a keeps
 * storage legacy); the channel facade (`getChannel`/`setChannel`) reads/writes it
 * through the codec. Two external touchpoints are injected as static hooks so this
 * class has no import cycle with the handlers/registry and can be unit-built in
 * isolation:
 *  - `Node.loadRecord(id)` → the persisted record for boot-restore (wired to the
 *    nodes repo during the route cutover);
 *  - `Node.automations(node, channel, value)` → fire the effect orchestrator on a
 *    sensor change (wired to computeSetActions + the registry).
 */

export type NodeCategory =
  | "light"
  | "door"
  | "evap-cooler"
  | "dimmable-light"
  | "blinds"
  | "camera"
  | "motion"
  | "presence"
  | "presence-relay"
  | "temp/humidity"
  | "voice-satellite";

/** Categories that own their own value — the hub never pushes on first ping.
 * `voice-satellite` is an audio I/O endpoint, not an actuator: it declares as a
 * device so the hub keeps its IP + zone for playback routing, but `/set` is a
 * firmware no-op and the hub must never push state at it. */
export const PRECISION_CATEGORIES: NodeCategory[] = ["blinds", "camera", "voice-satellite"];

/** Categories whose value is governed by a hub-side closed loop — the evap-cooler's
 * `coolerControl` decides fan/water from its own drifting temps. A closed-loop device is
 * its OWN crystallized chain: the actuation it produces already emits `source:"automation"`
 * (via `autoTrigger`), but so must the periodic state REPORT it sends back. Otherwise every
 * ≥threshold temp tick that clears the ingestion gate publishes a whole-value `state` event
 * (`source:"device"`, no channel role/kind) that sails past the gateway's per-channel
 * significance gate and re-wakes the agent to re-reason a loop it does not run → "no_action"
 * noise. See `deviceSelfReportMeta`. */
export const CLOSED_LOOP_CATEGORIES: NodeCategory[] = ["evap-cooler"];

/** The ingestion meta a device's OWN state report (`POST /device-value-set`) should carry.
 * A closed-loop device's report is part of a chain the reactive agent must stay blind to, so
 * stamp it `coveredByEffect` — the reaction plane drops it while memory keeps the honest
 * `source:"device"` reading for pattern mining (docs/PATTERN_LIFECYCLE.md §D2). Every other
 * device reports nothing special (an unflagged `device` event the agent may wake on). */
export function deviceSelfReportMeta(category: NodeCategory): EventMeta {
  return CLOSED_LOOP_CATEGORIES.includes(category) ? { coveredByEffect: true } : {};
}

const TIME_TO_INACTIVE = 1000 * 10;

const BOOLEAN_CATEGORIES = new Set<NodeCategory>(["light", "door", "motion", "presence"]);

/**
 * Stream-capability block a camera self-declares (docs/CAMERA_VISION_PLAN.md §3.3).
 * The hub stores it VERBATIM and exposes it on the roster so the box-side
 * vision-service can build `http://<ip>:<port><path>` and pull the MJPEG feed. The
 * hub never opens the stream itself — it stays control-plane only. */
export interface CameraStream {
  /** Transport family — currently always "mjpeg-http" (stock esp_camera server). */
  proto: string;
  /** Stream port (ESP32-CAM serves MJPEG on :81 by convention). */
  port: number;
  /** Path of the continuous multipart MJPEG feed, e.g. "/stream". */
  path: string;
  /** Single-JPEG snapshot path, e.g. "/capture". */
  snapshot?: string;
  /** Sensor framesize hint the cam booted with (e.g. "SVGA"). Tunable via /control. */
  res?: string;
  /** Nominal frames/sec the cam emits. */
  fps?: number;
}

export class Node {
  /** Boot-restore hook — returns the persisted record for `id`, or undefined. */
  static loadRecord: (id: string) => any = () => undefined;
  /** Automation hook — runs the effect orchestrator for a sensor channel change. */
  static automations: (node: Node, channel: string, value: boolean | number) => void = () => {};
  /** Coverage hook — true when an enabled effect already maps this sensor channel
   * change to a device action. A covered trigger is stamped `coveredByEffect:true`
   * on the ingestion envelope (its `source` stays TRUE, e.g. `device`) so the
   * reaction plane can drop the chain it already crystallized while the observation
   * plane keeps the honest reading for pattern discovery (docs/PATTERN_LIFECYCLE.md
   * §D2). Defaults false → no coverage stamp until wired (so the class unit-builds in
   * isolation and pre-cutover behaviour holds). */
  static isCovered: (node: Node, channel: string, value: boolean | number) => boolean = () => false;

  public id: string;
  public name: string;
  public category: NodeCategory;
  public type: "boolean" | "value";
  public ip: string | null = null;
  /** Camera-only: the self-declared stream block (§3.3). Defaults null and is
   * repopulated on each declare heartbeat — exactly like `ip` (which the DB also
   * does not restore). Surfaced on toClientData so the roster carries it. */
  public stream: CameraStream | null = null;
  /** Firmware version a device reports on declare (camera roster surfaces it). */
  public fwVersion: string = "";
  public manual: boolean = false;
  // Empty-string (not null) defaults so mergeDBData() restores them on reconnect.
  public zone: string = "";
  public unit: string = "";
  public channelAware: boolean = false;
  public channels: ChannelSpec[] = [];
  public value: any;
  public operationalRanges: string[];
  public lastPing: Date = new Date();

  private _timer: NodeJS.Timeout;
  private _graceTimer: NodeJS.Timeout;

  constructor(id: string, name: string, operationalRanges?: string[], ip?: string) {
    this.id = id;
    this.name = name;
    this.category = name as NodeCategory;
    this.type = BOOLEAN_CATEGORIES.has(this.category) ? "boolean" : "value";
    this.channels = channelSchema(this.category) ?? [];
    this.operationalRanges = operationalRanges || [];
    this.value = this.initialValue();
    if (ip) this.ip = pullIp(ip);

    this.mergeDBData();

    // Legacy DB records stored boolean sensors as 0/1; coerce a restored scalar
    // boolean to a real boolean so strict-equality checks never see a numeric —
    // both the server edge-trigger (`channelValue(...) !== true`) and the
    // dashboard tile's `sensor.value === true`. Object-blob categories
    // (presence-relay) keep their per-channel shape and are left alone.
    if (this.type === "boolean" && !isObjectBlobCategory(this.category)) {
      this.value = toBoolean(this.value);
    }

    // Legacy first-ping push: actuator nodes (writable, non-precision) get their
    // restored value pushed on construction. Sensors have nothing to push.
    if (this.hasWritableChannels() && !PRECISION_CATEGORIES.includes(this.category)) {
      this.notify(this.value);
    }
  }

  private initialValue(): any {
    if (this.category === "evap-cooler") {
      return { fan: false, water: false, target: 26, ["unit-temp"]: 0, ["room-temp"]: 0 };
    }
    if (this.category === "presence-relay") return { presence: false, relay: false };
    // Display defaults only — the device owns these (precision) and reports its
    // NVS-persisted truth via /device-value-set right after boot.
    if (this.category === "voice-satellite") return { volume: 55, mic: true, eco: true };
    if (this.category === "temp/humidity") return "";
    if (this.type === "boolean") return false;
    return 0;
  }

  private hasWritableChannels(): boolean {
    return this.channels.some((c) => c.writable);
  }

  // ── Channel facade ─────────────────────────────────────────────────────────

  /** Current value of one channel, read through the codec. */
  getChannel(key: string): boolean | number | undefined {
    return channelValue(this.category, key, this.value);
  }

  /**
   * Channel-addressed write (Stage 4 actuation entry point). Folds the new channel
   * value into the legacy blob and actuates. For single-channel devices this is
   * equivalent to a whole-value write. `manual:true` makes it a user override —
   * it takes the `manual` lock and clears any pending auto-off timer, exactly like
   * `manualTrigger` (so a dashboard channel toggle isn't immediately overridden by
   * `coolerControl`/automation).
   */
  setChannel(
    key: string,
    value: boolean | number,
    source: IngestionSource = "system",
    manual = false,
    causedBy?: EventMeta["causedBy"],
    actor?: EventMeta["actor"],
  ): Promise<boolean> {
    if (manual) this.manual = true;
    const folded = withChannelValue(this.category, this.value, key, value);
    const result = this.notify(reconcileValueWrite(this.category, this.value, folded), source, { causedBy, actor });
    if (!manual) return result;
    return result.then((success) => {
      if (this._timer) {
        clearTimeout(this._timer);
        this._timer = null;
      }
      return success;
    });
  }

  // ── Actuator behaviours (ported from Device) ───────────────────────────────

  async autoTrigger(value: any) {
    if (this.canAutoTrigger() && this.hasChanges(value)) {
      // Origin is a rule firing (cooler closed-loop), not a live device report —
      // tag it so the memory/LLM layer can keep the agent blind to automation.
      return this.notify(value, "automation");
    }
  }

  async manualTrigger(
    value: any,
    source: IngestionSource = "dashboard",
    actor?: EventMeta["actor"],
    latch: boolean = source === "dashboard",
  ): Promise<boolean> {
    // Only a write with a human behind it grabs the wheel. A dashboard tap always is;
    // an agent (llm/voice) write only when the gateway flags it as relaying a user
    // command — the route passes that decision via `latch` (see decideWritePolicy).
    // Agent *initiative* and system writes actuate without latching, so automations
    // keep applying — mirrors the source-aware lock setChannel does for channel writes.
    if (latch) this.manual = true;
    return this.notify(reconcileValueWrite(this.category, this.value, value), source, { actor }).then((success) => {
      if (this._timer) {
        clearTimeout(this._timer);
        this._timer = null;
      }
      return success;
    });
  }

  /** Set or clear the `manual` lock explicitly — the agent's (and dashboard's) "go manual /
   * back to automatic" control. The graceful counterpart to a lock-respecting skip: control
   * can be handed to/from automations on purpose, not only implicitly via a write. Idempotent;
   * returns true if the lock changed. */
  setManual(on: boolean): boolean {
    if (this.manual === on) return false;
    this.manual = on;
    return true;
  }

  /** Release the `manual` lock — control returns to automations (the "natural reset" of
   * docs/EFFECTS_DYNAMIC.md §8). Idempotent. Called by the daily reset. Returns true if changed. */
  releaseManual(): boolean {
    return this.setManual(false);
  }

  notify(value: any, source: IngestionSource = "system", meta: EventMeta = {}): Promise<boolean> {
    if (!this.ip) {
      log(EVENT_TYPES.error, [`Unable to update Node without IP address: ${this.name}`]);
      return Promise.resolve(false);
    }

    // Optimistic commit before the async round-trip (see the legacy Device note).
    const previous = this.value;
    this.value = value;
    io.emit("device-update", this.toClientData());
    emitDeviceState(this.asDeviceLike(), source, meta);

    if (!this.channelAware) {
      return axios
        .get(this.legacySetUrl(value))
        .then(() => {
          log(EVENT_TYPES.device_triggered, [`Node triggered ${this.name}, ${JSON.stringify(this.value, null, 2)}`]);
          return true;
        })
        .catch((reason) => {
          if (this.value === value) {
            this.value = previous;
            io.emit("device-update", this.toClientData());
            emitDeviceState(this.asDeviceLike(), source, meta);
          }
          log(EVENT_TYPES.error, [`Node not found 404, ${this.name}, ${reason}`]);
          return false;
        });
    }

    return this.notifyChannels(value, previous, source, meta);
  }

  private notifyChannels(value: any, previous: any, source: IngestionSource, meta: EventMeta = {}): Promise<boolean> {
    const requests = buildSetRequests({
      ip: this.ip,
      category: this.category,
      channelAware: true,
      value,
      previous,
    });
    if (requests.length === 0) return Promise.resolve(true);

    return Promise.all(
      requests.map((req) =>
        axios
          .get(req.url)
          .then(() => true)
          .catch((reason) => {
            this.revertChannel(req.channel, value, previous);
            log(EVENT_TYPES.error, [`Channel set failed ${this.name} (${req.channel}), ${reason}`]);
            return false;
          }),
      ),
    ).then((results) => {
      if (results.some((ok) => !ok)) {
        io.emit("device-update", this.toClientData());
        emitDeviceState(this.asDeviceLike(), source, meta);
      } else {
        log(EVENT_TYPES.device_triggered, [`Node triggered ${this.name}, ${JSON.stringify(this.value, null, 2)}`]);
      }
      return results.every(Boolean);
    });
  }

  private revertChannel(channel: string | undefined, value: any, previous: any) {
    if (channel && isObjectBlobCategory(this.category)) {
      if (this.value && previous) this.value[channel] = previous[channel];
    } else if (this.value === value) {
      this.value = previous;
    }
  }

  canAutoTrigger(): boolean {
    if (this.manual) return false;
    const pendingTimer = Boolean(this._timer);
    return this.validateOperationRanges() || pendingTimer;
  }

  private validateOperationRanges(): boolean {
    if (this.operationalRanges.length === 0) return true;
    let validCount = 0;
    const now = new Date().getTime();
    this.operationalRanges.forEach((range) => {
      const [from, to] = range.split("-");
      if (now >= this.parseRange(from) && now <= this.parseRange(to)) validCount++;
    });
    return validCount > 0;
  }

  private parseRange(value: string): number {
    const { sunrise, sunset } = dailyEvents;
    switch (value) {
      case "sunrise":
        return (sunrise.time && sunrise.time.getTime()) || new Date().getTime();
      case "sunset":
        return (sunset.time && sunset.time.getTime()) || new Date().getTime();
      default:
        return this.parseTimeValue(value).getTime();
    }
  }

  private parseTimeValue(timeValue: string): Date {
    const now = new Date();
    const [h, m] = timeValue.split(":");
    now.setHours(parseInt(h));
    now.setMinutes(m != null ? parseInt(m) : 0);
    now.setSeconds(0);
    return now;
  }

  private legacySetUrl(value: any): string {
    const url = `http://${this.ip}`;
    if (this.category === "evap-cooler") return `${url}/set?fan=${value.fan}&water=${value.water}`;
    if (this.category === "voice-satellite") {
      // `flip` only when the blob carries it (camera units) — sending flip=0 to an
      // audio-only unit is harmless but would seed the key into its reported blob.
      const flip = value?.flip === undefined ? "" : `&flip=${value.flip ? 1 : 0}`;
      // `eco` same shape: only forward it once the device has reported the key
      // (pre-eco firmware ignores the arg anyway; this just keeps blobs honest).
      const eco = value?.eco === undefined ? "" : `&eco=${value.eco ? 1 : 0}`;
      return `${url}/set?volume=${Number(value?.volume ?? 55)}&mic=${value?.mic ? 1 : 0}${flip}${eco}`;
    }
    return `${url}/set?value=${value}`;
  }

  private hasChanges(newValue: any): boolean {
    // Object-blob values stringify to "[object Object]" — a naive compare would
    // read every write as a no-op and never notify the device.
    if (isObjectBlobCategory(this.category)) return true;
    return String(newValue) !== String(this.value);
  }

  // ── Sensor behaviours (ported from Sensor) ─────────────────────────────────

  /** A sensor node reported a reading (the legacy Sensor.update). */
  report(value: any, source: IngestionSource = "device") {
    const sensorChannels = this.channels.filter((c) => c.role === "sensor");
    if (sensorChannels.length === 1 && sensorChannels[0].kind === "boolean") {
      this.updateBooleanSensor(value, sensorChannels[0].key, source);
    } else {
      this.updateValueSensor(value, sensorChannels, source);
    }
  }

  /**
   * Heartbeat reconvergence. The sensor declare carries the device's current value
   * (its latched state), so a missed `/sensor-update` edge — a dropped POST, or the
   * hub restarting while the sensor was already active — heals within one heartbeat
   * instead of persisting until the next physical edge. Re-applies the value through
   * the normal `report` path ONLY when it differs from what we hold, so a periodic
   * re-report is a no-op when already in sync (no redundant WS emit).
   *
   * Scoped to single-channel BOOLEAN sensors (presence/motion). A boolean has a
   * clean "in sync vs flipped" comparison, so a steady heartbeat is genuinely
   * silent. Value sensors (temp/humidity) are deliberately excluded — every
   * changed reading would differ and emit, which is the opposite of the "only on
   * a missed edge" intent; those report through `/sensor-update` as before.
   */
  reconcile(value: any, source: IngestionSource = "device") {
    const channel = this.booleanSensorChannel();
    if (!channel) return;
    const incoming = value === 1 || value === true;
    if (channelValue(this.category, channel.key, this.value) !== incoming) {
      this.report(value, source);
    }
  }

  /** The lone boolean sensor channel, if this node is a single-channel boolean
   * sensor (presence/motion); otherwise undefined. */
  private booleanSensorChannel(): ChannelSpec | undefined {
    const sensorChannels = this.channels.filter((c) => c.role === "sensor");
    return sensorChannels.length === 1 && sensorChannels[0].kind === "boolean"
      ? sensorChannels[0]
      : undefined;
  }

  /** Coverage stamp for a sensor trigger: a change already mapped by an enabled
   * effect is flagged `coveredByEffect` so the reaction plane drops the chain it
   * crystallized — WITHOUT altering the trigger's true `source` (it stays `device`
   * etc.), keeping the observation plane honest (docs/PATTERN_LIFECYCLE.md §D2). */
  private coverage(channel: string, value: boolean | number): EventMeta {
    return Node.isCovered(this, channel, value) ? { coveredByEffect: true } : {};
  }

  private updateBooleanSensor(value: any, channel: string, source: IngestionSource) {
    const active = value === 1 || value === true;
    if (active) {
      if (this._graceTimer) {
        clearTimeout(this._graceTimer);
        this._graceTimer = null;
      }
      // Edge-trigger: only fire on a real false → true transition. Read/write the
      // sensor channel through the codec so a multi-channel node (presence-relay)
      // keeps its co-located actuator sub-value; scalar nodes are unaffected.
      if (channelValue(this.category, channel, this.value) !== true) {
        this.value = withChannelValue(this.category, this.value, channel, true);
        io.emit("sensor-update", { id: this.id, value: true });
        emitSensorEvent(this.asSensorLike(), source, this.coverage(channel, true));
        Node.automations(this, channel, true);
      }
    } else {
      if (this._graceTimer) clearTimeout(this._graceTimer);
      this._graceTimer = setTimeout(() => {
        this._graceTimer = null;
        this.value = withChannelValue(this.category, this.value, channel, false);
        io.emit("sensor-update", { id: this.id, value: false });
        emitSensorEvent(this.asSensorLike(), source, this.coverage(channel, false));
        Node.automations(this, channel, false);
      }, TIME_TO_INACTIVE);
    }
  }

  private updateValueSensor(value: any, sensorChannels: ChannelSpec[], source: IngestionSource) {
    this.value = value;
    io.emit("sensor-update", { id: this.id, value: this.value });
    // A reading can carry several channels (e.g. temperature + humidity from one "t:h"
    // report). They share ONE ingestion emit, so the emit is flagged coveredByEffect if
    // ANY channel is covered. The `source` stays truthful regardless. (Edge case: a
    // covered temp would also drop a co-reported humidity swing from the reaction plane —
    // acceptable; the reading is still recorded to memory, with true provenance.)
    const present = sensorChannels
      .map((c) => ({ key: c.key, value: channelValue(this.category, c.key, this.value) }))
      .filter((c) => c.value !== undefined) as { key: string; value: boolean | number }[];
    const covered = present.some((c) => Node.isCovered(this, c.key, c.value));
    emitSensorEvent(this.asSensorLike(), source, covered ? { coveredByEffect: true } : {});
    // Re-evaluate every sensor channel this reading carries.
    present.forEach((c) => Node.automations(this, c.key, c.value));
  }

  // ── Persistence / serialization ────────────────────────────────────────────

  mergeDBData() {
    const stored = Node.loadRecord(this.id);
    if (stored) {
      Object.keys(stored).forEach((key) => {
        // `channels` is code-owned (channelSchema) unless the device self-declared
        // its own schema (channelAware). Restoring the persisted copy would pin the
        // node to the schema from whenever it was last saved — a schema added in a
        // hub upgrade (e.g. the satellite's battery channel) would never appear.
        if (key === "channels" && !stored.channelAware) return;
        if (this[key] !== null && stored[key] !== null) this[key] = stored[key];
      });
    }
  }

  /** device-update payload — matches the legacy buildClientDeviceData shape. */
  toClientData() {
    return {
      id: this.id,
      name: this.name,
      value: this.value,
      type: this.type,
      deviceCategory: this.category,
      manual: this.manual,
      operationalRanges: this.operationalRanges,
      ...(this.zone ? { zone: this.zone } : {}),
      ...(this.unit ? { unit: this.unit } : {}),
      ...(this.channels?.length ? { channels: this.channels } : {}),
      ...(this.stream ? { stream: this.stream } : {}),
      // Camera roster carries the device ip so the box-side vision-service can build
      // the MJPEG pull URL (`http://<ip>:<port><path>`). Contract: vision-service/
      // FIRMWARE_CONTRACT.md §roster + hub_client.Camera.stream_url. Scoped so other
      // categories keep their historical ip-free client shape; `voice-satellite` also
      // carries it — the Node-RED satellite_audio delivery POSTs TTS clips to
      // `http://<ip>/play` for the target zone (docs/VOICE_SATELLITE.md §4).
      ...((this.category === "camera" || this.category === "voice-satellite") && this.ip ? { ip: this.ip } : {}),
      ...(this.fwVersion ? { fwVersion: this.fwVersion } : {}),
      channelAware: this.channelAware ?? false,
    };
  }

  private asDeviceLike() {
    return { id: this.id, value: this.value, zone: this.zone, unit: this.unit, deviceCategory: this.category };
  }

  private asSensorLike() {
    return { id: this.id, value: this.value, zone: this.zone, unit: this.unit, sensorType: this.category };
  }
}

/** Blinds keep their extra positioning routes (ported from DeviceBlinds). */
export class NodeBlinds extends Node {
  private blindsAction(path: string, label: string): Promise<boolean> {
    if (!this.ip) {
      log(EVENT_TYPES.error, [`Node without IP address: ${this.name}`]);
      return Promise.resolve(false);
    }
    return axios.get(`http://${this.ip}${path}`).then(() => {
      log(EVENT_TYPES.device_triggered, [`${label}, ${this.name}, ${this.value}`]);
      return true;
    });
  }

  spin() {
    return this.blindsAction("/spin", "Blinds spinned");
  }
  setHomeValue() {
    return this.blindsAction("/home-position", "Blinds Homed");
  }
  setLimitValue() {
    return this.blindsAction("/set-limit", "Blinds Limit Set");
  }
  switchDirection() {
    return this.blindsAction("/switch-direction", "Blinds Switch direction");
  }
}

function pullIp(address: string): string {
  const chunks = address.split(":");
  return chunks[chunks.length - 1];
}

/**
 * Adopt a camera's self-declared stream-capability block + firmware version
 * (CAMERA_VISION_PLAN §3.3). Stored verbatim on the node (so the roster carries it
 * for the box-side vision-service) and refreshed on every declare heartbeat — the
 * same lifecycle as `ip`. Minimal validation: a stream needs at least a `path`; a
 * malformed block is ignored rather than throwing into the hot declare path. Pure
 * over a `Node` + body, so it lives here (no registry/repo dependency) and the
 * declare route imports it directly. */
export function captureStreamDeclare(
  node: Node,
  body: { stream?: any; fw_version?: any },
): void {
  if (typeof body.fw_version === "string" && body.fw_version) {
    node.fwVersion = body.fw_version;
  }
  const s = body.stream;
  if (s && typeof s === "object" && typeof s.path === "string" && s.path) {
    node.stream = {
      proto: typeof s.proto === "string" ? s.proto : "mjpeg-http",
      port: Number(s.port) || 81,
      path: s.path,
      ...(typeof s.snapshot === "string" ? { snapshot: s.snapshot } : {}),
      ...(typeof s.res === "string" ? { res: s.res } : {}),
      ...(s.fps != null && Number.isFinite(Number(s.fps)) ? { fps: Number(s.fps) } : {}),
    };
  }
}
