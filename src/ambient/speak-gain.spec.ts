/**
 * Speak-gain curve — the per-zone reply-volume multiplier that ambient.store's `background` EMA
 * feeds. Every test seeds `background` via a SINGLE recordAmbient background ping (the EMA bootstraps
 * directly on a zone's first background reading — see ambient.store.spec.ts), so the fed value is
 * exact and not itself subject to EMA blending.
 */
import { recordAmbient, __resetAmbient } from "./ambient.store";
import { speakGain } from "./speak-gain";

// Built from setHours (local time), matching how dayPart() reads the clock — avoids relying on
// ISO-string timezone-parsing semantics that could vary between the test box and CI.
function atHour(hour: number): number {
  const d = new Date();
  d.setHours(hour, 0, 0, 0);
  return d.getTime();
}
const NOON = atHour(12); // afternoon — dayPart !== "night"
const MIDNIGHT = atHour(2); // night

beforeEach(() => __resetAmbient());

describe("speakGain — no data", () => {
  it("a zone that was never pinged defaults to neutral gain", () => {
    expect(speakGain("sala", NOON)).toEqual({ gain: 1.0, basis: "no-data" });
  });

  it("a zone with only utterance pings (background never seeded) also defaults to neutral", () => {
    recordAmbient({ zone: "sala", noiseLevel: 0.8, utterance: true }, NOON);
    expect(speakGain("sala", NOON)).toEqual({ gain: 1.0, basis: "no-data" });
  });

  it("a zone whose digest aged out past the ambient TTL also defaults to neutral", () => {
    recordAmbient({ zone: "sala", noiseLevel: 0.5 }, NOON);
    expect(speakGain("sala", NOON + 6 * 60_000).basis).toBe("no-data"); // 6m > 5m default TTL
  });
});

describe("speakGain — curve", () => {
  it("a quiet room gains below 1.0", () => {
    recordAmbient({ zone: "sala", noiseLevel: 0.02 }, NOON);
    const r = speakGain("sala", NOON);
    expect(r.gain).toBeLessThan(1.0);
    expect(r.basis).toBe("curve");
  });

  it("a loud room clamps at the configured max", () => {
    recordAmbient({ zone: "sala", noiseLevel: 0.9 }, NOON);
    const r = speakGain("sala", NOON);
    expect(r.gain).toBe(1.8); // default SPEAK_GAIN_MAX
    expect(r.basis).toBe("curve");
  });
});

describe("speakGain — night cap", () => {
  it("caps a would-be boost at 1.0 but still allows attenuation", () => {
    recordAmbient({ zone: "sala", noiseLevel: 0.9 }, MIDNIGHT); // would clamp to GAIN_MAX by day
    expect(speakGain("sala", MIDNIGHT)).toEqual({ gain: 1.0, basis: "night-capped" });

    recordAmbient({ zone: "oficina", noiseLevel: 0.02 }, MIDNIGHT); // would be <1 by day too
    const quiet = speakGain("oficina", MIDNIGHT);
    expect(quiet.gain).toBeLessThan(1.0); // attenuation still allowed at night
    expect(quiet.basis).toBe("curve");
  });
});

describe("speakGain — env overrides", () => {
  const KEYS = ["SPEAK_GAIN_MIN", "SPEAK_GAIN_MAX"];
  afterEach(() => {
    for (const k of KEYS) delete process.env[k];
  });

  it("a lower SPEAK_GAIN_MAX clamps a loud room tighter than the default", () => {
    recordAmbient({ zone: "sala", noiseLevel: 0.9 }, NOON);
    process.env.SPEAK_GAIN_MAX = "1.2";
    expect(speakGain("sala", NOON).gain).toBe(1.2);
  });

  it("raising SPEAK_GAIN_MIN floors an otherwise-lower curve value", () => {
    recordAmbient({ zone: "sala", noiseLevel: 0 }, NOON);
    expect(speakGain("sala", NOON).gain).toBeCloseTo(0.75, 10); // sanity: default curve value at background=0
    process.env.SPEAK_GAIN_MIN = "0.95";
    expect(speakGain("sala", NOON).gain).toBe(0.95);
  });
});
