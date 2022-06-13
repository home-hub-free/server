import axios from "axios";
// import storage from 'node-persist';
import { EVENT_TYPES, log } from "../logger";
import { dailyEvents } from "../handlers/dailyEventsHandler";

const DEFAULT_TIMER = 1000 * 60;

type DeviceType = 'boolean' | 'value';

export interface DeviceData {
  id: number,
  name: string,
  value: any,
  type: DeviceType,
  manual: boolean
};

export type DeviceList = Device[];
export type DeviceMap = { [key: string]: Device } | {}

export class Device {
  public ip: string | null = null;
  public manual: boolean = false;
  public value: any;
  public id: number;
  public name: string;
  public type: DeviceType;
  /**
   * [HH:MM-HH:MM, HH:MM-HH:MM]
   * HH: 0-23
   * MM: 0-59
   */
  public operationalRanges: string[];

  // This needs to change to a single endpoint to notify the devices
  // changing this requires to re-compile and re-flash all the code 
  // running in the devices which i am to lazy to do at the moment
  private _endpoint: string;
  private _timer: NodeJS.Timeout;

  constructor(id: number, name: string, type: DeviceType, operationalRanges?: string[]) {
    switch (type) {
      case 'boolean':
        this.value = false;
        this._endpoint = 'toggle';
        break;
      case 'value':
        this.value = 0;
        this._endpoint = 'set';
        break;
    }

    this.id = id;
    this.name = name;
    this.type = type;
    this.operationalRanges = operationalRanges;
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
      if (this.type !== 'value') this.manual = true;
      if (this._timer) {
        clearTimeout(this._timer)
        this._timer = null;
      };

      return success;
    });
  }

  /**
   * Sets a start and end value with a within a 1 minute time range, if a timer is already initialized
   * the start value will beignored unless overrideCurrent is set to true, these values are applied
   * trough auto-trigger conditions.
   * @param startValue Value that will be applied if there is not timmer already initialized
   * @param endValue Value that will applied after 1 minute
   */
  timerTrigger(startValue: any, endValue: any) {
    if (this._timer) {
      clearTimeout(this._timer);
      this._timer = null;
    } else {
      this.autoTrigger(startValue);
    }
    this._timer = setTimeout(() => {
      this.autoTrigger(endValue);
      this._timer = null;
    }, DEFAULT_TIMER);
  }


  notifyDevice(value: any): Promise<boolean> {
    return new Promise((resolve, reject) => {
      if (!this.ip) {
        log(EVENT_TYPES.error, [`Device without IP address: ${this.name}`]);
        resolve(false);
        return;
      }
      axios.get(`http://${this.ip}/${this._endpoint}?value=${value}`).then(() => {
        this.value = value;
        // this.storeValue();
        log(EVENT_TYPES.device_triggered, [`Device triggered ${this.name}, ${this.value}`]);
        resolve(true);
      }).catch((reason) => {
        log(EVENT_TYPES.error, [`Device not found 404, ${this.name}, ${reason}`]);
        resolve(false);
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
}