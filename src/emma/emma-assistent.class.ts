import { getDayTimeWord, IForecastData, updateForecastData } from '../handlers/forecastHandler';
import { Greets, SentenceConnectors, SentenceEnders } from './greets';
import fs from 'fs';
const player = require('play-sound')({});
const AWS = require('aws-sdk');
const emmaSpeechPath = './src/sounds/speech/say.mp3';
const Polly = new AWS.Polly({
  region: 'us-east-1'
});

class Emma {

  public autoForecasted = {
    morning: false,
    afternoon: false,
    evening: false
  };

  constructor() {}

  public say(text: string): Promise<boolean> {
    const pollyOptions = {
      Engine: 'neural',
      LanguageCode: 'en-GB',
      OutputFormat: 'mp3',
      Text: text,
      VoiceId: 'Emma'
    };
    return new Promise((resolve, reject) => {
      player.play('./src/sounds/pre-notifier.mp3');
      Polly.synthesizeSpeech(pollyOptions, (err, data) => {
        if (err) return reject(err);

        fs.writeFileSync(emmaSpeechPath, data.AudioStream);
        player.play(emmaSpeechPath, () => {
          resolve(true);
        });
      });
    });
  }

  public sayWeatherForecast(autoTriggered?: boolean) {
    updateForecastData().then((data: IForecastData) => {
      let sentence = this.buildForecastSentence(data);
      this.say(sentence).then(() => {
        if (autoTriggered) {
          let dayTimeWord = getDayTimeWord();
          this.autoForecasted[dayTimeWord] = true;
        }
      });
    });
  }

  private buildForecastSentence(data: IForecastData): string {
    let greetTime = getDayTimeWord();  
    let greet = Greets[greetTime][Math.floor(Math.random() * Greets[greetTime].length)];
    let connector = SentenceConnectors[Math.floor(Math.random() * SentenceConnectors.length)];
    let ender = SentenceEnders[Math.floor(Math.random() * SentenceEnders.length)];
  
    let forecastSentence = 
      `${greet} ${greetTime === 'morning' ? connector + ',' : ''}
      For today's weather, the current temperature is ${data.currentTemp}° celcious ${data.isRising ? 'and rising' : data.isRising === null ? '' : 'and going down'},
      ${data.maxTemp > 0 ? "today's theoretical maximum is " + data.maxTemp + "° celcious" : ''}. ${data.description}. ${ender}`;

    console.log(forecastSentence);
  
    return forecastSentence;
  }
}

export const emma = new Emma();