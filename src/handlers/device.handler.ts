import { log, EVENT_TYPES } from "../logger";
import { Device, DeviceBlinds, DeviceData } from "../classes/device.class";
import JSONdb from "simple-json-db";
export const DevicesDB = new JSONdb('db/devices.db.json');

// These get populated as devices join the local network
export const devices: (Device | DeviceBlinds)[] = [
  // new Device('23239', 'test-device-1', 'value'),
  // new Device('12345', 'test-device-2', 'value'),
  // new Device('bool-test', 'cooling-system', 'boolean')
];

/**
 * takes a request and gets its ip address to store it into a device, this is
 * to allow both server/device communication back and forth
 * @param deviceId Device Id
 * @param address ip address from NodeJS request
 */
export function assignDeviceIpAddress(deviceId: string, address: string) {
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

export function mergeDeviceData(device: Device, data: any) {
  Object.keys(data).forEach((key: string) => {
    if (key in device) device[key] = data[key];
  });
}

export function buildClientDeviceData(device: Device): DeviceData {
  return {
    id: device.id,
    name: device.name,
    value: device.value,
    type: device.type,
    deviceCategory: device.deviceCategory,
    manual: device.manual,
    operationalRanges: device.operationalRanges,
  };
}
