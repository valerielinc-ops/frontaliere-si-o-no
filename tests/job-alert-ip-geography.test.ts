import { describe, expect, it, vi } from 'vitest';
import { createRegistrationGeoLookup } from '../scripts/lib/job-alert-ip-geography.mjs';
import { discoveryGeography } from '../scripts/lib/job-alert-discovery.mjs';

describe('registration IP geography', () => {
  it('looks up the anonymized prefix once without transmitting email/full IP, and shares the result', async () => {
    const fetchImpl = vi.fn(async () => ({ ok: true, json: async () => ({ ip: '8.8.8.0', country_code: 'CH', region: 'Ticino', city: 'Lugano', accuracy: 20 }) }));
    const lookup = createRegistrationGeoLookup({ fetchImpl });
    const [a, b] = await Promise.all([lookup({ consent_ip: '8.8.8.8' }), lookup({ consent_ip: '8.8.8.9' })]);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(fetchImpl.mock.calls[0][0]).toBe('https://get.geojs.io/v1/ip/geo/8.8.8.0.json');
    expect(a).toEqual(b); expect(a).toMatchObject({ country: 'CH', city: 'Lugano', source: 'geojs_ip_prefix' });
    expect(JSON.stringify(a)).not.toContain('8.8.8.');
  });

  it.each(['', 'garbage', '127.0.0.1', '10.1.2.3', '192.168.1.4', 'fc00::1'])('does not query private/invalid IP %s', async (ip) => {
    const fetchImpl = vi.fn(); const lookup = createRegistrationGeoLookup({ fetchImpl });
    expect(await lookup({ consent_ip: ip })).toBeNull(); expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('preserves unknown on timeout and backs off instead of repeating the lookup', async () => {
    const now = Date.now(); const fetchImpl = vi.fn(async () => { throw new Error('timeout'); });
    const first = await createRegistrationGeoLookup({ fetchImpl, now: () => now })({ consent_ip: '8.8.8.8' });
    expect(first.country).toBeUndefined();
    expect(await createRegistrationGeoLookup({ fetchImpl, now: () => now + 1 })({ consent_ip: '8.8.8.8' }, first)).toEqual(first);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('rejects a response for a different IP instead of borrowing its city', async () => {
    const fetchImpl = vi.fn(async () => ({ ok: true, json: async () => ({ ip: '1.1.1.1', country_code: 'CH', city: 'Lugano' }) }));
    expect((await createRegistrationGeoLookup({ fetchImpl })({ consent_ip: '8.8.8.8' })).country).toBeUndefined();
  });

  it('bounds failed lookup recovery to three attempts until the registration prefix changes', async () => {
    const now = Date.now(); const fetchImpl = vi.fn(async () => { throw new Error('unavailable'); });
    const lookup = createRegistrationGeoLookup({ fetchImpl, now: () => now });
    const first = await lookup({ consent_ip: '8.8.8.8' });
    const exhausted = { ...first, attempts: 3, expiresAt: now - 1 };
    await createRegistrationGeoLookup({ fetchImpl, now: () => now })({ consent_ip: '8.8.8.8' }, exhausted);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('lets stated locations win over IP and only reuses the native border-commute map', () => {
    const chosen = discoveryGeography({ geo_country: 'CH', geo_region: 'Zurich' }, { preferredCantons: ['ti'] });
    expect([...chosen.cantons]).toEqual(['ti']);
    expect([...discoveryGeography({ geo_country: 'IT', geo_city: 'Como' }, {}).cantons]).toEqual(['ti']);
    expect(discoveryGeography({ geo_country: 'IT', geo_city: 'Unknown' }, {}).cantons.size).toBe(0);
  });
});
