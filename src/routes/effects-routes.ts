import { Express } from "express";
import { EffectsRepo, IEffect } from "../db/effects.repo";
import { NormalizedEffect, normalizeEffect } from "../db/effects-normalize";
import type { Effect } from "../automation/effect.model";
import { flatToEffect, parseDynamicEffect } from "../automation/effect-compat";
import { nodes } from "../handlers/node.handler";
import { requireAuth } from "../auth/middleware";

export const EffectsDB = new EffectsRepo();

// Resolve a node id to its category — only needed to normalize a legacy-shaped
// rule that still arrives without a `set` channel. Falls back to undefined.
const resolveCategory = (id: string): string | undefined =>
  nodes.find((n) => String(n.id) === String(id))?.category;

/** Form fields may arrive JSON-encoded ("true"/"80"); decode when they do. */
function parseMaybe(v: any): any {
  if (typeof v !== "string") return v;
  try {
    return JSON.parse(v);
  } catch {
    return v;
  }
}

/**
 * Accept either the normalized contract (preferred — what the dashboard now
 * posts) or a legacy `IEffect`, and return a stored-shape NormalizedEffect.
 * `when.source` is the discriminator.
 */
function toNormalized(raw: any): NormalizedEffect {
  if (raw?.when?.source) {
    const when =
      raw.when.source === "time"
        ? { source: "time" as const, at: String(raw.when.at ?? "") }
        : {
            source: "sensor" as const,
            nodeId: String(raw.when.nodeId),
            channel: String(raw.when.channel),
            op: raw.when.op,
            value: parseMaybe(raw.when.value),
          };
    return {
      when,
      set: {
        nodeId: String(raw.set.nodeId),
        channel: String(raw.set.channel),
        value: parseMaybe(raw.set.value),
      },
      enabled: raw.enabled !== false,
    };
  }

  // Legacy fallback.
  const legacy: IEffect = {
    when: { id: raw.when.id, type: raw.when.type, is: parseMaybe(raw.when.is) },
    set: { id: raw.set.id, value: parseMaybe(raw.set.value) },
  };
  if (raw.set.valueToSet) legacy.set.valueToSet = raw.set.valueToSet;
  return normalizeEffect(legacy, resolveCategory);
}

/**
 * Accept either shape and return a stored dynamic `Effect`:
 *   - a dynamic `{ trigger, arms }` rule (LLM `create_effect`, or the dashboard once it
 *     speaks the new shape) → parsed natively, preserving multi-arm/conditions;
 *   - a flat `when → set` DTO / legacy `IEffect` → normalized, then lifted to a single-arm
 *     Effect (back-compat for the current dashboard until its UI is updated).
 */
function toEffect(raw: any): Effect {
  if (raw?.trigger && raw?.arms) return parseDynamicEffect(raw, parseMaybe);
  return flatToEffect(toNormalized(raw));
}

// Rule-change hook — invoked after any write so the time-trigger scheduler can re-arm to
// the new earliest boundary (EFFECTS_DYNAMIC §3.2). Wired in index.ts to rearmTimeEffects;
// a settable hook avoids an effects-routes ↔ time-scheduler import cycle.
let onEffectsChanged: () => void = () => {};
export function setOnEffectsChanged(fn: () => void): void {
  onEffectsChanged = fn;
}

export function initEffectsRoutes(app: Express) {
  // Dynamic contract (EFFECTS_DYNAMIC §2) — whole `trigger + arms` rules. The canonical
  // view once the dashboard/LLM speak it natively.
  app.get("/get-effects-dynamic", (request, response) => {
    response.send(EffectsDB.getAll());
  });

  // Normalized flat view — single-arm rules only (multi-arm rules have no flat form).
  app.get("/get-effects-normalized", (request, response) => {
    response.send(EffectsDB.getNormalized());
  });

  // Legacy denormalized view, kept for edges that still speak `IEffect`.
  app.get("/get-effects", (request, response) => {
    response.send(EffectsDB.get("effects") || []);
  });

  // Replace the full rule list. Each item is a dynamic `trigger + arms` rule or a flat
  // `when → set` DTO (back-compat); both are stored as dynamic Effects.
  app.post("/set-effects", requireAuth, (request, response) => {
    const { effects } = request.body;
    EffectsDB.setAll((effects || []).map(toEffect));
    onEffectsChanged();
    response.send(true);
  });

  // Append one rule (dynamic `trigger + arms` or a flat DTO).
  app.post("/set-effect", requireAuth, (request, response) => {
    const { effect } = request.body;
    EffectsDB.add(toEffect(effect));
    onEffectsChanged();
    response.send(true);
  });

  // Delete ONE rule by its id (the symmetric undo of /set-effect — lets the assistant remove an
  // automation by voice instead of the all-or-nothing /set-effects replace). id comes from /state.
  app.post("/delete-effect", requireAuth, (request, response) => {
    const id = Number(request.body?.id);
    if (!Number.isInteger(id)) return response.status(400).send({ ok: false, error: "numeric id required" });
    const removed = EffectsDB.delete(id);
    if (removed) onEffectsChanged();
    response.send({ ok: removed, id });
  });

  // Enable/disable ONE rule by id without deleting it (a reversible "turn this automation off").
  app.post("/set-effect-enabled", requireAuth, (request, response) => {
    const id = Number(request.body?.id);
    const enabled = request.body?.enabled !== false; // default true
    if (!Number.isInteger(id)) return response.status(400).send({ ok: false, error: "numeric id required" });
    const changed = EffectsDB.setEnabled(id, enabled);
    if (changed) onEffectsChanged();
    response.send({ ok: changed, id, enabled });
  });
}
