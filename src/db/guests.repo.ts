import { db } from "./connection";

/**
 * Guests + their relationships to household members (see schema.ts). A guest is
 * anyone the house may need to address who is NOT a member: a visiting parent, a
 * neighbour, a member's friend. The registry is deliberately generic — the
 * relationship is free text per (guest, member) pair ("mamá", "vecino", "jefa"),
 * and `treatment` records how the house should speak to them (tú / usted).
 *
 * Two writers share this surface: the dashboard (Settings → Household → Guests)
 * and reflex by voice ("Lupita es mi mamá", "a Lupita háblale de usted"); both go
 * through the /guests routes, so the capability stays mirrored across surfaces.
 */

export type Treatment = "tu" | "usted" | "";

export interface GuestRelation {
  memberId: string;
  /** The member's display name at read time (joined; never stored on the relation). */
  memberName: string;
  relation: string;
}

export interface Guest {
  id: string;
  name: string;
  aliases: string[];
  treatment: Treatment;
  notes: string;
  relations: GuestRelation[];
  createdAt: string;
  updatedAt: string;
}

interface GuestRow {
  id: string;
  name: string;
  aliases: string;
  treatment: string;
  notes: string;
  created_at: string;
  updated_at: string;
}

interface RelationRow {
  guest_id: string;
  member_id: string;
  member_name: string | null;
  relation: string;
}

/** Lowercase, accent-stripped, non-alphanumerics → '-'. Shared by ids and name matching. */
export function slugifyName(name: string): string {
  return name
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function parseAliases(raw: string): string[] {
  try {
    const v = JSON.parse(raw || "[]");
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}

function toTreatment(v: unknown): Treatment {
  return v === "tu" || v === "usted" ? v : "";
}

const insertStmt = db.prepare(
  `INSERT INTO guests (id, name, aliases, treatment, notes) VALUES (@id, @name, @aliases, @treatment, @notes)`,
);
const byIdStmt = db.prepare("SELECT * FROM guests WHERE id = ?");
const listStmt = db.prepare("SELECT * FROM guests ORDER BY name COLLATE NOCASE ASC");
const updateStmt = db.prepare(
  `UPDATE guests SET name = @name, aliases = @aliases, treatment = @treatment, notes = @notes,
     updated_at = datetime('now') WHERE id = @id`,
);
const deleteStmt = db.prepare("DELETE FROM guests WHERE id = ?");
const touchStmt = db.prepare("UPDATE guests SET updated_at = datetime('now') WHERE id = ?");

const relationsAllStmt = db.prepare(
  `SELECT r.guest_id, r.member_id, r.relation, u.display_name AS member_name
     FROM guest_relations r LEFT JOIN users u ON u.id = r.member_id
    ORDER BY r.guest_id, u.display_name COLLATE NOCASE`,
);
const relationsForStmt = db.prepare(
  `SELECT r.guest_id, r.member_id, r.relation, u.display_name AS member_name
     FROM guest_relations r LEFT JOIN users u ON u.id = r.member_id
    WHERE r.guest_id = ? ORDER BY u.display_name COLLATE NOCASE`,
);
const upsertRelationStmt = db.prepare(
  `INSERT INTO guest_relations (guest_id, member_id, relation) VALUES (?, ?, ?)
   ON CONFLICT(guest_id, member_id) DO UPDATE SET relation = excluded.relation`,
);
const deleteRelationStmt = db.prepare("DELETE FROM guest_relations WHERE guest_id = ? AND member_id = ?");

function toGuest(row: GuestRow, relations: RelationRow[]): Guest {
  return {
    id: row.id,
    name: row.name,
    aliases: parseAliases(row.aliases),
    treatment: toTreatment(row.treatment),
    notes: row.notes || "",
    relations: relations.map((r) => ({ memberId: r.member_id, memberName: r.member_name || r.member_id, relation: r.relation })),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export interface CreateGuestInput {
  name: string;
  aliases?: string[];
  treatment?: Treatment;
  notes?: string;
  relations?: Array<{ memberId: string; relation: string }>;
}

export interface UpdateGuestInput {
  name?: string;
  aliases?: string[];
  treatment?: Treatment;
  notes?: string;
}

export class GuestsRepo {
  list(): Guest[] {
    const rels = relationsAllStmt.all() as RelationRow[];
    const byGuest = new Map<string, RelationRow[]>();
    for (const r of rels) {
      const arr = byGuest.get(r.guest_id) ?? [];
      arr.push(r);
      byGuest.set(r.guest_id, arr);
    }
    return (listStmt.all() as GuestRow[]).map((row) => toGuest(row, byGuest.get(row.id) ?? []));
  }

  getById(id: string): Guest | undefined {
    const row = byIdStmt.get(id) as GuestRow | undefined;
    if (!row) return undefined;
    return toGuest(row, relationsForStmt.all(id) as RelationRow[]);
  }

  /** Find by name or alias, accent/case-insensitive ("lupita", "Doña Lupita" → the same row). */
  findByName(name: string): Guest | undefined {
    const key = slugifyName(name);
    if (!key) return undefined;
    const direct = this.getById(key);
    if (direct) return direct;
    for (const g of this.list()) {
      if (slugifyName(g.name) === key) return g;
      if (g.aliases.some((a) => slugifyName(a) === key)) return g;
    }
    return undefined;
  }

  /** Create a guest. Throws on an empty/unslugifiable name or a duplicate id. */
  create(input: CreateGuestInput): Guest {
    const name = (input.name || "").trim();
    const id = slugifyName(name);
    if (!id) throw new Error("invalid guest name");
    if (byIdStmt.get(id)) throw new Error("guest already exists");
    insertStmt.run({
      id,
      name,
      aliases: JSON.stringify((input.aliases ?? []).map((a) => a.trim()).filter(Boolean)),
      treatment: toTreatment(input.treatment),
      notes: (input.notes ?? "").trim(),
    });
    for (const r of input.relations ?? []) this.setRelation(id, r.memberId, r.relation);
    return this.getById(id)!;
  }

  update(id: string, patch: UpdateGuestInput): Guest | undefined {
    const cur = byIdStmt.get(id) as GuestRow | undefined;
    if (!cur) return undefined;
    updateStmt.run({
      id,
      name: typeof patch.name === "string" && patch.name.trim() ? patch.name.trim() : cur.name,
      aliases: JSON.stringify(
        Array.isArray(patch.aliases) ? patch.aliases.map((a) => String(a).trim()).filter(Boolean) : parseAliases(cur.aliases),
      ),
      treatment: patch.treatment === undefined ? toTreatment(cur.treatment) : toTreatment(patch.treatment),
      notes: typeof patch.notes === "string" ? patch.notes.trim() : cur.notes,
    });
    return this.getById(id);
  }

  /** Set (or replace) the guest's relationship to one member. Throws when either side is unknown (FK). */
  setRelation(guestId: string, memberId: string, relation: string): Guest | undefined {
    const rel = (relation || "").trim();
    if (!rel) throw new Error("relation required");
    upsertRelationStmt.run(guestId, memberId, rel);
    touchStmt.run(guestId);
    return this.getById(guestId);
  }

  removeRelation(guestId: string, memberId: string): Guest | undefined {
    deleteRelationStmt.run(guestId, memberId);
    touchStmt.run(guestId);
    return this.getById(guestId);
  }

  remove(id: string): boolean {
    return deleteStmt.run(id).changes > 0; // relations cascade
  }
}

export const guestsRepo = new GuestsRepo();
