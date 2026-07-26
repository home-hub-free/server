/**
 * /set-effect, /update-effect, /set-effects — the D10 validation + D2 duplicate-guard
 * contract (EFFECT_CREATION_REPAIR.md Phase 2 step 2.3):
 *   1. /set-effect and /update-effect validate BEFORE checking for a duplicate — a bad
 *      HH:MM or an empty arm list always 400s, even against a store that already holds
 *      a (bypass-inserted) invalid "duplicate" row;
 *   2. an exact structural duplicate 409s with {ok:false, duplicate:true, existingId},
 *      spanning disabled rows too;
 *   3. /update-effect excludes its own row from the duplicate check;
 *   4. /set-effect success now returns {ok:true, id}; /update-effect's pre-existing
 *      {ok, id} shape is unchanged;
 *   5. /set-effects dedupes the incoming list silently (first occurrence wins), runs no
 *      validation, and never 409s.
 * Same handlers-off-a-fake-app harness as camera-routes.spec.ts / assistant-chat-routes.spec.ts,
 * but effects-routes has no external service to mock — EffectsDB is the real repo against the
 * in-memory test db (db/repos.spec.ts's convention), so this exercises route + repo together.
 */
jest.mock("../auth/middleware", () => ({
  requireAuth: (_req: any, _res: any, next: any) => next(),
}));

import { initEffectsRoutes, EffectsDB } from "./effects-routes";

type Handler = (req: any, res: any) => void;
const handlers: Record<string, Handler> = {};
const fakeApp: any = {
  get: (path: string, h: Handler) => (handlers[`GET ${path}`] = h),
  post: (path: string, _auth: any, h: Handler) => (handlers[`POST ${path}`] = h),
};
initEffectsRoutes(fakeApp);

function fakeRes() {
  const res: any = { statusCode: 200 };
  res.status = (s: number) => ((res.statusCode = s), res);
  res.send = (b: any) => ((res.body = b), res);
  return res;
}

const sensorEffect = (overrides: any = {}) => ({
  trigger: { source: "sensor", nodeId: "pir-sala", channel: "presence" },
  arms: [
    { when: [{ kind: "sensor", nodeId: "pir-sala", channel: "presence", op: "eq", value: true }], set: { nodeId: "light-sala", channel: "power", value: true } },
  ],
  enabled: true,
  ...overrides,
});

const timeEffect = (at: string, overrides: any = {}) => ({
  trigger: { source: "time", at },
  arms: [{ when: [], set: { nodeId: "lamp-hall", channel: "power", value: true } }],
  enabled: true,
  ...overrides,
});

beforeEach(() => {
  EffectsDB.setAll([]); // isolate each test — the route handlers share one live repo instance
});

describe("POST /set-effect", () => {
  it("200s a valid rule and returns {ok:true, id}", async () => {
    const res = fakeRes();
    await handlers["POST /set-effect"]({ body: { effect: sensorEffect() } }, res);
    expect(res.statusCode).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(typeof res.body.id).toBe("number");
    expect(EffectsDB.getAll()).toHaveLength(1);
  });

  it("400s an empty arms list, before it ever reaches storage", async () => {
    const res = fakeRes();
    await handlers["POST /set-effect"]({ body: { effect: sensorEffect({ arms: [] }) } }, res);
    expect(res.statusCode).toBe(400);
    expect(res.body).toEqual({ ok: false, error: expect.any(String) });
    expect(EffectsDB.getAll()).toHaveLength(0);
  });

  it.each([
    ["24:00", false], // hour out of range
    ["12:60", false], // minute out of range
    ["7:00", false], // not zero-padded
    ["07:5", false], // not zero-padded
    ["00:00", true],
    ["23:59", true],
  ])("trigger.at %s valid=%s", async (at, valid) => {
    const res = fakeRes();
    await handlers["POST /set-effect"]({ body: { effect: timeEffect(at) } }, res);
    expect(res.statusCode).toBe(valid ? 200 : 400);
  });

  it("400s a bad time-condition from/to inside an arm", async () => {
    const res = fakeRes();
    await handlers["POST /set-effect"]({
      body: {
        effect: {
          trigger: { source: "sensor", nodeId: "motion-hall", channel: "presence" },
          arms: [{ when: [{ kind: "time", op: "between", from: "07:00", to: "25:00" }], set: { nodeId: "lamp", channel: "brightness", value: 100 } }],
          enabled: true,
        },
      },
    }, res);
    expect(res.statusCode).toBe(400);
  });

  it("409s an exact duplicate with {ok:false, duplicate:true, existingId}", async () => {
    const first = fakeRes();
    await handlers["POST /set-effect"]({ body: { effect: sensorEffect() } }, first);
    const existingId = first.body.id;

    const second = fakeRes();
    await handlers["POST /set-effect"]({ body: { effect: sensorEffect() } }, second);
    expect(second.statusCode).toBe(409);
    expect(second.body).toEqual({ ok: false, duplicate: true, existingId });
    expect(EffectsDB.getAll()).toHaveLength(1); // the second post never landed
  });

  it("409s against a DISABLED stored duplicate too", async () => {
    const first = fakeRes();
    await handlers["POST /set-effect"]({ body: { effect: sensorEffect({ enabled: false }) } }, first);
    const existingId = first.body.id;

    const second = fakeRes();
    await handlers["POST /set-effect"]({ body: { effect: sensorEffect({ enabled: true }) } }, second);
    expect(second.statusCode).toBe(409);
    expect(second.body.existingId).toBe(existingId);
  });

  it("treats a string-encoded value as a duplicate of its typed equivalent", async () => {
    const first = fakeRes();
    await handlers["POST /set-effect"]({ body: { effect: sensorEffect() } }, first);

    const second = fakeRes();
    const stringy = sensorEffect();
    stringy.arms[0].when[0].value = "true" as any;
    await handlers["POST /set-effect"]({ body: { effect: stringy } }, second);
    expect(second.statusCode).toBe(409);
  });

  it("validation runs BEFORE the duplicate check, even against an existing (bypass-inserted) invalid duplicate", async () => {
    // /set-effects applies no D10 validation, so it's the one legitimate way an invalid
    // rule can already be sitting in storage — set up that adversarial precondition here.
    const bad = timeEffect("24:00");
    await handlers["POST /set-effects"]({ body: { effects: [bad] } }, fakeRes());
    expect(EffectsDB.getAll()).toHaveLength(1); // confirms the bypass actually stored it

    const res = fakeRes();
    await handlers["POST /set-effect"]({ body: { effect: bad } }, res);
    expect(res.statusCode).toBe(400); // NOT 409 — validation wins the race
    expect(res.body.duplicate).toBeUndefined();
  });
});

