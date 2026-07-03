// Driver decision + tick behavior, everything injected (clock, rooms, users, latch, sinks).
import { PublicUser } from "../db/users.repo";
import type { RoomDigest } from "../ambient/room-digest";
import { confidentZone, decideBrief, localDateKey, runBriefTick, BriefTickDeps, LatchStore } from "./driver";
import type { BriefFetchers } from "./assemble";

const userOf = (o: Partial<PublicUser> = {}): PublicUser => ({
  id: "david",
  username: "david",
  displayName: "David",
  prefs: {},
  createdAt: "x",
  ...o,
});

const room = (zone: string, people: RoomDigest["people"], count?: number): RoomDigest => ({
  zone,
  occupied: true,
  count: count ?? people!.length,
  people,
  source: ["vision"],
  observedAt: "x",
});

const davidIn = (zone: string, over: Partial<NonNullable<RoomDigest["people"]>[number]> = {}) =>
  room(zone, [{ id: "david", name: "David", cls: "household", confidence: 0.9, ...over }]);

// 2026-07-02, at a given local clock time.
const at = (hm: string): Date => new Date(`2026-07-02T${hm}:00`);

const memLatch = (): LatchStore => {
  const m = new Map<string, string>();
  return { get: (id) => m.get(id), set: (id, d) => m.set(id, d) };
};

describe("confidentZone (§3.6 confidence gate)", () => {
  it("finds a confident household member by id, and flags a shared room", () => {
    expect(confidentZone({ cocina: davidIn("cocina") }, userOf())).toEqual({ zone: "cocina", shared: false });
    const sharedRoom = room("sala", [
      { id: "david", name: "David", cls: "household", confidence: 0.9 },
      { id: null, name: null, cls: "unknown", confidence: 0.3 },
    ]);
    expect(confidentZone({ sala: sharedRoom }, userOf())).toEqual({ zone: "sala", shared: true });
  });

  it("gives NOTHING to a low-confidence or non-household match", () => {
    expect(confidentZone({ cocina: davidIn("cocina", { confidence: 0.4 }) }, userOf())).toBeUndefined();
    expect(confidentZone({ cocina: davidIn("cocina", { cls: "guest" }) }, userOf())).toBeUndefined();
  });
});

describe("decideBrief", () => {
  const rooms = { cocina: davidIn("cocina") };

  it("waits before the window, delivers on first presence inside it, quiets after it", () => {
    expect(decideBrief(userOf(), rooms, at("04:30"), undefined).action).toBe("wait");
    expect(decideBrief(userOf(), rooms, at("07:15"), undefined)).toEqual({
      action: "deliver",
      zone: "cocina",
      shared: false,
    });
    expect(decideBrief(userOf(), {}, at("07:15"), undefined).action).toBe("wait"); // in window, not seen yet
    expect(decideBrief(userOf(), {}, at("11:30"), undefined).action).toBe("quiet");
  });

  it("skips when disabled or already latched today; a stale latch doesn't stick", () => {
    const off = userOf({ prefs: { brief: { enabled: false } } });
    expect(decideBrief(off, rooms, at("07:15"), undefined).action).toBe("skip");
    expect(decideBrief(userOf(), rooms, at("07:15"), "2026-07-02").action).toBe("skip");
    expect(decideBrief(userOf(), rooms, at("07:15"), "2026-07-01").action).toBe("deliver"); // yesterday's latch expired
  });

  it("honors a per-user window override from prefs", () => {
    const early = userOf({ prefs: { brief: { windowStart: "04:00", windowEnd: "06:00" } } });
    expect(decideBrief(early, rooms, at("04:30"), undefined).action).toBe("deliver");
    expect(decideBrief(early, rooms, at("07:15"), undefined).action).toBe("quiet");
  });

  // T0 defer-while-passing (VISION_CONTEXT_TIERS_PLAN §2): the rushing-past fix.
  describe("activity gate", () => {
    const inKitchen = (over: Partial<NonNullable<RoomDigest["people"]>[number]>, activity?: string) => {
      const r = davidIn("cocina", over);
      if (activity) r.activity = activity;
      return { cocina: r };
    };

    it("defers while the zone reads passing — and does NOT deliver", () => {
      const d = decideBrief(userOf(), inKitchen({ dwellS: 90, moving: true }, "passing"), at("07:15"), undefined);
      expect(d).toEqual({ action: "defer", zone: "cocina", activity: "passing", dwellS: 90 });
    });

    it("defers under briefMinDwellS even when the zone is not passing", () => {
      const d = decideBrief(userOf(), inKitchen({ dwellS: 30 }, "lingering"), at("07:15"), undefined);
      expect(d.action).toBe("defer");
    });

    it("delivers once settled past the dwell bar, carrying the activity snapshot", () => {
      const d = decideBrief(userOf(), inKitchen({ dwellS: 120 }, "settled+standing"), at("07:15"), undefined);
      expect(d).toEqual({
        action: "deliver", zone: "cocina", shared: false, activity: "settled+standing", dwellS: 120,
      });
    });

    it("honors a per-user briefMinDwellS pref", () => {
      const eager = userOf({ prefs: { brief: { briefMinDwellS: 10 } } });
      expect(decideBrief(eager, inKitchen({ dwellS: 15 }, "lingering"), at("07:15"), undefined).action).toBe("deliver");
    });

    it("a zone with NO dwell/activity data keeps the old first-sighting behavior", () => {
      expect(decideBrief(userOf(), { cocina: davidIn("cocina") }, at("07:15"), undefined).action).toBe("deliver");
    });
  });
});

