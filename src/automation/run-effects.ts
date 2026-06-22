import { channelValue } from "../clients/channels";
import type { NormalizedEffect } from "../db/effects-normalize";
import { ChannelEvent, SetAction, evaluate } from "./evaluate";

/**
 * The orchestration seam between the pure evaluator and the live node registry
 * (Stage 4a). Kept pure — the registry is injected as `getNode` — so it's testable
 * off the live box. The caller applies the returned actions (the only side effect)
 * by calling `set()` on each target node.
 */

/** The minimal view of a node the orchestrator needs to read target channels. */
export interface NodeView {
  category: string;
  value: any;
}

/**
 * Compute the set-actions to apply for a channel change: build a channel reader
 * over the node registry (via the value codec) and run the evaluator. This is the
 * exact replacement for the per-sensor precompiled effect closures
 * (effects.on/off/value) in the legacy Sensor.
 */
export function computeSetActions(
  effects: NormalizedEffect[],
  event: ChannelEvent,
  getNode: (nodeId: string) => NodeView | undefined,
): SetAction[] {
  const readChannel = (nodeId: string, channel: string) => {
    const node = getNode(nodeId);
    return node ? channelValue(node.category, channel, node.value) : undefined;
  };
  return evaluate(effects, event, readChannel);
}
