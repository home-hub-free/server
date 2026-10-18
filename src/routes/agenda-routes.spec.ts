/**
 * /agenda CRUD + the calendar-service-compatible /events read (LOCAL_AGENDA). Same handlers-off-a-fake-app
 * harness as effects-routes.spec.ts; AgendaDB is the real repo against the in-memory test db, so this
 * exercises route + repo + recurrence expansion together.
 */
jest.mock("../auth/middleware", () => ({
  requireAuth: (_req: any, _res: any, next: any) => next(),
}));

import { initAgendaRoutes, AgendaDB } from "./agenda-routes";
import { onAgendaChanged } from "../timers/agenda-events";
import { fireDue } from "../timers/scheduler";

type Handler = (req: any, res: any) => void;
const handlers: Record<string, Handler> = {};
const reg = (method: string) => (path: string, ...rest: any[]) => (handlers[`${method} ${path}`] = rest[rest.length - 1]);
const fakeApp: any = { get: reg("GET"), post: reg("POST"), patch: reg("PATCH"), delete: reg("DELETE") };
initAgendaRoutes(fakeApp);

function call(method: string, path: string, body: any = {}, query: any = {}, params: any = {}) {
  const res: any = { statusCode: 200 };
  res.status = (s: number) => ((res.statusCode = s), res);
  res.send = (b: any) => ((res.body = b), res);
  handlers[`${method} ${path}`]({ body, query, params, user: { id: "u1" } }, res);
  return res;
}

const pad = (n: number) => String(n).padStart(2, "0");
const ymd = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const tomorrow = () => { const d = new Date(); d.setDate(d.getDate() + 1); return d; };

const changes: string[] = [];
onAgendaChanged((c) => changes.push(c.reason));

beforeEach(() => {
  // Isolate: cancel everything the previous test left (the repo has no truncate by design).
  for (const r of AgendaDB.agendaRows()) AgendaDB.remove(r.id);
  changes.length = 0;
});

describe("POST /agenda", () => {
  it("creates an event with a default 15-minute reminder and returns its next occurrence", () => {
    const day = ymd(tomorrow());
    const res = call("POST", "/agenda", { kind: "event", title: "Dentista", start: `${day}T09:30`, end: `${day}T10:00`, for_person: "u1" });
    expect(res.statusCode).toBe(200);
    expect(res.body.item.kind).toBe("event");
    expect(res.body.item.next.start).toBe(`${day}T09:30`);
    expect(res.body.item.next.end).toBe(`${day}T10:00`);
    expect(res.body.item.next.calendar).toBe("u1");
    const row = AgendaDB.get(res.body.item.id)!;
    expect(row.remind_min).toBe(15);
    expect(Date.parse(row.notify_at!)).toBe(Date.parse(row.fire_at!) - 15 * 60_000);
    expect(changes).toEqual(["create"]);
  });

  it("an all-day event stores local midnight and announces at 08:00", () => {
    const day = ymd(tomorrow());
    const res = call("POST", "/agenda", { kind: "event", title: "Cumple de Ana", start: day, all_day: true, remind_min: 0 });
    expect(res.statusCode).toBe(200);
    const row = AgendaDB.get(res.body.item.id)!;
    expect(new Date(row.fire_at!).getHours()).toBe(0);
    expect(new Date(row.notify_at!).getHours()).toBe(8);
    expect(res.body.item.next.start).toBe(day);
    expect(res.body.item.next.all_day).toBe(true);
  });

  it("a silent event (remind_min null) never enters the due queue but still lists", () => {
    const day = ymd(tomorrow());
    const res = call("POST", "/agenda", { kind: "event", title: "Vacaciones", start: `${day}T08:00`, remind_min: null });
    expect(AgendaDB.get(res.body.item.id)!.notify_at).toBeNull();
    const list = call("GET", "/agenda", {}, { from: day, to: day });
    expect(list.body.items.map((o: any) => o.title)).toContain("Vacaciones");
  });

  it("a reminder takes `message` and recurrence", () => {
    const day = ymd(tomorrow());
    const res = call("POST", "/agenda", { kind: "reminder", message: "sacar la basura", start: `${day}T20:00`, recurrence: "weekly" });
    expect(res.statusCode).toBe(200);
    const row = AgendaDB.get(res.body.item.id)!;
    expect(row.kind).toBe("reminder");
    expect(row.recurrence).toBe("weekly");
    expect(row.notify_at).toBe(row.fire_at); // a reminder IS its announcement
  });

  it("400s on a bad kind, a missing start/title, an invalid recurrence or an end before start", () => {
    const day = ymd(tomorrow());
    expect(call("POST", "/agenda", { kind: "stopwatch", title: "x", start: day }).statusCode).toBe(400);
    expect(call("POST", "/agenda", { kind: "event", title: "x" }).statusCode).toBe(400);
    expect(call("POST", "/agenda", { kind: "event", start: `${day}T09:00` }).statusCode).toBe(400);
    expect(call("POST", "/agenda", { kind: "event", title: "x", start: `${day}T09:00`, recurrence: "hourly" }).statusCode).toBe(400);
    expect(call("POST", "/agenda", { kind: "event", title: "x", start: `${day}T09:00`, end: `${day}T08:00` }).statusCode).toBe(400);
    expect(call("POST", "/agenda", { kind: "event", title: "x", start: "mañana" }).statusCode).toBe(400);
  });
});

