import { describe, expect, it } from 'vitest';
import {
  selectGraceDescription,
  parseDeclaredJobTotal,
  reconcileGraceListings,
  classifyGraceProbe,
  isGraceJobDetailUrl,
} from '../scripts/lib/grace-job-parser.mjs';
import { assertExtractionComplete } from '../scripts/lib/extraction-completeness.mjs';

// Verbatim page text captured from www.hotelcareer.com on 2026-08-06 while
// diagnosing #5200. Kept literal on purpose: the bug was that a paraphrase
// ("this job is no longer available") does not substring-match what the site
// actually renders ("this job **ad** is no longer available").
const LIVE_TOMBSTONE_EN =
  'Report this job Grace La Margna St Moritz Sommelier (m/w) - be the master of bottles ' +
  'St. MoritzFixed-term / Seasonal contract07/15/2026 company profile ' +
  'Sorry, this job ad is no longer available. Use our search function or click on the jobs ' +
  'suggested on this page to find more suitable job offers. company profile Jobs: 1';

const LIVE_TOMBSTONE_DE =
  'Diesen Job melden Grace La Margna St Moritz Sommelier (m/w) - be the master of bottles ' +
  'St. MoritzZeit- / Saisonvertrag15.07.2026 Unternehmensprofil ' +
  'Diese Stellenanzeige ist leider nicht mehr verfügbar. Nutze unsere Suchfunktion oder klicke ' +
  'auf die vorgeschlagenen Jobs auf dieser Seite, um weitere passende Jobangebote zu finden.';

const LIVE_OPEN_JOB =
  'back to resultlist Report this job Grace La Margna St Moritz Restaurant Supervisor (m/w) ' +
  'St. MoritzFull Time08/03/2026 Start application company profile AddedSave About Grace La Margna. ' +
  // Present on live pages too — must never be read as a closed signal.
  "We don't currently have any suitable job offers for you. If this changes in the future, we will display them here.";

const DETAIL_URL =
  'https://www.hotelcareer.com/jobs/grace-la-margna-st-moritz-120155/sommelier-be-the-master-of-bottles-3694182';

describe('grace-job-parser', () => {
  it('prefers the rich jobDesigner container over the short meta teaser', () => {
    const description = selectGraceDescription({
      metaDesc: 'Looking for a job as Front Office Supervisor? Start your new career!',
      containerText: `WHO WE NEED We are looking for ambitious talents who will become the shapers of the new reborn legendary hotel in one of the most prestigious alpine resorts in the world.
        WHAT WILL YOU DO? Maintain highest standards of a 5* superior hotel reception, ensure outstanding customer care, be a role model for the team and create memorable guest experiences.
        YOUR PROFILE You have hospitality experience, lead with example, take ownership and enjoy working in a fast-paced luxury environment.`,
    });

    expect(description).toContain('WHO WE NEED');
    expect(description).toContain('WHAT WILL YOU DO?');
    expect(description.length).toBeGreaterThan(280);
    expect(description).not.toBe('Looking for a job as Front Office Supervisor? Start your new career!');
  });

  it('falls back to the meta description when no richer content exists', () => {
    const description = selectGraceDescription({
      metaDesc: 'Looking for a job as Concierge? Start your new career!',
      containerText: '',
      mainText: '',
      bodyText: '',
    });

    expect(description).toBe('Looking for a job as Concierge? Start your new career!');
  });
});

describe('grace listing completeness gate (#5200)', () => {
  it('reads the source-declared total out of the profile tab label', () => {
    // Verbatim tab text captured from the live page on 2026-08-06.
    expect(parseDeclaredJobTotal('Job offers (1)Jobs')).toBe(1);
    expect(parseDeclaredJobTotal('Job offers (14)')).toBe(14);
    expect(parseDeclaredJobTotal('Jobangebote (7)')).toBe(7);
    expect(parseDeclaredJobTotal('Job offers (0)')).toBe(0);
  });

  it('returns null when the counter is absent or unparseable', () => {
    expect(parseDeclaredJobTotal('')).toBeNull();
    expect(parseDeclaredJobTotal('Job offers')).toBeNull();
    expect(parseDeclaredJobTotal('Images & Video')).toBeNull();
  });

  // THE REGRESSION. Before the fix, `discoverListings()` rejected only a
  // literally empty result, so extracting 1 anchor when the source declares 14
  // exited 0 and wrote a 7% slice; nothing noticed until the shrink guard
  // rejected the write downstream.
  it('rejects a partial extraction instead of reporting success', () => {
    expect(() =>
      reconcileGraceListings({
        extracted: [{ title: 'Restaurant Supervisor (m/w)' }],
        declaredTotal: 14,
        declaredTotalRaw: 'Job offers (14)',
      }),
    ).toThrow(/incomplete extraction.*declares 14 item\(s\).*matched 1/s);
  });

  it('accepts an extraction that matches the declared total', () => {
    const result = reconcileGraceListings({
      extracted: [{ title: 'Restaurant Supervisor (m/w)' }],
      declaredTotal: 1,
      declaredTotalRaw: 'Job offers (1)',
    });
    expect(result).toEqual({ extractedCount: 1, declaredTotal: 1, verified: true });
  });

  // A verifier that cannot verify must not report green.
  it('refuses when the counter itself cannot be located', () => {
    expect(() =>
      reconcileGraceListings({ extracted: [{ title: 'a' }, { title: 'b' }], declaredTotal: null }),
    ).toThrow(/completeness unverifiable/);
  });

  it('names the escape hatch in the failure message', () => {
    expect(() => reconcileGraceListings({ extracted: [], declaredTotal: 14 })).toThrow(
      /JOBS_GRACE_SKIP_COUNT_CHECK=1/,
    );
  });

  it('honours the documented escape hatch without claiming verification', () => {
    const result = reconcileGraceListings({
      extracted: [{ title: 'a' }],
      declaredTotal: 14,
      skipCountCheck: true,
    });
    expect(result.verified).toBe(false);
    expect(result.extractedCount).toBe(1);
  });
});

