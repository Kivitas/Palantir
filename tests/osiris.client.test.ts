import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { normalizeFeed } from '../src/osiris/client';
import type { FeedLayerId } from '../src/osiris/types';

// Shapes are UNVERIFIED against the pinned Osiris release (see TODO in client.ts). These tests
// pin down what the normalizers accept today and that they never throw.

const EQ: FeedLayerId = 'earthquakes';
const FLIGHT: FeedLayerId = 'flights';

describe('normalizeFeed: envelopes', () => {
  it('maps a GeoJSON FeatureCollection (coordinates are [lon, lat])', () => {
    const items = normalizeFeed(EQ, {
      type: 'FeatureCollection',
      features: [
        {
          type: 'Feature',
          geometry: { type: 'Point', coordinates: [-122.4, 37.7] },
          properties: { mag: 4.2, place: 'Bay Area', time: 1700000000000, url: 'https://example.com/eq/1' },
          id: 'us1',
        },
      ],
    });
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      id: 'earthquakes:us1',
      layer: 'earthquakes',
      title: 'Bay Area',
      lat: 37.7,
      lon: -122.4,
      time: new Date(1700000000000).toISOString(),
      url: 'https://example.com/eq/1',
      severity: 4.2,
    });
  });

  it('maps a bare array of records', () => {
    const items = normalizeFeed(EQ, [
      { id: 'a', title: 'First', lat: 10, lon: 20 },
      { id: 'b', name: 'Second', latitude: '-5.5', longitude: '30' },
    ]);
    expect(items.map((i) => [i.id, i.title, i.lat, i.lon])).toEqual([
      ['earthquakes:a', 'First', 10, 20],
      ['earthquakes:b', 'Second', -5.5, 30],
    ]);
  });

  it('unwraps a {data: []} envelope', () => {
    const items = normalizeFeed(EQ, { data: [{ id: 'x', lat: 1, lon: 2 }] });
    expect(items).toHaveLength(1);
    expect(items[0]?.id).toBe('earthquakes:x');
  });

  it('unwraps one level of nesting such as {result: {data: []}}', () => {
    const items = normalizeFeed(EQ, { result: { data: [{ id: 'n', lat: 1, lon: 2 }] } });
    expect(items).toHaveLength(1);
  });

  it('does not descend past the allowed depth', () => {
    const deep = { data: { result: { data: [{ id: 'deep', lat: 1, lon: 2 }] } } };
    expect(normalizeFeed(EQ, deep)).toEqual([]);
  });
});

describe('normalizeFeed: OpenSky state arrays', () => {
  it('maps flight state vectors using icao24, callsign, time and lon/lat positions', () => {
    const state = ['abc123', 'UAL123  ', 'United States', 1700000000, 1700000005, -73.9, 40.6, 1000, false];
    const items = normalizeFeed(FLIGHT, { time: 1700000005, states: [state] });
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      id: 'flights:abc123',
      layer: 'flights',
      title: 'UAL123',
      lat: 40.6,
      lon: -73.9,
      time: new Date(1700000005 * 1000).toISOString(),
    });
  });

  it('drops state vectors shorter than the 7 fields needed for a position', () => {
    expect(normalizeFeed(FLIGHT, { states: [['abc123', 'X', 'Y', 1, 2, 3]] })).toEqual([]);
  });

  it('keeps the record but no position when coordinates are out of range', () => {
    const items = normalizeFeed(FLIGHT, { states: [['abc', 'C', 'O', 1, 2, 500, 95]] });
    expect(items).toHaveLength(1);
    expect(items[0]?.lat).toBeUndefined();
    expect(items[0]?.lon).toBeUndefined();
  });
});

describe('normalizeFeed: field handling', () => {
  it('rejects non-http(s) URLs', () => {
    const items = normalizeFeed(EQ, [{ id: 'j', lat: 1, lon: 1, url: 'javascript:alert(1)' }]);
    expect(items[0]?.url).toBeUndefined();
  });

  it('treats epoch seconds and epoch milliseconds the same way', () => {
    const [sec, ms] = normalizeFeed(EQ, [
      { id: 's', time: 1700000000, lat: 0, lon: 0 },
      { id: 'm', time: 1700000000000, lat: 0, lon: 0 },
    ]);
    expect(sec?.time).toBe(ms?.time);
  });

  it('rejects out-of-range latitude and longitude individually', () => {
    const [item] = normalizeFeed(EQ, [{ id: 'r', lat: 91, lon: 181 }]);
    expect(item?.lat).toBeUndefined();
    expect(item?.lon).toBeUndefined();
  });

  it('falls back to a generated title and index-based id when the record has none', () => {
    const [item] = normalizeFeed(EQ, [{ lat: 1, lon: 2 }]);
    expect(item?.id).toBe('earthquakes:0');
    expect(item?.title).toBe('Earthquakes 0');
  });
});

