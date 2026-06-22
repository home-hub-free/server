import { Express } from "express";
import { EffectsRepo, IEffect } from "../db/effects.repo";
import { NormalizedEffect, normalizeEffect } from "../db/effects-normalize";
import { nodes } from "../handlers/node.handler";

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

export function initEffectsRoutes(app: Express) {
  // Normalized contract — the canonical view consumed by the dashboard + LLM.
  app.get("/get-effects-normalized", (request, response) => {
    response.send(EffectsDB.getNormalized());
  });

  // Legacy denormalized view, kept for edges that still speak `IEffect`.
  app.get("/get-effects", (request, response) => {
    response.send(EffectsDB.get("effects") || []);
  });

  // Replace the full rule list.
  app.post("/set-effects", (request, response) => {
    const { effects } = request.body;
    EffectsDB.setNormalized((effects || []).map(toNormalized));
    response.send(true);
  });

  // Append one rule.
  app.post("/set-effect", (request, response) => {
    const { effect } = request.body;
    EffectsDB.addNormalized(toNormalized(effect));
    response.send(true);
  });
}
