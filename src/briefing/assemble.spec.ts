// Assembler + template, with the fetchers injected (no calendar-service, no Open-Meteo).
import { assembleBrief, buildBriefText, BriefFetchers, BriefFacts } from "./assemble";

const fetchers = (over: Partial<BriefFetchers> = {}): BriefFetchers => ({
  calendarSources: async () => [{ kind: "personal" }],
  calendarEvents: async () => [],
  weather: async () => ({ min: 12, max: 24, description: "despejado" }),
  ...over,
});

describe("assembleBrief", () => {
  it("returns null when the owner has NO personal calendar (never falls back to family)", async () => {
    // The calendar router degrades owner=<unlinked person> to the family calendar; the /sources
    // gate is what keeps that fallback out of a personal brief.
    const f = fetchers({ calendarSources: async () => [{ kind: "family" }] });
    expect(await assembleBrief("bob", "2026-07-02", f)).toBeNull();
  });

  it("returns the day's events + weather for a linked owner", async () => {
    const f = fetchers({
      calendarEvents: async () => [{ title: "Dentista", start: "2026-07-02T09:00" }],
    });
    const facts = await assembleBrief("david", "2026-07-02", f);
    expect(facts!.events).toHaveLength(1);
    expect(facts!.weather).toEqual({ min: 12, max: 24, description: "despejado" });
  });

  it("merges multi-calendar reads chronologically (service returns them grouped per calendar)", async () => {
    const f = fetchers({
      calendarEvents: async () => [
        { title: "Cena", start: "2026-07-02T20:00", calendar: "personal" },
        { title: "Busy", start: "2026-07-02T10:30", calendar: "work" },
      ],
    });
    const facts = await assembleBrief("david", "2026-07-02", f);
    expect(facts!.events.map((e) => e.title)).toEqual(["Busy", "Cena"]);
  });

  it("a weather failure degrades to weather:null, never blocks the calendar half", async () => {
    const f = fetchers({
      calendarEvents: async () => [{ title: "Dentista", start: "2026-07-02T09:00" }],
      weather: async () => {
        throw new Error("open-meteo down");
      },
    });
    const facts = await assembleBrief("david", "2026-07-02", f);
    expect(facts!.events).toHaveLength(1);
    expect(facts!.weather).toBeNull();
  });

  it("a calendar failure propagates (the driver retries next tick)", async () => {
    const f = fetchers({
      calendarEvents: async () => {
        throw new Error("calendar-service 502");
      },
    });
    await expect(assembleBrief("david", "2026-07-02", f)).rejects.toThrow("502");
  });
});

describe("buildBriefText", () => {
  const facts: BriefFacts = {
    events: [
      { title: "Dentista", start: "2026-07-02T09:00" },
      { title: "Busy", start: "2026-07-02T12:00", end: "2026-07-02T12:30" },
      { title: "Cumpleaños", start: "2026-07-02T00:00", all_day: true },
    ],
    weather: { min: 12, max: 24, description: "despejado" },
  };

  it("full depth enumerates times + titles, busy-blocks as 'ocupado', all-day flagged", () => {
    const text = buildBriefText("David", facts, "full");
    expect(text).toContain("Buenos días, David.");
    expect(text).toContain("3 cosas");
    expect(text).toContain("a las 9:00, Dentista");
    expect(text).toContain("ocupado de 12:00 a 12:30"); // WHEN, never WHAT, for a busy-only share
    expect(text).toContain("Cumpleaños, todo el día");
    expect(text).toContain("máxima de 24° y mínima de 12°");
  });

  it("count depth says how many, leaks NO titles, and keeps the (non-private) weather", () => {
    const text = buildBriefText("David", facts, "count");
    expect(text).toContain("3 cosas");
    expect(text).not.toContain("Dentista");
    expect(text).not.toContain("Cumpleaños");
    expect(text).toContain("despejado");
  });

  it("singular event reads naturally and a missing forecast omits the weather line", () => {
    const text = buildBriefText(
      "Ana",
      { events: [{ title: "Yoga", start: "2026-07-02T18:30" }], weather: null },
      "full",
    );
    expect(text).toContain("una cosa");
    expect(text).toContain("a las 18:30, Yoga");
    expect(text).not.toContain("clima");
  });
});
