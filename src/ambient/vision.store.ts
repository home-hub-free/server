/**
 * Vision perception store — the hub's per-zone occupancy+identity digest pushed by the vision-service
 * (cameras) on every salient change (PERCEPTION_TO_AGENT_PLAN §3.1). Sibling to ambient.store: the
 * satellite mic owns noise/activity (ambient); the camera world-model owns WHO/HOW-MANY (vision). They
 * are SEPARATE producers reporting different fields of the same zone, so they get separate stores and
 * are FUSED at read time by room-digest.ts — widening one POST /ambient would let a mic ping and a
 * camera ping clobber each other.
 *
 * Same posture as ambient.store: in-memory, TTL-pruned, best-effort, NEVER touches SQLite. Only resolved
 * identity (`{id, name, cls, confidence}`) is ever stored — NEVER an embedding (biometrics stay on the
 * box, CLAUDE.md identity rule). A zone with no fresh push simply drops out of the map.
 */

/** One resolved person in a zone — the SAME shape voice fills (AgentUserContext), via face. Names are
 *  carried but the agent gates on confidence before USING one (an unsure face is "someone"). */
export interface RoomPerson {
  id?: string | null;
  name?: string | null;
  cls: "household" | "guest" | "unknown";
  confidence: number;
}

/** The per-zone vision digest the hub keeps (what the camera pushes, validated/normalized). */
export interface VisionDigest {
  zone: string;
  count: number;
  occupied: boolean;
  people: RoomPerson[];
  /** ISO timestamp the hub received the push (for staleness on the consumer side). */
  observedAt: string;
}

/** Raw push body (untrusted → validated/normalized on record). Mirrors hub_push.room_digest_payload. */
export interface VisionPing {
  zone?: unknown;
  count?: unknown;
  occupied?: unknown;
  people?: unknown;
}

const TTL_MS = Number(process.env.VISION_TTL_MS ?? 5 * 60 * 1000); // 5m, like ambient: a gone producer goes stale

const byZone = new Map<string, { digest: VisionDigest; expiresAt: number }>();

const CLASSES = new Set(["household", "guest", "unknown"]);

const clamp01 = (n: unknown): number =>
  typeof n === "number" && Number.isFinite(n) ? Math.max(0, Math.min(1, n)) : 0;

/** Normalize one untrusted person entry. The producer sends identity meta keyed `class` (the established
 *  identity-meta key); we expose it as `cls` (TS-friendly) on /state. Accepts either. */
function normalizePerson(p: any): RoomPerson {
  const rawCls = typeof p?.cls === "string" ? p.cls : typeof p?.class === "string" ? p.class : "unknown";
  const cls = (CLASSES.has(rawCls) ? rawCls : "unknown") as RoomPerson["cls"];
  return {
    id: typeof p?.id === "string" ? p.id : null,
    name: typeof p?.name === "string" ? p.name : null,
    cls,
    confidence: clamp01(p?.confidence),
  };
}

/** Validate + record a vision push. Returns the stored digest, or null when zone is missing/invalid
 *  (the route answers 400). `count` is taken from the people roster (the producer's source of truth). */
export function recordVision(p: VisionPing, now = Date.now()): VisionDigest | null {
  const zone = typeof p.zone === "string" ? p.zone.trim() : "";
  if (!zone) return null;
  const people = Array.isArray(p.people) ? p.people.map(normalizePerson) : [];
  const occupied = typeof p.occupied === "boolean" ? p.occupied : people.length > 0;
  const digest: VisionDigest = {
    zone,
    people,
    count: people.length,
    occupied: occupied || people.length > 0,
    observedAt: new Date(now).toISOString(),
  };
  byZone.set(zone, { digest, expiresAt: now + TTL_MS });
  return digest;
}

/** The live per-zone vision map with stale zones pruned — what room-digest.ts fuses. */
export function visionByZone(now = Date.now()): Record<string, VisionDigest> {
  const out: Record<string, VisionDigest> = {};
  for (const [zone, e] of byZone) {
    if (e.expiresAt <= now) {
      byZone.delete(zone);
      continue;
    }
    out[zone] = e.digest;
  }
  return out;
}

/** Test seam: clear all vision state. */
export function __resetVision(): void {
  byZone.clear();
}
