import { db } from "./connection";

/**
 * The unified node store (Stage 4) — replaces the separate devices/sensors repos.
 * Same get/set/all/delete surface; the whole record (incl. its channel schema) is
 * stored verbatim as JSON, with name/category/zone/unit surfaced as generated
 * columns for the memory/LLM layer (see schema.ts).
 */
const getStmt = db.prepare("SELECT data FROM nodes WHERE id = ?");
const allStmt = db.prepare("SELECT data FROM nodes");
const upsertStmt = db.prepare(
  `INSERT INTO nodes (id, data, updated_at) VALUES (@id, @data, datetime('now'))
   ON CONFLICT(id) DO UPDATE SET data = @data, updated_at = datetime('now')`,
);
const deleteStmt = db.prepare("DELETE FROM nodes WHERE id = ?");

export class NodesRepo {
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
