import { devices } from './deviceHandler';
import { 
  RoomKeys,
  Room,
  RoomList,
  RoomEvent,
  ServerRoom
} from '../classes/room.class';

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
  kitchen.on(event, (devices, value) => {
    Object.values(devices).forEach(device => device.autoTrigger(value));
  });

  dinningRoom.on(event, (devices, value) => {
    devices['dinning-lamp'].autoTrigger(value);
    if (new Date().getHours() < 6) devices['kitchen-light-down'].autoTrigger(value);
  });
});

export let rooms: RoomList = {
  'kitchen': kitchen,
  'dinning-room': dinningRoom,
  'main-room': mainRoom
};

export function getRoomsStates(): ServerRoom[] {
  return Object.keys(rooms).map((key: RoomKeys) => {
    let room: Room = rooms[key];
    let data: ServerRoom = {
      room: key,
      active: room.active,
      data: room.data
    };
    return data;
  });
}