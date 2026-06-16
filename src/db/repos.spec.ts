// Runs against an in-memory SQLite DB (NODE_ENV=test -> ":memory:" in connection.ts),
// isolated per test file. Verifies the repos are faithful drop-ins for the old
// simple-json-db stores and that the LLM-facing generated columns populate.
import { db } from "./connection";
import { DevicesRepo } from "./devices.repo";
import { SensorsRepo } from "./sensors.repo";
import { EffectsRepo } from "./effects.repo";
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
