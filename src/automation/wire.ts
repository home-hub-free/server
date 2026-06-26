import { randomUUID } from "crypto";
import { Node } from "../classes/node.class";
import type { EventMeta } from "../clients/ingestion";
import { nodes } from "../handlers/node.handler";
import { EffectsDB } from "../routes/effects-routes";
import { triggerCovers } from "./dynamic-evaluate";
import type { SetAction } from "./effect.model";
import { computeSetActions } from "./run-effects";

/**
 * Apply effect-driven set-actions: actuate each target node's channel tagged
 * `source:"automation"` (honest — it WAS caused by automation) and linked to the trigger
 * via `causedBy`. The reaction plane drops it on `source`; the observation plane keeps the
 * link for chain reconstruction. Shared by the sensor hook (below) and the time scheduler.
 */
export function applyEffectActions(
  actions: SetAction[],
  causedBy: NonNullable<EventMeta["causedBy"]>,
): void {
  actions.forEach((action) => {
    const target = nodes.find((n) => n.id === action.nodeId);
    if (target) target.setChannel(action.channel, action.value, "automation", false, causedBy);
  });
}

/**
 * Wire the Node automation hook (EFFECTS_DYNAMIC Stage 1). On any sensor channel change,
 * load the dynamic effect rules live (`trigger + arms`), evaluate them against current
 * node state + the clock, and apply each resulting set-action by actuating the target
 * node's channel.
 *
 * Lives outside node.handler.ts to avoid an import cycle (node.handler ↔
 * effects-routes). Called once at boot from index.ts.
 */
export function wireAutomations(): void {
  Node.automations = (node, channel, value) => {
    const effects = EffectsDB.getAll();

    const actions = computeSetActions(
      effects,
      { nodeId: node.id, channel, value },
      (id) => {
        const target = nodes.find((n) => n.id === id);
        return target ? { category: target.category, value: target.value, manual: target.manual } : undefined;
      },
      new Date(),
    );

    // One correlation id per trigger OCCURRENCE — every actuation this trigger drives
    // carries the same id back to it, so memory/Discovery can reconstruct the exact
    // chain (docs/PATTERN_LIFECYCLE.md §D6).
    applyEffectActions(actions, { nodeId: node.id, channel, correlationId: randomUUID() });
  };

  // Coverage predicate (§4): true when an enabled rule's TRIGGER matches a sensor edge.
  // Node uses it to stamp the trigger `coveredByEffect:true` WITHOUT altering its true
  // `source` (§D2) — so BOTH ends of the crystallized chain drop off the reaction plane
  // (trigger via the flag, actuation via `source:"automation"`) while the observation
  // plane keeps honest provenance. Coverage is trigger-MATCH, not actuation — a
  // motion→light rule covers the motion edge even when every arm is a no-op (light
  // already at value, so computeSetActions yields nothing). Reads the same live store.
  Node.isCovered = (node, channel, value) =>
    triggerCovers(EffectsDB.getAll(), {
      source: "sensor",
      nodeId: node.id,
      channel,
      value,
    });
}
