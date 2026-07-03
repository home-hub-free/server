/**
 * /camera/:id proxy — the auth + audit contract (CAMERA_ONVIF_CONTROL_PLAN §2):
 *   1. actuations forward verbatim to the vision-service and MIRROR its status
 *      (404/409/503 pass through — the dashboard needs the {ptz:false} bodies);
 *   2. a successful actuation emits `camera_control` with source dashboard +
 *      meta.actor for a member session, source llm for a service-token caller;
 *   3. a FAILED forward emits nothing (no phantom audit records);
 *   4. a dead vision-service maps to 502, never a crash.
 * Same pure-function harness as assistant-chat-routes.spec (handlers off a fake app).
 */
import axios from "axios";

jest.mock("axios");
jest.mock("../auth/middleware", () => ({
  requireAuth: (_req: any, _res: any, next: any) => next(),
}));
jest.mock("../clients/ingestion", () => ({
  ...jest.requireActual("../clients/ingestion"),
  emitCameraControl: jest.fn(),
}));

import { initCameraRoutes } from "./camera-routes";
import { emitCameraControl } from "../clients/ingestion";

const mockedAxios = axios as jest.Mocked<typeof axios>;
const mockedEmit = emitCameraControl as jest.Mock;

type Handler = (req: any, res: any) => Promise<void>;
const handlers: Record<string, Handler> = {};
const fakeApp: any = {
  get: (path: string, h: Handler) => (handlers[`GET ${path}`] = h),
  post: (path: string, _auth: any, h: Handler) => (handlers[`POST ${path}`] = h),
  delete: (path: string, _auth: any, h: Handler) => (handlers[`DELETE ${path}`] = h),
};
initCameraRoutes(fakeApp);

function fakeRes() {
  const res: any = { statusCode: 200 };
  res.status = (s: number) => ((res.statusCode = s), res);
  res.send = (b: any) => ((res.body = b), res);
  return res;
}

const member = { id: "u1", username: "david", displayName: "David", prefs: {}, createdAt: "" };

describe("/camera/:id control proxy", () => {
  beforeEach(() => jest.clearAllMocks());

  it("forwards a move and audits it as dashboard + actor for a member session", async () => {
    mockedAxios.request.mockResolvedValueOnce({
      status: 200,
      data: { ok: true, cam_id: "mc200", zone: "entrance", vx: 0.5, vy: 0, ttl_s: 0.4 },
    } as any);
    const res = fakeRes();
    await handlers["POST /camera/:id/ptz/move"](
      { params: { id: "mc200" }, body: { vx: 0.5, vy: 0, ttl_ms: 400 }, user: member }, res);

    expect(mockedAxios.request).toHaveBeenCalledWith(expect.objectContaining({
      method: "post",
      url: "http://127.0.0.1:8130/ptz/mc200/move",
      data: { vx: 0.5, vy: 0, ttl_ms: 400 },
    }));
    expect(res.statusCode).toBe(200);
    expect(mockedEmit).toHaveBeenCalledWith(
      "mc200", "entrance", "ptz_move", { vx: 0.5, vy: 0, ttl_s: 0.4 },
      "dashboard", { actor: { id: "u1", name: "David" } });
  });

  it("audits a service-token caller (no req.user) as source llm", async () => {
    mockedAxios.request.mockResolvedValueOnce({
      status: 200, data: { ok: true, zone: "entrance" },
    } as any);
    await handlers["POST /camera/:id/ptz/goto"](
      { params: { id: "mc200" }, body: { token: "1" } }, fakeRes());
    expect(mockedEmit).toHaveBeenCalledWith(
      "mc200", "entrance", "ptz_goto_preset", { token: "1" }, "llm", {});
  });

  it("mirrors a vision-side 409 ({ptz:false}) and emits NO audit record", async () => {
    mockedAxios.request.mockResolvedValueOnce({
      status: 409, data: { detail: { ptz: false, error: "camera has no PTZ" } },
    } as any);
    const res = fakeRes();
    await handlers["POST /camera/:id/ptz/move"](
      { params: { id: "c110" }, body: { vx: 1 }, user: member }, res);
    expect(res.statusCode).toBe(409);
    expect(res.body.detail.ptz).toBe(false);
    expect(mockedEmit).not.toHaveBeenCalled();
  });

  it("maps a dead vision-service to 502 without emitting", async () => {
    mockedAxios.request.mockRejectedValueOnce(new Error("ECONNREFUSED"));
    const res = fakeRes();
    await handlers["POST /camera/:id/ptz/preset"](
      { params: { id: "mc200" }, body: { name: "door" }, user: member }, res);
    expect(res.statusCode).toBe(502);
    expect(mockedEmit).not.toHaveBeenCalled();
  });

  it("proxies the open controls read without auth or audit", async () => {
    mockedAxios.request.mockResolvedValueOnce({
      status: 200, data: { cam_id: "mc200", onvif: { ptz: true } },
    } as any);
    const res = fakeRes();
    await handlers["GET /camera/:id/controls"]({ params: { id: "mc200" } }, res);
    expect(res.body.onvif.ptz).toBe(true);
    expect(mockedEmit).not.toHaveBeenCalled();
  });

  it("audits an imaging write with the fields that were set", async () => {
    mockedAxios.request.mockResolvedValueOnce({
      status: 200, data: { ok: true, zone: "entrance", imaging: { brightness: 70 } },
    } as any);
    await handlers["POST /camera/:id/imaging"](
      { params: { id: "mc200" }, body: { brightness: 70 }, user: member }, fakeRes());
    expect(mockedEmit).toHaveBeenCalledWith(
      "mc200", "entrance", "imaging_set",
      expect.objectContaining({ brightness: 70 }), "dashboard",
      { actor: { id: "u1", name: "David" } });
  });
});
