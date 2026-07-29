/**
 * places.budget.spec.ts — the persistent monthly free-tier budget fuse (P-K,
 * docs/plans/PLACES_ADAPTER.md Phase 2b, step 2b.2).
 *
 * Same env-isolation convention as places.handler.spec.ts: `PLACES_MONTHLY_BUDGET` (and every
 * other config env this module reads) is consumed ONCE at module load into a top-level const, so
 * every case here gets a FRESH module instance via `jest.resetModules()` + `jest.isolateModules()`
 * with the env set beforehand — mutating `process.env` after the module has already loaded has no
 * effect on it.
 *
 * NO REAL DB, EVER: every case stubs `placesKv.{get,set}` — the injectable indirection the
 * monthly counter's persistence routes through — with an in-memory fake; production's default
 * (a lazy `require("../db/config.repo")`) is never exercised here. NO LIVE NETWORK either: every
 * case also stubs `placesFetch.{textSearch,placeDetails}`, same convention as
 * places.handler.spec.ts.
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

const ENV_KEYS = [
  'PLACES_API_KEY',
  'HUB_SIM',
  'PLACES_CACHE_STALE_MS',
  'PLACES_NEG_CACHE_MS',
  'PLACES_DAILY_BUDGET',
  'PLACES_MONTHLY_BUDGET',
  'PLACES_BIAS_RADIUS_M',
  'WEATHER_LATITUDE',
  'WEATHER_LONGITUDE',
];

afterEach(() => {
  for (const k of ENV_KEYS) delete process.env[k];
});

// Matches the module's own WEATHER_LATITUDE/LONGITUDE fallback default (places.handler.spec.ts).
const HOME = { lat: 20.5888, lng: -100.3899 };

interface MonthlyBudgetStateLike {
  month: string;
  count: number;
}

/** "YYYY-MM", UTC — matches the module's own (unexported) utcMonthKey(). */
function currentUtcMonth(): string {
  return new Date().toISOString().slice(0, 7);
}

/**
 * An in-memory fake for the injectable `placesKv` indirection, backed by a plain object held
 * OUTSIDE the module under test. `jest.resetModules()` only clears Node's *module* registry, not
 * this closure — which is exactly what case (b) needs to prove a persisted count survives a
 * simulated "restart" (a fresh `require("./places.handler")`).
 */
function fakeKv(store: { value?: MonthlyBudgetStateLike }) {
  return {
    get: jest.fn(() => store.value),
    set: jest.fn((v: MonthlyBudgetStateLike) => {
      store.value = v;
    }),
  };
}

describe('places.handler — monthly budget fuse: exhausted (P-K, case a)', () => {
  it('(a) monthly budget already at cap → resolvePlace returns null, no fetch, no re-charge', async () => {
    const mod = freshModule({ PLACES_API_KEY: 'test-key', PLACES_MONTHLY_BUDGET: '5' });
    const store: { value?: MonthlyBudgetStateLike } = { value: { month: currentUtcMonth(), count: 5 } };
    const kv = fakeKv(store);
    mod.placesKv.get = kv.get;
    mod.placesKv.set = kv.set;
    const textSearch = jest.fn();
    mod.placesFetch.textSearch = textSearch;
    mod.placesFetch.placeDetails = jest.fn();

    const result = await mod.resolvePlace('banco');

    expect(result).toBeNull();
    expect(textSearch).not.toHaveBeenCalled();
    expect(kv.set).not.toHaveBeenCalled(); // already exhausted — never even tries to charge
  });

  it('(a, extra) monthly budget already at cap also blocks a refreshPlace cache-miss, no fetch', async () => {
    const mod = freshModule({ PLACES_API_KEY: 'test-key', PLACES_MONTHLY_BUDGET: '5' });
    const store: { value?: MonthlyBudgetStateLike } = { value: { month: currentUtcMonth(), count: 5 } };
    const kv = fakeKv(store);
    mod.placesKv.get = kv.get;
    mod.placesKv.set = kv.set;
    const placeDetails = jest.fn();
    mod.placesFetch.placeDetails = placeDetails;

    const result = await mod.refreshPlace('place-not-in-cache');

    expect(result).toBeNull();
    expect(placeDetails).not.toHaveBeenCalled();
  });
});

