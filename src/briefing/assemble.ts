/**
 * Brief assembler (docs/BRIEFING_ROUTINE.md §3.2) — DETERMINISTIC content assembly for the
 * morning brief: the person's calendar for today + the cached weather, rendered through a
 * Spanish template. No LLM on this path on purpose — the brief has to be reliable enough to
 * be a trustworthy default (PHILOSOPHY.md §2).
 *
 * Pure over injected fetchers so tests need neither a calendar backend nor Open-Meteo. The
 * default fetchers read the hub's OWN agenda table in-process (LOCAL_AGENDA — the household
 * calendar lives on the box; the Google calendar-service path is retired) and the in-process
 * forecast cache (no loopback HTTP for /weather).
 *
 * The `calendarSources` personal-source gate survives from the Google era (a member with no
 * linked calendar must never be briefed from the family one); with the local agenda every
 * member has the one local calendar, so the default fetcher always reports a personal source
 * and person-targeting happens per row (house-wide rows + rows for this member).
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

/**
 * LOCAL_AGENDA (2026-10-18): the calendar is the hub's own agenda table now — no HTTP, no
 * calendar-service, nothing leaves the box. Every member has the one local calendar (so the
 * personal-source gate always passes); the day's events are the house-wide rows plus the ones
 * targeted at this person (by id or display name).
 */
export const defaultFetchers: BriefFetchers = {
  async calendarSources() {
    return [{ kind: "personal" }];
  },
  async calendarEvents(ownerId, dateISO) {
    // Lazy require: agenda-routes pulls the users repo + auth middleware; keep module load light for tests.
    const { readAgenda } = require("../routes/agenda-routes");
    const { parseLocalDate } = require("../timers/agenda");
    const from: Date | null = parseLocalDate(dateISO);
    if (!from) return [];
    const to = new Date(from);
    to.setHours(23, 59, 59, 999);
    return readAgenda(from, to, ownerId).map((o: any) => ({
      title: o.title,
      start: o.start,
      ...(o.end ? { end: o.end } : {}),
      ...(o.all_day ? { all_day: true } : {}),
      calendar: o.calendar,
    }));
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
