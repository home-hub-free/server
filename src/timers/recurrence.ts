/**
 * Recurrence rules for agenda rows (LOCAL_AGENDA) — pure date math, no DB, no clock of its own.
 *
 * The rule is a compact string stored in `timers.recurrence`:
 *   'daily' | 'weekdays' | 'weekly' | 'weekly:1,3,5' (0 = Sunday) | 'monthly' | 'yearly'
 * Deliberately NOT RRULE: the household asks for "every day", "weekdays", "every Tuesday and
 * Thursday", "every month on the 5th", "every year" — nothing an RRULE parser would add is
 * reachable from the dashboard form or from speech today.
 *
 * All arithmetic is in LOCAL time (the box runs America/Mexico_City, no DST) so "every day at
 * 7:00" stays at 7:00 across the year. Monthly clamps to the last day of a short month (anchor on
 * the 31st → the 30th in April); yearly clamps Feb 29 → Feb 28.
 */
export type RecurrenceFreq = "daily" | "weekdays" | "weekly" | "monthly" | "yearly";

export interface Recurrence {
  freq: RecurrenceFreq;
  /** weekly only: weekdays (0 = Sunday … 6 = Saturday); absent = the anchor's weekday. */
  days?: number[];
}

const FREQS: RecurrenceFreq[] = ["daily", "weekdays", "weekly", "monthly", "yearly"];

/** Parse the stored string. null for none/empty; undefined for a malformed rule (callers 400). */
export function parseRecurrence(s: string | null | undefined): Recurrence | null | undefined {
  if (s == null) return null;
  const t = String(s).trim().toLowerCase();
  if (!t || t === "none") return null;
  const [freq, rest] = t.split(":");
  if (!FREQS.includes(freq as RecurrenceFreq)) return undefined;
  if (freq === "weekly" && rest) {
    const days = rest.split(",").map((d) => Number(d.trim())).filter((d) => Number.isInteger(d) && d >= 0 && d <= 6);
    if (!days.length) return undefined;
    return { freq: "weekly", days: Array.from(new Set(days)).sort() };
  }
  if (rest) return undefined;
  return { freq: freq as RecurrenceFreq };
}

export function formatRecurrence(r: Recurrence | null): string | null {
  if (!r) return null;
  if (r.freq === "weekly" && r.days?.length) return `weekly:${r.days.join(",")}`;
  return r.freq;
}

function addDays(d: Date, n: number): Date {
  const x = new Date(d);
  x.setDate(x.getDate() + n);
  return x;
}

function daysInMonth(y: number, m: number): number {
  return new Date(y, m + 1, 0).getDate();
}

/** The anchor's time-of-day placed on year/month/day (clamped to that month's length). */
function placeOn(anchor: Date, y: number, m: number, day: number): Date {
  const x = new Date(anchor);
  x.setFullYear(y, m, Math.min(day, daysInMonth(y, m)));
  return x;
}

/** The occurrence right after `d` (strictly later), given the anchor (for day-of-month / weekday). */
function step(anchor: Date, d: Date, r: Recurrence): Date {
  switch (r.freq) {
    case "daily":
      return addDays(d, 1);
    case "weekdays": {
      let x = addDays(d, 1);
      while (x.getDay() === 0 || x.getDay() === 6) x = addDays(x, 1);
      return x;
    }
    case "weekly": {
      if (!r.days?.length) return addDays(d, 7);
      let x = addDays(d, 1);
      while (!r.days.includes(x.getDay())) x = addDays(x, 1);
      return x;
    }
    case "monthly": {
      // Month after d's month, on the anchor's day-of-month (clamped).
      const y = d.getFullYear();
      const m = d.getMonth() + 1;
      return placeOn(anchor, y + Math.floor(m / 12), m % 12, anchor.getDate());
    }
    case "yearly":
      return placeOn(anchor, d.getFullYear() + 1, anchor.getMonth(), anchor.getDate());
  }
}

/** The first occurrence at or after the anchor (a weekly rule whose anchor misses its day set
 *  slides forward to the first listed weekday). */
export function firstOccurrence(anchor: Date, r: Recurrence | null): Date {
  if (!r) return new Date(anchor);
  if (r.freq === "weekly" && r.days?.length && !r.days.includes(anchor.getDay())) return step(anchor, anchor, r);
  if (r.freq === "weekdays" && (anchor.getDay() === 0 || anchor.getDay() === 6)) return step(anchor, anchor, r);
  return new Date(anchor);
}

/** The first occurrence strictly AFTER `after` (and ≥ the anchor). Bounded: returns null only for a
 *  rule that can't advance (never, for the supported set) or after an absurd number of steps. */
export function nextOccurrence(anchor: Date, r: Recurrence, after: Date): Date | null {
  let x = firstOccurrence(anchor, r);
  // Fast-forward the fixed-period rules so a years-old anchor doesn't cost thousands of steps.
  if (x.getTime() <= after.getTime() && (r.freq === "daily" || (r.freq === "weekly" && !r.days?.length))) {
    const period = r.freq === "daily" ? 1 : 7;
    const gapDays = Math.floor((after.getTime() - x.getTime()) / 86_400_000);
    x = addDays(x, Math.max(0, Math.floor(gapDays / period) * period));
    // Re-seat the clock time (a DST-free TZ keeps it; harmless otherwise).
    x.setHours(anchor.getHours(), anchor.getMinutes(), anchor.getSeconds(), anchor.getMilliseconds());
  }
  let guard = 0;
  while (x.getTime() <= after.getTime()) {
    x = step(anchor, x, r);
    if (++guard > 5000) return null;
  }
  return x;
}

/** Every occurrence of (anchor, rule) inside [from, to] (inclusive), oldest first, capped at `max`.
 *  A non-recurring row yields its anchor when that falls inside the window. */
export function occurrencesBetween(anchor: Date, r: Recurrence | null, from: Date, to: Date, max = 400): Date[] {
  if (to.getTime() < from.getTime()) return [];
  if (!r) {
    const t = anchor.getTime();
    return t >= from.getTime() && t <= to.getTime() ? [new Date(anchor)] : [];
  }
  const out: Date[] = [];
  let x: Date | null = firstOccurrence(anchor, r);
  if (x.getTime() < from.getTime()) x = nextOccurrence(anchor, r, new Date(from.getTime() - 1));
  while (x && x.getTime() <= to.getTime() && out.length < max) {
    out.push(x);
    x = step(anchor, x, r);
  }
  return out;
}

/** Spanish label for the dashboard/speech ("cada día", "entre semana", "cada semana", …). */
export function describeRecurrence(r: Recurrence | null): string {
  if (!r) return "";
  const DAY = ["domingo", "lunes", "martes", "miércoles", "jueves", "viernes", "sábado"];
  switch (r.freq) {
    case "daily": return "cada día";
    case "weekdays": return "entre semana";
    case "weekly": return r.days?.length ? `cada ${r.days.map((d) => DAY[d]).join(", ")}` : "cada semana";
    case "monthly": return "cada mes";
    case "yearly": return "cada año";
  }
}
