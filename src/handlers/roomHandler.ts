import { devices } from './deviceHandler';
import { 
  RoomKeys,
  Room,
  RoomMap,
  RoomData,
  RoomEvent
} from '../classes/room.class';
import { hasBeenGreeted, speakDayResume } from './dailyEventsHandler';
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
  triggerMorningForecastIfNeeded();
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

let kitchenTriggerCounts = 0;
let kitchenTriggerTimeout = null;
function triggerMorningForecastIfNeeded() {
  if (hasBeenGreeted) {
    return;
  }

  let hour = new Date().getHours();
  kitchenTriggerCounts++;
  if (kitchenTriggerCounts >= 4 && !hasBeenGreeted && hour <= 11 && hour >= 6) {
    kitchenTriggerCounts = 0;
    speakDayResume();
  }
  
  if (kitchenTriggerTimeout) {
    clearTimeout(kitchenTriggerTimeout);
    kitchenTriggerTimeout = null;
  }

  // Monitor for continious activity, otherwise clear the counter
  kitchenTriggerTimeout = setTimeout(() => {
    kitchenTriggerCounts = 0;
    kitchenTriggerTimeout = null;
  }, 1000 * 8);
}