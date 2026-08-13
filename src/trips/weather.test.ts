import { describe, expect, it, vi } from 'vitest';
import {
  fetchForecast,
  forecastRange,
  isoDate,
  weatherItems,
  WeatherError,
  FORECAST_HORIZON_DAYS,
} from './weather';
import type { ForecastDay } from '../db/schema';

const day = (minC: number, maxC: number, precipMm = 0, date = '2026-06-10'): ForecastDay => ({
  date,
  minC,
  maxC,
  precipMm,
});

const keys = (days: ForecastDay[]) => weatherItems(days).map((item) => item.key);

describe('weatherItems', () => {
  it('is empty with no forecast, so a failed lookup degrades to the plain template', () => {
    expect(weatherItems([])).toEqual([]);
  });

  it('adds nothing for mild dry weather', () => {
    expect(keys([day(16, 23)])).toEqual([]);
  });

  it('adds sun protection when hot', () => {
    expect(keys([day(20, 30)])).toEqual(['sunscreen', 'sunhat', 'sunglasses']);
  });

  it('adds a sweater when cool but not the winter kit', () => {
    expect(keys([day(10, 18)])).toEqual(['sweater']);
  });

  it('adds the winter kit when cold, sweater included', () => {
    expect(keys([day(3, 9)])).toEqual(['sweater', 'warmCoat', 'gloves', 'warmHat']);
  });

  it('adds rain gear when wet', () => {
    expect(keys([day(16, 22, 5)])).toEqual(['umbrella', 'rainJacket']);
  });

  it('ignores a trace of rain', () => {
    expect(keys([day(16, 22, 0.3)])).toEqual([]);
  });

  it('decides on the extremes across the trip, not the average', () => {
    const mixed = [day(20, 26), day(20, 26), day(2, 8), day(20, 34, 11)];
    const result = keys(mixed);
    expect(result).toContain('warmCoat');
    expect(result).toContain('sunscreen');
    expect(result).toContain('umbrella');
  });

  it('is exactly at the thresholds rather than just past them', () => {
    expect(keys([day(20, 27)])).toContain('sunscreen');
    expect(keys([day(20, 26.9)])).not.toContain('sunscreen');
    expect(keys([day(6, 14)])).toContain('warmCoat');
    expect(keys([day(6.1, 14)])).not.toContain('warmCoat');
    expect(keys([day(16, 22, 2)])).toContain('umbrella');
    expect(keys([day(16, 22, 1.9)])).not.toContain('umbrella');
  });
});

describe('forecastRange', () => {
  it('is null with nothing to summarise', () => {
    expect(forecastRange([])).toBeNull();
  });

  it('reports the extremes the extra items were derived from', () => {
    expect(forecastRange([day(4, 20, 1), day(9, 31, 7)])).toEqual({
      minC: 4,
      maxC: 31,
      wettestMm: 7,
    });
  });
});

describe('isoDate', () => {
  it('formats a date in the given zone', () => {
    // 22:00 UTC on the 9th is already the 10th in Jerusalem.
    expect(isoDate(Date.UTC(2026, 5, 9, 22, 0), 'Asia/Jerusalem')).toBe('2026-06-10');
    expect(isoDate(Date.UTC(2026, 5, 9, 22, 0), 'UTC')).toBe('2026-06-09');
  });
});

// ---------------------------------------------------------------- fetching

const GEO_OK = {
  results: [{ latitude: 48.85, longitude: 2.35, name: 'Paris', country: 'France' }],
};
const DAILY_OK = {
  daily: {
    time: ['2026-06-20', '2026-06-21'],
    temperature_2m_min: [14, 15],
    temperature_2m_max: [24, 28],
    precipitation_sum: [0, 3.4],
  },
};

/** A fetch stub that answers the geocoder then the forecast, recording the URLs it saw. */
function stubFetch(responses: unknown[], status = 200) {
  const urls: string[] = [];
  const impl = vi.fn(async (url: string) => {
    urls.push(url);
    const body = responses[Math.min(urls.length - 1, responses.length - 1)];
    return new Response(JSON.stringify(body), { status });
  });
  return { impl: impl as unknown as typeof fetch, urls };
}

const input = {
  destination: 'Paris',
  startAt: Date.UTC(2026, 5, 20),
  endAt: Date.UTC(2026, 5, 22),
  timezone: 'UTC',
  now: Date.UTC(2026, 5, 18),
};

