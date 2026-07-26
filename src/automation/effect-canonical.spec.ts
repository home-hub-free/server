import type { Effect } from "./effect.model";
import { canonicalEffect, parseMaybe } from "./effect-canonical";

describe("parseMaybe", () => {
  it("decodes a JSON-encoded boolean/number string", () => {
    expect(parseMaybe("true")).toBe(true);
    expect(parseMaybe("false")).toBe(false);
    expect(parseMaybe("80")).toBe(80);
  });

  it("passes through a non-JSON string unchanged", () => {
    expect(parseMaybe("07:00")).toBe("07:00");
    expect(parseMaybe("sunset")).toBe("sunset");
  });

  it("passes through non-string values unchanged", () => {
    expect(parseMaybe(true)).toBe(true);
    expect(parseMaybe(42)).toBe(42);
    expect(parseMaybe(null)).toBe(null);
  });
});

describe("canonicalEffect (D2 duplicate identity)", () => {
  const sensorRule = (value: boolean | number = true): Effect => ({
    trigger: { source: "sensor", nodeId: "pir-sala", channel: "presence" },
    arms: [
      {
        when: [{ kind: "sensor", nodeId: "pir-sala", channel: "presence", op: "eq", value }],
        set: { nodeId: "light-sala", channel: "power", value: true },
      },
    ],
    enabled: true,
  });

  it("is stable for the exact same effect", () => {
    expect(canonicalEffect(sensorRule())).toBe(canonicalEffect(sensorRule()));
  });

  it("ignores `enabled` — a disabled rule is still a duplicate of its enabled twin", () => {
    const enabled: Effect = { ...sensorRule(), enabled: true };
    const disabled: Effect = { ...sensorRule(), enabled: false };
    expect(canonicalEffect(enabled)).toBe(canonicalEffect(disabled));
  });

  it("is independent of the source object's key order", () => {
    const a: Effect = {
      trigger: { source: "sensor", nodeId: "x", channel: "y" },
      arms: [{ when: [], set: { nodeId: "light", channel: "power", value: true } }],
      enabled: true,
    };
    // Same fields, written in a different literal order.
    const b: Effect = {
      enabled: true,
      arms: [{ set: { value: true, channel: "power", nodeId: "light" }, when: [] }],
      trigger: { channel: "y", nodeId: "x", source: "sensor" },
    } as Effect;
    expect(canonicalEffect(a)).toBe(canonicalEffect(b));
  });

  it("treats a string-encoded value the same as its typed equivalent", () => {
    const typed = sensorRule(true);
    const stringy: Effect = {
      trigger: { source: "sensor", nodeId: "pir-sala", channel: "presence" },
      arms: [
        {
          when: [{ kind: "sensor", nodeId: "pir-sala", channel: "presence", op: "eq", value: "true" as any }],
          set: { nodeId: "light-sala", channel: "power", value: true },
        },
      ],
      enabled: true,
    };
    expect(canonicalEffect(typed)).toBe(canonicalEffect(stringy));

    const gtTyped: Effect = {
      trigger: { source: "sensor", nodeId: "th", channel: "temperature" },
      arms: [{ when: [{ kind: "sensor", nodeId: "th", channel: "temperature", op: "gt", value: 80 }], set: { nodeId: "fan", channel: "power", value: true } }],
      enabled: true,
    };
    const gtStringy: Effect = {
      trigger: { source: "sensor", nodeId: "th", channel: "temperature" },
      arms: [{ when: [{ kind: "sensor", nodeId: "th", channel: "temperature", op: "gt", value: "80" as any }], set: { nodeId: "fan", channel: "power", value: true } }],
      enabled: true,
    };
    expect(canonicalEffect(gtTyped)).toBe(canonicalEffect(gtStringy));
  });

  it("is independent of condition order WITHIN one arm", () => {
    const a: Effect = {
      trigger: { source: "sensor", nodeId: "motion-hall", channel: "presence" },
      arms: [
        {
          when: [
            { kind: "time", op: "before", from: "23:00" },
            { kind: "dow", days: [1, 2, 3] },
          ],
          set: { nodeId: "lamp", channel: "brightness", value: 100 },
        },
      ],
      enabled: true,
    };
    const b: Effect = {
      ...a,
      arms: [{ ...a.arms[0], when: [...a.arms[0].when].reverse() }],
    };
    expect(canonicalEffect(a)).toBe(canonicalEffect(b));
  });

  it("sorts `dow` days numerically before comparing", () => {
    const a: Effect = {
      trigger: { source: "time", at: "22:00" },
      arms: [{ when: [{ kind: "dow", days: [3, 1, 2] }], set: { nodeId: "lamp", channel: "power", value: true } }],
      enabled: true,
    };
    const b: Effect = {
      ...a,
      arms: [{ ...a.arms[0], when: [{ kind: "dow", days: [1, 2, 3] }] }],
    };
    expect(canonicalEffect(a)).toBe(canonicalEffect(b));
  });

  it("keeps ARM ORDER significant — swapping two arms is NOT a duplicate", () => {
    const armA = { when: [{ kind: "time" as const, op: "before" as const, from: "23:00" }], set: { nodeId: "lamp", channel: "brightness", value: 100 } };
    const armB = { when: [], set: { nodeId: "lamp", channel: "brightness", value: 20 } };
    const forward: Effect = { trigger: { source: "sensor", nodeId: "motion-hall", channel: "presence" }, arms: [armA, armB], enabled: true };
    const swapped: Effect = { ...forward, arms: [armB, armA] };
    expect(canonicalEffect(forward)).not.toBe(canonicalEffect(swapped));
  });

  it("distinguishes genuinely different effects", () => {
    expect(canonicalEffect(sensorRule(true))).not.toBe(
      canonicalEffect({
        trigger: { source: "sensor", nodeId: "pir-other", channel: "presence" },
        arms: [{ when: [], set: { nodeId: "light-sala", channel: "power", value: true } }],
        enabled: true,
      }),
    );
  });
});
