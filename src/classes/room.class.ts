import { log, EVENT_TYPES } from '../logger';
import { Device, DeviceMap } from './device.class';

export const DEFAULT_TIMER = 1000 * 60;
export type RoomKeys = 'living-room' |'dinning-room' |'kitchen' |'main-room' |'main-bathroom'
export type RoomEvent = 'active' | 'signal-update' | 'inactive';
export type RoomList = {
  [key in RoomKeys]?: Room;
};
export type RoomEventCallback = (device: DeviceMap, value: any) => void

export interface RoomData {
  room: string,
  active: boolean,
  data: any
}

export interface ServerRoom {
  room: string,
  data: any,
  active: boolean
};

export class Room {

  public active: boolean = false;
  public timer: NodeJS.Timeout | null = null;
  public data: any = {};
  public name: RoomKeys;

  private _devices: DeviceMap;
  private timeout: number;
  private subscriptions = {
    'active': [],
    'signal-update': [],
    'inactive': []
  };

  constructor (name: RoomKeys, devices?: DeviceMap, timeout?: number) {
    this.name = name;
    this._devices = devices || {};
    this.timeout = timeout ? timeout : DEFAULT_TIMER;
  }

  /**
   * Allows for multiple subscriptions to the room events
   * @param event Event type to subscribe to
   * @param fn Function to execute when the event is internally triggered
   */
  on(event: RoomEvent, fn: (devices:{[key: string]: Device}, value: boolean) => void) {
    this.subscriptions[event].push(fn);
    return this;
  }

  /**
   * Sets  the room as active for a set amount of time, could be trough sensors or manual input
   * @param value Singal value
   */
  sensorSignal(value: boolean) {
    if (this.timer) {
      clearTimeout(this.timer);
    } else {
      this.active = true;
      if (this.subscriptions.active.length > 0) {
        log(EVENT_TYPES.room_active, [this.name])
        this.subscriptions.active.forEach(fn => fn(this._devices, value))
      };
    }
    if (this.subscriptions['signal-update'].length > 0) {
      log(EVENT_TYPES.room_signal, [this.name]);
      this.subscriptions['signal-update'].forEach(fn => fn(this._devices, value));
    }
    this.timer = setTimeout(() => {
      this.active = false;
      this.timer = null;
      if (this.subscriptions.inactive.length > 0) {
        log(EVENT_TYPES.room_innactive, [this.name]);
        this.subscriptions.inactive.forEach(fn => fn(this._devices, value));
      }
    }, this.timeout);
  }

  updateRoomDataRef(fn: (data: any) => void) {
    fn(this.data);
  }
}
