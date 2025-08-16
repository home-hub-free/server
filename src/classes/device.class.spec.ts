import { Device } from "./device.class";
import { dailyEvents } from "../handlers/daily-events.handler";
jest.mock("../handlers/daily-events.handler", () => ({
  dailyEvents: {
    sunset: { time: new Date() },
    sunrise: { time: new Date() },
  },
}));
dailyEvents.sunrise.time.setHours(6);
dailyEvents.sunset.time.setHours(19);

describe("Device validating time ranges", () => {
  afterEach(() => {
    jest.useRealTimers();
  });

  it("tests", () => {
    jest.useFakeTimers();

    // Before sunset
    let fakeDate = new Date();
    fakeDate.setHours(12);
    jest.setSystemTime(fakeDate);

    let device = new Device("1", "test", "boolean");
    device.operationalRanges = ["sunset-23:59", "0:0-1:0"];

    device.notifyDevice = (value): Promise<boolean> => {
      device.value = value;
      return Promise.resolve(true);
    };

    device.autoTrigger(true);
    // Should have not been able to auto trigger since its outside operational
    // time range
    expect(device.value).toBe(false);

    fakeDate.setHours(19);
    jest.setSystemTime(fakeDate);

    // Should have been able to auto trigger since its inside operational time rangess
    device.autoTrigger(true);
    expect(device.value).toBe(true);
  });
});
