import { Express } from "express";
import { PRECISION_CATEGORIES, NodeCategory, deviceSelfReportMeta } from "../classes/node.class";
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
import { emitDeviceDeclare, emitDeviceState, EventMeta } from "../clients/ingestion";
import { NodeBlinds, captureStreamDeclare } from "../classes/node.class";
import { requireAuth, requireActor } from "../auth/middleware";
import { log, EVENT_TYPES } from "../logger";
import { decideWritePolicy } from "./device-write-policy";

// Categories a blanket "apaga todas las luces" / "apaga todo en la sala" may sweep. Deliberately the
// switchable + dimmable + positional actuators only: the cooler is excluded (it has its own
// set_cooler + a temperature closed loop a flat on/off write would fight), and camera/sensors aren't
// actuatable. The agent scopes a group call by zone and/or category; both omitted = every device here.
const GROUP_CATEGORIES = new Set<NodeCategory>(["light", "door", "dimmable-light", "blinds"]);

/** Map a group request value (a plain on/off, or a 0–100 level) onto what THIS category expects:
 *  a boolean for light/door, a clamped 0–100 number for dimmable-light/blinds. So one "apágalo todo"
 *  (false) turns booleans off AND drives dimmables/blinds to 0; one "ponlo al 40" lights a plain bulb
 *  (40 > 0 → on) and sets a dimmable to 40. */
