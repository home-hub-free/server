import axios from 'axios';
import storage from 'node-persist';
import { log, EVENT_TYPES } from '../logger';
import { Device, DeviceData } from '../classes/device.class';
import {
  setSunriseEvent,
  setSunsetEvent,
  dailyEvents,
  addHoursToTimestamp
} from './dailyEventsHandler';

export const devices: Device[] = [
  new Device(1, 'Kitchen lights (down)', 'boolean'),
  new Device(2, 'Kitchen lights (up)', 'boolean', (value) => {
    let blindsRight = devices.find(device => device.id === 3);
    let blindsLeft = devices.find(device => device.id === 4);
    let sum = parseInt(blindsRight.value) + parseInt(blindsLeft.value);
    let hour = new Date().getHours();
    if (value) {
      return hour > 6 && sum < 60;
    }
    return true;
  }),
  new Device(3, 'Livingroom blinds (right)', 'value'),
  new Device(4, 'Livingroom blinds (left)', 'value'),
  new Device(5, 'Dinning/Living room lamp', 'boolean', (value) => {
    let sunset = dailyEvents['sunset'].time;
    let now = new Date().getTime();

    if (value) {
      return now > addHoursToTimestamp(sunset, -1).getTime();
    }
    return true;
  }),
];

/**
 * Randomizes a list of lights to turn on and off for fun
 */
export function randomLights() {
  console.log(devices);
  let lights: Device[] = [devices[0], devices[1], devices[4]];

  setInterval(() => {
    lights.forEach((light: Device) => {
      light.manual = true;
      manualTrigger(light, true);
      setTimeout(() => {
        manualTrigger(light, false);
      }, 100 * (Math.floor(Math.random() * (5 - 1 + 1) + 1)));
    });
  }, 800);
}

/**
 * Initializes the fixed executions of daily devices
 */
export function initDailyDevices() {
  let val = 60;
  setSunriseEvent(`Open living room blinds at ${val}%`, () => {
    let blindsRight = devices.find(device => device.id === 3);
    let blindsLeft = devices.find(device => device.id === 4);
    autoTrigger(blindsRight, val);
    autoTrigger(blindsLeft, val);
  });

  setSunsetEvent('Close living room blinds', () => {
    let blindsRight = devices.find(device => device.id === 3);
    let blindsLeft = devices.find(device => device.id === 4);
    autoTrigger(blindsRight, '0');
    autoTrigger(blindsLeft, '0');
  });
}

/**
 * takes a request and gets its ip address to store it into a device, this is
 * to allow both server/device communication back and forth
 * @param deviceId Device Id
 * @param address ip address from NodeJS request
 */
export function assignDeviceIpAddress(deviceId: number, address: string) {
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
 * Triggers devices based on external behavior, from sensors or daily events. This
 * function will check for device trigger conditions before actually triggering
 * the device
 * @param {Object} device Device object to trigger
 * @param {any} value Value that is being used to trigger the device
 * @param {boolean} force force trigger, ignoring triggerConditions
 */
export function autoTrigger(device: Device, value: any): Promise<any> {
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

  return manualTrigger(device, value).then(() => {
    log(EVENT_TYPES.device_triggered, [device.id, device.name, value]);
  }).catch((err) => {
    log(EVENT_TYPES.error, [err]);
  });
}

/**
 * Triggers a device based on more direct interactions that involve user
 * interactions. This type of trigger will be direct and have no conditions
 * attatched to it
 * @param {Object} device Device object to trigger
 * @param {any} value Value that is being used to trigger the device
 */
export function manualTrigger(device: Device, value: any): Promise<any> {
  let endpoints = {
    boolean: 'toggle',
    value: 'set'
  };

  return notifyDeviceValue(device, endpoints[device.type], value);
}

/**
 * Notifies a device of a value change using its IP address if exists
 */
function notifyDeviceValue(device: Device, endpoint: string, value: any): Promise<any> {
  return new Promise((resolve, reject) => {
    if (!device.ip) {
      reject(`Device without IP address: ${device.name}`);
      return;
    }
    axios.get(`http://${device.ip}/${endpoint}?value=${value}`).then(() => {
      device.value = value;
      storeDeviceValue(device);
      resolve(value);
    }).catch((error) => {
      reject(`Device not found 404, ${device.name} ${error.message}`);
    });
  });
}

/**
 * Iterates over the devices array and return server friendly objects for each device
 */
export function getDevices(): DeviceData[] {
  return Object.values(devices).map((device: Device) => {
    return {
      id: device.id,
      name: device.name,
      value: device.value,
      type: device.type,
      manual: !!device.manual
    };
  });
}

function storeDeviceValue(device: Device) {
  let id = JSON.stringify(device.id);
  let newValue = JSON.stringify(device.value);
  storage.getItem(id).then(value => {
    let args = [id, newValue];
    let fn = value ? 'updateItem' : 'setItem';
    storage[fn].apply(null, args); 
  });
}

function assignDeviceValue(device: Device) {
  let id = JSON.stringify(device.id);
  storage.getItem(id).then(value => {
    if (value) device.value = JSON.parse(value);
    log(EVENT_TYPES.init_value, [id, device.name, value]);
  });
}