describe("POST /update-effect", () => {
  it("200s and updates the row in place", async () => {
    const created = fakeRes();
    await handlers["POST /set-effect"]({ body: { effect: sensorEffect() } }, created);
    const id = created.body.id;

    const res = fakeRes();
    const edited = timeEffect("08:00");
    await handlers["POST /update-effect"]({ body: { id, effect: edited } }, res);
    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({ ok: true, id });
    expect(EffectsDB.getAll()[0].trigger).toEqual({ source: "time", at: "08:00" });
  });

  it("400s a non-numeric id before touching validation or storage", async () => {
    const res = fakeRes();
    await handlers["POST /update-effect"]({ body: { id: "not-a-number", effect: sensorEffect() } }, res);
    expect(res.statusCode).toBe(400);
    expect(res.body).toEqual({ ok: false, error: "numeric id required" });
  });

  it("400s an invalid effect body (D10) for an otherwise-valid id", async () => {
    const created = fakeRes();
    await handlers["POST /set-effect"]({ body: { effect: sensorEffect() } }, created);
    const id = created.body.id;

    const res = fakeRes();
    await handlers["POST /update-effect"]({ body: { id, effect: sensorEffect({ arms: [] }) } }, res);
    expect(res.statusCode).toBe(400);
  });

  it("does NOT 409 when editing a rule back to its own current shape (excludeId)", async () => {
    const created = fakeRes();
    await handlers["POST /set-effect"]({ body: { effect: sensorEffect() } }, created);
    const id = created.body.id;

    const res = fakeRes();
    await handlers["POST /update-effect"]({ body: { id, effect: sensorEffect() } }, res);
    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({ ok: true, id });
  });

  it("409s when editing a rule into a shape ANOTHER existing rule already has", async () => {
    const first = fakeRes();
    await handlers["POST /set-effect"]({ body: { effect: sensorEffect() } }, first);
    const second = fakeRes();
    await handlers["POST /set-effect"]({ body: { effect: timeEffect("09:00") } }, second);
    const idToEdit = second.body.id;

    const res = fakeRes();
    await handlers["POST /update-effect"]({ body: { id: idToEdit, effect: sensorEffect() } }, res);
    expect(res.statusCode).toBe(409);
    expect(res.body).toEqual({ ok: false, duplicate: true, existingId: first.body.id });
  });

  it("{ok:false, id} for an unknown id with an otherwise-valid, non-duplicate effect (unchanged pre-existing behavior)", async () => {
    const res = fakeRes();
    await handlers["POST /update-effect"]({ body: { id: 999999, effect: sensorEffect() } }, res);
    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({ ok: false, id: 999999 });
  });
});

describe("POST /set-effects (bulk replace)", () => {
  it("dedupes the incoming list silently — first occurrence wins, no 409", async () => {
    const a = sensorEffect({ enabled: true });
    const dupOfA = sensorEffect({ enabled: false }); // structurally a dup of `a` per D2 (enabled excluded)
    const c = timeEffect("10:00");

    const res = fakeRes();
    await handlers["POST /set-effects"]({ body: { effects: [a, dupOfA, c] } }, res);
    expect(res.statusCode).toBe(200);
    expect(res.body).toBe(true); // response shape unchanged by this plan

    const stored = EffectsDB.getAll();
    expect(stored).toHaveLength(2);
    expect(stored[0].enabled).toBe(true); // `a` (the first occurrence) survived, not dupOfA
    expect(stored[1].trigger).toEqual({ source: "time", at: "10:00" });
  });

  it("runs NO validation (bulk replace stays permissive)", async () => {
    const res = fakeRes();
    await handlers["POST /set-effects"]({ body: { effects: [timeEffect("24:00"), sensorEffect({ arms: [] })] } }, res);
    expect(res.statusCode).toBe(200);
    expect(EffectsDB.getAll()).toHaveLength(2);
  });
});
