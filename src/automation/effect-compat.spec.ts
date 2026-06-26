import type { Effect } from "./effect.model";
import { effectToFlat, flatToEffect, parseDynamicEffect } from "./effect-compat";
import type { NormalizedEffect } from "../db/effects-normalize";

describe("flat ↔ dynamic round-trip", () => {
  it("sensor rule: flat → dynamic → flat is identity", () => {
    const flat: NormalizedEffect = {
      when: { source: "sensor", nodeId: "pir", channel: "presence", op: "eq", value: true },
      set: { nodeId: "light", channel: "power", value: true },
      enabled: true,
    };
    expect(effectToFlat(flatToEffect(flat))).toEqual(flat);
  });

  it("time rule round-trips", () => {
    const flat: NormalizedEffect = {
      when: { source: "time", at: "sunset" },
      set: { nodeId: "light", channel: "power", value: true },
      enabled: false,
    };
    expect(effectToFlat(flatToEffect(flat))).toEqual(flat);
  });

  it("a multi-arm effect has no flat equivalent (returns null)", () => {
    const dynamic: Effect = {
      trigger: { source: "sensor", nodeId: "motion-hall", channel: "presence" },
      arms: [
        { when: [{ kind: "time", op: "before", from: "23:00" }], set: { nodeId: "lamp", channel: "brightness", value: 100 } },
        { when: [], set: { nodeId: "lamp", channel: "brightness", value: 20 } },
      ],
      enabled: true,
    };
    expect(effectToFlat(dynamic)).toBeNull();
  });
});

describe("parseDynamicEffect", () => {
  it("parses the canonical multi-arm rule (the shape create_effect now posts)", () => {
    const raw = {
      trigger: { source: "sensor", nodeId: "motion-hall", channel: "presence" },
      arms: [
        { when: [{ kind: "time", op: "before", from: "23:00" }], set: { nodeId: "lamp-hall", channel: "brightness", value: 100 } },
        { when: [], set: { nodeId: "lamp-hall", channel: "brightness", value: 20 } },
      ],
      enabled: true,
    };
    expect(parseDynamicEffect(raw)).toEqual({
      trigger: { source: "sensor", nodeId: "motion-hall", channel: "presence" },
      arms: [
        { when: [{ kind: "time", op: "before", from: "23:00", to: undefined }], set: { nodeId: "lamp-hall", channel: "brightness", value: 100 } },
        { when: [], set: { nodeId: "lamp-hall", channel: "brightness", value: 20 } },
      ],
      enabled: true,
    });
  });

  it("decodes form-encoded scalar values via the injected decoder", () => {
    const parse = (v: any) => (typeof v === "string" ? JSON.parse(v) : v);
    const raw = {
      trigger: { source: "time", at: "23:00" },
      arms: [{ when: [{ kind: "dow", days: ["1", "2"] }], set: { nodeId: "lamp", channel: "brightness", value: "20" } }],
    };
    const e = parseDynamicEffect(raw, parse);
    expect(e.trigger).toEqual({ source: "time", at: "23:00" });
    expect(e.arms[0].set.value).toBe(20);
    expect(e.arms[0].when).toEqual([{ kind: "dow", days: [1, 2] }]);
    expect(e.enabled).toBe(true); // default
  });

  it("parses sensor/state conditions with operators", () => {
    const raw = {
      trigger: { source: "sensor", nodeId: "pir", channel: "presence" },
      arms: [
        {
          when: [
            { kind: "state", nodeId: "door", channel: "power", op: "eq", value: true },
            { kind: "sensor", nodeId: "th", channel: "temperature", op: "gt", value: 28 },
          ],
          set: { nodeId: "fan", channel: "power", value: true },
        },
      ],
      enabled: false,
    };
    const e = parseDynamicEffect(raw);
    expect(e.enabled).toBe(false);
    expect(e.arms[0].when).toEqual([
      { kind: "state", nodeId: "door", channel: "power", op: "eq", value: true },
      { kind: "sensor", nodeId: "th", channel: "temperature", op: "gt", value: 28 },
    ]);
  });
});