describe('normalizeFeed: garbage input never throws', () => {
  const garbage: unknown[] = [
    undefined,
    null,
    0,
    42,
    NaN,
    'string payload',
    true,
    [],
    {},
    { features: 'not-an-array' },
    { data: null, result: 7 },
    [null, 1, 'x', [], {}, { lat: 'abc', lon: {} }],
    { features: [null, undefined, 3, 'x', { geometry: { coordinates: 'nope' } }] },
    Object.create(null),
  ];

  it.each(garbage.map((g, i) => [i, g] as const))('case %i returns an array', (_i, input) => {
    expect(() => normalizeFeed(EQ, input)).not.toThrow();
    expect(Array.isArray(normalizeFeed(EQ, input))).toBe(true);
  });

  it('returns an empty list for payloads with no usable records', () => {
    expect(normalizeFeed(EQ, null)).toEqual([]);
    expect(normalizeFeed(EQ, { features: 'nope' })).toEqual([]);
  });

  it('survives getters that throw', () => {
    const hostile = new Proxy(
      {},
      {
        get() {
          throw new Error('boom');
        },
      },
    );
    expect(() => normalizeFeed(EQ, hostile)).not.toThrow();
    expect(normalizeFeed(EQ, hostile)).toEqual([]);
  });

  it('skips a record whose getter throws but keeps the rest', () => {
    const bad = {};
    Object.defineProperty(bad, 'id', {
      enumerable: true,
      get() {
        throw new Error('bad getter');
      },
    });
    const items = normalizeFeed(EQ, [bad, { id: 'ok', lat: 1, lon: 2 }]);
    expect(items.map((i) => i.id)).toEqual(['earthquakes:ok']);
  });
});

describe('osirisClient transport (fetch mocked)', () => {
  type Client = typeof import('../src/osiris/client')['osirisClient'];
  let client: Client;
  let fetchMock: ReturnType<typeof vi.fn>;

  const okJson = (body: unknown) =>
    ({ ok: true, status: 200, json: async () => body }) as unknown as Response;

  beforeEach(async () => {
    // The feed cache is module-level; reload the module for every test.
    vi.resetModules();
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    client = (await import('../src/osiris/client')).osirisClient;
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('fetches a layer through /osiris and normalizes the response', async () => {
    fetchMock.mockResolvedValue(okJson({ features: [{ geometry: { coordinates: [1, 2] }, id: 'q' }] }));
    const result = await client.fetchLayer('earthquakes');
    expect(fetchMock.mock.calls[0]?.[0]).toContain('/osiris/api/earthquakes');
    expect(result.error).toBeUndefined();
    expect(result.items).toHaveLength(1);
    expect(result.items[0]?.lat).toBe(2);
  });

  it('reports HTTP errors without throwing', async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 500, json: async () => ({}) } as unknown as Response);
    const result = await client.fetchLayer('earthquakes');
    expect(result).toMatchObject({ items: [], error: 'HTTP 500' });
  });

  it('reports network failures without throwing', async () => {
    fetchMock.mockRejectedValue(new TypeError('Failed to fetch'));
    const result = await client.fetchLayer('earthquakes');
    expect(result).toMatchObject({ items: [], error: 'Failed to fetch' });
  });

  it('reports invalid JSON bodies without throwing', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => {
        throw new SyntaxError('Unexpected token <');
      },
    } as unknown as Response);
    const result = await client.fetchLayer('earthquakes');
    expect(result.items).toEqual([]);
    expect(result.error).toContain('Unexpected token');
  });

  it('serves a second request inside the TTL from the cache', async () => {
    fetchMock.mockResolvedValue(okJson({ features: [] }));
    const bbox = { minLat: 1, minLon: 2, maxLat: 3, maxLon: 4 };
    await client.fetchLayer('earthquakes', { bbox });
    await client.fetchLayer('earthquakes', { bbox });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('does not collapse distinct bboxes onto one cache entry, and requests the rounded box', async () => {
    fetchMock.mockResolvedValue(okJson({ features: [] }));
    const a = { minLat: 10.12341, minLon: 20, maxLat: 11, maxLon: 21 };
    const b = { minLat: 10.1239, minLon: 20, maxLat: 11, maxLon: 21 };
    const c = { minLat: 10.1234, minLon: 20, maxLat: 11, maxLon: 21 };
    await client.fetchLayer('earthquakes', { bbox: a });
    await client.fetchLayer('earthquakes', { bbox: b });
    await client.fetchLayer('earthquakes', { bbox: c });
    // a and c round to the same box, so they share one request; b is a different request.
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(decodeURIComponent(fetchMock.mock.calls[0]?.[0] as string)).toContain('bbox=20,10.1234,21,11');
  });

  it('does not fetch an OSINT lookup with an empty query', async () => {
    const result = await client.osintSanctions('   ');
    expect(result).toMatchObject({ ok: false, error: 'empty query' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('sends a trimmed OSINT query parameter', async () => {
    fetchMock.mockResolvedValue(okJson({ hit: false }));
    const result = await client.osintIp('  1.2.3.4 ');
    expect(result.ok).toBe(true);
    expect(fetchMock.mock.calls[0]?.[0]).toContain('ip=1.2.3.4');
  });

  it('health() returns false instead of throwing when the network fails', async () => {
    fetchMock.mockRejectedValue(new Error('offline'));
    await expect(client.health()).resolves.toBe(false);
  });
});
