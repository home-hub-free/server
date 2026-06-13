/**
 * Regression test for the presence grace-period race condition.
 *
 * Symptom: a presence sensor goes inactive (server schedules an "off" after a
 * grace period) and then active again at almost the same moment the grace timer
 * fires. The "off" device request is still in-flight when the "on" effect is
 * evaluated, so the on-effect reads a stale "on" value, concludes "already on",
 * and skips — leaving the room dark while presence is still detected.
 *
 * The fix commits the device's value optimistically at dispatch time (see
 * Device.notifyDevice) so the on-effect reads the latest intent, and the late
 * "off" resolution can no longer clobber it.
 */

// --- Controllable axios mock: every get() returns a deferred we resolve by hand.
const pendingResolvers: Array<(v?: unknown) => void> = [];
jest.mock("axios", () => ({
  __esModule: true,
  default: {
    get: jest.fn(
      () => new Promise((resolve) => pendingResolvers.push(resolve as any)),
    ),
  },
}));

jest.mock("../handlers/websockets.handler", () => ({
  io: { emit: jest.fn() },
}));

jest.mock("../handlers/daily-events.handler", () => ({
  dailyEvents: {
    sunrise: { time: new Date() },
    sunset: { time: new Date() },
  },
}));

// Shared device registry that both Device and Sensor read from.
jest.mock("../handlers/device.handler", () => ({
  devices: [],
  DevicesDB: { get: () => undefined },
  buildClientDeviceData: (d: any) => d,
  pullIpFromAddress: (ip: string) => ip,
}));

jest.mock("../handlers/sensor.handler", () => ({
  SensorsDB: { get: () => undefined },
}));

jest.mock("../routes/effects-routes", () => ({
  EffectsDB: { get: () => undefined },
}));

jest.mock("../v-assistant/v-assistant.class", () => ({
  assistant: { lastAutoForecast: 0, autoForecasted: {}, sayWeatherForecast: jest.fn() },
}));

import { Device } from "./device.class";
import { Sensor } from "./sensor.class";
import { devices } from "../handlers/device.handler";

// Capture scheduled grace-period callbacks so we can fire them deterministically
// without relying on jest fake timers (incompatible with this Node version).
let scheduled: Array<() => void> = [];
let timerHandle = 0;

function flushPending() {
  // Resolve any in-flight axios calls, then let microtasks settle.
  const resolvers = pendingResolvers.splice(0);
  resolvers.forEach((r) => r());
  return Promise.resolve();
}

describe("presence grace-period race", () => {
  beforeEach(() => {
    pendingResolvers.length = 0;
    (devices as any).length = 0;
    scheduled = [];
    timerHandle = 0;
    jest
      .spyOn(global, "setTimeout")
      .mockImplementation(((fn: () => void) => {
        scheduled.push(fn);
        return ++timerHandle as any;
      }) as any);
    jest.spyOn(global, "clearTimeout").mockImplementation((() => {}) as any);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  function buildLightWiredToPresence() {
    const light = new Device("light-1", "light", "boolean");
    light.ip = "192.168.1.50";
    light.value = true; // light currently ON

    const presence = new Sensor("presence-1", "presence", "boolean");
    presence.value = true; // presence currently active
    presence.setEffect({
      when: { id: "presence-1", type: "sensor", is: true },
      set: { id: "light-1", value: true },
    });
    presence.setEffect({
      when: { id: "presence-1", type: "sensor", is: false },
      set: { id: "light-1", value: false },
    });

    (devices as any).push(light);
    return { light, presence };
  }

  it("keeps the light ON when active arrives while the off request is in-flight", async () => {
    const { light, presence } = buildLightWiredToPresence();

    // Presence lost -> schedules the grace-period off.
    presence.update(0);
    expect(scheduled).toHaveLength(1);

    // Grace period elapses: the off-effect fires and dispatches an off request
    // that is intentionally left in-flight (not yet resolved).
    scheduled.shift()!();
    expect(light.value).toBe(false); // optimistic off committed

    // Presence returns at this very moment, before the off request resolved.
    presence.update(1);
    expect(light.value).toBe(true); // on-effect saw false and re-triggered

    // The dangerous ordering: the stale OFF resolves AFTER the ON. It must not
    // clobber the light back off.
    await flushPending();

    expect(light.value).toBe(true);
  });
});
