import type { IEffect } from "./effects.repo";

/**
 * Effect normalization — Stage 2 of the data-contract redesign (see
 * docs/DATA_CONTRACTS.md).
 *
 * The legacy effect shape is stringly-typed and reaches into device value blobs:
 *   when.is  = true | "false" | "temp:higher-than:28"   (field:comparison:target)
 *   set      = { id, value, valueToSet? }                (valueToSet = blob sub-key)
 *
 * The target shape references typed `(node, channel, op)` pairs — the same channel
 * keys the Stage-1 projection emits (`channels.ts`). This module is the pure,
 * deterministic converter from legacy → normalized. It is DERIVE-ON-READ: it does
 * not mutate the stored rows, so the live trigger engine keeps reading the legacy
 * shape while the dashboard/LLM consume the clean form. The transform is total and
 * idempotent, so it can re-run on every read with no state.
 */

export type EffectOp = "eq" | "gt" | "lt";

/** A sensor-driven condition: "<node>.<channel> <op> <value>". */
export interface SensorCondition {
  source: "sensor";
  nodeId: string;
  channel: string;
  op: EffectOp;
  value: boolean | number;
}

/** A time-driven condition. Legacy time effects are vestigial (never wired); we
 * preserve their raw expression rather than force them into the channel model. */
export interface TimeCondition {
  source: "time";
  at: string;
}

export type Condition = SensorCondition | TimeCondition;

export interface NormalizedEffect {
  when: Condition;
  set: { nodeId: string; channel: string; value: boolean | number };
  enabled: boolean;
}

/** Resolve a node id to its device category (for picking the primary channel on
 * the `set` side of single-value devices). Returns undefined if unknown. */
export type CategoryResolver = (nodeId: string) => string | undefined;

/**
 * The primary actuator channel for a single-value device category — mirrors the
 * Stage-1 projection in channels.ts. Used when the legacy `set` has no `valueToSet`
 * (i.e. the rule wrote `device.value` directly).
 */
export function primaryActuatorChannel(category: string | undefined): string {
  switch (category) {
    case "light":
    case "door":
      return "power";
    case "dimmable-light":
      return "brightness";
    case "blinds":
      return "position";
    case "evap-cooler":
      // Multi-channel; legacy cooler rules always carry valueToSet, so this is only
      // a defensive default.
      return "fan";
    default:
      return "value"; // unknown/legacy category — matches the generic projection
  }
}

/** Parse a temp/humidity field token into its Stage-1 channel key. */
function fieldToChannel(field: string): string {
  switch (field) {
    case "temp":
      return "temperature";
    case "humidity":
      return "humidity";
    default:
      return field;
  }
}

function comparisonToOp(comparison: string): EffectOp {
  switch (comparison) {
    case "higher-than":
      return "gt";
    case "lower-than":
      return "lt";
    default:
      return "eq";
  }
}

/** True when `is` encodes a value comparison ("field:comparison:target"). */
function isValueComparison(is: any): is is string {
  return typeof is === "string" && is.split(":").length === 3;
}

/** Coerce the legacy on/off truthiness rule into a real boolean. The runtime treats
 * a falsy `is` or the string "false" as the off-effect. */
function toBooleanCondition(is: any): boolean {
  return !(!is || is === "false");
}

function normalizeWhen(when: IEffect["when"]): Condition {
  if (when.type === "time") {
    return { source: "time", at: String(when.is ?? "") };
  }

  if (isValueComparison(when.is)) {
    const [field, comparison, target] = when.is.split(":");
    return {
      source: "sensor",
      nodeId: when.id,
      channel: fieldToChannel(field),
      op: comparisonToOp(comparison),
      value: Number(target),
    };
  }

  // Boolean (motion/presence) sensor — both project to the "presence" channel.
  return {
    source: "sensor",
    nodeId: when.id,
    channel: "presence",
    op: "eq",
    value: toBooleanCondition(when.is),
  };
}

function normalizeSet(
  set: IEffect["set"],
  resolveCategory: CategoryResolver,
): NormalizedEffect["set"] {
  // valueToSet names a blob sub-key directly — it IS the channel (e.g. "fan").
  const channel = set.valueToSet ?? primaryActuatorChannel(resolveCategory(set.id));
  return { nodeId: set.id, channel, value: set.value };
}

/** Convert one legacy effect to the normalized `(node, channel, op)` shape. */
export function normalizeEffect(
  effect: IEffect,
  resolveCategory: CategoryResolver = () => undefined,
): NormalizedEffect {
  return {
    when: normalizeWhen(effect.when),
    set: normalizeSet(effect.set, resolveCategory),
    enabled: true,
  };
}

/** Convert a full legacy rule list. */
export function normalizeAll(
  effects: IEffect[],
  resolveCategory: CategoryResolver = () => undefined,
): NormalizedEffect[] {
  return (effects || []).map((e) => normalizeEffect(e, resolveCategory));
}
