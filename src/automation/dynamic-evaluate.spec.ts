import type { ChannelReader, Effect, TriggerEvent } from "./effect.model";
import {
  compareOp,
  computeActions,
  conditionHolds,
  defaultTimeResolver,
  evaluate,
  triggerCovers,
  triggerMatches,
} from "./dynamic-evaluate";

// A reader over a fixed channel map; unknown channels read undefined.
const reader = (state: Record<string, boolean | number>): ChannelReader =>
  (nodeId, channel) => state[`${nodeId}.${channel}`];

const at = (h: number, m = 0) => new Date(2026, 5, 1, h, m, 0); // 2026-06-01 is a Monday

const motionEvent: TriggerEvent = {
  source: "sensor",
  nodeId: "motion-hall",
  channel: "presence",
  value: true,
};

// The canonical EFFECTS_DYNAMIC example: motion → 100% before 23:00, else 20%.
const hallRule: Effect = {
  trigger: { source: "sensor", nodeId: "motion-hall", channel: "presence" },
  arms: [
    {
      when: [{ kind: "time", op: "before", from: "23:00" }],
      set: { nodeId: "lamp-hall", channel: "brightness", value: 100 },
    },
    { when: [], set: { nodeId: "lamp-hall", channel: "brightness", value: 20 } },
  ],
  enabled: true,
};

describe("triggerMatches", () => {
  it("matches the sensor node+channel", () => {
    expect(triggerMatches(hallRule.trigger, motionEvent)).toBe(true);
  });
  it("rejects a different channel and a different source", () => {
    expect(
      triggerMatches(hallRule.trigger, { ...motionEvent, channel: "lux" }),
    ).toBe(false);
    expect(triggerMatches(hallRule.trigger, { source: "time", at: "23:00" })).toBe(false);
  });
});

describe("evaluate — first-arm-wins by time", () => {
  it("picks the bright arm before 23:00", () => {
    const action = evaluate(hallRule, motionEvent, reader({}), at(20));
    expect(action).toEqual({ nodeId: "lamp-hall", channel: "brightness", value: 100 });
  });
  it("falls through to the else arm at 23:30", () => {
    const action = evaluate(hallRule, motionEvent, reader({}), at(23, 30));
    expect(action).toEqual({ nodeId: "lamp-hall", channel: "brightness", value: 20 });
  });
});

describe("change-guard", () => {
  it("returns null when the target already holds the winning value", () => {
    const state = reader({ "lamp-hall.brightness": 100 });
    expect(evaluate(hallRule, motionEvent, state, at(20))).toBeNull();
  });
  it("still acts when the value differs", () => {
    const state = reader({ "lamp-hall.brightness": 50 });
    expect(evaluate(hallRule, motionEvent, state, at(20))).not.toBeNull();
  });
});

describe("evaluate — no match", () => {
  it("returns null when the trigger does not match", () => {
    const other: TriggerEvent = { ...motionEvent, nodeId: "motion-kitchen" };
    expect(evaluate(hallRule, other, reader({}), at(20))).toBeNull();
  });
  it("returns null when disabled", () => {
    expect(evaluate({ ...hallRule, enabled: false }, motionEvent, reader({}), at(20))).toBeNull();
  });
  it("returns null when no arm holds (no else arm)", () => {
    const rule: Effect = {
      trigger: hallRule.trigger,
      arms: [{ when: [{ kind: "time", op: "after", from: "23:00" }], set: hallRule.arms[0].set }],
      enabled: true,
    };
    expect(evaluate(rule, motionEvent, reader({}), at(20))).toBeNull();
  });
});

describe("conditionHolds", () => {
  const r = reader({ "door.power": true, "temp.temperature": 30 });
  it("time before/after", () => {
    expect(conditionHolds({ kind: "time", op: "before", from: "23:00" }, r, at(20), defaultTimeResolver)).toBe(true);
    expect(conditionHolds({ kind: "time", op: "after", from: "23:00" }, r, at(20), defaultTimeResolver)).toBe(false);
  });
  it("time between, including a window that wraps midnight", () => {
    const night = { kind: "time", op: "between", from: "22:00", to: "06:00" } as const;
    expect(conditionHolds(night, r, at(23), defaultTimeResolver)).toBe(true);
    expect(conditionHolds(night, r, at(3), defaultTimeResolver)).toBe(true);
    expect(conditionHolds(night, r, at(12), defaultTimeResolver)).toBe(false);
  });
  it("dow matches day-of-week (Mon=1)", () => {
    expect(conditionHolds({ kind: "dow", days: [1] }, r, at(9), defaultTimeResolver)).toBe(true);
    expect(conditionHolds({ kind: "dow", days: [0, 6] }, r, at(9), defaultTimeResolver)).toBe(false);
  });
  it("state/sensor compare live values", () => {
    expect(conditionHolds({ kind: "state", nodeId: "door", channel: "power", op: "eq", value: true }, r, at(9), defaultTimeResolver)).toBe(true);
    expect(conditionHolds({ kind: "sensor", nodeId: "temp", channel: "temperature", op: "gt", value: 28 }, r, at(9), defaultTimeResolver)).toBe(true);
  });
  it("is false when the referenced channel is unknown", () => {
    expect(conditionHolds({ kind: "state", nodeId: "ghost", channel: "x", op: "eq", value: true }, r, at(9), defaultTimeResolver)).toBe(false);
  });
});

describe("multi-condition arm (AND)", () => {
  const rule: Effect = {
    trigger: { source: "sensor", nodeId: "motion-hall", channel: "presence" },
    arms: [
      {
        when: [
          { kind: "time", op: "after", from: "18:00" },
          { kind: "dow", days: [1, 2, 3, 4, 5] }, // weekdays
        ],
        set: { nodeId: "lamp-hall", channel: "brightness", value: 40 },
      },
    ],
    enabled: true,
  };
  it("fires only when both guards hold", () => {
    expect(evaluate(rule, motionEvent, reader({}), at(19))).not.toBeNull(); // Mon 19:00
    expect(evaluate(rule, motionEvent, reader({}), at(10))).toBeNull(); // too early
    expect(evaluate(rule, motionEvent, reader({}), new Date(2026, 5, 7, 19, 0))).toBeNull(); // Sunday
  });
});

describe("computeActions + coverage", () => {
  it("collects actions across rules", () => {
    const actions = computeActions([hallRule], motionEvent, reader({}), at(20));
    expect(actions).toHaveLength(1);
  });
  it("triggerCovers is true on trigger match even when every arm is a no-op", () => {
    const state = reader({ "lamp-hall.brightness": 100 }); // bright arm would no-op
    expect(computeActions([hallRule], motionEvent, state, at(20))).toHaveLength(0);
    expect(triggerCovers([hallRule], motionEvent)).toBe(true);
  });
  it("triggerCovers ignores disabled rules", () => {
    expect(triggerCovers([{ ...hallRule, enabled: false }], motionEvent)).toBe(false);
  });
});

describe("compareOp + defaultTimeResolver", () => {
  it("eq compares booleans by identity and numbers by value", () => {
    expect(compareOp(true, "eq", true)).toBe(true);
    expect(compareOp(22, "eq", 22)).toBe(true);
    expect(compareOp(23, "eq", 22)).toBe(false);
  });
  it("parses HH:MM and rejects junk / solar refs", () => {
    expect(defaultTimeResolver("23:00")).toBe(1380);
    expect(defaultTimeResolver("07:30")).toBe(450);
    expect(defaultTimeResolver("sunset")).toBeUndefined();
    expect(defaultTimeResolver("99:99")).toBeUndefined();
  });
});
