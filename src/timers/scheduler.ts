import { TimersRepo, TimerRow } from "../db/timers.repo";
import { liveRooms } from "../ambient/live-rooms";
import type { RoomDigest } from "../ambient/room-digest";
import { log, EVENT_TYPES } from "../logger";

/**
 * Timer scheduler — the always-on driver behind user timers/reminders.
 *
 * The LLM agent is event-driven (no internal cron), so a timer set "in ten minutes"
 * has to be fired by something that is always running: the hub. Each tick we pull the
 * timers whose `fire_at` has arrived and announce their message through the injected
 * `announce` sink (in production, the same house speaker the agent's `say` tool uses).
 *
 * PERSON-TARGETED reminders (PERCEPTION_TO_AGENT_PLAN §3.5) are LATE-BOUND: a reminder set
 * "for Ana" at 3pm is delivered to whatever room Ana is in when it fires at 6pm — resolved
 * here, at fire time, from the fused world-model (live-rooms.ts). If Ana isn't reachable we
 * HOLD it (never broadcast a personal line to an empty house) until a bounded window lapses,
 * then drop it to a quiet surface.
 *
 * `fireDue`, `planDelivery`, `personZone` and `resolveFireAt` are pure (clock + repo + rooms
 * + sinks injected) so the firing logic and time math are unit-testable without an interval.
 */
export type Announce = (text: string, zone?: string | null) => void;
/** Fallback for an undeliverable personal line — a quiet, non-spoken surface (logged note today; a
 *  dashboard/phone-note store can replace it). The contract is "never speak it to the wrong room / an
 *  empty house". */
export type QuietSurface = (timer: TimerRow) => void;

// How long a person-targeted reminder is HELD waiting for its target to become reachable before it falls
// back to the quiet surface. Bounded so a reminder for someone who never comes home doesn't linger forever.
const HOLD_WINDOW_MS = Number(process.env.REMINDER_HOLD_WINDOW_MS ?? 30 * 60 * 1000); // 30m

const sharedRepo = new TimersRepo();

/** The zone a target person is currently in, per the fused world-model — matched by id OR display name
 *  (the agent tags a reminder with whichever it knows). undefined when they aren't seen in any zone. */
export function personZone(rooms: Record<string, RoomDigest>, target: string): string | undefined {
  const t = target.trim().toLowerCase();
  if (!t) return undefined;
  for (const r of Object.values(rooms)) {
    for (const p of r.people ?? []) {
      if ((p.id && p.id.toLowerCase() === t) || (p.name && p.name.trim().toLowerCase() === t)) return r.zone;
    }
  }
  return undefined;
}

export type DeliveryPlan =
  | { action: "announce"; zone: string | null }
  | { action: "hold"; reason: string }
  | { action: "quiet-surface"; reason: string };

/** Decide how a due timer/reminder is delivered. A general timer announces to its stored zone (or
 *  house-wide). A PERSON-TARGETED reminder late-binds to wherever the person is now; if unreachable it
 *  HOLDS within a bounded window (don't blurt to an empty house), then quiet-surfaces. Pure. */
export function planDelivery(t: TimerRow, rooms: Record<string, RoomDigest>, now: Date): DeliveryPlan {
  if (!t.for_person) return { action: "announce", zone: t.zone };
  const zone = personZone(rooms, t.for_person);
  if (zone) return { action: "announce", zone };
  const fireAtMs = t.fire_at ? Date.parse(t.fire_at) : now.getTime();
  const waited = now.getTime() - (Number.isNaN(fireAtMs) ? now.getTime() : fireAtMs);
  return waited < HOLD_WINDOW_MS
    ? { action: "hold", reason: `${t.for_person} not reachable` }
    : { action: "quiet-surface", reason: `${t.for_person} not reachable after hold window` };
}

/** Fire every due timer/reminder at `now`. General timers announce immediately; person-targeted reminders
 *  route to the target's current zone, hold while they're away, or quiet-surface once the window lapses.
 *  Held reminders stay pending (re-evaluated next tick); fired/quiet-surfaced ones are marked fired. */
