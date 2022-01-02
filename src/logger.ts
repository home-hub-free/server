const moment = require('moment');

export const EVENT_TYPES = {
  daily_event: '[DAILY EVENT]',
  device_detected: '[DEVICE DETECTED]',
  device_triggered: '[DEVICE TRIGGERED]',
  device_new_ip: '[DEVICE NEW IP]',
  ping: '[PING]',
  room_active: '[ROOM ACTIVE]',
  room_signal: '[ROOM SIGNAL]',
  room_innactive: '[ROOM_INNACTIVE]',
  timer_reset: '[TIMER RESET]',
  init_value: '[INIT VALUE]',
  error: '[ERROR]'
};

const blockedLogs = [
  // EVENT_TYPES.daily_event,
  // EVENT_TYPES.device_detected,
  // EVENT_TYPES.device_triggered,
  // EVENT_TYPES.device_new_ip,
  // EVENT_TYPES.ping,
  // EVENT_TYPES.room_active,
  // EVENT_TYPES.room_innactive,
  // EVENT_TYPES.timer_reset,
  EVENT_TYPES.init_value,
];

// Used just to make sure we log 100% text and not objects
export function log(type, texts) {
  if (block(type)) {
    return;
  }

  let display = '';
  texts.forEach((val) => {
    display += ' ' + val + ' ';
  });

  let value = moment(new Date()).format('LLL') + ' ' + type + ' ' + display;
  console.log(value);
  return value;
}

function block(type) {
  return blockedLogs.indexOf(type) > -1;
}