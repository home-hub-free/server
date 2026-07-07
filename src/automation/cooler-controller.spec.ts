import { computeCoolerUpdates } from "./cooler-controller";

// Golden tests for the cooler hysteresis (Stage 4c), ported from the legacy
// applyEvapCoolerEffects. One deliberate divergence: the unit probe measures the
// OUTLET air (it used to sit outside), so the water HOLD no longer requires
// unit ≥ target — a cold outlet means the pump is working, not that it should stop.
describe("computeCoolerUpdates (evap-cooler hysteresis)", () => {
  const base = { target: 25, roomTemp: 25, unitTemp: 25, fan: false, water: false };

  describe("fan", () => {
    it("turns on once the room reaches target + 1 (from off)", () => {
      expect(computeCoolerUpdates({ ...base, fan: false, roomTemp: 26 }).fan).toBe(true);
    });

    it("stays off below target + 1", () => {
      expect(computeCoolerUpdates({ ...base, fan: false, roomTemp: 25.9 }).fan).toBeUndefined();
    });

    it("stays on until the room drops to target - 1", () => {
      // running, room at target → still warm enough, no change emitted
      expect(computeCoolerUpdates({ ...base, fan: true, roomTemp: 25 }).fan).toBeUndefined();
    });

    it("turns off once the room drops below target - 1", () => {
      expect(computeCoolerUpdates({ ...base, fan: true, roomTemp: 23.9 }).fan).toBe(false);
    });
  });

  describe("water pump", () => {
    it("starts only when both room ≥ target and unit ≥ target", () => {
      expect(computeCoolerUpdates({ ...base, water: false, roomTemp: 25, unitTemp: 25 }).water).toBe(true);
    });

    it("does not start when the air through the unit is already cool (dry pads: outlet ≈ intake)", () => {
      expect(computeCoolerUpdates({ ...base, water: false, roomTemp: 26, unitTemp: 24 }).water).toBeUndefined();
    });

    it("keeps running while the room is warm even though the outlet air is now cold (pump working ≠ stop signal)", () => {
      expect(computeCoolerUpdates({ ...base, water: true, roomTemp: 26, unitTemp: 18 }).water).toBeUndefined();
    });

    it("stops when the room falls below target - 1", () => {
      expect(computeCoolerUpdates({ ...base, water: true, roomTemp: 23.9, unitTemp: 30 }).water).toBe(false);
    });
  });

  it("returns an empty object when nothing should change", () => {
    expect(computeCoolerUpdates({ ...base, fan: false, water: false, roomTemp: 25 })).toEqual({ water: true });
    // a fully-settled cool room: fan off & holding, water off & holding
    expect(computeCoolerUpdates({ target: 25, roomTemp: 22, unitTemp: 20, fan: false, water: false })).toEqual({});
  });
});
