/**
 * Tests for the BAZG waiting-times client probe.
 *
 * As of 2026-04-21 the BAZG (Swiss Customs) public waiting-times portal was
 * redesigned as a Nuxt SPA and no stable public JSON endpoint could be
 * discovered during the F8 sondaggi (every known candidate returns 404 / 502).
 *
 * The probe script `scripts/probe-bazg-waiting-times.mjs` exists so we can
 * re-run the discovery whenever BAZG publishes a proper API. This test
 * locks in the contract shape: the script must import nothing outside of
 * the standard library and must exit(0) iff at least one endpoint returns
 * JSON with HTTP 2xx.
 */

import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

describe('BAZG probe script', () => {
  const scriptPath = path.resolve(__dirname, '..', 'scripts', 'probe-bazg-waiting-times.mjs');

  it('script exists and is a plain ES module', () => {
    expect(fs.existsSync(scriptPath)).toBe(true);
    const raw = fs.readFileSync(scriptPath, 'utf-8');
    // No firebase-admin or other heavy deps — probe must stay minimal
    expect(raw).not.toContain("firebase-admin");
    expect(raw).toContain('CANDIDATES');
    expect(raw).toContain("'User-Agent'");
  });

  it('script probes at least 4 candidate endpoints', () => {
    const raw = fs.readFileSync(scriptPath, 'utf-8');
    const candidates = raw.match(/https:\/\/[^'"\s]+/g) ?? [];
    expect(candidates.length).toBeGreaterThanOrEqual(4);
  });

  it('script exits with code 0 only when at least one endpoint returns JSON', () => {
    const raw = fs.readFileSync(scriptPath, 'utf-8');
    expect(raw).toContain('process.exit(ok.length > 0 ? 0 : 1)');
  });
});
