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

describe("background EMA — utterance/background channel split", () => {
  it("a background (untagged) ping's first-ever reading seeds `background` directly", () => {
    const d = recordAmbient({ zone: "sala", noiseLevel: 0.4 }, 1000);
    expect(d!.background).toBe(0.4);
  });

  it("a second background ping blends via EMA (α=0.3) instead of overwriting", () => {
    recordAmbient({ zone: "sala", noiseLevel: 0.4 }, 1000);
    const d2 = recordAmbient({ zone: "sala", noiseLevel: 0.8 }, 2000);
    // 0.3*0.8 + 0.7*0.4 = 0.52
    expect(d2!.background).toBeCloseTo(0.52, 10);
    // ...and noiseLevel itself stays last-write-wins, unaffected by the EMA.
    expect(d2!.noiseLevel).toBe(0.8);
  });

  it("an utterance-tagged ping does NOT move background, but still refreshes noiseLevel/observedAt", () => {
    recordAmbient({ zone: "sala", noiseLevel: 0.3 }, 1000);
    const d = recordAmbient({ zone: "sala", noiseLevel: 0.9, utterance: true }, 2000);
    expect(d!.background).toBe(0.3); // unchanged by the speech-loudness reading
    expect(d!.noiseLevel).toBe(0.9); // digest still refreshes as today
    expect(d!.observedAt).toBe(new Date(2000).toISOString());
  });

  it("a background ping with no usable noiseLevel leaves background unchanged", () => {
    recordAmbient({ zone: "sala", noiseLevel: 0.5 }, 1000);
    const d = recordAmbient({ zone: "sala", activityLevel: 0.2 }, 2000);
    expect(d!.background).toBe(0.5);
  });

  it("a zone that has only ever heard utterance pings has no background reading", () => {
    const d = recordAmbient({ zone: "oficina", noiseLevel: 0.6, utterance: true }, 1000);
    expect(d!.background).toBeUndefined();
  });

  it("TTL expiry drops noiseLevel AND background together (no separate lifetime)", () => {
    const t0 = 1_000_000;
    recordAmbient({ zone: "sala", noiseLevel: 0.5 }, t0);
    expect(ambientByZone(t0 + 60_000)["sala"].background).toBe(0.5);
    expect(ambientByZone(t0 + 6 * 60_000)["sala"]).toBeUndefined();
  });
});
