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
    let dbStoredData = DevicesDB.get(id);

    if (!device) {
      device = new Device(id, name, DeviceTypesToDataTypes[name]);
      if (dbStoredData) mergeDeviceData(device, dbStoredData);
      io.emit("device-declare", buildClientDeviceData(device));
      devices.push(device);
      assignDeviceIpAddress(id, request.ip);
    } else {
    }
    response.send(true);
  });

  // Client side app trying to interact with a device
  app.post("/device-update", (request, response) => {
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
  app.post("/device-data-set", (request, response) => {
    let device = devices.find((device) => device.id === request.body.id);
    if (!device) return response.send(false);
    if (!request.body.data) return response.send(false);

    let incomingData = request.body.data;
    let dbStoredData = DevicesDB.get(device.id);
    if (!dbStoredData) {
      DevicesDB.set(device.id, incomingData);
    } else {
      Object.keys(incomingData).forEach((key: string) => {
        dbStoredData[key] = incomingData[key];
      });
      DevicesDB.set(device.id, dbStoredData);
    }
    mergeDeviceData(device, incomingData);
    response.send(true);
  });
}
