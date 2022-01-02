import { log, EVENT_TYPES } from '../logger';
import { Device } from './device.class';

export const DEFAULT_TIMER = 1000 * 60;
export const ROOMS = {
  LIVING_ROOM: 'living-room',
  DINNING_ROOM: 'dinning-room',
  KITCHEN: 'kitchen',
  MAIN_ROOM: 'main-room',
  MAIN_BATHROOM: 'main-bathroom'
}
export type RoomKeys = 'living-room' |'dinning-room' |'kitchen' |'main-room' |'main-bathroom'
export type RoomList = {
  [key in RoomKeys]?: Room;
};

export class Room {

  public active: boolean = false;
  public timer: NodeJS.Timeout | null = null;
  public data: any = {};
  public name: RoomKeys;

  private _devices: Array<any>;
  private timeout: number;
  private subscriptions = {
    'active': [],
    'signal-update': [],
    'inactive': []
  };

  constructor (name: RoomKeys, devices?: any, timeout?: number) {
    this.name = name;
    this._devices = devices ? devices : [];
    this.timeout = timeout ? timeout : DEFAULT_TIMER;
  }

  on(event: 'active' | 'signal-update' | 'inactive', fn: (devices:{[key: string]: Device}, value: boolean) => void) {
    this.subscriptions[event].push(fn);
    return this;
  }

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
}
