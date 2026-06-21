import { db } from "./connection";
import {
  CategoryResolver,
  NormalizedEffect,
  normalizeAll,
} from "./effects-normalize";

export interface IEffect {
  set: {
    id: string;
    value: any;
    valueToSet?: string;
  };
  when: {
    id: string;
    type: string;
    is: any;
  };
}

/**
 * Drop-in replacement for the `simple-json-db` effects store, which kept the
 * whole rule list under a single `"effects"` key. The call sites stay identical
 * (`EffectsDB.get('effects')` returns the array, `EffectsDB.set('effects', arr)`
 * replaces it), but underneath the rules are stored relationally — one row per
 * rule — so the dashboard and the memory/LLM layer can query by sensor/device.
 *
 * Values are JSON-encoded per column so types round-trip exactly: `when.is` may be
 * a string ("temp:higher-than:25") or a primitive, and `set.value` may be boolean,
 * number, or string.
 */
const selectAllStmt = db.prepare(
  `SELECT when_id, when_type, when_is, set_id, set_value, set_value_to_set
   FROM effects ORDER BY id`,
);
const deleteAllStmt = db.prepare("DELETE FROM effects");
const insertStmt = db.prepare(
  `INSERT INTO effects (when_id, when_type, when_is, set_id, set_value, set_value_to_set)
   VALUES (@when_id, @when_type, @when_is, @set_id, @set_value, @set_value_to_set)`,
);

interface EffectRow {
  when_id: string;
  when_type: string;
  when_is: string;
  set_id: string;
  set_value: string;
  set_value_to_set: string | null;
}

export class EffectsRepo {
  /** Mirrors JSONdb.get — only the "effects" key is meaningful here. */
  get(key: string): any {
    if (key !== "effects") return undefined;
    return (selectAllStmt.all() as EffectRow[]).map((r) => {
      const effect: IEffect = {
        when: { id: r.when_id, type: r.when_type, is: JSON.parse(r.when_is) },
        set: { id: r.set_id, value: JSON.parse(r.set_value) },
      };
      if (r.set_value_to_set != null) effect.set.valueToSet = r.set_value_to_set;
      return effect;
    });
  }

  /**
   * Derive-on-read view of the rule list in the Stage-2 normalized
   * `(node, channel, op)` shape (see docs/DATA_CONTRACTS.md). Computed from the
   * stored legacy rows on every call — no migration, no second source of truth.
   * `resolveCategory` maps a `set` node id to its device category so single-value
   * rules pick the right primary channel; pass the live DevicesRepo lookup.
   */
  getNormalized(resolveCategory?: CategoryResolver): NormalizedEffect[] {
    return normalizeAll(this.get("effects") || [], resolveCategory);
  }

  /** Mirrors JSONdb.set — replaces the full rule list atomically. */
  set(key: string, effects: IEffect[]): void {
    if (key !== "effects") return;
    const replaceAll = db.transaction((items: IEffect[]) => {
      deleteAllStmt.run();
      for (const e of items) {
        insertStmt.run({
          when_id: String(e.when.id),
          when_type: String(e.when.type),
          when_is: JSON.stringify(e.when.is),
          set_id: String(e.set.id),
          set_value: JSON.stringify(e.set.value),
          set_value_to_set: e.set.valueToSet ?? null,
        });
      }
    });
    replaceAll(effects || []);
  }
}
