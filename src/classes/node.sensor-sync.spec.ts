// Heartbeat reconvergence + boolean normalization for sensor nodes.
// Mock the two side-effectful seams so a Node can be unit-built in isolation.
const emit = jest.fn();
jest.mock("../handlers/websockets.handler", () => ({ io: { emit: (...a: any[]) => emit(...a) } }));
jest.mock("../clients/ingestion", () => ({
  emitSensorEvent: jest.fn(),
  emitDeviceState: jest.fn(),
}));
// daily-events.handler pulls in the node.handler/v-assistant cycle; stub it.
jest.mock("../handlers/daily-events.handler", () => ({ dailyEvents: {} }));

import { Node } from "./node.class";

function presence(id = "p1"): Node {
  return new Node(id, "presence");
}

beforeEach(() => emit.mockClear());

describe("boolean sensor value normalization (#3)", () => {
  it("coerces a legacy numeric restored value to a real boolean", () => {
    const node = presence();
    // Simulate a legacy DB record having seeded value=0.
    (node as any).value = 0;
    // Re-run the construction-time coercion by constructing fresh via loadRecord.
    Node.loadRecord = () => ({ value: 1 });
    const restored = presence("p2");
    expect(restored.value).toBe(true);
    Node.loadRecord = () => undefined;
    expect(node.value).toBe(0); // unchanged (only construction normalizes)
  });

  it("a fresh presence node starts as boolean false", () => {
    expect(presence().value).toBe(false);
  });
});

describe("Node.reconcile — heartbeat reconvergence (#2)", () => {
  it("heals a missed rising edge (server false, device reports active)", () => {
    const node = presence();
    expect(node.value).toBe(false);
    node.reconcile(1); // heartbeat carries the device's latched value
    expect(node.value).toBe(true);
    expect(emit).toHaveBeenCalledWith("sensor-update", { id: "p1", value: true });
  });

  it("is a no-op when already in sync (no redundant WS emit)", () => {
    const node = presence();
    node.reconcile(1);
    emit.mockClear();
    node.reconcile(1); // already true → nothing happens
    node.reconcile(true);
    expect(emit).not.toHaveBeenCalled();
  });

  it("is a no-op for an idle sensor reporting inactive", () => {
    const node = presence(); // value=false
    node.reconcile(0);
    expect(emit).not.toHaveBeenCalled();
  });

  it("ignores value sensors entirely (temp/humidity reconverges via /sensor-update)", () => {
    const th = new Node("t1", "temp/humidity");
    th.reconcile("21:55"); // would-be new reading
    expect(emit).not.toHaveBeenCalled();
    expect(th.value).not.toBe("21:55");
  });
});
