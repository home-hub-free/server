import { Express } from "express";
import { TimersRepo, TimerRow, TimerAction, elapsedSeconds, actionsOf } from "../db/timers.repo";
import { resolveFireAt } from "../timers/scheduler";
import { notifyAgendaChanged } from "../timers/agenda-events";
import { parseRecurrence } from "../timers/recurrence";

export const TimersDB = new TimersRepo();

/**
 * Timer / reminder / time-tracking HTTP surface, consumed by the LLM agent's tools
 * (set_timer, list_timers, cancel_timer, start_tracking, stop_tracking) and the dashboard.
 *
 * The hub owns the durable state and the firing (see src/timers/scheduler.ts); these routes
 * are thin CRUD. Relative ("in N minutes") vs absolute ("at HH:MM") fire times are resolved
 * here against the hub clock so the agent doesn't have to do date math.
 */

/** Shape a row for API responses: include a live `remaining`/`elapsed` derived from now. */
function view(row: TimerRow, now: Date) {
  const base = {
    id: row.id,
    kind: row.kind,
    label: row.label,
    message: row.message,
    zone: row.zone,
    status: row.status,
    for_person: row.for_person,
    recurrence: row.recurrence,
    action: actionsOf(row),
  };
  if (row.kind === "stopwatch") {
    return { ...base, elapsed_seconds: elapsedSeconds(row, now.toISOString()) };
  }
  const remaining = row.fire_at
    ? Math.max(0, Math.round((Date.parse(row.fire_at) - now.getTime()) / 1000))
    : null;
  return { ...base, fire_at: row.fire_at, remaining_seconds: remaining };
}

export function initTimerRoutes(app: Express) {
  // Create a timer or reminder. Body: { message, minutes? | seconds? | at?, label?, zone?, kind?, for_person?,
  // recurrence? } — `recurrence` (LOCAL_AGENDA: 'daily'|'weekdays'|'weekly[:d,d]'|'monthly'|'yearly') makes a
  // reminder re-arm after it fires; a reminder is also an agenda entry (GET /agenda).
  app.post("/timers", (req, res) => {
    const { message, minutes, seconds, at, label, zone, kind, for_person, forPerson, recurrence, action } = req.body ?? {};
    // Deferred device command (2026-10-25): `action` = [{id, value, channel?}] executed at fire time; then the
    // spoken `message` is optional (a silent deferred command is fine).
    const actions: TimerAction[] | null = Array.isArray(action)
      ? action.filter((a: unknown): a is TimerAction => !!a && typeof (a as TimerAction).id === "string" && "value" in (a as object))
      : null;
    if (Array.isArray(action) && (!actions || actions.length !== action.length)) {
      return res.status(400).send({ ok: false, error: "each action needs {id, value, channel?}" });
    }
    if ((!message || typeof message !== "string") && !(actions && actions.length)) {
      return res.status(400).send({ ok: false, error: "message is required" });
    }
    const fireAt = resolveFireAt(new Date(), { minutes, seconds, at });
    if (!fireAt) {
      return res.status(400).send({ ok: false, error: "need minutes, seconds, or a valid 'at' time" });
    }
    if (recurrence != null && recurrence !== "" && parseRecurrence(String(recurrence)) === undefined) {
      return res.status(400).send({ ok: false, error: "invalid recurrence" });
    }
    const row = TimersDB.create({
      kind: kind === "reminder" ? "reminder" : "timer",
      message: typeof message === "string" && message ? message : null,
      label: label ?? null,
      zone: zone ?? null,
      action: actions,
      // Person-targeted reminder (PLAN §3.5): id or name; delivery zone is late-bound at fire time.
      forPerson: forPerson ?? for_person ?? null,
      fireAt,
      recurrence: recurrence ? String(recurrence) : null,
      createdBy: (req as any).user?.id ?? null,
    });
    if (row.kind === "reminder") notifyAgendaChanged({ reason: "create", id: row.id });
    res.send({ ok: true, timer: view(row, new Date()) });
  });

  // List everything active: pending timers/reminders + running stopwatches.
  app.get("/timers", (_req, res) => {
    const now = new Date();
    res.send({ ok: true, timers: TimersDB.active().map((r) => view(r, now)) });
  });

  // Cancel a pending timer/reminder (or a running stopwatch) by id.
  app.post("/timers/cancel", (req, res) => {
    const { id } = req.body ?? {};
    const row = id ? TimersDB.cancel(String(id)) : undefined;
    if (!row) return res.status(404).send({ ok: false, error: "no active timer with that id" });
    if (row.kind === "reminder" || row.kind === "event") notifyAgendaChanged({ reason: "cancel", id: row.id });
    res.send({ ok: true, timer: view(row, new Date()) });
  });

  // Start a time-tracking stopwatch for an activity. Body: { activity, zone? }.
  app.post("/timers/track-start", (req, res) => {
    const { activity, zone } = req.body ?? {};
    if (!activity || typeof activity !== "string") {
      return res.status(400).send({ ok: false, error: "activity is required" });
    }
    const row = TimersDB.create({ kind: "stopwatch", label: activity, zone: zone ?? null });
    res.send({ ok: true, timer: view(row, new Date()) });
  });

  // Stop a running stopwatch by id or activity, returning how long it ran. Body: { id? , activity? }.
  app.post("/timers/track-stop", (req, res) => {
    const { id, activity } = req.body ?? {};
    const key = id ?? activity;
    const running = key ? TimersDB.findRunning(String(key)) : TimersDB.active().find((r) => r.kind === "stopwatch");
    if (!running) return res.status(404).send({ ok: false, error: "no matching running tracker" });
    const now = new Date();
    const stopped = TimersDB.stop(running.id, now.toISOString());
    res.send({ ok: true, timer: stopped ? view(stopped, now) : null });
  });
}
