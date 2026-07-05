/**
 * GET /state — single-shot home snapshot for the LLM agent runtime.
 *
 * The agent (in llm-gateway / a separate runtime) pulls this every time it's
 * about to think: it grounds the LLM in the live, authoritative control-plane
 * truth (devices, sensors, automations, time-of-day) without making the LLM
 * stitch together /get-devices + /get-sensors + /get-effects + a clock.
 *
 * Keep the payload compact and structured — every byte ends up in the prompt.
 */
import type { Express } from "express";
import { deviceNodes, sensorNodes } from "../handlers/node.handler";
import { EffectsDB } from "./effects-routes";
import { forecast, astro, weatherLastUpdated } from "../handlers/forecast.handler";
import { recordAmbient, ambientByZone } from "../ambient/ambient.store";
import { recordVision } from "../ambient/vision.store";
import { presenceByZone, liveRooms } from "../ambient/live-rooms";

interface DeviceSnap {
  id: string;
  name: string;
  category: string;
  value: any;
  zone?: string;
  unit?: string;
  manual: boolean;
  operationalRanges: string[];
  online: boolean;
  lastPingMs: number;
}

interface SensorSnap {
  id: string;
  name: string;
  type: string;
  sensorType: string;
  value: any;
  zone?: string;
  unit?: string;
}

