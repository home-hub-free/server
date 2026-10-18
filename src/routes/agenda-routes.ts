import { Express, Request, Response } from "express";
import { TimersRepo, TimerRow, UpdateTimerInput } from "../db/timers.repo";
import { usersRepo } from "../db/users.repo";
import { requireAuth } from "../auth/middleware";
import { expandAgenda, fmtLocalDate, parseLocalDate, parseWhen, rowMatchesOwner, Occurrence } from "../timers/agenda";
import { parseRecurrence } from "../timers/recurrence";
import { notifyAgendaChanged, onAgendaChanged } from "../timers/agenda-events";
import { log, EVENT_TYPES } from "../logger";

/**
 * The household agenda HTTP surface (LOCAL_AGENDA) — calendar events + reminders live in the hub's
 * `timers` table and are announced by the hub scheduler through the satellites; nothing leaves the box.
 *
 *   GET    /agenda?from=YYYY-MM-DD&to=YYYY-MM-DD   occurrences in the window (dashboard; open read)
 *   POST   /agenda                                  create an event/reminder (auth: member or service token)
 *   PATCH  /agenda/:id                              edit (auth)
 *   DELETE /agenda/:id                              remove (auth) — cancels the row, occurrences vanish
 *   GET    /events?from&to&within_days&owner        calendar-service-COMPATIBLE read ({ok, events, sources})
 *                                                   so reflex's calendar executor + the morning brief only
 *                                                   need CALENDAR_URL pointed at the hub — no code change.
 *   GET    /sources                                 compat: the one local calendar ("casa"), kind personal.
 *
 * Writes are gated by `requireAuth` like every other dashboard config mutation (the reflex service token
 * satisfies it too, so a deterministic voice write lane can land later without a route change).
 * Mutations + scheduler fires raise `agenda-update` on the dashboard socket so the calendar view refreshes.
 */
export const AgendaDB = new TimersRepo();

type Body = Record<string, any>;

const WRITABLE_KINDS = new Set(["event", "reminder"]);

/** Normalise the create/patch body into repo input. Returns an error string when invalid. */
function readFields(body: Body, kind: TimerRow["kind"], partial: boolean): { input: UpdateTimerInput & { kind?: never }; error?: string } {
  const input: UpdateTimerInput = {};
  const has = (k: string) => Object.prototype.hasOwnProperty.call(body, k);

  if (has("title")) input.title = body.title == null ? null : String(body.title).trim();
  if (has("message")) input.message = body.message == null ? null : String(body.message).trim();
  if (has("notes")) input.notes = body.notes == null ? null : String(body.notes).trim() || null;
  if (has("zone")) input.zone = body.zone ? String(body.zone).trim() : null;
  if (has("for_person") || has("forPerson")) {
    const p = body.for_person ?? body.forPerson;
    input.forPerson = p ? String(p).trim() : null;
  }
  if (has("all_day") || has("allDay")) input.allDay = !!(body.all_day ?? body.allDay);
  if (has("recurrence")) {
    const r = body.recurrence == null || body.recurrence === "" ? null : String(body.recurrence);
    if (r !== null && parseRecurrence(r) === undefined) return { input, error: "invalid recurrence" };
    input.recurrence = r;
  }
  if (has("remind_min") || has("remindMin")) {
    const v = body.remind_min ?? body.remindMin;
    if (v == null || v === "") input.remindMin = null;
    else {
      const n = Number(v);
      if (!Number.isFinite(n) || n < 0) return { input, error: "remind_min must be a non-negative number of minutes" };
      input.remindMin = Math.round(n);
    }
  }
  if (has("start")) {
    const d = body.start == null ? null : parseWhen(String(body.start));
    if (!d) return { input, error: "start must be a date (YYYY-MM-DD) or local datetime (YYYY-MM-DDTHH:MM)" };
    if (input.allDay) d.setHours(0, 0, 0, 0);
    input.fireAt = d.toISOString();
  }
  if (has("end")) {
    if (body.end == null || body.end === "") input.endAt = null;
    else {
      const d = parseWhen(String(body.end));
      if (!d) return { input, error: "end must be a local datetime (YYYY-MM-DDTHH:MM)" };
      input.endAt = d.toISOString();
    }
  }
  if (!partial) {
    if (!input.fireAt) return { input, error: "start is required" };
    const label = kind === "event" ? input.title : input.message ?? input.title;
    if (!label) return { input, error: kind === "event" ? "title is required" : "message is required" };
    if (kind === "reminder" && !input.message) input.message = input.title ?? null;
  }
  if (input.fireAt && input.endAt && input.endAt < input.fireAt) return { input, error: "end must be after start" };
  return { input };
}

