import { Express } from "express";
import axios from "axios";
import { io } from "../handlers/websockets.handler";
import {
  nodes,
  findNode,
  createNode,
  getSensorNodes,
  buildClientSensorData,
  mergeNodeData,
  persistNode,
} from "../handlers/node.handler";

export function initSensorRoutes(app: Express) {
  app.get("/get-sensors", (request, response) => {
    response.send(getSensorNodes());
  });

  // A sensor connected / is pinging (every ~10s).
  app.post("/sensor-declare", (request, response) => {
    let { id, name, ip } = request.body;
    let node = findNode(id);

    if (!node) {
      node = createNode(id, name, ip);
      if (ip) node.ip = ip;
      io.emit("sensor-declare", buildClientSensorData(node));
      nodes.push(node);
    } else {
      node.lastPing = new Date();
      if (ip) node.ip = ip;
    }
    response.send(true);
  });

  // A sensor reported a new value.
  app.post("/sensor-update", (request, response) => {
    const { id, value } = request.body;
    const node = findNode(id);
    if (node && value !== undefined) {
      node.report(value);
      response.send(true);
    } else {
      response.send(false);
    }
  });

  // Save sensor config (name, zone, etc.) — lives in the DB.
  app.post("/sensors-data-set", (request, response) => {
    const node = findNode(request.body.id);
    if (!node || !request.body.data) return response.send(false);

    mergeNodeData(node, request.body.data);
    persistNode(node);
    io.emit("sensor-update", buildClientSensorData(node));
    response.send(true);
  });

  // Trigger calibration mode on a presence sensor.
  app.post("/sensor-calibrate", async (request, response) => {
    const node = findNode(request.body.id);
    if (!node || !node.ip) {
      return response.status(400).send({ error: "Sensor not found or IP unknown" });
    }
    try {
      await axios.post(`http://${node.ip}/recalibrate`, {}, { timeout: 5000 });
      response.send({ ok: true });
    } catch (err) {
      console.error(`Failed to calibrate sensor ${request.body.id} at ${node.ip}:`, err.message);
      response.status(500).send({ error: "Failed to reach device" });
    }
  });
}
