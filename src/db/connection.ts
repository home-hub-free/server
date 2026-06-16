import Database from "better-sqlite3";
import fs from "fs";
import path from "path";
import { applySchema } from "./schema";

/**
 * Single shared SQLite connection for the hub's control-plane state (devices,
 * sensors, effects, assistant config). This replaces the per-file simple-json-db
 * stores. It is intentionally *local* to the hub: the control plane must keep
 * working even when the memory/LLM services are down — those are fed separately
 * through the (deferred) ingestion seam, never by pointing the hub at their DB.
 *
 * Path resolution:
 *  - HUB_DB_PATH overrides everything (used by tests / alt deployments).
 *  - Under Jest (NODE_ENV=test) we default to an isolated in-memory database so
 *    specs never touch the real db/ directory.
 *  - Otherwise the on-disk file at db/home-hub.db.
 *
 * The schema is applied at open time (idempotent) because a few modules read the
 * DB at import time (the assistant singleton, the bootstrap sensor), so the tables
 * must exist before the first query.
 */
const DB_DIR = "db";

function resolveDbPath(): string {
  if (process.env.HUB_DB_PATH) return process.env.HUB_DB_PATH;
  if (process.env.NODE_ENV === "test") return ":memory:";
  return path.join(DB_DIR, "home-hub.db");
}

const dbPath = resolveDbPath();
if (dbPath !== ":memory:") {
  const dir = path.dirname(dbPath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

export const db = new Database(dbPath);
db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");

applySchema(db);
