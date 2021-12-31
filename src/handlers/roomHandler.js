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
    data: {},
    onActive: () => {
      [devices[0], devices[1]].forEach(lights => {
        autoTrigger(lights, true);
      });
    },
    onInactive: () => {
      [devices[0], devices[1]].forEach(lights => {
        autoTrigger(lights, false);
      });
    }
  },
  [ROOMS.DINNING_ROOM]: {
    active: false,
    timer: null,
    data: {},
    onActive: () => autoTrigger(devices[4], true),
    onInactive: () => autoTrigger(devices[4], false)
    
  },
  [ROOMS.LIVING_ROOM]: {
    active: false,
    timer: null,
    data: {},
    onActive: () => {
      let dinningLamp = devices[4];
      let kitchenLightsDown = devices[0];
      let now = new Date();
      let hour = now.getHours();
      autoTrigger(dinningLamp, true);
      // Is past 12am and before 6am
      if (hour < 6) {
        autoTrigger(kitchenLightsDown, true);
      }
    },
    onInactive: () => {
      // autoTrigger(devices[4], false);
      let dinningLamp = devices[4];
      let kitchenLightsDown = devices[0];
      let now = new Date();
      let hour = now.getHours();
      autoTrigger(dinningLamp, false);
      // Is past 12am and before 6am
      if (hour < 6) {
        autoTrigger(kitchenLightsDown, false);
      }
    }
  },
  [ROOMS.MAIN_ROOM]: {
    active: false,
    timer: null,
    data: {},
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
    roomState.active = true;
    roomState.onActive();
    log(EVENT_TYPES.room_active, [room]);
  }

  // Set the timer for this room
  roomState.timer = setTimeout(() => {
    roomState.active = false;
    roomState.timer = null;
    roomState.onInactive();
    log(EVENT_TYPES.room_innactive, [room]);
  }, TIMER);
}

function updateRoomData(room, cb) {
  cb(activeStates[room].data);
}

// Deprecated
// function checkTriggers(roomState, value) {
//   if (!(roomState.triggerOnActive && roomState.triggerOnActive.length > 0)) {
//     return;
//   }

//   let triggers = roomState.triggerOnActive;
//   triggers.forEach(id => {
//     let device = devices.find((device) => device.id == id);
//     if (device) autoTrigger(device, value);
//   });
// }

function getRoomsStates() {
  return Object.keys(activeStates).map(key => {
    let state = activeStates[key];
    return {
      room: key,
      active: state.active,
      data: state.data
    };
  });
}

exports.ROOMS = ROOMS;
exports.activeStates = activeStates;
exports.updateRoomState = updateRoomState;
exports.updateRoomData = updateRoomData;
exports.getRoomsStates = getRoomsStates;