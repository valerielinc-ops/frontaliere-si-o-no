import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  collapseRepublishedCoopVacancies,
  createRepublishedCollapseForSliceWrite,
} from '../scripts/lib/coop-job-parser.mjs';

// #20424: on 2026-11-28 22 Coop groups (same title, same store, same body under
// two UUIDs) stayed published. The runner-side collapse ran before the slice
// writer resolved addresses and normalized bodies, so it never saw the pairs
// as equal. The collapse now also runs inside the writer, on the final records.

const read = (rel: string) => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');

// Record shape of a persisted Coop slice row (invented values).
const body = '## Verkäufer:in Beispiel\n\n**Coop Genossenschaft** — Musterdorf, BE, Svizzera\n\n- Pensum: 80-100 %\n\nDu berätst die Kundschaft und füllst Regale auf.';
const row = (uuid: string, extra: Record<string, unknown> = {}) => ({
  id: `company-${uuid.slice(0, 6)}`,
  companyKey: 'coop-ticino',
  company: 'Coop Genossenschaft',
  title: 'Verkäufer:in Beispiel',
  location: 'Musterdorf',
  addressLocality: 'Musterdorf',
  postalCode: '3999',
  streetAddress: 'Beispielgasse 12',
  streetAddressSource: 'source',
  description: body,
  url: `https://jobs.coopjobs.ch/offene-stellen/verkaeufer-in-beispiel/${uuid}`,
  slug: `verkaufer-in-beispiel-coop-musterdorf-${uuid.slice(0, 2)}`,
  slugByLocale: { it: `venditore-beispiel-coop-musterdorf-${uuid.slice(0, 2)}` },
  firstSeenAt: '2026-10-06T01:33:03.183Z',
  ...extra,
});

describe('final-slice collapse hook', () => {
  it('collapses an identical repost, keeps the older URL and bridges the removed routes', () => {
    const old = row('21ab8caf-0000', { postedDate: '2026-10-29', crawlerMissStreak: 1 });
    const repost = row('9ba2f26b-0000', { postedDate: '2026-11-27' });
    const hook = createRepublishedCollapseForSliceWrite('Coop');

    const kept = hook([repost, old]);

    expect(kept).toEqual([old]);
    expect(hook.collapsedCount).toBe(1);
    expect(old.previousSlugs).toContain(repost.slug);
    expect(old.previousSlugsByLocale?.it).toContain(repost.slugByLocale.it);
  });

  it('keeps two records when the body differs (different Pensum is another vacancy)', () => {
    const a = row('21ab8caf-0000', { postedDate: '2026-10-29' });
    const b = row('9ba2f26b-0000', { postedDate: '2026-11-27', description: body.replace('80-100 %', '40-60 %') });
    const hook = createRepublishedCollapseForSliceWrite('Coop');
    expect(hook([a, b])).toHaveLength(2);
    expect(hook.collapsedCount).toBe(0);
  });

  it('never treats the writer placeholder as a store address', () => {
    const a = row('21ab8caf-0000', { streetAddress: 'Musterdorf', streetAddressSource: 'to-enrich' });
    const b = row('9ba2f26b-0000', { streetAddress: 'Musterdorf', streetAddressSource: 'to-enrich' });
    expect(collapseRepublishedCoopVacancies([a, b]).collapsed).toEqual([]);
  });
});

describe('the writer and the three runners wire the final-state collapse', () => {
  const writerBody = () => {
    const src = read('scripts/assemble-jobs-dataset.mjs');
    const start = src.indexOf('export function writeJobsCrawlerSlice(');
    return src.slice(start, src.indexOf('\nexport ', start + 10));
  };

  it('writeJobsCrawlerSlice runs the hook after firstSeenAt and before the shrink guard', () => {
    const body = writerBody();
    const hook = body.indexOf('options.collapseRepublishedJobs(hardened.jobs)');
    expect(hook).toBeGreaterThan(body.indexOf('carryForwardFirstSeenAt('));
    expect(hook).toBeLessThan(body.indexOf('Anti-shrink guard'));
  });

  it.each([
    ['scripts/update-coop-jobs.mjs'],
    ['scripts/update-fust-jobs.mjs'],
    ['scripts/update-volg-jobs.mjs'],
  ])('%s passes collapseRepublishedJobs to the slice writer', (file) => {
    const src = read(file);
    expect(src).toContain('createRepublishedCollapseForSliceWrite(');
    expect(src).toMatch(/collapseRepublishedJobs: (finalCollapse|_finalCollapse)/);
    expect(src).toMatch(/onRouteHistoryOverflow/);
  });
});
