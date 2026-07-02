import { db } from "./connection";
import { hashPassword, newToken } from "../auth/passwords";

/**
 * Household members + login sessions (see schema.ts). Same prepared-statement
 * style as ConfigRepo. The hub is the single front door for the dashboard, so
 * identity lives here on the always-on control plane.
 *
 * `prefs` is a small JSON blob the LLM agent reads to personalise replies
 * (currently `{ tone }`); it round-trips verbatim so new keys need no migration.
 */

export interface UserPrefs {
  tone?: string;
  /** Morning-brief tuning (docs/BRIEFING_ROUTINE.md §3.5) — shape owned by briefing/driver.ts
   *  (`BriefPrefs`): { enabled, windowStart, windowEnd, depth }. Default-on when absent. */
  brief?: Record<string, unknown>;
  [key: string]: unknown;
}

/** A user as exposed to the dashboard / agent — never includes the password hash. */
export interface PublicUser {
  id: string;
  username: string;
  displayName: string;
  prefs: UserPrefs;
  createdAt: string;
}

interface UserRow {
  id: string;
  username: string;
  display_name: string;
  pass_hash: string;
  prefs: string;
  created_at: string;
}

function toPublic(row: UserRow): PublicUser {
  return {
    id: row.id,
    username: row.username,
    displayName: row.display_name,
    prefs: JSON.parse(row.prefs || "{}"),
    createdAt: row.created_at,
  };
}

/** Lowercase + strip to a stable id slug from a username. */
function slugify(username: string): string {
  return username
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

const insertStmt = db.prepare(
  `INSERT INTO users (id, username, display_name, pass_hash, prefs)
   VALUES (@id, @username, @display_name, @pass_hash, @prefs)`,
);
const byIdStmt = db.prepare("SELECT * FROM users WHERE id = ?");
const byUsernameStmt = db.prepare("SELECT * FROM users WHERE username = ?");
const listStmt = db.prepare("SELECT * FROM users ORDER BY created_at ASC");
const countStmt = db.prepare("SELECT COUNT(*) AS n FROM users");
const updatePrefsStmt = db.prepare(
  "UPDATE users SET prefs = ? WHERE id = ?",
);
const updateDisplayStmt = db.prepare(
  "UPDATE users SET display_name = ? WHERE id = ?",
);
const updatePassStmt = db.prepare(
  "UPDATE users SET pass_hash = ? WHERE id = ?",
);
const deleteStmt = db.prepare("DELETE FROM users WHERE id = ?");

const insertSessionStmt = db.prepare(
  "INSERT INTO sessions (token, user_id) VALUES (?, ?)",
);
const sessionUserStmt = db.prepare(
  `SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token = ?`,
);
const deleteSessionStmt = db.prepare("DELETE FROM sessions WHERE token = ?");

export interface CreateUserInput {
  username: string;
  displayName?: string;
  password: string;
  prefs?: UserPrefs;
}

export class UsersRepo {
  /** True when no users exist yet (first-boot seed guard). */
  isEmpty(): boolean {
    return (countStmt.get() as { n: number }).n === 0;
  }

  /** Create a member. Throws on duplicate username (UNIQUE constraint). */
  create(input: CreateUserInput): PublicUser {
    const id = slugify(input.username);
    if (!id) throw new Error("invalid username");
    insertStmt.run({
      id,
      username: input.username.trim(),
      display_name: (input.displayName || input.username).trim(),
      pass_hash: hashPassword(input.password),
      prefs: JSON.stringify(input.prefs || {}),
    });
    return toPublic(byIdStmt.get(id) as UserRow);
  }

  list(): PublicUser[] {
    return (listStmt.all() as UserRow[]).map(toPublic);
  }

  getById(id: string): PublicUser | undefined {
    const row = byIdStmt.get(id) as UserRow | undefined;
    return row ? toPublic(row) : undefined;
  }

  /** Internal: the raw row (with hash) for login verification. */
  getRowByUsername(username: string): UserRow | undefined {
    return byUsernameStmt.get(username.trim()) as UserRow | undefined;
  }

  updatePrefs(id: string, prefs: UserPrefs): PublicUser | undefined {
    updatePrefsStmt.run(JSON.stringify(prefs || {}), id);
    return this.getById(id);
  }

  updateDisplayName(id: string, displayName: string): PublicUser | undefined {
    updateDisplayStmt.run(displayName.trim(), id);
    return this.getById(id);
  }

  setPassword(id: string, password: string): void {
    updatePassStmt.run(hashPassword(password), id);
  }

  remove(id: string): void {
    deleteStmt.run(id); // sessions cascade (FK ON DELETE CASCADE)
  }

  // ── sessions ────────────────────────────────────────────────────────────
  createSession(userId: string): string {
    const token = newToken();
    insertSessionStmt.run(token, userId);
    return token;
  }

  /** Resolve a bearer token → the owning user, or undefined if unknown. */
  resolveSession(token: string): PublicUser | undefined {
    if (!token) return undefined;
    const row = sessionUserStmt.get(token) as UserRow | undefined;
    return row ? toPublic(row) : undefined;
  }

  deleteSession(token: string): void {
    deleteSessionStmt.run(token);
  }
}

export const usersRepo = new UsersRepo();
