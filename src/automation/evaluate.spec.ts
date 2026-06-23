import { conditionMet, evaluate, isCoveredByEffect, ChannelReader } from "./evaluate";
import type { EffectOp, NormalizedEffect } from "../db/effects-normalize";

// Build a ChannelReader from a flat {"node:channel": value} map.
const reader = (state: Record<string, boolean | number>): ChannelReader => (n, c) =>
  state[`${n}:${c}`];

const sensorEffect = (
  whenNode: string,
  whenChannel: string,
  op: EffectOp,
  whenValue: boolean | number,
  setNode: string,
  setChannel: string,
  setValue: boolean | number,
  enabled = true,
): NormalizedEffect => ({
  when: { source: "sensor", nodeId: whenNode, channel: whenChannel, op, value: whenValue },
  set: { nodeId: setNode, channel: setChannel, value: setValue },
  enabled,
});

describe("conditionMet", () => {
  it("compares booleans by identity (presence on/off edges)", () => {
    expect(conditionMet(true, "eq", true)).toBe(true);
    expect(conditionMet(false, "eq", true)).toBe(false);
    expect(conditionMet(false, "eq", false)).toBe(true);
  });

  it("compares numbers, coercing stringy readings", () => {
    expect(conditionMet(29 as any, "gt", 28)).toBe(true);
    expect(conditionMet("29.5" as any, "gt", 28)).toBe(true);
    expect(conditionMet(27, "gt", 28)).toBe(false);
    expect(conditionMet(35, "lt", 40)).toBe(true);
    expect(conditionMet(45, "lt", 40)).toBe(false);
  });
});

describe("evaluate — golden parity with the legacy engine", () => {
  // --- boolean (presence/motion) sensor: edge-driven on/off effects ---

  it("presence→on turns on a light that is currently off", () => {
    const effects = [sensorEffect("pir-sala", "presence", "eq", true, "light-sala", "power", true)];
    const actions = evaluate(
      effects,
      { nodeId: "pir-sala", channel: "presence", value: true },
      reader({ "light-sala:power": false }),
    );
    expect(actions).toEqual([{ nodeId: "light-sala", channel: "power", value: true }]);
  });

  it("does NOT re-fire when the light is already on (legacy hasChanges guard)", () => {
    const effects = [sensorEffect("pir-sala", "presence", "eq", true, "light-sala", "power", true)];
    const actions = evaluate(
      effects,
      { nodeId: "pir-sala", channel: "presence", value: true },
      reader({ "light-sala:power": true }),
    );
    expect(actions).toEqual([]);
  });

  it("presence→off only fires the off-rule, not the on-rule (edge semantics)", () => {
    const effects = [
      sensorEffect("pir-sala", "presence", "eq", true, "light-sala", "power", true),
      sensorEffect("pir-sala", "presence", "eq", false, "light-sala", "power", false),
    ];
    const actions = evaluate(
      effects,
      { nodeId: "pir-sala", channel: "presence", value: false },
      reader({ "light-sala:power": true }),
    );
    expect(actions).toEqual([{ nodeId: "light-sala", channel: "power", value: false }]);
  });

  // --- temp/humidity value sensor: gt/lt re-evaluated per reading ---

  it("temperature gt 28 turns the cooler fan on (reading 29.5)", () => {
    const effects = [sensorEffect("th-sala", "temperature", "gt", 28, "cooler-sala", "fan", true)];
    const actions = evaluate(
      effects,
      { nodeId: "th-sala", channel: "temperature", value: 29.5 },
      reader({ "cooler-sala:fan": false }),
    );
    expect(actions).toEqual([{ nodeId: "cooler-sala", channel: "fan", value: true }]);
  });

  it("temperature gt 28 does nothing below threshold (reading 27)", () => {
    const effects = [sensorEffect("th-sala", "temperature", "gt", 28, "cooler-sala", "fan", true)];
    const actions = evaluate(
      effects,
      { nodeId: "th-sala", channel: "temperature", value: 27 },
      reader({ "cooler-sala:fan": false }),
    );
    expect(actions).toEqual([]);
  });

  it("temperature gt 28 met but fan already on → no action", () => {
    const effects = [sensorEffect("th-sala", "temperature", "gt", 28, "cooler-sala", "fan", true)];
    const actions = evaluate(
      effects,
      { nodeId: "th-sala", channel: "temperature", value: 29.5 },
      reader({ "cooler-sala:fan": true }),
    );
    expect(actions).toEqual([]);
  });

  it("humidity lt 40 fires (reading 35) — the valueToSet sub-key is now just the channel", () => {
    const effects = [sensorEffect("th-sala", "humidity", "lt", 40, "cooler-sala", "water", true)];
    const actions = evaluate(
      effects,
      { nodeId: "th-sala", channel: "humidity", value: 35 },
      reader({ "cooler-sala:water": false }),
    );
    expect(actions).toEqual([{ nodeId: "cooler-sala", channel: "water", value: true }]);
  });

  // --- routing / filtering ---

  it("ignores effects whose when-channel didn't change", () => {
    const effects = [sensorEffect("th-sala", "humidity", "lt", 40, "cooler-sala", "water", true)];
    const actions = evaluate(
      effects,
      { nodeId: "th-sala", channel: "temperature", value: 35 }, // temperature changed, not humidity
      reader({ "cooler-sala:water": false }),
    );
    expect(actions).toEqual([]);
  });

  it("ignores effects for a different node", () => {
    const effects = [sensorEffect("pir-sala", "presence", "eq", true, "light-sala", "power", true)];
    const actions = evaluate(
      effects,
      { nodeId: "pir-recamara", channel: "presence", value: true },
      reader({ "light-sala:power": false }),
    );
    expect(actions).toEqual([]);
  });

  it("skips disabled rules", () => {
    const effects = [sensorEffect("pir-sala", "presence", "eq", true, "light-sala", "power", true, false)];
    const actions = evaluate(
      effects,
      { nodeId: "pir-sala", channel: "presence", value: true },
      reader({ "light-sala:power": false }),
    );
    expect(actions).toEqual([]);
  });

  it("ignores time-source conditions", () => {
    const effects: NormalizedEffect[] = [
      { when: { source: "time", at: "sunset" }, set: { nodeId: "light-sala", channel: "power", value: true }, enabled: true },
    ];
    const actions = evaluate(
      effects,
      { nodeId: "light-sala", channel: "power", value: false },
      reader({ "light-sala:power": false }),
    );
    expect(actions).toEqual([]);
  });

  it("fans one sensor change out to multiple matching targets", () => {
    const effects = [
      sensorEffect("pir-sala", "presence", "eq", true, "light-sala", "power", true),
      sensorEffect("pir-sala", "presence", "eq", true, "lamp-sala", "power", true),
    ];
    const actions = evaluate(
      effects,
      { nodeId: "pir-sala", channel: "presence", value: true },
      reader({ "light-sala:power": false, "lamp-sala:power": false }),
    );
    expect(actions).toEqual([
      { nodeId: "light-sala", channel: "power", value: true },
      { nodeId: "lamp-sala", channel: "power", value: true },
    ]);
  });
});

