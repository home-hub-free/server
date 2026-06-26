import { TimersRepo, TimerRow } from "../db/timers.repo";

/**
 * Timer scheduler — the always-on driver behind user timers/reminders.
 *
 * The LLM agent is event-driven (no internal cron), so a timer set "in ten minutes"
 * has to be fired by something that is always running: the hub. Each tick we pull the
 * timers whose `fire_at` has arrived and announce their message through the injected
 * `announce` sink (in production, the same house speaker the agent's `say` tool uses).
 *
 * `fireDue` and `resolveFireAt` are pure (clock + repo + sink injected) so the firing
 * and the relative/absolute time math are unit-testable without a running interval.
 */
export type Announce = (text: string, zone?: string | null) => void;

const sharedRepo = new TimersRepo();

/** Fire every due timer/reminder at `now`: announce its message, then mark it fired. */
export function fireDue(now: Date, announce: Announce, repo: TimersRepo = sharedRepo): TimerRow[] {
  const due = repo.due(now.toISOString());
  for (const t of due) {
    if (t.message) {
      try {
        announce(t.message, t.zone);
      } catch {
        // A failing speaker must not wedge the tick or re-fire the timer.
      }
    }
    repo.markFired(t.id);
  }
  return due;
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

/** Speak through the hub's announcement sink — lazily required so tests/CLIs needn't load Polly. */
function defaultAnnounce(text: string): void {
  // Lazy import: pulling the assistant singleton at module load would drag in play-sound/Polly.
  const { assistant } = require("../v-assistant/v-assistant.class");
  assistant.say(text, true).catch(() => {});
}
