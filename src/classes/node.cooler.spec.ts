// Evap-cooler write integrity: the channel/whole-value writes must never drop a
// sibling channel (the `target`-loss bug), must clamp `target` to range, and a
// `setting`-role write must NOT latch `manual` (which would freeze the closed
// loop). Mock the side-effectful seams so a Node unit-builds in isolation.
const emit = jest.fn();
const axiosGet = jest.fn((..._a: any[]) => Promise.resolve({ data: {} }));
jest.mock("../handlers/websockets.handler", () => ({ io: { emit: (...a: any[]) => emit(...a) } }));
jest.mock("../clients/ingestion", () => ({ emitSensorEvent: jest.fn(), emitDeviceState: jest.fn() }));
jest.mock("../handlers/daily-events.handler", () => ({ dailyEvents: {} }));
jest.mock("axios", () => ({ __esModule: true, default: { get: (url: string) => axiosGet(url) } }));

import { Node } from "./node.class";

function cooler(): Node {
  const n = new Node("c1", "evap-cooler");
  (n as any).ip = "10.0.0.9"; // assign after construction (no actuation on build)
  return n;
}

beforeEach(() => {
  emit.mockClear();
  axiosGet.mockClear();
});

describe("evap-cooler channel writes (target-loss fix)", () => {
  it("a channel write folds + preserves every sibling channel", async () => {
    const node = cooler();
    expect(node.value).toEqual({ fan: false, water: false, target: 26, "unit-temp": 0, "room-temp": 0 });
    await node.setChannel("fan", true, "dashboard", true);
    expect(node.value).toEqual({ fan: true, water: false, target: 26, "unit-temp": 0, "room-temp": 0 });
  });

  it("clamps an out-of-range target write into [16,30]", async () => {
    const node = cooler();
    await node.setChannel("target", 45, "dashboard", false);
    expect(node.value.target).toBe(30);
    await node.setChannel("target", 5, "dashboard", false);
    expect(node.value.target).toBe(16);
  });

  it("a setting-role target write does NOT latch manual (closed loop stays live)", async () => {
    const node = cooler();
    // Route passes latchManual=false for a `setting` channel; mirror that here.
    await node.setChannel("target", 22, "dashboard", false);
    expect(node.manual).toBe(false);
    expect(node.value.target).toBe(22);
  });

  it("an actuator override (fan) latches manual", async () => {
    const node = cooler();
    await node.setChannel("fan", true, "dashboard", true);
    expect(node.manual).toBe(true);
  });

  it("a partial whole-value write merges instead of replacing (no dropped target)", async () => {
    const node = cooler();
    (node as any).value = { fan: false, water: false, target: 24, "unit-temp": 20, "room-temp": 23 };
    await node.manualTrigger({ fan: true, "unit-temp": 21, "room-temp": 23 }, "dashboard");
    expect(node.value.target).toBe(24); // survived the partial write
    expect(node.value.fan).toBe(true);
  });
});
