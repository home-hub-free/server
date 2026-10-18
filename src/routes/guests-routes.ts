import { Express } from "express";
import { guestsRepo, Treatment } from "../db/guests.repo";
import { usersRepo } from "../db/users.repo";
import { requireAuth } from "../auth/middleware";

/**
 * /guests — the guest registry: people who are not household members but whom the
 * house may need to address, each with a free-text relationship to one or more
 * members ("mamá de David", "vecina de Ana") and a treatment (tú / usted).
 *
 * Reads stay open like every other hub GET (the roster is LAN-local data); writes
 * need a signed-in member OR the service token (reflex writing by voice). The
 * dashboard and reflex use the SAME routes, so what one surface can set the other
 * can too. `POST /guests/declare` is the idempotent "learn this in one sentence"
 * shape the voice path needs: create-or-update by name plus one relation.
 */
function toTreatment(v: unknown): Treatment | undefined {
  if (v === undefined || v === null) return undefined;
  return v === "tu" || v === "usted" ? v : "";
}

function cleanAliases(v: unknown): string[] | undefined {
  if (v === undefined) return undefined;
  if (!Array.isArray(v)) return [];
  return v.map((a) => String(a).trim()).filter(Boolean);
}

export function initGuestsRoutes(app: Express) {
  // List, or resolve one by name/alias (`?name=lupita`). Open read.
  app.get("/guests", (req, res) => {
    const name = typeof req.query.name === "string" ? req.query.name.trim() : "";
    if (name) return res.json({ ok: true, guest: guestsRepo.findByName(name) ?? null });
    return res.json({ ok: true, guests: guestsRepo.list() });
  });

  app.get("/guests/:id", (req, res) => {
    const g = guestsRepo.getById(req.params.id);
    if (!g) return res.status(404).json({ ok: false, error: "not found" });
    return res.json({ ok: true, guest: g });
  });

  app.post("/guests", requireAuth, (req, res) => {
    const { name, aliases, treatment, notes, relations } = req.body || {};
    if (!name || typeof name !== "string" || !name.trim()) {
      return res.status(400).json({ ok: false, error: "name required" });
    }
    const rels: Array<{ memberId: string; relation: string }> = Array.isArray(relations)
      ? relations.filter((r: any) => r && typeof r.memberId === "string" && typeof r.relation === "string" && r.relation.trim())
      : [];
    for (const r of rels) {
      if (!usersRepo.getById(r.memberId)) return res.status(404).json({ ok: false, error: `unknown member ${r.memberId}` });
    }
    try {
      const guest = guestsRepo.create({
        name,
        aliases: cleanAliases(aliases),
        treatment: toTreatment(treatment),
        notes: typeof notes === "string" ? notes : undefined,
        relations: rels,
      });
      return res.status(201).json({ ok: true, guest });
    } catch (err: any) {
      const msg = err?.message || "could not create guest";
      return res.status(/exists/.test(msg) ? 409 : 400).json({ ok: false, error: msg });
    }
  });

  // Idempotent one-sentence learn (the voice path): create-or-update by name, set one
  // relation and/or the treatment. "Lupita es mi mamá" → {name:"Lupita", memberId:<speaker>, relation:"mamá"}.
  app.post("/guests/declare", requireAuth, (req, res) => {
    const { name, memberId, relation, treatment, aliases, notes } = req.body || {};
    if (!name || typeof name !== "string" || !name.trim()) {
      return res.status(400).json({ ok: false, error: "name required" });
    }
    const hasRelation = typeof memberId === "string" && memberId && typeof relation === "string" && relation.trim();
    if ((memberId || relation) && !hasRelation) {
      return res.status(400).json({ ok: false, error: "memberId and relation go together" });
    }
    if (hasRelation && !usersRepo.getById(memberId)) {
      return res.status(404).json({ ok: false, error: `unknown member ${memberId}` });
    }
    let guest = guestsRepo.findByName(name);
    let created = false;
    try {
      if (!guest) {
        guest = guestsRepo.create({ name: name.trim(), aliases: cleanAliases(aliases), treatment: toTreatment(treatment), notes: typeof notes === "string" ? notes : undefined });
        created = true;
      } else {
        const patch: { treatment?: Treatment; aliases?: string[]; notes?: string } = {};
        const t = toTreatment(treatment);
        if (t !== undefined) patch.treatment = t;
        const al = cleanAliases(aliases);
        if (al) patch.aliases = [...new Set([...guest.aliases, ...al])];
        if (typeof notes === "string") patch.notes = notes;
        if (Object.keys(patch).length) guest = guestsRepo.update(guest.id, patch) ?? guest;
      }
      if (hasRelation) guest = guestsRepo.setRelation(guest.id, memberId, relation) ?? guest;
      return res.status(created ? 201 : 200).json({ ok: true, created, guest });
    } catch (err: any) {
      return res.status(400).json({ ok: false, error: err?.message || "could not declare guest" });
    }
  });

  app.patch("/guests/:id", requireAuth, (req, res) => {
    const { id } = req.params;
    if (!guestsRepo.getById(id)) return res.status(404).json({ ok: false, error: "not found" });
    const { name, aliases, treatment, notes } = req.body || {};
    const guest = guestsRepo.update(id, {
      name: typeof name === "string" ? name : undefined,
      aliases: cleanAliases(aliases),
      treatment: toTreatment(treatment),
      notes: typeof notes === "string" ? notes : undefined,
    });
    return res.json({ ok: true, guest });
  });

  app.delete("/guests/:id", requireAuth, (req, res) => {
    if (!guestsRepo.remove(req.params.id)) return res.status(404).json({ ok: false, error: "not found" });
    return res.json({ ok: true });
  });

  app.put("/guests/:id/relations/:memberId", requireAuth, (req, res) => {
    const { id, memberId } = req.params;
    if (!guestsRepo.getById(id)) return res.status(404).json({ ok: false, error: "unknown guest" });
    if (!usersRepo.getById(memberId)) return res.status(404).json({ ok: false, error: "unknown member" });
    const relation = typeof req.body?.relation === "string" ? req.body.relation.trim() : "";
    if (!relation) return res.status(400).json({ ok: false, error: "relation required" });
    return res.json({ ok: true, guest: guestsRepo.setRelation(id, memberId, relation) });
  });

  app.delete("/guests/:id/relations/:memberId", requireAuth, (req, res) => {
    const { id, memberId } = req.params;
    if (!guestsRepo.getById(id)) return res.status(404).json({ ok: false, error: "unknown guest" });
    return res.json({ ok: true, guest: guestsRepo.removeRelation(id, memberId) });
  });
}
