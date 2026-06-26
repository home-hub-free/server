/**
 * The dynamic effect model — Trigger → Conditions → Arms (docs/EFFECTS_DYNAMIC.md §2).
 *
 * Replaces the flat `when → set` rule (one condition that doubled as the trigger,
 * sensor-edge only) with **one master trigger + an ordered list of arms**, so a single
 * rule can pick a different action by time-of-day or by other live state:
 *
 *   "when motion fires: if before 23:00 → 100%, else → 20%"  ← ONE rule, two arms.
 *
 * Everything stays on the channel contract (`channels.ts`): `(nodeId, channel, value)`
 * everywhere, never reaching into device value blobs.
 *
 * These types are pure data. The evaluator (`dynamic-evaluate.ts`) is the only place
 * that interprets them, and it is pure too (clock + state reader injected) so it runs
 * off the live box, exactly like the flat evaluator it replaces.
 */

/** Comparison operator for sensor/state conditions. */
export type Op = "eq" | "gt" | "lt";

/** A time reference: "HH:MM" (24h) or a named solar event resolved via dailyEvents. */
export type TimeRef = string; // "HH:MM" | "sunrise" | "sunset"

/** The actuation an arm applies when it wins. */
export interface SetAction {
  nodeId: string;
  channel: string;
  value: boolean | number;
}

/**
 * The single master edge that wakes evaluation. Exactly one per rule.
 *  - sensor: a channel change fires the existing immediate `Node.automations` hook.
 *  - time:   a clock boundary fires the one-shot scheduler (EFFECTS_DYNAMIC Stage 2).
 */
export type Trigger =
  | { source: "sensor"; nodeId: string; channel: string }
  | { source: "time"; at: TimeRef };

/**
 * A passive guard. Conditions never trigger anything on their own — they only decide
 * whether an arm's action applies once the master trigger has fired.
 *  - time:   now is before/after a ref, or between two refs.
 *  - dow:    day-of-week is in `days` (0=Sun … 6=Sat).
 *  - sensor/state: a live (nodeId, channel) value compares `op` to `value`.
 */
export type Condition =
  | { kind: "time"; op: "before" | "after" | "between"; from: TimeRef; to?: TimeRef }
  | { kind: "dow"; days: number[] }
  | { kind: "sensor"; nodeId: string; channel: string; op: Op; value: boolean | number }
  | { kind: "state"; nodeId: string; channel: string; op: Op; value: boolean | number };

/**
 * One arm = an AND of guards → an action. Arms are ordered; the first arm whose
 * conditions ALL hold wins (first-match). An empty `when` always holds — the "else" arm.
 */
export interface Arm {
  when: Condition[];
  set: SetAction;
}

/** A complete automation rule. */
export interface Effect {
  trigger: Trigger;
  arms: Arm[];
  enabled: boolean;
}

/** The event that woke evaluation — a sensor channel change or a time-boundary fire. */
export type TriggerEvent =
  | { source: "sensor"; nodeId: string; channel: string; value: boolean | number }
  | { source: "time"; at: TimeRef };

/** Reads the current value of any (nodeId, channel), or undefined if unknown. */
export type ChannelReader = (
  nodeId: string,
  channel: string,
) => boolean | number | undefined;

/** Resolves a TimeRef ("HH:MM" | "sunrise" | "sunset") to minutes-since-midnight for
 * a given day. Injected so the evaluator stays pure and solar events are testable. */
export type TimeResolver = (ref: TimeRef, now: Date) => number | undefined;