/** Local window from query strings; `from` alone = that single day. */
function windowFromQuery(q: Record<string, any>, now: Date): { from: Date; to: Date } | null {
  const fromS = typeof q.from === "string" ? q.from : "";
  const toS = typeof q.to === "string" ? q.to : "";
  if (fromS) {
    const from = parseLocalDate(fromS);
    if (!from) return null;
    const to = toS ? parseLocalDate(toS) : new Date(from);
    if (!to) return null;
    to.setHours(23, 59, 59, 999);
    return { from, to };
  }
  const within = Number(q.within_days ?? q.withinDays ?? 7);
  const from = new Date(now);
  from.setHours(0, 0, 0, 0);
  const to = new Date(from);
  to.setDate(to.getDate() + (Number.isFinite(within) && within > 0 ? Math.min(within, 366) : 7));
  to.setHours(23, 59, 59, 999);
  return { from, to };
}

/** A row's owner aliases (id + display name) so `owner=u1` and `owner=David` both match. */
function ownerAliases(owner: string): string[] {
  const byId = usersRepo.getById(owner);
  if (byId) return [byId.id, byId.displayName];
  const hit = usersRepo.list().find((u) => u.displayName.trim().toLowerCase() === owner.trim().toLowerCase());
  return hit ? [hit.id, hit.displayName] : [owner];
}

/** Occurrences for a window + optional owner — shared by /agenda, /events and the brief. */
export function readAgenda(from: Date, to: Date, owner?: string | null, now = new Date()): Occurrence[] {
  const rows = AgendaDB.agendaRows().filter((r) => rowMatchesOwner(r, owner, owner ? ownerAliases(owner) : []));
  return expandAgenda(rows, from, to, now);
}

/** The agenda entry a route answers with (the row + its next occurrence, local-naive). */
function entryView(row: TimerRow, now: Date) {
  const far = new Date(now.getFullYear() + 2, 0, 1);
  const past = new Date(0);
  const occ = expandAgenda([row], past, far, now).find((o) => !o.past) ?? expandAgenda([row], past, far, now).pop();
  return { id: row.id, kind: row.kind, status: row.status, ...(occ ? { next: occ } : {}) };
}

