const moment = require('moment');

const EVENT_TYPES = {
  daily_event: '[DAILY EVENT]',
  device_detected: '[DEVICE DETECTED]',
  device_triggered: '[DEVICE TRIGGERED]',
  device_new_ip: '[DEVICE NEW IP]',
  ping: '[PING]',
  room_active: '[ROOM ACTIVE]',
  room_innactive: '[ROOM_INNACTIVE]',
  timer_reset: '[TIMER RESET]',
  init_value: '[INIT VALUE]',
  error: '[ERROR]'
};

const blockedLogs = [
  EVENT_TYPES.init_value,
  EVENT_TYPES.ping,
  EVENT_TYPES.device_new_ip,
  EVENT_TYPES.device_triggered,
  // EVENT_TYPES.timer_reset
];

// Used just to make sure we log 100% text and not objects
function log(type, texts) {
  if (block(type)) {
    return;
  }

  let display = '';
  texts.forEach((val) => {
    display += ' ' + val + ' ';
  });
  console.log(moment(new Date()).format('LLL'), type, display);
}

function block(type) {
  return blockedLogs.indexOf(type) > -1;
}

exports.log = log;
exports.EVENT_TYPES = EVENT_TYPES;