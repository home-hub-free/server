import type DatabaseType from "better-sqlite3";

/**
 * Applies the SQLite schema. Idempotent (CREATE ... IF NOT EXISTS), so it runs on
 * every connection open.
 *
 * Devices and sensors keep the exact key/value semantics the old simple-json-db
 * stores had: the full record is preserved verbatim in the `data` JSON column, so
 * heterogeneous / partial objects (e.g. `{ "name": "Living Room" }`) round-trip
 * untouched. The columns that the LLM ingestion + memory layer care about
 * (`zone`, `unit`, `name`, category) are exposed as *generated* columns extracted
 * from that JSON, so they are queryable without a second source of truth and stay
 * in sync automatically whenever the record is updated.
 *
 * Effects are relational (one row per automation rule) so the memory/LLM layer and
 * the dashboard can query rules by sensor/device without parsing a blob. As of
 * Stage 4b the row is the *normalized* `(node, channel, op)` contract itself
 * (see effects-normalize.ts) — the stringly-typed `when_is`/`set_value_to_set`
 * columns are gone, and migrate.ts rebuilds any legacy table in place.
 */
export function applySchema(db: DatabaseType.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS nodes (
      id          TEXT PRIMARY KEY,
      data        TEXT NOT NULL,
      name        TEXT GENERATED ALWAYS AS (json_extract(data, '$.name')) VIRTUAL,
      category    TEXT GENERATED ALWAYS AS (json_extract(data, '$.category')) VIRTUAL,
      zone        TEXT GENERATED ALWAYS AS (json_extract(data, '$.zone')) VIRTUAL,
      unit        TEXT GENERATED ALWAYS AS (json_extract(data, '$.unit')) VIRTUAL,
      updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS devices (
      id              TEXT PRIMARY KEY,
      data            TEXT NOT NULL,
      name            TEXT GENERATED ALWAYS AS (json_extract(data, '$.name')) VIRTUAL,
      device_category TEXT GENERATED ALWAYS AS (json_extract(data, '$.deviceCategory')) VIRTUAL,
      zone            TEXT GENERATED ALWAYS AS (json_extract(data, '$.zone')) VIRTUAL,
      unit            TEXT GENERATED ALWAYS AS (json_extract(data, '$.unit')) VIRTUAL,
      updated_at      TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS sensors (
      id          TEXT PRIMARY KEY,
      data        TEXT NOT NULL,
      name        TEXT GENERATED ALWAYS AS (json_extract(data, '$.name')) VIRTUAL,
      sensor_type TEXT GENERATED ALWAYS AS (json_extract(data, '$.sensorType')) VIRTUAL,
      zone        TEXT GENERATED ALWAYS AS (json_extract(data, '$.zone')) VIRTUAL,
      unit        TEXT GENERATED ALWAYS AS (json_extract(data, '$.unit')) VIRTUAL,
      updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS effects (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      when_source  TEXT NOT NULL,            -- 'sensor' | 'time'
      when_node_id TEXT,                     -- sensor only
      when_channel TEXT,                     -- sensor only
      when_op      TEXT,                     -- sensor only: 'eq' | 'gt' | 'lt'
      when_value   TEXT,                     -- sensor only: JSON (boolean | number)
      when_at      TEXT,                     -- time only: raw expression
      set_node_id  TEXT NOT NULL,
      set_channel  TEXT NOT NULL,
      set_value    TEXT NOT NULL,            -- JSON (boolean | number)
      enabled      INTEGER NOT NULL DEFAULT 1,
      updated_at   TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS kv_config (
      key   TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_nodes_zone    ON nodes(zone);
    CREATE INDEX IF NOT EXISTS idx_nodes_category ON nodes(category);
    CREATE INDEX IF NOT EXISTS idx_devices_zone  ON devices(zone);
    CREATE INDEX IF NOT EXISTS idx_sensors_zone  ON sensors(zone);
    CREATE INDEX IF NOT EXISTS idx_effects_when  ON effects(when_node_id);
  `);
}
