import { describe, expect, it, vi } from 'vitest';
import {
  ZAUGG_KEY,
  ZAUGG_COMPANY_NAME,
  ZAUGG_SOURCE_SPEC,
  extractZauggListingCards,
  fetchAllZauggJobs,
  isZauggJob,
  isZauggTargetRoleTitle,
  isTrustedDomain,
  parseZauggDetailPage,
  parseZauggSourceDate,
  sanitizeZauggDescription,
} from '../scripts/lib/zaugg-job-parser.mjs';
import { isAuthoritativeEmptySnapshot } from '../scripts/lib/authoritative-empty-snapshot.mjs';
import { getCompanyDefaults } from '../scripts/lib/crawler-location-config.mjs';
import {
  MIN_JOBS,
  meetsJobsFloor,
  renderProfessionBelowFloorBridge,
} from '../build-plugins/shared/professionJobsFloor';

const OFFICIAL_DETAIL_URL = 'https://www.zaugg.swiss/?section=2250&language=de_DE&itemid1541=3728&detail1541=1';
const OFFICIAL_LISTING_FIXTURE = `
  <div id="itemlistformod2076">
    <a href="/?section=2250&amp;language=de_DE&amp;itemid1541=3728&amp;detail1541=1"><img alt="" /></a>
    <a href="/?section=2250&amp;language=de_DE&amp;itemid1541=3728&amp;detail1541=1">
      <span itemprop="name">Schweisser:in Stahl/ALU/Inox</span>
    </a>
  </div>
`;
const SOURCE_BACKED_DETAIL_COPY = [
  'In Eggiwil fertigen Sie Schweisskonstruktionen aus Stahl, Aluminium und Inox nach den Zeichnungen des Arbeitgebers.',
  'Sie bereiten die Bauteile sorgfältig vor, kontrollieren Masse und Oberflächen und dokumentieren jeden Arbeitsschritt.',
  'Im Team stimmen Sie die Arbeitsplanung ab, halten Sicherheitsvorgaben ein und unterstützen die Montage bei Bedarf.',
  'Die Aufgabe verlangt eine zuverlässige Arbeitsweise, praktische Erfahrung und Freude an sauberer handwerklicher Qualität.',
  'Der offizielle Arbeitsplatz befindet sich in Eggiwil im Kanton Bern und bietet einen abwechslungsreichen Einsatz im Metallbau.',
].join(' ');

const zauggDetailFixture = ({
  canonicalUrl = OFFICIAL_DETAIL_URL,
  dateText = 'Montag 14 Jul 2025',
  includeDate = true,
} = {}) => `
  <!doctype html><html><head>${canonicalUrl
    ? `<meta property="og:url" content="${canonicalUrl}">`
    : ''}</head><body>
    <div class="am_1529"><span itemprop="name">Schweisser:in Stahl/ALU/Inox</span></div>
    ${includeDate ? `<div class="adate date"><span class="value">${dateText}</span></div>` : ''}
    <div class="amodule am_1532">${SOURCE_BACKED_DETAIL_COPY}</div>
  </body></html>
`;

