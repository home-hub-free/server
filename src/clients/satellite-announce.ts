import axios from "axios";
import { EVENT_TYPES, log } from "../logger";

/**
 * Zone-targeted announce client — SATELLITE_VOLUME_FEEDBACK's transport
 * (docs/plans/SATELLITE_VOLUME_FEEDBACK.md).
 *
 * POSTs directly to the existing Node-RED `/satellite-announce` handoff
 * (`SATELLITE_AUDIO_URL`) already live for the timer scheduler and the agent's
 * `say`/`ask_user` path (see v-assistant.class.ts `routeZonedAnnounce`). Deliberately
 * NOT `assistant.say()`: that call falls back to the BOX speaker when the transport is
 * unset, which is wrong here — a satellite volume cue must never play on the box.
 *
 * No-op unless `SATELLITE_AUDIO_URL` is set — same default-off posture as the
 * ingestion seam (src/clients/ingestion.ts), which is what keeps tests/sim/gate
 * silent without a separate feature flag. Fire-and-forget: the caller sits inside a
 * device-write path (Node.notify(), via the volume-announce debounce) and must never
 * be blocked or thrown into by a slow/failed delivery — errors are swallowed to one
 * log line.
 */

const ANNOUNCE_TIMEOUT_MS = 5000;

/** POST `{ text, zone }` to the satellite-announce handoff. No-op unless
 * SATELLITE_AUDIO_URL is configured; never throws. */
export function announceToZone(text: string, zone: string): void {
  const url = process.env.SATELLITE_AUDIO_URL;
  if (!url) return;

  axios.post(url, { text, zone }, { timeout: ANNOUNCE_TIMEOUT_MS }).catch((err) => {
    log(EVENT_TYPES.error, [`satellite-announce: POST to ${url} failed: ${err?.message ?? err}`]);
  });
}
