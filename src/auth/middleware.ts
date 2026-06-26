import { NextFunction, Request, Response } from "express";
import crypto from "crypto";
import { usersRepo, PublicUser } from "../db/users.repo";

/**
 * Bearer-token auth for the dashboard-facing surface. The ESP fleet is NOT
 * authenticated (firmware has no token), so these guards are applied per-route to
 * dashboard mutations only — device/sensor reporting routes stay open.
 *
 * Trusted internal services (the llm-gateway agent, the hub's own scheduler) are
 * not human users with a session, so they authenticate with a shared secret in
 * `HUB_SERVICE_TOKEN` presented as the `X-Hub-Service-Token` header. When that env
 * is set, the agent MUST present it; when unset we fall back to trusting the
 * request body's `source` field (the original, spoofable-but-LAN-only behaviour).
 */

const SERVICE_TOKEN = process.env.HUB_SERVICE_TOKEN || "";

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      user?: PublicUser;
    }
  }
}

/** Pull the bearer token from `Authorization: Bearer <t>` or `x-auth-token`. */
function readToken(req: Request): string {
  const header = req.headers["authorization"];
  if (typeof header === "string" && header.startsWith("Bearer ")) {
    return header.slice("Bearer ".length).trim();
  }
  const alt = req.headers["x-auth-token"];
  return typeof alt === "string" ? alt.trim() : "";
}

/** Constant-time string compare that fails closed on a length mismatch. */
function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return crypto.timingSafeEqual(ab, bb);
}

/**
 * True when the request carries the shared service token (header
 * `X-Hub-Service-Token`). Always false when `HUB_SERVICE_TOKEN` is unset, so the
 * hatch only exists once an operator opts in.
 */
export function isServiceCaller(req: Request): boolean {
  if (!SERVICE_TOKEN) return false;
  const presented = req.headers["x-hub-service-token"];
  if (typeof presented !== "string" || !presented) return false;
  return safeEqual(presented.trim(), SERVICE_TOKEN);
}

/** Resolve identity if a valid token is present; never blocks the request. */
export function attachUser(req: Request, _res: Response, next: NextFunction): void {
  const user = usersRepo.resolveSession(readToken(req));
  if (user) req.user = user;
  next();
}

/**
 * Require a valid session (or the shared service token for trusted internal
 * callers); 401 otherwise. Attaches `req.user` when a human session is present.
 */
export function requireAuth(req: Request, res: Response, next: NextFunction): void {
  const user = usersRepo.resolveSession(readToken(req));
  if (user) {
    req.user = user;
    return next();
  }
  if (isServiceCaller(req)) return next();
  res.status(401).json({ error: "unauthorized" });
}

/**
 * For the shared actuation route (`/device-update`): a *dashboard* write must be
 * a logged-in member (so we can attribute it), but the llm-gateway agent and the
 * hub's own scheduler are trusted internal callers and must not be blocked by login.
 * Attaches `req.user` when a session is present so the actor can still be recorded.
 *
 * Internal callers authenticate with the `X-Hub-Service-Token` shared secret. As a
 * migration fallback, when `HUB_SERVICE_TOKEN` is unset we still trust an
 * `llm|voice|system` `source` in the body (the original behaviour), so enabling the
 * token is a no-break opt-in: set the env + have the gateway send the header.
 */
export function requireActor(req: Request, res: Response, next: NextFunction): void {
  const user = usersRepo.resolveSession(readToken(req));
  if (user) req.user = user;
  if (user || isServiceCaller(req)) return next();

  // No session and no service token: fall back to trusting the source field only
  // while the shared secret is not configured.
  const source = req.body?.source;
  const internal = source === "llm" || source === "voice" || source === "system";
  if (!SERVICE_TOKEN && internal) return next();

  res.status(401).json({ error: "unauthorized" });
}
