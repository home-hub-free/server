import axios from "axios";
import { EVENT_TYPES, log } from "../logger";
import { dailyEvents } from "../handlers/daily-events.handler";
import {
  buildClientDeviceData,
  DevicesDB,
  pullIpFromAddress,
} from "../handlers/device.handler";
import { io } from "../handlers/websockets.handler";
import { emitDeviceState, IngestionSource } from "../clients/ingestion";
import { ChannelSpec, channelSchema, buildSetRequests } from "../clients/channels";

type DeviceType = "boolean" | "value";

export type DeviceCategory =
  | "light"
  | "door"
  | "evap-cooler"
  | "dimmable-light"
  | "blinds"
  | "camera";

/**
 * Presision devices measure their values themselves, since they should be
 * connected to either a sensor/rotation-encoder to work as expected, their
 * values should be the source of truth for the server, to avoid
 * unnecessary mechanical miss-alignments and or break stuff
 */
export const PRECISION_DEVICES: Array<DeviceCategory> = ["blinds", "camera"];

export const DeviceTypesToDataTypes = {
  light: "boolean",
  door: "boolean",
  "evap-cooler": "value",
  "dimmable-light": "value",
  blinds: "value",
};

export interface DeviceData {
  id: string;
  name: string;
  value: any;
  type: DeviceType;
  deviceCategory: string;
  manual: boolean;
  operationalRanges: string[];
  ip?: string;
  /** Physical location (e.g. "sala", "recamara"). Consumed by the memory/LLM layer. */
  zone?: string;
  /** Unit for value devices (e.g. "C", "%"). Consumed by the memory/LLM layer. */
  unit?: string;
  /** Stage-3 channel schema (declared by the device, or synthesized from category). */
  channels?: ChannelSpec[];
  /** True once the device self-described channels — gates channel-addressed `/set`. */
  channelAware?: boolean;
}

export type DeviceList = Device[];
export type DeviceMap = { [key: string]: Device } | {};

export class Device {
  public ip: string | null = null;
  public manual: boolean = false;
  // Empty-string (not null) defaults so mergeDBData() restores them from the DB
  // on reconnect — the merge skips null-valued fields.
  public zone: string = "";
  public unit: string = "";
  /**
   * Stage-3 compatibility shim (see docs/DATA_CONTRACTS.md). `channelAware` is the
   * capability signal: false (default) for the un-reflashed fleet, which keeps
   * getting the legacy `/set?value=` / `/set?fan=&water=` wire; flipped to true
   * only when a device self-describes `channels` in /device-declare. `channels`
   * holds the schema (declared, or synthesized from category) so the rest of the
   * system has a uniform channel view regardless.
   */
  public channelAware: boolean = false;
  public channels: ChannelSpec[] = [];
  public value: any;
  public id: string;
  public name: string;
  public type: DeviceType;
  public deviceCategory: DeviceCategory;
  public lastPing: Date = new Date();
  /**
   * Some devices have their own sensors, which can trigger
   * behavior
   */
  public effects = [];
  /**
   * [HH:MM-HH:MM, HH:MM-HH:MM]
   * Possible values:
   * HH: 0-23
   * MM: 0-59
   * sunset/sunrise are also valid values to use in a range
   * ea: [sunrise-12:00, sunset-22:00]
   */
  public operationalRanges: string[];
  private _timer: NodeJS.Timeout;

  constructor(
    id: string,
    name: string,
    type: DeviceType,
    operationalRanges?: string[],
    ip?: string,
  ) {
    switch (type) {
      case "boolean":
        this.value = false;
        break;
      case "value":
        this.value = 0;
        break;
    }

    if (name === "evap-cooler") {
      this.value = {
        fan: false,
        water: false,
        target: 26,
        ["unit-temp"]: 0,
        ["room-temp"]: 0,
      };
    }

    this.id = id;
    this.name = name;
    this.type = type;
    // When constructed the name original name is the device category
    this.deviceCategory = name as DeviceCategory;
    // Default to the category's channel schema; a self-describing device overrides
    // this (and flips channelAware) when it declares its own channels.
    this.channels = channelSchema(this.deviceCategory) ?? [];
    this.operationalRanges = operationalRanges || [];
    if (ip) {
      this.ip = pullIpFromAddress(ip);
    }
    this.mergeDBData();

    // TODO: Legacy implementation, remove once all devices have "firstPing" implemented
    // When device is initialized, notify of its DB value
    if (!PRECISION_DEVICES.includes(this.deviceCategory)) {
      this.notifyDevice(this.value);
    }
  }

