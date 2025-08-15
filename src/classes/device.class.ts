import axios from "axios";
import { EVENT_TYPES, log } from "../logger";
import { dailyEvents } from "../handlers/daily-events.handler";
import {
  buildClientDeviceData,
  DevicesDB,
  pullIpFromAddress,
} from "../handlers/device.handler";
import { io } from "../handlers/websockets.handler";

type DeviceType = "boolean" | "value";

export type DeviceCategory =
  | "light"
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
}

export type DeviceList = Device[];
export type DeviceMap = { [key: string]: Device } | {};

export class Device {
  public ip: string | null = null;
  public manual: boolean = false;
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
      return this.notifyDevice(value);
    }
  }

  /**
   * Triggers a device based on more direct interactions that involve user
   * interactions. This type of trigger will be direct and have no conditions
   * attatched to it
   */
  manualTrigger(value: any): Promise<boolean> {
    this.manual = true;
    return this.notifyDevice(value).then((success) => {
      if (this._timer) {
        clearTimeout(this._timer);
        this._timer = null;
      }
      return success;
    });
  }

  notifyDevice(value: any): Promise<boolean> {
    return new Promise((resolve, reject) => {
      if (!this.ip) {
        log(EVENT_TYPES.error, [
          `Unable to update Device without IP address: ${this.name}`,
        ]);
        resolve(false);
        return;
      }
      axios
        .get(this.getDeviceUpdateRequestURL(value))
        .then(() => {
          this.value = value;
          io.emit("device-update", buildClientDeviceData(this));

          log(EVENT_TYPES.device_triggered, [
            `Device triggered ${this.name}, ${JSON.stringify(this.value, null, 2)}`,
          ]);
          resolve(true);
        })
        .catch((reason) => {
          log(EVENT_TYPES.error, [
            `Device not found 404, ${this.name}, ${reason}`,
          ]);
          reject(false);
        });
    });
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
