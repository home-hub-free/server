const axios = require('axios');
const moment = require('moment');
const schedule = require('node-schedule');
const { log, EVENT_TYPES } = require('../logger');

let dailyEvents = {
  sunrise: {},
  sunset: {}
};
// Array of funcitons that will be triggeres at sunrise/sunset
const atSunrise = [];
const atSunset = [];

var rule = new schedule.RecurrenceRule();
rule.hour = 00;
rule.minute = 05;
rule.second = 00;
rule.dayOfWeek = new schedule.Range(0,6);
schedule.scheduleJob(rule, () => {
  dailyEvents = {};
  getTodayWeather();
});

function addDailyEvent(name, time, execution) {
  if (!dailyEvents[name]) dailyEvents[name] = {};
  dailyEvents[name].children = [];
  dailyEvents[name].time = time;
  dailyEvents[name].job = schedule.scheduleJob(time, execution);
  log(EVENT_TYPES.daily_event, [name, 'at: ' + moment(time, 'HH:mm:ss').format('hh:mm A')]);
}

function setSunriseEvent(description, fn) {
  if (fn && description) {
    atSunrise.push({
      fn: fn,
      description: description
    });
  };
}

function setSunsetEvent(description, fn) {
  if (fn && description) {
    atSunset.push({
      fn: fn,
      description, description
    });
  };
}

function getTodayWeather() {
  const coords = {
    lat: 20.6064818,
    lng: -100.4898658
  };
  let now = new Date();
  var today = moment(now).format('YYYY-MM-DD');

  return axios.get(`https://api.met.no/weatherapi/sunrise/2.0/.json?lat=${coords.lat}&lon=${coords.lng}&date=${today}&offset=-06:00`)
    .then((result) => {
      if (result && result.data && result.data.location && result.data.location.time && result.data.location.time.length > 0) {
        let dayData = result.data.location.time[0];
        let sunrise = new Date(dayData.sunrise.time);
        let sunset = new Date(dayData.sunset.time);

        addDailyEvent('sunrise', sunrise, () => {
          atSunrise.forEach((data) => {
            data.fn();
          });
        });
        atSunrise.forEach(data => dailyEvents['sunrise'].children.push(data.description));

        addDailyEvent('sunset', sunset, () => {
          atSunset.forEach((data) => {
            data.fn();
          });
        });
        atSunset.forEach(data => dailyEvents['sunset'].children.push(data.description));
      }
    })
    .catch(err => {
      log(EVENT_TYPES.error, [err]);
    });
}

function getDailyEvents() {
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

function addSecondsToTimestamp(timestamp, seconds) {
  timestamp = new Date(timestamp.getTime() + seconds * 1000);
}

exports.setSunriseEvent = setSunriseEvent;
exports.setSunsetEvent = setSunsetEvent;
exports.getDailyEvents = getDailyEvents;
exports.getTodayWeather = getTodayWeather;
exports.addDailyEvent = addDailyEvent;
exports.dailyEvents = dailyEvents;