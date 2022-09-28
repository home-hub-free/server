import { Express } from "express";
import { Device, DeviceTypesToDataTypes } from "../classes/device.class";
import {
  devices,
  assignDeviceIpAddress,
  getDevices,
  buildClientDeviceData,
  DevicesDB,
  mergeDeviceData,
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
      let deviceData = DevicesDB.get(id);
      device = new Device(id, name, DeviceTypesToDataTypes[name]);
      if (deviceData) mergeDeviceData(device, deviceData);      

      io.emit("device-declare", buildClientDeviceData(device));
      devices.push(device);
      assignDeviceIpAddress(id, request.ip);
      response.send(true);
    }
  });

  // Client side app trying to interact with a device
  app.post('/device-update', (request, response) => {
    let device = devices.find((device) => device.id === request.body.id);
    if (!device) {
      return response.send(false);
    }

    device
      .manualTrigger(request.body.value)
      .then(() => {
        response.send(true);
        io.emit("device-update", {
          id: device.id,
          value: request.body.value,
        });
      })
      .catch(() => {
        response.send(false);
      });
  });

  // Updates information about a device, this information live in DB
  app.post('/device-data-set', (request, response) => {
    let device = devices.find(device => device.id === request.body.id);
    if (!device) return response.send(false);
    if (!request.body.data) return response.send(false);

    let deviceData = DevicesDB.get(device.id);
    if (!deviceData) {
      DevicesDB.set(device.id, request.body.data);
    } else {
      Object.keys(request.body.data).forEach((key: string) => {
        let value = request.body.data[key];
        deviceData[key] = value;
      });
      DevicesDB.set(device.id, deviceData);
    }
    response.send(true);
  });
}
