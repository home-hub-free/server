/**
 * HUB_SIM backstop (docs/plans/DATA_INTEGRITY_FOUNDATION.md Phase 1, closes D1). A sim
 * hub must never reach the shared MQTT broker even when INGESTION_ENABLED leaks in true
 * from the real server/.env (dotenv loads from cwd; a sim hub launched via `cd server &&
 * HUB_SIM=1 ... exec node dist/index.js` sits in the real server/ dir). This is the
 * regression guard for exactly that scenario — HUB_SIM alone must force the seam off,
 * independent of INGESTION_ENABLED. See ingestion.ts's ENABLED computation.
 */

interface Published {
  topic: string;
  payload: any;
}

// Same broker mock as ingestion.envelope.spec.ts — connect() returns a fake client that
// "connects" synchronously and records every publish so a leak would be observable here.
const published: Published[] = [];
let connectCalls = 0;
jest.mock("mqtt", () => ({
  __esModule: true,
  default: {
    connect: () => {
      connectCalls++;
      const handlers: Record<string, Function> = {};
      const client = {
        on: (event: string, cb: Function) => {
          handlers[event] = cb;
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

describe("ingestion seam — HUB_SIM backstop", () => {
  afterEach(() => {
    delete process.env.INGESTION_ENABLED;
    delete process.env.HUB_SIM;
  });

  it("INGESTION_ENABLED=true + HUB_SIM=1 never connects to or publishes on the broker", () => {
    published.length = 0;
    connectCalls = 0;
    jest.resetModules();
    process.env.INGESTION_ENABLED = "true";
    process.env.HUB_SIM = "1";
    let ingestion: typeof import("./ingestion");
    jest.isolateModules(() => {
      ingestion = require("./ingestion");
    });
    ingestion!.initIngestion();
    ingestion!.emitDeviceState(
      { id: "bench-light-taller", deviceCategory: "light", zone: "taller", value: true },
      "device",
    );
    ingestion!.emitSensorEvent(
      { id: "bench-presence-terraza", sensorType: "presence", zone: "terraza", value: true },
      "device",
    );

    expect(connectCalls).toBe(0); // no MQTT client ever created
    expect(published).toHaveLength(0); // nothing reached the "broker"
    ingestion!.closeIngestion(); // no-op (no client to close), must not throw
  });

  it("control case: INGESTION_ENABLED=true without HUB_SIM DOES publish (the mock/harness works)", () => {
    published.length = 0;
    connectCalls = 0;
    jest.resetModules();
    process.env.INGESTION_ENABLED = "true";
    delete process.env.HUB_SIM;
    let ingestion: typeof import("./ingestion");
    jest.isolateModules(() => {
      ingestion = require("./ingestion");
    });
    ingestion!.initIngestion();
    ingestion!.emitDeviceState(
      { id: "light-sala", deviceCategory: "light", zone: "sala", value: true },
      "device",
    );

    expect(connectCalls).toBeGreaterThan(0);
    expect(published.length).toBeGreaterThan(0);
    ingestion!.closeIngestion();
  });
});
