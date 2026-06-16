import { db } from "./connection";

/**
 * Drop-in replacement for the `simple-json-db` v-assistant store. A plain
 * key/value table holding JSON-encoded config blobs (`houseData`, `screenData`).
 * Same get/set surface as before.
 */
const getStmt = db.prepare("SELECT value FROM kv_config WHERE key = ?");
const setStmt = db.prepare(
  `INSERT INTO kv_config (key, value) VALUES (?, ?)
   ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
);

export class ConfigRepo {
  get(key: string): any {
    const row = getStmt.get(key) as { value: string } | undefined;
    return row ? JSON.parse(row.value) : undefined;
  }

  set(key: string, value: any): void {
    setStmt.run(key, JSON.stringify(value));
  }
}