describe('fetchForecast', () => {
  it('geocodes then fetches the daily series', async () => {
    const { impl, urls } = stubFetch([GEO_OK, DAILY_OK]);
    const forecast = await fetchForecast({ ...input, fetchImpl: impl });

    expect(urls[0]).toContain('geocoding-api.open-meteo.com');
    expect(urls[0]).toContain('name=Paris');
    expect(urls[1]).toContain('api.open-meteo.com');
    expect(urls[1]).toContain('latitude=48.85');
    expect(forecast.resolvedName).toBe('Paris, France');
    expect(forecast.days).toHaveLength(2);
    expect(forecast.days[1]).toEqual({ date: '2026-06-21', minC: 15, maxC: 28, precipMm: 3.4 });
  });

  it('keeps the coordinates so a refresh needs no second name lookup', async () => {
    const { impl } = stubFetch([GEO_OK, DAILY_OK]);
    const forecast = await fetchForecast({ ...input, fetchImpl: impl });
    expect(forecast.latitude).toBe(48.85);
    expect(forecast.longitude).toBe(2.35);
  });

  it('reports not-found separately from unavailable, so the UI can say which failed', async () => {
    const { impl } = stubFetch([{ results: [] }]);
    await expect(fetchForecast({ ...input, fetchImpl: impl })).rejects.toMatchObject({
      reason: 'not-found',
    });
  });

  it('treats an HTTP error as unavailable', async () => {
    const { impl } = stubFetch([GEO_OK], 503);
    await expect(fetchForecast({ ...input, fetchImpl: impl })).rejects.toBeInstanceOf(WeatherError);
  });

  it('treats a network failure as unavailable rather than throwing something raw', async () => {
    const impl = (async () => {
      throw new TypeError('offline');
    }) as unknown as typeof fetch;
    await expect(fetchForecast({ ...input, fetchImpl: impl })).rejects.toMatchObject({
      reason: 'unavailable',
    });
  });

  it('treats unparseable JSON as unavailable', async () => {
    const impl = (async () => new Response('<html>', { status: 200 })) as unknown as typeof fetch;
    await expect(fetchForecast({ ...input, fetchImpl: impl })).rejects.toMatchObject({
      reason: 'unavailable',
    });
  });

  it('clamps the request to the API horizon rather than asking for months out', async () => {
    const { impl, urls } = stubFetch([GEO_OK, DAILY_OK]);
    await fetchForecast({
      ...input,
      endAt: Date.UTC(2026, 10, 1), // months beyond what any model answers
      fetchImpl: impl,
    });
    const end = new URL(urls[1]!).searchParams.get('end_date')!;
    const horizon = isoDate(input.now + FORECAST_HORIZON_DAYS * 86_400_000, 'UTC');
    expect(end).toBe(horizon);
  });

  it('never asks for dates already past', async () => {
    const { impl, urls } = stubFetch([GEO_OK, DAILY_OK]);
    await fetchForecast({
      ...input,
      startAt: Date.UTC(2026, 5, 1), // trip started weeks ago
      fetchImpl: impl,
    });
    expect(new URL(urls[1]!).searchParams.get('start_date')).toBe('2026-06-18');
  });

  it('drops rows where a temperature is missing instead of emitting NaN', async () => {
    // These are four independent parallel arrays from an external service.
    const ragged = {
      daily: {
        time: ['2026-06-20', '2026-06-21', '2026-06-22'],
        temperature_2m_min: [14, null, 16],
        temperature_2m_max: [24, 26],
        precipitation_sum: [0, 1, null],
      },
    };
    const { impl } = stubFetch([GEO_OK, ragged]);
    const forecast = await fetchForecast({ ...input, fetchImpl: impl });
    expect(forecast.days.map((d) => d.date)).toEqual(['2026-06-20']);
  });

  it('treats a null precipitation as zero rather than dropping the day', async () => {
    const noPrecip = {
      daily: {
        time: ['2026-06-20'],
        temperature_2m_min: [14],
        temperature_2m_max: [24],
        precipitation_sum: [null],
      },
    };
    const { impl } = stubFetch([GEO_OK, noPrecip]);
    const forecast = await fetchForecast({ ...input, fetchImpl: impl });
    expect(forecast.days).toEqual([{ date: '2026-06-20', minC: 14, maxC: 24, precipMm: 0 }]);
  });

  it('survives a response with no daily block at all', async () => {
    const { impl } = stubFetch([GEO_OK, {}]);
    const forecast = await fetchForecast({ ...input, fetchImpl: impl });
    expect(forecast.days).toEqual([]);
  });

  it('encodes a destination with spaces and non-Latin characters', async () => {
    const { impl, urls } = stubFetch([GEO_OK, DAILY_OK]);
    await fetchForecast({ ...input, destination: 'תל אביב', fetchImpl: impl });
    expect(urls[0]).toContain(encodeURIComponent('תל אביב'));
  });

  it('omits the country when the geocoder gives none', async () => {
    const { impl } = stubFetch([{ results: [{ latitude: 1, longitude: 2, name: 'Nowhere' }] }, DAILY_OK]);
    const forecast = await fetchForecast({ ...input, fetchImpl: impl });
    expect(forecast.resolvedName).toBe('Nowhere');
  });
});
