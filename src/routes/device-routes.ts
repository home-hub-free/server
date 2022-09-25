import { Express } from "express";
import { Device, DeviceTypesToDataTypes } from "../classes/device.class";
import {
  devices,
  assignDeviceIpAddress,
  getDevices,
} from "../handlers/deviceHandler";

export function initDeviceRoutes(app: Express) {
  app.get("/get-devices", (request, response) => {
    response.send(getDevices());
  });

  app.post("/device-declare", (request, response) => {
    let { id, name } = request.body;
    let device = devices.find((device) => device.id === id);

    if (device) {
      response.send(true);
    } else {
      device = new Device(id, name, DeviceTypesToDataTypes[name]);
      devices.push(device);
      assignDeviceIpAddress(id, request.ip);
      response.send(true);
    }
  });

  app.post("/manual-control", (request, response) => {
    let device = devices.find((device) => device.id === request.body.device);
    if (device) {
      // Avoid changing value type devices to manual mode for now
      device
        .manualTrigger(request.body.value)
        .then(() => {
          response.send(true);
          if (!request.body.manual) device.manual = false;
        })
        .catch(() => {
          response.send(false);
        });
    }
  });
}
