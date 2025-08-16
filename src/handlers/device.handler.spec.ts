import { Device } from "../classes/device.class";
import { applyEvapCoolerEffects } from "./device.handler";

describe("Validate device effects", () => {
  let device: Device;
  beforeEach(() => {
    device = new Device("id-123", "evap-cooler", "value", []);
    device.value = {
      fan: false,
      water: false,
      target: 25,
      ["room-temp"]: 25,
      ["unit-temp"]: 32,
    };

    device.notifyDevice = jest.fn();
  });

  describe("evap-cooler fan states", () => {
    it("set fan to true when temperature is 1 degree higher than target", () => {
      device.value.fan = false;
      device.value["room-temp"] = 26;
      device.value.target = 25;
      const updates = applyEvapCoolerEffects(device);
      expect(updates.fan).toBeTruthy();
    });

    it("keep fan as false when temperature is at target, and fan is turned off", () => {
      device.value.fan = false;
      device.value["room-temp"] = 25;
      device.value.target = 25;
      const updates = applyEvapCoolerEffects(device);
      expect(updates?.fan).toBeFalsy();
    });

    it("set fan to false, when temperature is 1.1 degree lower than target, and fan is currently on", () => {
      device.value.fan = true;
      device.value["room-temp"] = 23.9;
      device.value.target = 25;
      const updates = applyEvapCoolerEffects(device);
      expect(updates.fan).toBeFalsy();
    });

    it("keep fan as true, when temperature is at target, and fan is currently on", () => {
      device.value.fan = true;
      device.value["room-temp"] = 25;
      device.value.target = 25;
      const updates = applyEvapCoolerEffects(device);
      expect(updates.fan).toBeFalsy();
    });
  });

  describe("evap-cooler water pump states", () => {
    describe("water pump is currently off", () => {
      it("turn on when room temperature is at target", () => {
        device.value.water = false;
        device.value["room-temp"] = 25;
        device.value.target = 25;
        const updates = applyEvapCoolerEffects(device);
        expect(updates.water).toBeTruthy();
      });

      it("turn on when room temperature is above target", () => {
        device.value.water = false;
        device.value["room-temp"] = 26;
        device.value.target = 25;
        const updates = applyEvapCoolerEffects(device);
        expect(updates.water).toBeTruthy();
      });

      it("stays off when room temperature is lower than target", () => {
        device.value.water = false;
        device.value["room-temp"] = 24;
        device.value.target = 25;
        const updates = applyEvapCoolerEffects(device);
        expect(updates?.water).toBeFalsy();
      });
    });

    describe("water pump is currently on", () => {
      it("turn off when temperature is 1 degrees lower than target", () => {
        device.value.water = true;
        device.value["room-temp"] = 24;
        device.value.target = 25;
        const updates = applyEvapCoolerEffects(device);
        expect(updates?.water).toBeFalsy();
      });

      it("stay on when temperature is at target", () => {
        device.value.water = true;
        device.value["room-temp"] = 25;
        device.value.target = 25;
        const updates = applyEvapCoolerEffects(device);
        expect(updates).toBeNull(); // No updates
      });

      it("turn off when unit temp is lower or equal than target", () => {
        device.value.water = true;
        device.value["room-temp"] = 28;
        device.value["unit-temp"] = 25;
        device.value.target = 25;
        const updates = applyEvapCoolerEffects(device);
        expect(updates.water).toBeFalsy();
      });
    });
  });
});
