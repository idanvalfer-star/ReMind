/**
 * Destination weather, and what it adds to a packing list.
 *
 * Open-Meteo because it is genuinely free and needs no key or account — which the brief requires,
 * and which almost no other weather API manages. Two endpoints are used: the geocoder to turn a
 * typed destination into coordinates, and the daily forecast.
 *
 * **This is the only network request the app ever makes that is not the push backend**, and it only
 * happens when the user taps for a forecast. That is a deliberate constraint rather than an
 * accident: the destination name and dates are exactly the kind of thing the rest of this codebase
 * goes to some length not to send anywhere, so it is opt-in, per trip, and documented in
 * PRIVACY.md.
 *
 * The pure part — deciding what a forecast implies you should pack — is separated from the fetching
 * so the interesting logic is testable without a network.
 */

import type { Forecast, ForecastDay, PackCategory } from '../db/schema';

const GEOCODE_URL = 'https://geocoding-api.open-meteo.com/v1/search';
const FORECAST_URL = 'https://api.open-meteo.com/v1/forecast';

/** Open-Meteo's daily series reaches about 16 days out; beyond that there is nothing to ask for. */
export const FORECAST_HORIZON_DAYS = 16;

/** A forecast older than this is stale enough to be worth refetching before it is trusted. */
export const FORECAST_STALE_MS = 12 * 60 * 60 * 1000;

// ---------------------------------------------------------------- the pure part

export interface WeatherItem {
  key: string;
  category: PackCategory;
}

/**
 * Thresholds, in Celsius and millimetres.
 *
 * Chosen for what a person would actually change about their bag, not for meteorological
 * significance: 27°C is when sun protection stops being optional, 6°C is when a coat is a different
 * coat, and 2mm of rain in a day is the difference between damp and wet.
 */
const HOT_MAX_C = 27;
const COOL_MIN_C = 12;
const COLD_MIN_C = 6;
const WET_MM = 2;

/**
 * Extra items a forecast justifies.
 *
 * Driven by the *extremes* across the whole trip rather than an average, because packing is decided
 * by the worst day: one cold night means taking the coat, and averaging it away is how you end up
 * shivering.
 *
 * Returns nothing for an empty forecast, so a failed or skipped lookup degrades to the plain
 * template rather than to a broken list.
 */
export function weatherItems(days: readonly ForecastDay[]): WeatherItem[] {
  if (days.length === 0) return [];

  const hottest = Math.max(...days.map((day) => day.maxC));
  const coldest = Math.min(...days.map((day) => day.minC));
  const wettest = Math.max(...days.map((day) => day.precipMm));

  const items: WeatherItem[] = [];
  if (hottest >= HOT_MAX_C) {
    items.push(
      { key: 'sunscreen', category: 'health' },
      { key: 'sunhat', category: 'clothing' },
      { key: 'sunglasses', category: 'misc' },
    );
  }
  if (coldest <= COOL_MIN_C) items.push({ key: 'sweater', category: 'clothing' });
  if (coldest <= COLD_MIN_C) {
    items.push(
      { key: 'warmCoat', category: 'clothing' },
      { key: 'gloves', category: 'clothing' },
      { key: 'warmHat', category: 'clothing' },
    );
  }
  if (wettest >= WET_MM) {
    items.push(
      { key: 'umbrella', category: 'misc' },
      { key: 'rainJacket', category: 'clothing' },
    );
  }
  return items;
}

/**
 * A one-line summary of the trip's weather, for the UI to explain itself with.
 *
 * Returns the range rather than a single number, because the range is what the extra items were
 * derived from and showing the same basis makes the additions legible.
 */
export function forecastRange(days: readonly ForecastDay[]): { minC: number; maxC: number; wettestMm: number } | null {
  if (days.length === 0) return null;
  return {
    minC: Math.min(...days.map((day) => day.minC)),
    maxC: Math.max(...days.map((day) => day.maxC)),
    wettestMm: Math.max(...days.map((day) => day.precipMm)),
  };
}

/** `YYYY-MM-DD` in a given zone, which is how Open-Meteo wants its date bounds. */
export function isoDate(at: number, timezone: string): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: timezone }).format(new Date(at));
}

