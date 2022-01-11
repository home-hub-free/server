import axios from "axios";
import storage from 'node-persist';
import { EVENT_TYPES, log } from "../logger";

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

  private _condition: (device: Device) => boolean;
  // This needs to change to a single endpoint to notify the devices
  // changing this requires to re-compile and re-flash all the code 
  // running in the devices which i am to lazy to do at the moment
  private _endpoint: string;
  // public triggerCondition: (event: TriggerConditionEvent) => boolean;
  constructor(id: number, name: string, type: DeviceType, condition?: (device: Device) => boolean) {
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

    if (condition) this._condition = condition;

    // this.assignStorageValue();
  }

  /**
   * Triggers devices based on external behavior, from sensors or daily events. This
   * function will check for device trigger conditions before actually triggering
   * the device
   */
  autoTrigger(value: any) {
    if (this.manual || !this.triggerCondition() || String(value) === String(this.value)) {
      // reject('Unable to trigger device');
      return;
    }

    this.manualTrigger(value);
  }

  /**
   * Triggers a device based on more direct interactions that involve user
   * interactions. This type of trigger will be direct and have no conditions
   * attatched to it
   */
  manualTrigger(value: any, manual?: boolean): Promise<boolean> {
    return this.notifyDevice(value).then((success) => {
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
      axios.get(`http://${this.ip}/${this._endpoint}?value=${value}`).then(() => {
        this.value = value;
        this.storeValue();
        resolve(true);
      }).catch((reason) => {
        log(EVENT_TYPES.error, [`Device not found 404, ${this.name}, ${reason}`]);
        // resolve(`Device not found 404, ${this.name}, ${reason}`)
        resolve(false);
      });
    });
  }

  assignStorageValue() {
    let id = JSON.stringify(this.id);
    storage.getItem(id).then(value => {
      if (value) this.value = JSON.parse(value);
      log(EVENT_TYPES.init_value, [id, this.name, value]);
    })
  }

  private storeValue() {
    let id = JSON.stringify(this.id);
    let newVal = JSON.stringify(this.value);

    storage.getItem(id).then(value => {
      let args = [id, newVal];
      let fn = value ? 'updateItem' : 'setItem';
      storage[fn].apply(null, args);
    });
  }

  private triggerCondition(): boolean {
    // If we don't have a trigger condition we always allow the trigger to happen
    return this._condition ? this._condition(this) : true;
  }
}