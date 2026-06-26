// In-memory SQLite (NODE_ENV=test → ":memory:" in connection.ts). Covers the timers store:
// timer/reminder lifecycle (due → fired / cancelled) and the stopwatch elapsed math.
import { TimersRepo, elapsedSeconds } from "./timers.repo";

const repo = new TimersRepo();

function iso(offsetMs: number): string {
  return new Date(Date.now() + offsetMs).toISOString();
}

describe("TimersRepo — timers & reminders", () => {
  it("creates a pending timer and surfaces it as active", () => {
    const t = repo.create({ kind: "timer", message: "Ya está la pasta", fireAt: iso(60_000) });
    expect(t.status).toBe("pending");
    expect(t.id).toHaveLength(8);
    expect(repo.active().some((r) => r.id === t.id)).toBe(true);
  });

  it("due() returns only timers whose fire_at has passed", () => {
    const past = repo.create({ kind: "timer", message: "pasado", fireAt: iso(-1000) });
    const future = repo.create({ kind: "reminder", message: "futuro", fireAt: iso(60_000) });
    const due = repo.due(new Date().toISOString());
    const ids = due.map((r) => r.id);
    expect(ids).toContain(past.id);
    expect(ids).not.toContain(future.id);
  });

  it("markFired removes a timer from due() and active()", () => {
    const t = repo.create({ kind: "timer", message: "x", fireAt: iso(-1000) });
    repo.markFired(t.id);
    expect(repo.get(t.id)!.status).toBe("fired");
    expect(repo.due(new Date().toISOString()).some((r) => r.id === t.id)).toBe(false);
    expect(repo.active().some((r) => r.id === t.id)).toBe(false);
  });

  it("cancel marks a pending timer cancelled; cancelling an unknown id is a no-op", () => {
    const t = repo.create({ kind: "timer", message: "x", fireAt: iso(60_000) });
    expect(repo.cancel(t.id)!.status).toBe("cancelled");
    expect(repo.cancel("deadbeef")).toBeUndefined();
    // already-cancelled can't be cancelled again
    expect(repo.cancel(t.id)).toBeUndefined();
  });
});

describe("TimersRepo — stopwatch / time-tracking", () => {
  it("starts running, finds by label, and stops with elapsed", () => {
    const s = repo.create({ kind: "stopwatch", label: "cocinar" });
    expect(s.status).toBe("running");
    expect(s.fire_at).toBeNull();
    expect(repo.findRunning("cocinar")!.id).toBe(s.id);

    const stopped = repo.stop(s.id, iso(0));
    expect(stopped!.status).toBe("stopped");
    expect(stopped!.stopped_at).not.toBeNull();
    expect(repo.findRunning("cocinar")).toBeUndefined();
  });

  it("elapsedSeconds normalises SQLite UTC timestamps (no off-by-timezone)", () => {
    // started_at as SQLite writes it (UTC, space, no zone); ten minutes later in ISO-Z.
    const row: any = { started_at: "2026-06-23 10:00:00", stopped_at: null };
    expect(elapsedSeconds(row, "2026-06-23T10:10:00.000Z")).toBe(600);
  });
});