describe('places.handler — monthly budget fuse: persists across a simulated restart (P-K, case b)', () => {
  it('(b) module reload with the same backing store continues the count, not resets it', async () => {
    // The backing store lives HERE, outside any module instance — jest.resetModules() clears
    // Node's module registry, not this closure, so re-wiring a FRESH module to the SAME store
    // proves the count isn't merely a module-level variable that would reset with a restart.
    const store: { value?: MonthlyBudgetStateLike } = {};

    const mod1 = freshModule({ PLACES_API_KEY: 'test-key', PLACES_MONTHLY_BUDGET: '2' });
    const kv1 = fakeKv(store);
    mod1.placesKv.get = kv1.get;
    mod1.placesKv.set = kv1.set;
    mod1.placesFetch.textSearch = jest.fn().mockResolvedValue([]); // outcome irrelevant — only the charge matters
    mod1.placesFetch.placeDetails = jest.fn();

    await mod1.resolvePlace('first-query');
    expect(store.value).toEqual({ month: currentUtcMonth(), count: 1 });

    // Simulate a process restart: a brand-new module instance (fresh top-level state — daily
    // counter, both caches, everything resets) wired to the SAME backing store, mirroring what
    // bench/corpus-reflex.sh's real "restart the hub" case would do to a live deploy.
    const mod2 = freshModule({ PLACES_API_KEY: 'test-key', PLACES_MONTHLY_BUDGET: '2' });
    const kv2 = fakeKv(store); // same `store` object — this IS the persistence
    mod2.placesKv.get = kv2.get;
    mod2.placesKv.set = kv2.set;
    const textSearch2 = jest.fn().mockResolvedValue([]);
    mod2.placesFetch.textSearch = textSearch2;
    mod2.placesFetch.placeDetails = jest.fn();

    await mod2.resolvePlace('second-query');
    expect(textSearch2).toHaveBeenCalledTimes(1); // the charge succeeded — count continued from 1, not reset to 0
    expect(store.value).toEqual({ month: currentUtcMonth(), count: 2 });

    // Now AT the cap (2/2) on the SAME (post-"restart") module instance — a third hop must be
    // refused, proving the restart truly never reset anything.
    const textSearch3 = jest.fn();
    mod2.placesFetch.textSearch = textSearch3;
    const third = await mod2.resolvePlace('third-query');
    expect(third).toBeNull();
    expect(textSearch3).not.toHaveBeenCalled();
  });
});

describe('places.handler — monthly budget fuse: UTC month rollover (P-K, case c)', () => {
  it('(c) a stored count from a past UTC month is treated as fresh, not carried forward', async () => {
    const mod = freshModule({ PLACES_API_KEY: 'test-key', PLACES_MONTHLY_BUDGET: '1' });
    const store: { value?: MonthlyBudgetStateLike } = { value: { month: '2000-01', count: 999 } }; // any month != the real current one
    const kv = fakeKv(store);
    mod.placesKv.get = kv.get;
    mod.placesKv.set = kv.set;
    mod.placesFetch.textSearch = jest.fn().mockResolvedValue([]);
    mod.placesFetch.placeDetails = jest.fn();

    await mod.resolvePlace('some-query');

    // The stale month's count (999, way over any real budget) must NOT block this call, and the
    // persisted state must roll over to THIS month with a fresh count — not "999 + 1".
    expect(mod.placesFetch.textSearch).toHaveBeenCalledTimes(1);
    expect(store.value).toEqual({ month: currentUtcMonth(), count: 1 });
  });
});

describe('places.handler — monthly budget fuse: persistence-error fail-closed (P-K, case d)', () => {
  it('(d) a persistence READ failure → null, no fetch', async () => {
    const mod = freshModule({ PLACES_API_KEY: 'test-key' });
    const get = jest.fn(() => {
      throw new Error('disk error');
    });
    const set = jest.fn();
    mod.placesKv.get = get;
    mod.placesKv.set = set;
    const textSearch = jest.fn();
    mod.placesFetch.textSearch = textSearch;
    mod.placesFetch.placeDetails = jest.fn();

    const result = await mod.resolvePlace('banco');

    expect(result).toBeNull();
    expect(textSearch).not.toHaveBeenCalled();
    expect(set).not.toHaveBeenCalled(); // never reaches the write after a failed read
  });

  it('(d, extra) a persistence WRITE failure also → null, no fetch — P-K says "read/write", not read-only', async () => {
    const mod = freshModule({ PLACES_API_KEY: 'test-key' });
    const get = jest.fn(() => undefined); // read succeeds — fresh/never-charged
    const set = jest.fn(() => {
      throw new Error('disk full');
    });
    mod.placesKv.get = get;
    mod.placesKv.set = set;
    const textSearch = jest.fn();
    mod.placesFetch.textSearch = textSearch;
    mod.placesFetch.placeDetails = jest.fn();

    const result = await mod.resolvePlace('banco');

    expect(result).toBeNull();
    expect(textSearch).not.toHaveBeenCalled(); // the write failed BEFORE the network call, so it must not run
  });
});

