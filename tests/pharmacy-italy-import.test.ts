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
    // L'invariante non e' "zero righe in totale": e' che una fonte
    // `full-calendar` INCOMPLETA non pubblichi nulla. Le fixture di Como e
    // Varese coprono pochi giorni contro un minimo di 300, quindi pubblicano 0
    // righe e la release non e' pubblicabile. VCO, che e' `corrections-only`,
    // pubblica legittimamente i suoi cambi turno: pretendere `"duties": 0`
    // sull'intero payload pinnava il difetto invece dell'invariante.
    const report = JSON.parse(result.stdout);
    const byProvince = Object.fromEntries(report.provinces.map((entry: { province: string }) => [entry.province, entry]));
    expect(byProvince.CO).toMatchObject({ dutyCount: 0, state: 'partial', publication: 'required' });
    expect(byProvince.VA).toMatchObject({ dutyCount: 0, state: 'partial', publication: 'required' });
    expect(byProvince.VB).toMatchObject({ publication: 'best-effort' });
    // La misura esposta e' quella del CALENDARIO: sulle fixture e' un numero
    // piccolo, ed e' esattamente cio' che rende Como/Varese incomplete.
    expect(byProvince.CO.observedCalendarDays).toBeLessThan(300);
    expect(byProvince.CO.observedCalendarDays).toBeGreaterThan(0);
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
