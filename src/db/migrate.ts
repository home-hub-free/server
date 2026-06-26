import fs from "fs";
import { log, EVENT_TYPES } from "../logger";
import { db, DB_FILE } from "./connection";
import { applySchema } from "./schema";
import { DevicesRepo } from "./devices.repo";
import { SensorsRepo } from "./sensors.repo";
import { EffectsRepo, IEffect } from "./effects.repo";
import { CategoryResolver, EffectOp, NormalizedEffect, normalizeAll } from "./effects-normalize";
import { flatListToEffects } from "../automation/effect-compat";
import { ConfigRepo } from "./config.repo";
import { NodesRepo } from "./nodes.repo";

/**
 * One-time migration from the legacy simple-json-db files into SQLite. Runs at
 * boot (idempotent): for each legacy file that still exists, import any records
 * not already present, then archive the file to `<name>.bak` so the import never
 * repeats. If the SQLite store already holds the data (re-run, fresh deploy), the
 * presence checks make this a no-op.
 */
const LEGACY = {
  devices: "db/devices.db.json",
  sensors: "db/sensors.db.json",
  effects: "db/effects.db.json",
  vassistant: "db/v-assistant.db.json",
};

function readJson(file: string): any | null {
  if (!fs.existsSync(file)) return null;
  try {
    const raw = fs.readFileSync(file, "utf-8").trim();
    if (!raw) return null;
    return JSON.parse(raw);
  } catch (err) {
    log(EVENT_TYPES.error, [`Failed to read legacy DB ${file}: ${err}`]);
    return null;
  }
}

function archive(file: string): void {
  try {
    fs.renameSync(file, `${file}.bak`);
  } catch (err) {
    log(EVENT_TYPES.error, [`Failed to archive legacy DB ${file}: ${err}`]);
  }
}

export function importLegacyJson(): void {
  let imported = 0;

  const devicesJson = readJson(LEGACY.devices);
  if (devicesJson && typeof devicesJson === "object") {
    const repo = new DevicesRepo();
    for (const [id, obj] of Object.entries(devicesJson)) {
      if (repo.get(id) === undefined) {
        repo.set(id, obj);
        imported++;
      }
    }
    archive(LEGACY.devices);
  }

  const sensorsJson = readJson(LEGACY.sensors);
  if (sensorsJson && typeof sensorsJson === "object") {
    const repo = new SensorsRepo();
    for (const [id, obj] of Object.entries(sensorsJson)) {
      if (repo.get(id) === undefined) {
        repo.set(id, obj);
        imported++;
      }
    }
    archive(LEGACY.sensors);
  }

  const vassistantJson = readJson(LEGACY.vassistant);
  if (vassistantJson && typeof vassistantJson === "object") {
    const repo = new ConfigRepo();
    for (const [key, value] of Object.entries(vassistantJson)) {
      if (repo.get(key) === undefined) {
        repo.set(key, value);
        imported++;
      }
    }
    archive(LEGACY.vassistant);
  }

  if (imported > 0) {
    log(EVENT_TYPES.info, [`Migrated ${imported} record(s) from legacy JSON DBs into SQLite`]);
  }

  // Order matters: nodes must exist before the effect normalizer resolves a
  // `set` target's category, and the effects table must be the Stage-4b shape
  // before any normalized row is written.
  migrateToNodes();
  migrateEffectsToNormalized();
  migrateEffectsToDynamic();
  importLegacyEffectsJson();
}

/** Resolve a node id to its category from the unified `nodes` table — the
 * category picks the primary `set` channel for single-value devices. */
function nodeCategoryResolver(): CategoryResolver {
  const repo = new NodesRepo();
  return (id: string) => repo.get(id)?.category;
}

/**
 * One-time import of the legacy `db/effects.db.json` rule list. Runs after the
 * nodes + effects-table migrations so it can normalize into the Stage-4b storage
 * with a live category resolver. No-op (then archives) once SQLite already holds
 * rules or the file is gone.
 */
