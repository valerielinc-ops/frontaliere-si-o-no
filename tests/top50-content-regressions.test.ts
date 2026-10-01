import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { buildCompetitionSummary } from '../build-plugins/careerLandingsPlugin';
import { buildSectorHubSeo } from '../build-plugins/jobSectorLanding';
import { fuelObservation } from '../build-plugins/shared/fuelObservation';
import { hasMatchingArticleHeadline } from '../scripts/audit-h1-title-duplicates.mjs';
import { LEGACY_LUGANO_COMPETITION_REDIRECTS } from '../build-plugins/shared/legacyLuganoCompetitionRedirects';
import { resolveSearchConsoleCompatTarget } from '../build-plugins/searchConsoleCompat';
import { parseDetailPage, parseListingPage, buildJob, stripHtml } from '../scripts/lib/citta-di-lugano-job-parser.mjs';

const daysAgo = (days: number) => new Date(Date.now() - days * 86400000).toISOString();

describe('fuel collection provenance', () => {
  it('uses actual collection time rather than a newer generated page date', () => {
    const collected = daysAgo(4);
    expect(fuelObservation([{ updatedAt: collected, sp95PriceChf: 1.8 }], 'benzina', daysAgo(0)).collectedAt).toBe(collected);
  });
  it('never invents a diesel observation from the petrol price', () => {
    expect(fuelObservation([{ sp95PriceChf: 1.8 }], 'diesel')).toEqual({ collectedAt: null, count: 0, min: null, max: null });
    expect(fuelObservation([{ sp95PriceChf: 1.8, dieselPriceChf: 2 }], 'diesel').min).toBe(2);
  });
});

describe('editorial headline semantics', () => {
  const article = (headline = 'Titolo della notizia', type = 'NewsArticle', url = 'https://frontaliereticino.ch/articoli-frontaliere/notizia/') => `<link rel="canonical" href="https://frontaliereticino.ch/articoli-frontaliere/notizia/"><h1>Titolo della notizia</h1><script type="application/ld+json">${JSON.stringify({ '@type': type, headline, url })}</script>`;
  it('allows the own article headline, while retaining other duplicate checks', () => {
    expect(hasMatchingArticleHeadline(article(), 'Titolo della notizia')).toBe(true);
    expect(hasMatchingArticleHeadline(article('Altro titolo'), 'Titolo della notizia')).toBe(false);
    expect(hasMatchingArticleHeadline(article(undefined, 'WebPage'), 'Titolo della notizia')).toBe(false);
    expect(hasMatchingArticleHeadline(article(undefined, undefined, 'https://example.com/'), 'Titolo della notizia')).toBe(false);
    expect(hasMatchingArticleHeadline(article() + '<h1>Secondo titolo</h1>', 'Titolo della notizia')).toBe(false);
  });
  it('emits the original article H1 without the generic guide suffix', () => {
    const source = readFileSync(new URL('../packages/articles/engine/ogPagesPlugin.ts', import.meta.url), 'utf8');
    expect(source).toContain('isEvent ? differentiateH1FromTitle(localizedTitle, htmlPageTitle, articleLocale) : localizedTitle');
  });
});

describe('Lugano competition directory is not a job', () => {
  const title = 'Concorsi per posti di lavoro, concorsi per aziende e altri concorsi aperti dalla Citt&agrave;';
  it('decodes named entities and rejects generic source directory headings', () => {
    expect(stripHtml('Citt&agrave; di Lugano')).toBe('Città di Lugano');
    expect(parseDetailPage(`<h1>${title}</h1><p>Elenco dei concorsi</p>`)).toBeNull();
    expect(parseListingPage(`<li><strong>${title}</strong><a href="/directory.pdf">PDF</a></li>`)).toEqual([]);
    expect(buildJob({ title, url: 'https://www.lugano.ch/concorsi/' })).toBeNull();
    expect(buildJob({ title: 'Educatore della citt&agrave;', url: 'https://www.lugano.ch/educatore.pdf' })?.title).toBe('Educatore della città');
  });
  it('maps only the four known malformed directories to equivalent competition landings', () => {
    for (const [from, to] of Object.entries(LEGACY_LUGANO_COMPETITION_REDIRECTS)) {
      expect(resolveSearchConsoleCompatTarget(from)?.canonicalPath).toBe(to);
    }
  });
});


describe('job landing access promise', () => {
  it.each(['it', 'en', 'de', 'fr'] as const)('describes free sign-in before applying in %s', (locale) => {
    const copy = buildSectorHubSeo(locale, 'educatori', 4, new Date().getFullYear());
    expect(JSON.stringify(copy)).not.toMatch(/senza registrazione|no registration needed|keine Registrierung erforderlich|sans inscription/i);
    expect(copy.faq[2].answer).toMatch(/accesso gratuito|Free sign-in|kostenlose Anmeldung|connexion gratuite/i);
  });
});


describe('public competition snippet and source notices', () => {
  it.each(['it', 'en', 'de', 'fr'] as const)('uses source deadlines and reports missing ones in %s', (locale) => {
    const deadline = new Date(Date.now() + 86400000 * 7).toISOString().slice(0, 10);
    const snapshot = { liveCount: 2, fresh30Count: 2, medianSalaryChf: null, featured: [], topCities: ['Lugano'], topEmployers: [{ name: 'EOC', count: 2 }], competitionFetchedAt: daysAgo(2), competitionNotices: [{ title: 'Assistente', organization: 'Ente pubblico', deadline, url: 'https://www.lugano.ch/concorsi/' }] };
    const copy = buildCompetitionSummary(locale, snapshot);
    expect(copy.description).toContain('2');
    expect(copy.description).toContain('EOC');
    expect(copy.description).toContain(deadline);
    expect(copy.html).toContain(snapshot.competitionFetchedAt);
    expect(copy.html).toContain('https://www.lugano.ch/concorsi/');
    const missing = buildCompetitionSummary(locale, { ...snapshot, competitionNotices: [{ title: 'Assistente' }] });
    expect(missing.description).not.toMatch(/\d{4}-\d{2}-\d{2}/);
  });
});
