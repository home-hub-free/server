import { getDayTimeWord, IForecastData, updateWeatherData } from '../handlers/forecast.handler';
import { Greets, Reminders, SentenceConnectors, SentenceEnders } from './greets';
import fs from 'fs';
import { IEventData } from '../handlers/google-calendar.handler';
import JSONdb from 'simple-json-db';
import { sensors } from '../handlers/sensodr.handler';
import { devices } from '../handlers/device.handler';
const player = require('play-sound')({});
const AWS = require('aws-sdk');
const emmaSpeechPath = './src/sounds/speech/say.mp3';
const preSpeechSound =  './src/sounds/pre-notifier.mp3';
const Polly = new AWS.Polly({
  region: 'us-east-1'
});

export const VAssistantDB = new JSONdb('db/v-assistant.db.json');

interface ISpeechPromise {
  text: string,
  resolve: (value: unknown) => void,
  reject: (reason?: any) => void
}

class VAssistant {  

  public tempDifferenceAnnouncements = {
    outsideHotterThanInside: false,
    outsideCoolerThanInside: false,
  }

  public autoForecasted = {
    morning: false,
    afternoon: false,
    evening: false
  };

  public latestSpeeches = [];
  public lastAutoForecast: number = 0;

  private speechQueue: ISpeechPromise[] = [];
  private pollyOptions = {
    Engine: 'neural',
    LanguageCode: 'en-GB',
    OutputFormat: 'mp3',
    Text: '',
    VoiceId: 'Emma'
  };
  private allowedSpeakTimeRanges = [];

  /**
   * 
   * @param allowedSpeakTimeRange Time range where the v-assistant is not allowed to give speecj
   * anouncements
   * formatted as [HH:MM-HH:MM, ...]
   */
  constructor(allowedSpeakTimeRanges?: string[]) {
    this.allowedSpeakTimeRanges = allowedSpeakTimeRanges;
  }

  /**
   * Handles the creating of the speech and queue (if necessary) for emma's voice
   * @param text Text that will be read out-loud
   * @param force Force speech ignoring allowedSpeakTimeRanges validations
   */
  say(text: string, force?: boolean): Promise<boolean> {

    if (!this.isAllowedToSpeak() && !force) return Promise.resolve(false);

    this.latestSpeeches.push(new Date().toLocaleDateString() + ' ' + new Date().toLocaleTimeString() + ' ' + text);
    if (this.latestSpeeches.length > 10) {
      this.latestSpeeches.shift();
    }

    return new Promise((resolve, reject) => {
      this.speechQueue.push({
        text: text,
        resolve: resolve,
        reject: reject
      });

      if (this.speechQueue.length === 1) {
        this.playQueue(true);
      }
    });
  }

  sayWeatherForecast(autoTriggered?: boolean) {
    let dayTimeWord = getDayTimeWord();
    if (autoTriggered) {
      this.autoForecasted[dayTimeWord] = true;
    }
    return updateWeatherData().then((data) => {
      let sentence = this.buildForecastSentence(data.forecast);
      this.say(sentence);
      return sentence;
    });
  }

  sayCalendarEvent(calendarName: string, eventData: IEventData) {
    let sentence = this.buildCalendarEventSentence(calendarName, eventData);
    this.say(sentence);
  }

  toggleCoolingDevices(value: boolean) {
    let toggledDevices = 0;
    let coolingDevices = devices.filter((device) => device.deviceCategory === 'cooling-system');
    coolingDevices.forEach((device) => {
      let currentValue = device.value;
      device.autoTrigger(value);
      let newValue = device.value;
      if (currentValue !== newValue) toggledDevices++;
    });

    if (toggledDevices) {
      this.say('turned cooling devices ' + value ? 'on' : 'off');
    }
  }

  /**
   * Starts reading speeches in the queue
   * @param soundNotify Plays a notification-like sound before actually speaking
   */
  private playQueue(soundNotify?: boolean) {
    let promise = this.speechQueue[0];
    this.pollyOptions.Text = promise.text;
    Polly.synthesizeSpeech(this.pollyOptions, (err, data) => {
      if (err) return promise.reject(err);

      fs.writeFileSync(emmaSpeechPath, data.AudioStream);
      if (soundNotify) {
        player.play(preSpeechSound, () => {
          player.play(emmaSpeechPath, () => {
            this.speechQueue.shift();
            promise.resolve(true);
            if (this.speechQueue.length) this.playQueue();  
          });
        });
      } else {
        player.play(emmaSpeechPath, () => {
          this.speechQueue.shift();
          promise.resolve(true);
          if (this.speechQueue.length) this.playQueue();  
        });
      }
    });
  }

