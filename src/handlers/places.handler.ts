import axios from 'axios';
import { EVENT_TYPES, log } from '../logger';

/**
 * Places adapter — generalizes the weather seam (forecast.handler.ts +
 * weather-routes.ts: fetch, cache, serve compact JSON, refresh lazily past a
 * staleness TTL) to a KEYED source (Google Places), spend-bounded and inert by
 * default. See docs/plans/PLACES_ADAPTER.md, pinned decisions P-A/P-B/P-D/P-H/P-I/P-K.
 *
 * OWNERSHIP (CF15): this adapter owns facts about the PLACE (hours, location).
 * It never learns which place is "ours" — that's the memory-service personal
 * registry's job (Phase 2). The two in-memory caches below are cheap+lazy and
 * deliberately NOT durable (a restart cold-starts them harmlessly) — but the
 * monthly spend counter (P-K, below) is the one intentional exception: it
 * PERSISTS across restarts in the hub's own SQLite (`kv_config`), because the
 * entire point of a free-tier fuse is that a deploy/restart must never reset it.
 *
 * GUARD (P-I, mirrors src/clients/ingestion.ts's HUB_SIM/D1 pattern): both
 * `PLACES_API_KEY` and `HUB_SIM` are read ONCE at module load into top-level
 * consts (not re-read per call) — exactly like ingestion.ts's `ENABLED`. A sim
 * hub (bench/corpus-reflex.sh) launches with `PLACES_API_KEY=""` belt-and-braces
 * AND this module's own `HUB_SIM` check backstops it independently: either one
 * alone is sufficient to force every call to a no-network `null`. Tests that
 * need a specific key/HUB_SIM combination MUST `jest.resetModules()` +
 * `jest.isolateModules()` to get a fresh module instance with the env set
 * beforehand (see places.hub-sim.spec.ts / places.handler.spec.ts) — mutating
 * `process.env` after this module has already loaded has no effect on it.
 *
 * SPEND BOUNDS (P-H/P-K/M3): every network hop has its own request timeout (NOT
 * copying forecast.handler.ts's timeout-less axios) and there are NO retries.
 * TWO independent, additive budgets gate every hop — checked, and charged, right
 * after the key/HUB_SIM guard and the free cache-hit paths, before the actual
 * fetch: an in-memory per-UTC-day BURST counter (`PLACES_DAILY_BUDGET`, default
 * 200) that resets on every restart/deploy; and a SQLite-PERSISTED per-UTC-month
 * counter (`PLACES_MONTHLY_BUDGET`, default 750) that a restart/deploy can NEVER
 * reset — sized jointly with the daily fuse against the tightest Google Places
 * SKU quota (Enterprise, 1,000 free calls/month): 750 + one full daily budget
 * (200) of Pacific-billing-month boundary skew = 950 < 1,000 (see
 * docs/plans/PLACES_ADAPTER.md pin P-K; do not raise `PLACES_DAILY_BUDGET` past
 * 200 without re-doing that arithmetic). Either budget being exhausted, OR any
 * monthly-counter persistence read/write failure, returns `null` without
 * attempting the call (fail-CLOSED for billing — CF16 already makes the
 * resulting dark/plain-default behavior safe).
 */

// ── Config (read once at module load — see GUARD note above) ──────────────────────────────────
const PLACES_API_KEY = process.env.PLACES_API_KEY || '';
const KEY_PRESENT = !!PLACES_API_KEY;
// HUB_SIM backstop (P-I): forces every call to a no-network null independent of the key,
// mirroring ingestion.ts's `ENABLED = ... && !process.env.HUB_SIM`.
const SIM = !!process.env.HUB_SIM;

// Home bias point — reuses the SAME env vars as forecast.handler.ts (same defaults: Santiago
// de Querétaro, Vista Hermosa CP 76063) so the two adapters agree on "home" without a second
// pair of coordinates to keep in sync.
const HOME_LAT = Number(process.env.WEATHER_LATITUDE || '20.5888');
const HOME_LNG = Number(process.env.WEATHER_LONGITUDE || '-100.3899');

