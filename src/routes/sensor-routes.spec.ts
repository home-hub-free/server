/**
 * /sensor-declare response contract: mirrors /device-declare — the hub returns
 * the config it owns for the device to ADOPT at runtime (zone; and for presence
 * sensors the activity-LED flag, PRESENCE_LED). Old firmware ignored the
 * previous `true` body, so the shape change is compatible; new firmware parses
 * `ledOnActive` to decide whether the onboard LED mirrors detection.
 * Same pure-function harness as camera-routes.spec (handlers off a fake app).
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
}));

import { initSensorRoutes } from "./sensor-routes";
import { nodes, findNode, buildClientSensorData } from "../handlers/node.handler";

type Handler = (req: any, res: any) => any;
const handlers: Record<string, Handler> = {};
const fakeApp: any = {
  get: (path: string, ...h: Handler[]) => (handlers[`GET ${path}`] = h[h.length - 1]),
  post: (path: string, ...h: Handler[]) => (handlers[`POST ${path}`] = h[h.length - 1]),
};
initSensorRoutes(fakeApp);

function fakeRes() {
  const res: any = { statusCode: 200 };
  res.status = (s: number) => ((res.statusCode = s), res);
  res.send = (b: any) => ((res.body = b), res);
  return res;
}

function declare(body: any) {
  const res = fakeRes();
  handlers["POST /sensor-declare"]({ body, ip: "::ffff:192.168.1.60" }, res);
  return res;
}

beforeEach(() => {
  nodes.length = 0;
});

describe("/sensor-declare response — hub-owned config adoption", () => {
  it("presence: carries the activity-LED flag, defaulting ON", () => {
    const res = declare({ id: "p1", name: "presence" });
    expect(res.body).toEqual({ ok: true, zone: null, ledOnActive: true });
  });

  it("presence: reflects the configured LED-off + assigned zone on the heartbeat", () => {
    declare({ id: "p1", name: "presence" });
    const set = fakeRes();
    handlers["POST /sensors-data-set"](
      { body: { id: "p1", data: { ledOnActive: false, zone: "sala" } } },
      set,
    );
    expect(set.body).toBe(true);
    const res = declare({ id: "p1", name: "presence" });
    expect(res.body).toEqual({ ok: true, zone: "sala", ledOnActive: false });
  });

  it("non-presence sensors: no ledOnActive key", () => {
    const res = declare({ id: "m1", name: "motion" });
    expect(res.body.ok).toBe(true);
    expect("ledOnActive" in res.body).toBe(false);
  });
});

describe("ledOnActive plumbing", () => {
  it("ships on the sensor client payload and survives a hub restart", () => {
    declare({ id: "p1", name: "presence" });
    handlers["POST /sensors-data-set"](
      { body: { id: "p1", data: { ledOnActive: false } } },
      fakeRes(),
    );
    expect(buildClientSensorData(findNode("p1")!)).toMatchObject({ ledOnActive: false });

    // A restart re-creates the node from the persisted record (mergeDBData via
    // Node.loadRecord, wired to NodesDB) — the setting must come back.
    nodes.length = 0;
    const res = declare({ id: "p1", name: "presence" });
    expect(res.body.ledOnActive).toBe(false);
  });
});
