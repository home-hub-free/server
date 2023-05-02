import axios from "axios";
import { EVENT_TYPES, log } from "../logger";
import { dailyEvents } from "../handlers/daily-events.handler";
import { buildClientDeviceData, DevicesDB } from "../handlers/device.handler";
import { io } from "../handlers/websockets.handler";

type DeviceType = 'boolean' | 'value';

export const DeviceTypesToDataTypes = {
  'light': 'boolean',
  'dimmable-light': 'value',
  'blinds': 'value'
};

export interface DeviceData {
  id: string,
  name: string,
  value: any,
  type: DeviceType,
  manual: boolean,
  operationalRanges: string[]
};

export type DeviceList = Device[];
export type DeviceMap = { [key: string]: Device } | {}

export class Device {
  public ip: string | null = null;
  public manual: boolean = false;
  public value: any;
  public id: string;
  public name: string;
  public type: DeviceType;
  public lastPing: Date = new Date();
  /**
   * [HH:MM-HH:MM, HH:MM-HH:MM]
   * HH: 0-23
   * MM: 0-59
   */
  public operationalRanges: string[];
  private _timer: NodeJS.Timeout;

  constructor(id: string, name: string, type: DeviceType, operationalRanges?: string[]) {
    switch (type) {
      case 'boolean':
        this.value = false;
        break;
      case 'value':
        this.value = 0;
        break;
    }

    this.id = id;
    this.name = name;
    this.type = type;
    this.operationalRanges = operationalRanges || [];
    this.mergeDBData();
  }

  /**
   * Triggers devices based on external behavior, from sensors or daily events. This
   * function will check for device trigger conditions before actually triggering
   * the device
   */
  autoTrigger(value: any) {
    if (this.canAutoTrigger() && String(value) !== String(this.value)) {
      this.notifyDevice(value);
    }
  }

  /**
   * Triggers a device based on more direct interactions that involve user
   * interactions. This type of trigger will be direct and have no conditions
   * attatched to it
   */
  manualTrigger(value: any): Promise<boolean> {
    return this.notifyDevice(value).then((success) => {
      this.manual = true;
      if (this._timer) {
        clearTimeout(this._timer)
        this._timer = null;
      };
      return success;
    });
  }

  notifyDevice(value: any): Promise<boolean> {
    return new Promise((resolve, reject) => {
      if (!this.ip) {
        log(EVENT_TYPES.error, [`Device without IP address: ${this.name}`]);
        resolve(false);
        return;
      }
      axios.get(`http://${this.ip}/set?value=${value}`).then(() => {
        this.value = value;
        io.emit("device-update", buildClientDeviceData(this));
        log(EVENT_TYPES.device_triggered, [`Device triggered ${this.name}, ${this.value}`]);
        resolve(true);
      }).catch((reason) => {
        log(EVENT_TYPES.error, [`Device not found 404, ${this.name}, ${reason}`]);
        reject(false);
      });
    });
  }

  private canAutoTrigger(): boolean {
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
    let validCount = 0;
    let now = new Date().getTime();
    if (!this.operationalRanges) {
      return true;
    }

    // [HH:MM-HH:MM] (24h based)
    this.operationalRanges.forEach((range) => {
      let ranges = range.split('-');
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
      case 'sunrise':
        timestamp = sunrise.time && sunrise.time.getTime() || new Date().getTime();
        break;
      case 'sunset':
        timestamp = sunset.time && sunset.time.getTime() || new Date().getTime();
        break;
      default:
        timestamp = this.parseTimeValue(value).getTime();
    }

    return timestamp;
  }

  private parseTimeValue(timeValue: string): Date {
    let now = new Date();
    let splitTime = timeValue.split(':');
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
        if (this[key]) this[key] = dbStoredData[key];
      });
    }
  }
}

export class DeviceBlinds extends Device {
  setHomeValue() {
    return new Promise((resolve, reject) => {
      if (!this.ip) {
        log(EVENT_TYPES.error, [`Device without IP address: ${this.name}`]);
      }
      axios.get(`http://${this.ip}/home-position`).then(() => {
        log(EVENT_TYPES.device_triggered, [`Blinds Homed, ${this.name}, ${this.value}`]);
        resolve(true);
      });
    });
  }

  setMaxValue() {
    return new Promise((resolve, reject) => {
      if (!this.ip) {
        log(EVENT_TYPES.error, [`Device without IP address: ${this.name}`]);
      }
      axios.get(`http://${this.ip}/set-limit`).then(() => {
        log(EVENT_TYPES.device_triggered, [`Blinds Homed, ${this.name}, ${this.value}`]);
        resolve(true);
      });
    });
  }
}