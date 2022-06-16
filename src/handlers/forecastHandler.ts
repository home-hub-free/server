import axios from 'axios';
import { WeatherDescriptions } from '../weather-descriptions';
const WeatherApiURL = 'https://api.weatherapi.com/v1/';
const WeatherApiKey = process.env.WEATHER_API_KEY || '';
// const ipAddress = process.env.IP_ADDRESS || '';

export interface IForecastData {
  maxTemp: {
    hour: number,
    value: number
  },
  minTemp: number,
  currentTemp: number,
  dayAvgTemp: number,
  humidityAvg: number,
  description: string,
  isRising: boolean
}

export interface IAstroData {
  sunset: Date,
  sunrise: Date,
  moonrise: Date,
  moonset: Date
}

export let astro: IAstroData = {
  sunset: null,
  sunrise: null,
  moonrise: null,
  moonset: null
};
export let forecast: IForecastData = {
  maxTemp: {
    hour: 0,
    value: 0
  },
  minTemp: 0,
  currentTemp: 0,
  dayAvgTemp: 0,
  humidityAvg: 0,
  description: '',
  isRising: null
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
 * Hits the weather API endpoint to get the current weather conditions
 * @returns Simplified data from the weather API
 */
export function updateWeatherData(): Promise<any> {
  let url = `${WeatherApiURL}forecast.json?key=${WeatherApiKey}&q=Santiago De Queretaro&days=1&aqi=no&alerts=no`;
  return new Promise((resolve, reject) => {
    axios.get(url)
      .then((result) => {

        updateForecastData(result);
        updateAstroData(result);

        resolve({ forecast, astro});
      })
      .catch((err) => {
        if (err) {
          reject(err);
        }
      });
  });
}

function updateForecastData(result) {
  let currentHour = new Date().getHours();
  let forecastDay = result.data.forecast.forecastday[0];
  
  // Define if temperature is currently rising
  let isRising = null;
  let currentHourForecast = forecastDay.hour[currentHour];
  let nextHourForecast = forecastDay.hour[currentHour + 1];
  if (nextHourForecast) isRising = currentHourForecast.temp_c < nextHourForecast.temp_c;

  // Define the time of the day with the highest temperature
  // This is an array of length 23, one index per hour of the day
  let temperatures = forecastDay.hour.map(hourData => hourData.temp_c);
  let highestTemp = Math.max(...temperatures)
  let hour = temperatures.indexOf(highestTemp);
  forecast.maxTemp.value = highestTemp;
  forecast.maxTemp.hour = hour;
  
  // Update all important values
  forecast.minTemp = forecastDay.day.mintemp_c;
  forecast.currentTemp = result.data.current.temp_c;
  forecast.dayAvgTemp = forecastDay.day.avgtemp_c;
  forecast.humidityAvg = forecastDay.day.avghumidity;
  forecast.description = WeatherDescriptions.find((item) => item.code === forecastDay.day.condition.code).sentence;
  forecast.isRising = isRising;
}

function updateAstroData(result) {
  let astroServerData = result.data.forecast.forecastday[0].astro;
  astro.sunrise = timeStringToDate(astroServerData.sunrise);
  astro.sunset = timeStringToDate(astroServerData.sunset);
  astro.moonrise = timeStringToDate(astroServerData.moonrise);
  astro.moonset = timeStringToDate(astroServerData.moonset);
}

// Date string comes in format: HH:MM AM/PM
function timeStringToDate(date: string): Date {
  let ISODate = new Date();
  let splitted = date.split(' ');
  let time = splitted[0];
  let meridian = splitted[1];

  let timeSplitted = time.split(':');
  let hour = parseInt(meridian === 'PM' ? timeSplitted[0] + 12 : timeSplitted[0]);
  let minute = parseInt(timeSplitted[1]);

  ISODate.setHours(hour);
  ISODate.setMinutes(minute);
  ISODate.setSeconds(0);

  return ISODate;
}