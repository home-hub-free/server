import { randomUUID } from "crypto";
import { nodes } from "../handlers/node.handler";
import { dailyEvents, setSunriseEvent, setSunsetEvent } from "../handlers/daily-events.handler";
import { EffectsDB } from "../routes/effects-routes";
import { log, EVENT_TYPES } from "../logger";
import type { TimeRef } from "./effect.model";
import { defaultTimeResolver } from "./dynamic-evaluate";
import { computeTimeActions } from "./run-effects";
import { applyEffectActions } from "./wire";
import { earliestTimeTrigger, MinutesResolver } from "./time-scheduler";

/**
 * Time-trigger one-shot scheduler — the impure driver (docs/EFFECTS_DYNAMIC.md §3.2).
 *
 * Only a rule whose TRIGGER is `{ source: "time" }` ever arms a timer. The driver is
 * event-driven and idle between boundaries: it computes the single earliest next
 * occurrence across all enabled time triggers (via the pure `earliestTimeTrigger`), arms
 * ONE `setTimeout` to that instant (`.unref()` so it never holds the loop open), and on
 * fire runs the boundary through the same evaluator as the sensor hook, actuates, then
 * re-arms. No polling tick — effect boundaries are known ahead of time.
 *
 * Re-arms on: fire, rule add/remove/edit (effects-routes hook), the daily sunrise/sunset
 * recompute (daily-events hooks), and boot.
 */

/** Minutes-of-day for a solar ref, read from the daily-events handler's resolved times. */
function solarMinutes(ref: TimeRef): number | undefined {
  const slot = (dailyEvents as Record<string, { time?: unknown }>)[ref];
  const t = slot?.time;
  if (t instanceof Date) return t.getHours() * 60 + t.getMinutes();
  if (typeof t === "number" && Number.isFinite(t)) {
    const d = new Date(t);
    return d.getHours() * 60 + d.getMinutes();
  }
  return undefined;
}

/** Live resolver: "HH:MM" via the pure parser, "sunrise"/"sunset" via dailyEvents. */
export const liveMinutesResolver: MinutesResolver = (ref) => {
  const hm = defaultTimeResolver(ref);
  if (hm !== undefined) return hm;
  return solarMinutes(ref);
};

let handle: NodeJS.Timeout | null = null;

/**
 * (Re)arm the single one-shot timer to the earliest upcoming time boundary. Idempotent
 * and cheap — safe to call on every rule change. Clears any pending timer first.
 */
export function rearmTimeEffects(now: Date = new Date()): void {
  if (handle) {
    clearTimeout(handle);
    handle = null;
  }
  const next = earliestTimeTrigger(EffectsDB.getAll(), now, liveMinutesResolver);
  if (!next) return; // no time-triggered rules → stay idle

  const delay = Math.max(0, next.when.getTime() - now.getTime());
  handle = setTimeout(() => {
    handle = null;
    try {
      fireTimeBoundary(next.at);
    } catch (err) {
      log(EVENT_TYPES.error, [`time-effect fire failed: ${err}`]);
    }
    rearmTimeEffects(); // re-arm for the following boundary
  }, delay);
  handle.unref?.(); // never keep the event loop alive solely for this
}

/** Fire all effects whose time trigger is `at`: evaluate against live state, actuate. */
export function fireTimeBoundary(at: TimeRef, now: Date = new Date()): void {
  const actions = computeTimeActions(
    EffectsDB.getAll(),
    at,
    (id) => {
      const target = nodes.find((n) => n.id === id);
      return target ? { category: target.category, value: target.value, manual: target.manual } : undefined;
    },
    now,
    liveMinutesResolver,
  );
  // A time boundary has no sensor node; the causedBy link records the synthetic trigger so
  // memory/Discovery can still reconstruct the chain (one id per boundary occurrence).
  applyEffectActions(actions, { nodeId: `time:${at}`, channel: "time", correlationId: randomUUID() });
  log(EVENT_TYPES.daily_event, [`Time effect boundary ${at} → ${actions.length} action(s)`]);
}

/** Boot: arm the next boundary and re-arm whenever the daily sunrise/sunset times change. */
export function initTimeEffects(): void {
  setSunriseEvent("rearm time effects", () => rearmTimeEffects());
  setSunsetEvent("rearm time effects", () => rearmTimeEffects());
  rearmTimeEffects();
}

/** Stop the scheduler (tests / shutdown). */
export function stopTimeEffects(): void {
  if (handle) {
    clearTimeout(handle);
    handle = null;
  }
}