function coerceGroupValue(category: NodeCategory, value: boolean | number): boolean | number {
  if (category === "light" || category === "door") {
    return typeof value === "boolean" ? value : value > 0;
  }
  const n = typeof value === "boolean" ? (value ? 100 : 0) : value;
  return Math.max(0, Math.min(100, Math.round(n)));
}

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
    let { id, name, firstPing, channels, stream, fw_version } = request.body;

    let node = findNode(id);
    if (!node) {
      node = createNode(id, name, request.ip);
      nodes.push(node);
      io.emit("device-declare", buildClientNodeData(node));
      emitDeviceDeclare(node.toClientData());
    } else {
      node.lastPing = new Date();
    }

    // Camera (and any future device) declares its stream-capability block + firmware
    // version (CAMERA_VISION_PLAN §3.3). Stored verbatim and refreshed on every
    // declare heartbeat — the roster carries it so the box-side vision-service can
    // build the stream URL. The hub never opens the stream itself.
    captureStreamDeclare(node, { stream, fw_version });

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

  // Dashboard / agent manually controls a device. Requires a logged-in user so
  // the action can be attributed (the ESP fleet never hits this route).
  app.post("/device-update", requireActor, (request, response) => {
    const node = findNode(request.body.id);
    if (!node) return response.send(false);

    const source =
      request.body.source === "llm" || request.body.source === "voice"
        ? request.body.source
        : "dashboard";

    // Attribute a dashboard write to the signed-in member so memory/LLM records
    // *who* acted. Agent (llm/voice) writes carry their own provenance via source.
    const actor: EventMeta["actor"] =
      source === "dashboard" && request.user
        ? { id: request.user.id, name: request.user.displayName }
        : undefined;

    // Accept either a whole-value write or a channel-addressed one (Stage 4).
    const channelKey = request.body.channel;
    const channelRole =
      channelKey != null ? (node.channels ?? []).find((c) => c.key === channelKey)?.role : undefined;

    // Decide lock semantics from "is a human behind this write?" (see decideWritePolicy):
    // a dashboard/user-command write bypasses + latches `manual`; an agent-initiative write
    // respects the lock. A `setting`-role channel (cooler `target`) is a setpoint — never gated,
    // never latched (latching would freeze the closed loop that tracks the new target).
    const { skip, latch } = decideWritePolicy({
      source,
      onBehalfOf: request.body.onBehalfOf,
      nodeManual: node.manual,
      channelRole,
    });

    // Manual lock held + no human behind this write (agent initiative, or an un-flagged gateway):
    // drop the actuation so the user's override wins, and log it. 409 makes "did not actuate"
    // unambiguous so the agent can never read a normal node payload back as success.
    if (skip) {
      log(EVENT_TYPES.info, [`Skipped ${source} actuation of ${node.name} — manual lock held (agent initiative)`]);
      return response.status(409).send({ skipped: "manual-locked", id: node.id, name: node.name, manual: true });
    }

    const write =
      channelKey != null
        ? node.setChannel(channelKey, request.body.value, source, latch, undefined, actor)
        : node.manualTrigger(request.body.value, source, actor, latch);

    write
      .then((success) => {
        const clientData = buildClientNodeData(node);
        if (success) persistNode(node);
        response.send(clientData);
      })
      .catch(() => response.send(false));
  });

  // Actuate MANY devices in one shot: "apaga todas las luces", "apaga todo en la sala", "cierra todo".
  // Resolves the switchable devices matching the optional zone and/or category filters and applies a
  // per-category-coerced value to each. Same actor/source contract as /device-update (requireActor):
  // an llm/voice source actuates without latching `manual`; a dashboard write is attributed + latches.
  app.post("/device-update-group", requireActor, (request, response) => {
    const { value, zone, category, source: rawSource, onBehalfOf } = request.body ?? {};
    if (value === undefined || value === null) {
      return response.status(400).send({ ok: false, error: "value required" });
    }
    if (category != null && !GROUP_CATEGORIES.has(category)) {
      return response.status(400).send({ ok: false, error: `category must be one of ${[...GROUP_CATEGORIES].join(", ")}` });
    }

    const source =
      rawSource === "llm" || rawSource === "voice" ? rawSource : "dashboard";
    const actor: EventMeta["actor"] =
      source === "dashboard" && request.user
        ? { id: request.user.id, name: request.user.displayName }
        : undefined;

    const zoneFilter = typeof zone === "string" && zone.trim() ? zone.trim().toLowerCase() : undefined;
    const targets = nodes.filter(
      (n) =>
        GROUP_CATEGORIES.has(n.category) &&
        (!category || n.category === category) &&
        (!zoneFilter || (n.zone || "").toLowerCase() === zoneFilter),
    );

    Promise.all(
      targets.map((n) => {
        const base = { id: n.id, name: n.name, zone: n.zone || undefined, category: n.category };
        // Per-node lock semantics (same policy as /device-update): an agent-initiative sweep
        // skips manually-locked devices instead of stomping them; a dashboard/user-command sweep
        // bypasses + latches. Skips are reported (ok:false + skipped) so the agent doesn't claim them.
        const { skip, latch } = decideWritePolicy({ source, onBehalfOf, nodeManual: n.manual });
        if (skip) {
          log(EVENT_TYPES.info, [`Group: skipped ${source} actuation of ${n.name} — manual lock held`]);
          return Promise.resolve({ ...base, ok: false, skipped: "manual-locked" as const });
        }
        return n
          .manualTrigger(coerceGroupValue(n.category, value), source, actor, latch)
          .then((ok) => {
            if (ok) persistNode(n);
            return { ...base, ok };
          })
          .catch(() => ({ ...base, ok: false }));
      }),
    ).then((devices) => {
      response.send({
        ok: true,
        matched: targets.length,
        applied: devices.filter((d) => d.ok).length,
        skipped: devices.filter((d: any) => d.skipped).length,
        devices,
      });
    });
  });

  // Set / clear a device's `manual` lock explicitly — the agent's (and dashboard's) "go manual /
  // back to automatic" control. requireActor: same trusted-caller contract as /device-update. This
  // is the graceful counterpart to the lock-respecting skip: the agent can take a device off manual
  // (then actuate) or hand it back, instead of silently stomping — or being silently blocked by — a
  // user override. Persisted (survives restart) and broadcast so the dashboard reflects the change.
  app.post("/device-manual", requireActor, (request, response) => {
    const node = findNode(request.body.id);
    if (!node) return response.send(false);

    const on = request.body.manual === true || request.body.manual === "true";
    if (node.setManual(on)) {
      persistNode(node);
      io.emit("device-update", buildClientNodeData(node));
      log(EVENT_TYPES.info, [`${node.name} manual lock ${on ? "engaged" : "released"}`]);
    }
    response.send(buildClientNodeData(node));
  });

  app.post("/device-blinds-configure", requireAuth, (request, response) => {
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
  app.post("/devices-data-set", requireAuth, (request, response) => {
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
    // A closed-loop device (the evap-cooler) governs its own value, so its self-report is
    // part of a chain the reactive agent stays blind to: stamp it `coveredByEffect` so the
    // wake path drops it (true source stays "device" → memory still mines the temps). See
    // deviceSelfReportMeta / CLOSED_LOOP_CATEGORIES.
    emitDeviceState(node.toClientData(), "device", deviceSelfReportMeta(node.category));
    response.send(true);
  });
}
