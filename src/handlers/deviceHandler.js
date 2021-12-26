const axios = require('axios');
const storage = require('node-persist');
const { log, EVENT_TYPES } = require('../logger');
const { 
  setSunriseEvent,
  setSunsetEvent,
  isPastSunset
} = require('./dailyEventsHandler');

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
    id: 1,
    name: 'Kitchen lights (down)',
    type: 'boolean',
    // triggerCondition: (value) => true,
    ip: null
  },
  {
    id: 2,
    name: 'Kitchen lights (up)',
    type: 'boolean',
    value: false,
    triggerCondition: (value) => {
      let blindsRight = devices.find(device => device.id === 3);
      let blindsLeft = devices.find(device => device.id === 4);
      let sum = parseInt(blindsRight.value) + parseInt(blindsLeft.value);
      let hour = new Date().getHours();
      if (value) {
        return hour > 6 && sum < 60;
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
  },
  {
    id: 4,
    name: 'Livingroom blinds (left)',
    type: 'value',
    value: 0,
    ip: null
  },
  {
    id: 5,
    name:'Dinningroom/Livingroom lamp',
    type: 'boolean',
    value: false,
    triggerCondition: (value) => {
      if (value) {
        return isPastSunset();
      }
      return true;
    },
    ip: null
  }
];

function initDailyDevices() {
  setSunriseEvent('Open living room blinds at 60%', () => {
    let blindsRight = devices.find(device => device.id === 3);
    let blindsLeft = devices.find(device => device.id === 4);
    autoTrigger(blindsRight, '40');
    autoTrigger(blindsLeft, '40');
  });

  setSunsetEvent('Close living room blinds', () => {
    let blindsRight = devices.find(device => device.id === 3);
    let blindsLeft = devices.find(device => device.id === 4);
    autoTrigger(blindsRight, '0');
    autoTrigger(blindsLeft, '0');
  });
}

function assignDeviceIpAddress(deviceId, address) {
  let device = devices.find((device) => device.id == deviceId);
  let chunks = address.split(':');
  let ip = chunks[chunks.length - 1];
  if (device && !device.ip) {
    device.ip = ip;
    log(EVENT_TYPES.device_detected, [deviceId, device.name, ip]);
    assignDeviceValue(device);
  }

  if (device && device.ip !== ip) {
    device.ip = ip;
    log(EVENT_TYPES.device_new_ip, [deviceId, ip]);
  }
}

/**
 * Triggers devices based on external behavior, from sensors or daily events.
 * @param {Object} device Device object to trigger
 * @param {any} value Value that is being used to trigger the device
 * @param {boolean} force force trigger, ignoring triggerConditions
 */
function autoTrigger(device, value) {
  // Avoid triggering if device is in manual mode
  if (device.manual) {
    return;
  }

  // Check for trigger conditions on the device before triggering
  if (!device || (device.triggerCondition && !device.triggerCondition(value))) {
    return;
  }

  // Avoid trigger overall if the value is still the same, this to save server requests
  if (String(value) === String(device.value)) return;

  manualTrigger(device, value);
  log(EVENT_TYPES.device_triggered, [device.id, device.name, value]);
}

/**
 * Triggers a device based on more direct interactions that involve user
 * interactions. This type of trigger will be direct and have no conditions
 * attatch to it
 * @param {Object} device Device object to trigger
 * @param {any} value Value that is being used to trigger the device
 */
function manualTrigger(device, value) {
  switch (device.type) {
    case 'boolean':
      notifyDeviceValue(device, 'toggle', value);
      break;
    case 'value':
      notifyDeviceValue(device, 'set', value);
      break;
  }
}

function notifyDeviceValue(device, endpoint, value) {
  if (!device.ip) {
    log(EVENT_TYPES.error, ['Device without IP address:', device.name])
    return;
  }
  axios.get(`http://${device.ip}/${endpoint}?value=${value}`).then(() => {
    device.value = value;
    storeDeviceValue(device);
  }).catch((error) => {
    log(EVENT_TYPES.error, [`Device not found 404, ${device.name}`, error.message]);
  });
}

function getDevices() {
  return Object.values(devices).map((device) => {
    return {
      id: device.id,
      name: device.name,
      value: device.value,
      type: device.type,
      manual: !!device.manual
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
    log(EVENT_TYPES.init_value, [id, device.name, value]);
  });
}

exports.assignDeviceIpAddress = assignDeviceIpAddress;
exports.autoTrigger = autoTrigger;
exports.getDevices = getDevices;
exports.manualTrigger = manualTrigger;
exports.initDailyDevices = initDailyDevices;
exports.devices = devices;