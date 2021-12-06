const axios = require('axios');
const { log, EVENT_TYPES } = require('../logger');
const moment = require('moment');
const schedule = require('node-schedule');
const storage = require('node-persist');
storage.init({
  dir: './data',

  stringify: JSON.stringify,

  parse: JSON.parse,

  encoding: 'utf8',

  logging: false,  // can also be custom logging function

  ttl: false, // ttl* [NEW], can be true for 24h default or a number in MILLISECONDS or a valid Javascript Date object

  expiredInterval: 2 * 60 * 1000, // every 2 minutes the process will clean-up the expired cache

  // in some cases, you (or some other service) might add non-valid storage files to your
  // storage dir, i.e. Google Drive, make this true if you'd like to ignore these files and not throw an error
  forgiveParseErrors: false
});

const devices = [
  {
    id: 2,
    name: 'Kitchen lights (up)',
    type: 'boolean',
    value: false,
    triggerCondition: (value) => {
      let blinds = devices.find((device) => device.id === 3);
      let blindsClosed = parseInt(blinds.value) === 0;
      value = value === 'true';
      // Only do this validations if we are trying to turn the lights on
      if (value) {
        return (isPastSunSet() || blindsClosed);
      }
      return true;
    },
    ip: null
  },
  {
    id: 3,
    name: 'Livingroom blinds (right)',
    type: 'value',
    value: 0,
    ip: null
  }
];

function assignDeviceIpAddress(deviceId, address) {
  let device = devices.find((device) => device.id == deviceId);
  let chunks = address.split(':');
  let ip = chunks[chunks.length - 1];
  if (device && !device.ip) {
    device.ip = ip;
    log(EVENT_TYPES.device_detected, [deviceId, ip]);
    assignDeviceValue(device);
  }

  if (device.ip !== ip) {
    device.ip = ip;
    log(EVENT_TYPES.device_new_ip, [deviceId, ip]);
  }

}

function triggerDevice(device, value, force) {
  // Check for trigger conditions on the device before triggering
  if (device.triggerCondition && !device.triggerCondition(value) && !force) {
    return;
  }

  // Avoid trigger overall if the value is still the same, this to save server requests
  if (String(value) === String(device.value)) return;

  switch (device.type) {
    case 'boolean':
      triggerBooleanDevice(device, value);
      break;
    case 'value':
      setValueDevice(device, value);
  }
  log(EVENT_TYPES.device_triggered, [device.id, device.name, value]);
}

function setValueDevice(device, value) {
  if (device.ip) {
    axios.get('http://' + device.ip + '/set?value=' + value)
      .then(() => {
        device.value = value;
        storeDeviceValue(device);
      })
      .catch(() => {
        console.log(error.message);
      });
  }
}

function triggerBooleanDevice(device, value) {
  if (device.ip) {
    axios.get('http://' + device.ip + '/toggle?value=' + value)
      .then(() => {
        device.value = value;
        storeDeviceValue(device);
      })
      .catch((error) => {
        console.log(error.message);
      });
  }
}

var rule = new schedule.RecurrenceRule();
rule.hour = 00;
rule.minute = 05;
rule.second = 00;
rule.dayOfWeek = new schedule.Range(0,6);

const dailyEvents = {};
let sunrise = null;
let sunset = null;

const dailyJob = schedule.scheduleJob(rule, () => {
  setDailyEvents();
});

function setDailyEvents() {
  const coords = {
    lat: 20.6064818,
    lng: -100.4898658
  };
  let now = new Date();
  var today = moment(now).format('YYYY-MM-DD');

  axios.get(`https://api.met.no/weatherapi/sunrise/2.0/.json?lat=${coords.lat}&lon=${coords.lng}&date=${today}&offset=-06:00`)
    .then((result) => {
      if (result && result.data && result.data.location && result.data.location.time && result.data.location.time.length > 0) {
        let dayData = result.data.location.time[0];
        sunrise = new Date(dayData.sunrise.time);
        sunset = new Date(dayData.sunset.time);  

        setEvent('open-blinds', 'Opens living room blinds', sunrise, () => triggerDevice(devices[2], '100'));
        setEvent('close-blinds', 'Closes livingroom blinds', sunset, () => triggerDevice(devices[1], '0'));
      }
    })
    .catch(err => {
      log(EVENT_TYPES.error, [err]);
    });
}

function setEvent(name, description, time, execution) {
  dailyEvents[name] = {};
  dailyEvents[name].time = time;
  dailyEvents[name].description = description;
  dailyEvents[name].job = schedule.scheduleJob(time, execution);

  log(EVENT_TYPES.daily_event, [name, description, 'at: ' + moment(time, 'HH:mm:ss').format('hh:mm A')]);
}

function getDailyEvents() {
  return Object.keys(dailyEvents).map((key) => {
    let event = dailyEvents[key];
    return {
      time: moment(event.time, 'HH:mm:ss').format('hh:mm A'),
      name: key,
      description: event.description
    }
  });
}

function isPastSunSet() {
  return sunset.getTime() < (new Date()).getTime();
}

function getDevices() {
  return Object.values(devices).map((device) => {
    return {
      id: device.id,
      name: device.name,
      value: device.value,
      type: device.type
    };
  });
}

function storeDeviceValue(device) {
  let id = JSON.stringify(device.id);
  let newValue = JSON.stringify(device.value);
  storage.getItem(id).then(value => {
    let args = [id, newValue];
    let fn = value ? 'updateItem' : 'setItem';
    storage[fn].apply(null, args); 
  });
}

function assignDeviceValue(device) {
  let id = JSON.stringify(device.id);
  storage.getItem(id).then(value => {
    if (value) device.value = JSON.parse(value);

    log(EVENT_TYPES.init_value, [id, value]);
  });
}

exports.setDailyEvents = setDailyEvents;
exports.getDailyEvents = getDailyEvents;
exports.assignDeviceIpAddress = assignDeviceIpAddress;
exports.triggerDevice = triggerDevice;
exports.getDevices = getDevices;
exports.dailyEvents = dailyEvents;
exports.devices = devices;