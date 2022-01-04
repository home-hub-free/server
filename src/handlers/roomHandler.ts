import { autoTrigger, devices } from './deviceHandler';
import { 
  RoomKeys,
  Room,
  RoomList,
  RoomEvent,
  RoomData
} from '../classes/room.class';
import { DeviceMap } from '../classes/device.class';

// Defining rooms
let kitchen = new Room('kitchen', {
  'kitchen-light-down': devices[0],
  'kitchen-light-up': devices[1]
});
let dinningRoom = new Room('dinning-room', {
  'kitchen-light-down': devices[0],
  'dinning-lamp': devices[4]
}, 1000 * 60 * 2);
let mainRoom = new Room('main-room');

// Defining rooms behavior
['active', 'inactive'].forEach((event: RoomEvent) => {
  kitchen.on(event, (devices: DeviceMap, value: any) => {
    Object.values(devices).forEach(device => autoTrigger(device, value));
  });

  dinningRoom.on(event, (devices: DeviceMap, value: any) => {
    autoTrigger(devices['dinning-lamp'], value);
    // Is past 12am and before 6am
    if (new Date().getHours() < 6) autoTrigger(devices['kitchen-light-down'], value);
  });
});

export let roomList: RoomList = {
  'kitchen': kitchen,
  'dinning-room': dinningRoom,
  'main-room': mainRoom
};

/**
 * Iterates over room list object creates simples objects containing only
 * neccesary data for the front end
 * @returns RoomData
 */
export function getRoomsStates(): RoomData[] {
  return Object.keys(roomList).map((key: RoomKeys) => {
    let room = roomList[key];
    return {
      room: key,
      active: room.active,
      data: room.data
    };
  });
}