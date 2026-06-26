import type {
  Arm,
  ChannelReader,
  Condition,
  Effect,
  Op,
  SetAction,
  TimeRef,
  TimeResolver,
  Trigger,
  TriggerEvent,
} from "./effect.model";

/**
 * The dynamic effect evaluator — one pure function, two callers (docs/EFFECTS_DYNAMIC.md §4).
 *
 * `evaluate(effect, event, readState, now)`:
 *   trigger match → first arm whose conditions ALL hold → change-guard → SetAction | null.
 *
 * Both callers (the immediate sensor hook and the time scheduler) funnel through this,
 * so behavior is identical regardless of what woke the rule. Pure: clock + state reader
 * are injected, no Node/socket/DB imports — testable off the live box.
 *
 * Parity with the flat evaluator it replaces:
 *  - the change-guard stays (`current !== set.value`): an arm that wouldn't change the
 *    target fires nothing, so re-fires are harmless.
 *  - coverage is still about the TRIGGER matching, not the actuation (`triggerCovers`).
 */

/** Compare a live value against a target with an operator. Booleans compare by identity;
 * numeric ops coerce (readings may arrive stringy). Mirrors the flat `conditionMet`. */
export function compareOp(value: boolean | number, op: Op, target: boolean | number): boolean {
  switch (op) {
    case "eq":
      if (typeof value === "boolean" || typeof target === "boolean") return value === target;
      return Number(value) === Number(target);
    case "gt":
      return Number(value) > Number(target);
    case "lt":
      return Number(value) < Number(target);
    default:
      return false;
  }
}

/** Minutes-since-midnight for a Date (local time — matches how "HH:MM" refs are meant). */
function minutesOfDay(d: Date): number {
  return d.getHours() * 60 + d.getMinutes();
}

/** Default TimeRef resolver: parses "HH:MM". Solar events ("sunrise"/"sunset") return
 * undefined here and must be supplied by an injected resolver (dailyEvents-backed). */
export function defaultTimeResolver(ref: TimeRef): number | undefined {
  const m = /^(\d{1,2}):(\d{2})$/.exec(ref.trim());
  if (!m) return undefined;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h > 23 || min > 59) return undefined;
  return h * 60 + min;
}

/** Does the master trigger match the event that woke evaluation? */
export function triggerMatches(trigger: Trigger, event: TriggerEvent): boolean {
  if (trigger.source !== event.source) return false;
  if (trigger.source === "sensor" && event.source === "sensor") {
    return trigger.nodeId === event.nodeId && trigger.channel === event.channel;
  }
  if (trigger.source === "time" && event.source === "time") {
    return trigger.at === event.at;
  }
  return false;
}

/** Does a single condition hold right now? Resolves live state via `readState`,
 * clock-based guards via `now` (+ the time resolver for refs). */
export function conditionHolds(
  c: Condition,
  readState: ChannelReader,
  now: Date,
  resolveTime: TimeResolver,
): boolean {
  switch (c.kind) {
    case "dow":
      return c.days.includes(now.getDay());

    case "time": {
      const cur = minutesOfDay(now);
      const from = resolveTime(c.from, now);
      if (from === undefined) return false;
      if (c.op === "before") return cur < from;
      if (c.op === "after") return cur >= from;
      // between: from..to, supporting a window that wraps past midnight (e.g. 22:00–06:00).
      const to = c.to === undefined ? undefined : resolveTime(c.to, now);
      if (to === undefined) return false;
      return from <= to ? cur >= from && cur < to : cur >= from || cur < to;
    }

    case "sensor":
    case "state": {
      const live = readState(c.nodeId, c.channel);
      if (live === undefined) return false;
      return compareOp(live, c.op, c.value);
    }

    default:
      return false;
  }
}

/** Does an arm apply? All its conditions must hold (AND); an empty `when` always holds. */
function armHolds(arm: Arm, readState: ChannelReader, now: Date, resolveTime: TimeResolver): boolean {
  return arm.when.every((c) => conditionHolds(c, readState, now, resolveTime));
}

/**
 * Evaluate one rule against the event that woke it. Returns the action to apply, or null
 * (trigger didn't match / no arm matched / the winning arm wouldn't change the target).
 */
export function evaluate(
  effect: Effect,
  event: TriggerEvent,
  readState: ChannelReader,
  now: Date,
  resolveTime: TimeResolver = defaultTimeResolver,
): SetAction | null {
  if (effect.enabled === false) return null;
  if (!triggerMatches(effect.trigger, event)) return null;

  for (const arm of effect.arms) {
    if (armHolds(arm, readState, now, resolveTime)) {
      const current = readState(arm.set.nodeId, arm.set.channel);
      return current !== arm.set.value ? arm.set : null; // change-guard
    }
  }
  return null; // no arm matched → implicit no-op
}

/**
 * The list-level orchestration: evaluate every enabled rule against the event and
 * collect the actions to apply. Replaces the flat `evaluate(effects[], …)` the wire
 * layer used. Order follows the rule list.
 */
export function computeActions(
  effects: Effect[],
  event: TriggerEvent,
  readState: ChannelReader,
  now: Date,
  resolveTime: TimeResolver = defaultTimeResolver,
): SetAction[] {
  const actions: SetAction[] = [];
  for (const effect of effects) {
    const action = evaluate(effect, event, readState, now, resolveTime);
    if (action) actions.push(action);
  }
  return actions;
}

/**
 * Is this trigger event COVERED by an enabled rule — i.e. does any rule's TRIGGER match
 * it (docs/EFFECTS_DYNAMIC.md §4, PATTERN_LIFECYCLE §D2/D3)? Coverage is about the
 * trigger matching, NOT about an action firing: a motion-triggered rule covers the motion
 * edge even when every arm is a no-op (light already at value), so the reaction plane
 * keeps dropping crystallized chains while the observation plane records the honest event.
 */
export function triggerCovers(effects: Effect[], event: TriggerEvent): boolean {
  return effects.some((e) => e.enabled !== false && triggerMatches(e.trigger, event));
}
