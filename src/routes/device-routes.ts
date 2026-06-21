import { Express } from "express";
import {
  Device,
  DeviceBlinds,
  DeviceTypesToDataTypes,
  PRECISION_DEVICES,
} from "../classes/device.class";
import {
  devices,
  assignDeviceIpAddress,
  getDevices,
  buildClientDeviceData,
  DevicesDB,
  mergeDeviceData,
  mergeDeviceValue,
  mergeChannelReadings,
  applyDeclaredChannels,
  checkDeviceEffects,
} from "../handlers/device.handler";
import { io } from "../handlers/websockets.handler";
import {
  emitDeviceDeclare,
  emitDeviceState,
} from "../clients/ingestion";

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
    let { id, name, firstPing, channels } = request.body;

    let device = devices.find((device) => device.id === id);
    if (!device) {
      let DeviceClass = Device;
      switch (name) {
        case "blinds":
          DeviceClass = DeviceBlinds;
          break;
        default:
          DeviceClass = Device;
      }
      device = new DeviceClass(
        id,
        name,
        DeviceTypesToDataTypes[name],
        null,
        request.ip,
      );
      devices.push(device);
      io.emit("device-declare", buildClientDeviceData(device));
      emitDeviceDeclare(device);
    } else {
      device.lastPing = new Date();
    }

    // Stage-3 shim: a self-describing device sends its own `channels` and is marked
    // channel-aware (drives channel-addressed `/set`). A legacy device sends none
    // and keeps the constructor-synthesized schema + legacy wire. Idempotent across
    // re-pings; only flips a device forward (never back to legacy).
    applyDeclaredChannels(device, channels);
    assignDeviceIpAddress(id, request.ip);

    /**
     * Device could have been reseted turned off for whatever reason
     * if its the first ping, make sure to update ONLY if its not a
     * precision device, (avoid breaking stuff)
     */
    const isFirstPing = firstPing === "true"; // I don't know how to serialize to bool in cpp yet :(
    if (isFirstPing && !PRECISION_DEVICES.includes(device.deviceCategory)) {
      device.notifyDevice(device.value);
    }

    response.send(true);
  });

  // Client side app trying to interact with a device
  app.post("/device-update", (request, response) => {
    let device = devices.find((device) => device.id === request.body.id);
    if (!device) {
      return response.send(false);
    }

    // Provenance of this write: dashboard (default), voice, or the LLM agent ("llm"). It flows into
    // the ingestion emit so the event-driven agent can drop its own changes and not self-trigger.
    const source = request.body.source === "llm" || request.body.source === "voice" ? request.body.source : "dashboard";
    device
      .manualTrigger(request.body.value, source)
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
    let device: DeviceBlinds = devices.find(
      (device) => device.id === id,
    ) as DeviceBlinds;
    let result = false;
    if (device) {
      result = true;
      switch (action) {
        case "spin":
          device.spin();
          break;
        case "switch-direction":
          device.switchDirection();
          break;
        case "home-position":
          device.setHomeValue();
          break;
        case "set-limit":
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
    io.emit("device-update", clientData);
    // Registry info (name/zone/category) may have changed — re-declare to memory.
    emitDeviceDeclare(device);
    response.send(true);
  });

  // Used to update device value data, different from "device-data-set", in
  // which this endpoint updates read-only data from the device, and this data
  // can be used to run self-automations
  app.post("/device-value-set", (request, response) => {
    const { id, value, channels } = request.body;
    let device = devices.find((device) => device.id === id);
    // Stage-3 shim: accept either the legacy `value` blob or a `channels` array of
    // {key,value} readings. Both fold into the same internal value blob (storage is
    // unchanged in Stage 3 — that's Stage 4).
    if (Array.isArray(channels)) {
      mergeChannelReadings(device, channels);
    } else {
      mergeDeviceValue(device, value);
    }

    // Check if any of the updates values triggers
    // an device effect
    const updates = checkDeviceEffects(device);
    if (updates) {
      mergeDeviceValue(device, updates);
      console.log("Auto triggered from value-set");
      device.autoTrigger(device.value);
    }

    // Update device data after checking if there where updates
    const clientData = buildClientDeviceData(device);
    DevicesDB.set(device.id, clientData);
    io.emit("device-update", clientData);
    // Device-reported readings (e.g. cooler temps) are live telemetry for the LLM.
    emitDeviceState(device, "device");
    response.send(true);
  });
}
