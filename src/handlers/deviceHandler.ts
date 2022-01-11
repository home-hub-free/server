// import storage from 'node-persist';
import { log, EVENT_TYPES } from '../logger';
import { Device, ServerDevice } from '../classes/device.class';
import {
  setSunriseEvent,
  setSunsetEvent
} from './dailyEventsHandler';

export const devices: Device[] = [
  new Device(1, 'Kitchen lights (down)', 'boolean'),
  new Device(2, 'Kitchen lights (up)', 'boolean', (device) => {
    let sum = getBlindsOpeness();
    let hour = new Date().getHours();
    if (device.value) {
      return hour > 6 && sum < 50;
    }
    return true;
  }),
  new Device(3, 'Livingroom blinds (right)', 'value'),
  new Device(4, 'Livingroom blinds (left)', 'value'),
  new Device(5, 'Dinning/Living room lamp', 'boolean', (device) => {
    let sum = getBlindsOpeness();
    let hour = new Date().getHours();
    if (device.value) {
      return hour > 6 && sum < 50;
    }
    return true;
  }),
];

/**
 * Used once for new years, ill keep this code laying around
 */
export function randomLights() {
  console.log(devices);
  let lights = [devices[0], devices[1], devices[4]];
  setInterval(() => {
    lights.forEach((light) => {
      light.manualTrigger(true);
      setTimeout(() => {
        light.manualTrigger(false);
      }, 100 * (Math.floor(Math.random() * (5 - 1 + 1) + 1)));
    });
  }, 800);
}

export function initDailyDevices() {
  let val = 35;
  let blinds = devices.filter((device) => device.id === 3 || device.id === 4);
  setSunriseEvent(`Open living room blinds at ${val}%`, () => {
    blinds.forEach(dev => dev.autoTrigger(val));
  });

  setSunsetEvent('Close living room blinds', () => {
    blinds.forEach(dev => dev.autoTrigger(0));
  });
}

export function assignDeviceIpAddress(deviceId, address) {
  let device = devices.find((device) => device.id == deviceId);
  let chunks = address.split(':');
  let ip = chunks[chunks.length - 1];
  if (device && !device.ip) {
    device.ip = ip;
    device.assignStorageValue();
    log(EVENT_TYPES.device_detected, [deviceId, device.name, ip]);
  }

  if (device && device.ip !== ip) {
    device.ip = ip;
    log(EVENT_TYPES.device_new_ip, [deviceId, ip]);
  }
}

export function getDevices(): ServerDevice[] {
  return Object.values(devices).map((device: Device) => {
    let data: ServerDevice = {
      id: device.id,
      name: device.name,
      value: device.value,
      type: device.type,
      manual: device.manual
    };

    return data;
  });
}

function getBlindsOpeness(): number {
  let blindsRight = devices.find(device => device.id === 3);
  let blindsLeft = devices.find(device => device.id === 4);
  let sum = parseInt(blindsRight.value) + parseInt(blindsLeft.value);
  return sum;
}