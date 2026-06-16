import { db } from "./connection";

/**
 * Drop-in replacement for the `simple-json-db` sensors store. Same get/set
 * surface as before; record stored verbatim as JSON with zone/unit/name/type
 * exposed as generated columns for the memory/LLM layer.
 */
const getStmt = db.prepare("SELECT data FROM sensors WHERE id = ?");
const allStmt = db.prepare("SELECT data FROM sensors");
const upsertStmt = db.prepare(
  `INSERT INTO sensors (id, data, updated_at) VALUES (@id, @data, datetime('now'))
   ON CONFLICT(id) DO UPDATE SET data = @data, updated_at = datetime('now')`,
);
const deleteStmt = db.prepare("DELETE FROM sensors WHERE id = ?");

export class SensorsRepo {
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
