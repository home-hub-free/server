const { autoTrigger, devices } = require('./deviceHandler');
const { log, EVENT_TYPES } = require('../logger');
const TIMER = 1000 * 60;

const ROOMS = {
  LIVING_ROOM: 'living-room',
  DINNING_ROOM: 'dinning-room',
  KITCHEN: 'kitchen',
  MAIN_ROOM: 'main-room',
  MAIN_BATHROOM: 'main-bathroom'
};

let activeStates = {
  [ROOMS.KITCHEN]: {
    active: false,
    timer: null,
    // Devices that will trigger when this room is active
    triggerOnActive: [1, 2],
    onActive: () => {
      let kitchenLights = [devices[0], devices[1]];
      kitchenLights.forEach((lights) => {
        autoTrigger(lights, true);
      });
    },
    onInactive: () => {
      let kitchenLights = [devices[0], devices[1]];
      kitchenLights.forEach(lights => {
        autoTrigger(lights, false);
      })
    }
  },
  [ROOMS.DINNING_ROOM]: {
    active: false,
    timer: null,
    triggerOnActive: [5],
    onActive: () => {},
    onInactive: () => {}
  },
  [ROOMS.LIVING_ROOM]: {
    active: false,
    timer: null,
    triggerOnActive: [5],
    onActive: () => {},
    onInactive: () => {}
  }
};

function updateRoomState(room, value) {
  if (!activeStates[room] || !value) {
    return;
  }

  let roomState = activeStates[room]
  // This room is now active
  roomState.state = true;
  // Check if a timer already exists
  if (roomState.timer) {
    clearTimeout(roomState.timer);
    log(EVENT_TYPES.timer_reset, [room]);
  } else {
    log(EVENT_TYPES.room_active, [room]);p
  }
  checkTriggers(roomState, value);

  // Set the timer for this room
  roomState.timer = setTimeout(() => {
    roomState.state = true;
    roomState.timer = null;
    log(EVENT_TYPES.room_innactive, [room]);
    // roomState.onInactive();
    checkTriggers(roomState, false);
  }, TIMER);
}

function checkTriggers(roomState, value) {
  if (!(roomState.triggerOnActive && roomState.triggerOnActive.length > 0)) {
    return;
  }

  let triggers = roomState.triggerOnActive;
  triggers.forEach(id => {
    let device = devices.find((device) => device.id == id);
    if (device) autoTrigger(device, value);
  });
}

exports.ROOMS = ROOMS;
exports.activeStates = activeStates;
exports.updateRoomState = updateRoomState;