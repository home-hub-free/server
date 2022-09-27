import { Express } from "express";
import { Device, DeviceTypesToDataTypes } from "../classes/device.class";
import {
  devices,
  assignDeviceIpAddress,
  getDevices,
  buildClientDeviceData,
} from "../handlers/deviceHandler";
import { io } from "../handlers/websocketHandler";

export function initDeviceRoutes(app: Express) {
  app.get("/get-devices", (request, response) => {
    response.send(getDevices());
  });

  // A device just connected to the network and is trying to declare/ping the server
  app.post("/device-declare", (request, response) => {
    let { id, name } = request.body;
    let device = devices.find((device) => device.id === id);

    if (device) {
      response.send(true);
    } else {
      device = new Device(id, name, DeviceTypesToDataTypes[name]);
      io.emit("device-declare", buildClientDeviceData(device));
      devices.push(device);
      assignDeviceIpAddress(id, request.ip);
      response.send(true);
    }
  });

  // Client side app trying to interact with a device
  app.post("/manual-control", (request, response) => {
    let device = devices.find((device) => device.id === request.body.device);
    if (device) {
      // Avoid changing value type devices to manual mode for now
      device
        .manualTrigger(request.body.value)
        .then(() => {
          response.send(true);
          io.emit("device-update", {
            id: device.id,
            value: request.body.value,
          });
          if (!request.body.manual) device.manual = false;
        })
        .catch(() => {
          response.send(false);
        });
    } else {
      response.send(false);
    }
  });
}
