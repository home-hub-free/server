import { Express } from 'express';
import {
  forecast,
  updateWeatherData,
  weatherLastUpdated,
} from '../handlers/forecast.handler';

// Refetch from Open-Meteo only when the cached forecast is older than this. The
// daily-events scheduler already refreshes a few times a day; this lazy top-up keeps
// the dashboard hero current without hammering the (keyless, rate-limited) API on
// every page load.
const STALE_MS = 15 * 60 * 1000;

/**
 * GET /weather — compact, glanceable forecast JSON for the dashboard hero (and any
 * other lightweight consumer). The hub already pulls Open-Meteo for the VAssistant /
 * agent; this just exposes the cached numbers in a dashboard-shaped envelope plus the
 * raw WMO `code` (so the client picks its own icon). Open: a forecast leaks nothing,
 * and reporting/read routes stay unauthenticated like the rest of the GET surface.
 */
export function initWeatherRoutes(app: Express) {
  app.get('/weather', async (_request, response) => {
    const age = weatherLastUpdated ? Date.now() - weatherLastUpdated.getTime() : Infinity;
    if (age > STALE_MS) {
      // On failure keep serving the last good cache (updatedAt tells the client how
      // stale it is); only a never-fetched API yields a null reading below.
      await updateWeatherData().catch(() => {});
    }

    response.send({
      currentTemp: Math.round(forecast.currentTemp),
      minTemp: Math.round(forecast.minTemp),
      maxTemp: Math.round(forecast.maxTemp.value),
      code: forecast.weatherCode,
      description: forecast.description,
      isRising: forecast.isRising,
      // null when Open-Meteo has never been reached — the client gates on this to show
      // "—" rather than a misleading 0°.
      updatedAt: weatherLastUpdated ? weatherLastUpdated.toISOString() : null,
    });
  });
}
