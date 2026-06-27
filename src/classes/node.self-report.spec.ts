// A device's OWN state report (POST /device-value-set) must not wake the agent when the
// device runs a hub-side closed loop (the evap-cooler): coolerControl already governs its
// fan/water, so its periodic temp/state reports are a chain the reactive agent stays blind
// to. The route stamps those reports `coveredByEffect` (drop-from-reaction / keep-in-memory,
// PATTERN_LIFECYCLE §D2); every other device's report stays an honest, wake-eligible event.
// Mock the side-effectful seams so node.class unit-builds in isolation.
jest.mock("../handlers/websockets.handler", () => ({ io: { emit: jest.fn() } }));
jest.mock("../clients/ingestion", () => ({ emitSensorEvent: jest.fn(), emitDeviceState: jest.fn() }));
jest.mock("../handlers/daily-events.handler", () => ({ dailyEvents: {} }));
jest.mock("axios", () => ({ __esModule: true, default: { get: () => Promise.resolve({ data: {} }) } }));

import { deviceSelfReportMeta, CLOSED_LOOP_CATEGORIES } from "./node.class";

describe("device self-report ingestion meta", () => {
  it("stamps a closed-loop device (evap-cooler) coveredByEffect so the agent stays blind to its loop", () => {
    expect(deviceSelfReportMeta("evap-cooler")).toEqual({ coveredByEffect: true });
  });

  it("leaves a normal device's report unflagged (honest source:device — still wakes the agent)", () => {
    expect(deviceSelfReportMeta("light")).toEqual({});
    expect(deviceSelfReportMeta("dimmable-light")).toEqual({});
    expect(deviceSelfReportMeta("blinds")).toEqual({});
  });

  it("treats every closed-loop category consistently", () => {
    for (const c of CLOSED_LOOP_CATEGORIES) {
      expect(deviceSelfReportMeta(c)).toEqual({ coveredByEffect: true });
    }
  });
});
