const { triggerDevice, devices } = require('./deviceHandler');
const { log, EVENT_TYPES } = require('../logger');
const TIMER = 1000 * 40;

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
    triggerOnActive: [2]
  }
};


function updateRoomState(room, value) {
  if (!activeStates[room] || !value) {
    return;
  }

  let roomState = activeStates[room]
  // let restarted = false;
  // This room is now active
  roomState.state = true;
  // Check if a timer already exists
  // if (roomState.timer) {
  //   // If exists we clear it to restart it
  //   clearTimeout(roomState.timer);
  //   // restarted = true;
  // } else {
  //   log(EVENT_TYPES.room_active, [room]);
  // }

  roomState.timer ? clearTimeout(roomState.timer) : log(EVENT_TYPES.room_active, [room]);
  checkTriggers(roomState, value);

  // Set the timer for this room
  roomState.timer = setTimeout(() => {
    roomState.state = true;
    roomState.timer = null;
    log(EVENT_TYPES.room_innactive, [room]);
    checkTriggers(roomState, false);
  }, TIMER);

  // if (restarted) {
  //   log(EVENT_TYPES.timer_reset, [room]);
  // }
}

function checkTriggers(roomState, value) {
  if (roomState.triggerOnActive && roomState.triggerOnActive.length > 0) {
    roomState.triggerOnActive.forEach(id => {
      let device = devices.find((device) => device.id == id);
      if (device) triggerDevice(device, value);
    });
  }
}

exports.ROOMS = ROOMS;
exports.activeStates = activeStates;
exports.updateRoomState = updateRoomState;