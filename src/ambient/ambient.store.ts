/**
 * Ambient perception store — the hub's small, in-memory, per-zone digest of how ACTIVE each room is
 * right now. Producers (the voice satellites: room volume/noise; later the camera world-model:
 * occupancy/activity) POST /ambient; the agent reads the live map inside GET /state as `ambient` and
 * uses it to make quiet-hours DYNAMIC (llm-gateway proactivity.ts: a zone's own ambient activity lifts
 * its soft quiet shoulder, zone-matched, lift-only — never the dead-of-night floor).
 *
 * Deliberately ephemeral + best-effort, like the ingestion seam: pings are volatile, expire on a TTL,
 * and NEVER touch SQLite. The control plane has zero dependency on ambient data — a zone with no fresh
 * ping simply drops out of the map and the agent falls back to the clock. This is "perception", not
 * control-plane truth.
 */

/** The per-zone digest the agent consumes (mirrors llm-gateway AmbientSnapshot). */
export interface AmbientDigest {
  zone: string;
  /** 0..1 normalized room volume/RMS from a satellite mic. */
  noiseLevel?: number;
  /** 0..1 activity density (speech/motion fraction over the sample window). */
  activityLevel?: number;
  /** Camera/presence world-model: a person is in the zone now. */
  occupied?: boolean;
  /** ISO timestamp the hub received the ping (for staleness on the consumer side). */
  observedAt: string;
}

/** Raw ping body as posted by a producer (all values untrusted → validated/clamped on record). */
export interface AmbientPing {
  zone?: unknown;
  noiseLevel?: unknown;
  activityLevel?: unknown;
  occupied?: unknown;
}

const TTL_MS = Number(process.env.AMBIENT_TTL_MS ?? 5 * 60 * 1000); // 5m: a missing producer goes stale, not sticky

const byZone = new Map<string, { digest: AmbientDigest; expiresAt: number }>();

const clamp01 = (n: unknown): number | undefined =>
  typeof n === "number" && Number.isFinite(n) ? Math.max(0, Math.min(1, n)) : undefined;

/** Validate + record a ping. Returns the stored digest, or null when the zone is missing/invalid (the
 *  route answers 400). Numbers are clamped to 0..1; `occupied` must be a real boolean to be kept. */
export function recordAmbient(p: AmbientPing, now = Date.now()): AmbientDigest | null {
  const zone = typeof p.zone === "string" ? p.zone.trim() : "";
  if (!zone) return null;
  const digest: AmbientDigest = {
    zone,
    noiseLevel: clamp01(p.noiseLevel),
    activityLevel: clamp01(p.activityLevel),
    occupied: typeof p.occupied === "boolean" ? p.occupied : undefined,
    observedAt: new Date(now).toISOString(),
  };
  byZone.set(zone, { digest, expiresAt: now + TTL_MS });
  return digest;
}

/** The live per-zone ambient map with stale zones pruned — the exact shape exposed in GET /state. */
export function ambientByZone(now = Date.now()): Record<string, AmbientDigest> {
  const out: Record<string, AmbientDigest> = {};
  for (const [zone, e] of byZone) {
    if (e.expiresAt <= now) {
      byZone.delete(zone);
      continue;
    }
    out[zone] = e.digest;
  }
  return out;
}

/** Test seam: clear all ambient state. */
export function __resetAmbient(): void {
  byZone.clear();
}
