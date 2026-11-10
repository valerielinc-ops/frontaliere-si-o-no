/**
 * Observer: the publication date in static job HTML must not depend on the
 * build clock. A relative label ("Pubblicato 10 giorni fa") was false the day
 * after the build and changed the bytes of every job page and every listing
 * at every daily build — churn that the per-section shard push then paid for.
 *
 * The same job is rendered with two build clocks three days apart: the
 * date HTML (mobile action tile and listing card chip) must be byte-identical,
 * carry `<time datetime="YYYY-MM-DD">`, and contain no relative age.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

import { renderMobileActionBlock, type JobDetailJob } from '../../build-plugins/shared/jobDetailHtml';
import { renderJobCardHtml, type JobCardJob } from '../../build-plugins/shared/jobCardHtml';
import { formatPostedOnSentence, postingCalendarDay, renderPostedDateTime } from '../../build-plugins/shared/jobPostedDate';
import { findRelativePostedText } from '../helpers/relativePostedText';

const locales = ['it', 'en', 'de', 'fr'] as const;
const DAY = 86400000;
const esc = (s: string): string =>
  String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

function mobileBlock(job: JobDetailJob, locale: typeof locales[number], now: Date): string {
  return renderMobileActionBlock({
    job,
    locale,
    canonicalUrl: 'https://frontaliereticino.ch/example/',
    addressLocality: 'Zürich',
    salaryMin: NaN,
    salaryText: '',
    localeLabels: { applyNow: 'Apply', quickDetails: 'Details', location: 'Location', contract: 'Contract' },
    referralUrl: (raw: string) => raw,
    esc,
    now,
  });
}

function cardAt(job: JobCardJob, locale: typeof locales[number], now: Date): string {
  vi.useFakeTimers({ toFake: ['Date'], now });
  try {
    return renderJobCardHtml(job, { href: '/x/', locale });
  } finally {
    vi.useRealTimers();
  }
}

afterEach(() => vi.useRealTimers());

describe('static job posted date is independent of the build clock', () => {
  // Relative to now, as the fixture rule requires; old enough that the
  // separate 7-day "Nuovo" badge cannot flip between the two clocks.
  const posted = new Date(Date.now() - 20 * DAY).toISOString();
  const day = posted.slice(0, 10);
  const job = { postingDateSource: 'reported', postedDate: posted, datePosted: posted, url: 'https://example.com/apply', title: 'Carpentiere', company: 'Fachkraft CH GmbH', location: 'Zürich' } as const;

  it.each(locales)('%s mobile action tile is byte-identical at +3 days', (locale) => {
    const buildDay = new Date();
    const first = mobileBlock(job, locale, buildDay);
    const later = mobileBlock(job, locale, new Date(buildDay.getTime() + 3 * DAY));
    expect(later).toBe(first);
    expect(first).toContain(`<time datetime="${day}">`);
    expect(findRelativePostedText(first)).toBeNull();
  });

  it.each(locales)('%s listing card is byte-identical at +3 days', (locale) => {
    const buildDay = new Date();
    const first = cardAt(job, locale, buildDay);
    const later = cardAt(job, locale, new Date(buildDay.getTime() + 3 * DAY));
    expect(later).toBe(first);
    expect(first).toContain(`<time datetime="${day}">${formatPostedOnSentence(day, locale)}</time>`);
    expect(findRelativePostedText(first)).toBeNull();
  });
});

describe('localized absolute posted date', () => {
  // A pure formatter on a past calendar day: no pipeline prunes it.
  it.each([
    ['it', 'Pubblicato il 29 ottobre 2026'],
    ['en', 'Published on 29 October 2026'],
    ['de', 'Veröffentlicht am 29. Oktober 2026'],
    ['fr', 'Publié le 29 octobre 2026'],
  ] as const)('%s → %s', (locale, sentence) => {
    expect(formatPostedOnSentence('2026-10-29', locale)).toBe(sentence);
  });

  it('elides the Italian article before 1, 8 and 11', () => {
    expect(formatPostedOnSentence('2026-10-08', 'it')).toBe("Pubblicato l'8 ottobre 2026");
    expect(formatPostedOnSentence('2026-10-11', 'it')).toBe("Pubblicato l'11 ottobre 2026");
  });

  it('keeps the date part an ISO string names, whatever its offset', () => {
    expect(postingCalendarDay('2026-10-29T23:30:00+01:00')).toBe('2026-10-29');
    expect(postingCalendarDay('2026-10-29')).toBe('2026-10-29');
    expect(postingCalendarDay('2026-02-30')).toBeNull();
    expect(postingCalendarDay('not-a-date')).toBeNull();
    expect(postingCalendarDay('')).toBeNull();
  });

  it('rejects an ISO prefix followed by garbage instead of showing a false date', () => {
    for (const raw of ['2026-10-29Tgarbage', '2026-10-29T24:00:00Z', '2026-10-29 garbage', '2026-10-29T10:00:00+25:00']) {
      expect(postingCalendarDay(raw), raw).toBeNull();
      expect(renderPostedDateTime(raw, 'it', { sentence: true }), raw).toBe('');
    }
    expect(postingCalendarDay('2026-10-29T10:00:00.123456Z')).toBe('2026-10-29');
    expect(postingCalendarDay('2026-10-29T23:30:00+0100')).toBe('2026-10-29');
  });

  it('parses a legacy zoneless date in UTC, never in the build host zone', () => {
    const previous = process.env.TZ;
    try {
      for (const tz of ['UTC', 'Asia/Tokyo', 'America/Los_Angeles', 'Europe/Zurich']) {
        process.env.TZ = tz;
        expect(postingCalendarDay('2026/10/29 00:30'), tz).toBe('2026-10-29');
        expect(postingCalendarDay('October 29, 2026 23:59'), tz).toBe('2026-10-29');
        expect(postingCalendarDay('Thu, 29 Oct 2026 23:30:00 GMT'), tz).toBe('2026-10-29');
        expect(renderPostedDateTime('2026/10/29 00:30', 'en', { sentence: true }), tz)
          .toBe('<time datetime="2026-10-29">Published on 29 October 2026</time>');
      }
    } finally {
      if (previous === undefined) delete process.env.TZ; else process.env.TZ = previous;
    }
  });

  it('flags every relative wording the static HTML used to emit', () => {
    for (const text of ['10 giorni fa', '1 day ago', '3 days ago', 'vor 3 Tagen', 'vor 1 Tag', 'il y a 2 jours', 'Il y a 1 jour']) {
      expect(findRelativePostedText(`<dd>${text}</dd>`)).not.toBeNull();
    }
    expect(findRelativePostedText('<script>const s = "3 days ago";</script><p>negli ultimi 30 giorni</p>')).toBeNull();
  });
});
