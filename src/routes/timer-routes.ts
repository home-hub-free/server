import { Express } from "express";
import { TimersRepo, TimerRow, elapsedSeconds } from "../db/timers.repo";
import { resolveFireAt } from "../timers/scheduler";

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
  // Create a timer or reminder. Body: { message, minutes? | seconds? | at?, label?, zone?, kind? }.
  app.post("/timers", (req, res) => {
    const { message, minutes, seconds, at, label, zone, kind, for_person, forPerson } = req.body ?? {};
    if (!message || typeof message !== "string") {
      return res.status(400).send({ ok: false, error: "message is required" });
    }
    const fireAt = resolveFireAt(new Date(), { minutes, seconds, at });
    if (!fireAt) {
      return res.status(400).send({ ok: false, error: "need minutes, seconds, or a valid 'at' time" });
    }
    const row = TimersDB.create({
      kind: kind === "reminder" ? "reminder" : "timer",
      message,
      label: label ?? null,
      zone: zone ?? null,
      // Person-targeted reminder (PLAN §3.5): id or name; delivery zone is late-bound at fire time.
      forPerson: forPerson ?? for_person ?? null,
      fireAt,
    });
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
