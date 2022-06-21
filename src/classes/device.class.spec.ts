import { Device } from './device.class';
import { dailyEvents } from '../handlers/dailyEventsHandler';
jest.mock('../handlers/dailyEventsHandler', () => ({
    dailyEvents: {
        sunset: {time: new Date()},
        sunrise: {time: new Date()}
    }
}))
dailyEvents.sunrise.time.setHours(6);
dailyEvents.sunset.time.setHours(19);
  
// Look for a way to mock new Date since these test depend
// on the current time of the day
test('Device validating time ranges', () => {
    let device = new Device(1, 'test', 'boolean');
    device.operationalRanges = ['sunset-23:59', '0:0-1:0'];
    device.notifyDevice = (value): Promise<boolean> => {
        device.value = value;
        return Promise.resolve(true);
    };

    // Default value should be false
    expect(device.value).toBe(false);
    device.autoTrigger(true);
    // Should have been able to auto trigger
    expect(device.value).toBe(true);

    device.operationalRanges = ['sunset-23:59'];
    device.value = false;
    device.autoTrigger(true);
    expect(device.value).toBe(false);
});