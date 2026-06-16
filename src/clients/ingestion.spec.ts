import {
  emitDeviceState,
  emitSensorEvent,
  emitDeviceDeclare,
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
});
