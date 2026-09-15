import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import sources from '../data/pharmacy-duties-italy-sources.json';
import { assertOfficialItalyUrl } from '../scripts/import-pharmacy-duties-italy.mjs';

const REPO_ROOT = fileURLToPath(new URL('../', import.meta.url));
const SCRIPT_PATH = fileURLToPath(new URL('../scripts/import-pharmacy-duties-italy.mjs', import.meta.url));
const FIXTURE_DIR = fileURLToPath(new URL('./fixtures/pharmacy-duties/italy/', import.meta.url));
const FETCHED_AT = '2026-09-15T11:30:00.000Z';

describe('Italian pharmacy duty importer', () => {
  it('dry-run exits nonzero and never treats the partial fixtures as publishable', () => {
    const result = spawnSync(process.execPath, [
      SCRIPT_PATH,
      '--fixtures=' + FIXTURE_DIR,
      '--dry-run',
      '--at=' + FETCHED_AT,
    ], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
    });

    expect(result.error).toBeUndefined();
    expect(result.status).toBe(1);
    expect(result.stdout).toContain('"state": "not_published"');
    expect(result.stdout).toContain('"publishable": false');
    expect(result.stdout).toContain('"duties": 0');
  });

  it('rejects HTTP raw URLs and HTTP redirect targets', () => {
    const source = sources.sources.find((entry: { province: string }) => entry.province === 'CO');
    expect(() => assertOfficialItalyUrl('http://www.comune.merone.co.it/calendar.pdf', source, 'raw URL'))
      .toThrow('raw URL must remain official HTTPS');
    expect(() => assertOfficialItalyUrl('http://www.comune.merone.co.it/calendar.pdf', source, 'redirect final URL'))
      .toThrow('redirect final URL must remain official HTTPS');
    expect(() => assertOfficialItalyUrl(source.rawUrl, source)).not.toThrow();
  });
});
