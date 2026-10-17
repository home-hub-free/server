
import moment from 'moment';
import schedule from 'node-schedule';
import { log, EVENT_TYPES } from '../logger';
import { forecast, updateWeatherData } from './forecast.handler';
import { readCalendars, ICalendarData, IEventData } from './google-calendar.handler';
import { assistant, VAssistantDB } from '../v-assistant/v-assistant.class';
import { nodes } from './node.handler';

export let dailyEvents: any = {
  sunrise: {},
  sunset: {}
};

// Array of funcitons that will be triggeres at sunrise/sunset
const atSunrise = [];
const atSunset = [];

// Every Minute interval
setInterval(() => {
  if (process.env.LOCAL === 'true') return;
  
  let now = new Date();
  // Drop any node we haven't heard from in 30s (devices + sensors share one registry now).
  for (let i = nodes.length - 1; i >= 0; i--) {
    const offlineTime = now.getTime() - nodes[i].lastPing.getTime();
    if (offlineTime > 30 * 1000) nodes.splice(i, 1);
  }
}, 60 * 1000);

// Every 30 minutes interval. Exported so the tick is testable.
//
// The fetch MUST be absorbed here: Open-Meteo answering 503 (its 2026-09-20..29 outage) made
// `updateWeatherData()` reject on this timer with nothing catching it, and Node turns an
// unhandled rejection into a process exit — the hub died every 30 min for ten days (398
// systemd restarts). Weather is a convenience, never a control-plane dependency: on failure
// we log, keep the last-good `forecast`, and let the next tick retry.
export function weatherTick(): Promise<void> {
  return updateWeatherData().then(() => {
    const houseData = VAssistantDB.get('houseData');
    const insideTempSensor = houseData && houseData.insideSensorTemperature;
    if (insideTempSensor) {
      const sensor = nodes.find((node) => node.id === houseData.insideSensorTemperature);
      const temperature = sensor && sensor.value && sensor.value.split(':')[0];
      const currentHour = new Date().getHours();
      const outsideHotter = parseFloat(temperature) < forecast.hourlyTemperatures[currentHour];
      const outsideCooler = parseFloat(temperature) > forecast.hourlyTemperatures[currentHour];
      if (outsideHotter && !assistant.tempDifferenceAnnouncements.outsideHotterThanInside) {
        assistant.say('outside temperature is higher than inside temperature').then((spoke) => {
          assistant.tempDifferenceAnnouncements.outsideHotterThanInside = spoke;
          if (houseData.controlsCooling) {
            assistant.toggleCoolingDevices(true);
          }
        });
      } else if (outsideCooler && !assistant.tempDifferenceAnnouncements.outsideCoolerThanInside) {
        assistant.say('ouside temperature is cooler than inside').then((spoke) => {
          assistant.tempDifferenceAnnouncements.outsideCoolerThanInside = spoke;
          if (houseData.controlsCooling) {
            assistant.toggleCoolingDevices(false);
          }
        });
      }
    }
  }).catch((err) => {
    log(EVENT_TYPES.error, [`Weather refresh failed (keeping last-good forecast): ${describeError(err)}`]);
  });
}
setInterval(() => { void weatherTick(); }, 60 * 1000 * 30);

/** One-line, text-only error description (the logger prints strings, not objects). */
function describeError(err: unknown): string {
  if (err && typeof err === 'object') {
    const e = err as { message?: unknown; code?: unknown; response?: { status?: unknown } };
    const status = e.response && e.response.status !== undefined ? ` (HTTP ${e.response.status})` : '';
    const code = e.code !== undefined ? ` [${String(e.code)}]` : '';
    return `${e.message !== undefined ? String(e.message) : String(err)}${status}${code}`;
  }
  return String(err);
}

export function initDailyEvents() {
  var rule = new schedule.RecurrenceRule();
  rule.hour = 0;
  rule.minute = 5;
  rule.second = 0;
  rule.dayOfWeek = new schedule.Range(0,6);

  refreshAstroAndCalendar();

  // This runs daily at 12:05am, updates weather data and retrieves calendar data (if any)
  schedule.scheduleJob(rule, () => {
    cleanup();
    refreshAstroAndCalendar();
  });
}

