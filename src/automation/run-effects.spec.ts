import { computeSetActions, computeTimeActions, NodeView } from "./run-effects";
import type { Effect } from "./effect.model";

const registry = (nodes: Record<string, NodeView>) => (id: string) => nodes[id];

// A single-arm presence rule: trigger on the sensor's presence channel, act when it's `on`.
// Conditions read LIVE state, so the trigger node carries the current value (in production
// the node is updated before `automations` fires, so live state == the edge that woke it).
const presenceRule = (sensor: string, on: boolean, target: string, value: boolean): Effect => ({
  trigger: { source: "sensor", nodeId: sensor, channel: "presence" },
  arms: [
    {
      when: [{ kind: "sensor", nodeId: sensor, channel: "presence", op: "eq", value: on }],
      set: { nodeId: target, channel: "power", value },
    },
  ],
  enabled: true,
});

describe("computeSetActions — orchestrator over the node registry", () => {
  it("reads the target's current channel via the codec and fires when it would change", () => {
    const actions = computeSetActions(
      [presenceRule("pir", true, "light", true)],
      { nodeId: "pir", channel: "presence", value: true },
      registry({ pir: { category: "presence", value: true }, light: { category: "light", value: false } }),
    );
    expect(actions).toEqual([{ nodeId: "light", channel: "power", value: true }]);
  });

  it("suppresses the action when the target already holds the value", () => {
    const actions = computeSetActions(
      [presenceRule("pir", true, "light", true)],
      { nodeId: "pir", channel: "presence", value: true },
      registry({ pir: { category: "presence", value: true }, light: { category: "light", value: true } }),
    );
    expect(actions).toEqual([]);
  });

  it("reads a cooler sub-channel out of the blob for the change guard", () => {
    const tempRule: Effect = {
      trigger: { source: "sensor", nodeId: "th", channel: "temperature" },
      arms: [
        {
          when: [{ kind: "sensor", nodeId: "th", channel: "temperature", op: "gt", value: 28 }],
          set: { nodeId: "cooler", channel: "fan", value: true },
        },
      ],
      enabled: true,
    };
    const reg = (fan: boolean) =>
      registry({
        th: { category: "temp/humidity", value: "29.5:50" },
        cooler: { category: "evap-cooler", value: { fan, water: false } },
      });

    expect(
      computeSetActions([tempRule], { nodeId: "th", channel: "temperature", value: 29.5 }, reg(false)),
    ).toEqual([{ nodeId: "cooler", channel: "fan", value: true }]);

    // fan already on → no action
    expect(
      computeSetActions([tempRule], { nodeId: "th", channel: "temperature", value: 29.5 }, reg(true)),
    ).toEqual([]);
  });

  it("respects the manual lock — a user-controlled target is skipped (Stage 3)", () => {
    const actions = computeSetActions(
      [presenceRule("pir", true, "light", true)],
      { nodeId: "pir", channel: "presence", value: true },
      registry({
        pir: { category: "presence", value: true },
        light: { category: "light", value: false, manual: true }, // user grabbed the wheel
      }),
    );
    expect(actions).toEqual([]);
  });

  it("still fires on a target that is not manually locked", () => {
    const actions = computeSetActions(
      [presenceRule("pir", true, "light", true)],
      { nodeId: "pir", channel: "presence", value: true },
      registry({
        pir: { category: "presence", value: true },
        light: { category: "light", value: false, manual: false },
      }),
    );
    expect(actions).toEqual([{ nodeId: "light", channel: "power", value: true }]);
  });

  it("returns nothing when the target node is unknown", () => {
    const actions = computeSetActions(
      [presenceRule("pir", true, "ghost", true)],
      { nodeId: "pir", channel: "presence", value: true },
      registry({ pir: { category: "presence", value: true } }),
    );
    // unknown target reads undefined, undefined !== true, so it WOULD fire — the apply
    // step (registry lookup) is where a missing node is a no-op. Documents that
    // computeSetActions still proposes the action.
    expect(actions).toEqual([{ nodeId: "ghost", channel: "power", value: true }]);
  });

  it("time-triggered effects also respect the manual lock (Stage 3 consistency)", () => {
    const dimAt23: Effect = {
      trigger: { source: "time", at: "23:00" },
      arms: [{ when: [], set: { nodeId: "lamp", channel: "brightness", value: 20 } }],
      enabled: true,
    };
    const reg = (manual: boolean) =>
      registry({ lamp: { category: "dimmable-light", value: 100, manual } });

    expect(computeTimeActions([dimAt23], "23:00", reg(false))).toEqual([
      { nodeId: "lamp", channel: "brightness", value: 20 },
    ]);
    // user set the lamp by hand → the 23:00 transition does not override it
    expect(computeTimeActions([dimAt23], "23:00", reg(true))).toEqual([]);
  });
});
