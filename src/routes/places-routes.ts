import { Express } from 'express';
import { resolvePlace, refreshPlace } from '../handlers/places.handler';

/**
 * GET /places/* — hub-side Places adapter surface (docs/plans/PLACES_ADAPTER.md Phase 1).
 * Generalizes the weather seam (weather-routes.ts) to a KEYED source: both routes stay on the
 * open LAN GET surface (ARCHITECTURE_RULES.md §2 "GETs stay open" — a place's hours leak
 * nothing, same posture as `GET /weather`); billing is bounded by the handler's own in-process
 * daily call budget (P-H), not by auth. Both handler entry points already fail-safe to `null`
 * on any error/guard (unset key, HUB_SIM, exhausted budget, network failure) — these routes
 * never throw regardless of live-key state.
 */
export function initPlacesRoutes(app: Express) {
  app.get('/places/resolve', async (request, response) => {
    const q = typeof request.query.q === 'string' ? request.query.q.trim() : '';
    if (!q) {
      response.send({ ok: true, place: null });
      return;
    }
    const place = await resolvePlace(q).catch(() => null);
    response.send({ ok: true, place });
  });

  app.get('/places/:placeId/refresh', async (request, response) => {
    const place = await refreshPlace(request.params.placeId).catch(() => null);
    response.send({ ok: true, place });
  });
}
