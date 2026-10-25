import { randomUUID } from "crypto";
import { db } from "./connection";
import { parseRecurrence } from "../timers/recurrence";

/**
 * Store for user-facing timers, reminders, calendar events and time-tracking ("stopwatch") entries —
 * the household's ONE agenda table (LOCAL_AGENDA: reminders and calendar entries fall under the same
 * umbrella, owned by the hub).
 *
 * Shapes share one table, discriminated by `kind`:
 *   - 'timer' / 'reminder' — a one-shot (or recurring) that the scheduler ANNOUNCES at `fire_at`
 *     (status: pending → fired, or → cancelled if dropped first).
 *   - 'event'              — a calendar entry: `title`, start = `fire_at`, `end_at`, `all_day`. The
 *     scheduler announces it `remind_min` minutes before the start (`notify_at`); NULL = silent.
 *   - 'stopwatch'          — an open-ended tracked activity; elapsed is `now - started_at`
 *     (status: running → stopped).
 * `recurrence` (see timers/recurrence.ts) makes a timer/reminder/event re-arm after firing: the
 * scheduler advances `fire_at`/`end_at`/`notify_at` to the next occurrence instead of marking fired.
 *
 * The repo keeps no clock of its own: `due()` is parameterised by `nowIso` and the scheduler owns
 * the tick. That keeps the firing logic unit-testable with a fake clock.
 */
export type TimerKind = "timer" | "reminder" | "event" | "stopwatch";

/** A device write the scheduler performs when the row fires — a deferred spoken command («apaga la luz de la
 *  cocina en diez minutos»). Executed through the same write policy as a live user command (bypasses + latches
 *  the manual lock; a `setting` channel is a setpoint). */
export interface TimerAction {
  id: string;
  value: unknown;
  channel?: string;
}

/** Parse the row's JSON `action` column; [] when none / unparsable. */
export function actionsOf(row: { action?: string | null }): TimerAction[] {
  if (!row.action) return [];
  try {
    const v = JSON.parse(row.action);
    return Array.isArray(v) ? v.filter((a) => a && typeof a.id === "string") : [];
  } catch {
    return [];
  }
}
export type TimerStatus = "pending" | "fired" | "cancelled" | "running" | "stopped";

export interface TimerRow {
  id: string;
  kind: TimerKind;
  label: string | null;
  message: string | null;
  zone: string | null;
  /** Person-targeted reminder/event: their id or display name. The delivery zone is late-bound (resolved
   *  to wherever they are at fire time); null for a general/house-wide item. See PERCEPTION_TO_AGENT_PLAN §3.5. */
  for_person: string | null;
  /** ISO fire time (timer/reminder) or the START of the current occurrence (event). */
  fire_at: string | null;
  started_at: string;
  stopped_at: string | null;
  status: TimerStatus;
  created_at: string;
  // ── agenda columns (LOCAL_AGENDA) ──
  title: string | null;
  end_at: string | null;
  all_day: number; // SQLite boolean (0/1)
  recurrence: string | null;
  remind_min: number | null;
  /** Derived: when the scheduler announces this row (fire_at − remind_min for events; fire_at otherwise). */
  notify_at: string | null;
  notes: string | null;
  created_by: string | null;
  /** JSON-encoded TimerAction[]; null for a plain announcement. */
  action: string | null;
}

export interface CreateTimerInput {
  kind: TimerKind;
  label?: string | null;
  message?: string | null;
  zone?: string | null;
  /** Person-targeted: their id or display name (late-bound zone). Omit for house-wide. */
  forPerson?: string | null;
  /** ISO8601 fire time (timer/reminder) / start (event); required except for stopwatch. */
  fireAt?: string | null;
  title?: string | null;
  endAt?: string | null;
  allDay?: boolean;
  recurrence?: string | null;
  /** Minutes before `fireAt` to announce an event (null = silent). Ignored for timer/reminder (= 0). */
  remindMin?: number | null;
  notes?: string | null;
  createdBy?: string | null;
  /** Device writes performed at fire time (deferred command). */
  action?: TimerAction[] | null;
}

/** The editable subset for PATCH (agenda-routes). `null` clears a nullable field. */
export interface UpdateTimerInput {
  label?: string | null;
  message?: string | null;
  zone?: string | null;
  forPerson?: string | null;
  fireAt?: string | null;
  title?: string | null;
  endAt?: string | null;
  allDay?: boolean;
  recurrence?: string | null;
  remindMin?: number | null;
  notes?: string | null;
}

