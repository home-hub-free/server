import type { Effect, TimeRef } from "./effect.model";

/**
 * Time-trigger scheduling math — the PURE core (docs/EFFECTS_DYNAMIC.md §3.2, Stage 2).
 *
 * No live imports (no node registry, no daily-events, no port-binding handlers), so it is
 * unit-testable off the live box. The impure driver that arms the actual `setTimeout` and
 * actuates lives in `time-scheduler-driver.ts`; it injects the resolver + reads the store.
 */

/** Resolve a TimeRef to minutes-since-midnight for `now`'s day, or undefined if unknown. */
export type MinutesResolver = (ref: TimeRef, now: Date) => number | undefined;

/**
 * The next future instant a TimeRef occurs: today at that time, or tomorrow if it has
 * already passed. Returns null when the ref can't be resolved (e.g. a solar ref before
 * dailyEvents is populated) — that trigger is simply not armed until the next re-arm.
 */
export function nextOccurrence(at: TimeRef, now: Date, resolve: MinutesResolver): Date | null {
  const mins = resolve(at, now);
  if (mins === undefined) return null;
  const d = new Date(now);
  d.setHours(Math.floor(mins / 60), mins % 60, 0, 0);
  if (d.getTime() <= now.getTime()) d.setDate(d.getDate() + 1);
  return d;
}

/** The earliest next occurrence across all enabled time-triggered effects. */
export function earliestTimeTrigger(
  effects: Effect[],
  now: Date,
  resolve: MinutesResolver,
): { at: TimeRef; when: Date } | null {
  let best: { at: TimeRef; when: Date } | null = null;
  for (const e of effects) {
    if (e.enabled === false || e.trigger.source !== "time") continue;
    const when = nextOccurrence(e.trigger.at, now, resolve);
    if (when && (!best || when.getTime() < best.when.getTime())) best = { at: e.trigger.at, when };
  }
  return best;
}
