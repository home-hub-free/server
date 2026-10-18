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

    -- Dynamic effects (docs/EFFECTS_DYNAMIC.md §5): one master trigger + an ordered
    -- list of arms (first arm whose conditions ALL hold wins). The arm/condition
    -- fan-out lives in child tables; reads reassemble whole Effect objects.
    CREATE TABLE IF NOT EXISTS effects (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      trigger_source  TEXT NOT NULL,           -- 'sensor' | 'time'
      trigger_node    TEXT,                     -- sensor only
      trigger_channel TEXT,                     -- sensor only
      trigger_at      TEXT,                     -- time only: 'HH:MM' | 'sunrise' | 'sunset'
      enabled         INTEGER NOT NULL DEFAULT 1,
      updated_at      TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS effect_arms (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      effect_id   INTEGER NOT NULL REFERENCES effects(id) ON DELETE CASCADE,
      position    INTEGER NOT NULL,            -- arm order (first match wins)
      set_node    TEXT NOT NULL,
      set_channel TEXT NOT NULL,
      set_value   TEXT NOT NULL                -- JSON (boolean | number)
    );
    CREATE TABLE IF NOT EXISTS effect_conditions (
      id        INTEGER PRIMARY KEY AUTOINCREMENT,
      arm_id    INTEGER NOT NULL REFERENCES effect_arms(id) ON DELETE CASCADE,
      position  INTEGER NOT NULL,              -- condition order within the arm
      kind      TEXT NOT NULL,                 -- 'time' | 'dow' | 'sensor' | 'state'
      node_id   TEXT,                          -- sensor/state
      channel   TEXT,                          -- sensor/state
      op        TEXT,                          -- sensor/state: eq|gt|lt ; time: before|after|between
      value     TEXT                           -- JSON: number/boolean ; time: {from,to} ; dow: days[]
    );

    CREATE TABLE IF NOT EXISTS kv_config (
      key   TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    -- User-facing timers, reminders and time-tracking ("stopwatch") entries. The hub
    -- owns these because it is the always-on control plane: the LLM agent is event-driven
    -- (no internal cron), so a timer that fires minutes later must be driven by something
    -- that is always running. The scheduler tick (src/timers/scheduler.ts) announces a
    -- due timer/reminder through the same speaker sink the agent's say tool uses.
    --   kind 'timer'/'reminder' → one-shot at fire_at, status pending → fired|cancelled
    --   kind 'event'            → a calendar entry (LOCAL_AGENDA); announced remind_min before fire_at
    --   kind 'stopwatch'        → open-ended, status running → stopped (elapsed from started_at)
    CREATE TABLE IF NOT EXISTS timers (
      id          TEXT PRIMARY KEY,
      kind        TEXT NOT NULL,            -- 'timer' | 'reminder' | 'stopwatch'
      label       TEXT,                     -- activity / human label (stopwatch + optional for timers)
      message     TEXT,                     -- spoken line announced when a timer/reminder fires
      zone        TEXT,                     -- optional zone (routing / context)
      for_person  TEXT,                     -- person-targeted reminder: their id or name; zone is late-bound
      fire_at     TEXT,                     -- ISO8601 fire time (timer/reminder) / START of the current occurrence (event); NULL for stopwatch
      -- LOCAL_AGENDA: the agenda columns. An 'event' is a calendar entry (title, start=fire_at, end_at,
      -- all_day) that the scheduler ANNOUNCES remind_min minutes before its start (NULL = silent);
      -- a 'reminder' keeps using message/fire_at. recurrence ('daily'|'weekdays'|'weekly[:d,d]'|
      -- 'monthly'|'yearly') makes the row re-arm itself after firing (fire_at advances to the next
      -- occurrence). notify_at is the derived moment the scheduler watches (fire_at - remind_min).
      title       TEXT,
      end_at      TEXT,
      all_day     INTEGER NOT NULL DEFAULT 0,
      recurrence  TEXT,
      remind_min  INTEGER,
      notify_at   TEXT,
      notes       TEXT,
      created_by  TEXT,
      started_at  TEXT NOT NULL DEFAULT (datetime('now')),  -- creation / stopwatch start
      stopped_at  TEXT,                     -- stopwatch stop time
      status      TEXT NOT NULL DEFAULT 'pending', -- pending | fired | cancelled | running | stopped
      created_at  TEXT NOT NULL DEFAULT (datetime('now'))
    );

    -- Household members + login sessions. The hub owns these because it is the
    -- always-on control plane and the single front door for the dashboard. Each
    -- user carries a prefs blob (JSON) for per-user settings. Passwords are stored
    -- as a scrypt hash ('salt:key' hex, see src/auth/passwords.ts) -- never plaintext.
    CREATE TABLE IF NOT EXISTS users (
      id            TEXT PRIMARY KEY,           -- slug, e.g. 'david'
      username      TEXT NOT NULL UNIQUE,
      display_name  TEXT NOT NULL,
      pass_hash     TEXT NOT NULL,              -- scrypt 'salt:derivedKey' hex
      prefs         TEXT NOT NULL DEFAULT '{}', -- JSON per-user settings blob
      created_at    TEXT NOT NULL DEFAULT (datetime('now'))
    );
    -- Opaque bearer tokens minted on login; deleted on logout. No expiry (home LAN).
    CREATE TABLE IF NOT EXISTS sessions (
      token       TEXT PRIMARY KEY,            -- 32-byte hex
      user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      created_at  TEXT NOT NULL DEFAULT (datetime('now'))
    );

    -- Guests: people who are NOT household members but whom the house may need to
    -- address (a parent visiting, a neighbour, a friend of a member). One row per
    -- person; aliases is a JSON array of other names they go by. treatment is
    -- how the house should speak to them ('tu' | 'usted' | '' = unspecified).
    -- The relationship to each member lives in guest_relations ("Lupita is
    -- david's mamá", "Lupita is ana's suegra") — generic free text per pair.
    -- Writes come from the dashboard (Settings → Household) or from reflex by
    -- voice (service token); both go through the same /guests routes.
    CREATE TABLE IF NOT EXISTS guests (
      id            TEXT PRIMARY KEY,           -- slug of the name, e.g. 'lupita'
      name          TEXT NOT NULL,              -- display name, as the house says it
      aliases       TEXT NOT NULL DEFAULT '[]', -- JSON string[]
      treatment     TEXT NOT NULL DEFAULT '',   -- 'tu' | 'usted' | ''
      notes         TEXT NOT NULL DEFAULT '',
      created_at    TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at    TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS guest_relations (
      guest_id   TEXT NOT NULL REFERENCES guests(id) ON DELETE CASCADE,
      member_id  TEXT NOT NULL REFERENCES users(id)  ON DELETE CASCADE,
      relation   TEXT NOT NULL,                 -- free text, guest's role to the member: 'mamá', 'vecino', 'amiga'
      PRIMARY KEY (guest_id, member_id)
    );

    CREATE INDEX IF NOT EXISTS idx_nodes_zone    ON nodes(zone);
    CREATE INDEX IF NOT EXISTS idx_nodes_category ON nodes(category);
    CREATE INDEX IF NOT EXISTS idx_devices_zone  ON devices(zone);
    CREATE INDEX IF NOT EXISTS idx_sensors_zone  ON sensors(zone);
    CREATE INDEX IF NOT EXISTS idx_effect_arms_eff  ON effect_arms(effect_id);
    CREATE INDEX IF NOT EXISTS idx_effect_conds_arm ON effect_conditions(arm_id);
    CREATE INDEX IF NOT EXISTS idx_timers_status ON timers(status);
    CREATE INDEX IF NOT EXISTS idx_timers_fire   ON timers(fire_at);
    CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);
    CREATE INDEX IF NOT EXISTS idx_guest_relations_member ON guest_relations(member_id);
  `);

  // The `effects` trigger index targets a dynamic-shape column (`trigger_node`).
  // applySchema runs eagerly at connection-open, *before* migrate.ts has a chance
  // to rebuild a legacy `effects` table (the `CREATE TABLE IF NOT EXISTS` above is
  // a no-op when an older table already exists). Creating this index against a
  // legacy table would throw `no such column: trigger_node` and crash the process
  // at import, so guard it: only create it once the table actually has the column.
  // After migrateEffectsToDynamic() drops + recreates the table via applySchema,
  // the column exists and the index is created normally.
  const effectsCols = db.prepare("PRAGMA table_info(effects)").all() as { name: string }[];
  if (effectsCols.some((c) => c.name === "trigger_node")) {
    db.exec("CREATE INDEX IF NOT EXISTS idx_effects_trigger ON effects(trigger_node);");
  }

  // Additive column for person-targeted reminders (PERCEPTION_TO_AGENT_PLAN §3.5). The CREATE above
  // already carries it on a fresh DB; ALTER it onto an existing timers table (idempotent — guard on the
  // PRAGMA so we never re-add it). SQLite ADD COLUMN is cheap and non-locking.
  const timerCols = db.prepare("PRAGMA table_info(timers)").all() as { name: string }[];
  if (!timerCols.some((c) => c.name === "for_person")) {
    db.exec("ALTER TABLE timers ADD COLUMN for_person TEXT;");
  }
  // LOCAL_AGENDA (2026-10-18): the calendar columns, additive + idempotent like for_person above.
  const agendaCols: Array<[string, string]> = [
    ["title", "TEXT"], ["end_at", "TEXT"], ["all_day", "INTEGER NOT NULL DEFAULT 0"], ["recurrence", "TEXT"],
    ["remind_min", "INTEGER"], ["notify_at", "TEXT"], ["notes", "TEXT"], ["created_by", "TEXT"],
  ];
  for (const [name, type] of agendaCols) {
    if (!timerCols.some((c) => c.name === name)) db.exec(`ALTER TABLE timers ADD COLUMN ${name} ${type};`);
  }
  // Legacy pending timers/reminders predate notify_at — the scheduler now watches notify_at, so seed it.
  db.exec("UPDATE timers SET notify_at = fire_at WHERE notify_at IS NULL AND fire_at IS NOT NULL AND kind IN ('timer','reminder');");
  db.exec("CREATE INDEX IF NOT EXISTS idx_timers_notify ON timers(status, notify_at);");
}
