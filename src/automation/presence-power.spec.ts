// Satellite presence power-save: occupied pushes immediately, empty only after
// the grace window, and only zones that have BOTH a presence sensor and a
// satellite ever get pushed. Mock the three seams (axios, the node registry,
// the presence fusion) so the watcher runs in isolation with fake timers.
const axiosGet = jest.fn((..._a: any[]) => Promise.resolve({ data: {} }));
jest.mock("axios", () => ({ get: (...a: any[]) => (axiosGet as any)(...a) }));

const satellites: any[] = [];
jest.mock("../handlers/node.handler", () => ({
  deviceNodes: () => satellites,
}));

let zones: Map<string, { zone: string; occupied: boolean; sensors: any[] }>;
jest.mock("../ambient/live-rooms", () => ({
  presenceByZone: () => zones,
}));

import {
  onPresenceEdge,
  reconcilePresencePower,
  _resetPresencePower,
} from "./presence-power";

const GRACE_MS = 10 * 60 * 1000; // SAT_ECO_GRACE_MIN default

const sat = (zone: string, ip = "10.0.0.9") => ({ category: "voice-satellite", zone, ip });
const zone = (name: string, occupied: boolean) => ({ zone: name, occupied, sensors: [] });
const pir = (z: string) => ({ category: "presence", zone: z }) as any;

const pushed = () => axiosGet.mock.calls.map((c: any[]) => c[0]);

beforeEach(() => {
  // doNotFake performance: sinon@9 can't hijack Node's read-only global.performance
  // (first install throws half-way, every later install reports "twice").
  jest.useFakeTimers({ doNotFake: ["performance"] });
  satellites.length = 0;
  zones = new Map();
  axiosGet.mockClear();
  _resetPresencePower();
  delete process.env.SAT_ECO_GRACE_MIN;
});

afterEach(() => {
  _resetPresencePower();
  jest.useRealTimers();
});

describe("presence-power edge path", () => {
  it("pushes occupied=1 immediately on a presence edge (mic must beat the person)", () => {
    satellites.push(sat("sala"));
    zones.set("sala", zone("sala", true));
    onPresenceEdge(pir("sala"));
    expect(pushed()).toEqual(["http://10.0.0.9/presence?occupied=1"]);
  });

  it("does not push occupied=0 until the zone has been empty a full grace window", () => {
    satellites.push(sat("sala"));
    zones.set("sala", zone("sala", true));
    onPresenceEdge(pir("sala")); // occupied baseline
    axiosGet.mockClear();

    zones.set("sala", zone("sala", false));
    onPresenceEdge(pir("sala"));
    expect(pushed()).toEqual([]); // nothing yet — grace running

    jest.advanceTimersByTime(GRACE_MS - 1000);
    expect(pushed()).toEqual([]);

    jest.advanceTimersByTime(2000);
    expect(pushed()).toEqual(["http://10.0.0.9/presence?occupied=0"]);
  });

  it("presence returning inside the grace cancels the pending empty push", () => {
    satellites.push(sat("sala"));
    zones.set("sala", zone("sala", true));
    onPresenceEdge(pir("sala"));
    axiosGet.mockClear();

    zones.set("sala", zone("sala", false));
    onPresenceEdge(pir("sala"));
    jest.advanceTimersByTime(GRACE_MS / 2);

    zones.set("sala", zone("sala", true));
    onPresenceEdge(pir("sala"));
    // No re-push: the satellite was never told "empty", so occupied=1 still stands…
    expect(pushed()).toEqual([]);

    jest.advanceTimersByTime(GRACE_MS * 2);
    expect(pushed()).toEqual([]); // …and the pending empty timer must be dead.
  });

  it("dedupes repeated occupied edges (motion re-fires constantly in a busy room)", () => {
    satellites.push(sat("sala"));
    zones.set("sala", zone("sala", true));
    onPresenceEdge(pir("sala"));
    onPresenceEdge(pir("sala"));
    onPresenceEdge(pir("sala"));
    expect(pushed()).toHaveLength(1);
  });

  it("ignores non-presence sensors and unzoned sensors", () => {
    satellites.push(sat("sala"));
    zones.set("sala", zone("sala", true));
    onPresenceEdge({ category: "temp/humidity", zone: "sala" } as any);
    onPresenceEdge({ category: "presence", zone: "" } as any);
    expect(pushed()).toEqual([]);
  });

  it("re-checks live occupancy when the grace expires (a race must not park an occupied room)", () => {
    satellites.push(sat("sala"));
    zones.set("sala", zone("sala", false));
    onPresenceEdge(pir("sala"));
    zones.set("sala", zone("sala", true)); // re-occupied, but no edge delivered (e.g. lost)
    jest.advanceTimersByTime(GRACE_MS + 1000);
    expect(pushed()).toEqual([]);
  });
});

describe("presence-power reconcile sweep", () => {
  it("pushes truth to satellites in covered zones only", () => {
    satellites.push(sat("sala"), sat("oficina", "10.0.0.10"), sat("cuarto", "10.0.0.11"));
    zones.set("sala", zone("sala", true)); // covered + occupied
    // oficina: satellite but NO presence sensor → never pushed
    zones.set("cocina", zone("cocina", true)); // presence sensor but no satellite

    reconcilePresencePower();
    expect(pushed()).toEqual(["http://10.0.0.9/presence?occupied=1"]);
  });

  it("treats a zone first seen empty as occupied until the grace has actually elapsed", () => {
    satellites.push(sat("sala"));
    zones.set("sala", zone("sala", false));

    const t0 = Date.now();
    reconcilePresencePower(t0); // e.g. right after a hub restart
    expect(pushed()).toEqual(["http://10.0.0.9/presence?occupied=1"]); // never eco on a guess
    axiosGet.mockClear();

    jest.advanceTimersByTime(GRACE_MS + 1000);
    // the grace timer armed by the sweep fires the empty push by itself
    expect(pushed()).toEqual(["http://10.0.0.9/presence?occupied=0"]);
    axiosGet.mockClear();

    reconcilePresencePower(t0 + GRACE_MS + 5000);
    expect(pushed()).toEqual(["http://10.0.0.9/presence?occupied=0"]); // sweep keeps re-asserting
  });

  it("pushes every satellite in the zone", () => {
    satellites.push(sat("sala", "10.0.0.9"), sat("sala", "10.0.0.10"));
    zones.set("sala", zone("sala", true));
    reconcilePresencePower();
    expect(pushed()).toEqual([
      "http://10.0.0.9/presence?occupied=1",
      "http://10.0.0.10/presence?occupied=1",
    ]);
  });

  it("respects SAT_ECO_GRACE_MIN", () => {
    process.env.SAT_ECO_GRACE_MIN = "1";
    satellites.push(sat("sala"));
    zones.set("sala", zone("sala", true));
    onPresenceEdge(pir("sala"));
    axiosGet.mockClear();

    zones.set("sala", zone("sala", false));
    onPresenceEdge(pir("sala"));
    jest.advanceTimersByTime(61 * 1000);
    expect(pushed()).toEqual(["http://10.0.0.9/presence?occupied=0"]);
  });
});