export function initAgendaRoutes(app: Express) {
  // The dashboard socket mirror: any agenda change → `agenda-update` so open calendars refresh.
  onAgendaChanged((change) => {
    try {
      const { io } = require("../handlers/websockets.handler");
      io?.emit("agenda-update", { ...change, at: new Date().toISOString() });
    } catch {
      // sockets not up (tests / early boot) — nothing to mirror to
    }
  });

  app.get("/agenda", (req: Request, res: Response) => {
    const now = new Date();
    const q = { ...req.query } as Record<string, any>;
    if (!q.from) {
      // Default: this month ± a week, the dashboard's month grid.
      const first = new Date(now.getFullYear(), now.getMonth(), 1);
      first.setDate(first.getDate() - 7);
      const last = new Date(now.getFullYear(), now.getMonth() + 1, 0);
      last.setDate(last.getDate() + 7);
      q.from = fmtLocalDate(first);
      q.to = fmtLocalDate(last);
    }
    const win = windowFromQuery(q, now);
    if (!win) return res.status(400).send({ ok: false, error: "from/to must be YYYY-MM-DD" });
    const owner = typeof q.owner === "string" && q.owner ? q.owner : null;
    res.send({ ok: true, from: fmtLocalDate(win.from), to: fmtLocalDate(win.to), items: readAgenda(win.from, win.to, owner, now) });
  });

  // calendar-service-compatible read (reflex `readEvents`, brief `calendarEvents`).
  app.get("/events", (req: Request, res: Response) => {
    const now = new Date();
    const win = windowFromQuery(req.query as Record<string, any>, now);
    if (!win) return res.status(400).send({ ok: false, error: "from/to must be YYYY-MM-DD" });
    const owner = typeof req.query.owner === "string" && req.query.owner ? req.query.owner : null;
    const events = readAgenda(win.from, win.to, owner, now).map((o) => ({
      id: o.id,
      title: o.title,
      start: o.start,
      ...(o.end ? { end: o.end } : {}),
      ...(o.all_day ? { all_day: true } : {}),
      calendar: o.calendar,
      ...(o.day ? { day: o.day } : {}),
      kind: o.kind,
    }));
    res.send({ ok: true, events, sources: [LOCAL_SOURCE] });
  });

  app.get("/sources", (_req: Request, res: Response) => {
    res.send({ ok: true, sources: [LOCAL_SOURCE] });
  });

  app.post("/agenda", requireAuth, (req: Request, res: Response) => {
    const body: Body = req.body ?? {};
    const kind = String(body.kind ?? "event");
    if (!WRITABLE_KINDS.has(kind)) return res.status(400).send({ ok: false, error: "kind must be event or reminder" });
    const { input, error } = readFields(body, kind as TimerRow["kind"], false);
    if (error) return res.status(400).send({ ok: false, error });
    const row = AgendaDB.create({
      kind: kind as TimerRow["kind"],
      title: input.title ?? null,
      message: input.message ?? null,
      notes: input.notes ?? null,
      zone: input.zone ?? null,
      forPerson: input.forPerson ?? null,
      fireAt: input.fireAt!,
      endAt: input.endAt ?? null,
      allDay: input.allDay ?? false,
      recurrence: input.recurrence ?? null,
      remindMin: kind === "event" ? (input.remindMin === undefined ? 15 : input.remindMin) : 0,
      createdBy: (req as any).user?.id ?? "service",
    });
    log(EVENT_TYPES.info, [`[agenda] created ${row.kind} ${row.id} "${row.title ?? row.message}" by ${row.created_by}`]);
    notifyAgendaChanged({ reason: "create", id: row.id });
    res.send({ ok: true, item: entryView(row, new Date()) });
  });

  app.patch("/agenda/:id", requireAuth, (req: Request, res: Response) => {
    const id = String(req.params.id);
    const existing = AgendaDB.get(id);
    if (!existing || !WRITABLE_KINDS.has(existing.kind) || existing.status === "cancelled") {
      return res.status(404).send({ ok: false, error: "no agenda entry with that id" });
    }
    const body: Body = req.body ?? {};
    // allDay affects how `start` is normalised — carry the stored value when the patch doesn't say.
    if (!Object.prototype.hasOwnProperty.call(body, "all_day") && !Object.prototype.hasOwnProperty.call(body, "allDay")) {
      body.all_day = existing.all_day === 1;
    }
    const { input, error } = readFields(body, existing.kind, true);
    if (error) return res.status(400).send({ ok: false, error });
    const now = new Date();
    const row = AgendaDB.update(id, input, now.toISOString());
    if (!row) return res.status(404).send({ ok: false, error: "no agenda entry with that id" });
    notifyAgendaChanged({ reason: "update", id });
    res.send({ ok: true, item: entryView(row, now) });
  });

  app.delete("/agenda/:id", requireAuth, (req: Request, res: Response) => {
    const id = String(req.params.id);
    const row = AgendaDB.remove(id);
    if (!row || !WRITABLE_KINDS.has(row.kind)) return res.status(404).send({ ok: false, error: "no agenda entry with that id" });
    log(EVENT_TYPES.info, [`[agenda] removed ${row.kind} ${row.id} "${row.title ?? row.message}"`]);
    notifyAgendaChanged({ reason: "cancel", id });
    res.send({ ok: true });
  });
}

/** The single local calendar every member reads from — `kind:"personal"` so the brief's personal-source
 *  gate (briefing/assemble.ts) passes for everyone; person-targeting is per row, not per calendar. */
const LOCAL_SOURCE = { id: "casa", kind: "personal", label: "Casa", writable: true, backend: "hub" };