describe('ZAUGG AG official-source crawler', () => {
  it('uses the official .swiss career page and its source-specific selectors', () => {
    expect(ZAUGG_SOURCE_SPEC).toMatchObject({
      companyKey: 'zaugg',
      companyName: 'ZAUGG AG',
      companyHost: 'zaugg.swiss',
      sourceType: 'official-employer-html',
      sourceLang: 'de',
      seedUrls: ['https://www.zaugg.swiss/stellen'],
      targetTitle: 'Schweisser:in Stahl/ALU/Inox',
    });
    expect(ZAUGG_SOURCE_SPEC.selectors).toMatchObject({
      listingContainer: '#itemlistformod2076',
      detailTitle: ".am_1529 [itemprop='name']",
      detailDescription: '.am_1532',
      postingDate: '.adate .value',
    });
    expect(getCompanyDefaults(ZAUGG_KEY)).toEqual({
      city: 'Eggiwil', canton: 'BE', postalCode: '3537', addressRegion: 'BE',
    });
    expect(ZAUGG_COMPANY_NAME).toBe('ZAUGG AG');
  });

  it('extracts the official query-string detail URL and exact source title', () => {
    const cards = extractZauggListingCards(OFFICIAL_LISTING_FIXTURE);
    expect(cards).toEqual([{
      title: 'Schweisser:in Stahl/ALU/Inox',
      url: OFFICIAL_DETAIL_URL,
      sourceId: '3728',
    }]);
    expect(isZauggTargetRoleTitle(cards[0].title)).toBe(true);
    expect(isZauggTargetRoleTitle('Servicetechniker:in Kundendienst')).toBe(false);
    expect(isZauggTargetRoleTitle('Schweisser:in Stahl/ALU')).toBe(false);
  });

  it('fails closed if the recognized listing container or job links disappear', () => {
    expect(() => extractZauggListingCards('<main>Karriere</main>'))
      .toThrow(/container was not found/u);
    expect(() => extractZauggListingCards('<div id="itemlistformod2076"></div>'))
      .toThrow(/no recognized detail links/u);
    expect(() => extractZauggListingCards(`
      <div id="itemlistformod2076">
        <a href="/?section=2250&amp;language=de_DE&amp;itemid1541=3728&amp;detail1541=1"><img alt="" /></a>
      </div>
    `)).toThrow(/no title-bearing link/u);
  });

  it('stamps an empty target snapshot only when the official list proves other open roles', async () => {
    const officialOtherRole = `
      <div id="itemlistformod2076">
        <a href="/?section=2250&amp;language=de_DE&amp;itemid1541=4046&amp;detail1541=1">
          <span itemprop="name">Konstrukteur:in / Mechanical Design Engineer</span>
        </a>
      </div>
    `;
    const fetchPage = vi.fn(async () => officialOtherRole);
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      const jobs = await fetchAllZauggJobs({ fetchPage });
      expect(jobs).toEqual([]);
      expect(isAuthoritativeEmptySnapshot(jobs)).toBe(true);
      expect(fetchPage).toHaveBeenCalledTimes(1);
    } finally {
      log.mockRestore();
    }
  });

  it('accepts only the official employer host, not .com or job marketplaces', () => {
    expect(isTrustedDomain(OFFICIAL_DETAIL_URL)).toBe(true);
    expect(isTrustedDomain('https://careers.zaugg.swiss/jobs/3728')).toBe(true);
    expect(isTrustedDomain('https://zaugg.com/jobs/3728')).toBe(false);
    expect(isTrustedDomain('https://jobs.ch/stellen/3728')).toBe(false);
    expect(isTrustedDomain('https://jobup.ch/jobs/3728')).toBe(false);
    expect(isTrustedDomain('https://zaugg.swiss.evil.example/jobs/3728')).toBe(false);
    expect(isZauggJob({ url: 'https://zaugg.swiss.evil.example/jobs/3728' })).toBe(false);
  });

  it('normalizes only the employer-reported publication date', () => {
    expect(parseZauggSourceDate('Montag 14 Jul 2025')).toEqual({
      datePosted: '2025-07-14',
      postedDate: '2025-07-14',
      postingDateSource: 'reported',
    });
    expect(parseZauggSourceDate('')).toMatchObject({
      datePosted: '', postedDate: '', postingDateSource: 'unknown',
    });
  });

  it('requires canonical vacancy identity and a valid source posting date', () => {
    expect(() => parseZauggDetailPage(
      zauggDetailFixture({ canonicalUrl: '' }),
      OFFICIAL_DETAIL_URL,
    )).toThrow(/og:url/u);

    const differentVacancyUrl = OFFICIAL_DETAIL_URL.replace('itemid1541=3728', 'itemid1541=4046');
    expect(() => parseZauggDetailPage(
      zauggDetailFixture({ canonicalUrl: differentVacancyUrl }),
      OFFICIAL_DETAIL_URL,
    )).toThrow(/different vacancy/u);

    expect(() => parseZauggDetailPage(
      zauggDetailFixture({ dateText: 'nicht verfügbar' }),
      OFFICIAL_DETAIL_URL,
    )).toThrow(/valid source-backed posting date/u);
    expect(() => parseZauggDetailPage(
      zauggDetailFixture({ includeDate: false }),
      OFFICIAL_DETAIL_URL,
    )).toThrow(/valid source-backed posting date/u);

    const parsed = parseZauggDetailPage(
      zauggDetailFixture(),
      OFFICIAL_DETAIL_URL,
    );
    expect(parsed.sourceDate).toEqual({
      datePosted: '2025-07-14',
      postedDate: '2025-07-14',
      postingDateSource: 'reported',
    });
  });

  it('removes contact PII from published copy without dropping role text', () => {
    const description = sanitizeZauggDescription(
      'Aufgaben in Eggiwil. Kontaktieren Sie uns unter metallbau@example.invalid. Arbeiten im Stahlbau bleiben beschrieben.',
    );
    expect(description).not.toMatch(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/iu);
    expect(description).toContain('Aufgaben in Eggiwil.');
    expect(description).toContain('Arbeiten im Stahlbau bleiben beschrieben.');
  });

  it('does not publish an incomplete detail page or weaken the shared floor', () => {
    const shortDetail = `
      <meta property="og:url" content="${OFFICIAL_DETAIL_URL}">
      <div class="am_1529"><span itemprop="name">Schweisser:in Stahl/ALU/Inox</span></div>
      <div class="adate date"><span class="value">Montag 14 Jul 2025</span></div>
      <div class="amodule am_1532">Eggiwil</div>
    `;
    expect(() => parseZauggDetailPage(shortDetail, OFFICIAL_DETAIL_URL))
      .toThrow(/shared 50-word source floor/u);

    expect(MIN_JOBS).toBe(3);
    expect(meetsJobsFloor({ liveCount: 1 }).meetsFloor).toBe(false);
    expect(renderProfessionBelowFloorBridge('de', 'BE', 'saldatore'))
      .toContain('<meta name="robots" content="noindex,follow">');
  });
});
