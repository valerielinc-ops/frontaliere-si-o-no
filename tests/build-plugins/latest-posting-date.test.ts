import { afterEach, describe, expect, it, vi } from 'vitest';
import { JSDOM } from 'jsdom';
import { __renderOrphanLandingPage } from '../../build-plugins/orphanQueryLandingPlugin';
import {
  formatLatestPostingSentence,
  latestReportedPostingDay,
  renderLatestPostingKicker,
} from '../../build-plugins/shared/latestPostingDate';

const DAY = 86400000;
const locales = ['it', 'en', 'de', 'fr'] as const;
const ago = (days: number) => new Date(Date.now() - days * DAY).toISOString();
const generationLabel = /Pagina generata|Page generated|Seite erstellt|Page générée/;
const updatedLabel = /Aggiornato|Updated|Aktualisiert|Mis à jour/;

afterEach(() => vi.useRealTimers());

describe('latest reported posting day', () => {
  it('takes the most recent source-reported publication day only', () => {
    const newest = ago(3);
    const jobs = [
      { postingDateSource: 'reported', datePosted: ago(9) },
      { postingDateSource: 'reported', datePosted: newest },
      // A crawler observation or a first-seen fallback is not a publication date.
      { postingDateSource: 'unknown', datePosted: ago(1), crawledAt: ago(0) },
      { firstSeenAt: ago(0) },
    ];
    expect(latestReportedPostingDay(jobs)).toBe(newest.slice(0, 10));
  });

  it('prints no kicker, rather than a substitute date, when no job has one', () => {
    expect(latestReportedPostingDay([{ crawledAt: ago(1) }])).toBeNull();
    expect(renderLatestPostingKicker([{ crawledAt: ago(1) }], 'it', 'class="k"')).toBe('');
    expect(renderLatestPostingKicker([], 'it', 'class="k"')).toBe('');
  });

  it.each([
    ['it', '2026-10-29', 'Offerta più recente pubblicata il 29 ottobre 2026'],
    ['it', '2026-10-08', "Offerta più recente pubblicata l'8 ottobre 2026"],
    ['en', '2026-10-29', 'Most recent offer published on 29 October 2026'],
    ['de', '2026-10-29', 'Neuestes Angebot veröffentlicht am 29. Oktober 2026'],
    ['fr', '2026-10-29', 'Offre la plus récente publiée le 29 octobre 2026'],
  ] as const)('%s %s → %s', (locale, day, sentence) => {
    // A pure formatter on a past calendar day: no pipeline prunes it.
    expect(formatLatestPostingSentence(day, locale)).toBe(sentence);
  });

  it.each(locales)('%s kicker is byte-identical when only the build clock moves', (locale) => {
    const jobs = [{ postingDateSource: 'reported', datePosted: ago(12) }];
    const day = jobs[0].datePosted.slice(0, 10);
    vi.useFakeTimers({ toFake: ['Date'], now: new Date() });
    const first = renderLatestPostingKicker(jobs, locale, 'class="k"');
    vi.setSystemTime(new Date(Date.now() + 3 * DAY));
    const later = renderLatestPostingKicker(jobs, locale, 'class="k"');
    expect(later).toBe(first);
    expect(first).toBe(`<p class="k"><time datetime="${day}">${formatLatestPostingSentence(day, locale)}</time></p>`);
  });
});

describe('orphan search landing kicker', () => {
  it.each(locales)('dates the hero from the listed offers, never from the build, in %s', (locale) => {
    const posted = ago(5);
    const page = __renderOrphanLandingPage({
      cluster: { clusterId: 'kicker', locale, canonicalQuery: 'infermiere Lugano', canonicalSlug: 'kicker', roleTokens: [], regionTokens: [], totalImpressions: 20, totalClicks: 0, queries: [] },
      matchingJobs: [{ title: 'Infermiere', company: 'Clinica Esempio SA', canton: 'TI', location: 'Lugano', postingDateSource: 'reported', datePosted: posted }],
      strings: {}, knownSlugsByLocale: new Map(),
    });
    const dom = new JSDOM(page.html);
    const header = dom.window.document.querySelector('main h1')?.closest('header');
    const time = header?.querySelector('time');
    expect(time?.getAttribute('datetime')).toBe(posted.slice(0, 10));
    expect(time?.textContent).toBe(formatLatestPostingSentence(posted.slice(0, 10), locale));
    expect(header?.textContent).not.toMatch(generationLabel);
    expect(header?.textContent).not.toMatch(updatedLabel);
    dom.window.close();
  });

  it('omits the kicker when no listed offer has a reported date', () => {
    const today = new Date().toISOString().slice(0, 10);
    const page = __renderOrphanLandingPage({
      cluster: { clusterId: 'kicker', locale: 'it', canonicalQuery: 'infermiere Lugano', canonicalSlug: 'kicker', roleTokens: [], regionTokens: [], totalImpressions: 20, totalClicks: 0, queries: [] },
      matchingJobs: [], strings: {}, knownSlugsByLocale: new Map(),
    });
    const dom = new JSDOM(page.html);
    const header = dom.window.document.querySelector('main h1')?.closest('header');
    expect(header?.querySelector('time')).toBeNull();
    expect(header?.textContent).not.toMatch(generationLabel);
    expect(page.html).not.toContain(today);
    dom.window.close();
  });
});
