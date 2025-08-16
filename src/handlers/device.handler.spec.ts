import { Device } from "../classes/device.class";
import { applyEvapCoolerEffects } from "./device.handler";

jest.mock("../handlers/daily-events.handler", () => ({
  dailyEvents: {
    sunset: { time: new Date() },
    sunrise: { time: new Date() },
  },
}));
// dailyEvents.sunrise.time.setHours(6);
// dailyEvents.sunset.time.setHours(19);

describe("Validate device effects", () => {
  let device: Device;
  beforeEach(() => {
    device = new Device(
      "id-123",
      "evap-cooler",
      "value",
      [],
      "123.123.123.123",
    );
    device.value = {
      fan: false,
      water: false,
      target: 25,
      ["room-temp"]: 25,
      ["unit-temp"]: 32,
    };
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
      expect(updates.fan).toBeFalsy();
    });

    it("set fan to false, when temperature is 1 degree lower than target, and fan is currently on", () => {
      device.value.fan = true;
      device.value["room-temp"] = 24;
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
});
