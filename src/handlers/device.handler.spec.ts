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
  it("Should trigger evap cooler fan on when temperature is 1 degree higher than target", () => {
    device.value["room-temp"] = 26;
    device.value.target = 25;
    const updates = applyEvapCoolerEffects(device);
    expect(updates.fan).toBeTruthy();
  });

  it("Should keep evap cooler fan off when temperature is exactly at target", () => {
    device.value.fan = false;
    device.value["room-temp"] = 25;
    device.value.target = 25;
    const updates = applyEvapCoolerEffects(device);
    expect(updates.fan).toBeFalsy();
  });

  it("Should trigger evap cooler fan off when temperature is 1 degree below target", () => {
    device.value.fan = true;
    device.value.target = 25;
    device.value["room-temp"] = 24;
    const updates = applyEvapCoolerEffects(device);
    expect(updates.fan).toBeFalsy();
  });

  it("Should trigger evap cooler water on when temperature is 1 degree below target", () => {
    device.value.target = 25;
    device.value["room-temp"] = 24;
    const updates = applyEvapCoolerEffects(device);
    expect(updates.water).toBeTruthy();
  });

  it("Should trigger evap cooler water on when temperature is at target", () => {
    device.value.target = 25;
    device.value["room-temp"] = 25;
    const updates = applyEvapCoolerEffects(device);
    expect(updates.water).toBeTruthy();
  });

  it("Should keep evap cooler water off when temperature is 2 degrees below target", () => {
    device.value.target = 25;
    device.value["room-temp"] = 23;
    const updates = applyEvapCoolerEffects(device);
    expect(updates.water).toBeFalsy();
  });

  it("Should turn evap cooler water off when temperature is 2 degrees below target", () => {
    device.value.water = true;
    device.value.target = 25;
    device.value["room-temp"] = 23;
    const updates = applyEvapCoolerEffects(device);
    expect(updates.water).toBeFalsy();
  });

  it("Should turn evap cooler water on when temperature is 1 degrees below target", () => {
    device.value.water = false;
    device.value.target = 25;
    device.value["room-temp"] = 24;
    const updates = applyEvapCoolerEffects(device);
    expect(updates.water).toBeTruthy();
  });
});
