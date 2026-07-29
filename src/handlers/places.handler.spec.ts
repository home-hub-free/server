/**
 * places.handler.spec.ts — the Places adapter's guard/cache/budget/reduction/haversine contract
 * (docs/plans/PLACES_ADAPTER.md Phase 1, step 1.4).
 *
 * `PLACES_API_KEY` (and every other config env this module reads) is consumed ONCE at module
 * load into top-level consts (mirrors src/clients/ingestion.ts's `ENABLED`) — so EVERY case here
 * explicitly controls the env and gets a FRESH module instance via `jest.resetModules()` +
 * `jest.isolateModules()`, exactly like `ingestion.hub-sim.spec.ts` (m5). After Phase 0 the real
 * key may exist in `server/.env`, but `dotenv.config()` only runs from `src/index.ts` — never
 * imported here — so this suite is unaffected by it either way; the explicit env control below is
 * the belt (dotenv not loading is the braces).
 *
 * NO LIVE NETWORK: every case stubs `placesFetch.{textSearch,placeDetails}` before calling
 * `resolvePlace`/`refreshPlace`. If a case ever needs a real Google credential or reaches the
 * network, the phase is wrong.
 */

type PlacesModule = typeof import('./places.handler');

/** Fresh module instance with the given env applied before load (undefined ⇒ deleted). */
function freshModule(env: Record<string, string | undefined>): PlacesModule {
  jest.resetModules();
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  let mod!: PlacesModule;
  jest.isolateModules(() => {
    mod = require('./places.handler');
  });
  return mod;
}

// Matches the module's own WEATHER_LATITUDE/LONGITUDE fallback default exactly, so tests that
// don't override the env still land "at home" for the haversine filter.
const HOME = { lat: 20.5888, lng: -100.3899 };

/** A latitude offset (~meters, along a meridian so longitude drift doesn't matter) well outside
 *  any realistic PLACES_BIAS_RADIUS_M. */
function farLat(meters: number): number {
  return HOME.lat + meters / 111320;
}

const ENV_KEYS = [
  'PLACES_API_KEY',
  'HUB_SIM',
  'PLACES_CACHE_STALE_MS',
  'PLACES_NEG_CACHE_MS',
  'PLACES_DAILY_BUDGET',
  'PLACES_BIAS_RADIUS_M',
  'WEATHER_LATITUDE',
  'WEATHER_LONGITUDE',
];

afterEach(() => {
  for (const k of ENV_KEYS) delete process.env[k];
});

describe('places.handler — key/HUB_SIM guard (P-I)', () => {
  it('(a) key unset → resolvePlace returns null, no fetch', async () => {
    const mod = freshModule({ PLACES_API_KEY: undefined, HUB_SIM: undefined });
    const textSearch = jest.fn();
    const placeDetails = jest.fn();
    mod.placesFetch.textSearch = textSearch;
    mod.placesFetch.placeDetails = placeDetails;

    const result = await mod.resolvePlace('banco');

    expect(result).toBeNull();
    expect(textSearch).not.toHaveBeenCalled();
    expect(placeDetails).not.toHaveBeenCalled();
  });

  it('(a) key unset → refreshPlace also returns null, no fetch', async () => {
    const mod = freshModule({ PLACES_API_KEY: undefined, HUB_SIM: undefined });
    const placeDetails = jest.fn();
    mod.placesFetch.placeDetails = placeDetails;

    const result = await mod.refreshPlace('some-place-id');

    expect(result).toBeNull();
    expect(placeDetails).not.toHaveBeenCalled();
  });
});