const insertStmt = db.prepare(
  `INSERT INTO timers (id, kind, label, message, zone, for_person, fire_at, status,
                       title, end_at, all_day, recurrence, remind_min, notify_at, notes, created_by, action)
   VALUES (@id, @kind, @label, @message, @zone, @for_person, @fire_at, @status,
           @title, @end_at, @all_day, @recurrence, @remind_min, @notify_at, @notes, @created_by, @action)`,
);
const getStmt = db.prepare("SELECT * FROM timers WHERE id = ?");
const dueStmt = db.prepare(
  `SELECT * FROM timers
     WHERE status = 'pending' AND notify_at IS NOT NULL AND notify_at <= ?
     ORDER BY notify_at`,
);
// The spoken "what timers do I have" list — events are agenda entries, not timers, so they stay out.
const activeTimersStmt = db.prepare(
  "SELECT * FROM timers WHERE status = 'pending' AND kind IN ('timer','reminder') ORDER BY fire_at",
);
const runningStmt = db.prepare(
  "SELECT * FROM timers WHERE status = 'running' ORDER BY started_at",
);
const runningByLabelStmt = db.prepare(
  "SELECT * FROM timers WHERE status = 'running' AND label = ? ORDER BY started_at DESC LIMIT 1",
);
// Every agenda row (events + reminders, any status but cancelled). Window filtering happens in
// recurrence expansion (timers/agenda.ts) — a recurring anchor from last year still produces this
// month's occurrences, so a SQL range on fire_at would be wrong.
const agendaRowsStmt = db.prepare(
  "SELECT * FROM timers WHERE kind IN ('event','reminder') AND status != 'cancelled' ORDER BY fire_at",
);
const setStatusStmt = db.prepare("UPDATE timers SET status = ? WHERE id = ?");
const stopStmt = db.prepare(
  "UPDATE timers SET status = 'stopped', stopped_at = ? WHERE id = ?",
);
const advanceStmt = db.prepare(
  "UPDATE timers SET fire_at = @fire_at, end_at = @end_at, notify_at = @notify_at, status = 'pending' WHERE id = @id",
);

/** Short, human-quotable id (the agent reads it from list_timers, then cancels by it). */
function newId(): string {
  return randomUUID().replace(/-/g, "").slice(0, 8);
}

/** Local midnight of an instant (the box TZ — America/Mexico_City, no DST). */
function localMidnight(ms: number): Date {
  const d = new Date(ms);
  d.setHours(0, 0, 0, 0);
  return d;
}

/**
 * When the scheduler should speak this row:
 *  - timer / reminder → at fire_at (remind_min is meaningless: the reminder IS the announcement);
 *  - timed event      → fire_at − remind_min; null remind_min = a silent calendar entry;
 *  - all-day event    → 08:00 local on the day (remind_min < 1 day) or 08:00 the day before (≥ 1 day),
 *                       since "15 minutes before midnight" is never what anyone means.
 */
export function computeNotifyAt(
  kind: TimerKind,
  fireAt: string | null,
  remindMin: number | null | undefined,
  allDay: boolean,
): string | null {
  if (!fireAt || kind === "stopwatch") return null;
  const fire = Date.parse(fireAt);
  if (Number.isNaN(fire)) return null;
  if (kind !== "event") return new Date(fire).toISOString();
  if (remindMin == null) return null;
  if (allDay) {
    const eight = localMidnight(fire);
    eight.setHours(8, 0, 0, 0);
    if (remindMin >= 1440) eight.setDate(eight.getDate() - 1);
    return eight.toISOString();
  }
  return new Date(fire - Math.max(0, remindMin) * 60_000).toISOString();
}

export class TimersRepo {
  /** Create a timer/reminder/event (with fireAt) or a running stopwatch (kind 'stopwatch'). */
  create(input: CreateTimerInput): TimerRow {
    const id = newId();
    const status: TimerStatus = input.kind === "stopwatch" ? "running" : "pending";
    const fireAt = input.kind === "stopwatch" ? null : input.fireAt ?? null;
    const allDay = input.kind === "event" && !!input.allDay;
    const remindMin = input.kind === "event" ? input.remindMin ?? null : 0;
    insertStmt.run({
      id,
      kind: input.kind,
      label: input.label ?? null,
      message: input.message ?? null,
      zone: input.zone ?? null,
      for_person: input.forPerson ?? null,
      fire_at: fireAt,
      status,
      title: input.title ?? null,
      end_at: input.kind === "event" ? input.endAt ?? null : null,
      all_day: allDay ? 1 : 0,
      recurrence: parseRecurrence(input.recurrence) ? input.recurrence!.trim().toLowerCase() : null,
      remind_min: remindMin,
      notify_at: computeNotifyAt(input.kind, fireAt, remindMin, allDay),
      notes: input.notes ?? null,
      created_by: input.createdBy ?? null,
      action: input.action && input.action.length ? JSON.stringify(input.action) : null,
    });
    return this.get(id)!;
  }