  /**
   * Triggers devices based on external behavior, from sensors or daily events. This
   * function will check for device trigger conditions before actually triggering
   * the device
   */
  async autoTrigger(value: any) {
    if (this.canAutoTrigger() && this.hasChanges(value)) {
      return this.notifyDevice(value, "device");
    }
  }

  /**
   * Triggers a device based on more direct interactions that involve user
   * interactions. This type of trigger will be direct and have no conditions
   * attatched to it
   */
  async manualTrigger(value: any, source: IngestionSource = "dashboard"): Promise<boolean> {
    this.manual = true;
    // `source` is the provenance of this direct write (dashboard user, voice, or the LLM agent).
    // It rides the ingestion emit so consumers can tell agent-induced changes apart — the agent
    // drops its own ("llm") events to avoid an act → event → act loop.
    return this.notifyDevice(value, source).then((success) => {
      if (this._timer) {
        clearTimeout(this._timer);
        this._timer = null;
      }
      return success;
    });
  }

  notifyDevice(value: any, source: IngestionSource = "system"): Promise<boolean> {
    if (!this.ip) {
      log(EVENT_TYPES.error, [
        `Unable to update Device without IP address: ${this.name}`,
      ]);
      return Promise.resolve(false);
    }

    // Commit the intended value optimistically, before the (async) device
    // round-trip resolves. This guarantees that any effect evaluated while the
    // request is still in-flight reads the latest intent instead of the stale
    // confirmed value. Without this, a presence "active" signal arriving while a
    // grace-period "off" request is pending would compare against the old value,
    // wrongly conclude "already on", and skip turning the light back on — leaving
    // the room dark while presence is still detected.
    const previous = this.value;
    this.value = value;
    io.emit("device-update", buildClientDeviceData(this));
    // Feed live actor state to the memory/LLM layer (deferred no-op for now).
    emitDeviceState(this, source);

    // Legacy fleet (channelAware=false): unchanged single-request behavior.
    if (!this.channelAware) {
      return axios
        .get(this.getDeviceUpdateRequestURL(value))
        .then(() => {
          log(EVENT_TYPES.device_triggered, [
            `Device triggered ${this.name}, ${JSON.stringify(this.value, null, 2)}`,
          ]);
          return true;
        })
        .catch((reason) => {
          // Only revert if a newer request hasn't already superseded our value.
          if (this.value === value) {
            this.value = previous;
            io.emit("device-update", buildClientDeviceData(this));
            emitDeviceState(this, source);
          }
          log(EVENT_TYPES.error, [
            `Device not found 404, ${this.name}, ${reason}`,
          ]);
          return false;
        });
    }

    return this.notifyChannels(value, previous, source);
  }

