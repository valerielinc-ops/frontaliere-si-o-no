/**
 * tests/unsubscribe-forensics.test.ts
 *
 * Unit coverage for functions/src/lib/requestForensics.js plus the wiring that
 * carries it into every unsubscribe endpoint.
 *
 * Two invariants matter more than the field values themselves:
 *   1. NOTHING here may change unsubscribe behaviour. A GET still unsubscribes
 *      on the spot, the RFC 8058 one-click POST still returns 200, and a broken
 *      capture degrades to fewer fields instead of throwing.
 *   2. A raw IP is never stored. `anonymizeIp` is the only path to the
 *      `unsubscribe_ip` field and it truncates to /24 (IPv4) or /48 (IPv6).
 *
 * Every literal address below is from a range IANA reserves for documentation
 * (RFC 5737 203.0.113.0/24, 198.51.100.0/24; RFC 3849 2001:db8::/32) — no real
 * user address appears in this repo.
 */
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import {
  anonymizeIp,
  buildUnsubscribeForensics,
  extractClientIp,
  forensicsFields,
  truncateUserAgent,
} from '../functions/src/lib/requestForensics.js';
import { handleSavedJobsDigestUnsubscribe, generateSavedJobsDigestUnsubToken } from '../functions/src/savedJobsDigestUnsubscribe.js';
import { handleOutreachUnsubscribe, generateOutreachUnsubToken } from '../functions/src/outreachUnsubscribe.js';

/** Minimal Express-ish request double: `req.get` is case-insensitive, like Express. */
function fakeReq({ method = 'GET', headers = {} as Record<string, string>, ip = '' } = {}) {
  return {
    method,
    headers,
    ip,
    get(name: string) { return headers[String(name).toLowerCase()]; },
  };
}

// ── IP anonymization (the privacy contract) ──────────────────────────────────

describe('anonymizeIp — never returns a full address', () => {
  it('zeroes the last IPv4 octet (/24)', () => {
    expect(anonymizeIp('203.0.113.42')).toBe('203.0.113.0');
    expect(anonymizeIp('198.51.100.7')).toBe('198.51.100.0');
  });

  it('keeps only the first three IPv6 hextets (/48)', () => {
    expect(anonymizeIp('2001:0db8:85a3:0000:0000:8a2e:0370:7334')).toBe('2001:0db8:85a3::');
    expect(anonymizeIp('2001:db8:85a3::8a2e:370:7334')).toBe('2001:db8:85a3::');
  });

  it('treats an IPv4-mapped IPv6 address as IPv4', () => {
    expect(anonymizeIp('::ffff:203.0.113.42')).toBe('203.0.113.0');
  });

  it('strips a source port and IPv6 brackets before truncating', () => {
    expect(anonymizeIp('203.0.113.42:51514')).toBe('203.0.113.0');
    expect(anonymizeIp('[2001:db8:85a3::1]:443')).toBe('2001:db8:85a3::');
  });

  it('drops an IPv6 zone index', () => {
    expect(anonymizeIp('fe80::1%eth0')).toBe('fe80:0:0::');
  });

  it('returns null (no half-anonymized string) for anything unparseable', () => {
    for (const bad of ['', '   ', 'not-an-ip', '203.0.113', '203.0.113.999', '1:2:3', 'a.b.c.d', null, undefined, 42]) {
      expect(anonymizeIp(bad as any)).toBeNull();
    }
  });

  it('never echoes back the full input for a valid address', () => {
    for (const ip of ['203.0.113.42', '2001:db8:85a3::8a2e:370:7334', '198.51.100.255']) {
      expect(anonymizeIp(ip)).not.toBe(ip);
    }
  });
});

// ── Proxy chain ──────────────────────────────────────────────────────────────

describe('extractClientIp — honours the proxy chain', () => {
  it('prefers cf-connecting-ip, the one header an external caller cannot forge', () => {
    const req = fakeReq({
      headers: {
        'cf-connecting-ip': '203.0.113.42',
        'x-forwarded-for': '198.51.100.9, 10.0.0.1',
        'x-real-ip': '198.51.100.10',
      },
    });
    expect(extractClientIp(req)).toBe('203.0.113.42');
  });

  it('falls back to the leftmost x-forwarded-for hop', () => {
    const req = fakeReq({ headers: { 'x-forwarded-for': '203.0.113.42, 70.41.3.18, 10.0.0.1' } });
    expect(extractClientIp(req)).toBe('203.0.113.42');
  });

  it('falls back to x-real-ip, then to req.ip', () => {
    expect(extractClientIp(fakeReq({ headers: { 'x-real-ip': '203.0.113.7' } }))).toBe('203.0.113.7');
    expect(extractClientIp(fakeReq({ ip: '203.0.113.8' }))).toBe('203.0.113.8');
  });

  it('returns null when the request carries nothing usable', () => {
    expect(extractClientIp(fakeReq())).toBeNull();
    expect(extractClientIp({} as any)).toBeNull();
    expect(extractClientIp(null as any)).toBeNull();
  });

  it('reads headers directly when the request has no Express `get`', () => {
    expect(extractClientIp({ headers: { 'cf-connecting-ip': '203.0.113.42' } } as any)).toBe('203.0.113.42');
  });
});

