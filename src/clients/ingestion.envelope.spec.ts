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
