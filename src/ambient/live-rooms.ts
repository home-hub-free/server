/**
 * Live room fusion from the hub's three perception sources — the single place that turns the ambient
 * store + vision store + PIR sensors into the fused `rooms` world-model (room-digest.ts). Shared by the
 * agent-facing routes (GET /state, GET /rooms) AND the timer scheduler's person-targeted late-bind
 * (PERCEPTION_TO_AGENT_PLAN §3.5) so "where is this person now?" reads the exact same truth the agent does.
 */
import { sensorNodes } from "../handlers/node.handler";
import { ambientByZone } from "./ambient.store";
import { visionByZone } from "./vision.store";
import { roomDigest, RoomDigest } from "./room-digest";

/** Per-zone presence from the PIR/motion sensors (occupied when ANY of a zone's presence/motion sensors
 *  reads true). Unzoned sensors group under "(unzoned)". Used by GET /presence and the fusion below. */
export function presenceByZone(): Map<string, { zone: string; occupied: boolean; sensors: any[] }> {
  const presence = sensorNodes().filter((s) => s.category === "presence" || s.category === "motion");
  const byZone = new Map<string, { zone: string; occupied: boolean; sensors: any[] }>();
  for (const s of presence) {
    const zone = s.zone || "(unzoned)";
    const active = s.value === true;
    const entry = byZone.get(zone) ?? { zone, occupied: false, sensors: [] };
    entry.occupied = entry.occupied || active;
    entry.sensors.push({ id: s.id, name: s.name, category: s.category, active });
    byZone.set(zone, entry);
  }
  return byZone;
}

/** zone -> occupied, for the room-digest fusion. Drops "(unzoned)" (a real zone keys every other source,
 *  and an "(unzoned): occupied" room is meaningless to the agent). */
export function pirOccupiedByZone(): Record<string, boolean> {
  const out: Record<string, boolean> = {};
  for (const z of presenceByZone().values()) {
    if (z.zone === "(unzoned)") continue;
    out[z.zone] = z.occupied;
  }
  return out;
}

/** The fused per-zone world-model (camera roster ⊕ ambient ⊕ PIR) from the live stores. */
export function liveRooms(now = Date.now()): Record<string, RoomDigest> {
  return roomDigest(
    { ambient: ambientByZone(now), vision: visionByZone(now), pir: pirOccupiedByZone() },
    now,
  );
}
