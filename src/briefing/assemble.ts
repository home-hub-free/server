/**
 * Brief assembler (docs/BRIEFING_ROUTINE.md §3.2) — DETERMINISTIC content assembly for the
 * morning brief: the person's calendar for today + the cached weather, rendered through a
 * Spanish template. No LLM on this path on purpose — the brief has to be reliable enough to
 * be a trustworthy default (PHILOSOPHY.md §2).
 *
 * Pure over injected fetchers so tests need neither calendar-service nor Open-Meteo. The
 * default fetchers call calendar-service over HTTP (same CALENDAR_URL convention as the
 * gateway) and read the hub's own in-process forecast cache (no loopback HTTP for /weather).
 *
 * Calendar routing gotcha this module owns: the calendar router degrades an `owner=<person>`
 * read to the FAMILY calendar when that person has no linked calendar. A brief must never do
 * that (it would read the family calendar to every unlinked member as if it were theirs), so
 * we check GET /sources first and only proceed when a `kind:"personal"` source exists.
 * Owner is routed by user.id — the roster's name map can't resolve display names today
 * (hub sends `displayName`, roster expects `name`), but ids resolve via IsEnrolled.
 */
import { log, EVENT_TYPES } from "../logger";

export interface BriefEvent {
  title: string;
  /** ISO-8601 local start, e.g. "2026-07-03T09:00". */
  start: string;
  end?: string;
  all_day?: boolean;
  calendar?: string;
}

export interface BriefWeather {
  min: number;
  max: number;
  description: string;
}

/** The assembled facts a brief is phrased from. `events` may be empty (→ no brief, the self-gate). */
export interface BriefFacts {
  events: BriefEvent[];
  weather: BriefWeather | null;
}

export interface BriefFetchers {
  /** The calendar sources a read for this owner spans (GET /sources) — used for the personal-source gate. */
  calendarSources(ownerId: string): Promise<Array<{ kind?: string }>>;
  /** The owner's events for one local calendar day (GET /events?owner=&from=). */
  calendarEvents(ownerId: string, dateISO: string): Promise<BriefEvent[]>;
  /** Today's forecast, or null when it was never fetched. */
  weather(): Promise<BriefWeather | null>;
}

/**
 * Assemble the brief facts for one person. Returns:
 *  - null            → the person has NO personal calendar linked (never brief; avoids the
 *                      router's family fallback). Callers latch so this isn't re-probed all day.
 *  - { events: [] }  → linked but nothing today (the §1 self-gate: a quiet day is silence).
 * Calendar fetch errors propagate (the driver leaves the person unlatched and retries next tick);
 * a weather failure degrades to weather:null — never blocks the calendar half.
 */
export async function assembleBrief(
  ownerId: string,
  dateISO: string,
  f: BriefFetchers,
): Promise<BriefFacts | null> {
  const sources = await f.calendarSources(ownerId);
  if (!sources.some((s) => s?.kind === "personal")) return null;
  const events = await f.calendarEvents(ownerId, dateISO);
  // calendar-service concatenates per-calendar (personal, then work, …) — merge chronologically
  // so the spoken brief follows the day. ISO strings compare lexicographically.
  events.sort((a, b) => (a.start || "").localeCompare(b.start || ""));
  const weather = await f.weather().catch(() => null);
  return { events, weather };
}

/** "9:00" from an ISO start (local clock — the box and the calendar share a TZ, MX has no DST). */
function fmtTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return `${d.getHours()}:${String(d.getMinutes()).padStart(2, "0")}`;
}

/** One spoken clause per event. A busy-block (title stamped "Busy" by calendar-service for a
 *  freeBusyReader share) reads as an "ocupado" time range — WHEN without WHAT, mirroring the
 *  busy-only stance. */
function eventClause(e: BriefEvent): string {
  const busy = e.title.trim().toLowerCase() === "busy";
  if (busy) {
    const from = fmtTime(e.start);
    const to = e.end ? fmtTime(e.end) : "";
    return to ? `ocupado de ${from} a ${to}` : `ocupado a las ${from}`;
  }
  if (e.all_day) return `${e.title}, todo el día`;
  const t = fmtTime(e.start);
  return t ? `a las ${t}, ${e.title}` : e.title;
}

