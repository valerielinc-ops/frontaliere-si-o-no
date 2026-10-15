import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { aggregateLamalCantonMedians } from '../build-plugins/comparisonsHubAggregate';

const roots: string[] = [];
const year = new Date().getUTCFullYear();
const profile = (premium: number) => ({ ERW: { withoutAccident: { '300': { standard: premium } } } });
function snapshot(value?: unknown) {
  const root = mkdtempSync(path.join(tmpdir(), 'health-hub-'));
  roots.push(root);
  if (value !== undefined) {
    const folder = path.join(root, 'data', 'health-premiums');
    mkdirSync(folder, { recursive: true });
    writeFileSync(path.join(folder, `${year}.json`), JSON.stringify(value));
  }
  return root;
}
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

describe('comparison hub observed health premiums', () => {
  it('calculates the stated insurer-region median and does not fill absent cantons', () => {
    const root = snapshot({ year, sourceUrl: 'https://opendata.bagnet.ch/', quotes: {
      TI: { '1': { '8': profile(300), '32': profile(400), '1562': profile(700) }, '2': { '8': profile(600) } },
    } });
    expect(aggregateLamalCantonMedians(root, year)).toEqual([
      { canton: 'Ticino', code: 'TI', year, medianMonthlyCHF: 500, annualCHF: 6000 },
    ]);
  });

  it('returns unavailable for missing data instead of publishing fixed canton prices', () => {
    expect(aggregateLamalCantonMedians(snapshot(), year)).toEqual([]);
  });

  it('rejects a different data year and malformed quote profiles', () => {
    for (const payload of [
      { year: year + 1, sourceUrl: 'https://opendata.bagnet.ch/', quotes: { TI: { '1': { '8': profile(300) } } } },
      { year, sourceUrl: 'https://opendata.bagnet.ch/', quotes: { TI: { '1': { '8': null } } } },
    ]) expect(aggregateLamalCantonMedians(snapshot(payload), year)).toEqual([]);
  });

  it('omits a canton with insufficient observed standard premiums', () => {
    const root = snapshot({ year, sourceUrl: 'https://opendata.bagnet.ch/', quotes: { TI: { '1': { '8': profile(300) } } } });
    expect(aggregateLamalCantonMedians(root, year)).toEqual([]);
  });
});
