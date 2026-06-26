import type { Effect } from "./effect.model";
import { earliestTimeTrigger, nextOccurrence, MinutesResolver } from "./time-scheduler";

// HH:MM resolver + a fixed solar table for the tests.
const resolve: MinutesResolver = (ref) => {
  if (ref === "sunset") return 19 * 60 + 30; // 19:30
  if (ref === "sunrise") return 6 * 60 + 15; // 06:15
  const m = /^(\d{1,2}):(\d{2})$/.exec(ref);
  return m ? Number(m[1]) * 60 + Number(m[2]) : undefined;
};

const at = (h: number, m = 0) => new Date(2026, 5, 1, h, m, 0);

const timeRule = (ref: string, enabled = true): Effect => ({
  trigger: { source: "time", at: ref },
  arms: [{ when: [], set: { nodeId: "lamp", channel: "brightness", value: 20 } }],
  enabled,
});

describe("nextOccurrence", () => {
  it("returns today's instant when the time is still ahead", () => {
    const d = nextOccurrence("23:00", at(20), resolve)!;
    expect(d.getHours()).toBe(23);
    expect(d.getDate()).toBe(1); // same day
  });

  it("rolls to tomorrow when the time has passed", () => {
    const d = nextOccurrence("23:00", at(23, 30), resolve)!;
    expect(d.getHours()).toBe(23);
    expect(d.getDate()).toBe(2); // next day
  });

  it("resolves a solar ref via the injected resolver", () => {
    const d = nextOccurrence("sunset", at(12), resolve)!;
    expect(d.getHours()).toBe(19);
    expect(d.getMinutes()).toBe(30);
  });

  it("returns null when the ref can't be resolved (solar not yet known)", () => {
    expect(nextOccurrence("sunset", at(12), () => undefined)).toBeNull();
  });
});

describe("earliestTimeTrigger", () => {
  it("picks the soonest upcoming boundary across rules", () => {
    const best = earliestTimeTrigger([timeRule("23:00"), timeRule("sunset")], at(18), resolve)!;
    expect(best.at).toBe("sunset"); // 19:30 today beats 23:00
  });

  it("ignores disabled rules and sensor-triggered rules", () => {
    const sensorRule: Effect = {
      trigger: { source: "sensor", nodeId: "pir", channel: "presence" },
      arms: [{ when: [], set: { nodeId: "lamp", channel: "brightness", value: 100 } }],
      enabled: true,
    };
    const best = earliestTimeTrigger(
      [timeRule("22:00", false), sensorRule, timeRule("06:15")],
      at(20),
      resolve,
    )!;
    // 22:00 is disabled; sensor rule never arms; 06:15 rolls to tomorrow morning.
    expect(best.at).toBe("06:15");
    expect(best.when.getDate()).toBe(2);
  });

  it("returns null when there are no enabled time triggers", () => {
    expect(earliestTimeTrigger([timeRule("22:00", false)], at(20), resolve)).toBeNull();
  });
});
