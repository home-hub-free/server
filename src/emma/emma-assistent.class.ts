import { getDayTimeWord, IForecastData, updateWeatherData } from '../handlers/forecastHandler';
import { Greets, Reminders, SentenceConnectors, SentenceEnders } from './greets';
import fs from 'fs';
import { IEventData } from '../handlers/googleCalendarHandler';
const player = require('play-sound')({});
const AWS = require('aws-sdk');
const emmaSpeechPath = './src/sounds/speech/say.mp3';
const preSpeechSound =  './src/sounds/pre-notifier.mp3';
const Polly = new AWS.Polly({
  region: 'us-east-1'
});

interface ISpeechPromise {
  text: string,
  resolve: (value: unknown) => void,
  reject: (reason?: any) => void
}

class Emma {  

  public autoForecasted = {
    morning: false,
    afternoon: false,
    evening: false
  };

  public latestSpeeches = [];

  private speechQueue: ISpeechPromise[] = [];
  private pollyOptions = {
    Engine: 'neural',
    LanguageCode: 'en-GB',
    OutputFormat: 'mp3',
    Text: '',
    VoiceId: 'Emma'
  };

  constructor() { }

  /**
   * Handles the creating of the speech and queue (if necessary) for emma's voice
   * @param text Text that will be read out-loud
   */
  say(text: string): Promise<boolean> {

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

  /**
   * Starts reading speeches in the queue
   * @param soundNotify Plays a notification-like sound before actually speaking
   */
  playQueue(soundNotify?: boolean) {
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

  private buildForecastSentence(data: IForecastData): string {
    let greetTime = getDayTimeWord();  
    let greet = Greets[greetTime][Math.floor(Math.random() * Greets[greetTime].length)];
    let connector = SentenceConnectors[Math.floor(Math.random() * SentenceConnectors.length)];
    let ender = SentenceEnders[Math.floor(Math.random() * SentenceEnders.length)];

    let emmaGreet = `${greet} ${greetTime === 'morning' ? connector + ',' : ''}`;
    let emmaCurrentWeather = `For today's weather, the current temperature is ${data.currentTemp}° celcious ${data.isRising ? 'and rising' : data.isRising === null ? '' : 'and going down'}.`;
    
    let showMax = data.maxTemp.hour > new Date().getHours();
    let emmaMaxTemperature = showMax ? `Today's theoretical maximum is ${data.maxTemp.value}° celcious.` : '';

    let emmaWeatherDescription = `${data.description}.`;
    let emmaDone = ender;

    return `${emmaGreet} ${emmaCurrentWeather} ${emmaMaxTemperature} ${emmaWeatherDescription} ${emmaDone}`;
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
}

export const emma = new Emma();

if (process.env.USER === 'pi') {
  setInterval(() => {
    // Play this sound and super low volume to keep the bluetooth speaker from turning off
    player.play('./src/sounds/pre-notifier.mp3', {
      // Command specific to raspberry audio player
      mpg123: ['-f', 500]
    });
  }, 60 * 1000);
}