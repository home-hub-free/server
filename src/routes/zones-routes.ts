import { Express } from "express";
import { VAssistantDB } from "../v-assistant/v-assistant.class";
import { nodes } from "../handlers/node.handler";
import { requireAuth } from "../auth/middleware";

/**
 * Zones registry — the house's canonical room list, the typo-free source for the
 * dashboard's zone dropdowns. Stored as a JSON string[] in kv_config (alongside
 * houseData/screenData); the list is purely a control-plane convenience, so it
 * lives with the hub's other local config rather than the memory/LLM layer.
 *
 * `GET /get-zones` returns the stored list UNIONED with any zone currently assigned
 * to a node, so existing assignments seed the registry (a zone in use is never
 * missing from the list) and the dropdown is never empty on first boot.
 */
const ZONES_KEY = "zones";

function resolveZones(): string[] {
  const stored: string[] = VAssistantDB.get(ZONES_KEY) || [];
  const inUse = nodes.map((n) => n.zone).filter((z): z is string => !!z);
  return Array.from(new Set([...stored, ...inUse])).sort((a, b) =>
    a.localeCompare(b),
  );
}

/** Trim, drop blanks, de-dupe case-insensitively (keeping the first spelling). */
function normalizeZones(incoming: unknown): string[] {
  const list = Array.isArray(incoming) ? incoming : [];
  const seen = new Set<string>();
  const zones: string[] = [];
  for (const raw of list) {
    const z = String(raw).trim();
    if (!z) continue;
    const key = z.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    zones.push(z);
  }
  return zones.sort((a, b) => a.localeCompare(b));
}

export function initZonesRoutes(app: Express) {
  app.get("/get-zones", (_request, response) => {
    response.json(resolveZones());
  });

  // Replace the whole registry (mirrors /set-effects). Returns the normalized list
  // so the client can adopt exactly what was stored.
  app.post("/set-zones", requireAuth, (request, response) => {
    const zones = normalizeZones(request.body?.zones);
    VAssistantDB.set(ZONES_KEY, zones);
    response.json(zones);
  });
}
