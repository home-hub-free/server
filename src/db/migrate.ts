import fs from "fs";
import { log, EVENT_TYPES } from "../logger";
import { DevicesRepo } from "./devices.repo";
import { SensorsRepo } from "./sensors.repo";
import { EffectsRepo } from "./effects.repo";
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

  const effectsJson = readJson(LEGACY.effects);
  if (effectsJson && Array.isArray(effectsJson.effects)) {
    const repo = new EffectsRepo();
    if ((repo.get("effects") || []).length === 0 && effectsJson.effects.length) {
      repo.set("effects", effectsJson.effects);
      imported += effectsJson.effects.length;
    }
    archive(LEGACY.effects);
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

  migrateToNodes();
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
