const axios = require('axios');
const storage = require('node-persist');
const { log, EVENT_TYPES } = require('../logger');
const { 
  setSunriseEvent,
  setSunsetEvent 
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
    name: 'Dinning room lamp',
    value: false,
    type: 'boolean',
    ip: null
  },
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

setSunriseEvent(() => {
  let blinds = devices[2];
  manualTrigger(blinds, '50');
});

setSunsetEvent(() => {
  let dinningLamp = devices[0];
  manualTrigger(dinningLamp, true);
});

function assignDeviceIpAddress(deviceId, address) {
  let device = devices.find((device) => device.id == deviceId);
  let chunks = address.split(':');
  let ip = chunks[chunks.length - 1];
  if (device && !device.ip) {
    device.ip = ip;
    log(EVENT_TYPES.device_detected, [deviceId, ip]);
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
function triggerDevice(device, value, force) {
  // Avoid triggering if device is in manual mode
  if (device.manual) {
    return;
  }

  // Check for trigger conditions on the device before triggering
  if (!device || (device.triggerCondition && !device.triggerCondition(value) && !force)) {
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
      triggerBooleanDevice(device, value);;
    case 'value':
      setValueDevice(device, value)
  }
}

function setValueDevice(device, value) {
  if (device.ip) {
    axios.get('http://' + device.ip + '/set?value=' + value)
      .then(() => {
        device.value = value;
        storeDeviceValue(device);
      })
      .catch((error) => {
        log(EVENT_TYPES.error, [error.message]);
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
        log(EVENT_TYPES.error, [error.message]);
      });
  }
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

    log(EVENT_TYPES.init_value, [id, value]);
  });
}

exports.assignDeviceIpAddress = assignDeviceIpAddress;
exports.triggerDevice = triggerDevice;
exports.getDevices = getDevices;
exports.manualTrigger = manualTrigger;
exports.devices = devices;