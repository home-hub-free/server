
import axios from 'axios';
import moment from 'moment';
import schedule from 'node-schedule';
import fs from 'fs';
import { log, EVENT_TYPES } from '../logger';
import { WeatherDescriptions } from '../weather-descriptions';
import { Greets, SentenceConnectors, SentenceEnders } from '../greets';
const WeatherApiURL = 'https://api.weatherapi.com/v1/';
const WeatherApiKey = process.env.WEATHER_API_KEY || '';
const ipAddress = process.env.IP_ADDRESS || '';
const player = require('play-sound')({});
const AWS = require('aws-sdk');

export interface IForecastData {
  max: number,
  min: number,
  current: number,
  avg: number,
  humidity_avg: number,
  description: string
}

export let dailyEvents: any = {
  sunrise: {},
  sunset: {}
};

export let hasBeenGreeted = false;
// Array of funcitons that will be triggeres at sunrise/sunset
const atSunrise = [];
const atSunset = [];
const coords = {
  lat: process.env.LAT,
  lng: process.env.LNG,
};
const Polly = new AWS.Polly({
  region: 'us-east-1'
});

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

export function getTodayForecastSentence(): Promise<string> {
  let url = `${WeatherApiURL}forecast.json?key=${WeatherApiKey}&q=${ipAddress}&days=1&aqi=no&alerts=no`;
  return new Promise((resolve, reject) => {
    axios.get(url)
      .then((result) => {
        let forecastData = result.data.forecast.forecastday[0];
        let maxTemp = forecastData.day.maxtemp_c;
        let minTemp = forecastData.day.mintemp_c;
        let average = forecastData.day.avgtemp_c;
        let humidity = forecastData.day.avghumidity;
        let descriptionCode = forecastData.day.condition.code;
        let generalDescription = WeatherDescriptions.find((item) => item.code === descriptionCode).sentence;
  
        let sentence = buildForecastResume({
          current: result.data.current.temp_c,
          max: maxTemp,
          min: minTemp,
          avg: average,
          humidity_avg: humidity,
          description: generalDescription
        });
        resolve(sentence);
      })
      .catch((err) => {
        if (err) {
          reject(err);
          // console.log(err);
        }
      });
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
  hasBeenGreeted = false;
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

function buildForecastResume(data: IForecastData): string {
  let greet = Greets.morning[Math.floor(Math.random() * Greets.morning.length)];
  let connector = SentenceConnectors[Math.floor(Math.random() * SentenceConnectors.length)];
  let ender = SentenceEnders[Math.floor(Math.random() * SentenceEnders.length)];

  let forecastSentence = 
    `${greet} ${connector}. For today's weather, the current temperature is ${Math.round(data.avg)}°, today's theoretical maximum is ${Math.round(data.max)}° celsius. ${data.description}. ${ender}`;

  return forecastSentence;
}

export function speakDayResume() {
  hasBeenGreeted = true;
  getTodayForecastSentence().then((sentence) => {
    const pollyOptions = {
      Engine: 'neural',
      LanguageCode: 'en-GB',
      OutputFormat: 'mp3',
      Text: sentence,
      VoiceId: 'Emma'
    };
    Polly.synthesizeSpeech(pollyOptions, (err, data)=> {
      if (err) {
        console.log(err);
        return;
      }
      if (data && data.AudioStream instanceof Buffer) {
        fs.writeFileSync('./src/sounds/speech/forecast.mp3', data.AudioStream);
        voiceNotify('./src/sounds/speech/forecast.mp3');
      }
    });
  });
}

function voiceNotify(speechFile) {
  player.play('./src/sounds/pre-notifier.mp3', (err) => {
    if (err) console.log(err);
    player.play(speechFile)
  })
}