import { randomUUID } from "crypto";
import { db } from "./connection";

/**
 * Store for user-facing timers, reminders and time-tracking ("stopwatch") entries.
 *
 * Two shapes share one table, discriminated by `kind`:
 *   - 'timer' / 'reminder' — a one-shot that the scheduler ANNOUNCES at `fire_at`
 *     (status: pending → fired, or → cancelled if dropped first).
 *   - 'stopwatch' — an open-ended tracked activity; elapsed is `now - started_at`
 *     (status: running → stopped).
 *
 * The repo keeps no clock of its own: `due()` is parameterised by `nowIso` and the
 * scheduler owns the tick. That keeps the firing logic unit-testable with a fake clock.
 */
export type TimerKind = "timer" | "reminder" | "stopwatch";
export type TimerStatus = "pending" | "fired" | "cancelled" | "running" | "stopped";

export interface TimerRow {
  id: string;
  kind: TimerKind;
  label: string | null;
  message: string | null;
  zone: string | null;
  /** Person-targeted reminder: their id or display name. The delivery zone is late-bound (resolved to
   *  wherever they are at fire time); null for a general/house-wide timer. See PERCEPTION_TO_AGENT_PLAN §3.5. */
  for_person: string | null;
  fire_at: string | null;
  started_at: string;
  stopped_at: string | null;
  status: TimerStatus;
  created_at: string;
}

export interface CreateTimerInput {
  kind: TimerKind;
  label?: string | null;
  message?: string | null;
  zone?: string | null;
  /** Person-targeted reminder: their id or display name (late-bound zone). Omit for house-wide. */
  forPerson?: string | null;
  /** ISO8601 fire time; required for timer/reminder, ignored for stopwatch. */
  fireAt?: string | null;
}

const insertStmt = db.prepare(
  `INSERT INTO timers (id, kind, label, message, zone, for_person, fire_at, status)
   VALUES (@id, @kind, @label, @message, @zone, @for_person, @fire_at, @status)`,
);
const getStmt = db.prepare("SELECT * FROM timers WHERE id = ?");
const dueStmt = db.prepare(
  `SELECT * FROM timers
     WHERE status = 'pending' AND fire_at IS NOT NULL AND fire_at <= ?
     ORDER BY fire_at`,
);
const activeTimersStmt = db.prepare(
  "SELECT * FROM timers WHERE status = 'pending' ORDER BY fire_at",
);
const runningStmt = db.prepare(
  "SELECT * FROM timers WHERE status = 'running' ORDER BY started_at",
);
const runningByLabelStmt = db.prepare(
  "SELECT * FROM timers WHERE status = 'running' AND label = ? ORDER BY started_at DESC LIMIT 1",
);
const setStatusStmt = db.prepare("UPDATE timers SET status = ? WHERE id = ?");
const stopStmt = db.prepare(
  "UPDATE timers SET status = 'stopped', stopped_at = ? WHERE id = ?",
);

/** Short, human-quotable id (the agent reads it from list_timers, then cancels by it). */
function newId(): string {
  return randomUUID().replace(/-/g, "").slice(0, 8);
}

export class TimersRepo {
  /** Create a timer/reminder (with fireAt) or a running stopwatch (kind 'stopwatch'). */
  create(input: CreateTimerInput): TimerRow {
    const id = newId();
    const status: TimerStatus = input.kind === "stopwatch" ? "running" : "pending";
    insertStmt.run({
      id,
      kind: input.kind,
      label: input.label ?? null,
      message: input.message ?? null,
      zone: input.zone ?? null,
      for_person: input.forPerson ?? null,
      fire_at: input.kind === "stopwatch" ? null : input.fireAt ?? null,
      status,
    });
    return this.get(id)!;
  }

  get(id: string): TimerRow | undefined {
    return getStmt.get(id) as TimerRow | undefined;
  }

  /** Pending timers/reminders whose fire_at has arrived at `nowIso`. */
  due(nowIso: string): TimerRow[] {
    return dueStmt.all(nowIso) as TimerRow[];
  }

  /** Everything the user would consider "active": pending timers + running stopwatches. */
  active(): TimerRow[] {
    return [...(activeTimersStmt.all() as TimerRow[]), ...(runningStmt.all() as TimerRow[])];
  }

  markFired(id: string): void {
    setStatusStmt.run("fired", id);
  }

  /** Cancel a pending timer/reminder (no-op message). Returns the row if one was cancelled. */
  cancel(id: string): TimerRow | undefined {
    const row = this.get(id);
    if (!row || (row.status !== "pending" && row.status !== "running")) return undefined;
    setStatusStmt.run("cancelled", id);
    return this.get(id);
  }

  /** Find a running stopwatch by id or (newest) by label/activity. */
  findRunning(idOrLabel: string): TimerRow | undefined {
    const byId = this.get(idOrLabel);
    if (byId && byId.status === "running") return byId;
    return runningByLabelStmt.get(idOrLabel) as TimerRow | undefined;
  }

  /** Stop a running stopwatch and return it (with stopped_at set). */
  stop(id: string, nowIso: string): TimerRow | undefined {
    const row = this.get(id);
    if (!row || row.status !== "running") return undefined;
    stopStmt.run(nowIso, id);
    return this.get(id);
  }
}

/**
 * Parse a stored timestamp to epoch ms. SQLite's `datetime('now')` yields
 * "YYYY-MM-DD HH:MM:SS" (UTC, no zone), which Date.parse would misread as LOCAL time — so we
 * normalise that form to UTC ISO. Values we wrote ourselves are already ISO-with-Z and pass through.
 */
function parseStoredTime(s: string): number {
  const sqlForm = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(s);
  return Date.parse(sqlForm ? s.replace(" ", "T") + "Z" : s);
}

/** Elapsed seconds for a stopwatch row, measured to `nowIso` (or its stopped_at). */
export function elapsedSeconds(row: TimerRow, nowIso: string): number {
  const end = row.stopped_at ?? nowIso;
  return Math.max(0, Math.round((parseStoredTime(end) - parseStoredTime(row.started_at)) / 1000));
}
