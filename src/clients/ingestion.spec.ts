import {
  emitDeviceState,
  emitSensorEvent,
  emitDeviceDeclare,
  initIngestion,
  closeIngestion,
} from "./ingestion";

// Transport is deferred: with INGESTION_ENABLED unset, every emit must be a safe
// no-op that never throws — the control plane must not depend on the brain.
describe("ingestion seam (deferred transport)", () => {
  it("emitDeviceState is a no-op and never throws when disabled", () => {
    expect(() =>
      emitDeviceState({ id: "d1", value: true, zone: "sala", unit: "" }, "dashboard"),
    ).not.toThrow();
  });

  it("emitSensorEvent is a no-op and never throws when disabled", () => {
    expect(() =>
      emitSensorEvent({ id: "s1", value: "23:50", zone: "cocina" }, "device"),
    ).not.toThrow();
  });

  it("emitDeviceDeclare is a no-op and never throws when disabled", () => {
    expect(() =>
      emitDeviceDeclare({ id: "d2", value: 0, deviceCategory: "blinds" }),
    ).not.toThrow();
  });

  it("tolerates missing optional fields", () => {
    expect(() => emitDeviceState({ id: "d3", value: null }, "system")).not.toThrow();
  });

  it("fanning a device out into per-channel events is a safe no-op when disabled", () => {
    // Stage 1 projects each emit into per-channel events; with the transport off
    // they must remain no-ops that never throw. Use a non-suppressed category so the
    // channel path actually runs (evap-cooler is short-circuited by suppression).
    expect(() =>
      emitDeviceState({ id: "dim1", deviceCategory: "dimmable-light", zone: "sala", value: 42 }, "device"),
    ).not.toThrow();
  });

  it("splitting a temp/humidity sensor into channels is a safe no-op when disabled", () => {
    expect(() =>
      emitSensorEvent({ id: "th1", sensorType: "temp/humidity", value: "23.5:10.5", zone: "cocina" }, "device"),
    ).not.toThrow();
  });

  it("initIngestion/closeIngestion are no-ops when disabled (no socket opened)", () => {
    // With INGESTION_ENABLED unset, no MQTT client must be created — otherwise the
    // open socket would keep Jest's event loop alive and hang the run.
    expect(() => initIngestion()).not.toThrow();
    expect(() => closeIngestion()).not.toThrow();
  });
});
