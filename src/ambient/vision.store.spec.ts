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