function importLegacyEffectsJson(): void {
  const effectsJson = readJson(LEGACY.effects);
  if (!effectsJson || !Array.isArray(effectsJson.effects)) return;

  const repo = new EffectsRepo();
  if (repo.getNormalized().length === 0 && effectsJson.effects.length) {
    repo.set("effects", effectsJson.effects, nodeCategoryResolver());
    log(EVENT_TYPES.info, [
      `Migrated ${effectsJson.effects.length} effect(s) from legacy JSON into SQLite`,
    ]);
  }
  archive(LEGACY.effects);
}

/**
 * Stage-4b migration: rebuild a legacy `effects` table (stringly-typed
 * `when_is`/`set_value_to_set`) into the normalized `(node, channel, op)` storage
 * (see docs/DATA_CONTRACTS.md). Irreversible (schema mutation), so it takes a
 * verified `.bak` snapshot first and aborts if that fails. Idempotent: a no-op
 * once the table is already the new shape (fresh install or prior run).
 */
export function migrateEffectsToNormalized(): void {
  const cols = db.prepare("PRAGMA table_info(effects)").all() as { name: string }[];
  if (!cols.some((c) => c.name === "when_is")) return; // already normalized

  // Read the legacy rows directly — the repo can no longer parse this shape.
  const legacyRows = db
    .prepare(
      `SELECT when_id, when_type, when_is, set_id, set_value, set_value_to_set
       FROM effects ORDER BY id`,
    )
    .all() as {
    when_id: string;
    when_type: string;
    when_is: string;
    set_id: string;
    set_value: string;
    set_value_to_set: string | null;
  }[];
  const legacy: IEffect[] = legacyRows.map((r) => {
    const e: IEffect = {
      when: { id: r.when_id, type: r.when_type, is: JSON.parse(r.when_is) },
      set: { id: r.set_id, value: JSON.parse(r.set_value) },
    };
    if (r.set_value_to_set != null) e.set.valueToSet = r.set_value_to_set;
    return e;
  });

  // Verified .bak BEFORE the destructive change. VACUUM INTO writes a consistent
  // snapshot and can't run inside a transaction. If it fails we abort and leave
  // the legacy table untouched — never mutate the schema without a backup.
  if (DB_FILE !== ":memory:") {
    const backup = `${DB_FILE}.pre-4b-${Date.now()}.bak`;
    try {
      db.exec(`VACUUM INTO '${backup.replace(/'/g, "''")}'`);
      log(EVENT_TYPES.info, [`Backed up DB to ${backup} before Stage-4b effects migration`]);
    } catch (err) {
      log(EVENT_TYPES.error, [
        `Aborting Stage-4b effects migration — backup failed: ${err}`,
      ]);
      return;
    }
  }

  const normalized = normalizeAll(legacy, nodeCategoryResolver());
  const rebuild = db.transaction(() => {
    db.exec("DROP TABLE effects");
    applySchema(db); // recreates effects in the new shape (other tables no-op)
    new EffectsRepo().setNormalized(normalized);
  });
  rebuild();
  log(EVENT_TYPES.info, [
    `Migrated ${normalized.length} effect(s) to normalized storage (Stage 4b)`,
  ]);
}

/**
 * EFFECTS_DYNAMIC Stage 1 migration: rebuild a flat-normalized `effects` table
 * (`when_source`/`when_*`/`set_*`, the Stage-4b shape) into the dynamic `trigger + arms`
 * storage (effects + effect_arms + effect_conditions; docs/EFFECTS_DYNAMIC.md §5). Each
 * flat rule becomes a single-arm `Effect` via the flat→dynamic adapter (§7: the small
 * deployed rule set is re-authored, not carried forward as a dual shape).
 *
 * Runs AFTER migrateEffectsToNormalized so an ancient stringly table (already lifted to
 * the dynamic shape by that step's applySchema) is detected as dynamic and skipped here.
 * Idempotent: a no-op once `effects` is the dynamic shape (has `trigger_source`).
 * Irreversible (schema mutation), so it snapshots a verified `.bak` first and aborts if
 * that fails.
 */
