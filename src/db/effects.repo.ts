import { db } from "./connection";
import {
  CategoryResolver,
  NormalizedEffect,
  denormalizeAll,
  normalizeAll,
} from "./effects-normalize";
import type { Arm, Condition, Effect, SetAction, Trigger } from "../automation/effect.model";
import {
  effectToFlat,
  effectsToFlatList,
  flatListToEffects,
  flatToEffect,
} from "../automation/effect-compat";

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
 * The automation-rule store. As of EFFECTS_DYNAMIC Stage 1 the stored shape is the
 * dynamic `trigger + arms` model (docs/EFFECTS_DYNAMIC.md §5), spread across three
 * tables (`effects` / `effect_arms` / `effect_conditions`). Reads reassemble whole
 * `Effect` objects so `evaluate` and the contracts see complete rules; replace-all is a
 * single transaction.
 *
 * Two surfaces:
 *   - canonical (dynamic): `getAll()` / `setAll()` / `add()` — what the runtime uses.
 *   - boundary (flat DTO): `getNormalized()` / `setNormalized()` / `addNormalized()` and
 *     the legacy `get()/set()` shim — the `when → set` shape the dashboard, LLM gateway,
 *     and state dump still speak, adapted via `effect-compat.ts`. Stage 4 teaches those
 *     callers the dynamic shape and removes this boundary (and effects-normalize.ts).
 */
// Statements are prepared lazily (first use), never at module load — migrate.ts imports
// this repo before the dynamic tables exist, so preparing at import time would crash boot.
let _selEffects: ReturnType<typeof db.prepare> | undefined;
let _selArms: ReturnType<typeof db.prepare> | undefined;
let _selConds: ReturnType<typeof db.prepare> | undefined;
let _delEffects: ReturnType<typeof db.prepare> | undefined;
let _insEffect: ReturnType<typeof db.prepare> | undefined;
let _insArm: ReturnType<typeof db.prepare> | undefined;
let _insCond: ReturnType<typeof db.prepare> | undefined;

const selEffects = () =>
  (_selEffects ??= db.prepare(
    `SELECT id, trigger_source, trigger_node, trigger_channel, trigger_at, enabled
     FROM effects ORDER BY id`,
  ));
const selArms = () =>
  (_selArms ??= db.prepare(
    `SELECT id, set_node, set_channel, set_value FROM effect_arms
     WHERE effect_id = ? ORDER BY position`,
  ));
const selConds = () =>
  (_selConds ??= db.prepare(
    `SELECT kind, node_id, channel, op, value FROM effect_conditions
     WHERE arm_id = ? ORDER BY position`,
  ));
const delEffects = () => (_delEffects ??= db.prepare("DELETE FROM effects"));
const insEffect = () =>
  (_insEffect ??= db.prepare(
    `INSERT INTO effects (trigger_source, trigger_node, trigger_channel, trigger_at, enabled)
     VALUES (@trigger_source, @trigger_node, @trigger_channel, @trigger_at, @enabled)`,
  ));
const insArm = () =>
  (_insArm ??= db.prepare(
    `INSERT INTO effect_arms (effect_id, position, set_node, set_channel, set_value)
     VALUES (@effect_id, @position, @set_node, @set_channel, @set_value)`,
  ));
const insCond = () =>
  (_insCond ??= db.prepare(
    `INSERT INTO effect_conditions (arm_id, position, kind, node_id, channel, op, value)
     VALUES (@arm_id, @position, @kind, @node_id, @channel, @op, @value)`,
  ));

interface EffectRow {
  id: number;
  trigger_source: string;
  trigger_node: string | null;
  trigger_channel: string | null;
  trigger_at: string | null;
  enabled: number;
}
interface ArmRow {
  id: number;
  set_node: string;
  set_channel: string;
  set_value: string;
}
interface CondRow {
  kind: string;
  node_id: string | null;
  channel: string | null;
  op: string | null;
  value: string | null;
}

function rowToTrigger(r: EffectRow): Trigger {
  return r.trigger_source === "time"
    ? { source: "time", at: r.trigger_at ?? "" }
    : { source: "sensor", nodeId: r.trigger_node ?? "", channel: r.trigger_channel ?? "" };
}

