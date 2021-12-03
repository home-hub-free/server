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
  init_value: '[INIT VALUE]'
}

// Used just to make sure we log 100% text and not objects
function log(type, texts) {
  let display = '';
  texts.forEach((val) => {
    display += ' ' + val + ' ';
  })
  console.log(moment(new Date()).format('LLL'), type, display);
}

exports.log = log;
exports.EVENT_TYPES = EVENT_TYPES;