  /**
   * Channel-addressed actuation (Stage 3). Issues one request per writable channel
   * and reverts ONLY the channels whose request failed — partial failure no longer
   * rolls back the whole device. Falls back to "success" when there's nothing to
   * send (e.g. a cooler write that changed no actuator channel).
   */
  private notifyChannels(value: any, previous: any, source: IngestionSource): Promise<boolean> {
    const requests = buildSetRequests({
      ip: this.ip,
      category: this.deviceCategory,
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
            log(EVENT_TYPES.error, [
              `Channel set failed ${this.name} (${req.channel}), ${reason}`,
            ]);
            return false;
          }),
      ),
    ).then((results) => {
      if (results.some((ok) => !ok)) {
        // At least one channel reverted — re-broadcast the corrected state.
        io.emit("device-update", buildClientDeviceData(this));
        emitDeviceState(this, source);
      } else {
        log(EVENT_TYPES.device_triggered, [
          `Device triggered ${this.name}, ${JSON.stringify(this.value, null, 2)}`,
        ]);
      }
      return results.every(Boolean);
    });
  }

  /** Revert a single channel to its previous value after a failed request. Mirrors
   * the legacy "only if not superseded" guard for single-value devices. */
  private revertChannel(channel: string | undefined, value: any, previous: any) {
    if (channel && this.deviceCategory === "evap-cooler") {
      if (this.value && previous) this.value[channel] = previous[channel];
    } else if (this.value === value) {
      this.value = previous;
    }
  }

  canAutoTrigger(): boolean {
    if (this.manual) {
      return false;
    }

    // We allow autotrigger if there is a pending timmer to execute since timerTriggers
    // can only be initialized when trigger conditions pass, this is to allow devices
    // to trigger their timers if they where initialized during operational range and
    // the timmer ran past it.
    let pendingTimer = Boolean(this._timer);
    let withinOperationRange = this.validateOperationRanges();

    return withinOperationRange || pendingTimer;
  }

  private validateOperationRanges() {
    if (this.operationalRanges.length === 0) {
      return true;
    }

    let validCount = 0;
    let now = new Date().getTime();
    // [HH:MM-HH:MM] (24h based)
    this.operationalRanges.forEach((range) => {
      let ranges = range.split("-");
      let start = this.parseRange(ranges[0]);
      let end = this.parseRange(ranges[1]);

      if (now >= start && now <= end) {
        validCount++;
      }
    });

    return validCount > 0;
  }

  private parseRange(value: string) {
    let timestamp: number;
    let sunrise = dailyEvents.sunrise;
    let sunset = dailyEvents.sunset;

    switch (value) {
      case "sunrise":
        timestamp =
          (sunrise.time && sunrise.time.getTime()) || new Date().getTime();
        break;
      case "sunset":
        timestamp =
          (sunset.time && sunset.time.getTime()) || new Date().getTime();
        break;
      default:
        timestamp = this.parseTimeValue(value).getTime();
    }

    return timestamp;
  }

  private parseTimeValue(timeValue: string): Date {
    let now = new Date();
    let splitTime = timeValue.split(":");
    let hours = parseInt(splitTime[0]);
    let minutes = 0;

    if (splitTime.length == 2) {
      minutes = parseInt(splitTime[1]);
    }

    now.setHours(hours);
    now.setMinutes(minutes);
    now.setSeconds(0);

    return now;
  }

  private mergeDBData() {
    const dbStoredData = DevicesDB.get(this.id);
    if (dbStoredData) {
      Object.keys(dbStoredData).forEach((key: string) => {
        if (this[key] !== null && dbStoredData[key] !== null)
          this[key] = dbStoredData[key];
      });
    }
  }

  private getDeviceUpdateRequestURL(value: any) {
    const url = `http://${this.ip}`;
    switch (this.deviceCategory) {
      case "evap-cooler":
        return `${url}/set?fan=${value.fan}&water=${value.water}`;
      default:
        return `${url}/set?value=${value}`;
    }
  }

  private hasChanges(newValue: any): boolean {
    switch (this.deviceCategory) {
      case "evap-cooler":
        return true;
      default:
        return String(newValue) !== String(this.value);
    }
  }
}

export class DeviceBlinds extends Device {
  spin() {
    return new Promise((resolve, reject) => {
      if (!this.ip) {
        log(EVENT_TYPES.error, [`Device without IP address: ${this.name}`]);
      }
      axios.get(`http://${this.ip}/spin`).then(() => {
        log(EVENT_TYPES.device_triggered, [
          `Blinds spinned, ${this.name}, ${this.value}`,
        ]);
        resolve(true);
      });
    });
  }

  setHomeValue() {
    return new Promise((resolve, reject) => {
      if (!this.ip) {
        log(EVENT_TYPES.error, [`Device without IP address: ${this.name}`]);
      }
      axios.get(`http://${this.ip}/home-position`).then(() => {
        log(EVENT_TYPES.device_triggered, [`Blinds Homed`]);
        resolve(true);
      });
    });
  }

  setLimitValue() {
    return new Promise((resolve, reject) => {
      if (!this.ip) {
        log(EVENT_TYPES.error, [`Device without IP address: ${this.name}`]);
      }
      axios.get(`http://${this.ip}/set-limit`).then(() => {
        log(EVENT_TYPES.device_triggered, [
          `Blinds Limit Set, ${this.name}, ${this.value}`,
        ]);
        resolve(true);
      });
    });
  }

  switchDirection() {
    return new Promise((resolve, reject) => {
      if (!this.ip) {
        log(EVENT_TYPES.error, [`Device without IP address: ${this.name}`]);
      }
      axios.get(`http://${this.ip}/switch-direction`).then(() => {
        log(EVENT_TYPES.device_triggered, [
          `Blinds Switch directio, ${this.name}, ${this.value}`,
        ]);
        resolve(true);
      });
    });
  }
}
