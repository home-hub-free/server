import { randomUUID } from "crypto";
import { Node } from "../classes/node.class";
import { nodes } from "../handlers/node.handler";
import { EffectsDB } from "../routes/effects-routes";
import { isCoveredByEffect } from "./evaluate";
import { computeSetActions } from "./run-effects";

/**
 * Wire the Node automation hook (Stage 4). On any sensor channel change, load the
 * effect rules live (normalized — now stored, read as identity), compute the
 * set-actions against current node state, and apply each by actuating the target
 * node's channel.
 *
 * Lives outside node.handler.ts to avoid an import cycle (node.handler ↔
 * effects-routes). Called once at boot from index.ts.
 */
export function wireAutomations(): void {
  Node.automations = (node, channel, value) => {
    const effects = EffectsDB.getNormalized();

    const actions = computeSetActions(
      effects,
      { nodeId: node.id, channel, value },
      (id) => {
        const target = nodes.find((n) => n.id === id);
        return target ? { category: target.category, value: target.value } : undefined;
      },
    );

    // One correlation id per trigger OCCURRENCE — every actuation this trigger drives
    // carries the same id back to it, so memory/Discovery can reconstruct the exact
    // chain (docs/PATTERN_LIFECYCLE.md §D6).
    const correlationId = randomUUID();

    actions.forEach((action) => {
      const target = nodes.find((n) => n.id === action.nodeId);
      // Effect-driven actuation: tag `source:"automation"` (honest — it WAS caused by
      // automation) and link it to the trigger via `causedBy`. The reaction plane drops
      // it on `source`; the observation plane keeps the link for chain reconstruction.
      if (target)
        target.setChannel(action.channel, action.value, "automation", false, {
          nodeId: node.id,
          channel,
          correlationId,
        });
    });
  };

  // Coverage predicate (D3): true when an enabled rule's WHEN matches a sensor trigger.
  // Node uses it to stamp the trigger `coveredByEffect:true` WITHOUT altering its true
  // `source` (§D2) — so BOTH ends of the crystallized chain drop off the reaction plane
  // (trigger via the flag, actuation via `source:"automation"`) while the observation
  // plane keeps honest provenance. Coverage is rule-MATCH, not actuation — a motion→light
  // rule covers the motion edge even when the light is already on (computeSetActions
  // yields nothing). Reads the same live effect store.
  Node.isCovered = (node, channel, value) =>
    isCoveredByEffect(EffectsDB.getNormalized(), { nodeId: node.id, channel, value });
}