// P-B: days-scale positive cache, hours-scale negative cache. Both overridable.
const STALE_MS = Number(process.env.PLACES_CACHE_STALE_MS ?? 7 * 24 * 60 * 60 * 1000);
const NEG_CACHE_MS = Number(process.env.PLACES_NEG_CACHE_MS ?? 6 * 60 * 60 * 1000);
// P-H: cheap daily call budget (network hops, not "resolves" — a resolve that reaches the
// details call spends 2). In-memory only — a BURST guard, resets on every restart.
const DAILY_BUDGET = Number(process.env.PLACES_DAILY_BUDGET ?? 200);
// P-K: persistent monthly free-tier fuse (same accounting unit as PLACES_DAILY_BUDGET — one
// network hop). Sized against the tightest Google Places SKU (Enterprise, 1,000 free
// calls/month) JOINTLY with PLACES_DAILY_BUDGET — see the SPEND BOUNDS header note above for
// the boundary-skew arithmetic. Unlike DAILY_BUDGET, this one is backed by durable storage (see
// "Monthly budget fuse" below) so a restart/deploy can never reset it.
const MONTHLY_BUDGET = Number(process.env.PLACES_MONTHLY_BUDGET ?? 750);
// V5: Google's `locationBias` is SOFT (out-of-circle results still come back) — this is the
// HARD haversine cutoff applied before the uniqueness test.
const BIAS_RADIUS_M = Number(process.env.PLACES_BIAS_RADIUS_M ?? 3000);

// Per-call timeout for each outbound Google request. Deliberately NOT copying
// forecast.handler.ts's timeout-less axios (P-H) — a stalled Google call must never hang the
// hub process. This is independent of (and comfortably under) reflex's own overall resolve
// deadline (PLACES_RESOLVE_DEADLINE_MS, Phase 3) — that's a separate budget on the CALLER side.
const REQUEST_TIMEOUT_MS = 5000;

const GOOGLE_TEXT_SEARCH_URL = 'https://places.googleapis.com/v1/places:searchText';
const GOOGLE_PLACE_DETAILS_URL = 'https://places.googleapis.com/v1/places';

// ── Types ───────────────────────────────────────────────────────────────────────────────────
/**
 * The canonical place-fact shape (CF17) — mirrors reflex's `PlaceFact`
 * (reflex/src/decision/venues.ts) VERBATIM field-for-field. The two repos can't share a type
 * import (separate git repos), so this is an independent definition that must stay in lockstep;
 * it round-trips as JSON over `GET /places/*` and reflex's Phase-3 resolver parses it back into
 * its own `PlaceFact`.
 */
export interface PlaceFact {
  name: string;
  hours?: { closeHour: number; closedDays: number[] };
  location?: string;
  source: 'places-api' | 'personal-registry' | 'calendar';
  fetchedAt: string;
  placeId?: string;
}

/** A text-search hit, reduced to just what the haversine filter + uniqueness test need. */
export interface PlaceCandidate {
  placeId: string;
  name: string;
  lat: number;
  lng: number;
}

/** One Google opening-hours period, weekday-indexed 0=Sun..6=Sat (matches `PlaceFact.hours`). A
 *  period with no `closeHour` means "open with no close that day" (24-h venue) — Google's own
 *  representation for OXXO-style locations. */
export interface PlaceOpeningPeriod {
  openDay: number;
  openHour: number;
  closeDay?: number;
  closeHour?: number;
}

export interface PlaceDetailsResult {
  placeId: string;
  name: string;
  location?: string;
  /** null when Google reports no known hours at all for this place. */
  periods: PlaceOpeningPeriod[] | null;
}

// ── Caches (exported — P-B; tests seed/inspect these directly) ────────────────────────────────
/** Positive cache: a resolved place's fact, keyed by `placeId`. `fetchedAt` (epoch ms) is the
 *  staleness baseline `refreshPlace` compares against `PLACES_CACHE_STALE_MS`. */
export const placeCache = new Map<string, { fact: PlaceFact; fetchedAt: number }>();
/** Negative/ambiguous-result cache, keyed by the raw query string. Value is the absolute expiry
 *  (epoch ms) — CF16: a multi-result alias like "banco" must not re-run a paid search on every
 *  venue reminder inside `PLACES_NEG_CACHE_MS`. */
export const negativeCache = new Map<string, number>();

// ── Daily call budget (P-H) ─────────────────────────────────────────────────────────────────
let budgetDay = '';
let budgetCount = 0;

function utcDayKey(d: Date = new Date()): string {
  return d.toISOString().slice(0, 10); // "YYYY-MM-DD", UTC
}

function rollBudgetDay(): void {
  const today = utcDayKey();
  if (today !== budgetDay) {
    budgetDay = today;
    budgetCount = 0;
  }
}

function isBudgetExhausted(): boolean {
  rollBudgetDay();
  return budgetCount >= DAILY_BUDGET;
}

/** Charge one network hop against today's budget. Called right before each real fetch — both a
 *  text-search and a details call each cost one, so a full cold-start resolve spends 2. */
function chargeCall(): void {
  rollBudgetDay();
  budgetCount++;
}

