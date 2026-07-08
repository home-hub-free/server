import axios from "axios";
import { EVENT_TYPES, log } from "../logger";
import type { Node } from "../classes/node.class";
import { deviceNodes } from "../handlers/node.handler";
import { presenceByZone } from "../ambient/live-rooms";

/**
 * Presence power-save for the voice satellites (docs/VOICE_SATELLITE.md §4.7).
 *
 * Split ownership: this watcher owns "is the zone occupied" — fused from the
 * zone's presence/motion sensors (`presenceByZone`, PIR-only ON PURPOSE: the
 * satellite's own camera feeds the vision store, so fusing vision here would be
 * circular — camera off ⇒ vision says empty ⇒ camera stays off). The satellite
 * owns "do I care" (its NVS `eco` setting), so we push occupancy to EVERY
 * satellite in a presence-covered zone and let the firmware decide. Zones with
 * no presence/motion sensor never get pushed — their satellites stay full-power.
 *
 * Debounce is asymmetric, matching the cost of being wrong:
 *  - occupied: pushed IMMEDIATELY on the sensor edge (a person walking in must
 *    find the mic awake before they finish saying "Casita");
 *  - empty: pushed only after the zone has been continuously empty for
 *    SAT_ECO_GRACE_MIN minutes (default 10 — a PIR goes quiet while someone
 *    reads on the couch; the hub-side 10 s sensor grace is far too short).
 *
 * A reconcile sweep re-pushes the truth to every covered satellite every 5
 * minutes: satellite reboots (which boot occupied, fail-safe), zone
 * reassignments, hub restarts and dropped pushes all self-heal — and the sweep
 * doubles as the firmware's retry path for a failed camera resume. Pushes are
 * fire-and-forget: a satellite that's offline just misses one.
 */

const SWEEP_MS = 5 * 60 * 1000;
const graceMs = () => Number(process.env.SAT_ECO_GRACE_MIN || 10) * 60 * 1000;

/** zone -> when it was last seen going empty; absent = currently occupied (or never seen). */
const emptySince = new Map<string, number>();
/** zone -> pending empty-grace timer. */
const emptyTimers = new Map<string, NodeJS.Timeout>();
/** zone -> last occupancy pushed on an edge (dedupe; the sweep pushes unconditionally). */
const lastPushed = new Map<string, boolean>();

const satellitesInZone = (zone: string) =>
  deviceNodes().filter((n) => n.category === "voice-satellite" && n.zone === zone && n.ip);

function pushZone(zone: string, occupied: boolean): void {
  lastPushed.set(zone, occupied);
  for (const sat of satellitesInZone(zone)) {
    axios
      .get(`http://${sat.ip}/presence?occupied=${occupied ? 1 : 0}`, { timeout: 5000 })
      .catch(() => {
        // Offline satellite — the 5-min sweep (or its boot fail-safe) covers it.
      });
  }
}

/** Zone occupancy per the PIR/motion roster; undefined when the zone has no such sensors. */
function zoneOccupied(zone: string): boolean | undefined {
  return presenceByZone().get(zone)?.occupied;
}

/** Mark a zone empty-as-of-now (idempotent) and arm the grace timer that will
 *  push occupied=0 once the zone has stayed empty the whole window. */
function armEmptyGrace(zone: string, now: number): void {
  if (!emptySince.has(zone)) emptySince.set(zone, now);
  if (emptyTimers.has(zone)) return;
  const elapsed = now - (emptySince.get(zone) ?? now);
  const timer = setTimeout(() => {
    emptyTimers.delete(zone);
    if (zoneOccupied(zone) === false && lastPushed.get(zone) !== false) pushZone(zone, false);
  }, Math.max(graceMs() - elapsed, 0));
  timer.unref?.();
  emptyTimers.set(zone, timer);
}

function clearEmptyGrace(zone: string): void {
  emptySince.delete(zone);
  const timer = emptyTimers.get(zone);
  if (timer) {
    clearTimeout(timer);
    emptyTimers.delete(zone);
  }
}

/**
 * Sensor-edge fast path — wired into the same hook the effect orchestrator uses
 * (wire.ts), so it sees every boolean sensor edge (the false edge already behind
 * the Node's 10 s inactive grace). Non-presence sensors are ignored.
 */
export function onPresenceEdge(node: Node): void {
  if (node.category !== "presence" && node.category !== "motion") return;
  const zone = node.zone;
  if (!zone) return;
  const occupied = zoneOccupied(zone);
  if (occupied === undefined) return;
  if (occupied) {
    clearEmptyGrace(zone);
    // Only push the transition — motion sensors re-fire constantly while a room
    // is in use, and every push is a GET into the satellite's control plane.
    if (lastPushed.get(zone) !== true) pushZone(zone, true);
  } else {
    armEmptyGrace(zone, Date.now());
  }
}

/** One reconcile pass: push current truth to every satellite in a presence-covered
 *  zone. Exported for the spec; scheduled by startPresencePower(). */
export function reconcilePresencePower(now = Date.now()): void {
  for (const [zone, entry] of presenceByZone()) {
    if (zone === "(unzoned)") continue;
    if (satellitesInZone(zone).length === 0) continue;
    if (entry.occupied) {
      clearEmptyGrace(zone);
      pushZone(zone, true);
    } else {
      // First time we observe the zone empty (e.g. right after a hub restart):
      // start the grace from NOW — never push a satellite into eco on a guess.
      armEmptyGrace(zone, now);
      pushZone(zone, now - (emptySince.get(zone) ?? now) >= graceMs() ? false : true);
    }
  }
}

let sweep: NodeJS.Timeout | null = null;

/** Boot wiring (index.ts): start the periodic reconcile sweep. */
export function startPresencePower(): void {
  if (sweep) return;
  sweep = setInterval(() => reconcilePresencePower(), SWEEP_MS);
  sweep.unref?.();
  log(EVENT_TYPES.info, [`[presence-power] satellite eco sweep armed (grace ${graceMs() / 60000} min)`]);
}

/** Test hook: clear module state between specs. */
export function _resetPresencePower(): void {
  for (const t of emptyTimers.values()) clearTimeout(t);
  emptyTimers.clear();
  emptySince.clear();
  lastPushed.clear();
  if (sweep) clearInterval(sweep);
  sweep = null;
}