export function migrateEffectsToDynamic(): void {
  const cols = db.prepare("PRAGMA table_info(effects)").all() as { name: string }[];
  if (cols.some((c) => c.name === "trigger_source")) return; // already dynamic
  if (!cols.some((c) => c.name === "when_source")) return; // not the flat-normalized shape

  // Read the flat-normalized rows directly into the DTO the adapter consumes.
  const rows = db
    .prepare(
      `SELECT when_source, when_node_id, when_channel, when_op, when_value, when_at,
              set_node_id, set_channel, set_value, enabled
       FROM effects ORDER BY id`,
    )
    .all() as {
    when_source: string;
    when_node_id: string | null;
    when_channel: string | null;
    when_op: string | null;
    when_value: string | null;
    when_at: string | null;
    set_node_id: string;
    set_channel: string;
    set_value: string;
    enabled: number;
  }[];
  const flat: NormalizedEffect[] = rows.map((r) =>
    r.when_source === "time"
      ? {
          when: { source: "time", at: r.when_at ?? "" },
          set: { nodeId: r.set_node_id, channel: r.set_channel, value: JSON.parse(r.set_value) },
          enabled: r.enabled !== 0,
        }
      : {
          when: {
            source: "sensor",
            nodeId: String(r.when_node_id ?? ""),
            channel: String(r.when_channel ?? ""),
            op: (r.when_op ?? "eq") as EffectOp,
            value: JSON.parse(r.when_value ?? "null"),
          },
          set: { nodeId: r.set_node_id, channel: r.set_channel, value: JSON.parse(r.set_value) },
          enabled: r.enabled !== 0,
        },
  );

  // Verified .bak BEFORE the destructive change (VACUUM INTO can't run in a transaction).
  if (DB_FILE !== ":memory:") {
    const backup = `${DB_FILE}.pre-dynamic-${Date.now()}.bak`;
    try {
      db.exec(`VACUUM INTO '${backup.replace(/'/g, "''")}'`);
      log(EVENT_TYPES.info, [`Backed up DB to ${backup} before dynamic-effects migration`]);
    } catch (err) {
      log(EVENT_TYPES.error, [`Aborting dynamic-effects migration — backup failed: ${err}`]);
      return;
    }
  }

  const effects = flatListToEffects(flat);
  const rebuild = db.transaction(() => {
    db.exec("DROP TABLE effects");
    applySchema(db); // recreates effects + effect_arms + effect_conditions (other tables no-op)
    new EffectsRepo().setAll(effects);
  });
  rebuild();
  log(EVENT_TYPES.info, [
    `Migrated ${effects.length} effect(s) to dynamic trigger+arms storage (EFFECTS_DYNAMIC Stage 1)`,
  ]);
}

/**
 * Stage-4 migration: fold the legacy `devices` + `sensors` rows into the unified
 * `nodes` table. Idempotent — only writes a node that isn't already present, so it
 * is safe on every boot. The old tables are left in place (read-only) as a backup;
 * they can be dropped once the Node cutover has baked in.
 */
export function migrateToNodes(): void {
  const nodes = new NodesRepo();
  let migrated = 0;

  for (const d of new DevicesRepo().all()) {
    if (!d || d.id == null || nodes.get(d.id) !== undefined) continue;
    nodes.set(d.id, {
      id: d.id,
      name: d.name,
      category: d.deviceCategory,
      type: d.type,
      value: d.value,
      manual: d.manual,
      operationalRanges: d.operationalRanges ?? [],
      ...(d.zone ? { zone: d.zone } : {}),
      ...(d.unit ? { unit: d.unit } : {}),
      ...(d.channels ? { channels: d.channels } : {}),
      ...(d.channelAware != null ? { channelAware: d.channelAware } : {}),
    });
    migrated++;
  }

  for (const s of new SensorsRepo().all()) {
    if (!s || s.id == null || nodes.get(s.id) !== undefined) continue;
    nodes.set(s.id, {
      id: s.id,
      ...(s.name != null ? { name: s.name } : {}),
      ...(s.sensorType ? { category: s.sensorType } : {}),
      ...(s.type ? { type: s.type } : {}),
      ...(s.value != null ? { value: s.value } : {}),
      ...(s.zone ? { zone: s.zone } : {}),
      ...(s.unit ? { unit: s.unit } : {}),
    });
    migrated++;
  }

  if (migrated > 0) {
    log(EVENT_TYPES.info, [`Migrated ${migrated} device/sensor record(s) into the unified nodes table`]);
  }
}
