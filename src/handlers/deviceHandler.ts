import { log, EVENT_TYPES } from "../logger";
import { Device, DeviceData } from "../classes/device.class";
import {
  setSunriseEvent,
  setSunsetEvent,
} from "./dailyEventsHandler";

// These get populated as devices join the local network
export const devices: Device[] = [];

/**
 * Initializes the fixed executions of daily devices
 */
export function initDailyDevices() {
  let val = 35;
  let blinds = devices.filter((device) => device.id === 3 || device.id === 4);
  setSunriseEvent(`Open living room blinds at ${val}%`, () => {
    blinds.forEach((dev) => dev.autoTrigger(val));
  });

  setSunsetEvent("Close living room blinds", () => {
    blinds.forEach((dev) => dev.autoTrigger(0));
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
  let chunks = address.split(":");
  let ip = chunks[chunks.length - 1];
  if (device && !device.ip) {
    device.ip = ip;
    log(EVENT_TYPES.device_detected, [deviceId, device.name, ip]);
  }

  if (device && device.ip !== ip) {
    device.ip = ip;
    log(EVENT_TYPES.device_new_ip, [deviceId, ip]);
  }
}

export function getDevices(): DeviceData[] {
  return Object.values(devices).map(buildClientDeviceData);
}

export function buildClientDeviceData(device: Device): DeviceData {
  return {
    id: device.id,
    name: device.name,
    value: device.value,
    type: device.type,
    manual: device.manual,
  };
}