describe('places.handler — resolvePlace happy path + P-D hours reduction', () => {
  it('(b) single in-radius candidate + details → a correct P-D-reduced PlaceFact', async () => {
    const mod = freshModule({ PLACES_API_KEY: 'test-key' });
    mod.placesFetch.textSearch = jest
      .fn()
      .mockResolvedValue([{ placeId: 'place-1', name: 'Banco Cercano', lat: HOME.lat, lng: HOME.lng }]);
    mod.placesFetch.placeDetails = jest.fn().mockResolvedValue({
      placeId: 'place-1',
      name: 'Banco Cercano',
      location: 'Av. Siempre Viva 123',
      periods: [
        { openDay: 1, openHour: 9, closeDay: 1, closeHour: 18 },
        { openDay: 2, openHour: 9, closeDay: 2, closeHour: 18 },
      ],
    });

    const fact = await mod.resolvePlace('banco cercano');

    expect(fact).toMatchObject({
      name: 'Banco Cercano',
      hours: { closeHour: 18, closedDays: [0, 3, 4, 5, 6] },
      location: 'Av. Siempre Viva 123',
      source: 'places-api',
      placeId: 'place-1',
    });
    expect(typeof fact!.fetchedAt).toBe('string');
    expect(mod.placesFetch.placeDetails).toHaveBeenCalledWith('place-1');
  });

  it('(d) 24-h venue (an open period with no close) → hours omitted (M1.ii)', async () => {
    const mod = freshModule({ PLACES_API_KEY: 'test-key' });
    mod.placesFetch.textSearch = jest
      .fn()
      .mockResolvedValue([{ placeId: 'place-24h', name: 'OXXO Esquina', lat: HOME.lat, lng: HOME.lng }]);
    mod.placesFetch.placeDetails = jest.fn().mockResolvedValue({
      placeId: 'place-24h',
      name: 'OXXO Esquina',
      periods: [{ openDay: 0, openHour: 0 }], // no closeHour anywhere → 24-h
    });

    const fact = await mod.resolvePlace('oxxo');

    expect(fact).not.toBeNull();
    expect(fact!.hours).toBeUndefined();
    expect(fact!.name).toBe('OXXO Esquina');
  });

  it('(e) split-hours day (9-14/16-20) → per-day LAST close wins; cross-day closeHour = MIN across days (M1.i)', async () => {
    const mod = freshModule({ PLACES_API_KEY: 'test-key' });
    mod.placesFetch.textSearch = jest
      .fn()
      .mockResolvedValue([{ placeId: 'place-split', name: 'Farmacia Split', lat: HOME.lat, lng: HOME.lng }]);
    mod.placesFetch.placeDetails = jest.fn().mockResolvedValue({
      placeId: 'place-split',
      name: 'Farmacia Split',
      periods: [
        // Monday siesta split: LAST close (20) must win over the first (14).
        { openDay: 1, openHour: 9, closeDay: 1, closeHour: 14 },
        { openDay: 1, openHour: 16, closeDay: 1, closeHour: 20 },
        // Tuesday closes earlier — proves the CROSS-DAY figure is the MIN (18), not mode/max.
        { openDay: 2, openHour: 9, closeDay: 2, closeHour: 18 },
      ],
    });

    const fact = await mod.resolvePlace('farmacia split');

    expect(fact!.hours).toEqual({ closeHour: 18, closedDays: [0, 3, 4, 5, 6] });
  });
});

describe('places.handler — CF16 ambiguity + negative cache (M3.ii)', () => {
  it('(c) multi-candidate → null + a negative-cache entry; a repeat inside PLACES_NEG_CACHE_MS does not re-fetch', async () => {
    const mod = freshModule({ PLACES_API_KEY: 'test-key', PLACES_NEG_CACHE_MS: '3600000' });
    const textSearch = jest.fn().mockResolvedValue([
      { placeId: 'p1', name: 'Banco A', lat: HOME.lat, lng: HOME.lng },
      { placeId: 'p2', name: 'Banco B', lat: HOME.lat, lng: HOME.lng },
    ]);
    mod.placesFetch.textSearch = textSearch;
    mod.placesFetch.placeDetails = jest.fn();

    const first = await mod.resolvePlace('banco');
    expect(first).toBeNull();
    expect(mod.negativeCache.has('banco')).toBe(true);
    expect(textSearch).toHaveBeenCalledTimes(1);

    const second = await mod.resolvePlace('banco');
    expect(second).toBeNull();
    expect(textSearch).toHaveBeenCalledTimes(1); // served from the negative cache, not re-fetched
    expect(mod.placesFetch.placeDetails).not.toHaveBeenCalled();
  });
});

