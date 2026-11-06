import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const source = readFileSync(
  resolve(dirname(fileURLToPath(import.meta.url)), '../scripts/geocode-municipalities.mjs'),
  'utf8',
);

describe('municipality geocoder transport', () => {
  it('bounds Google and Nominatim request/body waits', () => {
    expect(source).toContain('GEOCODER_FETCH_TIMEOUT_MS');
    expect(source).toMatch(/fetch\(url,\s*\{\s*signal:\s*AbortSignal\.timeout\(GEOCODER_FETCH_TIMEOUT_MS\)/);
    expect(source).toMatch(/headers:\s*\{[^}]*['"]User-Agent['"]:[\s\S]*?\},\s*signal:\s*AbortSignal\.timeout\(GEOCODER_FETCH_TIMEOUT_MS\)/);
  });

  it('falls back to the default after flooring sub-millisecond values', () => {
    expect(source).toMatch(
      /const floored = Number\.isFinite\(raw\) && raw > 0 \? Math\.floor\(raw\) : 0;\s*return floored > 0 \? Math\.min\(floored, 120_000\) : 30_000;/,
    );
  });
});
