const moment = require('moment');
const schedule = require('node-schedule');
const axios = require('axios');
const { triggerDevice, devices } = require('./deviceHandler');
const { log, EVENT_TYPES } = require('../logger');

var rule = new schedule.RecurrenceRule();
rule.hour = 00;
rule.minute = 05;
rule.second = 00;
rule.dayOfWeek = new schedule.Range(0,6);

const dailyEvents = {};
let sunrise = null;
let sunset = null;

const dailyJob = schedule.scheduleJob(rule, () => {
  setDailyEvents();
});

function setDailyEvents() {
  const coords = {
    lat: 20.6064818,
    lng: -100.4898658
  };
  let now = new Date();
  var today = moment(now).format('YYYY-MM-DD');

  axios.get(`https://api.met.no/weatherapi/sunrise/2.0/.json?lat=${coords.lat}&lon=${coords.lng}&date=${today}&offset=-06:00`)
    .then((result) => {
      if (result && result.data && result.data.location && result.data.location.time && result.data.location.time.length > 0) {
        let dayData = result.data.location.time[0];
        sunrise = new Date(dayData.sunrise.time);
        sunset = new Date(dayData.sunset.time);  

        setEvent('open-blinds', 'Opens living room blinds', sunrise, () => triggerDevice(devices[2], '100'));
        setEvent('close-blinds', 'Closes livingroom blinds', sunset, () => triggerDevice(devices[1], '0'));
      }
    });
}

function setEvent(name, description, time, execution) {
  dailyEvents[name] = {};
  dailyEvents[name].time = time;
  dailyEvents[name].description = description;
  dailyEvents[name].job = schedule.scheduleJob(time, execution);

  log(EVENT_TYPES.daily_event, [name, description, 'at: ' + moment(time, 'HH:mm:ss').format('hh:mm A')]);
}

function getDailyEvents() {
  return Object.keys(dailyEvents).map((key) => {
    let event = dailyEvents[key];
    return {
      time: moment(event.time, 'HH:mm:ss').format('hh:mm A'),
      name: key,
      description: event.description
    }
  });
}

function isPastSunSet() {
  return sunset < new Date();
}

exports.setDailyEvents = setDailyEvents;
exports.getDailyEvents = getDailyEvents;
exports.isPastSunSet = isPastSunSet;
exports.dailyEvents = dailyEvents;
// exports.sunrise = sunrise;
// exports.sunset = sunset;