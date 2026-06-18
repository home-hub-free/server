import { io } from "./websockets.handler";

/**
 * In-memory ring buffer of device diagnostic logs.
 *
 * Deliberately NOT persisted to SQLite: the control-plane DB is local to the hub
 * and authoritative (see CLAUDE.md). Device logs are ephemeral diagnostics — a
 * live tail for the /ops page — so a bounded in-memory buffer is the right home.
 * Restarting the hub clears them, which is fine.
 */
export interface DeviceLogEntry {
  id: string;
  name?: string;
  level: string;
  msg: string;
  ms?: number; // device-side millis() since boot, if reported
  at: number; // server receive time (epoch ms)
}

const MAX_ENTRIES = 1000;
const buffer: DeviceLogEntry[] = [];

// Append a log line, trim to the cap, and push it live to dashboards/ops page.
export function addDeviceLog(entry: Omit<DeviceLogEntry, "at">): DeviceLogEntry {
  const full: DeviceLogEntry = { ...entry, at: Date.now() };
  buffer.push(full);
  if (buffer.length > MAX_ENTRIES) {
    buffer.splice(0, buffer.length - MAX_ENTRIES);
  }
  if (io) io.emit("device-log", full);
  return full;
}

// Recent backlog, optionally filtered to one device, capped to `limit` lines.
export function getDeviceLogs(id?: string, limit = 200): DeviceLogEntry[] {
  let out = id ? buffer.filter((e) => String(e.id) === String(id)) : buffer.slice();
  if (limit > 0 && out.length > limit) out = out.slice(out.length - limit);
  return out;
}
