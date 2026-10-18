// Agenda read model (LOCAL_AGENDA): rows → dated occurrences in the calendar-service wire shape.
import { eventAnnouncement, expandAgenda, parseWhen, relativeDay, rowMatchesOwner } from "./agenda";
import type { TimerRow } from "../db/timers.repo";

const row = (o: Partial<TimerRow>): TimerRow => ({
  id: "r1", kind: "event", label: null, message: null, zone: null, for_person: null, fire_at: null, started_at: "x",
  stopped_at: null, status: "pending", created_at: "x", title: "Dentista", end_at: null, all_day: 0, recurrence: null,
  remind_min: 15, notify_at: null, notes: null, created_by: null, ...o,
});
const L = (y: number, m: number, d: number, h = 0, min = 0) => new Date(y, m - 1, d, h, min);

describe("parseWhen", () => {
  it("reads local-naive datetimes, bare dates and zoned ISO", () => {
    expect(parseWhen("2026-10-20T09:30")!.getHours()).toBe(9);
    expect(parseWhen("2026-10-20")!.getHours()).toBe(0);
    expect(parseWhen("2026-10-20T09:30:00.000Z")!.toISOString()).toBe("2026-10-20T09:30:00.000Z");
    expect(parseWhen("mañana")).toBeNull();
  });
});

describe("expandAgenda", () => {
  const now = L(2026, 10, 18, 12);

  it("emits local-naive starts, a day label and the owner calendar", () => {
    const r = row({ fire_at: L(2026, 10, 19, 9, 30).toISOString(), end_at: L(2026, 10, 19, 10).toISOString(), for_person: "david" });
    const [o] = expandAgenda([r], L(2026, 10, 18), L(2026, 10, 25, 23, 59), now);
    expect(o.start).toBe("2026-10-19T09:30");
    expect(o.end).toBe("2026-10-19T10:00");
    expect(o.day).toBe("mañana");
    expect(o.calendar).toBe("david");
    expect(o.all_day).toBe(false);
    expect(o.past).toBe(false);
  });

  it("an all-day event carries a bare date and no end", () => {
    const r = row({ fire_at: L(2026, 10, 18).toISOString(), all_day: 1 });
    const [o] = expandAgenda([r], L(2026, 10, 18), L(2026, 10, 18, 23, 59), now);
    expect(o.start).toBe("2026-10-18");
    expect(o.end).toBeUndefined();
    expect(o.all_day).toBe(true);
    expect(o.day).toBe("hoy");
  });

  it("a weekly recurring reminder fans out across the window and keeps its id", () => {
    const r = row({ id: "rem", kind: "reminder", title: null, message: "sacar la basura", fire_at: L(2026, 10, 13, 20).toISOString(), recurrence: "weekly" });
    const occ = expandAgenda([r], L(2026, 10, 18), L(2026, 11, 7, 23, 59), now);
    expect(occ.map((o) => o.start)).toEqual(["2026-10-20T20:00", "2026-10-27T20:00", "2026-11-03T20:00"]);
    expect(occ.every((o) => o.id === "rem" && o.title === "sacar la basura" && o.recurrence_label === "cada semana")).toBe(true);
  });

  it("ignores timers, stopwatches and rows without a start; sorts by start", () => {
    const rows = [
      row({ id: "b", fire_at: L(2026, 10, 19, 15).toISOString(), title: "B" }),
      row({ id: "a", fire_at: L(2026, 10, 19, 8).toISOString(), title: "A" }),
      row({ id: "t", kind: "timer", fire_at: L(2026, 10, 19, 9).toISOString(), message: "pasta" }),
      row({ id: "s", kind: "stopwatch", fire_at: null }),
      row({ id: "n", fire_at: null }),
    ];
    expect(expandAgenda(rows, L(2026, 10, 19), L(2026, 10, 19, 23, 59), now).map((o) => o.id)).toEqual(["a", "b"]);
  });
});

describe("rowMatchesOwner", () => {
  it("house-wide rows belong to everyone; targeted rows match id or alias case-insensitively", () => {
    expect(rowMatchesOwner(row({ for_person: null }), "u1")).toBe(true);
    expect(rowMatchesOwner(row({ for_person: "David" }), "u1", ["u1", "david"])).toBe(true);
    expect(rowMatchesOwner(row({ for_person: "ana" }), "u1", ["u1", "david"])).toBe(false);
    expect(rowMatchesOwner(row({ for_person: "ana" }), null)).toBe(true);
  });
});

describe("relativeDay + eventAnnouncement", () => {
  const now = L(2026, 10, 18, 8, 45);

  it("labels the week ahead and nothing beyond", () => {
    expect(relativeDay(L(2026, 10, 18, 23), now)).toBe("hoy");
    expect(relativeDay(L(2026, 10, 20), now)).toBe("pasado mañana");
    expect(relativeDay(L(2026, 10, 22), now)).toBe("jueves");
    expect(relativeDay(L(2026, 10, 26), now)).toBe("");
  });

  it("speaks a deterministic reminder line", () => {
    expect(eventAnnouncement(row({ fire_at: L(2026, 10, 18, 9).toISOString() }), now)).toBe("Recordatorio: Dentista en 15 minutos.");
    expect(eventAnnouncement(row({ fire_at: L(2026, 10, 18, 8, 45).toISOString() }), now)).toBe("Recordatorio: Dentista, ahora.");
    expect(eventAnnouncement(row({ fire_at: L(2026, 10, 18, 17, 5).toISOString() }), now)).toBe("Recordatorio: Dentista a las 17:05.");
    expect(eventAnnouncement(row({ fire_at: L(2026, 10, 19, 10).toISOString() }), now)).toBe("Recordatorio: Dentista mañana a las 10:00.");
    expect(eventAnnouncement(row({ fire_at: L(2026, 10, 18).toISOString(), all_day: 1 }), now)).toBe("Recordatorio para hoy: Dentista.");
  });
});