describe('places.handler — daily + monthly fuses are both independently live (P-K, case e)', () => {
  it('(e) an exhausted daily budget still blocks a call even with ample monthly headroom', async () => {
    const mod = freshModule({
      PLACES_API_KEY: 'test-key',
      PLACES_DAILY_BUDGET: '1',
      PLACES_MONTHLY_BUDGET: '750',
    });
    const store: { value?: MonthlyBudgetStateLike } = {};
    const kv = fakeKv(store);
    mod.placesKv.get = kv.get;
    mod.placesKv.set = kv.set;
    const textSearch = jest.fn().mockResolvedValue([]); // single-hop (search-only) resolve
    mod.placesFetch.textSearch = textSearch;
    mod.placesFetch.placeDetails = jest.fn();

    // First call spends the ENTIRE daily budget (1) on its one search hop; the monthly counter
    // also advances to 1 (out of a 750 budget — nowhere near exhausted).
    const first = await mod.resolvePlace('first-query');
    expect(first).toBeNull();
    expect(textSearch).toHaveBeenCalledTimes(1);
    expect(store.value).toEqual({ month: currentUtcMonth(), count: 1 });

    // A distinct query (so this exercises the DAILY guard, not the negative-cache guard) with
    // 749/750 monthly headroom remaining — still blocked.
    const second = await mod.resolvePlace('second-query');
    expect(second).toBeNull();
    expect(textSearch).toHaveBeenCalledTimes(1); // no second fetch attempted
    expect(store.value).toEqual({ month: currentUtcMonth(), count: 1 }); // monthly guard never even reached
  });
});

describe('places.handler — monthly budget fuse: mid-resolve exhaustion (P-K, case f — mirrors places.handler.spec.ts g2)', () => {
  it('(f) exactly 1 hop remaining → the search hop charges it → placeDetails is never called', async () => {
    const mod = freshModule({ PLACES_API_KEY: 'test-key', PLACES_MONTHLY_BUDGET: '1' });
    const store: { value?: MonthlyBudgetStateLike } = {};
    const kv = fakeKv(store);
    mod.placesKv.get = kv.get;
    mod.placesKv.set = kv.set;
    const textSearch = jest
      .fn()
      .mockResolvedValue([{ placeId: 'place-1', name: 'Banco Cercano', lat: HOME.lat, lng: HOME.lng }]);
    const placeDetails = jest.fn();
    mod.placesFetch.textSearch = textSearch;
    mod.placesFetch.placeDetails = placeDetails;

    const result = await mod.resolvePlace('banco cercano');

    expect(result).toBeNull();
    expect(textSearch).toHaveBeenCalledTimes(1); // the search hop charged the ONE available hop
    expect(placeDetails).not.toHaveBeenCalled(); // the details hop never gets to run
    expect(store.value).toEqual({ month: currentUtcMonth(), count: 1 }); // exactly one charge recorded, no more
  });
});

describe('places.handler — cache-before-budget holds for the monthly fuse too (P-K, case g)', () => {
  it('(g) a fresh positive-cache refreshPlace hit is served even with the monthly budget exhausted — zero fetches', async () => {
    const mod = freshModule({ PLACES_API_KEY: 'test-key', PLACES_MONTHLY_BUDGET: '1' });
    const get = jest.fn(() => ({ month: currentUtcMonth(), count: 1 })); // already AT the cap
    const set = jest.fn();
    mod.placesKv.get = get;
    mod.placesKv.set = set;
    const placeDetails = jest.fn();
    mod.placesFetch.placeDetails = placeDetails;

    // Seed a FRESH positive-cache entry directly (same technique as places.handler.spec.ts's
    // staleness test) — no network call needed to get it there.
    const fact = {
      name: 'Banco Cercano',
      hours: { closeHour: 17, closedDays: [0, 3, 4, 5, 6] },
      source: 'places-api' as const,
      fetchedAt: new Date().toISOString(),
      placeId: 'place-1',
    };
    mod.placeCache.set('place-1', { fact, fetchedAt: Date.now() });

    const result = await mod.refreshPlace('place-1');

    expect(result).toEqual(fact);
    expect(placeDetails).not.toHaveBeenCalled();
    expect(get).not.toHaveBeenCalled(); // never even consults the monthly counter — cache-before-budget
    expect(set).not.toHaveBeenCalled();
  });
});
