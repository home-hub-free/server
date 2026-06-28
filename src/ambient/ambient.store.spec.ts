/**
 * Ambient perception store — validation, clamping, TTL pruning. The agent's dynamic quiet-hours depend
 * on this map being honest (clamped 0..1) and FRESH (stale zones gone), so a dead producer can never
 * keep a room looking "awake".
 */
import { recordAmbient, ambientByZone, __resetAmbient } from "./ambient.store";

beforeEach(() => __resetAmbient());

describe("recordAmbient", () => {
  it("stores a valid ping and clamps levels into 0..1", () => {
    const d = recordAmbient({ zone: "sala", noiseLevel: 1.7, activityLevel: -0.2, occupied: true });
    expect(d).not.toBeNull();
    expect(d!.zone).toBe("sala");
    expect(d!.noiseLevel).toBe(1); // clamped down
    expect(d!.activityLevel).toBe(0); // clamped up
    expect(d!.occupied).toBe(true);
    expect(typeof d!.observedAt).toBe("string");
  });

  it("rejects a ping with no zone", () => {
    expect(recordAmbient({ noiseLevel: 0.5 })).toBeNull();
    expect(recordAmbient({ zone: "   " })).toBeNull();
  });

  it("omits non-numeric levels and non-boolean occupied (no misleading zeros)", () => {
    const d = recordAmbient({ zone: "oficina", noiseLevel: "loud" as unknown, occupied: "yes" as unknown });
    expect(d!.noiseLevel).toBeUndefined();
    expect(d!.activityLevel).toBeUndefined();
    expect(d!.occupied).toBeUndefined();
  });

  it("a newer ping for a zone replaces the older one", () => {
    recordAmbient({ zone: "sala", noiseLevel: 0.2 }, 1000);
    recordAmbient({ zone: "sala", noiseLevel: 0.8 }, 2000);
    expect(ambientByZone(2000)["sala"].noiseLevel).toBe(0.8);
  });
});

describe("ambientByZone — freshness", () => {
  it("returns only non-expired zones and prunes stale ones", () => {
    const t0 = 1_000_000;
    recordAmbient({ zone: "sala", noiseLevel: 0.5 }, t0);
    recordAmbient({ zone: "oficina", noiseLevel: 0.4 }, t0);

    // Within TTL (default 5m): both present.
    const fresh = ambientByZone(t0 + 60_000);
    expect(Object.keys(fresh).sort()).toEqual(["oficina", "sala"]);

    // Past TTL: pruned out, so a dead producer never keeps a room "awake".
    const stale = ambientByZone(t0 + 6 * 60_000);
    expect(stale).toEqual({});
  });
});
