import { getDayTimeWord, IForecastData, updateWeatherData } from '../handlers/forecastHandler';
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
      Polly.synthesizeSpeech(pollyOptions, (err, data) => {
        if (err) return reject(err);
        
        fs.writeFileSync(emmaSpeechPath, data.AudioStream);
        player.play('./src/sounds/pre-notifier.mp3', () => {
          player.play(emmaSpeechPath, () => {
            resolve(true);
          });
        });
      });
    });
  }

  public sayWeatherForecast(autoTriggered?: boolean) {
    updateWeatherData().then((data) => {
      let sentence = this.buildForecastSentence(data.forecast);
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

    let emmaGreet = `${greet} ${greetTime === 'morning' ? connector + ',' : ''}`;
    let emmaCurrentWeather = `For today's weather, the current temperature is ${data.currentTemp}° celcious ${data.isRising ? 'and rising' : data.isRising === null ? '' : 'and going down'}.`;
    
    let showMax = data.maxTemp.hour > new Date().getHours();
    let emmaMaxTemperature = showMax ? `Today's theoretical maximum is ${data.maxTemp.value}° celcious.` : '';

    let emmaWeatherDescription = `${data.description}.`;
    let emmaDone = ender;

    let fullSentence = `${emmaGreet} ${emmaCurrentWeather} ${emmaMaxTemperature} ${emmaWeatherDescription} ${emmaDone}`;
  
    return fullSentence;
  }
}

export const emma = new Emma();

setInterval(() => {
  // Play this sound and super low volume to keep the bluetooth speaker from turning off
  player.play('./src/sounds/pre-notifier.mp3', {
    mpg123: ['-f', 500]
  });
}, 60 * 1000);