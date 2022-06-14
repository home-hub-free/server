
import axios from 'axios';
import moment from 'moment';
import schedule from 'node-schedule';
import { log, EVENT_TYPES } from '../logger';

export let dailyEvents: any = {
  sunrise: {},
  sunset: {}
};

// Array of funcitons that will be triggeres at sunrise/sunset
const atSunrise = [];
const atSunset = [];
const coords = {
  lat: process.env.LAT,
  lng: process.env.LNG,
};

var rule = new schedule.RecurrenceRule();
rule.hour = 0;
rule.minute = 5;
rule.second = 0;
rule.dayOfWeek = new schedule.Range(0,6);
schedule.scheduleJob(rule, () => {
  cleanup();
  getSunriseData();
});

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

export function getSunriseData() {
  let now = new Date();
  var today = moment(now).format('YYYY-MM-DD');
  return axios.get(`https://api.met.no/weatherapi/sunrise/2.0/.json?lat=${coords.lat}&lon=${coords.lng}&date=${today}&offset=-06:00`)
    .then((result) => {
      if (result && result.data && result.data.location && result.data.location.time && result.data.location.time.length > 0) {
        let dayData = result.data.location.time[0];
        let sunrise = new Date(dayData.sunrise.time);
        let sunset = new Date(dayData.sunset.time);

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
      }
    })
    .catch(err => {
      log(EVENT_TYPES.error, [err]);
    });
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

function addMinutesToTimestamp(timestamp: Date, minutes: number): Date {
  return addSecondsToTimestamp(timestamp, minutes * 60);
}

function addSecondsToTimestamp(timestamp: Date, seconds: number): Date {
  return new Date(timestamp.getTime() + (seconds * 1000));
}

function cleanup() {
  dailyEvents = {
    sunrise: {},
    sunset: {}
  };
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
