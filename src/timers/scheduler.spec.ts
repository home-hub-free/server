// Scheduler firing logic + relative/absolute fire-time resolution, with the clock + sink injected
// (no real interval, no Polly). Runs against the in-memory test DB via the shared repo.
import { fireDue, resolveFireAt, planDelivery, personZone } from "./scheduler";
import { TimersRepo, TimerRow } from "../db/timers.repo";
import type { RoomDigest } from "../ambient/room-digest";

const repo = new TimersRepo();

const room = (zone: string, people: RoomDigest["people"]): RoomDigest =>
  ({ zone, occupied: true, count: people!.length, people, source: ["vision"], observedAt: "x" });
const rowOf = (o: Partial<TimerRow>): TimerRow =>
  ({ id: "t", kind: "reminder", label: null, message: "m", zone: null, for_person: null, fire_at: null, started_at: "x", stopped_at: null, status: "pending", created_at: "x", ...o });

describe("fireDue", () => {
  it("announces each due timer's message exactly once, then marks it fired", () => {
    const spoken: string[] = [];
    const past = repo.create({ kind: "timer", message: "Saca la basura", fireAt: new Date(Date.now() - 1000).toISOString() });
    const future = repo.create({ kind: "timer", message: "todavía no", fireAt: new Date(Date.now() + 60_000).toISOString() });

    const fired = fireDue(new Date(), (t) => spoken.push(t), repo);

    expect(fired.map((r) => r.id)).toContain(past.id);
    expect(spoken).toContain("Saca la basura");
    expect(spoken).not.toContain("todavía no");
    expect(repo.get(past.id)!.status).toBe("fired");
    expect(repo.get(future.id)!.status).toBe("pending");

    // A second tick does not re-announce the already-fired timer.
    spoken.length = 0;
    fireDue(new Date(), (t) => spoken.push(t), repo);
    expect(spoken).not.toContain("Saca la basura");
  });

  it("a throwing sink does not wedge the tick or re-fire the timer", () => {
    const t = repo.create({ kind: "timer", message: "boom", fireAt: new Date(Date.now() - 1000).toISOString() });
    expect(() => fireDue(new Date(), () => { throw new Error("speaker down"); }, repo)).not.toThrow();
    expect(repo.get(t.id)!.status).toBe("fired");
  });
});

