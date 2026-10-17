/**
 * Regression: the 30-minute weather refresh must survive a failing forecast fetch.
 *
 * 2026-09-20..29 Open-Meteo answered 503 for ten days; `updateWeatherData()` rejected on the
 * scheduler's interval with nothing catching it, Node escalated the unhandled rejection to a
 * process exit, and systemd restarted the hub ~48 times a day. These tests drive the exported
 * tick AND the real interval (fake timers) and assert no rejection escapes.
 */

const weatherImpl = jest.fn<Promise<any>, []>();
const logged: Array<[string, string[]]> = [];

jest.mock("./forecast.handler", () => ({
  forecast: { hourlyTemperatures: [] },
  updateWeatherData: () => weatherImpl(),
}));
jest.mock("./google-calendar.handler", () => ({ readCalendars: () => Promise.resolve([]) }));
jest.mock("./node.handler", () => ({ nodes: [] }));
jest.mock("../v-assistant/v-assistant.class", () => ({
  assistant: { tempDifferenceAnnouncements: {}, autoForecasted: {}, say: () => Promise.resolve(false) },
  VAssistantDB: { get: () => undefined },
}));
jest.mock("../logger", () => ({
  EVENT_TYPES: { error: "[ERROR]", daily_event: "[DAILY EVENT]" },
  log: (type: string, texts: string[]) => logged.push([type, texts]),
}));

const THIRTY_MIN = 30 * 60 * 1000;

let handler: typeof import("./daily-events.handler");
let unhandled: unknown[] = [];
const onUnhandled = (reason: unknown) => unhandled.push(reason);

beforeAll(() => {
  // Fake timers BEFORE the module loads so its module-level setInterval()s are captured.
  jest.useFakeTimers({ doNotFake: ["setImmediate", "nextTick", "performance"] });
  handler = require("./daily-events.handler");
});
afterAll(() => jest.useRealTimers());

beforeEach(() => {
  logged.length = 0;
  unhandled = [];
  weatherImpl.mockReset();
  process.on("unhandledRejection", onUnhandled);
});
afterEach(() => {
  process.off("unhandledRejection", onUnhandled);
});

const flush = () => new Promise<void>((r) => setImmediate(r));

describe("weatherTick", () => {
  it("absorbs a rejected forecast fetch: resolves, logs one text-only error, nothing escapes", async () => {
    const err: any = new Error("Request failed with status code 503");
    err.response = { status: 503 };
    weatherImpl.mockRejectedValueOnce(err);

    await expect(handler.weatherTick()).resolves.toBeUndefined();
    await flush();

    expect(unhandled).toEqual([]);
    const errors = logged.filter(([type]) => type === "[ERROR]");
    expect(errors).toHaveLength(1);
    expect(errors[0][1]).toEqual([expect.stringContaining("status code 503")]);
    expect(errors[0][1][0]).toContain("(HTTP 503)");
    expect(typeof errors[0][1][0]).toBe("string");
  });

  it("logs nothing on a successful refresh", async () => {
    weatherImpl.mockResolvedValueOnce({ forecast: {}, astro: {} });
    await expect(handler.weatherTick()).resolves.toBeUndefined();
    await flush();
    expect(unhandled).toEqual([]);
    expect(logged.filter(([type]) => type === "[ERROR]")).toHaveLength(0);
  });
});

describe("the 30-minute interval (the actual crash site)", () => {
  it("keeps ticking across consecutive failures without an unhandled rejection", async () => {
    weatherImpl.mockRejectedValue(new Error("getaddrinfo ENOTFOUND api.open-meteo.com"));

    for (let i = 0; i < 3; i++) {
      jest.advanceTimersByTime(THIRTY_MIN);
      await flush();
    }

    expect(weatherImpl).toHaveBeenCalledTimes(3);
    expect(unhandled).toEqual([]);
    expect(logged.filter(([type]) => type === "[ERROR]")).toHaveLength(3);
  });
});
