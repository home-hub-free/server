/**
 * Envelope honesty (docs/PATTERN_LIFECYCLE.md §4/§D2/§D6). With the transport
 * ENABLED and a mocked broker, assert that the reaction-plane hints ride the
 * published payload WITHOUT ever overriding the true `source`:
 *  - a covered sensor trigger emits `source:"device"` + `coveredByEffect:true`;
 *  - an effect-driven actuation emits `source:"automation"` + `causedBy`.
 * This is the regression guard for the interim bug (overwriting `source` to
 * "automation"), now fixed.
 */

interface Published {
  topic: string;
  payload: any;
}

// Mock the broker: connect() returns a fake client that immediately "connects"
// and records every publish so we can inspect the wire payloads.
const published: Published[] = [];
jest.mock("mqtt", () => ({
  __esModule: true,
  default: {
    connect: () => {
      const handlers: Record<string, Function> = {};
      const client = {
        on: (event: string, cb: Function) => {
          handlers[event] = cb;
          // Fire "connect" synchronously so `connected` flips true before we publish.
          if (event === "connect") cb();
          return client;
        },
        publish: (topic: string, payload: string, _opts: any, cb?: Function) => {
          published.push({ topic, payload: JSON.parse(payload) });
          if (cb) cb();
        },
        end: () => {},
      };
      return client;
    },
  },
}));

describe("ingestion envelope — honest provenance + reaction hints", () => {
  let ingestion: typeof import("./ingestion");

  beforeEach(() => {
    published.length = 0;
    jest.resetModules();
    process.env.INGESTION_ENABLED = "true";
    jest.isolateModules(() => {
      ingestion = require("./ingestion");
    });
    ingestion.initIngestion();
  });

  afterEach(() => {
    ingestion.closeIngestion();
    delete process.env.INGESTION_ENABLED;
  });

  const channelPayloads = (channel: string) =>
    published.filter((p) => p.topic.endsWith(`/${channel}`)).map((p) => p.payload);

  it("a covered trigger keeps source:device and adds coveredByEffect:true", () => {
    ingestion.emitSensorEvent(
      { id: "pir-sala", sensorType: "presence", zone: "sala", value: true },
      "device",
      { coveredByEffect: true },
    );

    const presence = channelPayloads("presence");
    expect(presence.length).toBeGreaterThan(0);
    for (const p of presence) {
      expect(p.source).toBe("device"); // NOT relabelled to "automation"
      expect(p.coveredByEffect).toBe(true);
      expect(p.causedBy).toBeUndefined();
    }
  });

  it("an uncovered trigger carries no coveredByEffect flag", () => {
    ingestion.emitSensorEvent(
      { id: "pir-sala", sensorType: "presence", zone: "sala", value: true },
      "device",
    );
    for (const p of channelPayloads("presence")) {
      expect(p.source).toBe("device");
      expect(p.coveredByEffect).toBeUndefined();
    }
  });

  it("a vision identity payload rides meta.identity onto the channel event (§5.1)", () => {
    ingestion.emitSensorEvent(
      { id: "pir-sala", sensorType: "presence", zone: "sala", value: true },
      "device",
      { identity: { id: "u_david", name: "David", class: "household", via: "face", confidence: 0.91 } },
    );
    const presence = channelPayloads("presence");
    expect(presence.length).toBeGreaterThan(0);
    for (const p of presence) {
      expect(p.source).toBe("device"); // an observation, never automation/llm
      expect(p.identity).toEqual({
        id: "u_david",
        name: "David",
        class: "household",
        via: "face",
        confidence: 0.91,
      });
    }
  });

  it("a dashboard write carries meta.actor on the wire (who did the manual action)", () => {
    // Regression: EventMeta.actor was typed + stamped by /device-update but never serialized in
    // publish(), so memory could not attribute manual actions to a member.
    ingestion.emitDeviceState(
      { id: "light-sala", deviceCategory: "light", zone: "sala", value: true },
      "dashboard",
      { actor: { id: "u_david", name: "David" } },
    );

    const power = channelPayloads("power");
    expect(power.length).toBeGreaterThan(0);
    for (const p of power) {
      expect(p.source).toBe("dashboard");
      expect(p.actor).toEqual({ id: "u_david", name: "David" });
    }
  });

  it("an unattributed event carries no actor field", () => {
    ingestion.emitDeviceState(
      { id: "light-sala", deviceCategory: "light", zone: "sala", value: true },
      "device",
    );
    for (const p of channelPayloads("power")) {
      expect(p.actor).toBeUndefined();
    }
  });

  it("a device state blob carries deviceCategory (wake-seam category policy)", () => {
    // The mqtt-to-agent wake filter + the gateway's /agent/event guard drop context
    // categories (voice-satellite) by CATEGORY, not device id — the blob must say
    // what kind of node it is.
    ingestion.emitDeviceState(
      { id: "sat-sala", deviceCategory: "voice-satellite", zone: "sala", value: { volume: 35, mic: true, battery: 42 } },
      "device",
    );

    const state = channelPayloads("state");
    expect(state.length).toBeGreaterThan(0);
    for (const p of state) {
      expect(p.deviceCategory).toBe("voice-satellite");
      expect(p.source).toBe("device"); // category is additive; provenance untouched
    }
  });

  it("a sensor blob carries no deviceCategory (device state blobs only)", () => {
    ingestion.emitSensorEvent(
      { id: "pir-sala", sensorType: "presence", zone: "sala", value: true },
      "device",
    );
    for (const p of channelPayloads("sensor")) {
      expect(p.deviceCategory).toBeUndefined();
    }
  });

  it("an effect-driven actuation is source:automation with a causedBy link", () => {
    ingestion.emitDeviceState(
      { id: "light-sala", deviceCategory: "light", zone: "sala", value: true },
      "automation",
      { causedBy: { nodeId: "pir-sala", channel: "presence", correlationId: "corr-1" } },
    );

    const power = channelPayloads("power");
    expect(power.length).toBeGreaterThan(0);
    for (const p of power) {
      expect(p.source).toBe("automation");
      expect(p.causedBy).toEqual({ nodeId: "pir-sala", channel: "presence", correlationId: "corr-1" });
      expect(p.coveredByEffect).toBeUndefined();
    }
  });
});
