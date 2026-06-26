import { channelValue } from "../clients/channels";
import type { ChannelReader, Effect, SetAction, TimeResolver, TriggerEvent } from "./effect.model";
import { computeActions, defaultTimeResolver } from "./dynamic-evaluate";

/**
 * The orchestration seam between the pure dynamic evaluator and the live node registry
 * (EFFECTS_DYNAMIC Stage 1). Kept pure — the registry is injected as `getNode` — so it's
 * testable off the live box. The caller applies the returned actions (the only side
 * effect) by calling `setChannel()` on each target node.
 *
 * Conditions (and the change-guard) resolve against live channel state through the same
 * reader, built over the node registry via the value codec — so a `state`/`sensor`
 * condition reading "is the door open?" sees the current value, not the trigger payload.
 */

/** The minimal view of a node the orchestrator needs to read channels + honor the lock. */
export interface NodeView {
  category: string;
  value: any;
  /** True when a user has manually grabbed the wheel (the `manual` lock). Effect
   * actuations skip a locked target — the user wins until the next natural reset
   * (docs/EFFECTS_DYNAMIC.md §8/Stage 3). */
  manual?: boolean;
}

/** A sensor channel that just changed (the trigger edge). */
export interface ChannelEvent {
  nodeId: string;
  channel: string;
  value: boolean | number;
}

/**
 * Compute the set-actions to apply for a sensor channel change: build a channel reader
 * over the node registry (via the value codec), wrap the edge as a sensor TriggerEvent,
 * and run the dynamic evaluator. `now` is injected (defaults to the wall clock) so time
 * conditions are testable.
 */
export function computeSetActions(
  effects: Effect[],
  event: ChannelEvent,
  getNode: (nodeId: string) => NodeView | undefined,
  now: Date = new Date(),
): SetAction[] {
  const triggerEvent: TriggerEvent = {
    source: "sensor",
    nodeId: event.nodeId,
    channel: event.channel,
    value: event.value,
  };
  const actions = computeActions(effects, triggerEvent, readerOver(getNode), now, defaultTimeResolver);
  return dropManualLocked(actions, getNode);
}

/**
 * The time-trigger counterpart (EFFECTS_DYNAMIC Stage 2): evaluate every effect whose
 * `time` trigger fired at `at`. Same evaluator, same change-guard — the only difference
 * is the event shape. `resolveTime` is injected so arm conditions can resolve solar refs.
 */
export function computeTimeActions(
  effects: Effect[],
  at: string,
  getNode: (nodeId: string) => NodeView | undefined,
  now: Date = new Date(),
  resolveTime: TimeResolver = defaultTimeResolver,
): SetAction[] {
  const event: TriggerEvent = { source: "time", at };
  const actions = computeActions(effects, event, readerOver(getNode), now, resolveTime);
  return dropManualLocked(actions, getNode);
}

/** Build a channel reader over the node registry via the value codec. */
function readerOver(getNode: (nodeId: string) => NodeView | undefined): ChannelReader {
  return (nodeId, channel) => {
    const node = getNode(nodeId);
    return node ? channelValue(node.category, channel, node.value) : undefined;
  };
}

/** Drop any action whose target node holds the `manual` lock — the user wins (Stage 3).
 * Applies uniformly to sensor- and time-triggered effects, so override semantics are
 * consistent across both. An unknown target is not locked, so it stays (the apply step
 * is where a missing node no-ops). */
function dropManualLocked(
  actions: SetAction[],
  getNode: (nodeId: string) => NodeView | undefined,
): SetAction[] {
  return actions.filter((a) => getNode(a.nodeId)?.manual !== true);
}