  private buildForecastSentence(data: IForecastData): string {
    let greetTime = getDayTimeWord();  
    let greet = Greets[greetTime][Math.floor(Math.random() * Greets[greetTime].length)];
    let connector = SentenceConnectors[Math.floor(Math.random() * SentenceConnectors.length)];
    let ender = SentenceEnders[Math.floor(Math.random() * SentenceEnders.length)];

    let emmaGreet = `${greet} ${greetTime === 'morning' ? connector + ',' : ''}`;
    let emmaCurrentWeather = `The current temperature is ${data.currentTemp}° ${data.isRising ? 'and rising' : data.isRising === null ? '' : 'and going down'}.`;
    const houseData = VAssistantDB.get('houseData');
    const insideSensorTemperatureId = houseData.insideSensorTemperature || null;
    let insideSensorTemperature = sensors.find((sensor) => sensor.id === insideSensorTemperatureId);
    let emmaInsideTemperature = '';

    if (insideSensorTemperature) {
      const temp = insideSensorTemperature.value.split(':')[0];
      emmaInsideTemperature = 'Inside temperature sensor reads ' + temp + '°.'
    }
    
    let showMax = data.maxTemp.hour > new Date().getHours();
    let emmaMaxTemperature = showMax ? `Today's maximum is ${data.maxTemp.value}°.` : '';



    let emmaWeatherDescription = `${data.description}.`;
    let emmaDone = ender;

    return `${emmaGreet} ${emmaCurrentWeather} ${emmaInsideTemperature} ${emmaMaxTemperature} ${emmaWeatherDescription} ${emmaDone}`;
  }

  private buildCalendarEventSentence(calendarName, eventData) {
    let now = new Date();

    let eventTime = eventData.startTime;
    let isReminder = now.getTime() < eventData.startTime;
    // We shouldn't get events from the past.
    let remainingTime = eventTime.getTime() - now.getTime();
    let start = isReminder ? Reminders[Math.floor(Math.random() * Reminders.length)] : '';
    let calendar = `from ${calendarName}'s calendar`;
    let type = eventData.type;
    
    let aMinute = 60 * 1000;
    let anHour = aMinute * 60;
    let time = '';
    if (remainingTime <= aMinute) {
      time = 'is about to start';
    } else if (remainingTime > aMinute && remainingTime <= anHour) {
      let minutes = Math.round(remainingTime / aMinute);
      time = `starts in ${minutes} minutes`;
    } else if (remainingTime > anHour) {
      let hours = Math.round(remainingTime / (60 * 1000 * 60));
      time = hours > 1 ? `starts in ${hours} hours` : 'starts in about an hour'
    }

    return `${start}, ${calendar}, ${type} "${eventData.name}", ${time}`;
  }

  private isAllowedToSpeak() {
    return true;
    if (this.allowedSpeakTimeRanges.length === 0) {
      return true;
    }

    let validCount = 0;
    let now = new Date();

    this.allowedSpeakTimeRanges.forEach((range) => {
      let ranges = range.split('-');
      let from: Date = this.parseTimeStringToDate(ranges[0]);
      let to: Date = this.parseTimeStringToDate(ranges[1]);

      const laterThanRangeStart = now.getTime() >= from.getTime();
      const earlierThanRangeEnd = now.getTime() <= to.getTime();
      if (laterThanRangeStart && earlierThanRangeEnd) {
        validCount++;
      }

      return validCount > 0
    });
  }

  private parseTimeStringToDate(time: string): Date {
    let date = new Date();
    let splitTime = time.split(':');
    let hours = parseInt(splitTime[0]);
    let minutes = 0;

    if (splitTime.length == 2) {
      minutes = parseInt(splitTime[1]);
    } 

    date.setHours(hours);
    date.setMinutes(minutes);

    return date;
  }
}

export const assistant = new VAssistant(['7:00-23:59']);

if (process.env.USER === 'pi') {
  setInterval(() => {
    // Play this sound and super low volume to keep the bluetooth speaker from turning off
    player.play('./src/sounds/pre-notifier.mp3', {
      // Command specific to raspberry audio player
      mpg123: ['-f', 500]
    });
  }, 60 * 1000);
}