// ── Monthly budget fuse (P-K) ───────────────────────────────────────────────────────────────
/** Persisted shape of the monthly counter — `{month:"YYYY-MM", count}`, UTC. The ONLY state
 *  this module keeps durable across restarts (everything else — both caches, the daily counter
 *  above — is deliberately in-memory/lazy; see the OWNERSHIP header note). */
export interface MonthlyBudgetState {
  month: string;
  count: number;
}

const MONTHLY_BUDGET_KV_KEY = 'placesMonthlyBudget';

/**
 * Lazily-constructed singleton reached via a `require("../db/config.repo")` DEFERRED to the
 * first actual charge — never a top-level import of `../db/config.repo` itself, and especially
 * never of the `../db` barrel (`../db/index.ts` also top-level-imports `./migrate`, which would
 * drag migrate/effects/logger into every `jest.isolateModules()` registry this handler's specs
 * spin up — reviewer MINOR-3). Mirrors `src/briefing/driver.ts`'s `configRepo`/`LATCH_KEY`
 * briefingLatch pattern (a dedicated `kv_config` key holding one JSON blob) and
 * `src/briefing/assemble.ts`'s `weather()` fetcher (the existing precedent for a lazy
 * in-function `require` of a sibling module) — but memoized after the first construction, since
 * "at first charge" is a ONE-TIME event, not a per-call one.
 */
let configRepo: { get(key: string): any; set(key: string, value: any): void } | null = null;
function lazyConfigRepo() {
  if (!configRepo) {
    const { ConfigRepo } = require('../db/config.repo');
    configRepo = new ConfigRepo();
  }
  return configRepo;
}

/**
 * Monomorphic injection point for the monthly counter's persistence, mirroring `placesFetch`'s
 * convention — specs reassign `.get`/`.set` to an in-memory fake so NO case in this module's
 * suite ever touches a real DB. Production's default implementation routes through the lazy
 * `ConfigRepo` singleton above.
 */
export const placesKv = {
  get: (): MonthlyBudgetState | undefined => lazyConfigRepo().get(MONTHLY_BUDGET_KV_KEY),
  set: (value: MonthlyBudgetState): void => lazyConfigRepo().set(MONTHLY_BUDGET_KV_KEY, value),
};

function utcMonthKey(d: Date = new Date()): string {
  return d.toISOString().slice(0, 7); // "YYYY-MM", UTC
}

/**
 * Check-and-charge the persistent monthly budget as ONE atomic step (no `await` runs between
 * the read and the write, so nothing else in this single-threaded process can interleave):
 * reads the current count — a stored month different from `utcMonthKey()` (including "never
 * charged before", i.e. `undefined`) is treated as a fresh month, count 0 — and if still under
 * `MONTHLY_BUDGET`, increments and persists before returning `true`. Returns `false` — the
 * caller MUST treat this as "no call" — when the budget is already at/over the cap, OR when
 * EITHER the read OR the write throws (fail-CLOSED for billing, P-K: an unreadable/unwritable
 * counter must never be interpreted as "budget available"; CF16 already makes the resulting
 * dark/plain-default behavior safe).
 */
function chargeMonthlyBudget(): boolean {
  const month = utcMonthKey();
  let state: MonthlyBudgetState | undefined;
  try {
    state = placesKv.get();
  } catch (err) {
    log(EVENT_TYPES.error, [`places: monthly budget read failed, fail-closed: ${err}`]);
    return false;
  }
  const count = state && state.month === month ? state.count : 0;
  if (count >= MONTHLY_BUDGET) return false;
  try {
    placesKv.set({ month, count: count + 1 });
  } catch (err) {
    log(EVENT_TYPES.error, [`places: monthly budget write failed, fail-closed: ${err}`]);
    return false;
  }
  return true;
}

// ── Haversine (V5) ──────────────────────────────────────────────────────────────────────────
const EARTH_RADIUS_M = 6371000;

