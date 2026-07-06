/**
 * Vision perception store — validation, identity normalization, TTL pruning. The fused room-digest the
 * agent reads depends on this map being honest (no embeddings, classes constrained) and FRESH.
 */
import { recordVision, visionByZone, __resetVision } from "./vision.store";

beforeEach(() => __resetVision());

describe("recordVision", () => {
  it("stores a roster, derives count/occupied, and keeps ONLY resolved identity fields", () => {
    const d = recordVision({
      zone: "sala",
      people: [
        { id: "u1", name: "Juan", class: "household", confidence: 0.82, embedding: [1, 2, 3] },
        { id: null, name: null, class: "unknown", confidence: 0.0 },
      ],
    });
    expect(d).not.toBeNull();
    expect(d!.zone).toBe("sala");
    expect(d!.count).toBe(2);
    expect(d!.occupied).toBe(true);
    // `class` on the wire → `cls` on /state; embedding stripped (never stored).
    expect(d!.people[0]).toEqual({ id: "u1", name: "Juan", cls: "household", confidence: 0.82 });
    expect((d!.people[0] as any).embedding).toBeUndefined();
    expect(d!.people[1]).toEqual({ id: null, name: null, cls: "unknown", confidence: 0.0 });
  });

  it("rejects a push with no zone", () => {
    expect(recordVision({ people: [] })).toBeNull();
    expect(recordVision({ zone: "  " })).toBeNull();
  });

  it("an empty roster is unoccupied with count 0", () => {
    const d = recordVision({ zone: "cocina", people: [] });
    expect(d!.count).toBe(0);
    expect(d!.occupied).toBe(false);
    expect(d!.people).toEqual([]);
  });

  it("carries the T0/T1 activity fields (dwell_s→dwellS, moving, posture, zone activity)", () => {
    const d = recordVision({
      zone: "cocina",
      activity: "settled+standing",
      people: [
        { id: "u1", name: "David", class: "household", confidence: 0.9, dwell_s: 94.2, moving: false, posture: "standing" },
        { id: null, name: null, class: "unknown", confidence: 0, dwell_s: 3.1, moving: true },
      ],
    });
    expect(d!.activity).toBe("settled+standing");
    expect(d!.people[0]).toMatchObject({ dwellS: 94.2, moving: false, posture: "standing" });
    expect(d!.people[1]).toMatchObject({ dwellS: 3.1, moving: true });
    expect(d!.people[1].posture).toBeUndefined();
  });

  it("carries the T2a activity hint verbatim with its confidence tier", () => {
    const d = recordVision({
      zone: "cocina",
      activity: "settled+standing",
      activity_hint: "making breakfast or coffee",
      activity_hint_conf: "medium",
      people: [{ id: "u1", name: "David", class: "household", confidence: 0.9, dwell_s: 94.2, moving: false }],
    });
    expect(d!.activityHint).toBe("making breakfast or coffee");
    expect(d!.activityHintConf).toBe("medium");
    // a missing/garbage conf degrades to "low", never to a stored garbage value
    const low = recordVision({ zone: "sala", activity_hint: "relaxing", activity_hint_conf: "certain" });
    expect(low!.activityHintConf).toBe("low");
  });

  it("drops a malformed activity hint (markup / over-long) instead of storing it", () => {
    const d = recordVision({ zone: "x", activity_hint: "<script>alert(1)</script>" });
    expect(d!.activityHint).toBeUndefined();
    expect(d!.activityHintConf).toBeUndefined();
    const long = recordVision({ zone: "x", activity_hint: "a".repeat(81) });
    expect(long!.activityHint).toBeUndefined();
  });

  it("drops a garbage activity/posture instead of storing it", () => {
    const d = recordVision({
      zone: "x",
      activity: "sprinting",
      people: [{ class: "household", confidence: 0.9, dwell_s: -5, posture: "backflip" }],
    });
    expect(d!.activity).toBeUndefined();
    expect(d!.people[0].dwellS).toBeUndefined();
    expect(d!.people[0].posture).toBeUndefined();
  });

  it("clamps confidence and defaults an unknown/garbage class", () => {
    const d = recordVision({ zone: "x", people: [{ id: "g", class: "intruder", confidence: 9 }] });
    expect(d!.people[0].cls).toBe("unknown");
    expect(d!.people[0].confidence).toBe(1);
  });

  it("a newer push replaces the older one for a zone", () => {
    recordVision({ zone: "sala", people: [{ class: "unknown", confidence: 0 }] }, 1000);
    recordVision({ zone: "sala", people: [] }, 2000);
    expect(visionByZone(2000)["sala"].count).toBe(0);
  });
});

describe("visionByZone — freshness", () => {
  it("returns only non-expired zones and prunes stale ones", () => {
    const t0 = 1_000_000;
    recordVision({ zone: "sala", people: [{ class: "household", name: "Ana", confidence: 0.9 }] }, t0);
    expect(Object.keys(visionByZone(t0 + 60_000))).toEqual(["sala"]);
    expect(visionByZone(t0 + 6 * 60_000)).toEqual({});
  });
});
