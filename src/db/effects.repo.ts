import { db } from "./connection";
import {
  CategoryResolver,
  Condition,
  EffectOp,
  NormalizedEffect,
  denormalizeAll,
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
 * The automation-rule store. As of Stage 4b the stored row IS the normalized
 * `(node, channel, op)` contract (see effects-normalize.ts) — the stringly-typed
 * legacy columns are gone. The canonical surface is therefore:
 *   - `getNormalized()`  — read the rules (identity over the stored rows);
 *   - `setNormalized()`  — replace the full list atomically;
 *   - `addNormalized()`  — append one rule.
 *
 * The legacy `get('effects')` / `set('effects', ...)` surface is kept as a thin
 * denormalize-on-read / normalize-on-write shim for the few edges that still speak
 * the old `IEffect` shape (`GET /get-effects`, the state dump, the one-time JSON
 * import). Values are JSON-encoded per column so booleans/numbers round-trip.
 */
// Statements are prepared lazily (first use), never at module load. migrate.ts
// imports this repo *before* migrateEffectsToNormalized() has rebuilt a legacy
// `effects` table into the Stage-4b shape — preparing against the old columns
// (`when_is`, no `when_source`) at import time would crash boot before the
// migration can run. Memoize so each statement still compiles only once.
let _selectAllStmt: ReturnType<typeof db.prepare> | undefined;
let _deleteAllStmt: ReturnType<typeof db.prepare> | undefined;
let _insertStmt: ReturnType<typeof db.prepare> | undefined;

const selectAllStmt = () =>
  (_selectAllStmt ??= db.prepare(
    `SELECT when_source, when_node_id, when_channel, when_op, when_value, when_at,
            set_node_id, set_channel, set_value, enabled
     FROM effects ORDER BY id`,
  ));
const deleteAllStmt = () =>
  (_deleteAllStmt ??= db.prepare("DELETE FROM effects"));
const insertStmt = () =>
  (_insertStmt ??= db.prepare(
    `INSERT INTO effects
       (when_source, when_node_id, when_channel, when_op, when_value, when_at,
        set_node_id, set_channel, set_value, enabled)
     VALUES
       (@when_source, @when_node_id, @when_channel, @when_op, @when_value, @when_at,
        @set_node_id, @set_channel, @set_value, @enabled)`,
  ));

interface EffectRow {
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
}

function rowToNormalized(r: EffectRow): NormalizedEffect {
  const when: Condition =
    r.when_source === "time"
      ? { source: "time", at: r.when_at ?? "" }
      : {
          source: "sensor",
          nodeId: String(r.when_node_id ?? ""),
          channel: String(r.when_channel ?? ""),
          op: (r.when_op ?? "eq") as EffectOp,
          value: JSON.parse(r.when_value ?? "null"),
        };
  return {
    when,
    set: {
      nodeId: r.set_node_id,
      channel: r.set_channel,
      value: JSON.parse(r.set_value),
    },
    enabled: r.enabled !== 0,
  };
}

function normalizedToRow(e: NormalizedEffect) {
  const sensor = e.when.source === "sensor" ? e.when : null;
  return {
    when_source: e.when.source,
    when_node_id: sensor ? String(sensor.nodeId) : null,
    when_channel: sensor ? String(sensor.channel) : null,
    when_op: sensor ? sensor.op : null,
    when_value: sensor ? JSON.stringify(sensor.value) : null,
    when_at: e.when.source === "time" ? e.when.at : null,
    set_node_id: String(e.set.nodeId),
    set_channel: String(e.set.channel),
    set_value: JSON.stringify(e.set.value),
    enabled: e.enabled === false ? 0 : 1,
  };
}

export class EffectsRepo {
  // --- Canonical normalized surface (Stage 4b) ----------------------------

  /** All rules in the normalized contract — identity over the stored rows. */
  getNormalized(): NormalizedEffect[] {
    return (selectAllStmt().all() as EffectRow[]).map(rowToNormalized);
  }

  /** Replace the full rule list atomically. */
  setNormalized(effects: NormalizedEffect[]): void {
    const replaceAll = db.transaction((items: NormalizedEffect[]) => {
      deleteAllStmt().run();
      for (const e of items) insertStmt().run(normalizedToRow(e));
    });
    replaceAll(effects || []);
  }

  /** Append a single rule. */
  addNormalized(effect: NormalizedEffect): void {
    insertStmt().run(normalizedToRow(effect));
  }

  // --- Legacy IEffect shim (denormalize-on-read / normalize-on-write) ------

  /** Mirrors the old JSONdb.get — denormalizes the stored rules to `IEffect[]`. */
  get(key: string): IEffect[] | undefined {
    if (key !== "effects") return undefined;
    return denormalizeAll(this.getNormalized());
  }

  /** Mirrors the old JSONdb.set — normalizes legacy rules, then stores them.
   * `resolveCategory` picks the primary channel for single-value `set` targets
   * (pass the live nodes lookup); without it, unknown targets get the generic
   * "value" channel. */
  set(key: string, effects: IEffect[], resolveCategory?: CategoryResolver): void {
    if (key !== "effects") return;
    this.setNormalized(normalizeAll(effects || [], resolveCategory));
  }
}