// ── User agent ───────────────────────────────────────────────────────────────

describe('truncateUserAgent', () => {
  it('caps a hostile length', () => {
    expect(truncateUserAgent('A'.repeat(10_000))).toHaveLength(256);
  });

  it('returns null for absent/blank/non-string input', () => {
    for (const bad of [undefined, null, '', '   ', 42, {}]) {
      expect(truncateUserAgent(bad as any)).toBeNull();
    }
  });
});

// ── Payload builder ──────────────────────────────────────────────────────────

describe('buildUnsubscribeForensics', () => {
  it('records GET vs POST — Gmail one-click POSTs, a link scanner GETs', () => {
    expect(buildUnsubscribeForensics(fakeReq({ method: 'GET' })).unsubscribe_method).toBe('GET');
    expect(buildUnsubscribeForensics(fakeReq({ method: 'POST' })).unsubscribe_method).toBe('POST');
    expect(buildUnsubscribeForensics(fakeReq({ method: 'post' })).unsubscribe_method).toBe('POST');
  });

  it('captures a truncated UA and an ANONYMIZED ip, never the raw one', () => {
    const req = fakeReq({
      method: 'POST',
      headers: {
        'user-agent': 'Mozilla/5.0 (Macintosh) SomeScanner/2.1',
        'cf-connecting-ip': '203.0.113.42',
      },
    });
    expect(buildUnsubscribeForensics(req)).toEqual({
      unsubscribe_method: 'POST',
      unsubscribe_user_agent: 'Mozilla/5.0 (Macintosh) SomeScanner/2.1',
      unsubscribe_ip: '203.0.113.0',
    });
  });

  it('tolerates a missing user-agent — method survives on its own', () => {
    const out = buildUnsubscribeForensics(fakeReq({ method: 'GET', headers: { 'cf-connecting-ip': '203.0.113.42' } }));
    expect(out.unsubscribe_method).toBe('GET');
    expect(out).not.toHaveProperty('unsubscribe_user_agent');
  });

  it('never throws — a request whose accessors blow up yields fewer fields, not an error', () => {
    const hostile = {
      method: 'GET',
      get(): string { throw new Error('header access exploded'); },
      get headers(): never { throw new Error('headers exploded'); },
    };
    expect(() => buildUnsubscribeForensics(hostile as any)).not.toThrow();
    expect(buildUnsubscribeForensics(hostile as any)).toEqual({ unsubscribe_method: 'GET' });
    expect(() => buildUnsubscribeForensics(undefined as any)).not.toThrow();
  });
});

// ── Allowlist copier ─────────────────────────────────────────────────────────

describe('forensicsFields', () => {
  it('copies only the three known fields', () => {
    expect(forensicsFields({
      unsubscribe_method: 'GET',
      unsubscribe_ip: '203.0.113.0',
      active: true,
      status: 'confirmed',
    } as any)).toEqual({ unsubscribe_method: 'GET', unsubscribe_ip: '203.0.113.0' });
  });

  it('returns {} for junk input instead of throwing', () => {
    for (const junk of [undefined, null, 'string', 42, []]) {
      expect(forensicsFields(junk as any)).toEqual({});
    }
  });

  it('discards a partial capture when a getter throws', () => {
    const hostile = {
      unsubscribe_method: 'GET',
      get unsubscribe_user_agent(): string { throw new Error('boom'); },
    };
    expect(forensicsFields(hostile as any)).toEqual({});
  });

  it('ignores non-string values', () => {
    expect(forensicsFields({ unsubscribe_method: 42, unsubscribe_ip: null } as any)).toEqual({});
  });
});

// ── Sibling endpoints: saved-jobs digest + employer outreach ─────────────────

