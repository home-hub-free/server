/**
 * Room-digest fusion — the §3.1 reconciliation of vision (who/how-many) + ambient (activity/noise) + PIR
 * (fallback occupancy) into one per-zone world-model. Q2 fusion rules: camera roster wins for *who*;
 * occupied = OR of every source. Pure, so it's tested without the stores or HTTP.
 */
import { roomDigest } from "./room-digest";
import type { AmbientDigest } from "./ambient.store";
import type { VisionDigest } from "./vision.store";

const amb = (zone: string, o: Partial<AmbientDigest> = {}): AmbientDigest => ({
  zone, observedAt: "2026-06-29T20:00:00.000Z", ...o,
});
const vis = (zone: string, o: Partial<VisionDigest> = {}): VisionDigest => ({
  zone, count: 0, occupied: false, people: [], observedAt: "2026-06-29T20:00:01.000Z", ...o,
});

describe("roomDigest fusion", () => {
  it("the camera roster wins for who/how-many; ambient supplies activity/noise", () => {
    const rooms = roomDigest({
      ambient: { sala: amb("sala", { activityLevel: 0.7, noiseLevel: 0.5, occupied: false }) },
      vision: { sala: vis("sala", { count: 2, occupied: true, people: [
        { id: "u1", name: "Juan", cls: "household", confidence: 0.82 },
        { id: null, name: null, cls: "unknown", confidence: 0 },
      ] }) },
      pir: {},
    });
    const sala = rooms.sala;
    expect(sala.count).toBe(2);
    expect(sala.people?.[0].name).toBe("Juan");
    expect(sala.activityLevel).toBe(0.7);
    expect(sala.noiseLevel).toBe(0.5);
    expect(sala.source.sort()).toEqual(["ambient", "vision"]);
    expect(sala.occupied).toBe(true);
  });

  it("occupied is the OR of every source (PIR catches a person the camera missed)", () => {
    const rooms = roomDigest({
      ambient: {},
      vision: { sala: vis("sala", { count: 0, occupied: false }) }, // camera says empty
      pir: { sala: true }, // ...but a PIR is firing
    });
    expect(rooms.sala.occupied).toBe(true);
    expect(rooms.sala.source).toContain("pir");
    expect(rooms.sala.source).toContain("vision");
    // PIR/ambient can't count — count comes from vision only (0 here).
    expect(rooms.sala.count).toBe(0);
  });

  it("a PIR-only zone is occupied with no count/people (PIR can't say who)", () => {
    const rooms = roomDigest({ ambient: {}, vision: {}, pir: { bedroom: true } });
    expect(rooms.bedroom.occupied).toBe(true);
    expect(rooms.bedroom.count).toBeUndefined();
    expect(rooms.bedroom.people).toBeUndefined();
    expect(rooms.bedroom.source).toEqual(["pir"]);
  });

  it("an idle PIR zone (false) does not appear", () => {
    const rooms = roomDigest({ ambient: {}, vision: {}, pir: { cocina: false } });
    expect(rooms.cocina).toBeUndefined();
  });

  it("an ambient-only quiet zone still appears (its activity/noise reach the agent); occupied false", () => {
    const rooms = roomDigest({
      ambient: { cocina: amb("cocina", { activityLevel: 0.05, noiseLevel: 0.0, occupied: false }) },
      vision: {}, pir: {},
    });
    expect(rooms.cocina.occupied).toBe(false);
    expect(rooms.cocina.activityLevel).toBe(0.05);
    expect(rooms.cocina.source).toEqual(["ambient"]);
  });

  it("T0 zone activity + per-person dwell/posture ride the fusion untouched", () => {
    const rooms = roomDigest({
      ambient: {},
      vision: { cocina: vis("cocina", { count: 1, occupied: true, activity: "settled+standing", people: [
        { id: "u1", name: "David", cls: "household", confidence: 0.9, dwellS: 240, moving: false, posture: "standing" },
      ] }) },
      pir: {},
    });
    expect(rooms.cocina.activity).toBe("settled+standing");
    expect(rooms.cocina.people?.[0]).toMatchObject({ dwellS: 240, posture: "standing" });
    // A producer without T0 fields yields no activity key at all.
    const legacy = roomDigest({ ambient: {}, vision: { sala: vis("sala", { occupied: true }) }, pir: {} });
    expect("activity" in legacy.sala).toBe(false);
  });

  it("T2a activity hint rides the fusion verbatim; conf defaults to low", () => {
    const rooms = roomDigest({
      ambient: {},
      vision: { cocina: vis("cocina", { count: 1, occupied: true,
        activityHint: "making breakfast or coffee", activityHintConf: "medium" }) },
      pir: {},
    });
    expect(rooms.cocina.activityHint).toBe("making breakfast or coffee");
    expect(rooms.cocina.activityHintConf).toBe("medium");
    const bare = roomDigest({ ambient: {}, vision: { sala: vis("sala", {
      occupied: true, activityHint: "relaxing" }) }, pir: {} });
    expect(bare.sala.activityHintConf).toBe("low");
    // no hint from the producer → no hint keys at all
    const none = roomDigest({ ambient: {}, vision: { sala: vis("sala", { occupied: true }) }, pir: {} });
    expect("activityHint" in none.sala).toBe(false);
  });

  it("observedAt is the most-recent contributing source", () => {
    const rooms = roomDigest({
      ambient: { sala: amb("sala", { observedAt: "2026-06-29T20:00:00.000Z" }) },
      vision: { sala: vis("sala", { observedAt: "2026-06-29T20:05:00.000Z" }) },
      pir: {},
    });
    expect(rooms.sala.observedAt).toBe("2026-06-29T20:05:00.000Z");
  });
});
