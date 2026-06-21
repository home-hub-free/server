import { Express } from "express";
import { PRECISION_CATEGORIES } from "../classes/node.class";
import {
  nodes,
  findNode,
  createNode,
  assignNodeIp,
  getDeviceNodes,
  buildClientNodeData,
  NodesDB,
  mergeNodeData,
  mergeNodeValue,
  mergeChannelReadings,
  applyDeclaredChannels,
  coolerControl,
  persistNode,
} from "../handlers/node.handler";
import { io } from "../handlers/websockets.handler";
import { emitDeviceDeclare, emitDeviceState } from "../clients/ingestion";
import { NodeBlinds } from "../classes/node.class";

export function initDeviceRoutes(app: Express) {
  app.get("/get-devices", (request, response) => {
    response.send(getDeviceNodes());
  });

  app.post("/device-get-actions", (request, response) => {
    const stored = NodesDB.get(request.body.id);
    return response.send(stored?.actions ?? []);
  });

  // A device just connected to the network and is trying to declare/ping the server
  app.post("/device-declare", (request, response) => {
    let { id, name, firstPing, channels } = request.body;

    let node = findNode(id);
    if (!node) {
      node = createNode(id, name, request.ip);
      nodes.push(node);
      io.emit("device-declare", buildClientNodeData(node));
      emitDeviceDeclare(node.toClientData());
    } else {
      node.lastPing = new Date();
    }

    // Stage-3 shim: adopt self-described channels (or keep the synthesized schema).
    applyDeclaredChannels(node, channels);
    assignNodeIp(id, request.ip);

    // Re-push stored value on a fresh boot, except for precision (value-owning) devices.
    const isFirstPing = firstPing === "true";
    if (isFirstPing && !PRECISION_CATEGORIES.includes(node.category)) {
      node.notify(node.value);
    }

    response.send(true);
  });

  // Dashboard / agent manually controls a device.
  app.post("/device-update", (request, response) => {
    const node = findNode(request.body.id);
    if (!node) return response.send(false);

    const source =
      request.body.source === "llm" || request.body.source === "voice"
        ? request.body.source
        : "dashboard";

    // Accept either a whole-value write or a channel-addressed one (Stage 4).
    const write =
      request.body.channel != null
        ? node.setChannel(request.body.channel, request.body.value, source)
        : node.manualTrigger(request.body.value, source);

    write
      .then((success) => {
        const clientData = buildClientNodeData(node);
        if (success) persistNode(node);
        response.send(clientData);
      })
      .catch(() => response.send(false));
  });

  app.post("/device-blinds-configure", (request, response) => {
    const { id, action } = request.body;
    const node = findNode(id);
    if (!(node instanceof NodeBlinds)) return response.send(false);

    switch (action) {
      case "spin":
        node.spin();
        break;
      case "switch-direction":
        node.switchDirection();
        break;
      case "home-position":
        node.setHomeValue();
        break;
      case "set-limit":
        node.setLimitValue();
        break;
    }
    response.send(true);
  });

  // Save device config (name, ranges, zone, etc.) — lives in the DB.
  app.post("/devices-data-set", (request, response) => {
    const node = findNode(request.body.id);
    if (!node || !request.body.data) return response.send(false);

    mergeNodeData(node, request.body.data);
    const clientData = buildClientNodeData(node);
    persistNode(node);
    io.emit("device-update", clientData);
    emitDeviceDeclare(node.toClientData()); // registry info may have changed
    response.send(true);
  });

  // Device reports its own readings (e.g. cooler temps); may self-automate.
  app.post("/device-value-set", (request, response) => {
    const { id, value, channels } = request.body;
    const node = findNode(id);
    if (!node) return response.send(false);

    if (Array.isArray(channels)) {
      mergeChannelReadings(node, channels);
    } else {
      mergeNodeValue(node, value);
    }

    // Cooler closed-loop: apply any fan/water change the new temps warrant.
    const updates = coolerControl(node);
    if (updates) {
      mergeNodeValue(node, updates);
      node.autoTrigger(node.value);
    }

    const clientData = buildClientNodeData(node);
    persistNode(node);
    io.emit("device-update", clientData);
    emitDeviceState(node.toClientData(), "device");
    response.send(true);
  });
}
