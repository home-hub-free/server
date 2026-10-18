// Recurrence rules (LOCAL_AGENDA) — pure local-time date math.
import { describeRecurrence, firstOccurrence, nextOccurrence, occurrencesBetween, parseRecurrence } from "./recurrence";

const L = (y: number, m: number, d: number, h = 9, min = 0) => new Date(y, m - 1, d, h, min);
const iso = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")} ${d.getHours()}:${String(d.getMinutes()).padStart(2, "0")}`;

describe("parseRecurrence", () => {
  it("accepts the supported set and rejects garbage", () => {
    expect(parseRecurrence(null)).toBeNull();
    expect(parseRecurrence("")).toBeNull();
    expect(parseRecurrence("none")).toBeNull();
    expect(parseRecurrence("daily")).toEqual({ freq: "daily" });
    expect(parseRecurrence("Weekly")).toEqual({ freq: "weekly" });
    expect(parseRecurrence("weekly:2,4")).toEqual({ freq: "weekly", days: [2, 4] });
    expect(parseRecurrence("weekly:4,2,2")).toEqual({ freq: "weekly", days: [2, 4] });
    expect(parseRecurrence("hourly")).toBeUndefined();
    expect(parseRecurrence("weekly:9")).toBeUndefined();
    expect(parseRecurrence("daily:1")).toBeUndefined();
  });
});

describe("step rules", () => {
  it("daily keeps the clock time", () => {
    const next = nextOccurrence(L(2026, 10, 18, 7, 30), { freq: "daily" }, L(2026, 10, 18, 8));
    expect(iso(next!)).toBe("2026-10-19 7:30");
  });

  it("weekdays skips Saturday/Sunday (Fri 2026-10-16 → Mon 10-19)", () => {
    const next = nextOccurrence(L(2026, 10, 16), { freq: "weekdays" }, L(2026, 10, 16, 10));
    expect(iso(next!)).toBe("2026-10-19 9:00");
  });

  it("weekly with a day set slides the anchor onto the first listed weekday", () => {
    // 2026-10-18 is a Sunday; Tue/Thu → first is Tue 10-20, then Thu 10-22, then Tue 10-27.
    const rule = { freq: "weekly" as const, days: [2, 4] };
    expect(iso(firstOccurrence(L(2026, 10, 18), rule))).toBe("2026-10-20 9:00");
    const occ = occurrencesBetween(L(2026, 10, 18), rule, L(2026, 10, 18, 0), L(2026, 10, 28, 0));
    expect(occ.map(iso)).toEqual(["2026-10-20 9:00", "2026-10-22 9:00", "2026-10-27 9:00"]);
  });

  it("monthly clamps to a short month and comes back to the anchor's day", () => {
    const anchor = L(2026, 1, 31, 18);
    const occ = occurrencesBetween(anchor, { freq: "monthly" }, L(2026, 1, 1, 0), L(2026, 5, 31, 23, 59));
    expect(occ.map(iso)).toEqual(["2026-01-31 18:00", "2026-02-28 18:00", "2026-03-31 18:00", "2026-04-30 18:00", "2026-05-31 18:00"]);
  });

  it("yearly handles Feb 29 → Feb 28", () => {
    const occ = occurrencesBetween(L(2028, 2, 29), { freq: "yearly" }, L(2028, 1, 1), L(2030, 12, 31));
    expect(occ.map(iso)).toEqual(["2028-02-29 9:00", "2029-02-28 9:00", "2030-02-28 9:00"]);
  });
});

describe("occurrencesBetween", () => {
  it("a one-shot yields its anchor only when inside the window", () => {
    expect(occurrencesBetween(L(2026, 10, 20), null, L(2026, 10, 18), L(2026, 10, 25)).map(iso)).toEqual(["2026-10-20 9:00"]);
    expect(occurrencesBetween(L(2026, 10, 20), null, L(2026, 10, 21), L(2026, 10, 25))).toEqual([]);
  });

  it("fast-forwards a years-old daily anchor into this week's window", () => {
    const occ = occurrencesBetween(L(2020, 1, 1, 6, 15), { freq: "daily" }, L(2026, 10, 18, 0), L(2026, 10, 20, 23, 59));
    expect(occ.map(iso)).toEqual(["2026-10-18 6:15", "2026-10-19 6:15", "2026-10-20 6:15"]);
  });

  it("respects the cap and an inverted window", () => {
    expect(occurrencesBetween(L(2026, 1, 1), { freq: "daily" }, L(2026, 1, 1), L(2030, 1, 1), 5)).toHaveLength(5);
    expect(occurrencesBetween(L(2026, 1, 1), { freq: "daily" }, L(2026, 2, 1), L(2026, 1, 1))).toEqual([]);
  });
});

describe("describeRecurrence", () => {
  it("speaks Spanish", () => {
    expect(describeRecurrence(parseRecurrence("daily")!)).toBe("cada día");
    expect(describeRecurrence(parseRecurrence("weekly:1,3")!)).toBe("cada lunes, miércoles");
    expect(describeRecurrence(null)).toBe("");
  });
});
