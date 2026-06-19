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
import { devices } from "../handlers/device.handler";
import { sensors } from "../handlers/sensor.handler";
import { EffectsDB } from "./effects-routes";

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

function dayPart(d: Date): "morning" | "afternoon" | "evening" | "night" {
  const h = d.getHours();
  if (h < 6) return "night";
  if (h < 12) return "morning";
  if (h < 18) return "afternoon";
  if (h < 22) return "evening";
  return "night";
}

export function initStateRoutes(app: Express): void {
  app.get("/state", (_req, res) => {
    const now = new Date();
    const deviceSnaps: DeviceSnap[] = devices.map((d) => ({
      id: d.id,
      name: d.name,
      category: d.deviceCategory,
      value: d.value,
      zone: d.zone || undefined,
      unit: d.unit || undefined,
      manual: d.manual,
      operationalRanges: d.operationalRanges || [],
      online: !!d.ip,
      lastPingMs: d.lastPing ? now.getTime() - new Date(d.lastPing).getTime() : -1,
    }));

    const sensorSnaps: SensorSnap[] = sensors.map((s: any) => ({
      id: s.id,
      name: s.name,
      type: s.type,
      sensorType: s.sensorType,
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
      now: now.toISOString(),
      dayPart: dayPart(now),
      hour: now.getHours(),
      zones,
      devices: deviceSnaps,
      sensors: sensorSnaps,
      effects: EffectsDB.get("effects") || [],
    });
  });
}
