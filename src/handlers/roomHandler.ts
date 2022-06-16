import { devices } from './deviceHandler';
import { 
  RoomKeys,
  Room,
  RoomMap,
  RoomData,
  RoomEvent
} from '../classes/room.class';
import { emma } from '../emma/emma-assistent.class';
import { getDayTimeWord } from './forecastHandler';

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
  triggerForecastIfNeeded();
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

/**
 * Checks wether we need to trigger the voiced weather forecast
 */
let kitchenTriggerCounts = 0;
let kitchenTriggerTimeout = null;
function triggerForecastIfNeeded() {
  let currentHour = new Date().getHours();
  let dayTimeWord = getDayTimeWord();

  if (emma.autoForecasted[dayTimeWord]) return;

  kitchenTriggerCounts++;
  if (kitchenTriggerCounts >= 10 && currentHour > 6) {
    kitchenTriggerCounts = 0;
    emma.sayWeatherForecast(true);
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