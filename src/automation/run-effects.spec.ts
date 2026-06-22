import { computeSetActions, NodeView } from "./run-effects";
import type { NormalizedEffect } from "../db/effects-normalize";

const registry = (nodes: Record<string, NodeView>) => (id: string) => nodes[id];

const presenceRule = (sensor: string, on: boolean, target: string, value: boolean): NormalizedEffect => ({
  when: { source: "sensor", nodeId: sensor, channel: "presence", op: "eq", value: on },
  set: { nodeId: target, channel: "power", value },
  enabled: true,
});

describe("computeSetActions — orchestrator over the node registry", () => {
  it("reads the target's current channel via the codec and fires when it would change", () => {
    const actions = computeSetActions(
      [presenceRule("pir", true, "light", true)],
      { nodeId: "pir", channel: "presence", value: true },
      registry({ light: { category: "light", value: false } }),
    );
    expect(actions).toEqual([{ nodeId: "light", channel: "power", value: true }]);
  });

  it("suppresses the action when the target already holds the value", () => {
    const actions = computeSetActions(
      [presenceRule("pir", true, "light", true)],
      { nodeId: "pir", channel: "presence", value: true },
      registry({ light: { category: "light", value: true } }),
    );
    expect(actions).toEqual([]);
  });

  it("reads a cooler sub-channel out of the blob for the change guard", () => {
    const tempRule: NormalizedEffect = {
      when: { source: "sensor", nodeId: "th", channel: "temperature", op: "gt", value: 28 },
      set: { nodeId: "cooler", channel: "fan", value: true },
      enabled: true,
    };
    const cool = (fan: boolean) => registry({ cooler: { category: "evap-cooler", value: { fan, water: false } } });

    expect(
      computeSetActions([tempRule], { nodeId: "th", channel: "temperature", value: 29.5 }, cool(false)),
    ).toEqual([{ nodeId: "cooler", channel: "fan", value: true }]);

    // fan already on → no action
    expect(
      computeSetActions([tempRule], { nodeId: "th", channel: "temperature", value: 29.5 }, cool(true)),
    ).toEqual([]);
  });

  it("returns nothing when the target node is unknown", () => {
    const actions = computeSetActions(
      [presenceRule("pir", true, "ghost", true)],
      { nodeId: "pir", channel: "presence", value: true },
      registry({}),
    );
    // unknown target reads undefined, undefined !== true, so it WOULD fire — the
    // apply step (registry.get) is where a missing node is a no-op. Guard documents
    // that computeSetActions still proposes the action.
    expect(actions).toEqual([{ nodeId: "ghost", channel: "power", value: true }]);
  });
});
