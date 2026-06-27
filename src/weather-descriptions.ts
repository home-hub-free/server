// WMO weather interpretation codes (worldwide), as returned by Open-Meteo's `weather_code`.
// https://open-meteo.com/en/docs — "WMO Weather interpretation codes (WW)".
// We map each code to a short English sentence in the assistant's existing declarative tone
// (it is both spoken aloud by the VAssistant forecast and surfaced to the LLM agent via /state).
// Codes Open-Meteo can emit are listed; unknown codes fall back via describeWeatherCode().
export const WMO_WEATHER: Record<number, string> = {
  0: "Today will be most likely clear",
  1: "Today will be mainly clear",
  2: "Today might be partly cloudy",
  3: "Today's sky will be overcast",
  45: "Today will be foggy",
  48: "Today will be foggy with rime",
  51: "Today might have light drizzle",
  53: "Today might have drizzle",
  55: "Today might have dense drizzle",
  56: "Today might have freezing drizzle",
  57: "Today might have dense freezing drizzle",
  61: "Today might have light rain",
  63: "Today might be rainy",
  65: "Today might have heavy rain",
  66: "Today might have freezing rain",
  67: "Today might have heavy freezing rain",
  71: "Today might have light snow",
  73: "Today might have snow",
  75: "Today might have heavy snow",
  77: "Today might have snow grains",
  80: "Today might have light rain showers",
  81: "Today might have rain showers",
  82: "Today might have violent rain showers",
  85: "Today might have light snow showers",
  86: "Today might have heavy snow showers",
  95: "Today might have a thunderstorm",
  96: "Today might have a thunderstorm with hail",
  99: "Today might have a thunderstorm with heavy hail",
};

/** Map a WMO weather code to its sentence, with a safe generic fallback for unmapped codes. */
export function describeWeatherCode(code: number | null | undefined): string {
  if (code == null) return "";
  return WMO_WEATHER[code] ?? "Today's weather is uncertain";
}
