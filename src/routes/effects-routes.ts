import { Express } from "express";
import { EffectsRepo, IEffect } from "../db/effects.repo";
import { NormalizedEffect, normalizeEffect } from "../db/effects-normalize";
import type { Effect } from "../automation/effect.model";
import { flatToEffect, parseDynamicEffect } from "../automation/effect-compat";
import { canonicalEffect, parseMaybe } from "../automation/effect-canonical";
import { nodes } from "../handlers/node.handler";
import { requireAuth } from "../auth/middleware";

export const EffectsDB = new EffectsRepo();

// Resolve a node id to its category — only needed to normalize a legacy-shaped
// rule that still arrives without a `set` channel. Falls back to undefined.
const resolveCategory = (id: string): string | undefined =>
  nodes.find((n) => String(n.id) === String(id))?.category;

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

const HHMM_RE = /^\d{2}:\d{2}$/;

/** D10: "HH:MM" (24h, zero-padded) with valid ranges — the only time format the
 *  scheduler and time-conditions accept (solar refs aren't authorable yet). */
function isValidTime(s: string): boolean {
  if (!HHMM_RE.test(s)) return false;
  const [h, m] = s.split(":").map(Number);
  return h <= 23 && m <= 59;
}

/**
 * D10 input validation for a parsed dynamic Effect: every clock time it carries
 * (trigger.at for a time trigger, and each arm's time-condition from/to) must be a
 * valid HH:MM, and a rule needs at least one arm. Returns a human-readable error
 * message, or null when the effect is valid. Wired into /set-effect and
 * /update-effect, ahead of the duplicate check (EFFECT_CREATION_REPAIR Phase 2 step
 * 2.3); /set-effects (bulk replace) intentionally stays permissive, unchanged.
 */
function validateEffect(effect: Effect): string | null {
  if (!Array.isArray(effect.arms) || effect.arms.length < 1) {
    return "at least one arm is required";
  }
  if (effect.trigger.source === "time" && !isValidTime(effect.trigger.at)) {
    return `invalid trigger time "${effect.trigger.at}" — expected HH:MM`;
  }
  for (const arm of effect.arms) {
    for (const c of arm.when) {
      if (c.kind !== "time") continue;
      if (!isValidTime(c.from)) return `invalid condition time "${c.from}" — expected HH:MM`;
      if (c.to !== undefined && !isValidTime(c.to)) return `invalid condition time "${c.to}" — expected HH:MM`;
    }
  }
  return null;
}

// Rule-change hook — invoked after any write so the time-trigger scheduler can re-arm to
// the new earliest boundary (EFFECTS_DYNAMIC §3.2). Wired in index.ts to rearmTimeEffects;
// a settable hook avoids an effects-routes ↔ time-scheduler import cycle.
let onEffectsChanged: () => void = () => {};
export function setOnEffectsChanged(fn: () => void): void {
  onEffectsChanged = fn;
}

export function initEffectsRoutes(app: Express) {
  // Dynamic contract (EFFECTS_DYNAMIC §2) — whole `trigger + arms` rules. Served via
  // summaries() so each rule carries its stable row id + enabled flag: the dashboard
  // management UI needs that to disable/delete a specific rule, and it's the same id
  // space the agent uses (/state + /delete-effect + /set-effect-enabled). The id is
  // additive — runtime callers read trigger/arms in-process via getAll(), not this route.
  app.get("/get-effects-dynamic", (request, response) => {
    response.send(EffectsDB.summaries());
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
  // `when → set` DTO (back-compat); both are stored as dynamic Effects. Bulk replace
  // dedupes the incoming list silently (D2: first occurrence wins, no 409 — a caller
  // replacing the whole list isn't "adding a duplicate", it's stating the new truth)
  // and does NOT run D10 validation (unchanged blind-write contract for this route).
  app.post("/set-effects", requireAuth, (request, response) => {
    const { effects } = request.body;
    const parsed: Effect[] = (effects || []).map(toEffect);
    const deduped: Effect[] = [];
    const seen = new Set<string>();
    for (const e of parsed) {
      const key = canonicalEffect(e);
      if (seen.has(key)) continue;
      seen.add(key);
      deduped.push(e);
    }
    EffectsDB.setAll(deduped);
    onEffectsChanged();
    response.send(true);
  });

  // Append one rule (dynamic `trigger + arms` or a flat DTO). D10 validation first
  // (400 on a bad time or an empty arm list), then the D2 duplicate guard (409 with
  // the existing row's id) — the response shape gaining `{ok, id}` instead of a bare
  // `true` is additive; the current dashboard ignores the body (EFFECT_CREATION_REPAIR
  // Phase 2 step 2.3).
  app.post("/set-effect", requireAuth, (request, response) => {
    const { effect } = request.body;
    const parsed = toEffect(effect);

    const invalid = validateEffect(parsed);
    if (invalid) return response.status(400).send({ ok: false, error: invalid });

    const existingId = EffectsDB.findDuplicate(parsed);
    if (existingId !== null) {
      return response.status(409).send({ ok: false, duplicate: true, existingId });
    }

    const id = EffectsDB.add(parsed);
    onEffectsChanged();
    response.send({ ok: true, id });
  });

  // Replace ONE rule in place by id (the edit counterpart of /set-effect's append). The dashboard
  // sends the id of the rule being edited plus the full new `trigger + arms` rule; the row keeps its
  // id + list position so the management view doesn't reshuffle on every tweak. Same D10 validation
  // + D2 duplicate guard as /set-effect, but findDuplicate excludes this row's own id — editing a
  // rule back to its own current shape (or any shape no OTHER rule already has) is never a 409.
  app.post("/update-effect", requireAuth, (request, response) => {
    const id = Number(request.body?.id);
    if (!Number.isInteger(id)) return response.status(400).send({ ok: false, error: "numeric id required" });

    const parsed = toEffect(request.body?.effect);

    const invalid = validateEffect(parsed);
    if (invalid) return response.status(400).send({ ok: false, error: invalid });

    const existingId = EffectsDB.findDuplicate(parsed, id);
    if (existingId !== null) {
      return response.status(409).send({ ok: false, duplicate: true, existingId });
    }

    const updated = EffectsDB.update(id, parsed);
    if (updated) onEffectsChanged();
    response.send({ ok: updated, id });
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
