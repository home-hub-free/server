// Scheduler firing logic + relative/absolute fire-time resolution, with the clock + sink injected
// (no real interval, no Polly). Runs against the in-memory test DB via the shared repo.
import { fireDue, resolveFireAt } from "./scheduler";
import { TimersRepo } from "../db/timers.repo";

const repo = new TimersRepo();

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