describe("isCoveredByEffect — trigger-side suppression", () => {
  const presenceRule = sensorEffect("pir-sala", "presence", "eq", true, "light-sala", "power", true);

  it("covers a trigger that matches an enabled rule's WHEN clause", () => {
    expect(isCoveredByEffect([presenceRule], { nodeId: "pir-sala", channel: "presence", value: true })).toBe(true);
  });

  it("covers even when the target already holds the value (where evaluate yields no action)", () => {
    // The crux: motion edge fires the rule, but the light is already on, so `evaluate`
    // returns []. Coverage must still be true so the trigger doesn't wake the agent.
    const event = { nodeId: "pir-sala", channel: "presence", value: true };
    expect(evaluate([presenceRule], event, reader({ "light-sala:power": true }))).toEqual([]);
    expect(isCoveredByEffect([presenceRule], event)).toBe(true);
  });

  it("does NOT cover an unmatched condition (temp below threshold)", () => {
    const tempRule = sensorEffect("th-sala", "temperature", "gt", 28, "cooler-sala", "fan", true);
    expect(isCoveredByEffect([tempRule], { nodeId: "th-sala", channel: "temperature", value: 27 })).toBe(false);
    expect(isCoveredByEffect([tempRule], { nodeId: "th-sala", channel: "temperature", value: 29.5 })).toBe(true);
  });

  it("does NOT cover a different node, a different channel, a disabled rule, or a time rule", () => {
    const timeRule: NormalizedEffect = {
      when: { source: "time", at: "sunset" }, set: { nodeId: "light-sala", channel: "power", value: true }, enabled: true,
    };
    const disabled = sensorEffect("pir-sala", "presence", "eq", true, "light-sala", "power", true, false);
    expect(isCoveredByEffect([presenceRule], { nodeId: "pir-recamara", channel: "presence", value: true })).toBe(false);
    expect(isCoveredByEffect([presenceRule], { nodeId: "pir-sala", channel: "motion", value: true })).toBe(false);
    expect(isCoveredByEffect([disabled], { nodeId: "pir-sala", channel: "presence", value: true })).toBe(false);
    expect(isCoveredByEffect([timeRule], { nodeId: "light-sala", channel: "power", value: true })).toBe(false);
  });
});
