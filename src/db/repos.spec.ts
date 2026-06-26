// Runs against an in-memory SQLite DB (NODE_ENV=test -> ":memory:" in connection.ts),
// isolated per test file. Verifies the repos are faithful drop-ins for the old
// simple-json-db stores and that the LLM-facing generated columns populate.
import { db } from "./connection";
import { DevicesRepo } from "./devices.repo";
import { SensorsRepo } from "./sensors.repo";
import { EffectsRepo } from "./effects.repo";
import { NodesRepo } from "./nodes.repo";
import { migrateEffectsToNormalized, migrateEffectsToDynamic } from "./migrate";
import { ConfigRepo } from "./config.repo";

describe("DevicesRepo (simple-json-db drop-in)", () => {
  const repo = new DevicesRepo();

  it("round-trips an arbitrary record verbatim", () => {
    const record = {
      id: "abc",
      name: "Office EC",
      value: { fan: false, target: 25 },
      type: "value",
      deviceCategory: "evap-cooler",
      manual: false,
      operationalRanges: ["03:59-09:59"],
      zone: "office",
      unit: "C",
    };
    repo.set("abc", record);
    expect(repo.get("abc")).toEqual(record);
  });

  it("preserves heterogeneous / partial objects (like the legacy JSON)", () => {
    repo.set("partial", { name: "Living Room" });
    expect(repo.get("partial")).toEqual({ name: "Living Room" });
  });

  it("returns undefined for missing keys", () => {
    expect(repo.get("does-not-exist")).toBeUndefined();
  });

  it("upserts (set twice keeps one row, latest wins)", () => {
    repo.set("dup", { name: "v1" });
    repo.set("dup", { name: "v2" });
    expect(repo.get("dup")).toEqual({ name: "v2" });
  });

  it("exposes zone/unit as generated columns for the LLM layer", () => {
    repo.set("z1", { name: "x", zone: "recamara", unit: "%" });
    const row = db
      .prepare("SELECT zone, unit FROM devices WHERE id = ?")
      .get("z1") as { zone: string; unit: string };
    expect(row).toEqual({ zone: "recamara", unit: "%" });
  });

  it("delete removes the record", () => {
    repo.set("del", { name: "bye" });
    repo.delete("del");
    expect(repo.get("del")).toBeUndefined();
  });
});

describe("SensorsRepo", () => {
  const repo = new SensorsRepo();
  it("round-trips and surfaces zone via generated column", () => {
    repo.set("s1", { name: "temp/humidity", sensorType: "temp/humidity", zone: "cocina" });
    expect(repo.get("s1").zone).toBe("cocina");
    const row = db.prepare("SELECT zone FROM sensors WHERE id = ?").get("s1") as {
      zone: string;
    };
    expect(row.zone).toBe("cocina");
  });
});

describe("EffectsRepo (relational, JSONdb-compatible surface)", () => {
  const repo = new EffectsRepo();

  it("set('effects', ...) then get('effects') round-trips, preserving valueToSet and string when.is", () => {
    const effects = [
      {
        set: { id: "10260975", valueToSet: "fan", value: true },
        when: { id: "123", type: "sensor", is: "temp:higher-than:25" },
      },
      {
        set: { id: "999", value: 80 },
        when: { id: "456", type: "sensor", is: true },
      },
    ];
    repo.set("effects", effects);
    expect(repo.get("effects")).toEqual(effects);
  });

  it("set replaces the full list (not append)", () => {
    repo.set("effects", [
      { set: { id: "a", value: false }, when: { id: "x", type: "sensor", is: false } },
    ]);
    expect(repo.get("effects")).toHaveLength(1);
  });

  it("returns an empty array after clearing", () => {
    repo.set("effects", []);
    expect(repo.get("effects")).toEqual([]);
  });

  it("setNormalized then getNormalized is identity (Stage 4b canonical surface)", () => {
    const normalized = [
      {
        when: { source: "sensor" as const, nodeId: "th", channel: "temperature", op: "gt" as const, value: 28 },
        set: { nodeId: "cooler", channel: "fan", value: true },
        enabled: true,
      },
      {
        when: { source: "time" as const, at: "sunset" },
        set: { nodeId: "light", channel: "power", value: true },
        enabled: false,
      },
    ];
    repo.setNormalized(normalized);
    expect(repo.getNormalized()).toEqual(normalized);
  });

  it("addNormalized appends a single rule", () => {
    repo.setNormalized([]);
    repo.addNormalized({
      when: { source: "sensor", nodeId: "pir", channel: "presence", op: "eq", value: true },
      set: { nodeId: "light", channel: "power", value: true },
      enabled: true,
    });
    expect(repo.getNormalized()).toHaveLength(1);
  });
});