/** Join clauses Spanish-style: "a; b; y c". */
function joinClauses(clauses: string[]): string {
  if (clauses.length <= 1) return clauses.join("");
  return `${clauses.slice(0, -1).join("; ")}; y ${clauses[clauses.length - 1]}`;
}

/**
 * The v1 Spanish template (§3.2.3 — phrasing is the only place an LLM is optional, and it's
 * not on this path). `depth`:
 *  - "full"  → enumerate times + titles.
 *  - "count" → count only, no titles — the shared-room privacy degrade (§3.4) and an explicit
 *              per-user preference. Weather isn't private, so it rides along either way.
 * Caller gates on events.length > 0 (zero items → no brief at all).
 */
export function buildBriefText(
  displayName: string,
  facts: BriefFacts,
  depth: "full" | "count",
): string {
  const n = facts.events.length;
  const count = n === 1 ? "una cosa" : `${n} cosas`;
  let agenda: string;
  if (depth === "count") {
    agenda = `Tienes ${count} en tu agenda hoy.`;
  } else {
    agenda = `Hoy tienes ${count} en tu agenda: ${joinClauses(facts.events.map(eventClause))}.`;
  }
  const w = facts.weather;
  const weather =
    w && w.description
      ? ` El clima: ${w.description}, máxima de ${w.max}° y mínima de ${w.min}°.`
      : "";
  return `Buenos días, ${displayName}. ${agenda}${weather}`;
}

// ── default (production) fetchers ────────────────────────────────────────────────────────────

// Box-local like the gateway's calendar module (llm-gateway tools.ts uses the same default).
const CALENDAR_URL = process.env.CALENDAR_URL ?? "http://127.0.0.1:8150";

/** The identity envelope the driver presents: the hub is a trusted internal caller briefing a
 *  roster member it already confidence-gated (household + vision confidence ≥ min), so it
 *  asserts the target's id at full confidence — same trust posture as the gateway forwarding
 *  a login session. */
function envelope(ownerId: string): URLSearchParams {
  return new URLSearchParams({
    owner: ownerId,
    user_id: ownerId,
    via: "system",
    confidence: "1",
  });
}

async function getJSON(url: string): Promise<any> {
  // Node 18+ global fetch (server tsconfig lib doesn't declare it — same reach-through as
  // v-assistant's routeZonedAnnounce).
  const f = (globalThis as any).fetch as undefined | ((u: string) => Promise<any>);
  if (!f) throw new Error("fetch unavailable");
  const res = await f(url);
  if (!res.ok) throw new Error(`calendar-service ${res.status}`);
  return res.json();
}

export const defaultFetchers: BriefFetchers = {
  async calendarSources(ownerId) {
    const body = await getJSON(`${CALENDAR_URL}/sources?${envelope(ownerId)}`);
    return Array.isArray(body?.sources) ? body.sources : [];
  },
  async calendarEvents(ownerId, dateISO) {
    const q = envelope(ownerId);
    q.set("from", dateISO); // `from` alone pins the single calendar day (calendar-service windowFromQuery)
    const body = await getJSON(`${CALENDAR_URL}/events?${q}`);
    return Array.isArray(body?.events) ? body.events : [];
  },
  async weather() {
    // In-process — the hub owns the forecast cache; no reason to loop back through GET /weather.
    // Lazy require keeps module load light for tests that never touch weather.
    const fh = require("../handlers/forecast.handler");
    await fh.updateWeatherData().catch(() => {});
    if (!fh.weatherLastUpdated) {
      log(EVENT_TYPES.info, ["[brief] weather never fetched; briefing without it"]);
      return null;
    }
    return {
      min: Math.round(fh.forecast.minTemp),
      max: Math.round(fh.forecast.maxTemp.value),
      description: fh.forecast.description,
    };
  },
};
