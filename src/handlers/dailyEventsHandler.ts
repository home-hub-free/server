
import moment from 'moment';
import schedule from 'node-schedule';
import { log, EVENT_TYPES } from '../logger';
import { updateWeatherData } from './forecastHandler';
import { readCalendars, ICalendarData, IEventData } from './googleCalendarHandler';
import { emma } from '../emma/emma-assistent.class';

export let dailyEvents: any = {
  sunrise: {},
  sunset: {}
};

// Array of funcitons that will be triggeres at sunrise/sunset
const atSunrise = [];
const atSunset = [];

var rule = new schedule.RecurrenceRule();
rule.hour = 0;
rule.minute = 5;
rule.second = 0;
rule.dayOfWeek = new schedule.Range(0,6);
schedule.scheduleJob(rule, () => {
  cleanup();
  initDailyEvents();
});

export function initDailyEvents() {
  updateAstroEvents();
  updateDailyGoogleCalendarEvents();
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
  readCalendars().then((calendarsData: ICalendarData[]) => {
    calendarsData.forEach((data: ICalendarData) => {
      scheduleCalendarData(data);
    });
  });
}

function scheduleCalendarData(calendarData: ICalendarData) {
  calendarData.events.forEach((event: IEventData) => {
    let reminderTime = addMinutesToTimestamp(event.startTime, -15);

    addDailyEvent(calendarData.calendarName + ' event ' + event.name, reminderTime, () => {
      emma.sayCalendarEvent(calendarData.calendarName, event);
    });
  });
}

function updateAstroEvents() {
  updateWeatherData()
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

  emma.autoForecasted.morning = false;
  emma.autoForecasted.afternoon = false;
  emma.autoForecasted.evening = false;
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
