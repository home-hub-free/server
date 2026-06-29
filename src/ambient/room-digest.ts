/**
 * Room digest — the hub FUSES its three per-zone perception sources into one world-model the agent reads
 * on GET /state as `rooms` (PERCEPTION_TO_AGENT_PLAN §3.1). This is the abstraction that reconciles the
 * three previously un-joined presence notions (plan G5):
 *
 *   - vision  (camera world-model) — authoritative for WHO and HOW MANY (identity roster + count).
 *   - ambient (satellite mic)      — activity/noise levels + a coarse occupied flag.
 *   - pir     (presence/motion)    — fallback occupancy (can only ever say ">=1 person", never who).
 *
 * Fusion rules (plan Q2): the camera roster wins for *who/how many*; `occupied` is the OR of every source
 * (never miss a person). Pure over its inputs (no I/O, no clock dependency beyond the passed `now`), so
 * the fusion is unit-testable without the stores or HTTP — state-routes.ts wires the live maps in.
 */
import type { AmbientDigest } from "./ambient.store";
import type { RoomPerson, VisionDigest } from "./vision.store";

/** One fused per-zone room — the shape the gateway renders into "Who's around". */
export interface RoomDigest {
  zone: string;
  /** Fused: vision roster OR ambient.occupied OR a firing PIR — the OR of every source. */
  occupied: boolean;
  /** People in the zone — vision only (PIR/ambient can't count). Omitted when no camera covers the zone. */
  count?: number;
  /** Identity roster (confidence-gated downstream) — vision only. Omitted when no camera covers the zone. */
  people?: RoomPerson[];
  /** 0..1 ambient activity density (satellite mic). */
  activityLevel?: number;
  /** 0..1 ambient room volume (satellite mic). */
  noiseLevel?: number;
  /** Which sources contributed — for trust/debug + the agent's grounding confidence. */
  source: Array<"vision" | "ambient" | "pir">;
  /** Most-recent observation among the contributing sources. */
  observedAt: string;
}

export interface RoomDigestInputs {
  ambient: Record<string, AmbientDigest>;
  vision: Record<string, VisionDigest>;
  /** zone -> any PIR/presence sensor firing. Only `true` zones contribute (an idle PIR isn't presence). */
  pir: Record<string, boolean>;
}

/** Fuse the three per-zone perception maps into one `rooms` world-model. A zone is emitted when ANY
 *  source is fresh/active for it (the stores already TTL-prune, so a zone present here has live data);
 *  the gateway applies the prompt's activity threshold + identity confidence gate at render time. */
export function roomDigest(inputs: RoomDigestInputs, now = Date.now()): Record<string, RoomDigest> {
  const { ambient, vision, pir } = inputs;
  const zones = new Set<string>([
    ...Object.keys(ambient),
    ...Object.keys(vision),
    ...Object.keys(pir).filter((z) => pir[z]),
  ]);

  const out: Record<string, RoomDigest> = {};
  for (const zone of zones) {
    const v = vision[zone];
    const a = ambient[zone];
    const p = pir[zone] === true;

    const source: RoomDigest["source"] = [];
    if (v) source.push("vision");
    if (a) source.push("ambient");
    if (p) source.push("pir");

    const occupied =
      (v ? v.occupied || v.count > 0 : false) || a?.occupied === true || p;

    // Latest observation among the sources; PIR has no timestamp of its own, so fall back to `now`.
    const stamps = [v?.observedAt, a?.observedAt].filter((s): s is string => !!s);
    const observedAt = stamps.length
      ? stamps.reduce((latest, s) => (s > latest ? s : latest))
      : new Date(now).toISOString();

    out[zone] = {
      zone,
      occupied,
      ...(v ? { count: v.count, people: v.people } : {}),
      ...(a?.activityLevel !== undefined ? { activityLevel: a.activityLevel } : {}),
      ...(a?.noiseLevel !== undefined ? { noiseLevel: a.noiseLevel } : {}),
      source,
      observedAt,
    };
  }
  return out;
}
