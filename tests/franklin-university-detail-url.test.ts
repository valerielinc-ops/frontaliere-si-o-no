import { createHash } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  fetchAllFranklinUniversityJobs,
  parseListingPage,
} from '../scripts/lib/franklin-university-job-parser.mjs';

// Issue #9679: the fus.edu careers page is ONE page of Drupal accordions. The
// parser used to publish every vacancy under that list URL, so the URL-keyed
// merge handed each new role the previous role's id and slug. Each leaf
// accordion carries a stable paragraph id, which is the per-vacancy deep link.

const mocks = vi.hoisted(() => ({ fetchHtml: vi.fn() }));

vi.mock('../scripts/lib/crawler-template.mjs', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../scripts/lib/crawler-template.mjs')>()),
  fetchHtml: mocks.fetchHtml,
}));

const CAREER_URL = 'https://www.fus.edu/about-franklin/job-opportunities';

function leaf(id: string | null, title: string, text: string) {
  const idAttr = id === null ? '' : ` id="${id}"`;
  return `<div class="paragraph paragraph--type--single-accordion paragraph--view-mode--default"${idAttr}>
    <div class="fus_para_accordion_title">${title}</div>
    <div class="fus_para_accordion_text">${text}</div>
  </div>`;
}

function page(...leaves: string[]) {
  return `<html><body>
    ${leaf('para_664', 'ACADEMIC POSITIONS', 'There are currently no open positions.')}
    <div class="paragraph paragraph--type--single-accordion" id="para_669">
      <div class="fus_para_accordion_title">ADMINISTRATIVE POSITIONS</div>
      <div class="fus_para_accordion_text">${leaves.join('\n')}</div>
    </div>
  </body></html>`;
}

const VP = leaf('para_4660', 'Vice President of Enrollment Management', 'Location: Sorengo, Switzerland. Full-time role leading admissions.');
const DIRECTOR = leaf('para_4700', 'Director of Marketing and Communications', 'Location: Lugano, Switzerland. Full-time role.');
const NO_ANCHOR = leaf(null, 'Registrar', 'Location: Sorengo, Switzerland. Part-time role.');

describe('Franklin University parser — per-vacancy detail URL (#9679)', () => {
  afterEach(() => mocks.fetchHtml.mockReset());

  it('derives a per-vacancy anchor URL instead of publishing the list page', async () => {
    const listings = parseListingPage(page(VP, DIRECTOR));
    expect(listings.map((l: { url: string }) => l.url)).toEqual([
      `${CAREER_URL}#para_4660`,
      `${CAREER_URL}#para_4700`,
    ]);
    // A clean parse stays a plain array (no loss property to compare against).
    expect(listings.missingDetailUrlCount).toBeUndefined();
  });

  it('drops a vacancy without an anchor and counts it, never falling back to the list URL', async () => {
    const listings = parseListingPage(page(VP, NO_ANCHOR));
    expect(listings.map((l: { title: string }) => l.title)).toEqual(['Vice President of Enrollment Management']);
    expect(listings.missingDetailUrlCount).toBe(1);
  });

  it('publishes distinct url/applyUrl per vacancy, unique ids, and reports the loss to the template', async () => {
    mocks.fetchHtml.mockResolvedValue(page(VP, DIRECTOR, NO_ANCHOR));
    vi.useFakeTimers();
    try {
      const pending = fetchAllFranklinUniversityJobs();
      await vi.runAllTimersAsync();
      const jobs = await pending;

      expect(jobs).toHaveLength(2);
      for (const job of jobs) {
        expect(job.url).not.toBe(CAREER_URL);
        expect(job.applyUrl).toBe(job.url);
      }
      expect(new Set(jobs.map((j: { url: string }) => j.url)).size).toBe(2);
      expect(new Set(jobs.map((j: { id: string }) => j.id)).size).toBe(2);
      // The crawler template reads this off the returned array and keeps the
      // existing slice once it exceeds MISSING_DETAIL_URL_MAX_RATIO.
      expect(jobs.missingDetailUrlCount).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps the id a function of the title, as before the anchor URL', async () => {
    mocks.fetchHtml.mockResolvedValue(page(DIRECTOR));
    vi.useFakeTimers();
    try {
      const pending = fetchAllFranklinUniversityJobs();
      await vi.runAllTimersAsync();
      const [job] = await pending;
      const expected = createHash('sha1')
        .update(`${CAREER_URL}#Director of Marketing and Communications`)
        .digest('hex')
        .slice(0, 12);
      // franklin-university-c41fb337efaa is the id published on 2026-07-08.
      expect(job.id).toBe(`franklin-university-${expected}`);
      expect(expected).toBe('c41fb337efaa');
    } finally {
      vi.useRealTimers();
    }
  });

  it('returns an empty result carrying the loss when no vacancy has an anchor', async () => {
    mocks.fetchHtml.mockResolvedValue(page(NO_ANCHOR));
    const jobs = await fetchAllFranklinUniversityJobs();
    expect(jobs).toHaveLength(0);
    expect(jobs.missingDetailUrlCount).toBe(1);
  });
});
