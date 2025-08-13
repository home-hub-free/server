import { log, EVENT_TYPES } from "../logger";
import { Device, DeviceBlinds, DeviceData } from "../classes/device.class";
import JSONdb from "simple-json-db";
import { Request } from "express";
import { createStorageStream } from "./camera-storage-handler";
export const DevicesDB = new JSONdb("db/devices.db.json");

// These get populated as devices join the local network
export const devices: (Device | DeviceBlinds)[] = [
  // new Device('23239', 'test-device-1', 'value'),
  // new Device('12345', 'test-device-2', 'value'),
  // new Device('bool-test', 'evap-cooler', 'value')
];

/**
 * takes a request and gets its ip address to store it into a device, this is
 * to allow both server/device communication back and forth
 * @param deviceId Device Id
 * @param address ip address from NodeJS request
 */
export function assignDeviceIpAddress(deviceId: string, address: string) {
  let device = devices.find((device) => device.id == deviceId);
  const ip = pullIpFromAddress(address);
  if (device && !device.ip) {
    device.ip = ip;
    log(EVENT_TYPES.device_detected, [deviceId, device.name, ip]);
  }

  if (device && device.ip !== ip) {
    device.ip = ip;
    log(EVENT_TYPES.device_new_ip, [deviceId, ip]);
  }

  if (device.deviceCategory === "camera") {
    createStorageStream(device);
  }
}

export function pullIpFromAddress(address: Request["ip"]) {
  let chunks = address.split(":");
  let ip = chunks[chunks.length - 1];
  return ip;
}

export function getDevices(): DeviceData[] {
  return Object.values(devices).map(buildClientDeviceData);
}

export function mergeDeviceData(device: Device, data: any) {
  Object.keys(data).forEach((key: string) => {
    if (key in device) device[key] = data[key];
  });
}

export function mergeDeviceValue(device: Device, value: any) {
  Object.keys(value).forEach((key: string) => {
    device.value[key] = value[key];
  });
}

// Devices can have their own effects based on their own sensors
export function checkDeviceEffects(device: Device) {
  switch (device.deviceCategory) {
    case "evap-cooler":
      return applyEvapCoolerEffects(device);
  }
}

export function applyEvapCoolerEffects(device: Device) {
  const current = device.value;
  const target = current.target;

  // Sensor used inside the room
  const roomTemp = current["room-temp"];

  // Sensor used wherever else, usually inside the cooler (to know output temp), or
  // outside near the cooler (temp of pulled air), whatever is more convinient
  // to know
  const unitTemp = current["unit-temp"];

  const updates: any = {};

  // Turn on water pump half degree sooner, to allow pads to
  // soak, this will only apply when naturally reaching temperature trough-out
  // the day, since if this is turned on in the middle of a hot day, it will
  // likely just turn both water pump and fan on
  const controlTempBelowTarget = unitTemp < target;
  const waterPumpState = roomTemp < target - 0.4 && !controlTempBelowTarget;
  const fanState = roomTemp > target + 0.4;

  if (current.water !== waterPumpState) updates.water = waterPumpState;
  if (current.fan !== fanState) updates.fan = fanState;

  return Object.keys(updates).length ? updates : null;
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
