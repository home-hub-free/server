import axios from 'axios';
import { describeWeatherCode } from '../weather-descriptions';

// Open-Meteo — free, keyless weather forecast (https://open-meteo.com/en/docs).
// No API key/signup: location is a lat/lon. Defaults to Santiago de Querétaro (Vista Hermosa,
// CP 76063); override with WEATHER_LATITUDE / WEATHER_LONGITUDE. `timezone=auto` makes all
// returned timestamps local to that location, so sunrise/sunset and hourly indices line up
// with the hub's local clock without any offset math.
const OpenMeteoURL = 'https://api.open-meteo.com/v1/forecast';
const Latitude = process.env.WEATHER_LATITUDE || '20.5888';
const Longitude = process.env.WEATHER_LONGITUDE || '-100.3899';

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
  // Raw WMO weather-interpretation code (0..99). `description` is its sentence; the
  // code is kept so glanceable consumers (e.g. the dashboard hero) can map it to an
  // icon without re-parsing prose. null until the first successful fetch.
  weatherCode: number | null,
  isRising: boolean,
  hourlyTemperatures: number[],
  // Multi-day outlook (today + upcoming days) derived from Open-Meteo's `daily` block. One entry
  // per day; index 0 is today. Empty until the first successful fetch. Lets the agent answer
  // "weather for the week" from local state instead of a (useless) web_search.
  dailyForecast: Array<{
    date: string,          // Open-Meteo local date "YYYY-MM-DD"
    minTemp: number,
    maxTemp: number,
    weatherCode: number | null,
    description: string
  }>
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
  // Open-Meteo's free forecast endpoint does not provide moon times; kept on the interface
  // for compatibility but always null (no current consumer reads them).
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
  weatherCode: null,
  isRising: null,
  hourlyTemperatures: [],
  dailyForecast: [],
};

// Wall-clock of the last successful Open-Meteo fetch. null until the first success —
// consumers (e.g. GET /state) use it to avoid feeding stale/empty forecast values into the
// agent prompt when the API is unreachable.
export let weatherLastUpdated: Date | null = null;

export function getDayTimeWord(): 'morning' | 'afternoon' | 'evening' {
  let hours = new Date().getHours();
  if (hours >= 0 && hours <= 11) {
    return 'morning';
  } else if (hours >= 12 && hours <= 18) {
    return 'afternoon';
  } else {
    return 'evening'
  }
}

/**
 * Hits the Open-Meteo endpoint to get today's weather conditions.
 * @returns Simplified data ({ forecast, astro }) from the weather API
 */
export function updateWeatherData(): Promise<any> {
  const params = new URLSearchParams({
    latitude: Latitude,
    longitude: Longitude,
    current: 'temperature_2m,relative_humidity_2m,weather_code',
    hourly: 'temperature_2m,relative_humidity_2m',
    daily: 'temperature_2m_min,temperature_2m_max,sunrise,sunset,weather_code',
    timezone: 'auto',
    // A week's outlook. The daily block gives one entry per day (min/max/code) for the week view;
    // the today-centric derivations below deliberately slice `hourly` back to the first 24 entries
    // so bumping this never widens "today's" max/avg/rising math to the whole week.
    forecast_days: '7',
  });
  const url = `${OpenMeteoURL}?${params.toString()}`;
  return new Promise((resolve, reject) => {
    axios.get(url)
      .then((result) => {
        updateForecastData(result);
        updateAstroData(result);
        weatherLastUpdated = new Date();

        resolve({ forecast, astro });
      })
      .catch((err) => {
        if (err) {
          reject(err);
        }
      });
  });
}

function updateForecastData(result) {
  const data = result.data;
  const currentHour = new Date().getHours();

  // hourly.temperature_2m is one value per hour. With forecast_days=7 the full arrays span the
  // whole week (168 entries); every derivation below is about TODAY, so slice to the first 24
  // (hour 0..23 of day 0 with timezone=auto) before computing max/avg/rising.
  const temperatures: number[] = ((data.hourly && data.hourly.temperature_2m) || []).slice(0, 24);
  const humidities: number[] = ((data.hourly && data.hourly.relative_humidity_2m) || []).slice(0, 24);
  forecast.hourlyTemperatures = temperatures;

  // Is the temperature currently rising? Compare this hour to the next.
  let isRising = null;
  if (temperatures[currentHour] != null && temperatures[currentHour + 1] != null) {
    isRising = temperatures[currentHour] < temperatures[currentHour + 1];
  }
  forecast.isRising = isRising;

  // Time of day with the highest temperature (index = hour).
  if (temperatures.length) {
    const highestTemp = Math.max(...temperatures);
    forecast.maxTemp.value = highestTemp;
    forecast.maxTemp.hour = temperatures.indexOf(highestTemp);
  }

  // Open-Meteo has no single "average" field, so derive day averages from the hourly series.
  forecast.dayAvgTemp = temperatures.length ? round1(avg(temperatures)) : 0;
  forecast.humidityAvg = humidities.length ? Math.round(avg(humidities)) : 0;

  forecast.minTemp = firstDaily(data, 'temperature_2m_min', 0);
  forecast.currentTemp = (data.current && data.current.temperature_2m) ?? temperatures[currentHour] ?? 0;
  // Prefer the live `current.weather_code` over the daily summary so the hero icon
  // tracks now (e.g. clear at midday vs. an afternoon shower in the daily roll-up).
  const code = (data.current && data.current.weather_code) ?? firstDaily(data, 'weather_code', null);
  forecast.weatherCode = typeof code === 'number' ? code : null;
  forecast.description = describeWeatherCode(forecast.weatherCode);

  // Week outlook — one row per day from the daily block (index 0 = today). `daily.time` is always
  // returned; the min/max/code arrays line up with it. Guarded per-index so a short/absent array
  // never throws.
  const dTime: string[] = (data.daily && data.daily.time) || [];
  const dMin: number[] = (data.daily && data.daily.temperature_2m_min) || [];
  const dMax: number[] = (data.daily && data.daily.temperature_2m_max) || [];
  const dCode: number[] = (data.daily && data.daily.weather_code) || [];
  forecast.dailyForecast = dTime.map((date, i) => {
    const wc = typeof dCode[i] === 'number' ? dCode[i] : null;
    return {
      date,
      minTemp: dMin[i] != null ? Math.round(dMin[i]) : 0,
      maxTemp: dMax[i] != null ? Math.round(dMax[i]) : 0,
      weatherCode: wc,
      description: describeWeatherCode(wc),
    };
  });
}

function updateAstroData(result) {
  const data = result.data;
  // With timezone=auto these are local naive ISO strings (e.g. "2026-06-26T06:02"), which
  // `new Date(...)` parses as local time — exactly what the daily-events scheduler expects.
  const sunrise = firstDaily(data, 'sunrise', null);
  const sunset = firstDaily(data, 'sunset', null);
  astro.sunrise = sunrise ? new Date(sunrise) : null;
  astro.sunset = sunset ? new Date(sunset) : null;
  astro.moonrise = null;
  astro.moonset = null;
}

// daily.* fields are arrays (one entry per forecast day); we only ever request day 0.
function firstDaily(data: any, key: string, fallback: any) {
  const arr = data && data.daily && data.daily[key];
  return Array.isArray(arr) && arr.length ? arr[0] : fallback;
}

function avg(nums: number[]): number {
  return nums.reduce((a, b) => a + b, 0) / nums.length;
}

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}