describe("runBriefTick — defer does not latch", () => {
  it("a passing sighting is re-evaluated next tick and delivers once settled", async () => {
    const spoken: Array<{ text: string; zone?: string | null }> = [];
    let dwell = 5;
    const m = new Map<string, string>();
    const deps: BriefTickDeps = {
      users: () => [userOf()],
      rooms: () => {
        const r = davidIn("cocina", { dwellS: dwell });
        r.activity = dwell < 45 ? "passing" : "settled";
        return { cocina: r };
      },
      announce: (text, zone) => spoken.push({ text, zone }),
      quietNote: () => {},
      fetchers: {
        calendarSources: async () => [{ kind: "personal" }],
        calendarEvents: async () => [{ title: "Dentista", start: "2026-07-02T09:00" }],
        weather: async () => null,
      },
      latch: { get: (id) => m.get(id), set: (id, d) => m.set(id, d) },
    };
    await runBriefTick(at("07:15"), deps);
    expect(spoken).toHaveLength(0);
    expect(m.get("david")).toBeUndefined(); // deferred, NOT latched
    dwell = 200; // settled by the next tick
    await runBriefTick(at("07:16"), deps);
    expect(spoken).toHaveLength(1);
    expect(m.get("david")).toBe("2026-07-02");
  });
});

describe("runBriefTick", () => {
  const fetchers = (over: Partial<BriefFetchers> = {}): BriefFetchers => ({
    calendarSources: async () => [{ kind: "personal" }],
    calendarEvents: async () => [{ title: "Dentista", start: "2026-07-02T09:00" }],
    weather: async () => null,
    ...over,
  });

  const depsOf = (over: Partial<BriefTickDeps> = {}) => {
    const spoken: Array<{ text: string; zone?: string | null }> = [];
    const notes: string[] = [];
    const deps: BriefTickDeps = {
      users: () => [userOf()],
      rooms: () => ({ cocina: davidIn("cocina") }),
      announce: (text, zone) => spoken.push({ text, zone }),
      quietNote: (_u, text) => notes.push(text),
      fetchers: fetchers(),
      latch: memLatch(),
      ...over,
    };
    return { deps, spoken, notes };
  };

  it("briefs a present person in THEIR zone exactly once (latch persists across ticks)", async () => {
    const { deps, spoken } = depsOf();
    await runBriefTick(at("07:15"), deps);
    expect(spoken).toHaveLength(1);
    expect(spoken[0].zone).toBe("cocina");
    expect(spoken[0].text).toContain("Dentista");
    await runBriefTick(at("07:16"), deps); // re-entry / next tick → no re-brief
    expect(spoken).toHaveLength(1);
  });

  it("degrades to count-only when the room is shared", async () => {
    const sharedRoom = room("sala", [
      { id: "david", name: "David", cls: "household", confidence: 0.9 },
      { id: "u2", name: "Ana", cls: "household", confidence: 0.9 },
    ]);
    const { deps, spoken } = depsOf({ rooms: () => ({ sala: sharedRoom }) });
    await runBriefTick(at("07:15"), deps);
    expect(spoken).toHaveLength(1);
    expect(spoken[0].text).not.toContain("Dentista");
    expect(spoken[0].text).toContain("una cosa");
  });

  it("an empty calendar latches SILENTLY (the self-gate: a quiet day is silence)", async () => {
    const { deps, spoken } = depsOf({ fetchers: fetchers({ calendarEvents: async () => [] }) });
    await runBriefTick(at("07:15"), deps);
    expect(spoken).toHaveLength(0);
    expect(deps.latch.get("david")).toBe("2026-07-02");
  });

  it("no personal calendar linked → no brief, no family fallback, latched", async () => {
    const { deps, spoken } = depsOf({
      fetchers: fetchers({ calendarSources: async () => [{ kind: "family" }] }),
    });
    await runBriefTick(at("07:15"), deps);
    expect(spoken).toHaveLength(0);
    expect(deps.latch.get("david")).toBe("2026-07-02");
  });

  it("assembly failure leaves the person UNLATCHED so the next tick retries", async () => {
    let calls = 0;
    const flaky = fetchers({
      calendarEvents: async () => {
        if (++calls === 1) throw new Error("calendar-service down");
        return [{ title: "Dentista", start: "2026-07-02T09:00" }];
      },
    });
    const { deps, spoken } = depsOf({ fetchers: flaky });
    await runBriefTick(at("07:15"), deps);
    expect(spoken).toHaveLength(0);
    expect(deps.latch.get("david")).toBeUndefined();
    await runBriefTick(at("07:16"), deps);
    expect(spoken).toHaveLength(1);
  });

  it("window closed + never seen → quiet note (never spoken to an empty house), latched", async () => {
    const { deps, spoken, notes } = depsOf({ rooms: () => ({}) });
    await runBriefTick(at("11:30"), deps);
    expect(spoken).toHaveLength(0);
    expect(notes).toHaveLength(1);
    expect(notes[0]).toContain("Dentista");
    expect(deps.latch.get("david")).toBe("2026-07-02");
  });

  it("a throwing announce sink does not wedge the tick and still latches", async () => {
    const { deps } = depsOf({
      announce: () => {
        throw new Error("speaker down");
      },
    });
    await expect(runBriefTick(at("07:15"), deps)).resolves.toBeUndefined();
    expect(deps.latch.get("david")).toBe("2026-07-02");
  });
});

describe("localDateKey", () => {
  it("formats the local calendar day", () => {
    expect(localDateKey(new Date(2026, 6, 2, 7, 5))).toBe("2026-07-02");
  });
});