function rowToCondition(r: CondRow): Condition {
  const v = r.value === null ? null : JSON.parse(r.value);
  switch (r.kind) {
    case "dow":
      return { kind: "dow", days: (v?.days ?? []) as number[] };
    case "time":
      return { kind: "time", op: r.op as "before" | "after" | "between", from: v?.from ?? "", to: v?.to };
    case "state":
      return { kind: "state", nodeId: r.node_id ?? "", channel: r.channel ?? "", op: r.op as any, value: v };
    case "sensor":
    default:
      return { kind: "sensor", nodeId: r.node_id ?? "", channel: r.channel ?? "", op: r.op as any, value: v };
  }
}

function conditionToRow(arm_id: number, position: number, c: Condition) {
  const base = {
    arm_id,
    position,
    kind: c.kind,
    node_id: null as string | null,
    channel: null as string | null,
    op: null as string | null,
    value: null as string | null,
  };
  if (c.kind === "dow") return { ...base, value: JSON.stringify({ days: c.days }) };
  if (c.kind === "time") return { ...base, op: c.op, value: JSON.stringify({ from: c.from, to: c.to }) };
  // sensor | state
  return { ...base, node_id: c.nodeId, channel: c.channel, op: c.op, value: JSON.stringify(c.value) };
}

export class EffectsRepo {
  // --- Canonical dynamic surface (EFFECTS_DYNAMIC Stage 1) -----------------

  /** All rules reassembled as whole `Effect` objects (trigger + arms + conditions). */
  getAll(): Effect[] {
    return (selEffects().all() as EffectRow[]).map((er) => {
      const arms: Arm[] = (selArms().all(er.id) as ArmRow[]).map((ar) => {
        const when = (selConds().all(ar.id) as CondRow[]).map(rowToCondition);
        const set: SetAction = {
          nodeId: ar.set_node,
          channel: ar.set_channel,
          value: JSON.parse(ar.set_value),
        };
        return { when, set };
      });
      return { trigger: rowToTrigger(er), arms, enabled: er.enabled !== 0 };
    });
  }

  /** Replace the full rule list atomically. */
  setAll(effects: Effect[]): void {
    const replaceAll = db.transaction((items: Effect[]) => {
      delEffects().run(); // ON DELETE CASCADE clears arms + conditions
      for (const e of items) this.insertOne(e);
    });
    replaceAll(effects || []);
  }

  /** Append a single rule. */
  add(effect: Effect): void {
    this.insertOne(effect);
  }

  private insertOne(e: Effect): void {
    const t = e.trigger;
    const info = insEffect().run({
      trigger_source: t.source,
      trigger_node: t.source === "sensor" ? t.nodeId : null,
      trigger_channel: t.source === "sensor" ? t.channel : null,
      trigger_at: t.source === "time" ? t.at : null,
      enabled: e.enabled === false ? 0 : 1,
    });
    const effectId = Number(info.lastInsertRowid);
    e.arms.forEach((arm, position) => {
      const armInfo = insArm().run({
        effect_id: effectId,
        position,
        set_node: arm.set.nodeId,
        set_channel: arm.set.channel,
        set_value: JSON.stringify(arm.set.value),
      });
      const armId = Number(armInfo.lastInsertRowid);
      arm.when.forEach((c, ci) => insCond().run(conditionToRow(armId, ci, c)));
    });
  }

  // --- Boundary flat DTO surface (adapted via effect-compat) ---------------

  /** Flat `when → set` view for the dashboard/LLM (single-arm rules only; multi-arm
   * rules have no flat equivalent and are omitted). */
  getNormalized(): NormalizedEffect[] {
    return effectsToFlatList(this.getAll());
  }

  /** Replace the full list from the flat DTO. */
  setNormalized(effects: NormalizedEffect[]): void {
    this.setAll(flatListToEffects(effects));
  }

  /** Append one rule from the flat DTO. */
  addNormalized(effect: NormalizedEffect): void {
    this.add(flatToEffect(effect));
  }

  // --- Legacy IEffect shim (denormalize-on-read / normalize-on-write) ------

  /** Mirrors the old JSONdb.get — denormalizes the stored rules to `IEffect[]`. */
  get(key: string): IEffect[] | undefined {
    if (key !== "effects") return undefined;
    return denormalizeAll(this.getNormalized());
  }

  /** Mirrors the old JSONdb.set — normalizes legacy rules, then stores them. */
  set(key: string, effects: IEffect[], resolveCategory?: CategoryResolver): void {
    if (key !== "effects") return;
    this.setNormalized(normalizeAll(effects || [], resolveCategory));
  }
}
