import { db } from "./connection";

/**
 * Drop-in replacement for the `simple-json-db` devices store. Exposes the same
 * get/set surface the call sites already use (`DevicesDB.get(id)` /
 * `DevicesDB.set(id, clientData)`), so nothing downstream changes. The whole
 * record is stored verbatim as JSON; `zone`/`unit`/`name`/category are surfaced
 * as generated columns (see schema.ts) for the memory/LLM layer.
 */
const getStmt = db.prepare("SELECT data FROM devices WHERE id = ?");
const allStmt = db.prepare("SELECT data FROM devices");
const upsertStmt = db.prepare(
  `INSERT INTO devices (id, data, updated_at) VALUES (@id, @data, datetime('now'))
   ON CONFLICT(id) DO UPDATE SET data = @data, updated_at = datetime('now')`,
);
const deleteStmt = db.prepare("DELETE FROM devices WHERE id = ?");

export class DevicesRepo {
  get(id: string): any {
    const row = getStmt.get(id) as { data: string } | undefined;
    return row ? JSON.parse(row.data) : undefined;
  }

  set(id: string, value: any): void {
    upsertStmt.run({ id, data: JSON.stringify(value ?? {}) });
  }

  all(): any[] {
    return (allStmt.all() as { data: string }[]).map((r) => JSON.parse(r.data));
  }

  delete(id: string): void {
    deleteStmt.run(id);
  }
}
