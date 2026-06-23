import type { EffectOp, NormalizedEffect } from "../db/effects-normalize";

/**
 * The single effect evaluator — Stage 4a (see docs/DATA_CONTRACTS.md).
 *
 * Replaces the two stringly-typed evaluators in sensor.class.ts
 * (`setBooleanSensorEffect` + `setTempHumidityEffect`) with one pure, channel-based
 * decision function over the Stage-2 normalized `(node, channel, op)` rules.
 *
 * Pure by design: it takes the changed channel event and a reader for current
 * target-channel values, and returns the set-actions that should fire. No Node /
 * socket / DB imports — so it (and its golden parity test) runs off the live box,
 * where the `node.*` integration specs cannot (port-8082 camera-storage import).
 *
 * Parity with the legacy engine it replaces:
 *  - Boolean (presence/motion) sensor: legacy ran on-effects on a false→true edge
 *    and off-effects on true→false. Here a presence change to `true` matches rules
 *    whose `when.value === true`; to `false` matches `when.value === false`. The
 *    orchestrator calls `evaluate` once per edge, reproducing the edge semantics.
 *  - temp/humidity: legacy re-evaluated `gt`/`lt` on every reading; same here.
 *  - "only act if it changes": legacy skipped when the target already held the set
 *    value (`device.value !== effect.set.value`, incl. the `valueToSet` sub-key).
 *    Here that's the `readChannel(...) !== set.value` guard, and the channel key
 *    already encodes the old `valueToSet`.
 */

/** A channel that just changed (the trigger). */
export interface ChannelEvent {
  nodeId: string;
  channel: string;
  value: boolean | number;
}

/** A resulting actuation to apply. */
export interface SetAction {
  nodeId: string;
  channel: string;
  value: boolean | number;
}

/** Reads the current value of a target channel, or undefined if unknown. */
export type ChannelReader = (
  nodeId: string,
  channel: string,
) => boolean | number | undefined;

/** Evaluate one condition operator. Booleans compare by identity; numeric ops
 * coerce (readings may arrive stringy). */
export function conditionMet(
  value: boolean | number,
  op: EffectOp,
  target: boolean | number,
): boolean {
  switch (op) {
    case "eq":
      if (typeof value === "boolean" || typeof target === "boolean") {
        return value === target;
      }
      return Number(value) === Number(target);
    case "gt":
      return Number(value) > Number(target);
    case "lt":
      return Number(value) < Number(target);
    default:
      return false;
  }
}

/** Does this enabled sensor rule's WHEN clause match the changed channel? The single
 * source of truth for "this trigger fires this rule", shared by `evaluate` (which then
 * additionally requires the target to change) and `isCoveredByEffect` (which doesn't). */
function whenMatches(effect: NormalizedEffect, event: ChannelEvent): boolean {
  if (effect.enabled === false) return false;
  const when = effect.when;
  if (when.source !== "sensor") return false;
  if (when.nodeId !== event.nodeId || when.channel !== event.channel) return false;
  return conditionMet(event.value, when.op, when.value);
}

/**
 * Given the full rule list and a channel that just changed, return the set-actions
 * to apply. Time rules are ignored (handled elsewhere). Disabled rules are skipped.
 */
export function evaluate(
  effects: NormalizedEffect[],
  event: ChannelEvent,
  readChannel: ChannelReader,
): SetAction[] {
  const actions: SetAction[] = [];

  for (const effect of effects) {
    if (!whenMatches(effect, event)) continue;

    // Only act when the target channel would actually change.
    const current = readChannel(effect.set.nodeId, effect.set.channel);
    if (current !== effect.set.value) {
      actions.push({
        nodeId: effect.set.nodeId,
        channel: effect.set.channel,
        value: effect.set.value,
      });
    }
  }

  return actions;
}

/**
 * Is this sensor change COVERED by an effect — i.e. does any enabled rule's WHEN
 * clause match it? Distinct from `evaluate`: coverage is about the trigger matching a
 * rule, NOT about an actuation firing. A motion→light rule still "covers" the motion
 * edge even when the light is already on (so `evaluate` returns no action) — the agent
 * crystallized that whole chain into a deterministic effect, so its reactive stream
 * should ignore the trigger rather than re-reason its way to "no_action". Pure; the
 * hub uses it to stamp a covered trigger `coveredByEffect:true` (dropped from the agent
 * wake-path) WITHOUT altering its true `source` (docs/PATTERN_LIFECYCLE.md §D2) — the
 * event is still persisted to memory with honest provenance.
 */
export function isCoveredByEffect(
  effects: NormalizedEffect[],
  event: ChannelEvent,
): boolean {
  return effects.some((effect) => whenMatches(effect, event));
}
