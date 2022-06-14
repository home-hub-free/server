import axios from 'axios';
import { WeatherDescriptions } from '../weather-descriptions';
const WeatherApiURL = 'https://api.weatherapi.com/v1/';
const WeatherApiKey = process.env.WEATHER_API_KEY || '';
const ipAddress = process.env.IP_ADDRESS || '';

export interface IForecastData {
  maxTemp: number,
  minTemp: number,
  currentTemp: number,
  dayAvgTemp: number,
  humidityAvg: number,
  description: string,
  isRising: boolean
}

export const forecast: IForecastData = {
  maxTemp: 0,
  minTemp: 0,
  currentTemp: 0,
  dayAvgTemp: 0,
  humidityAvg: 0,
  description: '',
  isRising: false
};

export function getDayTimeWord(): 'morning' | 'afternoon' | 'evening' {
  let hours = new Date().getHours();
  if (hours >=0 && hours <= 11) {
    return 'morning';
  } else if (hours >= 12 && hours <=7) {
    return 'afternoon';
  } else {
    return 'evening';
  }
}

/**
 * Hits the weather API endpoint to get the current weather conditions for the IP address
 * in the .env file
 * @returns Simplified data from the weather API
 */
export function updateForecastData(): Promise<IForecastData> {
  let url = `${WeatherApiURL}forecast.json?key=${WeatherApiKey}&q=${ipAddress}&days=1&aqi=no&alerts=no`;
  return new Promise((resolve, reject) => {
    axios.get(url)
      .then((result) => {
        let now = new Date().getHours();
        let isRising = false;
        let forecastData = result.data.forecast.forecastday[0];
        let maxTemp = forecastData.day.maxtemp_c;
        let minTemp = forecastData.day.mintemp_c;
        let average = forecastData.day.avgtemp_c;
        let humidity = forecastData.day.avghumidity;
        let descriptionCode = forecastData.day.condition.code;
        let generalDescription = WeatherDescriptions.find((item) => item.code === descriptionCode).sentence;

        let current = forecastData.hour[now];
        let next = forecastData.hour[now + 1];
        if (next) {
          if (current.temp_c < next.temp_c) {
            isRising = true;
          } else if (current.temp_c > next.temp_c) {
            isRising = false;
          } else {
            isRising = null;
          }
        }

        let maxTempHour = 0;
        forecastData.hour.forEach((hour, i) => {
          if (hour.temp_c >= maxTemp) {
            maxTempHour = i;
          }
        });
        
        if (maxTempHour < now) {
          maxTemp = 0;
        }
        
        forecast.maxTemp = maxTemp;
        forecast.minTemp = minTemp;
        forecast.currentTemp = result.data.current.temp_c;
        forecast.dayAvgTemp = average;
        forecast.humidityAvg = humidity;
        forecast.description = generalDescription;
        forecast.isRising = isRising;

        resolve(forecast);
      })
      .catch((err) => {
        if (err) {
          reject(err);
        }
      });
  });
}