describe('handleSavedJobsDigestUnsubscribe — forensics', () => {
  const SECRET = 'test-secret-saved-jobs';
  const UID = 'uid-abc-123';

  function capturingDb(userData: Record<string, unknown> | null) {
    const sets: Record<string, any>[] = [];
    return {
      sets,
      collection: () => ({
        doc: () => ({
          get: async () => ({ exists: userData !== null, data: () => userData || {} }),
          set: async (data: any) => { sets.push(data); },
        }),
      }),
    };
  }

  it('records method/UA/anonymized ip inside the savedJobsDigest write', async () => {
    const db = capturingDb({ savedJobsDigest: { optedOut: false } });
    const result = await handleSavedJobsDigestUnsubscribe({
      uid: UID,
      email: 'user@example.com',
      token: generateSavedJobsDigestUnsubToken(UID, SECRET),
      secret: SECRET,
      forensics: buildUnsubscribeForensics(fakeReq({
        method: 'POST',
        headers: { 'user-agent': 'Gmail-Unsubscriber', 'cf-connecting-ip': '203.0.113.42' },
      })),
      db: db as any,
    });

    expect(result.status).toBe(200);
    expect(db.sets[0].savedJobsDigest).toMatchObject({
      optedOut: true,
      unsubscribe_method: 'POST',
      unsubscribe_user_agent: 'Gmail-Unsubscriber',
      unsubscribe_ip: '203.0.113.0',
    });
  });

  it('opts out exactly as before with no forensics passed', async () => {
    const db = capturingDb({ savedJobsDigest: { optedOut: false } });
    const result = await handleSavedJobsDigestUnsubscribe({
      uid: UID,
      email: '',
      token: generateSavedJobsDigestUnsubToken(UID, SECRET),
      secret: SECRET,
      db: db as any,
    });
    expect(result.status).toBe(200);
    expect(db.sets[0].savedJobsDigest.optedOut).toBe(true);
    expect(db.sets[0].savedJobsDigest).not.toHaveProperty('unsubscribe_method');
  });

  it('keeps the 200-on-repeat idempotency (provider retry safety) untouched', async () => {
    const db = capturingDb({ savedJobsDigest: { optedOut: true } });
    const result = await handleSavedJobsDigestUnsubscribe({
      uid: UID,
      email: '',
      token: generateSavedJobsDigestUnsubToken(UID, SECRET),
      secret: SECRET,
      forensics: { unsubscribe_method: 'POST' },
      db: db as any,
    });
    expect(result.status).toBe(200);
    expect(db.sets).toHaveLength(0);
  });
});

describe('handleOutreachUnsubscribe — forensics', () => {
  const SECRET = 'test-secret-outreach';
  const COMPANY = 'acme-sa';

  function capturingDb() {
    const sets: Record<string, any>[] = [];
    return {
      sets,
      collection: () => ({ doc: () => ({ set: async (data: any) => { sets.push(data); } }) }),
    };
  }

  it('records forensics on the suppression write', async () => {
    const db = capturingDb();
    const result = await handleOutreachUnsubscribe({
      companyKey: COMPANY,
      token: generateOutreachUnsubToken(COMPANY, SECRET),
      secret: SECRET,
      forensics: buildUnsubscribeForensics(fakeReq({
        method: 'GET',
        headers: { 'user-agent': 'Barracuda-Link-Protect', 'x-forwarded-for': '198.51.100.77' },
      })),
      db: db as any,
    });

    expect(result.status).toBe(200);
    expect(db.sets[0]).toMatchObject({
      companyKey: COMPANY,
      source: 'one-click',
      unsubscribe_method: 'GET',
      unsubscribe_user_agent: 'Barracuda-Link-Protect',
      unsubscribe_ip: '198.51.100.0',
    });
  });

  it('rejects a bad token before any write, forensics or not', async () => {
    const db = capturingDb();
    const result = await handleOutreachUnsubscribe({
      companyKey: COMPANY,
      token: 'deadbeef'.repeat(8),
      secret: SECRET,
      forensics: { unsubscribe_method: 'GET' },
      db: db as any,
    });
    expect(result.status).toBe(403);
    expect(db.sets).toHaveLength(0);
  });
});

// ── Endpoint wiring (source scan) ────────────────────────────────────────────
//
// The onRequest wrappers cannot be imported here (they construct real
// firebase-functions handlers), so the handler → forensics wiring is asserted
// against the source. Without this, a handler could silently stop being fed and
// every unit test above would still pass on hand-built inputs.

describe('functions/index.js — every unsubscribe endpoint feeds the handler', () => {
  const src = fs.readFileSync(path.resolve(__dirname, '../functions/index.js'), 'utf8');

  it('imports the shared builder rather than re-deriving headers inline', () => {
    expect(src).toContain("import { buildUnsubscribeForensics } from './src/lib/requestForensics.js'");
    // No endpoint may read the proxy chain by hand — one helper, no drift.
    expect(src).not.toMatch(/req\.(get\(['"]x-forwarded-for|headers\[['"]x-forwarded-for)/);
  });

  for (const handler of [
    'handleJobAlertUnsubscribe',
    'handleSavedJobsDigestUnsubscribe',
    'handleOutreachUnsubscribe',
    'handleSubscriptionManagement',
  ]) {
    it(`${handler} receives forensics: buildUnsubscribeForensics(req)`, () => {
      const start = src.indexOf(`await ${handler}({`);
      expect(start).toBeGreaterThan(-1);
      const call = src.slice(start, src.indexOf('});', start));
      expect(call).toContain('forensics: buildUnsubscribeForensics(req)');
    });
  }

  it('still answers a one-click POST with 200 and no HTML body (RFC 8058 unchanged)', () => {
    expect(src).toMatch(/res\.status\(result\.status\)\.type\('text'\)\.send\(result\.status === 200 \? 'OK' : 'Error'\)/);
  });
});