describe("person-targeted reminders (late-bound delivery zone, PLAN §3.5)", () => {
  const sala = room("sala", [{ id: "u-ana", name: "Ana", cls: "household", confidence: 0.9 }]);
  const oficina = room("oficina", [{ id: "u-ana", name: "Ana", cls: "household", confidence: 0.9 }]);

  it("personZone matches by id OR display name", () => {
    expect(personZone({ sala }, "u-ana")).toBe("sala");
    expect(personZone({ sala }, "ana")).toBe("sala"); // case-insensitive name
    expect(personZone({ sala }, "Bob")).toBeUndefined();
  });

  it("a general (no-person) timer announces to its stored zone", () => {
    expect(planDelivery(rowOf({ zone: "cocina" }), {}, new Date())).toEqual({ action: "announce", zone: "cocina" });
  });

  it("late-binds to wherever the person is NOW, not the zone it was created with", () => {
    // Reminder carries no zone; Ana is currently in the oficina → deliver there.
    const plan = planDelivery(rowOf({ for_person: "Ana", zone: null }), { oficina }, new Date());
    expect(plan).toEqual({ action: "announce", zone: "oficina" });
  });

  it("HOLDS (never broadcasts) while the target is away, within the bounded window", () => {
    const justFired = rowOf({ for_person: "Ana", fire_at: new Date(Date.now() - 60_000).toISOString() });
    expect(planDelivery(justFired, {}, new Date()).action).toBe("hold");
  });

  it("falls back to a quiet surface once the hold window lapses", () => {
    const longAgo = rowOf({ for_person: "Ana", fire_at: new Date(Date.now() - 60 * 60_000).toISOString() });
    expect(planDelivery(longAgo, {}, new Date()).action).toBe("quiet-surface");
  });

  it("fireDue routes a person reminder to the resolved zone and marks it fired", () => {
    const spoken: Array<{ text: string; zone?: string | null }> = [];
    const t = repo.create({ kind: "reminder", message: "Saca la basura", forPerson: "Ana", fireAt: new Date(Date.now() - 1000).toISOString() });
    const fired = fireDue(new Date(), (text, zone) => spoken.push({ text, zone }), repo, { rooms: { oficina } });
    expect(spoken).toEqual([{ text: "Saca la basura", zone: "oficina" }]);
    expect(fired.map((r) => r.id)).toContain(t.id);
    expect(repo.get(t.id)!.status).toBe("fired");
  });

  it("fireDue HOLDS an absent target: not announced, not quiet-surfaced, stays pending", () => {
    const spoken: string[] = [];
    const quiet: string[] = [];
    const t = repo.create({ kind: "reminder", message: "Toma tu pastilla", forPerson: "Ana", fireAt: new Date(Date.now() - 1000).toISOString() });
    fireDue(new Date(), (text) => spoken.push(text), repo, { rooms: {}, quietSurface: (r) => quiet.push(r.id) });
    expect(spoken).toHaveLength(0);
    expect(quiet).toHaveLength(0);
    expect(repo.get(t.id)!.status).toBe("pending"); // held for a later tick
  });

  it("fireDue quiet-surfaces (never broadcasts) an absent target past the hold window", () => {
    const spoken: string[] = [];
    const quiet: string[] = [];
    const t = repo.create({ kind: "reminder", message: "Cena lista", forPerson: "Ana", fireAt: new Date(Date.now() - 60 * 60_000).toISOString() });
    fireDue(new Date(), (text) => spoken.push(text), repo, { rooms: {}, quietSurface: (r) => quiet.push(r.id) });
    expect(spoken).toHaveLength(0);
    expect(quiet).toContain(t.id);
    expect(repo.get(t.id)!.status).toBe("fired");
  });
});

describe("resolveFireAt", () => {
  const now = new Date("2026-06-23T20:00:00.000Z");

  it("resolves relative minutes and seconds", () => {
    expect(resolveFireAt(now, { minutes: 10 })).toBe("2026-06-23T20:10:00.000Z");
    expect(resolveFireAt(now, { seconds: 30 })).toBe("2026-06-23T20:00:30.000Z");
  });

  it("resolves an HH:MM clock time to the next occurrence (local clock, like the impl)", () => {
    // Mirror the implementation's LOCAL-time construction so the assertion is TZ-independent.
    const atLocal = (h: number, m: number, addDays = 0) => {
      const d = new Date(now);
      d.setHours(h, m, 0, 0);
      if (addDays) d.setDate(d.getDate() + addDays);
      return d;
    };
    const r2230 = resolveFireAt(now, { at: "22:30" })!;
    const passed = atLocal(22, 30).getTime() <= now.getTime();
    expect(r2230).toBe(atLocal(22, 30, passed ? 1 : 0).toISOString());

    const r0600 = resolveFireAt(now, { at: "06:00" })!;
    const passed6 = atLocal(6, 0).getTime() <= now.getTime();
    expect(r0600).toBe(atLocal(6, 0, passed6 ? 1 : 0).toISOString());
    // Whatever the local zone, the resolved time must be in the future.
    expect(Date.parse(r0600)).toBeGreaterThan(now.getTime());
  });

  it("passes a full ISO timestamp through and rejects junk", () => {
    expect(resolveFireAt(now, { at: "2026-12-25T09:00:00.000Z" })).toBe("2026-12-25T09:00:00.000Z");
    expect(resolveFireAt(now, { at: "luego" })).toBeNull();
    expect(resolveFireAt(now, { at: "99:99" })).toBeNull();
    expect(resolveFireAt(now, {})).toBeNull();
  });
});
