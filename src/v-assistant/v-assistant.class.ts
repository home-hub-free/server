import { getDayTimeWord, IForecastData, updateWeatherData } from '../handlers/forecast.handler';
import { Greets, Reminders, SentenceConnectors, SentenceEnders } from './greets';
import fs from 'fs';
import { IEventData } from '../handlers/google-calendar.handler';
import { ConfigRepo } from '../db/config.repo';
import { nodes } from '../handlers/node.handler';
import { exec } from 'child_process';
import { synthesizeToFile } from '../clients/tts';
const player = require('play-sound')({});
const speechPath = './src/sounds/speech/say.wav';
const preSpeechSound =  './src/sounds/pre-notifier.mp3';

if (!fs.existsSync('./src/sounds/speech/')) {
  fs.mkdirSync('./src/sounds/speech/');
}

export const VAssistantDB = new ConfigRepo();

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
  public screenSensors = [];

  private speechQueue: ISpeechPromise[] = [];
  private allowedSpeakTimeRanges = [];
  private screenTimeout = null;
  private screenTimeOn = 1000 * 60 * 5;
  /**
   * 
   * @param allowedSpeakTimeRange Time range where the v-assistant is not allowed to give speecj
   * anouncements
   * formatted as [HH:MM-HH:MM, ...]
   */
  constructor(allowedSpeakTimeRanges?: string[]) {
    this.allowedSpeakTimeRanges = allowedSpeakTimeRanges;
    const screenData = VAssistantDB.get("screenData");
    if (screenData && screenData.motionSensors) {
      this.screenSensors = screenData.motionSensors;
    } else {
      exec('vcgencmd display_power 1');
    }
  }

  /**
   * Handles the creating of the speech and queue (if necessary) for v-assistant's voice
   * @param text Text that will be read out-loud
   * @param force Force speech ignoring allowedSpeakTimeRanges validations
   * @param zone Optional target zone (PERCEPTION_TO_AGENT_PLAN §3.5). When a zone is given AND a
   *   satellite audio transport is configured (SATELLITE_AUDIO_URL — the node-red `satellite_audio`
   *   handoff), the line is spoken in THAT room instead of on the box. Until the satellite HW lands, a
   *   zoned line with no transport configured falls back to the box speaker (the zone is honored as far
   *   as software can today). This is the one zone-aware announce sink BOTH the agent's say/ask_user and
   *   the timer scheduler route through.
   */
  say(text: string, force?: boolean, zone?: string | null): Promise<boolean> {

    if (!this.isAllowedToSpeak() && !force) return Promise.resolve(false);

    this.latestSpeeches.push(new Date().toLocaleDateString() + ' ' + new Date().toLocaleTimeString() + (zone ? ` [${zone}]` : '') + ' ' + text);
    if (this.latestSpeeches.length > 10) {
      this.latestSpeeches.shift();
    }

    if (zone && process.env.SATELLITE_AUDIO_URL) {
      return this.routeZonedAnnounce(text, zone);
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
   * Speak a line in a specific room via the satellite audio transport (the node-red `satellite_audio`
   * handoff at SATELLITE_AUDIO_URL). Best-effort + fire-and-forget like the rest of the announce path —
   * a failed handoff resolves false rather than throwing. The physical per-zone speaker is out of scope
   * here (the satellite HW); this plumbs the zone to that transport.
   */
  private routeZonedAnnounce(text: string, zone: string): Promise<boolean> {
    // Node 18+ global fetch (server tsconfig lib doesn't declare it — reach it off globalThis).
    const f = (globalThis as any).fetch as undefined | ((url: string, init: any) => Promise<{ ok: boolean }>);
    if (!f) return Promise.resolve(false);
    return f(process.env.SATELLITE_AUDIO_URL as string, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text, zone }),
    })
      .then((r) => r.ok)
      .catch(() => false);
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
    let coolingDevices = nodes.filter((node) => node.category === 'evap-cooler');
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

  handleScreenTimer() {
    if (this.screenTimeout) {
      clearTimeout(this.screenTimeout);
    }
    exec('vcgencmd display_power 1');
    this.screenTimeout = setTimeout(() => {
      this.screenTimeout = null;
      exec('vcgencmd display_power 0');
    }, this.screenTimeOn);
  }

  /**
   * Starts reading speeches in the queue
   * @param soundNotify Plays a notification-like sound before actually speaking
   */
  private playQueue(soundNotify?: boolean) {
    let promise = this.speechQueue[0];
    synthesizeToFile({ text: promise.text, outPath: speechPath })
      .then(() => {
        const playSpeech = () => {
          player.play(speechPath, () => {
            this.speechQueue.shift();
            promise.resolve(true);
            if (this.speechQueue.length) this.playQueue();
          });
        };
        if (soundNotify) {
          player.play(preSpeechSound, playSpeech);
        } else {
          playSpeech();
        }
      })
      .catch((err) => {
        // tts-service down or stub-503'd: drop the utterance, drain the queue.
        console.error('[v-assistant] tts-service failed:', err?.message || err);
        this.speechQueue.shift();
        promise.resolve(false);
        if (this.speechQueue.length) this.playQueue();
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
    const insideSensorTemperatureId = houseData && houseData.insideSensorTemperature || null;
    let insideSensorTemperature = nodes.find((node) => node.id === insideSensorTemperatureId);
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