// Local ISO-8601 with offset (e.g. 2026-06-22T15:56:15-06:00). Unlike Date.toISOString() (always
// UTC "Z"), this matches dayPart/hour — which are local (getHours) — so the agent never sees a
// UTC timestamp paired with a local hour.
function localISO(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  const tz = d.getTimezoneOffset(); // minutes; positive when local is behind UTC (CST → 360)
  const sign = tz <= 0 ? "+" : "-";
  const abs = Math.abs(tz);
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}` +
    `T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}` +
    `${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`
  );
}

function dayPart(d: Date): "morning" | "afternoon" | "evening" | "night" {
  const h = d.getHours();
  if (h < 6) return "night";
  if (h < 12) return "morning";
  if (h < 18) return "afternoon";
  if (h < 22) return "evening";
  return "night";
}

// Compact outdoor-weather block for the agent prompt. Returns null until the first
// successful Open-Meteo fetch (API unreachable at boot) so the agent never reasons over
// the zero-filled default forecast. hourlyTemperatures and moon times are intentionally
// dropped — too verbose / low-signal for the prompt.
function weatherSnap() {
  if (!weatherLastUpdated) return null;
  return {
    unit: "C",
    currentTemp: forecast.currentTemp,
    minTemp: forecast.minTemp,
    maxTemp: forecast.maxTemp.value,
    maxTempHour: forecast.maxTemp.hour,
    dayAvgTemp: forecast.dayAvgTemp,
    humidityAvg: forecast.humidityAvg,
    description: forecast.description,
    rising: forecast.isRising,
    sunrise: astro.sunrise ? localISO(astro.sunrise) : null,
    sunset: astro.sunset ? localISO(astro.sunset) : null,
    // Multi-day outlook (today + upcoming) so the agent can answer "weather for the week" from
    // local state. Compact per-day shape (date + low/high + description); index 0 is today.
    daily: (forecast.dailyForecast || []).map((d) => ({
      date: d.date,
      min: d.minTemp,
      max: d.maxTemp,
      description: d.description,
    })),
    updatedAt: localISO(weatherLastUpdated),
  };
}

export function initStateRoutes(app: Express): void {
  app.get("/state", (_req, res) => {
    const now = new Date();
    const deviceSnaps: DeviceSnap[] = deviceNodes().map((d) => ({
      id: d.id,
      name: d.name,
      category: d.category,
      value: d.value,
      zone: d.zone || undefined,
      unit: d.unit || undefined,
      manual: d.manual,
      operationalRanges: d.operationalRanges || [],
      online: !!d.ip,
      lastPingMs: d.lastPing ? now.getTime() - new Date(d.lastPing).getTime() : -1,
    }));

    const sensorSnaps: SensorSnap[] = sensorNodes().map((s) => ({
      id: s.id,
      name: s.name,
      type: s.type,
      sensorType: s.category,
      value: s.value,
      zone: s.zone || undefined,
      unit: s.unit || undefined,
    }));

    const zones = Array.from(
      new Set(
        [...deviceSnaps, ...sensorSnaps]
          .map((x) => x.zone)
          .filter((z): z is string => !!z),
      ),
    ).sort();

    res.json({
      ok: true,
      now: localISO(now),
      dayPart: dayPart(now),
      hour: now.getHours(),
      zones,
      devices: deviceSnaps,
      sensors: sensorSnaps,
      // Dynamic shape WITH each rule's id + enabled flag, so the agent can name one to disable/delete
      // (manage_effect). Replaces the old flat, id-less view — /state is agent-only, so no other
      // consumer depends on the legacy shape (the dashboard uses /get-effects*).
      effects: EffectsDB.summaries(),
      weather: weatherSnap(),
      // Per-zone ambient perception digest (satellite volume/activity). Fresh zones only (TTL-pruned).
      // The agent uses it for dynamic, zone-matched quiet-hours. Empty {} until a producer pings
      // POST /ambient. Kept untouched (the proactivity quiet-gate reads it) — `rooms` below is additive.
      ambient: ambientByZone(),
      // FUSED per-zone world-model (PERCEPTION_TO_AGENT_PLAN §3.1): camera roster (who/how-many) + ambient
      // (activity/noise) + PIR (fallback occupancy), reconciled into one digest the agent renders into
      // "Who's around". Only zones with a fresh source appear. See ambient/room-digest.ts.
      rooms: liveRooms(now.getTime()),
    });
  });

  // Producer seam for ambient perception: the voice satellites (room volume/noise) and, later, the
  // camera world-model (occupancy/activity) POST a per-zone digest here. Ephemeral + best-effort (TTL,
  // never persisted) — a reporting route like the ESP fleet's, so it stays open (no auth). The agent
  // reads the aggregate back inside GET /state. See ambient.store.ts.
  app.post("/ambient", (req, res) => {
    const digest = recordAmbient(req.body ?? {});
    if (!digest) {
      res.status(400).json({ ok: false, error: "ambient ping requires a non-empty 'zone'" });
      return;
    }
    res.json({ ok: true, ambient: digest });
  });

  // Per-zone occupancy derived from the presence/motion sensors — a clean "who/what is where" the
  // agent can read directly instead of inferring it from raw sensor rows. A zone is `occupied` when
  // ANY of its presence/motion sensors reads true. Sensors with no zone are grouped under "(unzoned)".
  app.get("/presence", (req, res) => {
    const zoneParam = typeof req.query.zone === "string" ? req.query.zone.trim().toLowerCase() : undefined;
    const zones = [...presenceByZone().values()]
      .filter((z) => !zoneParam || z.zone.toLowerCase() === zoneParam)
      .sort((a, b) => a.zone.localeCompare(b.zone));
    res.json({ ok: true, anyoneHome: zones.some((z) => z.occupied), zones });
  });

  // Producer seam for the camera world-model: the vision-service POSTs a per-zone occupancy+identity
  // digest here on every salient change (PERCEPTION_TO_AGENT_PLAN §3.1). Like /ambient it's ephemeral +
  // best-effort (TTL, never persisted) and stays OPEN (a reporting route, like the ESP fleet) — only
  // resolved identity crosses, never embeddings. The hub FUSES it into GET /state `rooms`. See
  // ambient/vision.store.ts.
  app.post("/perception", (req, res) => {
    const digest = recordVision(req.body ?? {});
    if (!digest) {
      res.status(400).json({ ok: false, error: "perception push requires a non-empty 'zone'" });
      return;
    }
    res.json({ ok: true, vision: digest });
  });

  // Fused per-zone "who's around" world-model — the agent's `who_is_present` tool reads THIS instead of
  // raw PIR, so it can answer "Juan y alguien que no reconozco", not just "occupied" (PERCEPTION_TO_AGENT
  // _PLAN §3.1/Phase 2). Camera roster (who/how-many) ⊕ ambient (activity/noise) ⊕ PIR (fallback
  // occupancy). Degrades to PIR-only occupancy when no camera covers a zone. Pass ?zone= for one room
  // (then `occupied` is a definitive boolean — an absent zone means nobody there).
  app.get("/rooms", (req, res) => {
    const zoneParam = typeof req.query.zone === "string" ? req.query.zone.trim() : undefined;
    const fused = liveRooms(Date.now());
    let rooms = Object.values(fused).sort((a, b) => a.zone.localeCompare(b.zone));
    if (zoneParam) {
      const zl = zoneParam.toLowerCase();
      rooms = rooms.filter((r) => r.zone.toLowerCase() === zl);
    }
    const people = rooms.flatMap((r) => (r.people ?? []).map((p) => ({ zone: r.zone, ...p })));
    const out: Record<string, unknown> = {
      ok: true,
      anyoneHome: rooms.some((r) => r.occupied),
      rooms,
      people,
    };
    if (zoneParam) out.occupied = rooms.some((r) => r.occupied); // definitive answer for one room
    res.json(out);
  });
}
