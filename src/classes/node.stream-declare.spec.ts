/**
 * captureStreamDeclare (CAMERA_VISION_PLAN §3.3): a camera's self-declared stream
 * block + firmware version land verbatim on the node (defaulted, validated, and
 * surfaced on toClientData) so the roster carries it for the box-side
 * vision-service. A malformed block must not throw into the hot declare path.
 */
// Mock the side-effectful seams so a Node unit-builds in isolation (same pattern as
// node.cooler.spec). Mocking daily-events.handler also breaks the v-assistant →
// node.handler import cycle that would otherwise crash the suite at load.
jest.mock("../handlers/websockets.handler", () => ({ io: { emit: jest.fn() } }));
jest.mock("../clients/ingestion", () => ({ emitSensorEvent: jest.fn(), emitDeviceState: jest.fn() }));
jest.mock("../handlers/daily-events.handler", () => ({ dailyEvents: {} }));
jest.mock("axios", () => ({ __esModule: true, default: { get: () => Promise.resolve({ data: {} }) } }));

import { Node, captureStreamDeclare } from "./node.class";

describe("captureStreamDeclare", () => {
  const makeCam = () => new Node("cam-sala", "camera");

  it("stores a well-formed stream block + fw_version and surfaces them on toClientData", () => {
    const cam = makeCam();
    captureStreamDeclare(cam, {
      fw_version: "1.4.2",
      stream: { proto: "mjpeg-http", port: 81, path: "/stream", snapshot: "/capture", res: "SVGA", fps: 10 },
    });

    expect(cam.fwVersion).toBe("1.4.2");
    expect(cam.stream).toEqual({
      proto: "mjpeg-http",
      port: 81,
      path: "/stream",
      snapshot: "/capture",
      res: "SVGA",
      fps: 10,
    });

    const client = cam.toClientData() as any;
    expect(client.stream.path).toBe("/stream");
    expect(client.fwVersion).toBe("1.4.2");
  });

  it("defaults proto/port when omitted but path is present", () => {
    const cam = makeCam();
    captureStreamDeclare(cam, { stream: { path: "/stream" } });
    expect(cam.stream).toEqual({ proto: "mjpeg-http", port: 81, path: "/stream" });
  });

  it("ignores a malformed stream block (no path) without throwing", () => {
    const cam = makeCam();
    expect(() => captureStreamDeclare(cam, { stream: { port: 81 } })).not.toThrow();
    expect(cam.stream).toBeNull();
    // A non-camera declare with no stream is a clean no-op.
    expect(() => captureStreamDeclare(cam, {})).not.toThrow();
    expect(cam.stream).toBeNull();
  });

  it("a node without a declared stream omits stream/fwVersion from toClientData", () => {
    const light = new Node("light-sala", "light");
    const client = light.toClientData() as any;
    expect(client.stream).toBeUndefined();
    expect(client.fwVersion).toBeUndefined();
  });
});
