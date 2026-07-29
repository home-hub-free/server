/**
 * places.hub-sim.spec.ts — HUB_SIM hermeticity backstop for the Places adapter (B1/P-I),
 * modeled directly on src/clients/ingestion.hub-sim.spec.ts.
 *
 * The reflex corpus sim launches a HUB_SIM=1 hub from the REAL server/ dir, so it inherits
 * whatever `server/.env` holds — including, after Phase 0, a real `PLACES_API_KEY`. This is the
 * identical trap ingestion.ts's D1 fix closed for INGESTION_ENABLED: HUB_SIM alone must be
 * sufficient to force every Places call to a no-network `null`, independent of the key. The
 * corpus/bench launch line ALSO passes `PLACES_API_KEY=""` (belt-and-braces, step 3.5) — this
 * spec is the regression guard for the handler's OWN backstop, standing on its own even if that
 * launch-line override were ever dropped.
 */

interface PlacesModule {
  resolvePlace: (query: string) => Promise<any>;
  refreshPlace: (placeId: string) => Promise<any>;
  placesFetch: { textSearch: (...args: any[]) => Promise<any>; placeDetails: (...args: any[]) => Promise<any> };
}

function loadFresh(): PlacesModule {
  let mod!: PlacesModule;
  jest.isolateModules(() => {
    mod = require('./places.handler');
  });
  return mod;
}

describe('places adapter — HUB_SIM backstop', () => {
  afterEach(() => {
    delete process.env.PLACES_API_KEY;
    delete process.env.HUB_SIM;
  });

  it('PLACES_API_KEY set + HUB_SIM=1 never calls the network and returns null', async () => {
    jest.resetModules();
    process.env.PLACES_API_KEY = 'a-real-looking-key';
    process.env.HUB_SIM = '1';
    const mod = loadFresh();
    const textSearch = jest.fn();
    const placeDetails = jest.fn();
    mod.placesFetch.textSearch = textSearch;
    mod.placesFetch.placeDetails = placeDetails;

    const resolved = await mod.resolvePlace('banco');
    const refreshed = await mod.refreshPlace('some-place-id');

    expect(resolved).toBeNull();
    expect(refreshed).toBeNull();
    expect(textSearch).not.toHaveBeenCalled();
    expect(placeDetails).not.toHaveBeenCalled();
  });

  it('control case: PLACES_API_KEY set WITHOUT HUB_SIM DOES call the stub (the harness works)', async () => {
    jest.resetModules();
    process.env.PLACES_API_KEY = 'a-real-looking-key';
    delete process.env.HUB_SIM;
    const mod = loadFresh();
    const textSearch = jest.fn().mockResolvedValue([]);
    mod.placesFetch.textSearch = textSearch;
    mod.placesFetch.placeDetails = jest.fn();

    await mod.resolvePlace('banco');

    expect(textSearch).toHaveBeenCalledTimes(1);
  });
});
