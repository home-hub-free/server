import { devices } from './deviceHandler';
import { 
  RoomKeys,
  Room,
  RoomMap,
  RoomData,
  RoomEvent
} from '../classes/room.class';

/**
 * TODO: Rooms should be user defined, not code defined
 */
export let rooms: RoomMap = {};
Object.values(RoomKeys).map((roomName) => {
  rooms[roomName] = new Room(roomName);
});

rooms[RoomKeys.Kithen].on(RoomEvent.SignalUpdate, () => {
  devices[0].timerTrigger(true, false);
  devices[1].timerTrigger(true, false);
});

rooms[RoomKeys.DinningRoom].on(RoomEvent.SignalUpdate, () => {
  devices[4].timerTrigger(true, false);
});


/**
 * Iterates over room list object creates simples objects containing only
 * neccesary data for the front end
 * @returns RoomData
 */
export function getRoomsStates(): RoomData[] {
  return Object.keys(rooms).map((key: RoomKeys) => {
    let room = rooms[key];

    return {
      room: key,
      active: room.active,
      data: room.data
    };
  });
}