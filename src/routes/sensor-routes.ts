import { Express } from "express";
import axios from "axios";
import { io } from "../handlers/websockets.handler";
import {
  nodes,
  findNode,
  createNode,
  assignNodeIp,
  getSensorNodes,
  buildClientSensorData,
  mergeNodeData,
  persistNode,
} from "../handlers/node.handler";
import { requireAuth } from "../auth/middleware";

// Active calibration polls, keyed by node id, so a re-trigger (or a 409 from a
// still-running pass) never spawns a second poller for the same sensor.
const calibrationPolls = new Set<string>();
const CAL_POLL_INTERVAL_MS = 2000;
// Must outlast the firmware's own CAL_MAX_MS (240s) or the UI reverts to the
// plain button while the device is still mid-pass.
const CAL_POLL_MAX_MS = 300_000;

/**
 * Poll a presence sensor's `GET /status` while it calibrates, relaying `cal_pct`
 * to the dashboard over the existing `sensor-update` channel (Object.assign'd
 * onto the sensor client-side, so the "Calibrate" button can show progress).
 * Detached + self-terminating: stops when the device clears `calibrating` (pass
 * saved, or it bailed) or when the safety cap hits.
 */
async function pollCalibrationProgress(id: string, ip: string): Promise<void> {
  if (calibrationPolls.has(id)) return;
  calibrationPolls.add(id);
  const startedAt = Date.now();
  try {
    // Flip the UI into calibrating state at once — the device just returned 202.
    io.emit("sensor-update", { id, calibrating: true, calPct: 0 });
    while (Date.now() - startedAt < CAL_POLL_MAX_MS) {
      await new Promise((r) => setTimeout(r, CAL_POLL_INTERVAL_MS));
      let status: any;
      try {
        status = (await axios.get(`http://${ip}/status`, { timeout: 3000 })).data;
      } catch {
        continue; // transient — the radar pass keeps the device busy
      }
      const calibrating = status?.calibrating === true;
      const calPct = Number(status?.cal_pct ?? 0);
      io.emit("sensor-update", { id, calibrating, calPct });
      if (!calibrating) return; // finished (saved) or bailed — final event already sent
    }
    // Safety cap reached without the device clearing the flag — clear the UI.
    io.emit("sensor-update", { id, calibrating: false, calPct: 0 });
  } finally {
    calibrationPolls.delete(id);
  }
}

export function initSensorRoutes(app: Express) {
  app.get("/get-sensors", (request, response) => {
    response.send(getSensorNodes());
  });

  // A sensor connected / is pinging (every ~10s).
  app.post("/sensor-declare", (request, response) => {
    const { id, name, value } = request.body;
    let node = findNode(id);

    if (!node) {
      // The firmware never sends its IP in the body — capture it from the
      // connection like /device-declare does. assignNodeIp normalizes the
      // IPv6-mapped form (::ffff:192.168.x.x) and logs IP changes. The IP is
      // what makes the dashboard's presence-sensor "Calibrate" button render,
      // so normalize it before emitting the declare payload.
      node = createNode(id, name, request.ip);
      nodes.push(node);
      assignNodeIp(id, request.ip);
      io.emit("sensor-declare", buildClientSensorData(node));
    } else {
      node.lastPing = new Date();
      assignNodeIp(id, request.ip);
    }
    // Heartbeat reconvergence: when the declare carries the device's current
    // value (latched state), re-apply it so a missed `/sensor-update` edge heals
    // within one heartbeat. No-op when already in sync. Inert for firmware that
    // doesn't yet include `value` in its declare body.
    if (value !== undefined) node.reconcile(value);
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
  app.post("/sensors-data-set", requireAuth, (request, response) => {
    const node = findNode(request.body.id);
    if (!node || !request.body.data) return response.send(false);

    mergeNodeData(node, request.body.data);
    persistNode(node);
    io.emit("sensor-update", buildClientSensorData(node));
    response.send(true);
  });

  // Trigger calibration mode on a presence sensor.
  app.post("/sensor-calibrate", requireAuth, async (request, response) => {
    const node = findNode(request.body.id);
    if (!node || !node.ip) {
      return response.status(400).send({ error: "Sensor not found or IP unknown" });
    }
    try {
      // Firmware: POST /calibrate (non-blocking; 202 "started", 409 if a pass
      // is already running). Defaults trigger/hold/micro=3.0 on the device.
      const deviceRes = await axios.post(`http://${node.ip}/calibrate`, {}, { timeout: 10_000 });
      // Relay live progress to the dashboard until the pass completes (detached).
      void pollCalibrationProgress(node.id, node.ip);
      response.send(deviceRes.data ?? { ok: true });
    } catch (err) {
      // A 409 (already calibrating) surfaces here as a response error.
      if (err.response) {
        return response.status(err.response.status).send(err.response.data);
      }
      // Weak-RSSI units can swallow the POST's *response* while the request
      // itself landed and started the pass (seen live: RSSI −85, 5s timeout,
      // yet the device calibrated to 100%). Before failing the UI, probe
      // /status once — if the pass is running, report started + poll progress.
      try {
        const status = (await axios.get(`http://${node.ip}/status`, { timeout: 5000 })).data;
        if (status?.calibrating === true) {
          void pollCalibrationProgress(node.id, node.ip);
          return response.send({ ok: true, status: "started" });
        }
      } catch {
        // Fall through to the original error.
      }
      console.error(`Failed to calibrate sensor ${request.body.id} at ${node.ip}:`, err.message);
      response.status(500).send({ error: "Failed to reach device" });
    }
  });

  // Toggle a presence sensor's radar debug (engineering) mode. The device
  // streams per-gate energies while it's on and auto-reverts to normal mode
  // after `secs` (firmware-capped), so a dropped dashboard can't strand it.
  app.post("/sensor-debug", requireAuth, async (request, response) => {
    const { id, on, secs } = request.body;
    const node = findNode(id);
    if (!node || !node.ip) {
      return response.status(400).send({ error: "Sensor not found or IP unknown" });
    }
    try {
      const qs = on === false ? "off=1" : `secs=${Number(secs) || 60}`;
      const deviceRes = await axios.post(`http://${node.ip}/debug-bins?${qs}`, {}, { timeout: 10_000 });
      response.send(deviceRes.data ?? { ok: true });
    } catch (err) {
      if (err.response) {
        return response.status(err.response.status).send(err.response.data);
      }
      response.status(500).send({ error: "Failed to reach device" });
    }
  });

  // Live per-gate radar energies for the dashboard's debug view. Plain proxy —
  // the dashboard polls this while the detail overlay's live view is open.
  app.get("/sensor-bins", async (request, response) => {
    const node = findNode(String(request.query.id || ""));
    if (!node || !node.ip) {
      return response.status(400).send({ error: "Sensor not found or IP unknown" });
    }
    try {
      const deviceRes = await axios.get(`http://${node.ip}/bins`, { timeout: 4000 });
      response.send(deviceRes.data);
    } catch {
      response.status(504).send({ error: "Device did not answer" });
    }
  });
}