describe('places.handler — V5 haversine hard-filter runs BEFORE the uniqueness test', () => {
  it('(h) two results, the second OUTSIDE PLACES_BIAS_RADIUS_M → still unique-in-radius → resolves the near one', async () => {
    const mod = freshModule({ PLACES_API_KEY: 'test-key', PLACES_BIAS_RADIUS_M: '3000' });
    mod.placesFetch.textSearch = jest.fn().mockResolvedValue([
      { placeId: 'near', name: 'Banco Cercano', lat: HOME.lat, lng: HOME.lng }, // ~0m from home
      { placeId: 'far', name: 'Banco Lejano', lat: farLat(20000), lng: HOME.lng }, // ~20km away
    ]);
    mod.placesFetch.placeDetails = jest.fn().mockResolvedValue({
      placeId: 'near',
      name: 'Banco Cercano',
      periods: [{ openDay: 1, openHour: 9, closeDay: 1, closeHour: 17 }],
    });

    const fact = await mod.resolvePlace('banco');

    expect(fact).not.toBeNull();
    expect(fact!.placeId).toBe('near');
    expect(mod.placesFetch.placeDetails).toHaveBeenCalledWith('near');
  });
});

describe('places.handler — refreshPlace lazy staleness (P-B)', () => {
  it('(f) a cache hit inside TTL does not re-fetch; a stale entry re-fetches', async () => {
    const mod = freshModule({ PLACES_API_KEY: 'test-key', PLACES_CACHE_STALE_MS: '1000' });
    const placeDetails = jest.fn().mockResolvedValue({
      placeId: 'place-1',
      name: 'Banco Cercano',
      periods: [{ openDay: 1, openHour: 9, closeDay: 1, closeHour: 17 }],
    });
    mod.placesFetch.placeDetails = placeDetails;

    const fresh = await mod.refreshPlace('place-1');
    expect(fresh).not.toBeNull();
    expect(placeDetails).toHaveBeenCalledTimes(1);

    const cachedAgain = await mod.refreshPlace('place-1');
    expect(cachedAgain).toEqual(fresh); // served from cache — no new fetch
    expect(placeDetails).toHaveBeenCalledTimes(1);

    // Force staleness by rewinding the cache entry's fetchedAt past the (tiny, test-only) TTL.
    const entry = mod.placeCache.get('place-1')!;
    mod.placeCache.set('place-1', { fact: entry.fact, fetchedAt: Date.now() - 2000 });

    const refreshed = await mod.refreshPlace('place-1');
    expect(refreshed).not.toBeNull();
    expect(placeDetails).toHaveBeenCalledTimes(2); // stale → re-fetched
  });
});

describe('places.handler — daily call budget (P-H)', () => {
  it('(g) daily budget exhausted → null, no fetch', async () => {
    const mod = freshModule({ PLACES_API_KEY: 'test-key', PLACES_DAILY_BUDGET: '1' });
    const textSearch = jest.fn().mockResolvedValue([]); // outcome doesn't matter — just needs charging
    mod.placesFetch.textSearch = textSearch;
    mod.placesFetch.placeDetails = jest.fn();

    // Spends the entire budget (1) on its own textSearch hop; a distinct query from the next
    // call so this exercises the BUDGET gate, not the negative-cache gate.
    const first = await mod.resolvePlace('first-query');
    expect(first).toBeNull();
    expect(textSearch).toHaveBeenCalledTimes(1);

    const second = await mod.resolvePlace('second-query');
    expect(second).toBeNull();
    expect(textSearch).toHaveBeenCalledTimes(1); // budget exhausted — no second fetch attempted
  });

  it('(g2) budget exhausted BETWEEN the search and details hop of the SAME resolve → no details call', async () => {
    // A resolve that reaches a single in-radius candidate still spends the search hop's charge
    // before it gets there — with a budget of 1, that charge alone exhausts the day, so the
    // details call (the second hop of this SAME resolve) must be skipped too (P-H applies the
    // "over budget -> no call" rule per hop, not just once at entry).
    const mod = freshModule({ PLACES_API_KEY: 'test-key', PLACES_DAILY_BUDGET: '1' });
    const textSearch = jest
      .fn()
      .mockResolvedValue([{ placeId: 'place-1', name: 'Banco Cercano', lat: HOME.lat, lng: HOME.lng }]);
    const placeDetails = jest.fn();
    mod.placesFetch.textSearch = textSearch;
    mod.placesFetch.placeDetails = placeDetails;

    const result = await mod.resolvePlace('banco cercano');

    expect(result).toBeNull();
    expect(textSearch).toHaveBeenCalledTimes(1);
    expect(placeDetails).not.toHaveBeenCalled();
  });
});
