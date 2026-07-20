// SATELLITE_VOLUME_FEEDBACK: Node.notify()'s volume-change hook must fire exactly
// when a voice-satellite's `volume` field changes AND the device round-trip ACKs AND
// source isn't "system" AND the VOLUME_ANNOUNCE kill switch isn't "false" — never on
// a mic/eco-only write, a failed device round-trip, or a system-sourced write (boot
// reconcile/schedules). Mock every side-effectful seam (matches node.cooler.spec.ts /
// node.self-report.spec.ts) plus the volume-announce module itself, so the hook is
// asserted without a real debounce timer or HTTP call.
const emit = jest.fn();
const axiosGet = jest.fn((..._a: any[]) => Promise.resolve({ data: {} }));
const scheduleVolumeAnnounce = jest.fn();
jest.mock("../handlers/websockets.handler", () => ({ io: { emit: (...a: any[]) => emit(...a) } }));
jest.mock("../clients/ingestion", () => ({ emitSensorEvent: jest.fn(), emitDeviceState: jest.fn() }));
jest.mock("../handlers/daily-events.handler", () => ({ dailyEvents: {} }));
jest.mock("axios", () => ({ __esModule: true, default: { get: (url: string) => axiosGet(url) } }));
jest.mock("../automation/volume-announce", () => ({
  scheduleVolumeAnnounce: (...a: any[]) => scheduleVolumeAnnounce(...a),
}));

import { Node } from "./node.class";

function satellite(id = "sat1", zone = "cocina"): Node {
  const n = new Node(id, "voice-satellite");
  (n as any).ip = "10.0.0.20"; // assign after construction (no actuation on build — precision category)
  n.zone = zone;
  return n;
}

beforeEach(() => {
  emit.mockClear();
  axiosGet.mockClear();
  scheduleVolumeAnnounce.mockClear();
  delete process.env.VOLUME_ANNOUNCE;
});

describe("Node.notify() volume-announce hook", () => {
  it("schedules an announce when a dashboard write changes volume", async () => {
    const node = satellite();
    const ok = await node.setChannel("volume", 45, "dashboard", false);
    expect(ok).toBe(true);
    expect(scheduleVolumeAnnounce).toHaveBeenCalledWith("sat1", "cocina", 45);
  });

  it("does not schedule when only mic changes (volume unchanged)", async () => {
    const node = satellite();
    await node.setChannel("mic", false, "dashboard", false);
    expect(scheduleVolumeAnnounce).not.toHaveBeenCalled();
  });

  it("does not schedule when only eco/flip change (volume unchanged)", async () => {
    const node = satellite();
    await node.setChannel("eco", false, "dashboard", false);
    expect(scheduleVolumeAnnounce).not.toHaveBeenCalled();
  });

  it("skips a system-sourced volume change (boot reconcile/schedules stay silent)", async () => {
    const node = satellite();
    await node.manualTrigger({ volume: 45, mic: true, eco: true }, "system");
    expect(scheduleVolumeAnnounce).not.toHaveBeenCalled();
  });

  it("announces a voice/llm/automation-sourced volume change (not just dashboard)", async () => {
    const node = satellite();
    await node.manualTrigger({ volume: 60, mic: true, eco: true }, "llm");
    expect(scheduleVolumeAnnounce).toHaveBeenCalledWith("sat1", "cocina", 60);
  });

  it("honors the VOLUME_ANNOUNCE=false kill switch", async () => {
    process.env.VOLUME_ANNOUNCE = "false";
    const node = satellite();
    await node.setChannel("volume", 70, "dashboard", false);
    expect(scheduleVolumeAnnounce).not.toHaveBeenCalled();
  });

  it("does not announce a failed device round-trip (value reverts)", async () => {
    axiosGet.mockImplementationOnce(() => Promise.reject(new Error("404")));
    const node = satellite();
    const ok = await node.setChannel("volume", 80, "dashboard", false);
    expect(ok).toBe(false);
    expect(scheduleVolumeAnnounce).not.toHaveBeenCalled();
  });

  it("fires through the channel-aware (notifyChannels) path too", async () => {
    const node = satellite();
    (node as any).channelAware = true;
    const ok = await node.setChannel("volume", 33, "dashboard", false);
    expect(ok).toBe(true);
    expect(scheduleVolumeAnnounce).toHaveBeenCalledWith("sat1", "cocina", 33);
  });

  it("never fires for a non-satellite category (light) even though value 'changes'", async () => {
    const light = new Node("l1", "light");
    (light as any).ip = "10.0.0.21";
    await light.manualTrigger(true, "dashboard");
    expect(scheduleVolumeAnnounce).not.toHaveBeenCalled();
  });
});