export function fireDue(
  now: Date,
  announce: Announce,
  repo: TimersRepo = sharedRepo,
  opts: { rooms?: Record<string, RoomDigest>; quietSurface?: QuietSurface } = {},
): TimerRow[] {
  const quietSurface = opts.quietSurface ?? defaultQuietSurface;
  let rooms = opts.rooms; // resolved lazily — only person-targeted reminders need the world-model
  const getRooms = (): Record<string, RoomDigest> => (rooms ??= liveRooms(now.getTime()));

  const fired: TimerRow[] = [];
  for (const t of repo.due(now.toISOString())) {
    const plan: DeliveryPlan = t.for_person
      ? planDelivery(t, getRooms(), now)
      : { action: "announce", zone: t.zone };
    if (plan.action === "hold") continue; // leave pending; the next tick re-checks reachability
    if (t.message) {
      try {
        if (plan.action === "announce") announce(t.message, plan.zone);
        else quietSurface(t); // undeliverable personal line → quiet surface, never broadcast
      } catch {
        // A failing speaker/surface must not wedge the tick or re-fire the timer.
      }
    }
    repo.markFired(t.id);
    fired.push(t);
  }
  return fired;
}

/** Default quiet surface: a logged note (never spoken). Replace with a dashboard/phone-note store later. */
function defaultQuietSurface(t: TimerRow): void {
  log(EVENT_TYPES.info, [`reminder for ${t.for_person} held out (not reachable); kept quiet:`, t.message ?? ""]);
}

/**
 * Compute an ISO fire time from the agent's loose inputs:
 *   - seconds / minutes → relative to `now`;
 *   - at "HH:MM"        → the next occurrence of that clock time (today, or tomorrow if passed);
 *   - at ISO8601        → used verbatim.
 * Returns null when nothing usable was given.
 */
export function resolveFireAt(
  now: Date,
  opts: { seconds?: number; minutes?: number; at?: string },
): string | null {
  if (typeof opts.seconds === "number" && opts.seconds > 0) {
    return new Date(now.getTime() + opts.seconds * 1000).toISOString();
  }
  if (typeof opts.minutes === "number" && opts.minutes > 0) {
    return new Date(now.getTime() + opts.minutes * 60_000).toISOString();
  }
  if (opts.at && opts.at.trim()) {
    const at = opts.at.trim();
    const hm = /^(\d{1,2}):(\d{2})$/.exec(at);
    if (hm) {
      const h = Number(hm[1]);
      const m = Number(hm[2]);
      if (h > 23 || m > 59) return null;
      const fire = new Date(now);
      fire.setHours(h, m, 0, 0);
      if (fire.getTime() <= now.getTime()) fire.setDate(fire.getDate() + 1);
      return fire.toISOString();
    }
    const parsed = Date.parse(at);
    if (!Number.isNaN(parsed)) return new Date(parsed).toISOString();
  }
  return null;
}

let handle: NodeJS.Timeout | null = null;

/** Start the periodic tick. `announce` defaults to the house speaker; injectable for tests. */
export function initTimers(announce?: Announce, intervalMs = 5000): void {
  if (handle) return;
  const sink = announce ?? defaultAnnounce;
  handle = setInterval(() => {
    try {
      fireDue(new Date(), sink);
    } catch {
      // never let a tick error kill the interval
    }
  }, intervalMs);
  // Don't keep the event loop alive solely for the tick.
  handle.unref?.();
}

export function stopTimers(): void {
  if (handle) {
    clearInterval(handle);
    handle = null;
  }
}

/** Speak through the hub's announcement sink — lazily required so tests/CLIs needn't load Polly. Honors
 *  the `zone` (today it routes to that zone's satellite when one is configured, else the box — see
 *  v-assistant say()); previously the zone was dropped here. */
function defaultAnnounce(text: string, zone?: string | null): void {
  // Lazy import: pulling the assistant singleton at module load would drag in play-sound/Polly.
  const { assistant } = require("../v-assistant/v-assistant.class");
  assistant.say(text, true, zone ?? undefined).catch(() => {});
}