describe("GET /agenda + GET /events", () => {
  it("expands recurrence inside the window and filters by owner (id or display name)", () => {
    const day = ymd(tomorrow());
    call("POST", "/agenda", { kind: "reminder", message: "vitaminas", start: `${day}T08:00`, recurrence: "daily", for_person: "ana" });
    call("POST", "/agenda", { kind: "event", title: "Junta", start: `${day}T11:00` });
    const to = new Date(tomorrow()); to.setDate(to.getDate() + 2);
    const all = call("GET", "/agenda", {}, { from: day, to: ymd(to) });
    expect(all.body.items.filter((o: any) => o.title === "vitaminas")).toHaveLength(3);
    expect(all.body.items.filter((o: any) => o.title === "Junta")).toHaveLength(1);
    // Owner "david" sees the house-wide Junta but not Ana's vitamins.
    const mine = call("GET", "/events", {}, { from: day, to: ymd(to), owner: "david" });
    expect(mine.body.ok).toBe(true);
    expect(mine.body.events.map((e: any) => e.title)).toEqual(["Junta"]);
    expect(mine.body.sources[0]).toMatchObject({ kind: "personal", writable: true });
  });

  it("/events with `from` alone pins one day and carries the calendar-service shape", () => {
    const day = ymd(tomorrow());
    call("POST", "/agenda", { kind: "event", title: "Dentista", start: `${day}T09:30`, end: `${day}T10:00` });
    const res = call("GET", "/events", {}, { from: day });
    expect(res.body.events).toHaveLength(1);
    expect(res.body.events[0]).toMatchObject({ title: "Dentista", start: `${day}T09:30`, end: `${day}T10:00`, day: "mañana" });
    expect(res.body.events[0].all_day).toBeUndefined();
  });

  it("/events with no window reads a rolling 7-day horizon from today", () => {
    const far = new Date(); far.setDate(far.getDate() + 20);
    call("POST", "/agenda", { kind: "event", title: "lejos", start: `${ymd(far)}T09:00` });
    call("POST", "/agenda", { kind: "event", title: "cerca", start: `${ymd(tomorrow())}T09:00` });
    expect(call("GET", "/events").body.events.map((e: any) => e.title)).toEqual(["cerca"]);
    expect(call("GET", "/agenda", {}, { from: "nope" }).statusCode).toBe(400);
  });
});

describe("PATCH + DELETE /agenda/:id", () => {
  it("edits title/start and recomputes the announce time; 404s on unknown/cancelled ids", () => {
    const day = ymd(tomorrow());
    const created = call("POST", "/agenda", { kind: "event", title: "Junta", start: `${day}T11:00`, remind_min: 10 });
    const id = created.body.item.id;
    const res = call("PATCH", "/agenda/:id", { title: "Junta semanal", start: `${day}T12:00`, remind_min: 30, recurrence: "weekly:2" }, {}, { id });
    expect(res.statusCode).toBe(200);
    const row = AgendaDB.get(id)!;
    expect(row.title).toBe("Junta semanal");
    expect(Date.parse(row.notify_at!)).toBe(Date.parse(row.fire_at!) - 30 * 60_000);
    expect(row.recurrence).toBe("weekly:2");
    expect(call("PATCH", "/agenda/:id", { recurrence: "bogus" }, {}, { id }).statusCode).toBe(400);
    expect(call("DELETE", "/agenda/:id", {}, {}, { id }).statusCode).toBe(200);
    expect(AgendaDB.get(id)!.status).toBe("cancelled");
    expect(call("PATCH", "/agenda/:id", { title: "x" }, {}, { id }).statusCode).toBe(404);
    expect(call("DELETE", "/agenda/:id", {}, {}, { id: "nope" }).statusCode).toBe(404);
    expect(call("GET", "/agenda", {}, { from: day, to: day }).body.items).toEqual([]);
    expect(changes).toEqual(["create", "update", "cancel"]);
  });
});

describe("scheduler integration", () => {
  it("fires a due event with its generated line and re-arms a recurring one onto the next day", () => {
    const spoken: string[] = [];
    const start = new Date(Date.now() + 10 * 60_000); // in 10 min, reminded 15 min before → due now
    const res = call("POST", "/agenda", { kind: "event", title: "Yoga", start: start.toISOString(), remind_min: 15, recurrence: "daily" });
    const id = res.body.item.id;
    const before = AgendaDB.get(id)!;
    const fired = fireDue(new Date(), (t) => spoken.push(t), AgendaDB);
    expect(fired.map((r) => r.id)).toContain(id);
    expect(spoken[0]).toMatch(/^Recordatorio: Yoga en (9|10) minutos\.$/);
    const after = AgendaDB.get(id)!;
    expect(after.status).toBe("pending");
    expect(Date.parse(after.fire_at!) - Date.parse(before.fire_at!)).toBe(86_400_000);
    expect(changes).toContain("fire");
    // A second tick doesn't re-announce tomorrow's occurrence.
    spoken.length = 0;
    fireDue(new Date(), (t) => spoken.push(t), AgendaDB);
    expect(spoken).toEqual([]);
  });

  it("a one-shot reminder retires after firing and leaves the agenda's future", () => {
    const spoken: string[] = [];
    const res = call("POST", "/agenda", { kind: "reminder", message: "llamar a mamá", start: new Date(Date.now() - 1000).toISOString() });
    fireDue(new Date(), (t) => spoken.push(t), AgendaDB);
    expect(spoken).toEqual(["llamar a mamá"]);
    expect(AgendaDB.get(res.body.item.id)!.status).toBe("fired");
  });
});
