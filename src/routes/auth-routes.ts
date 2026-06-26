import { Express } from "express";
import { usersRepo, UserPrefs } from "../db/users.repo";
import { verifyPassword } from "../auth/passwords";
import { requireAuth } from "../auth/middleware";

/**
 * Simple household login. Password + opaque bearer token; a seeded roster
 * managed in the dashboard settings (no public signup). Each user carries a
 * `prefs` blob ({ tone }) the LLM agent reads to personalise replies.
 */
export function initAuthRoutes(app: Express) {
  // ── login / session ───────────────────────────────────────────────────────
  app.post("/auth/login", (req, res) => {
    const { username, password } = req.body || {};
    if (!username || !password) {
      return res.status(400).json({ error: "username and password required" });
    }
    const row = usersRepo.getRowByUsername(String(username));
    if (!row || !verifyPassword(String(password), row.pass_hash)) {
      return res.status(401).json({ error: "invalid credentials" });
    }
    const token = usersRepo.createSession(row.id);
    return res.json({ token, user: usersRepo.getById(row.id) });
  });

  app.post("/auth/logout", requireAuth, (req, res) => {
    const header = req.headers["authorization"];
    const token =
      typeof header === "string" && header.startsWith("Bearer ")
        ? header.slice(7).trim()
        : String(req.headers["x-auth-token"] || "");
    if (token) usersRepo.deleteSession(token);
    res.json({ ok: true });
  });

  app.get("/auth/me", requireAuth, (req, res) => {
    res.json({ user: req.user });
  });

  // ── household roster (any signed-in member can manage; home LAN) ────────────
  app.get("/auth/users", requireAuth, (_req, res) => {
    res.json({ users: usersRepo.list() });
  });

  app.post("/auth/users", requireAuth, (req, res) => {
    const { username, displayName, password, prefs } = req.body || {};
    if (!username || !password) {
      return res.status(400).json({ error: "username and password required" });
    }
    try {
      const user = usersRepo.create({
        username: String(username),
        displayName: displayName ? String(displayName) : undefined,
        password: String(password),
        prefs: (prefs as UserPrefs) || {},
      });
      return res.status(201).json({ user });
    } catch (err: any) {
      // UNIQUE(username) or invalid slug.
      return res.status(409).json({ error: err?.message || "could not create user" });
    }
  });

  app.patch("/auth/users/:id", requireAuth, (req, res) => {
    const { id } = req.params;
    if (!usersRepo.getById(id)) return res.status(404).json({ error: "not found" });
    const { displayName, prefs, password } = req.body || {};
    if (typeof displayName === "string") usersRepo.updateDisplayName(id, displayName);
    if (prefs && typeof prefs === "object") usersRepo.updatePrefs(id, prefs as UserPrefs);
    if (typeof password === "string" && password) usersRepo.setPassword(id, password);
    return res.json({ user: usersRepo.getById(id) });
  });

  app.delete("/auth/users/:id", requireAuth, (req, res) => {
    const { id } = req.params;
    if (!usersRepo.getById(id)) return res.status(404).json({ error: "not found" });
    // Don't let the roster be emptied — there must always be a way back in.
    if (usersRepo.list().length <= 1) {
      return res.status(409).json({ error: "cannot remove the last user" });
    }
    usersRepo.remove(id);
    return res.json({ ok: true });
  });
}
