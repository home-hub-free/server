import { log, EVENT_TYPES } from '../logger';
import { Device, DeviceData } from '../classes/device.class';
import {
  dailyEvents,
  setSunriseEvent,
  setSunsetEvent
} from './dailyEventsHandler';

/**
 * TODO: Re-write this so that device data is not hardcoded, instead every device should be responsible
 * for communicating its id, name and data type, attempt to change all the app to that concept for
 * Devices, Sensors, Rooms should also be user defined not code defined
 */
export const devices: Device[] = [
  new Device(1, 'Kitchen lights (down)', 'boolean'),
  new Device(2, 'Kitchen lights (up)', 'boolean'),
  new Device(3, 'Livingroom blinds (right)', 'value'),
  new Device(4, 'Livingroom blinds (left)', 'value'),
  new Device(5, 'Dinning/Living room lamp', 'boolean'),
  new Device(6, 'Kitchen Fan', 'value')
];

// // Kitchen lights up
devices[1].operationalRanges = ['sunrise-23:59'];
// // Dinning room lamp
devices[4].operationalRanges = ['sunset-23:59', '0:0-1:0'];

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

/**
 * Initializes the fixed executions of daily devices
 */
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
    // device.assignStorageValue();
    log(EVENT_TYPES.device_detected, [deviceId, device.name, ip]);
  }

  if (device && device.ip !== ip) {
    device.ip = ip;
    log(EVENT_TYPES.device_new_ip, [deviceId, ip]);
  }
}

export function getDevices(): DeviceData[] {
  return Object.values(devices).map((device: Device) => {
    let data: DeviceData = {
      id: device.id,
      name: device.name,
      value: device.value,
      type: device.type,
      manual: device.manual
    };

    return data;
  });
}