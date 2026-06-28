import { Request } from "express";
import { log, EVENT_TYPES } from "../logger";
import { Node, NodeBlinds, NodeCategory, PRECISION_CATEGORIES } from "../classes/node.class";
import { isObjectBlobCategory, reconcileValueWrite, toBoolean } from "../clients/channels";
import { NodesRepo } from "../db/nodes.repo";
import { computeCoolerUpdates } from "../automation/cooler-controller";

export const NodesDB = new NodesRepo();

/** The single live registry — every device and sensor on the network. */
export const nodes: Node[] = [];

// Wire boot-restore here (node.class can't import this handler — would cycle).
Node.loadRecord = (id: string) => NodesDB.get(id);

const BLINDS_CATEGORY: NodeCategory = "blinds";

/** Construct the right Node subclass for a category. */
export function createNode(id: string, name: string, ip?: string): Node {
  if (name === BLINDS_CATEGORY) return new NodeBlinds(id, name, undefined, ip);
  return new Node(id, name, undefined, ip);
}

export function findNode(id: string): Node | undefined {
  return nodes.find((n) => String(n.id) === String(id));
}

export function pullIpFromAddress(address: Request["ip"]): string {
  const chunks = address.split(":");
  return chunks[chunks.length - 1];
}

/** Assign/refresh a node's IP from a request. */
export function assignNodeIp(id: string, address: string): void {
  const node = findNode(id);
  if (!node) return;
  const ip = pullIpFromAddress(address);

  if (!node.ip) {
    node.ip = ip;
    log(EVENT_TYPES.device_detected, [id, node.name, ip]);
  } else if (node.ip !== ip) {
    node.ip = ip;
    log(EVENT_TYPES.device_new_ip, [id, ip]);
  }
  // Camera media (stream pull + recording) moved off the hub to the box-side
  // vision-service (CAMERA_VISION_PLAN §5.4). The hub keeps the camera in the
  // registry + stream-capability block (see captureStreamDeclare) but never opens
  // a stream — it stays control-plane only.
}

const SENSOR_CATEGORIES = new Set<NodeCategory>(["motion", "presence", "temp/humidity"]);

/** A node is a "sensor" if it's a pure sensor category; everything else (incl. the
 * cooler, which also reports temps) is a "device" for the legacy split endpoints. */
export function isSensorNode(node: Node): boolean {
  return SENSOR_CATEGORIES.has(node.category);
}

export const deviceNodes = () => nodes.filter((n) => !isSensorNode(n));
export const sensorNodes = () => nodes.filter(isSensorNode);

export function getNodes() {
  return nodes.map((n) => n.toClientData());
}

export function getDeviceNodes() {
  return deviceNodes().map((n) => n.toClientData());
}

export function getSensorNodes() {
  return sensorNodes().map(buildClientSensorData);
}

export function buildClientNodeData(node: Node) {
  return node.toClientData();
}

/** Sensor-shaped client payload (matches the legacy buildClientSensorData). */
export function buildClientSensorData(node: Node) {
  // Defensive normalization at the client seam: a scalar boolean sensor always
  // ships a real boolean, so the dashboard's `value === true` never trips on a
  // legacy numeric (0/1) — even before a server restart re-normalizes the node.
  const value =
    node.type === "boolean" && !isObjectBlobCategory(node.category)
      ? toBoolean(node.value)
      : node.value;
  return {
    id: node.id,
    type: node.type,
    name: node.name,
    value,
    sensorType: node.category,
    ip: node.ip,
    ...(node.zone ? { zone: node.zone } : {}),
  };
}

/** Merge incoming config (name/zone/ranges/etc.) into a node, by matching keys. */
export function mergeNodeData(node: Node, data: any): void {
  Object.keys(data).forEach((key) => {
    if (key in node) (node as any)[key] = data[key];
  });
}

/** Persist a node's current state to the unified store. */
export function persistNode(node: Node): void {
  NodesDB.set(node.id, node.toClientData());
}

/** Stage-3 shim: adopt a device's self-declared channel schema (marks it channel-aware). */
export function applyDeclaredChannels(node: Node, channels: any): void {
  if (Array.isArray(channels) && channels.length) {
    node.channelAware = true;
    node.channels = channels;
  }
}

/** Fold a {key,value} channel-reading array into the legacy value blob. */
export function mergeChannelReadings(node: Node, channels: any[]): void {
  channels.forEach((c) => {
    if (!c || c.key == null) return;
    if (node.value && typeof node.value === "object") {
      node.value[c.key] = c.value;
    } else {
      node.value = c.value;
    }
  });
}

/** Merge a partial value object into a node's value blob (cooler telemetry).
 * Routes through `reconcileValueWrite` so object-blob categories merge (never drop
 * absent channels) and ranged settings (`target`) are clamped — the same integrity
 * guard the Node write paths use, applied to the device-telemetry route. */
export function mergeNodeValue(node: Node, value: any): void {
  node.value = reconcileValueWrite(node.category, node.value, value);
}

/**
 * Evap-cooler closed-loop controller. Reads the cooler's channels into a flat
 * snapshot and delegates the hysteresis to the pure `computeCoolerUpdates`
 * (automation/cooler-controller.ts); returns the fan/water updates, or null when
 * nothing should change. Stays hub-local control (works with the brain down).
 */
export function coolerControl(node: Node): { fan?: boolean; water?: boolean } | null {
  if (node.category !== "evap-cooler") return null;
  if (!node.canAutoTrigger()) return null;

  const v = node.value ?? {};
  const updates = computeCoolerUpdates({
    roomTemp: v["room-temp"],
    unitTemp: v["unit-temp"],
    target: v.target,
    fan: v.fan,
    water: v.water,
  });

  return Object.keys(updates).length ? updates : null;
}
