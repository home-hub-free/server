/**
 * Ambient perception store — the hub's small, in-memory, per-zone digest of how ACTIVE each room is
 * right now. Producers POST /ambient: the voice satellite's per-30s report (room volume/noise) and
 * voice-pipeline's per-utterance ping (speech loudness — tagged `utterance:true`); later the camera
 * world-model (occupancy/activity). The agent reads the live map inside GET /state as `ambient`.
 * (The original consumer, llm-gateway proactivity.ts's dynamic quiet-hours, was deleted at the P6
 * cutover — the current consumer is speak-gain.ts's per-zone reply-volume curve, ADAPTIVE_SPEAK_VOLUME
 * plan.)
 *
 * TWO CHANNELS, one digest: `noiseLevel`/`activityLevel`/`occupied` stay last-write-wins (any ping
 * refreshes them, exactly as before) but `background` is a separate slow EMA fed ONLY by pings that
 * are NOT tagged `utterance:true` — a per-utterance ping is the user's speech loudness, not room
 * noise, and must never look like a suddenly loud room right before a reply gets sized off it. See
 * `recordAmbient` for the split.
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
  /** Slow EMA (α=0.3, see BACKGROUND_EMA_ALPHA) of background-only `noiseLevel` readings — pings
   *  tagged `utterance:true` never feed this. Undefined until the zone's first background ping (a
   *  zone that has only ever heard utterance pings has no background reading yet). Feeds speak-gain.ts. */
  background?: number;
  /** ISO timestamp the hub received the ping (for staleness on the consumer side). */
  observedAt: string;
}

/** Raw ping body as posted by a producer (all values untrusted → validated/clamped on record). */
export interface AmbientPing {
  zone?: unknown;
  noiseLevel?: unknown;
  activityLevel?: unknown;
  occupied?: unknown;
  /** true ONLY on voice-pipeline's per-utterance ping (speech loudness). Untagged/false/anything else
   *  = a background reading (satellite's periodic report, or the opt-in continuous sampler). */
  utterance?: unknown;
}

const TTL_MS = Number(process.env.AMBIENT_TTL_MS ?? 5 * 60 * 1000); // 5m: a missing producer goes stale, not sticky
const BACKGROUND_EMA_ALPHA = 0.3; // weight on each new background-only reading; a design constant, not env-tunable

const byZone = new Map<string, { digest: AmbientDigest; expiresAt: number }>();

const clamp01 = (n: unknown): number | undefined =>
  typeof n === "number" && Number.isFinite(n) ? Math.max(0, Math.min(1, n)) : undefined;

/** Validate + record a ping. Returns the stored digest, or null when the zone is missing/invalid (the
 *  route answers 400). Numbers are clamped to 0..1; `occupied` must be a real boolean to be kept.
 *
 *  `background` is the one field that is NOT last-write-wins: a background (untagged) ping with a
 *  usable `noiseLevel` either seeds it directly (the zone's first-ever background reading) or blends
 *  it in via the EMA; an utterance ping — or a background ping with no usable `noiseLevel` — carries
 *  the previous value forward UNCHANGED rather than clobbering or resetting it. (EMA of inputs already
 *  clamped 0..1 stays in 0..1 by construction, so no extra clamp is needed on the blended result.) */
export function recordAmbient(p: AmbientPing, now = Date.now()): AmbientDigest | null {
  const zone = typeof p.zone === "string" ? p.zone.trim() : "";
  if (!zone) return null;
  const noise = clamp01(p.noiseLevel);
  const isUtterance = p.utterance === true;
  const prevBackground = byZone.get(zone)?.digest.background;
  const background =
    isUtterance || noise === undefined
      ? prevBackground
      : prevBackground === undefined
        ? noise // bootstrap: the zone's first background reading seeds directly, no averaging yet
        : BACKGROUND_EMA_ALPHA * noise + (1 - BACKGROUND_EMA_ALPHA) * prevBackground;
  const digest: AmbientDigest = {
    zone,
    noiseLevel: noise,
    activityLevel: clamp01(p.activityLevel),
    occupied: typeof p.occupied === "boolean" ? p.occupied : undefined,
    background,
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