/** Great-circle distance in meters. Pure — exported for reuse/testing. */
export function haversineMeters(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const toRad = (deg: number) => (deg * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return EARTH_RADIUS_M * c;
}

// ── P-D: hours reduction — coarse, conservative, crash-safe ────────────────────────────────────
/**
 * Reduces Google's rich per-day opening periods to the coarse `{closeHour, closedDays}` shape.
 * Returns `undefined` (omit `hours` entirely — no shift, dark) whenever:
 *  - there is no period data at all;
 *  - ANY period (any day) has no close (a 24-h venue like OXXO / a 24-h farmacia — would
 *    otherwise yield NaN for that day's effective close, M1.ii);
 *  - the parsed open-day count is 0;
 *  - the final reduction is a non-integer or out of the 0-23 range.
 * Per-day effective close = that weekday's LAST close hour (resolves siesta/split-hours: a
 * 9-14 / 16-20 day closes at 20, M1.i). Cross-day `closeHour` = the MIN of the per-day effective
 * closes across open days (conservative single number; `chooseReminderDefault`'s 08:00 floor
 * absorbs the over-conservatism) — NOT the mode. Bucketing is by `openDay` only (an
 * overnight-crossing period's `closeDay` is not consulted) — a documented coarseness, not a bug:
 * P-D anchors "that weekday's LAST close hour" to the OPEN day.
 */
export function reduceHours(
  periods: PlaceOpeningPeriod[] | null | undefined,
): { closeHour: number; closedDays: number[] } | undefined {
  if (!periods || periods.length === 0) return undefined;

  // Any period anywhere with no close → the whole place is 24-h somewhere → omit entirely.
  if (periods.some((p) => p.closeHour === undefined || p.closeHour === null)) return undefined;

  const perDayClose = new Map<number, number>();
  for (const p of periods) {
    if (!Number.isInteger(p.openDay) || p.openDay < 0 || p.openDay > 6) continue; // defensive
    const close = p.closeHour as number;
    const prev = perDayClose.get(p.openDay);
    if (prev === undefined || close > prev) perDayClose.set(p.openDay, close);
  }

  const openDays = [...perDayClose.keys()];
  if (openDays.length === 0) return undefined;

  const closedDays: number[] = [];
  for (let d = 0; d <= 6; d++) {
    if (!perDayClose.has(d)) closedDays.push(d);
  }

  const closeHour = Math.min(...openDays.map((d) => perDayClose.get(d) as number));
  if (!Number.isInteger(closeHour) || closeHour < 0 || closeHour > 23) return undefined;

  return { closeHour, closedDays };
}

// ── Injectable fetch indirection (specs stub this — NO live network in tests) ─────────────────
async function textSearch(query: string): Promise<PlaceCandidate[]> {
  const response = await axios.post(
    GOOGLE_TEXT_SEARCH_URL,
    {
      textQuery: query,
      locationBias: {
        circle: {
          center: { latitude: HOME_LAT, longitude: HOME_LNG },
          radius: BIAS_RADIUS_M,
        },
      },
    },
    {
      timeout: REQUEST_TIMEOUT_MS,
      headers: {
        'Content-Type': 'application/json',
        'X-Goog-Api-Key': PLACES_API_KEY,
        'X-Goog-FieldMask': 'places.id,places.displayName,places.location,places.formattedAddress',
      },
    },
  );
  const places = (response.data && response.data.places) || [];
  return places
    .filter((p: any) => p && p.id && p.location)
    .map((p: any) => ({
      placeId: p.id,
      name: (p.displayName && p.displayName.text) || '',
      lat: p.location.latitude,
      lng: p.location.longitude,
    }));
}

async function placeDetails(placeId: string): Promise<PlaceDetailsResult | null> {
  const response = await axios.get(
    `${GOOGLE_PLACE_DETAILS_URL}/${encodeURIComponent(placeId)}`,
    {
      timeout: REQUEST_TIMEOUT_MS,
      headers: {
        'X-Goog-Api-Key': PLACES_API_KEY,
        'X-Goog-FieldMask': 'id,displayName,regularOpeningHours,formattedAddress',
      },
    },
  );
  const data = response.data;
  if (!data) return null;
  const rawPeriods = data.regularOpeningHours && data.regularOpeningHours.periods;
  const periods: PlaceOpeningPeriod[] | null = Array.isArray(rawPeriods)
    ? rawPeriods.map((p: any) => ({
        openDay: p.open && p.open.day,
        openHour: p.open && p.open.hour,
        closeDay: p.close && p.close.day,
        closeHour: p.close && p.close.hour,
      }))
    : null;
  return {
    placeId: data.id || placeId,
    name: (data.displayName && data.displayName.text) || '',
    location: data.formattedAddress,
    periods,
  };
}

/** Monomorphic injection point (mirrors reflex's `venueErrandModelCall` convention) — specs
 *  reassign these two properties to stub the network hermetically. Production code (this
 *  module) never calls `axios` directly outside these two functions. */
export const placesFetch = { textSearch, placeDetails };

// ── Public entry points ─────────────────────────────────────────────────────────────────────
/**
 * Cold-start resolve: given free-text (a venue alias like "banco"), text-search near home,
 * hard-filter to `PLACES_BIAS_RADIUS_M` (V5 — Google's `locationBias` is soft), and require
 * EXACTLY one in-radius candidate before spending a details call. Zero/multiple/out-of-radius
 * all abstain (CF16) and negative-cache the query so a repeated ambiguous alias doesn't re-pay
 * for a search inside `PLACES_NEG_CACHE_MS`. Guard (P-I): unset key OR `HUB_SIM` OR an exhausted
 * daily budget short-circuits to `null` with NO network call at all — checked before the
 * (free) negative-cache read even runs its lookup logic, so the fail-safe is unconditional.
 * The persistent monthly fuse (P-K) is checked — and charged — right after the daily one, for
 * BOTH hops (the search below and, again, the details call further down); either budget being
 * exhausted, or a monthly-counter persistence failure, is the same "no call" outcome.
 */
export async function resolvePlace(query: string): Promise<PlaceFact | null> {
  if (!KEY_PRESENT || SIM) return null;

  const negExpiry = negativeCache.get(query);
  if (negExpiry !== undefined && Date.now() < negExpiry) return null;

  if (isBudgetExhausted()) return null;
  if (!chargeMonthlyBudget()) return null; // P-K — after the daily guard, before the hop

  let candidates: PlaceCandidate[];
  try {
    chargeCall();
    candidates = await placesFetch.textSearch(query);
  } catch (err) {
    log(EVENT_TYPES.error, [`places: textSearch(${query}) failed: ${err}`]);
    return null;
  }

  const inRadius = (candidates || []).filter(
    (c) => haversineMeters(HOME_LAT, HOME_LNG, c.lat, c.lng) <= BIAS_RADIUS_M,
  );

  if (inRadius.length !== 1) {
    // Zero, multiple, or all-out-of-radius — CF16 abstain. Cache the query itself (not a
    // placeId — there isn't one yet) so a repeated ambiguous alias is cheap.
    negativeCache.set(query, Date.now() + NEG_CACHE_MS);
    return null;
  }

  const candidate = inRadius[0];

  // Budget may have been exhausted BY the search call just above (a full resolve spends 2) —
  // re-check before the second network hop so an over-budget day never spends a details call
  // either, matching P-H's "over budget -> return null without a call" for EVERY hop, not just
  // the first. Same "every hop, not just the first" rule applies to the monthly fuse (P-K) —
  // charging it again here is what the (f) mid-resolve-exhaustion spec case proves.
  if (isBudgetExhausted()) return null;
  if (!chargeMonthlyBudget()) return null;

  let details: PlaceDetailsResult | null;
  try {
    chargeCall();
    details = await placesFetch.placeDetails(candidate.placeId);
  } catch (err) {
    log(EVENT_TYPES.error, [`places: placeDetails(${candidate.placeId}) failed: ${err}`]);
    return null;
  }
  if (!details) return null;

  const fact: PlaceFact = {
    name: details.name || candidate.name,
    hours: reduceHours(details.periods),
    location: details.location,
    source: 'places-api',
    fetchedAt: new Date().toISOString(),
    placeId: candidate.placeId,
  };

  placeCache.set(candidate.placeId, { fact, fetchedAt: Date.now() });
  return fact;
}

/**
 * Read a KNOWN place's current hours — details-only (no search). Lazy refresh (P-B): a cache
 * hit fresher than `PLACES_CACHE_STALE_MS` is returned WITHOUT any network call (free, so it is
 * never blocked by EITHER budget — P-H's daily counter or P-K's persistent monthly one); only a
 * stale-or-missing entry spends a details call, gated by both in sequence.
 * Guard (P-I) applies first, same as `resolvePlace`.
 */
export async function refreshPlace(placeId: string): Promise<PlaceFact | null> {
  if (!KEY_PRESENT || SIM) return null;

  const cached = placeCache.get(placeId);
  if (cached && Date.now() - cached.fetchedAt < STALE_MS) {
    return cached.fact; // free — never gated by EITHER budget (P-B/P-K cache-before-budget)
  }

  if (isBudgetExhausted()) return null;
  if (!chargeMonthlyBudget()) return null;

  let details: PlaceDetailsResult | null;
  try {
    chargeCall();
    details = await placesFetch.placeDetails(placeId);
  } catch (err) {
    log(EVENT_TYPES.error, [`places: refreshPlace(${placeId}) failed: ${err}`]);
    return null;
  }
  if (!details) return null;

  const fact: PlaceFact = {
    name: details.name,
    hours: reduceHours(details.periods),
    location: details.location,
    source: 'places-api',
    fetchedAt: new Date().toISOString(),
    placeId,
  };

  placeCache.set(placeId, { fact, fetchedAt: Date.now() });
  return fact;
}
