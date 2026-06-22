import { Node } from "../classes/node.class";
import { nodes } from "../handlers/node.handler";
import { EffectsDB } from "../routes/effects-routes";
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

    actions.forEach((action) => {
      const target = nodes.find((n) => n.id === action.nodeId);
      // Effect-driven actuation: tag as "automation" so the memory/LLM layer can
      // filter it out of the agent's reactive stream (still persisted for auditing).
      if (target) target.setChannel(action.channel, action.value, "automation");
    });
  };
}