describe('assertExtractionComplete (shared primitive, #5200)', () => {
  it('passes when extraction matches the declared total', () => {
    expect(assertExtractionComplete({ label: 'x', extractedCount: 14, declaredTotal: 14 })).toEqual({
      extractedCount: 14,
      declaredTotal: 14,
      verified: true,
    });
  });

  it('throws on under-extraction, the silent-partial-failure case', () => {
    expect(() => assertExtractionComplete({ label: 'x', extractedCount: 1, declaredTotal: 14 })).toThrow(
      /\[x\] incomplete extraction/,
    );
  });

  // Over-extraction is equally a selector bug (matching nav/related links).
  it('throws on over-extraction too', () => {
    expect(() => assertExtractionComplete({ label: 'x', extractedCount: 20, declaredTotal: 14 })).toThrow(
      /incomplete extraction/,
    );
  });

  it('treats a missing declared total as a failure, not a free pass', () => {
    expect(() => assertExtractionComplete({ label: 'x', extractedCount: 5 })).toThrow(
      /completeness unverifiable/,
    );
    expect(() =>
      assertExtractionComplete({ label: 'x', extractedCount: 5, declaredTotal: Number.NaN }),
    ).toThrow(/completeness unverifiable/);
  });

  it('allows a legitimate zero when the source declares zero', () => {
    expect(assertExtractionComplete({ label: 'x', extractedCount: 0, declaredTotal: 0 }).verified).toBe(true);
  });
});

describe('grace shrink-guard probe classification (#5200)', () => {
  it('recognises the real hotelcareer tombstone as definitive evidence', () => {
    const verdict = classifyGraceProbe({
      status: 200,
      finalUrl: DETAIL_URL,
      bodyText: LIVE_TOMBSTONE_EN,
      pageTitle: 'Job offer: Sommelier - be the master of bottles in St. Moritz',
    });
    expect(verdict.valid).toBe(false);
    expect(verdict.definitive).toBe(true);
    expect(verdict.reason).toContain('job ad is no longer available');
  });

  it('recognises the German tombstone (interposed "leider")', () => {
    const verdict = classifyGraceProbe({
      status: 200,
      finalUrl: DETAIL_URL.replace('.com', '.de'),
      bodyText: LIVE_TOMBSTONE_DE,
    });
    expect(verdict.valid).toBe(false);
    expect(verdict.definitive).toBe(true);
  });

  // hotelcareer bounces some expired ads to a role search page, NOT to the
  // company listing URL the old exact-match check looked for.
  it('treats a redirect off the job-detail URL shape as definitive', () => {
    const verdict = classifyGraceProbe({
      status: 200,
      finalUrl: 'https://www.hotelcareer.com/jobs/barkeeper-st-moritz',
      bodyText: 'Jobs and vacancies as Barkeeper in St. Moritz',
      pageTitle: 'Jobs and vacancies as Barkeeper in St. Moritz | Hotelcareer',
    });
    expect(verdict.valid).toBe(false);
    expect(verdict.definitive).toBe(true);
    expect(verdict.reason).toMatch(/^redirect-off-detail:/);
  });

  it('leaves a live job alone', () => {
    const verdict = classifyGraceProbe({
      status: 200,
      finalUrl:
        'https://www.hotelcareer.com/jobs/grace-la-margna-st-moritz-120155/restaurant-supervisor-m-w-4016125',
      bodyText: LIVE_OPEN_JOB,
      pageTitle: 'Job offer: Restaurant Supervisor in St. Moritz at Grace La Margna St Moritz',
    });
    expect(verdict.valid).toBe(true);
    expect(verdict.definitive).toBeUndefined();
  });

  it('still honours 404/410', () => {
    expect(classifyGraceProbe({ status: 404, finalUrl: DETAIL_URL })).toMatchObject({
      valid: false,
      definitive: true,
      reason: 'http-404',
    });
  });

  // Fail-open: a blocked probe can never masquerade as proof a job is gone.
  it('never treats an unresolved anti-bot challenge as evidence', () => {
    const verdict = classifyGraceProbe({
      status: 200,
      finalUrl: 'https://www.hotelcareer.com/lzjHXqtgM/_EONDI/6/challenge',
      bodyText: 'Challenge Validation processing your request',
      pageTitle: 'Challenge Validation',
    });
    expect(verdict.valid).toBe(true);
    expect(verdict.definitive).toBeUndefined();
    expect(verdict.reason).toBe('challenge-unresolved');
  });

  it('knows the hotelcareer job-detail URL shape', () => {
    expect(isGraceJobDetailUrl(DETAIL_URL)).toBe(true);
    expect(isGraceJobDetailUrl(DETAIL_URL + '?rltr=comp')).toBe(true);
    expect(isGraceJobDetailUrl('https://www.hotelcareer.com/jobs/grace-la-margna-st-moritz-120155')).toBe(false);
    expect(isGraceJobDetailUrl('https://www.hotelcareer.com/jobs/barkeeper-st-moritz')).toBe(false);
  });
});
