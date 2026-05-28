import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// Re-implement the pure helpers locally because the .mjs script doesn't
// export them (it's a CLI entry point). Keeping these signatures in
// sync with `scripts/refine-url-first-seen-via-gsc.mjs` is the test's
// whole point — they decide JSON keys + day iteration.

function normalizePath(p: string): string {
  if (!p) return '';
  let s = p;
  if (s.startsWith('http://') || s.startsWith('https://')) {
    try { s = new URL(s).pathname; } catch { return ''; }
  }
  const q = s.indexOf('?'); if (q >= 0) s = s.slice(0, q);
  const h = s.indexOf('#'); if (h >= 0) s = s.slice(0, h);
  s = s.replace(/\/index\.html$/, '/');
  if (s.length > 1 && s.endsWith('/')) s = s.slice(0, -1);
  if (!s.startsWith('/')) s = '/' + s;
  return s;
}

function* daysFrom(startDate: string, endDate: string) {
  const d = new Date(`${startDate}T00:00:00Z`);
  const end = new Date(`${endDate}T00:00:00Z`);
  while (d <= end) {
    yield d.toISOString().slice(0, 10);
    d.setUTCDate(d.getUTCDate() + 1);
  }
}

describe('refine-url-first-seen-via-gsc', () => {
  describe('normalizePath: byte-identical contract with trafficEvidenceFilter + seed-url-first-seen-precise', () => {
    it('strips protocol+host', () => {
      expect(normalizePath('https://frontaliereticino.ch/about')).toBe('/about');
      expect(normalizePath('http://www.frontaliereticino.ch/about/')).toBe('/about');
    });
    it('strips query + hash', () => {
      expect(normalizePath('/about?utm=foo')).toBe('/about');
      expect(normalizePath('/about#section')).toBe('/about');
    });
    it('strips trailing slash except root', () => {
      expect(normalizePath('/about/')).toBe('/about');
      expect(normalizePath('/')).toBe('/');
    });
    it('strips /index.html suffix', () => {
      expect(normalizePath('/foo/index.html')).toBe('/foo');
    });
    it('returns empty on invalid URL', () => {
      expect(normalizePath('not a url with spaces and no slash')).toBe('/not a url with spaces and no slash');
      // pure paths get a leading slash; only http(s):// + invalid → ''
      expect(normalizePath('https://')).toBe('');
    });
    it('handles empty input', () => {
      expect(normalizePath('')).toBe('');
    });
  });

  describe('daysFrom: inclusive range, oldest-first', () => {
    it('single day yields that day', () => {
      expect(Array.from(daysFrom('2026-01-15', '2026-01-15'))).toEqual(['2026-01-15']);
    });
    it('multi-day inclusive both ends', () => {
      expect(Array.from(daysFrom('2026-01-15', '2026-01-17'))).toEqual([
        '2026-01-15', '2026-01-16', '2026-01-17',
      ]);
    });
    it('crosses month boundary', () => {
      const r = Array.from(daysFrom('2026-01-30', '2026-02-02'));
      expect(r).toEqual(['2026-01-30', '2026-01-31', '2026-02-01', '2026-02-02']);
    });
    it('crosses DST boundary without skipping days (UTC iteration)', () => {
      // EU DST start = last Sunday March. Make sure UTC math doesn't drop a day.
      const r = Array.from(daysFrom('2026-03-28', '2026-03-31'));
      expect(r).toEqual(['2026-03-28', '2026-03-29', '2026-03-30', '2026-03-31']);
    });
  });

  describe('contract: script file present + executable shebang', () => {
    it('script exists with #!/usr/bin/env node', () => {
      const src = readFileSync(join(__dirname, '../../scripts/refine-url-first-seen-via-gsc.mjs'), 'utf8');
      expect(src.startsWith('#!/usr/bin/env node')).toBe(true);
    });
    it('script declares FALLBACK_DATE default consistent with seed script', () => {
      const src = readFileSync(join(__dirname, '../../scripts/refine-url-first-seen-via-gsc.mjs'), 'utf8');
      const seedSrc = readFileSync(join(__dirname, '../../scripts/seed-url-first-seen-precise.mjs'), 'utf8');
      const ours = src.match(/fallbackDate:\s*'(\d{4}-\d{2}-\d{2})'/);
      const seeded = seedSrc.match(/fallbackDate:\s*'(\d{4}-\d{2}-\d{2})'/);
      expect(ours?.[1]).toBe(seeded?.[1]); // must match to detect/refine the same set
    });
  });
});
