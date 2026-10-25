// Mock the side-effectful seams so node.class unit-builds in isolation (as node.self-report.spec does).
jest.mock("../handlers/websockets.handler", () => ({ io: { emit: jest.fn() } }));
jest.mock("../clients/ingestion", () => ({ emitSensorEvent: jest.fn(), emitDeviceState: jest.fn() }));
jest.mock("../handlers/daily-events.handler", () => ({ dailyEvents: {} }));

import { simDeviceAddress } from "./node.class";

describe("simDeviceAddress (house sim)", () => {
  const env = { ...process.env };
  afterEach(() => { process.env = { ...env }; });

  it("is undefined in prod, even with HUB_SIM_DEVICES set", () => {
    delete process.env.HUB_SIM;
    process.env.HUB_SIM_DEVICES = "http://127.0.0.1:8156";
    expect(simDeviceAddress("luz-cocina")).toBeUndefined();
  });

  it("is undefined in a plain sim (no emulator)", () => {
    process.env.HUB_SIM = "1";
    delete process.env.HUB_SIM_DEVICES;
    expect(simDeviceAddress("luz-cocina")).toBeUndefined();
  });

  it("routes each node to the emulator by id", () => {
    process.env.HUB_SIM = "1";
    process.env.HUB_SIM_DEVICES = "http://127.0.0.1:8156/";
    expect(simDeviceAddress("luz cocina")).toBe("127.0.0.1:8156/d/luz%20cocina");
  });
});