// Same discipline as `weatherTick`: the calendar read can reject (credentials, network) and
// this chain runs unsupervised at boot and at 00:05 — never let it become an unhandled rejection.
function refreshAstroAndCalendar(): Promise<void> {
  return updateAstroEvents()
    .then(() => updateDailyGoogleCalendarEvents())
    .then(() => undefined)
    .catch((err) => {
      log(EVENT_TYPES.error, [`Daily calendar refresh failed: ${describeError(err)}`]);
    });
}

export function addDailyEvent(name, time, execution) {
  if (!dailyEvents[name]) {
    dailyEvents[name] = {}
  };
  dailyEvents[name].children = [];
  dailyEvents[name].time = time;
  dailyEvents[name].job = schedule.scheduleJob(time, () => execution());
}

export function setSunriseEvent(desc, fn) {
  if (fn && desc) {
    atSunrise.push({
      fn: fn,
      description: desc
    });
  };
}

export function setSunsetEvent(desc, fn) {
  if (fn && desc) {
    atSunset.push({
      fn: fn,
      description: desc
    });
  };
}

function updateDailyGoogleCalendarEvents() {
  return readCalendars().then((calendarsData: ICalendarData[]) => {
    calendarsData.forEach((data: ICalendarData) => {
      scheduleCalendarData(data);
    });
  });
}

function scheduleCalendarData(calendarData: ICalendarData) {
  calendarData.events.forEach((event: IEventData) => {
    let reminderTime = addMinutesToTimestamp(event.startTime, -15);

    addDailyEvent(calendarData.calendarName + ' event ' + event.name, reminderTime, () => {
      assistant.sayCalendarEvent(calendarData.calendarName, event);
    });
  });
}

function updateAstroEvents() {
  return updateWeatherData()
    .then((result) => {
      let sunrise = result.astro.sunrise;
      let sunset = result.astro.sunset;

      addDailyEvent('sunrise', sunrise, () => {
        atSunrise.forEach(data => data.fn());
        log(EVENT_TYPES.daily_event, ['Executing scheduled sunrise']);
      });
      atSunrise.forEach(data => dailyEvents['sunrise'].children.push(data.description));

      addDailyEvent('sunset', sunset, () => {
        atSunset.forEach(data => data.fn());
        log(EVENT_TYPES.daily_event, ['Executing scheduled sunset']);
      });
      atSunset.forEach(data => dailyEvents['sunset'].children.push(data.description));
    })
    .catch((err) => {
      log(EVENT_TYPES.error, [err]);
    })
}

export function getDailyEvents() {
  return Object.keys(dailyEvents).map((key) => {
    let event = dailyEvents[key];
    let eventData = {
      time: moment(event.time, 'HH:mm:ss').format('hh:mm A'),
      name: key,
      description: event.description,
      children: event.children
    };
    return eventData
  });
}

export function addHoursToTimestamp(timestamp: Date, hours: number): Date {
  return addMinutesToTimestamp(timestamp, hours * 60);
}

export function addMinutesToTimestamp(timestamp: Date, minutes: number): Date {
  return addSecondsToTimestamp(timestamp, minutes * 60);
}

export function addSecondsToTimestamp(timestamp: Date, seconds: number): Date {
  return new Date(timestamp.getTime() + (seconds * 1000));
}

function cleanup() {
  dailyEvents = {
    sunrise: {},
    sunset: {}
  };

  assistant.autoForecasted.morning = false;
  assistant.autoForecasted.afternoon = false;
  assistant.autoForecasted.evening = false;

  // Natural reset of manual overrides (docs/EFFECTS_DYNAMIC.md §8/Stage 3): a user's
  // manual control "wins" for the rest of the day, then automations resume the next day.
  // Without this the lock — which dynamic effects now respect — would be permanent.
  let released = 0;
  nodes.forEach((node) => {
    if (node.releaseManual()) released++;
  });
  if (released > 0) {
    log(EVENT_TYPES.daily_event, [`Released ${released} manual lock(s) — automations resume`]);
  }
}

export function getSunsetTimeStamp() {
  return dailyEvents['sunset'].time;
}

export function isPastSunset() {
  let now = new Date().getTime();
  let sunset = dailyEvents['sunset'].time;
  if (sunset) {
    return now >= sunset;
  }
  return null;
}
