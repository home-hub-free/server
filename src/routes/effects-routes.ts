import { Express } from "express";
import { EffectsRepo, IEffect } from "../db/effects.repo";
import { nodes } from "../handlers/node.handler";

export const EffectsDB = new EffectsRepo();

// Resolve a node id to its category, for the normalized `set` channel. Falls back
// to undefined (generic channel) when the node is unknown.
const resolveCategory = (id: string): string | undefined =>
  nodes.find((n) => String(n.id) === String(id))?.category;

export function initEffectsRoutes(app: Express) {
  app.get("/get-effects", (request, response) => {
    response.send(EffectsDB.get("effects") || []);
  });

  // Stage-2 normalized view: same rules in the typed `(node, channel, op)` shape.
  app.get("/get-effects-normalized", (request, response) => {
    response.send(EffectsDB.getNormalized(resolveCategory));
  });

  // Replace the full rule list. The live engine reads effects on every sensor
  // change (no per-sensor recompilation needed any more — Stage 4).
  app.post("/set-effects", (request, response) => {
    let { effects } = request.body;
    effects.forEach((effect: any) => {
      effect.set.value = JSON.parse(effect.set.value);
      effect.when.is = JSON.parse(effect.when.is);
    });
    EffectsDB.set("effects", effects);
    response.send(true);
  });

  app.post("/set-effect", (request, response) => {
    let { effect } = request.body;
    let effects: IEffect[] = EffectsDB.get("effects") || [];
    effect.set.value = JSON.parse(effect.set.value);
    effect.when.is = effect.when.is.indexOf(":") > -1 ? effect.when.is : JSON.parse(effect.when.is);
    effects.push(effect);
    EffectsDB.set("effects", effects);
    response.send(true);
  });
}
