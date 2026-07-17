/**
 * Speak-gain — maps a zone's background noise into a multiplier for satellite reply volume
 * (ADAPTIVE_SPEAK_VOLUME plan). The hub computes the number; Node-RED (the delivery seam,
 * voice-to-tts.json "push to satellite /play") stays a dumb applier — "hub computes the gain,
 * delivery applies it" is the plan's locked split.
 *
 * Curve: `gain` is linear in `background` between two knee points, then clamped to
 * [SPEAK_GAIN_MIN, SPEAK_GAIN_MAX]. A zone with no fresh background reading — never pinged, or its
 * digest aged out past ambient.store's TTL (ambientByZone() already prunes those, so "stale" and
 * "absent" look identical from here) — gets a neutral 1.0: never guess a gain from missing data.
 *
 * Night (dayPart === "night", the SAME source GET /state uses for its own `dayPart` field) caps the
 * result at 1.0: a quiet-room ATTENUATION still applies at night (softer is always safe), a
 * loud-room BOOST never does (never make a reply louder while the house is supposed to be asleep).
 *
 * All knees/clamps are env-tunable (`SPEAK_GAIN_*`), read fresh on every call rather than hoisted to
 * a module const — the values are cheap to re-read (a handful of GET /state zones, not a hot loop)
 * and it lets tests override per-case with a plain `process.env.SPEAK_GAIN_MIN = ...` instead of a
 * jest.resetModules dance. Defaults below are a starting guess; Phase 3 tunes them from a live
 * observation window (see the plan).
 */
import { ambientByZone } from "./ambient.store";
import { dayPart } from "./daypart";

export type SpeakGainBasis = "no-data" | "curve" | "night-capped";

export interface SpeakGainResult {
  gain: number;
  /** Why this number: no fresh background reading, the plain curve, or a night-time boost cap. */
  basis: SpeakGainBasis;
}

const clamp = (v: number, min: number, max: number) => Math.max(min, Math.min(max, v));

/** speakGain(zone, now) — the per-zone reply-volume multiplier. `now` is epoch ms (matches
 *  ambient.store's convention) so tests can pin the clock instead of racing Date.now(). */
export function speakGain(zone: string, now: number = Date.now()): SpeakGainResult {
  const background = ambientByZone(now)[zone]?.background;
  if (background === undefined) {
    return { gain: 1.0, basis: "no-data" };
  }

  const min = Number(process.env.SPEAK_GAIN_MIN ?? 0.6);
  const max = Number(process.env.SPEAK_GAIN_MAX ?? 1.8);
  const knee1Bg = Number(process.env.SPEAK_GAIN_KNEE1_BG ?? 0.05);
  const knee1Gain = Number(process.env.SPEAK_GAIN_KNEE1_GAIN ?? 0.9);
  const knee2Bg = Number(process.env.SPEAK_GAIN_KNEE2_BG ?? 0.35);
  const knee2Gain = Number(process.env.SPEAK_GAIN_KNEE2_GAIN ?? 1.8);

  // A straight line through the two knees, extended past them and THEN clamped — not a 3-segment
  // piecewise curve. With the defaults this only matters below knee1 (background can't go negative,
  // so the low end never actually reaches SPEAK_GAIN_MIN); above knee2 the line always exceeds
  // SPEAK_GAIN_MAX by background<=1, so the clamp is what actually produces the "loud room" ceiling.
  const slope = knee2Bg === knee1Bg ? 0 : (knee2Gain - knee1Gain) / (knee2Bg - knee1Bg);
  const curved = clamp(knee1Gain + slope * (background - knee1Bg), min, max);

  if (dayPart(new Date(now)) === "night" && curved > 1.0) {
    return { gain: 1.0, basis: "night-capped" };
  }
  return { gain: curved, basis: "curve" };
}
