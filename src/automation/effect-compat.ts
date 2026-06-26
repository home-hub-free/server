import type { Arm, Condition, Effect, Op, Trigger } from "./effect.model";
import type { NormalizedEffect } from "../db/effects-normalize";

/**
 * Flat ↔ dynamic effect adapters (docs/EFFECTS_DYNAMIC.md Stage 1).
 *
 * The runtime + storage are now `Effect`-native (trigger + arms). The flat
 * `NormalizedEffect` (`when → set`) survives only as the **boundary DTO** the dashboard,
 * LLM gateway, and state dump still speak — until EFFECTS_DYNAMIC Stage 4 teaches them
 * `trigger + arms` natively (then §7 removes this and `effects-normalize.ts`).
 *
 * These converters are the seam. They are exact inverses for every rule the flat shape
 * can express, so the legacy HTTP surface round-trips losslessly.
 */

/**
 * Flat → dynamic. A flat sensor rule's `when` is BOTH the trigger and a value guard, so
 * it becomes: trigger = the (node, channel) edge; a single arm whose `when` carries the
 * op/value as a `sensor` condition (re-checked against live state at fire time — exactly
 * the flat semantics: wake on the channel change, act only if the comparison holds). A
 * flat time rule becomes a time trigger with one unconditional arm.
 */
export function flatToEffect(n: NormalizedEffect): Effect {
  if (n.when.source === "time") {
    return {
      trigger: { source: "time", at: n.when.at },
      arms: [{ when: [], set: n.set }],
      enabled: n.enabled !== false,
    };
  }
  return {
    trigger: { source: "sensor", nodeId: n.when.nodeId, channel: n.when.channel },
    arms: [
      {
        when: [
          {
            kind: "sensor",
            nodeId: n.when.nodeId,
            channel: n.when.channel,
            op: n.when.op,
            value: n.when.value,
          },
        ],
        set: n.set,
      },
    ],
    enabled: n.enabled !== false,
  };
}

/**
 * Dynamic → flat. Only a SINGLE-arm rule is representable in the flat shape; a multi-arm
 * (context-conditioned) rule has no flat equivalent and returns null — the boundary skips
 * it (those only appear once the dashboard/LLM speak the dynamic shape in Stage 4).
 *
 * For a sensor trigger, the flat `when` is reconstructed from the arm's sensor condition
 * on the trigger channel (the inverse of `flatToEffect`); absent one, it defaults to a
 * boolean `eq true` guard (a bare trigger). For a time trigger, the arm's guards are
 * dropped (flat time rules carry none).
 */
export function effectToFlat(e: Effect): NormalizedEffect | null {
  if (e.arms.length !== 1) return null;
  const arm = e.arms[0];

  const trigger = e.trigger;
  if (trigger.source === "time") {
    return { when: { source: "time", at: trigger.at }, set: arm.set, enabled: e.enabled !== false };
  }

  const guard = arm.when.find(
    (c): c is Extract<Condition, { kind: "sensor" }> =>
      c.kind === "sensor" &&
      c.nodeId === trigger.nodeId &&
      c.channel === trigger.channel,
  );
  return {
    when: {
      source: "sensor",
      nodeId: trigger.nodeId,
      channel: trigger.channel,
      op: guard ? guard.op : "eq",
      value: guard ? guard.value : true,
    },
    set: arm.set,
    enabled: e.enabled !== false,
  };
}

/** Convert a full flat list to dynamic effects. */
export function flatListToEffects(list: NormalizedEffect[]): Effect[] {
  return (list || []).map(flatToEffect);
}

/** Convert a full dynamic list to flat, dropping rules with no flat equivalent. */
export function effectsToFlatList(effects: Effect[]): NormalizedEffect[] {
  const out: NormalizedEffect[] = [];
  for (const e of effects) {
    const flat = effectToFlat(e);
    if (flat) out.push(flat);
  }
  return out;
}

/**
 * Parse a wire-shaped dynamic effect (`{ trigger, arms, enabled? }`) into a typed `Effect`
 * (EFFECTS_DYNAMIC Stage 4 native ingest). Tolerant of form-encoded values (strings) via
 * `decode`, so it serves both the LLM `create_effect` tool (well-typed JSON) and a future
 * dashboard form post. The opposite direction of `effectToFlat` — this is what lets the
 * agent author multi-arm, context-conditioned rules the flat shape can't express.
 */
export function parseDynamicEffect(raw: any, decode: (v: any) => any = (v) => v): Effect {
  const t = raw?.trigger ?? {};
  const trigger: Trigger =
    t.source === "time"
      ? { source: "time", at: String(t.at ?? "") }
      : { source: "sensor", nodeId: String(t.nodeId ?? ""), channel: String(t.channel ?? "") };

  const arms: Arm[] = (raw?.arms ?? []).map((a: any) => ({
    when: (a?.when ?? []).map((c: any) => parseCondition(c, decode)),
    set: {
      nodeId: String(a?.set?.nodeId ?? ""),
      channel: String(a?.set?.channel ?? ""),
      value: decode(a?.set?.value),
    },
  }));

  return { trigger, arms, enabled: raw?.enabled !== false };
}

function parseCondition(c: any, decode: (v: any) => any): Condition {
  switch (c?.kind) {
    case "time":
      return { kind: "time", op: c.op, from: String(c.from ?? ""), to: c.to !== undefined ? String(c.to) : undefined };
    case "dow":
      return { kind: "dow", days: (c.days ?? []).map((d: any) => Number(d)) };
    case "state":
      return { kind: "state", nodeId: String(c.nodeId ?? ""), channel: String(c.channel ?? ""), op: c.op as Op, value: decode(c.value) };
    case "sensor":
    default:
      return { kind: "sensor", nodeId: String(c.nodeId ?? ""), channel: String(c.channel ?? ""), op: c.op as Op, value: decode(c.value) };
  }
}
