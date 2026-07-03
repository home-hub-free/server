/**
 * Camera control proxy (docs/CAMERA_ONVIF_CONTROL_PLAN.md §2/§4) — the AUTH + AUDIT
 * boundary for the vision-service's ONVIF seam.
 *
 * The vision-service (:8130) is the only thing that speaks SOAP to the cameras; its
 * control routes are open on the LAN, so the DASHBOARD comes through here instead:
 * `requireAuth` resolves the member (or admits the agent via HUB_SERVICE_TOKEN), the
 * call is forwarded verbatim, and on success the actuation is emitted on the ingestion
 * bus (`camera_control` channel, `source` dashboard/llm + `meta.actor`) so a physical
 * repoint is auditable exactly like a device write. Reads (`/controls`) stay open,
 * matching the house rule that GETs are unauthenticated.
 *
 * Vision-service error contract is forwarded as-is: 404 unknown camera · 409 not
 * PTZ/ONVIF-capable ({ptz:false}) · 503 camera unreachable · 502 camera fault.
 */
import { Express, Request, Response } from "express";
import axios, { Method } from "axios";
import { requireAuth } from "../auth/middleware";
import { emitCameraControl, EventMeta, IngestionSource } from "../clients/ingestion";

const VISION_URL = process.env.VISION_URL || "http://127.0.0.1:8130";
const TIMEOUT = 8000; // above the vision-side ONVIF timeout so its 503s arrive as 503s

/** Attribute the actuation: a member session → dashboard + actor; a service-token
 * caller (the agent / scheduler — requireAuth admits it with no req.user) → llm. */
function attribution(request: Request): { source: IngestionSource; meta: EventMeta } {
  if (request.user) {
    return {
      source: "dashboard",
      meta: { actor: { id: request.user.id, name: request.user.displayName || request.user.username } },
    };
  }
  return { source: "llm", meta: {} };
}

/** Forward one call to the vision-service, mirroring its status/body back. Returns the
 * response body on 2xx (for the audit emit), null otherwise. 5xx from the service is
 * passed through; a dead service maps to 502. */
async function forward(
  request: Request,
  response: Response,
  method: Method,
  path: string,
  body?: unknown,
): Promise<any | null> {
  try {
    const r = await axios.request({
      method,
      url: `${VISION_URL}${path}`,
      data: body,
      timeout: TIMEOUT,
      validateStatus: () => true, // mirror everything, even 4xx/5xx
    });
    response.status(r.status).send(r.data);
    return r.status >= 200 && r.status < 300 ? r.data : null;
  } catch {
    response.status(502).send({ error: "vision-service unreachable" });
    return null;
  }
}

export function initCameraRoutes(app: Express): void {
  const camId = (request: Request) => encodeURIComponent(request.params.id);

  // One-shot control summary for the dashboard tile: capabilities + presets +
  // imaging + aim. Open read (the tile renders before login; controls stay gated).
  app.get("/camera/:id/controls", async (request, response) => {
    await forward(request, response, "get", `/camctl/${camId(request)}`);
  });

  app.post("/camera/:id/ptz/move", requireAuth, async (request, response) => {
    const { vx = 0, vy = 0, ttl_ms = 500 } = request.body ?? {};
    const data = await forward(request, response, "post",
      `/ptz/${camId(request)}/move`, { vx, vy, ttl_ms });
    if (data) {
      const { source, meta } = attribution(request);
      emitCameraControl(request.params.id, data.zone || "", "ptz_move",
        { vx: data.vx, vy: data.vy, ttl_s: data.ttl_s }, source, meta);
    }
  });

  // Stop is the tail of a move (or a panic tap) — forwarded but not audited
  // separately; the move already carries the audit record.
  app.post("/camera/:id/ptz/stop", requireAuth, async (request, response) => {
    await forward(request, response, "post", `/ptz/${camId(request)}/stop`);
  });

  app.post("/camera/:id/ptz/goto", requireAuth, async (request, response) => {
    const token = String(request.body?.token ?? "");
    const data = await forward(request, response, "post",
      `/ptz/${camId(request)}/goto`, { token });
    if (data) {
      const { source, meta } = attribution(request);
      emitCameraControl(request.params.id, data.zone || "", "ptz_goto_preset", { token }, source, meta);
    }
  });

  app.post("/camera/:id/ptz/preset", requireAuth, async (request, response) => {
    const name = String(request.body?.name ?? "");
    const data = await forward(request, response, "post",
      `/ptz/${camId(request)}/preset`, { name });
    if (data) {
      const { source, meta } = attribution(request);
      emitCameraControl(request.params.id, data.zone || "", "ptz_save_preset",
        { name, token: data.token }, source, meta);
    }
  });

  app.delete("/camera/:id/ptz/preset/:token", requireAuth, async (request, response) => {
    const data = await forward(request, response, "delete",
      `/ptz/${camId(request)}/preset/${encodeURIComponent(request.params.token)}`);
    if (data) {
      const { source, meta } = attribution(request);
      emitCameraControl(request.params.id, data.zone || "", "ptz_delete_preset",
        { token: request.params.token }, source, meta);
    }
  });

  app.post("/camera/:id/imaging", requireAuth, async (request, response) => {
    const { brightness, saturation, contrast, sharpness, ir_cut } = request.body ?? {};
    const data = await forward(request, response, "post",
      `/imaging/${camId(request)}`, { brightness, saturation, contrast, sharpness, ir_cut });
    if (data) {
      const { source, meta } = attribution(request);
      emitCameraControl(request.params.id, data.zone || "", "imaging_set",
        { brightness, saturation, contrast, sharpness, ir_cut }, source, meta);
    }
  });
}
