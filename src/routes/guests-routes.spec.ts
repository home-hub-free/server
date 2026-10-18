/**
 * /guests — the guest registry routes against the real repos on the in-memory test DB
 * (same handlers-off-a-fake-app harness as effects-routes.spec.ts). Covers: create + list,
 * name/alias resolve, the idempotent /guests/declare upsert the voice path uses, relation
 * set/replace/remove with member FK checks, treatment validation, delete cascade.
 */
jest.mock("../auth/middleware", () => ({
  requireAuth: (_req: any, _res: any, next: any) => next(),
}));

import { initGuestsRoutes } from "./guests-routes";
import { usersRepo } from "../db/users.repo";
import { guestsRepo } from "../db/guests.repo";

type Handler = (req: any, res: any) => void;
const handlers: Record<string, Handler> = {};
const reg = (method: string) => (path: string, a: any, b?: any) => {
  handlers[`${method} ${path}`] = b ?? a;
};
const fakeApp: any = { get: reg("GET"), post: reg("POST"), patch: reg("PATCH"), put: reg("PUT"), delete: reg("DELETE") };
initGuestsRoutes(fakeApp);

function fakeRes() {
  const res: any = { statusCode: 200 };
  res.status = (s: number) => ((res.statusCode = s), res);
  res.json = (b: any) => ((res.body = b), res);
  res.send = res.json;
  return res;
}
function call(key: string, req: any = {}) {
  const res = fakeRes();
  handlers[key]({ body: {}, params: {}, query: {}, ...req }, res);
  return res;
}

beforeAll(() => {
  usersRepo.create({ username: "david", displayName: "David", password: "x" });
  usersRepo.create({ username: "ana", displayName: "Ana", password: "x" });
});

describe("/guests", () => {
  it("creates a guest with relations and lists it with member names joined", () => {
    const r = call("POST /guests", { body: { name: "Lupita", treatment: "usted", relations: [{ memberId: "david", relation: "mamá" }] } });
    expect(r.statusCode).toBe(201);
    expect(r.body.guest.id).toBe("lupita");
    expect(r.body.guest.treatment).toBe("usted");
    expect(r.body.guest.relations).toEqual([{ memberId: "david", memberName: "David", relation: "mamá" }]);
    const list = call("GET /guests");
    expect(list.body.guests.map((g: any) => g.id)).toEqual(["lupita"]);
  });

  it("409s a duplicate and 404s an unknown member", () => {
    expect(call("POST /guests", { body: { name: "lupita" } }).statusCode).toBe(409);
    expect(call("POST /guests", { body: { name: "Pepe", relations: [{ memberId: "nobody", relation: "amigo" }] } }).statusCode).toBe(404);
    expect(call("POST /guests", { body: { name: "  " } }).statusCode).toBe(400);
  });

  it("resolves by name or alias, accent/case-insensitive", () => {
    call("PATCH /guests/:id", { params: { id: "lupita" }, body: { aliases: ["Doña Lupe"] } });
    expect(call("GET /guests", { query: { name: "LUPITA" } }).body.guest.id).toBe("lupita");
    expect(call("GET /guests", { query: { name: "dona lupe" } }).body.guest.id).toBe("lupita");
    expect(call("GET /guests", { query: { name: "nadie" } }).body.guest).toBeNull();
  });

  it("declare is an idempotent upsert: creates once, then adds/replaces relations", () => {
    const a = call("POST /guests/declare", { body: { name: "Toño", memberId: "ana", relation: "hermano" } });
    expect(a.statusCode).toBe(201);
    expect(a.body.created).toBe(true);
    const b = call("POST /guests/declare", { body: { name: "toño", memberId: "david", relation: "cuñado" } });
    expect(b.statusCode).toBe(200);
    expect(b.body.created).toBe(false);
    expect(b.body.guest.relations).toEqual([
      { memberId: "ana", memberName: "Ana", relation: "hermano" },
      { memberId: "david", memberName: "David", relation: "cuñado" },
    ]);
    const c = call("POST /guests/declare", { body: { name: "Toño", memberId: "ana", relation: "hermano mayor" } });
    expect(c.body.guest.relations.find((r: any) => r.memberId === "ana").relation).toBe("hermano mayor");
    // treatment alone, no relation
    const d = call("POST /guests/declare", { body: { name: "Toño", treatment: "tu" } });
    expect(d.statusCode).toBe(200);
    expect(d.body.guest.treatment).toBe("tu");
    // half a relation is a 400; unknown member a 404
    expect(call("POST /guests/declare", { body: { name: "Toño", memberId: "ana" } }).statusCode).toBe(400);
    expect(call("POST /guests/declare", { body: { name: "Toño", memberId: "zz", relation: "x" } }).statusCode).toBe(404);
  });

  it("relation routes set, replace and remove; unknown sides 404", () => {
    expect(call("PUT /guests/:id/relations/:memberId", { params: { id: "lupita", memberId: "ana" }, body: { relation: "suegra" } }).body.guest.relations).toHaveLength(2);
    expect(call("PUT /guests/:id/relations/:memberId", { params: { id: "lupita", memberId: "ana" }, body: { relation: "" } }).statusCode).toBe(400);
    expect(call("PUT /guests/:id/relations/:memberId", { params: { id: "lupita", memberId: "zz" }, body: { relation: "x" } }).statusCode).toBe(404);
    expect(call("PUT /guests/:id/relations/:memberId", { params: { id: "zz", memberId: "ana" }, body: { relation: "x" } }).statusCode).toBe(404);
    const after = call("DELETE /guests/:id/relations/:memberId", { params: { id: "lupita", memberId: "ana" } });
    expect(after.body.guest.relations.map((r: any) => r.memberId)).toEqual(["david"]);
  });

  it("invalid treatment is stored as unspecified; patch keeps untouched fields", () => {
    const r = call("PATCH /guests/:id", { params: { id: "lupita" }, body: { treatment: "vos" } });
    expect(r.body.guest.treatment).toBe("");
    expect(r.body.guest.name).toBe("Lupita");
    expect(r.body.guest.aliases).toEqual(["Doña Lupe"]);
  });

  it("deleting a guest cascades its relations; deleting a member cascades too", () => {
    expect(call("DELETE /guests/:id", { params: { id: "lupita" } }).statusCode).toBe(200);
    expect(call("GET /guests/:id", { params: { id: "lupita" } }).statusCode).toBe(404);
    expect(call("DELETE /guests/:id", { params: { id: "lupita" } }).statusCode).toBe(404);
    usersRepo.remove("ana");
    expect(guestsRepo.getById("tono")!.relations.map((r) => r.memberId)).toEqual(["david"]);
  });
});
