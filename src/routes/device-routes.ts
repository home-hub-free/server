import { Express } from "express";
import { Device, DeviceBlinds, DeviceTypesToDataTypes } from "../classes/device.class";
import {
  devices,
  assignDeviceIpAddress,
  getDevices,
  buildClientDeviceData,
  DevicesDB,
  mergeDeviceData,
} from "../handlers/device.handler";
import { io } from "../handlers/websockets.handler";

export function initDeviceRoutes(app: Express) {
  app.get("/get-devices", (request, response) => {
    response.send(getDevices());
  });

  app.post("/device-get-actions", (request, response) => {
    let { id } = request.body;
    let dbStoredData = DevicesDB.get(id);
    if (dbStoredData.actions) return response.send(dbStoredData.actions);
    return response.send([]);
  });

  // A device just connected to the network and is trying to declare/ping the server
  app.post("/device-declare", (request, response) => {
    let { id, name } = request.body;

    let device = devices.find((device) => device.id === id);
    if (!device) {
      let DeviceClass = Device;
      switch (name) {
        case 'blinds':
          DeviceClass = DeviceBlinds;
          break;
        default:
          DeviceClass = Device;
      }
      device = new DeviceClass(id, name, DeviceTypesToDataTypes[name]);
      devices.push(device);
      io.emit("device-declare", buildClientDeviceData(device));
    } else {
      device.lastPing = new Date();
    }
    assignDeviceIpAddress(id, request.ip);

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
      .then((success) => {
        const clientData = buildClientDeviceData(device);
        if (success) {
          DevicesDB.set(device.id, clientData);
        }
        response.send(clientData);
      })
      .catch(() => {
        response.send(false);
      });
  });

  app.post("/device-blinds-configure", (request, response) => {
    const { id, action } = request.body;
    let device: DeviceBlinds = devices.find((device) => device.id === id) as DeviceBlinds;
    let result = false;
    if (device) {
      result = true;
      switch (action) {
        case 'spin':
          device.spin();
          break;
        case 'switch-direction':
          device.switchDirection();
          break;
        case 'home-position':
          device.setHomeValue();
          break;
        case 'set-limit':
          device.setLimitValue();
          break;
      }
    }

    response.send(result);
  });

  // Updates information about a device, this information live in DB
  app.post("/devices-data-set", (request, response) => {
    let device = devices.find((device) => device.id === request.body.id);
    if (!device) return response.send(false);
    if (!request.body.data) return response.send(false);

    let incomingData = request.body.data;
    mergeDeviceData(device, incomingData);
    const clientData = buildClientDeviceData(device);
    DevicesDB.set(device.id, clientData);
    io.emit('device-update', clientData);
    response.send(true);
  });
}