describe("Stage-4b effects migration (migrateEffectsToNormalized)", () => {
  it("rebuilds a legacy effects table into normalized storage", () => {
    // Recreate the pre-4b legacy table shape and seed it.
    db.exec("DROP TABLE effects");
    db.exec(`
      CREATE TABLE effects (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        when_id TEXT NOT NULL, when_type TEXT NOT NULL, when_is TEXT NOT NULL,
        set_id TEXT NOT NULL, set_value TEXT NOT NULL, set_value_to_set TEXT,
        enabled INTEGER NOT NULL DEFAULT 1, updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
    `);
    db.prepare(
      `INSERT INTO effects (when_id, when_type, when_is, set_id, set_value, set_value_to_set)
       VALUES (@when_id, @when_type, @when_is, @set_id, @set_value, @set_value_to_set)`,
    ).run({
      when_id: "th-sala", when_type: "sensor", when_is: JSON.stringify("temp:higher-than:28"),
      set_id: "cooler-sala", set_value: JSON.stringify(true), set_value_to_set: "fan",
    });

    // Seed a node so the category resolver picks the right primary channel.
    new NodesRepo().set("cooler-sala", { id: "cooler-sala", category: "evap-cooler" });

    migrateEffectsToNormalized();
    migrateEffectsToDynamic();

    // Table is now the dynamic trigger+arms shape; the rule reads back via the flat adapter.
    const cols = db.prepare("PRAGMA table_info(effects)").all() as { name: string }[];
    expect(cols.some((c) => c.name === "trigger_source")).toBe(true);
    expect(cols.some((c) => c.name === "when_is")).toBe(false);
    expect(cols.some((c) => c.name === "when_source")).toBe(false);
    expect(new EffectsRepo().getNormalized()).toEqual([
      {
        when: { source: "sensor", nodeId: "th-sala", channel: "temperature", op: "gt", value: 28 },
        set: { nodeId: "cooler-sala", channel: "fan", value: true },
        enabled: true,
      },
    ]);
  });

  it("is a no-op when the table is already normalized", () => {
    const repo = new EffectsRepo();
    repo.setNormalized([
      {
        when: { source: "sensor", nodeId: "pir", channel: "presence", op: "eq", value: true },
        set: { nodeId: "light", channel: "power", value: true },
        enabled: true,
      },
    ]);
    migrateEffectsToNormalized();
    expect(repo.getNormalized()).toHaveLength(1);
  });
});

describe("Dynamic effects migration (migrateEffectsToDynamic)", () => {
  it("rebuilds a flat-normalized effects table into trigger+arms storage", () => {
    // Recreate the Stage-4b flat-normalized table (the live shape) and seed a rule.
    db.exec("DROP TABLE IF EXISTS effect_conditions");
    db.exec("DROP TABLE IF EXISTS effect_arms");
    db.exec("DROP TABLE effects");
    db.exec(`
      CREATE TABLE effects (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        when_source TEXT NOT NULL, when_node_id TEXT, when_channel TEXT,
        when_op TEXT, when_value TEXT, when_at TEXT,
        set_node_id TEXT NOT NULL, set_channel TEXT NOT NULL, set_value TEXT NOT NULL,
        enabled INTEGER NOT NULL DEFAULT 1, updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
    `);
    db.prepare(
      `INSERT INTO effects (when_source, when_node_id, when_channel, when_op, when_value,
                            set_node_id, set_channel, set_value, enabled)
       VALUES ('sensor', 'pir-hall', 'presence', 'eq', 'true', 'lamp-hall', 'power', 'true', 1)`,
    ).run();

    migrateEffectsToDynamic();

    const cols = db.prepare("PRAGMA table_info(effects)").all() as { name: string }[];
    expect(cols.some((c) => c.name === "trigger_source")).toBe(true);
    expect(cols.some((c) => c.name === "when_source")).toBe(false);

    // The flat rule is now a single-arm Effect: trigger is the edge, the value guard
    // moved into the arm's sensor condition.
    expect(new EffectsRepo().getAll()).toEqual([
      {
        trigger: { source: "sensor", nodeId: "pir-hall", channel: "presence" },
        arms: [
          {
            when: [{ kind: "sensor", nodeId: "pir-hall", channel: "presence", op: "eq", value: true }],
            set: { nodeId: "lamp-hall", channel: "power", value: true },
          },
        ],
        enabled: true,
      },
    ]);
  });

  it("is a no-op once the table is already dynamic", () => {
    const repo = new EffectsRepo();
    repo.setAll([
      {
        trigger: { source: "sensor", nodeId: "pir", channel: "presence" },
        arms: [{ when: [], set: { nodeId: "light", channel: "power", value: true } }],
        enabled: true,
      },
    ]);
    migrateEffectsToDynamic();
    expect(repo.getAll()).toHaveLength(1);
  });
});

describe("ConfigRepo (v-assistant kv)", () => {
  const repo = new ConfigRepo();
  it("round-trips nested config blobs", () => {
    const screenData = { motionSensors: ["a", "b", "c"] };
    repo.set("screenData", screenData);
    expect(repo.get("screenData")).toEqual(screenData);
    expect(repo.get("missing")).toBeUndefined();
  });
});
