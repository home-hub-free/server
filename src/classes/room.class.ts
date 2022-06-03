import { log, EVENT_TYPES } from '../logger';

export const DEFAULT_TIMER = 1000 * 60;

export enum RoomKeys {
  Kithen = 'kitchen',
  LivingRoom = 'living-room',
  MainRoom = 'main-room',
  DinningRoom = 'dinning-room'
};
export enum RoomEvent {
  Activated = 'active',
  SignalUpdate = 'signal-update',
  Inactive = 'inactive'
};

export type RoomMap = { [key in RoomKeys]?: Room };

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

  private timeout: number;
  private subscriptions = {
    [RoomEvent.Activated]: [],
    [RoomEvent.SignalUpdate]: [],
    [RoomEvent.Inactive]: []
  };

  constructor (name: RoomKeys, timeout?: number) {
    this.name = name;
    this.timeout = timeout ? timeout : DEFAULT_TIMER;
  }

  /**
   * Allows for multiple subscriptions to the room events
   * @param event Event type to subscribe to
   * @param fn Function to execute when the event is internally triggered
   */
  on(event: RoomEvent, fn: (value: boolean) => void) {
    this.subscriptions[event].push(fn);
    return this;
  }

  /**
   * Sets  the room as active for a set amount of time, could be trough sensors or manual input
   * @param value Singal value
   */
  activate(value: boolean) {
    if (this.timer) {
      clearTimeout(this.timer);
    } else {
      this.active = true;
      if (this.subscriptions[RoomEvent.Activated].length > 0) {
        log(EVENT_TYPES.room_active, [this.name])
        this.subscriptions[RoomEvent.Activated].forEach(fn => fn(value))
      };
    }

    if (this.subscriptions[RoomEvent.SignalUpdate].length > 0) {
      log(EVENT_TYPES.room_signal, [this.name]);
      this.subscriptions[RoomEvent.SignalUpdate].forEach(fn => fn(value));
    }

    this.timer = setTimeout(() => {
      this.active = false;
      this.timer = null;
      if (this.subscriptions[RoomEvent.Inactive].length > 0) {
        log(EVENT_TYPES.room_innactive, [this.name]);
        this.subscriptions[RoomEvent.Inactive].forEach(fn => fn(value));
      }
    }, this.timeout);
  }

  updateRoomDataRef(fn: (data: any) => void) {
    fn(this.data);
  }
}
