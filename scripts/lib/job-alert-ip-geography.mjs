import { createHash } from 'node:crypto';
import { isIP } from 'node:net';
import { anonymizeIp } from '../../functions/src/lib/requestForensics.js';

const DAY_MS = 86400000;

function publicPrefix(raw) {
  const ip = anonymizeIp(raw);
  if (!ip || !isIP(ip)) return null;
  if (isIP(ip) === 4) {
    const [a, b] = ip.split('.').map(Number);
    if (a === 0 || a === 10 || a === 127 || a >= 224 || (a === 169 && b === 254)
      || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168)
      || (a === 100 && b >= 64 && b <= 127)) return null;
  } else if (!/^[23]/.test(ip)) return null;
  return ip;
}

/** One bounded lookup per anonymized prefix/run; never transmits email or full IP. */
export function createRegistrationGeoLookup({ fetchImpl = fetch, now = () => Date.now() } = {}) {
  const pending = new Map();
  return async (subscriber = {}, saved = null) => {
    const ip = publicPrefix(subscriber.consent_ip);
    if (!ip) return null;
    const ipHash = createHash('sha256').update(ip).digest('hex');
    const at = now();
    if (saved?.ipHash === ipHash && (saved.expiresAt > at || (saved.attempts >= 3 && !saved.country))) return saved;
    if (!pending.has(ipHash)) pending.set(ipHash, (async () => {
      const base = { ipHash, source: 'geojs_ip_prefix', capturedAt: at,
        attempts: saved?.ipHash === ipHash ? (saved.attempts || 0) + 1 : 1 };
      try {
        // GeoJS's documented single-IP endpoint returns country/region/city.
        // https://www.geojs.io/docs/v1/endpoints/geo/
        const response = await fetchImpl(`https://get.geojs.io/v1/ip/geo/${encodeURIComponent(ip)}.json`, {
          signal: AbortSignal.timeout(3000),
        });
        if (!response.ok) return { ...base, expiresAt: at + DAY_MS };
        const data = await response.json();
        if (anonymizeIp(data?.ip) !== ip || !/^[A-Z]{2}$/.test(data?.country_code || '')) {
          return { ...base, expiresAt: at + DAY_MS };
        }
        const text = (value) => typeof value === 'string' && value.length <= 100 ? value.trim() : '';
        return { ...base, country: data.country_code, region: text(data.region), city: text(data.city),
          accuracyKm: Number.isFinite(data.accuracy) ? data.accuracy : null, expiresAt: at + 30 * DAY_MS };
      } catch {
        return { ...base, expiresAt: at + DAY_MS };
      }
    })());
    return pending.get(ipHash);
  };
}
