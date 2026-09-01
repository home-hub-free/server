/**
 * POST /device-noise-mix — the R3 sibling of /device-blinds-configure: device
 * CURATION of a voice-satellite's sleep-sound layer mix (docs/plans/
 * SATELLITE_SLEEP_SOUNDS.md), deliberately off the channel bus. Same fake-app
 * harness as camera-routes.spec.ts / sensor-routes.spec.ts (handlers off a fake
 * app, the real Node class, in-memory test DB per src/db/connection.ts); axios +
 * volume-announce mocked per the style of node.volume-announce.spec.ts so the
 * locked-decision-5 regression (no volume announce from a noise-only write) can
 * be asserted without a real HTTP round-trip or debounce timer.
 */
jest.mock("../handlers/websockets.handler", () => ({ io: { emit: jest.fn() } }));
jest.mock("../clients/ingestion", () => ({
  ...jest.requireActual("../clients/ingestion"),
  emitSensorEvent: jest.fn(),
  emitDeviceState: jest.fn(),
}));
jest.mock("../handlers/daily-events.handler", () => ({ dailyEvents: {} }));
jest.mock("../auth/middleware", () => ({
  requireAuth: (_req: any, _res: any, next: any) => next(),
  requireActor: (_req: any, _res: any, next: any) => next(),
}));
const axiosGet = jest.fn((..._a: any[]) => Promise.resolve({ data: {} }));
jest.mock("axios", () => ({ __esModule: true, default: { get: (url: string) => axiosGet(url) } }));
const scheduleVolumeAnnounce = jest.fn();
jest.mock("../automation/volume-announce", () => ({
  scheduleVolumeAnnounce: (...a: any[]) => scheduleVolumeAnnounce(...a),
}));

import { initDeviceRoutes } from "./device-routes";
import { nodes } from "../handlers/node.handler";
import { Node } from "../classes/node.class";

type Handler = (req: any, res: any) => any;
const handlers: Record<string, Handler> = {};
const fakeApp: any = {
  get: (path: string, ...h: Handler[]) => (handlers[`GET ${path}`] = h[h.length - 1]),
  post: (path: string, ...h: Handler[]) => (handlers[`POST ${path}`] = h[h.length - 1]),
};
initDeviceRoutes(fakeApp);

function fakeRes() {
  const res: any = { statusCode: 200 };
  res.status = (s: number) => ((res.statusCode = s), res);
  res.send = (b: any) => ((res.body = b), res);
  return res;
}

const member = { id: "u1", username: "david", displayName: "David", prefs: {}, createdAt: "" };

const FULL_LAYERS = [
  { id: "white", on: false, level: 50 },
  { id: "pink", on: true, level: 45 },
  { id: "brown", on: false, level: 45 },
  { id: "rain", on: false, level: 35 },
  { id: "fan", on: false, level: 40 },
  { id: "ocean", on: false, level: 40 },
];

/** A noise-capable satellite, pre-seeded with a full 6-layer mix. `ip` is
 * assigned AFTER construction (no actuation on build — precision category, same
 * as node.volume-announce.spec.ts's helper). */
function satellite(id = "sat1"): Node {
  const n = new Node(id, "voice-satellite");
  (n as any).ip = "10.0.0.20";
  n.zone = "bebe";
  n.value = {
    volume: 55,
    mic: true,
    eco: true,
    battery: 80,
    noise: true,
    noiseLevel: 60,
    noiseTimerMin: 0,
    noiseLayers: FULL_LAYERS,
  };
  nodes.push(n);
  return n;
}

async function mixWrite(body: any) {
  const res = fakeRes();
  await handlers["POST /device-noise-mix"]({ body, user: member }, res);
  return res;
}

beforeEach(() => {
  nodes.length = 0;
  axiosGet.mockClear();
  scheduleVolumeAnnounce.mockClear();
  delete process.env.VOLUME_ANNOUNCE;
});

describe("POST /device-noise-mix (device curation, R3)", () => {
  it("merges a layer-mix write into the blob and pushes it to the device", async () => {
    satellite();
    const res = await mixWrite({
      id: "sat1",
      layers: [
        { id: "pink", on: false, level: 45 },
        { id: "rain", on: true, level: 60 },
      ],
    });

    expect(res.body.value.noiseLayers).toEqual([
      { id: "pink", on: false, level: 45 },
      { id: "rain", on: true, level: 60 },
    ]);
    // Untouched fields survive the merge (reconcileValueWrite, object-blob category).
    expect(res.body.value.volume).toBe(55);
    expect(res.body.value.noiseLevel).toBe(60);
    // The write actually reached the device (legacySetUrl, step 5.3's encoder).
    expect(axiosGet).toHaveBeenCalledWith(
      expect.stringContaining(`noiseLayers=${encodeURIComponent("-pink:45,rain:60")}`),
    );
  });

  it("rejects when the node is missing", async () => {
    const res = await mixWrite({ id: "nope", level: 50 });
    expect(res.body).toBe(false);
    expect(axiosGet).not.toHaveBeenCalled();
  });

  it("rejects a non-satellite node", async () => {
    const light = new Node("l1", "light");
    (light as any).ip = "10.0.0.5";
    nodes.push(light);
    const res = await mixWrite({ id: "l1", level: 50 });
    expect(res.body).toBe(false);
    expect(axiosGet).not.toHaveBeenCalled();
  });

  it("clamps level and timerMin into their wire ranges", async () => {
    satellite("sat1");
    const high = await mixWrite({ id: "sat1", level: 150, timerMin: 9999 });
    expect(high.body.value.noiseLevel).toBe(100);
    expect(high.body.value.noiseTimerMin).toBe(720);

    satellite("sat2");
    const low = await mixWrite({ id: "sat2", level: -20, timerMin: -5 });
    expect(low.body.value.noiseLevel).toBe(0);
    expect(low.body.value.noiseTimerMin).toBe(0);
  });

  it("never latches the manual lock", async () => {
    const node = satellite();
    expect(node.manual).toBe(false);
    await mixWrite({ id: "sat1", level: 40 });
    expect(node.manual).toBe(false);
  });

  it("does not touch value.volume and fires no volume announce (locked decision 5)", async () => {
    satellite();
    const res = await mixWrite({ id: "sat1", layers: FULL_LAYERS, level: 77, timerMin: 30 });
    expect(res.body.value.volume).toBe(55);
    expect(scheduleVolumeAnnounce).not.toHaveBeenCalled();
  });
});