// ---------------------------------------------------------------- the network part

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export class WeatherError extends Error {
  constructor(
    message: string,
    /** `not-found` when the destination could not be geocoded, so the UI can say which failed. */
    readonly reason: 'not-found' | 'unavailable',
  ) {
    super(message);
    this.name = 'WeatherError';
  }
}

interface GeocodeResult {
  results?: { latitude: number; longitude: number; name: string; country?: string }[];
}

interface DailyResponse {
  daily?: {
    time?: string[];
    temperature_2m_min?: number[];
    temperature_2m_max?: number[];
    precipitation_sum?: (number | null)[];
  };
}

export interface FetchForecastInput {
  destination: string;
  /** Trip bounds as epoch ms; the request is clamped to the API's horizon. */
  startAt: number;
  endAt: number;
  timezone: string;
  now?: number;
  fetchImpl?: FetchLike;
}

/**
 * Resolves a destination and fetches its daily forecast.
 *
 * Throws `WeatherError` rather than returning a partial result: the caller has a real decision to
 * make between "that place could not be found" and "the network is down", and collapsing both into
 * an empty forecast would show the user a list with no explanation for why it has no weather in it.
 */
export async function fetchForecast(input: FetchForecastInput): Promise<Forecast> {
  const fetchImpl = input.fetchImpl ?? fetch;
  const now = input.now ?? Date.now();

  const geo = await getJson<GeocodeResult>(
    fetchImpl,
    `${GEOCODE_URL}?name=${encodeURIComponent(input.destination)}&count=1&format=json`,
  );
  const place = geo.results?.[0];
  if (!place) throw new WeatherError(`no match for ${input.destination}`, 'not-found');

  // Clamp to what the API can answer. A trip booked four months out gets no forecast rather than a
  // silently empty series, and the UI says so.
  const horizonEnd = now + FORECAST_HORIZON_DAYS * 86_400_000;
  const from = isoDate(Math.max(input.startAt, now), input.timezone);
  const to = isoDate(Math.min(input.endAt, horizonEnd), input.timezone);

  const params = new URLSearchParams({
    latitude: String(place.latitude),
    longitude: String(place.longitude),
    daily: 'temperature_2m_min,temperature_2m_max,precipitation_sum',
    timezone: 'auto',
    start_date: from,
    end_date: to,
  });
  const forecast = await getJson<DailyResponse>(fetchImpl, `${FORECAST_URL}?${params}`);

  return {
    fetchedAt: now,
    latitude: place.latitude,
    longitude: place.longitude,
    resolvedName: place.country ? `${place.name}, ${place.country}` : place.name,
    days: toDays(forecast),
  };
}

/**
 * Reshapes the API's parallel arrays into rows.
 *
 * Defensive about length mismatches and nulls because these are four independent arrays from an
 * external service, and `precipitation_sum` in particular is null for days outside the model's
 * range rather than absent.
 */
function toDays(response: DailyResponse): ForecastDay[] {
  const daily = response.daily;
  const time = daily?.time ?? [];
  const min = daily?.temperature_2m_min ?? [];
  const max = daily?.temperature_2m_max ?? [];
  const precip = daily?.precipitation_sum ?? [];

  const days: ForecastDay[] = [];
  for (let i = 0; i < time.length; i++) {
    const date = time[i];
    const minC = min[i];
    const maxC = max[i];
    if (date === undefined || typeof minC !== 'number' || typeof maxC !== 'number') continue;
    days.push({ date, minC, maxC, precipMm: typeof precip[i] === 'number' ? precip[i]! : 0 });
  }
  return days;
}

async function getJson<T>(fetchImpl: FetchLike, url: string): Promise<T> {
  let response: Response;
  try {
    response = await fetchImpl(url, { headers: { accept: 'application/json' } });
  } catch (cause) {
    throw new WeatherError(`request failed: ${String(cause)}`, 'unavailable');
  }
  if (!response.ok) throw new WeatherError(`HTTP ${response.status}`, 'unavailable');
  try {
    return (await response.json()) as T;
  } catch (cause) {
    throw new WeatherError(`bad JSON: ${String(cause)}`, 'unavailable');
  }
}
