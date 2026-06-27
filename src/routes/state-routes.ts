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
      effects: EffectsDB.get("effects") || [],
      weather: weatherSnap(),
    });
  });
}