  get(id: string): TimerRow | undefined {
    return getStmt.get(id) as TimerRow | undefined;
  }

  /** Patch an agenda row's editable fields (recomputing notify_at). A one-shot that already fired is
   *  re-armed when its new announce time is in the future (`nowIso`). Returns undefined when missing. */
  update(id: string, patch: UpdateTimerInput, nowIso: string): TimerRow | undefined {
    const row = this.get(id);
    if (!row || row.kind === "stopwatch") return undefined;
    const next = {
      label: patch.label !== undefined ? patch.label : row.label,
      message: patch.message !== undefined ? patch.message : row.message,
      zone: patch.zone !== undefined ? patch.zone : row.zone,
      for_person: patch.forPerson !== undefined ? patch.forPerson : row.for_person,
      fire_at: patch.fireAt !== undefined ? patch.fireAt : row.fire_at,
      title: patch.title !== undefined ? patch.title : row.title,
      end_at: patch.endAt !== undefined ? patch.endAt : row.end_at,
      all_day: patch.allDay !== undefined ? (patch.allDay ? 1 : 0) : row.all_day,
      recurrence:
        patch.recurrence !== undefined
          ? parseRecurrence(patch.recurrence) ? patch.recurrence!.trim().toLowerCase() : null
          : row.recurrence,
      remind_min: row.kind === "event" ? (patch.remindMin !== undefined ? patch.remindMin : row.remind_min) : 0,
      notes: patch.notes !== undefined ? patch.notes : row.notes,
    };
    const notifyAt = computeNotifyAt(row.kind, next.fire_at, next.remind_min, next.all_day === 1);
    let status = row.status;
    if (status === "fired" && notifyAt && notifyAt > nowIso) status = "pending";
    if (status === "pending" && row.kind === "event" && !notifyAt) status = "pending"; // silent events stay pending (they're agenda entries)
    db.prepare(
      `UPDATE timers SET label=@label, message=@message, zone=@zone, for_person=@for_person, fire_at=@fire_at,
         title=@title, end_at=@end_at, all_day=@all_day, recurrence=@recurrence, remind_min=@remind_min,
         notify_at=@notify_at, notes=@notes, status=@status WHERE id=@id`,
    ).run({ ...next, notify_at: notifyAt, status, id });
    return this.get(id);
  }

  /** Pending rows whose announce moment (notify_at) has arrived at `nowIso`. */
  due(nowIso: string): TimerRow[] {
    return dueStmt.all(nowIso) as TimerRow[];
  }

  /** Everything the user would consider an "active timer": pending timers/reminders + running stopwatches. */
  active(): TimerRow[] {
    return [...(activeTimersStmt.all() as TimerRow[]), ...(runningStmt.all() as TimerRow[])];
  }

  /** All agenda rows (events + reminders; pending or fired, never cancelled) for occurrence expansion. */
  agendaRows(): TimerRow[] {
    return agendaRowsStmt.all() as TimerRow[];
  }

  markFired(id: string): void {
    setStatusStmt.run("fired", id);
  }

  /** Re-arm a recurring row onto its next occurrence (status back to pending). */
  advance(id: string, fireAt: string, endAt: string | null): void {
    const row = this.get(id);
    if (!row) return;
    advanceStmt.run({
      id,
      fire_at: fireAt,
      end_at: endAt,
      notify_at: computeNotifyAt(row.kind, fireAt, row.remind_min, row.all_day === 1),
    });
  }

  /** Cancel a pending timer/reminder (no-op message). Returns the row if one was cancelled. */
  cancel(id: string): TimerRow | undefined {
    const row = this.get(id);
    if (!row || (row.status !== "pending" && row.status !== "running")) return undefined;
    setStatusStmt.run("cancelled", id);
    return this.get(id);
  }

  /** Remove an agenda entry whatever its status (a fired one-shot still shows in the past). */
  remove(id: string): TimerRow | undefined {
    const row = this.get(id);
    if (!row || row.kind === "stopwatch" || row.status === "cancelled") return undefined;
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
