/**
 * Prospector — unit tests for the pieces that decide what gets crawled.
 *
 * These cover the judgements that are expensive to get wrong: what counts as
 * the same organisation, what counts as a platform, and what counts as a
 * vacancy. A defect in any of them does not fail loudly — it quietly files
 * thousands of wrong candidates or drops a whole vendor's tenant base.
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, expectTypeOf, it } from 'vitest';
import { registrableDomain, tenantLabel, sameOrg, normalizeHost, safeDecodePath } from '../scripts/lib/prospector/registrable.mjs';
import { parseRobots, robotsAllows } from '../scripts/lib/prospector/polite-fetch.mjs';
import {
  loadRegistry, observePlatform, isPlatformEligible, enumerablePlatforms,
  sharedHostPlatforms, listingPathHints,
} from '../scripts/lib/prospector/platform-registry.mjs';
import { pathTemplate, extractByTemplate, extractJsonLd, extractDetailFields, extractMicrodata, scoreVacancyPage, textOf, isVacancyPath } from '../scripts/lib/prospector/extract.mjs';
import { cleanAnchorText, extractLinks, isCareerLink, externalAtsLinks, isDistinctCareerSurface } from '../scripts/lib/prospector/careers-trail.mjs';
import { tenantSlugCandidates, tenantIdsAreNameLike, employerNameFromPage } from '../scripts/lib/prospector/tenant-enum.mjs';
import { normalizeCompanyName, isCovered } from '../scripts/lib/prospector/coverage.mjs';
import { isTransportLogistics } from '../scripts/lib/prospector/sector-signal.mjs';
import { domainGuesses, verifyOwnership } from '../scripts/lib/prospector/domain-resolve.mjs';
import { tokenOverlap, gradeExtraction, isReadableText } from '../scripts/lib/prospector/validate.mjs';
import { gradeJobLike, hasAnyJobSignal } from '../scripts/lib/job-like.mjs';
import { commonUrlTemplate, crawlerKeyFor, detectPageLang, isExpectedSynthesisError } from '../scripts/lib/prospector/synthesize.mjs';
import { evaluatePromotion, selectForPromotion, clampMinDays, findOpenPromotionPr, GATE_DEFAULTS } from '../scripts/lib/prospector/promotion-gate.mjs';
import { createSpecUrlPolicy, geographyFieldsForDecision, needsDetailEnrichment, templateToRegex } from '../scripts/lib/prospector/spec-crawler.mjs';
import {
  resolveDetailOrListingSwissGeography,
  resolveSourceBackedSwissGeography,
  schemaJobLocationCandidates,
} from '../scripts/lib/prospector/location-evidence.mjs';
import {
  COUNTRY_INVENTORY_VERSION,
  FOREIGN_COUNTRY_NAME_LABELS,
  ISO_ALPHA2_COUNTRY_CODES,
} from '../scripts/lib/prospector/country-inventory.mjs';
import {
  FOREIGN_SUBDIVISION_CODES,
  SUBDIVISION_INVENTORY_VERSION,
} from '../scripts/lib/prospector/subdivision-inventory.mjs';
import { constPrefix, pascalIdentifier } from '../scripts/lib/crawler-identifier.mjs';
import { fetchFollowingValidatedRedirects, fetchHtml } from '../scripts/lib/crawler-template.mjs';

const emptyRegistry = () => loadRegistry('/prospector/does-not-exist.json');

describe('registrable domains', () => {
  it('separates tenant from vendor', () => {
    expect(registrableDomain('cippatrasporti.altamiraweb.com')).toBe('altamiraweb.com');
    expect(tenantLabel('cippatrasporti.altamiraweb.com')).toBe('cippatrasporti');
    expect(tenantLabel('example.ch')).toBe('');
  });

  it('handles multi-label suffixes', () => {
    expect(registrableDomain('jobs.acme.co.uk')).toBe('acme.co.uk');
  });

  it('normalises www and ports', () => {
    expect(normalizeHost('https://WWW.Example.CH:8443/x')).toBe('example.ch');
  });

  it('treats one brand across TLDs as one organisation', () => {
    expect(sameOrg('acme.ch', 'www.acme.com')).toBe(true);
    // Short brands must NOT collapse, or unrelated employers merge.
    expect(sameOrg('abc.ch', 'abcdefg.com')).toBe(false);
    expect(sameOrg('cippatrasporti.ch', 'altamiraweb.com')).toBe(false);
  });
});

describe('decodifica dei path', () => {
  it('non lancia su un escape percentuale non valido', () => {
    // `decodeURIComponent` LANCIA su `%E9` (Latin-1), e i siti che il loop
    // visita ne sono pieni. In produzione un solo link cosi', su un solo
    // datore, ha ucciso l'intero stadio SYNTHESIZE.
    expect(() => safeDecodePath('https://x.ch/offre-d%E9taill%E9e/')).not.toThrow();
    expect(safeDecodePath('https://x.ch/offre-d%E9taill%E9e/')).toBe('/offre-d%E9taill%E9e/');
  });

  it('decodifica quando puo`', () => {
    expect(safeDecodePath('https://x.ch/lavora%20con%20noi')).toBe('/lavora con noi');
    expect(safeDecodePath('https://x.ch/lavora-con-noi/')).toBe('/lavora-con-noi/');
  });

  it('sopravvive a un input che non e` un URL', () => {
    expect(safeDecodePath('/annunci/%E9')).toBe('/annunci/%E9');
    expect(safeDecodePath('')).toBe('');
  });
});

describe('robots.txt', () => {
  it('lets a longer Allow beat a Disallow', () => {
    const r = parseRobots('User-agent: *\nDisallow: /private\nAllow: /private/jobs\n');
    expect(robotsAllows(r, '/private/secret')).toBe(false);
    expect(robotsAllows(r, '/private/jobs')).toBe(true);
    expect(robotsAllows(r, '/')).toBe(true);
  });

  it('ignores groups addressed to another agent', () => {
    const r = parseRobots('User-agent: SomeOtherBot\nDisallow: /\n');
    expect(robotsAllows(r, '/anything')).toBe(true);
  });
});

describe('platform registry', () => {
  it('rejects social, CDN and aggregator hosts', () => {
    expect(isPlatformEligible('facebook.com')).toBe(false);
    expect(isPlatformEligible('jobs.ch')).toBe(false);
    expect(isPlatformEligible('itunes.apple.com')).toBe(false);
    expect(isPlatformEligible('cippatrasporti.altamiraweb.com')).toBe(true);
  });

  it('needs two unrelated employers before confirming a vendor', () => {
    const r = emptyRegistry();
    const first = observePlatform(r, { tenantHost: 'a.vendor.example', employerDomain: 'alpha.ch' });
    expect(first.platform?.status).toBe('candidate');
    const second = observePlatform(r, { tenantHost: 'b.vendor.example', employerDomain: 'beta.ch' });
    expect(second.platform?.status).toBe('confirmed');
  });

  it('never lets an employer confirm its own domain as a platform', () => {
    const r = emptyRegistry();
    const res = observePlatform(r, { tenantHost: 'jobs.acme.ch', employerDomain: 'acme.ch' });
    expect(res.platform).toBeNull();
  });

  it('tells a per-tenant subdomain vendor from a shared host', () => {
    const r = emptyRegistry();
    observePlatform(r, { tenantHost: 'alpha.ats.example', employerDomain: 'alpha.ch' });
    observePlatform(r, { tenantHost: 'beta.ats.example', employerDomain: 'beta.ch' });
    expect(r.platforms['ats.example'].tenantShape).toBe('subdomain');

    observePlatform(r, { tenantHost: 'apply.board.example', employerDomain: 'gamma.ch' });
    observePlatform(r, { tenantHost: 'apply.board.example', employerDomain: 'delta.ch' });
    expect(r.platforms['board.example'].tenantShape).toBe('shared');

    expect(enumerablePlatforms(r).map((p) => p.domain)).toContain('ats.example');
    expect(enumerablePlatforms(r).map((p) => p.domain)).not.toContain('board.example');
    expect(sharedHostPlatforms(r).map((p) => p.domain)).toContain('board.example');
  });

  it('learns a listing path only when several employers share it', () => {
    const r = emptyRegistry();
    observePlatform(r, { tenantHost: 'a.ats.example', employerDomain: 'alpha.ch', path: '/Vacancies/1/Description' });
    observePlatform(r, { tenantHost: 'b.ats.example', employerDomain: 'beta.ch', path: '/Vacancies/2/Description' });
    expect(listingPathHints(r.platforms['ats.example'])).toContain('/Vacancies');

    // Tenant-in-path vendors give a different segment per employer: nothing to probe.
    const r2 = emptyRegistry();
    observePlatform(r2, { tenantHost: 'live.shared.example', employerDomain: 'alpha.ch', path: '/alpha/jobs' });
    observePlatform(r2, { tenantHost: 'live.shared.example', employerDomain: 'beta.ch', path: '/beta/jobs' });
    expect(listingPathHints(r2.platforms['shared.example'])).toEqual([]);
  });
});

describe('vacancy extraction', () => {
  it('keeps the detail location and the full rendered description', () => {
    const html = `<script type="application/ld+json">{"@type":"JobPosting","title":"Polymechaniker/in","description":"Teaser","jobLocation":{"address":{"addressLocality":"Pfäffikon","addressRegion":"Zürich"}}}</script><div class="ff-detail__intro">Intro</div><h1>Polymechaniker/in</h1><div class="ff-detail__text"><h3>Tätigkeiten</h3><ul><li>Installation und Wartung</li><li>Service beim Kunden</li></ul></div><div class="ff-detail__information-grid"></div>`;
    const detail = extractDetailFields(html, 'https://fachkraft.ch/stellen/test/');
    expect(detail.location).toBe('Pfäffikon, Zürich');
    expect(detail.description).toContain('Installation und Wartung');
    expect(detail.description).toContain('Service beim Kunden');
    expect(detail.description.length).toBeGreaterThan('Teaser'.length);
  });

  it('extracts a full description from vendor-neutral job markup', () => {
    const html = `<h1>Warehouse Specialist</h1><div class="job-location">Winterthur</div><article class="vacancy-description"><p>We are looking for a reliable specialist.</p><ul><li>Coordinate inbound logistics</li><li>Work with the warehouse team</li></ul></article>`;
    const detail = extractDetailFields(html, 'https://example.ch/jobs/warehouse/');
    expect(detail.location).toBe('Winterthur');
    expect(detail.description).toContain('Coordinate inbound logistics');
    expect(detail.description).toContain('Work with the warehouse team');
  });

  // Regressione arsante.ch/gmo (#6372). Il markup microdata reale mette la
  // copia dentro un <p> nidificato, non come nodo di testo diretto del div
  // itemprop: `readItempropBody` deve leggere fino alla chiusura bilanciata
  // dell'elemento itemprop, non fermarsi al primo `<` incontrato.
  it('reads a microdata description wrapped in a nested tag', () => {
    const html = `<div itemscope itemtype="https://schema.org/JobPosting"><h2 itemprop="title">Assistant·e médical·e</h2><div class="pb-2" itemprop="description"> <p>Recherche assistant·e médical·e pour rejoindre notre équipe.</p> <a href="/emploi/assistant-e-medical-e-98" itemprop="url">Plus d'informations</a></div></div>`;
    const [job] = extractMicrodata(html, 'https://www.arsante.ch/emploi');
    expect(job.title).toBe('Assistant·e médical·e');
    expect(job.description).toContain('Recherche assistant·e médical·e pour rejoindre notre équipe.');
  });

  it('still reads a meta-style itemprop content attribute', () => {
    const html = `<div itemscope itemtype="https://schema.org/JobPosting"><span itemprop="title">Comptable</span><meta itemprop="datePosted" content="2026-08-01"></div>`;
    const [job] = extractMicrodata(html, 'https://example.ch/emploi');
    expect(job.title).toBe('Comptable');
    expect(job.postedDate).toBe('2026-08-01');
  });

  it('does not end a microdata start tag at > inside a quoted attribute', () => {
    const html = '<div data-label="A > B" itemscope itemtype="https://schema.org/JobPosting">' +
      '<meta data-label="A > B" itemprop="title" content="Quote-aware Engineer">' +
      '<div data-label="A > B" itemprop="jobLocation">' +
        '<meta data-label="A > B" itemprop="addressLocality" content="Zürich">' +
        '<meta itemprop="addressCountry" content="CH">' +
      '</div></div>';
    const [job] = extractMicrodata(html, 'https://x.example/job/quoted-angle');
    expect(job).toMatchObject({
      title: 'Quote-aware Engineer',
      location: 'Zürich',
      addressCountry: 'CH',
    });
  });

  it('recovers a valid JobPosting after an unterminated quoted tag', () => {
    const html = '<div data-label="unterminated><span>broken shell</span>' +
      '<article itemscope itemtype="https://schema.org/JobPosting">' +
      '<meta itemprop="title" content="Recovered Engineer">' +
      '<div itemprop="jobLocation"><meta itemprop="addressLocality" content="Zürich">' +
      '<meta itemprop="addressRegion" content="ZH"><meta itemprop="addressCountry" content="CH"></div>' +
      '</article>';
    expect(extractMicrodata(html, 'https://x.example/jobs')).toEqual([
      expect.objectContaining({ title: 'Recovered Engineer', location: 'Zürich, ZH' }),
    ]);
  });

  it('unifies JSON-LD and microdata detail evidence without losing a foreign negative', () => {
    const html = '<h1>Sales Executive</h1><script type="application/ld+json">' + JSON.stringify({
      '@type': 'JobPosting', title: 'Sales Executive', description: 'Teaser',
    }) + '</script>' +
      '<article itemscope itemtype="https://schema.org/JobPosting">' +
      '<meta itemprop="title" content="Sales Executive">' +
      '<div itemprop="jobLocation"><meta itemprop="addressLocality" content="Geneva">' +
      '<meta itemprop="addressRegion" content="NY"><meta itemprop="addressCountry" content="US"></div>' +
      '</article><div class="job-location">Geneva</div>';
    const detail = extractDetailFields(html, 'https://x.example/job/foreign');
    expect(detail.locationCandidates).toEqual([
      expect.objectContaining({ location: 'Geneva, NY', addressCountry: 'US', addressRegion: 'NY' }),
    ]);
    expect(resolveDetailOrListingSwissGeography(detail, { location: 'Geneva' })).toMatchObject({
      geography: null,
      explicitlyForeign: true,
    });
  });

  it('does not merge a Swiss recommended JobPosting into the foreign current vacancy', () => {
    const pageUrl = 'https://x.example/job/primary';
    const html = `<h1>Primary Sales Role</h1><script type="application/ld+json">${JSON.stringify([
      {
        '@type': 'JobPosting', title: 'Primary Sales Role', url: pageUrl,
        jobLocation: { address: { addressLocality: 'Geneva', addressRegion: 'NY', addressCountry: 'US' } },
      },
      {
        '@type': 'JobPosting', title: 'Recommended Sales Role', url: 'https://x.example/job/recommended',
        jobLocation: { address: { addressLocality: 'Genève', addressRegion: 'GE', addressCountry: 'CH' } },
      },
    ])}</script>`;
    const detail = extractDetailFields(html, pageUrl);
    expect(detail.locationCandidates).toEqual([
      expect.objectContaining({ location: 'Geneva, NY', addressCountry: 'US' }),
    ]);
    expect(resolveDetailOrListingSwissGeography(detail, { location: 'Genève' })).toMatchObject({
      geography: null,
      explicitlyForeign: true,
    });
  });

  it('fails closed on sibling JobPosting records with no matching detail identity', () => {
    const html = `<h1>Careers</h1><script type="application/ld+json">${JSON.stringify([
      {
        '@type': 'JobPosting', title: 'First Role',
        jobLocation: { address: { addressLocality: 'Zürich', addressRegion: 'ZH', addressCountry: 'CH' } },
      },
      {
        '@type': 'JobPosting', title: 'Second Role',
        jobLocation: { address: { addressLocality: 'Genève', addressRegion: 'GE', addressCountry: 'CH' } },
      },
    ])}</script>`;
    const detail = extractDetailFields(html, 'https://x.example/careers');
    expect(detail.locationCandidates).toEqual([]);
    expect(resolveDetailOrListingSwissGeography(detail, {})).toMatchObject({ geography: null });
  });

  it('fails closed on same-title URL-less JSON-LD siblings', () => {
    const html = `<h1>Sales Engineer</h1><script type="application/ld+json">${JSON.stringify([
      {
        '@type': 'JobPosting', title: 'Sales Engineer',
        jobLocation: { address: { addressLocality: 'Zürich', addressRegion: 'ZH', addressCountry: 'CH' } },
      },
      {
        '@type': 'JobPosting', title: 'Sales Engineer',
        jobLocation: { address: { addressLocality: 'Genève', addressRegion: 'GE', addressCountry: 'CH' } },
      },
    ])}</script>`;
    const detail = extractDetailFields(html, 'https://x.example/job/current');
    expect(detail.locationCandidates).toEqual([]);
    expect(resolveDetailOrListingSwissGeography(detail, {})).toMatchObject({ geography: null });
  });

  it('resolves relative structured URLs before selecting the current JobPosting', () => {
    const pageUrl = 'https://x.example/job/current';
    const html = `<h1>Careers</h1><script type="application/ld+json">${JSON.stringify([
      {
        '@type': 'JobPosting', title: 'Current Role', url: '/job/current',
        jobLocation: { address: { addressLocality: 'Zürich', addressRegion: 'ZH', addressCountry: 'CH' } },
      },
      {
        '@type': 'JobPosting', title: 'Other Role', url: '/job/other',
        jobLocation: { address: { addressLocality: 'Genève', addressRegion: 'GE', addressCountry: 'CH' } },
      },
    ])}</script>`;
    const detail = extractDetailFields(html, pageUrl);
    expect(detail.locationCandidates).toEqual([
      expect.objectContaining({ location: 'Zürich, ZH', addressCountry: 'CH' }),
    ]);
  });

  it('gives an exact structured URL precedence over a URL-less title match', () => {
    const pageUrl = 'https://x.example/job/current';
    const html = `<h1>Rendered Recommended Role</h1><script type="application/ld+json">${JSON.stringify([
      {
        '@type': 'JobPosting', title: 'Canonical Current Role', url: pageUrl,
        jobLocation: { address: { addressLocality: 'Zürich', addressRegion: 'ZH', addressCountry: 'CH' } },
      },
      {
        '@type': 'JobPosting', title: 'Rendered Recommended Role',
        jobLocation: { address: { addressLocality: 'Geneva', addressRegion: 'NY', addressCountry: 'US' } },
      },
    ])}</script>`;
    const detail = extractDetailFields(html, pageUrl);
    expect(detail.locationCandidates).toEqual([
      expect.objectContaining({ location: 'Zürich, ZH', addressCountry: 'CH' }),
    ]);
    expect(detail.authoritativeLocationConflict).toBe(false);
  });

  it('keeps complementary current-job microdata and fails closed on cross-format conflict', () => {
    const pageUrl = 'https://x.example/job/current';
    const html = `<h1>Current Engineer</h1><script type="application/ld+json">${JSON.stringify({
      '@type': 'JobPosting', title: 'Current Engineer', url: pageUrl,
      jobLocation: { address: { addressLocality: 'Zürich', addressRegion: 'ZH', addressCountry: 'CH' } },
    })}</script>` +
      '<article itemscope itemtype="https://schema.org/JobPosting">' +
      '<meta itemprop="title" content="Current Engineer">' +
      '<div itemprop="jobLocation"><meta itemprop="addressLocality" content="Geneva">' +
      '<meta itemprop="addressRegion" content="NY"><meta itemprop="addressCountry" content="US"></div>' +
      '</article>';
    const detail = extractDetailFields(html, pageUrl);
    expect(detail.locationCandidates).toHaveLength(2);
    expect(detail.authoritativeLocationConflict).toBe(true);
    expect(resolveDetailOrListingSwissGeography(detail, {})).toMatchObject({
      geography: null,
      explicitlyForeign: true,
    });
  });

  it('detects authoritative foreign subdivision evidence without addressCountry', () => {
    const pageUrl = 'https://x.example/job/current';
    const html = `<h1>Current Engineer</h1><script type="application/ld+json">${JSON.stringify({
      '@type': 'JobPosting', title: 'Current Engineer', url: pageUrl,
      jobLocation: { address: { addressLocality: 'Zürich', addressRegion: 'ZH', addressCountry: 'CH' } },
    })}</script>` +
      '<article itemscope itemtype="https://schema.org/JobPosting">' +
      '<meta itemprop="title" content="Current Engineer">' +
      '<div itemprop="jobLocation"><meta itemprop="addressLocality" content="Berlin">' +
      '<meta itemprop="addressRegion" content="Berlin"></div></article>';
    const detail = extractDetailFields(html, pageUrl);
    expect(detail.authoritativeLocationConflict).toBe(true);
    expect(resolveDetailOrListingSwissGeography(detail, {})).toMatchObject({
      geography: null,
      explicitlyForeign: true,
    });
  });

  it('propagates authoritative microdata country evidence', () => {
    const html = '<div itemscope itemtype="https://schema.org/JobPosting">' +
      '<span itemprop="title">Network Engineer</span>' +
      '<span itemprop="addressLocality">Geneva</span>' +
      '<span itemprop="addressRegion">NY</span>' +
      '<meta itemprop="addressCountry" content="US"></div>';
    const [job] = extractMicrodata(html, 'https://x.example/job/2');
    expect(job).toMatchObject({ location: 'Geneva, NY', addressCountry: 'US' });
    expect(resolveDetailOrListingSwissGeography(job).geography).toBeNull();
  });

  it('keeps sibling microdata jobLocation containers independent', () => {
    const html = '<div itemscope itemtype="https://schema.org/JobPosting">' +
      '<span itemprop="title">Network Engineer</span>' +
      '<div itemprop="jobLocation" itemscope itemtype="https://schema.org/Place">' +
        '<span itemprop="addressLocality">Paris</span><meta itemprop="addressCountry" content="FR">' +
      '</div>' +
      '<div itemprop="jobLocation" itemscope itemtype="https://schema.org/Place">' +
        '<span itemprop="addressLocality">Zürich</span><span itemprop="addressRegion">ZH</span>' +
        '<meta itemprop="addressCountry" content="CH">' +
      '</div>' +
      '</div>';
    const [job] = extractMicrodata(html, 'https://x.example/job/3');
    expect(job.locationCandidates).toEqual([
      expect.objectContaining({ location: 'Paris', addressCountry: 'FR', addressLocality: 'Paris' }),
      expect.objectContaining({ location: 'Zürich, ZH', addressCountry: 'CH', addressLocality: 'Zürich', addressRegion: 'ZH' }),
    ]);
    expect(resolveDetailOrListingSwissGeography(job).geography).toMatchObject({
      location: 'Zürich, ZH', canton: 'ZH', addressCountry: 'CH',
    });
  });

  it('balances nested same-name microdata containers without crossing jobs', () => {
    const html = [
      '<article itemscope itemtype="https://schema.org/JobPosting">',
      '<div><div itemprop="title"><span>First nested role</span></div></div>',
      '<div itemprop="jobLocation"><div><span itemprop="addressLocality">Zürich</span></div></div>',
      '</article>',
      '<article itemscope itemtype="https://schema.org/JobPosting">',
      '<div><div itemprop="title"><span>Second nested role</span></div></div>',
      '<div itemprop="jobLocation"><div><span itemprop="addressLocality">Lausanne</span></div></div>',
      '</article>',
    ].join('');
    expect(extractMicrodata(html, 'https://x.example/jobs')).toEqual([
      expect.objectContaining({ title: 'First nested role', location: 'Zürich' }),
      expect.objectContaining({ title: 'Second nested role', location: 'Lausanne' }),
    ]);
  });

  it('indexes microdata in linear total input rather than rescanning the page per job', () => {
    const count = 160;
    const html = Array.from({ length: count }, (_, index) =>
      `<article data-label="A > B" itemscope itemtype="https://schema.org/JobPosting">`
      + `<div><div itemprop="title"><span>Role ${index}</span></div></div>`
      + '<div itemprop="jobLocation"><span itemprop="addressLocality">Zürich</span></div>'
      + '</article>').join('');
    const scans: Array<{sourceLength: number, tagCount: number}> = [];
    const jobs = extractMicrodata(html, 'https://x.example/jobs', {
      onIndex: (metrics) => scans.push(metrics),
    });
    expect(jobs).toHaveLength(count);
    expect(scans.length).toBeLessThanOrEqual((2 * count) + 1);
    expect(scans.reduce((sum, scan) => sum + scan.sourceLength, 0))
      .toBeLessThanOrEqual(html.length * 3);
  });

  it('collapses a slug+id path into a template', () => {
    expect(pathTemplate('/annunci-lavoro/Ocean-Freight-Specialist-662670289.htm')).toBe('/annunci-lavoro/*');
    expect(pathTemplate('/chi-siamo')).toBe('/chi-siamo');
  });

  it('reads a listing from link shape when there is no structured data', () => {
    const links = [
      { url: 'https://x.example/annunci-lavoro/Autista-Categoria-CE-111111.htm', text: 'Autista Categoria CE' },
      { url: 'https://x.example/annunci-lavoro/Magazziniere-Turni-222222.htm', text: 'Magazziniere Turni' },
      { url: 'https://x.example/chi-siamo', text: 'Chi siamo' },
    ];
    const out = extractByTemplate(links, 'https://x.example/');
    expect(out).toHaveLength(2);
    expect(out[0].via).toBe('template');
  });

  it('refuses a repeated template that is not vacancy-shaped', () => {
    const links = [
      { url: 'https://x.example/news/qualcosa-di-nuovo-111111', text: 'Qualcosa di nuovo' },
      { url: 'https://x.example/news/altra-notizia-222222', text: 'Altra notizia' },
    ];
    expect(extractByTemplate(links, 'https://x.example/')).toEqual([]);
  });

  it('prefers JSON-LD over anything inferred', () => {
    const html = `<script type="application/ld+json">${JSON.stringify({
      '@type': 'JobPosting',
      title: 'Autista CE',
      url: 'https://x.example/j/1',
      hiringOrganization: { name: 'Trasporti SA' },
      jobLocation: { address: { addressLocality: 'Chiasso' } },
      datePosted: '2026-08-01',
    })}</script>`;
    const [job] = extractJsonLd(html, 'https://x.example/');
    expect(job).toMatchObject({ title: 'Autista CE', company: 'Trasporti SA', location: 'Chiasso', via: 'jsonld' });
  });

  it('preserves country evidence and every JSON-LD job location', () => {
    const html = `<script type="application/ld+json">${JSON.stringify({
      '@type': 'JobPosting',
      title: 'Network Engineer',
      jobLocation: [
        { address: { addressLocality: 'Paris', addressCountry: 'FR' } },
        { address: { addressLocality: 'Zürich', addressRegion: 'ZH', addressCountry: 'CH' } },
      ],
    })}</script>`;
    const [job] = extractJsonLd(html, 'https://x.example/job/1');
    expect(job.locationCandidates).toEqual([
      expect.objectContaining({ location: 'Paris', addressCountry: 'FR', addressLocality: 'Paris' }),
      expect.objectContaining({ location: 'Zürich, ZH', addressCountry: 'CH', addressLocality: 'Zürich', addressRegion: 'ZH' }),
    ]);
    expect(resolveDetailOrListingSwissGeography(job).geography).toMatchObject({
      location: 'Zürich, ZH',
      canton: 'ZH',
      addressCountry: 'CH',
    });
  });

  it('preserves every address candidate inside one JSON-LD Place', () => {
    const html = `<script type="application/ld+json">${JSON.stringify({
      '@type': 'JobPosting',
      title: 'Platform Engineer',
      jobLocation: {
        '@type': 'Place',
        address: [
          { addressLocality: 'Paris', addressCountry: 'FR' },
          { addressLocality: 'Zürich', addressRegion: 'ZH', addressCountry: 'CH' },
        ],
      },
    })}</script>`;
    const [job] = extractJsonLd(html, 'https://x.example/job/address-array');
    expect(job.locationCandidates).toEqual([
      expect.objectContaining({ location: 'Paris', addressCountry: 'FR' }),
      expect.objectContaining({ location: 'Zürich, ZH', addressCountry: 'CH' }),
    ]);
    expect(resolveDetailOrListingSwissGeography(job).geography).toMatchObject({
      location: 'Zürich, ZH', canton: 'ZH', addressCountry: 'CH',
    });
  });

  it('recovers JSON-LD that a CMS entity-escaped', () => {
    const escaped = '<script type="application/ld+json">{&quot;@type&quot;:&quot;JobPosting&quot;,&quot;title&quot;:&quot;Autista CE&quot;}</script>';
    expect(extractJsonLd(escaped, 'https://x.example/')).toHaveLength(1);
  });

  it('scores a page with no vacancy signal at zero', () => {
    const { score } = scoreVacancyPage('<html><body><p>Certificazioni e qualita</p></body></html>', 'https://sgs.example/', []);
    expect(score).toBe(0);
  });

  it('strips scripts and styles from text', () => {
    expect(textOf('<style>a{}</style><script>var x=1</script><p>Ciao</p>')).toBe('Ciao');
  });

  // Regressione hotel-international (2026-08-24). `/it/jobs/` dell'albergo non
  // ha UN annuncio — dice che le candidature si mandano per posta a gennaio —
  // ma linka il carosello promozionale del sito, nove `/it/offerte/<slug>/`.
  // Con `offerte` fra i token forti quel cluster prendeva il bonus job-ish,
  // vinceva senza concorrenti e quattro offerte di camere sono finite in
  // produzione come annunci di lavoro.
  it('rifiuta il carosello promozionale di un albergo sulla sua pagina jobs', () => {
    const links = [
      { url: 'https://hotel.example/it/offerte/offerta-speciale-3-notti/', text: 'Offerta speciale 3 notti' },
      { url: 'https://hotel.example/it/offerte/prenota-senza-carta-di-credito/', text: 'Prenota SENZA carta di credito!' },
      { url: 'https://hotel.example/it/offerte/perche-prenotare-direttamente/', text: 'Perché prenotare direttamente' },
      { url: 'https://hotel.example/it/offerte/weekend-romantico/', text: 'Weekend romantico' },
    ];
    expect(extractByTemplate(links, 'https://hotel.example/it/jobs/')).toEqual([]);
  });

  it('riconosce ancora «offerte di lavoro», che e\' il senso legittimo del token', () => {
    const links = [
      { url: 'https://x.example/offerte-di-lavoro/autista-ce-111111/', text: 'Autista categoria CE' },
      { url: 'https://x.example/offerte-di-lavoro/magazziniere-222222/', text: 'Magazziniere turni' },
    ];
    expect(extractByTemplate(links, 'https://x.example/')).toHaveLength(2);
  });

  it('distingue i token forti da quelli che valgono solo accanto a una parola di lavoro', () => {
    expect(isVacancyPath('/it/annunci-lavoro/*')).toBe(true);
    expect(isVacancyPath('/de/offene-stellen/*')).toBe(true);
    expect(isVacancyPath('/fr/emploi/*')).toBe(true);
    // Ambigui da soli...
    expect(isVacancyPath('/it/offerte/*/')).toBe(false);
    expect(isVacancyPath('/it/posti/*/')).toBe(false);
    expect(isVacancyPath('/it/hotel-3-stelle/*/')).toBe(false);
    // ...ma non accanto a una parola di lavoro.
    expect(isVacancyPath('/it/offerte-lavoro/*/')).toBe(true);
    expect(isVacancyPath('/it/offerte-di-impiego/*/')).toBe(true);
    expect(isVacancyPath('/de/stellenangebote/*/')).toBe(true);
  });
});

describe('e\' davvero un annuncio di lavoro?', () => {
  // Estratto reale della pagina promo che il crawler pubblicava come "lavoro".
  const promoAlbergo = `Prenotare Garanzia del miglior prezzo Prenota qui e ricevi il Ticino-Ticket
    Offerta speciale 3 notti 3 Pernottamenti consecutivi scontati fino al 15% e incluso ricco buffet
    della prima colazione prenotabile solo qui sul nostro sito Internet Prenota ora - paga alla partenza
    Conferma immediata tramite e-mail Prenotazione sicura. da 240 CHF Doppia Classic con vista laterale
    aria condizionata WiFi gratuito Camere Giardino e piscina Check-in dalle 14:00
    scegli la tariffa che ti permette di prenotare senza dover inserire i dati della carta di credito`;

  // Annuncio vero di un albergo: porta lo STESSO chrome di sito (camere,
  // colazione, prenota) piu' cio' che una promo non ha mai.
  const annuncioAlbergo = `Prenota la tua camera Camere Colazione Piscina Wellness
    Receptionist 80-100% Le tue mansioni: accoglienza degli ospiti, gestione delle prenotazioni,
    check-in e check-out. Il tuo profilo: esperienza nel settore alberghiero, ottime conoscenze
    di italiano e tedesco. Ti offriamo: un contratto a tempo indeterminato, stipendio secondo il CCNL.
    Invia la tua candidatura con curriculum vitae all'ufficio del personale. Sede di lavoro: Lugano.`;

  const paginaAziendale = `Chi siamo La nostra storia dal 1906 Il nostro team Rassegna stampa
    Dove siamo Come raggiungerci Contatti Impressum Protezione dei dati`;

  it('boccia il contenuto promozionale', () => {
    const g = gradeJobLike(promoAlbergo);
    expect(g.jobLike).toBe(false);
    expect(g.notJobHits.length).toBeGreaterThan(g.jobHits.length);
  });

  it('promuove un annuncio vero anche quando porta il chrome di un sito alberghiero', () => {
    // Il punto della soglia a margine invece del veto su un vocabolario
    // proibito: in Ticino l'ospitalita' e' il settore, e una regola che
    // respinge «prenota»/«camere» cancellerebbe proprio i datori che il loop
    // esiste per trovare.
    const g = gradeJobLike(annuncioAlbergo);
    expect(g.jobLike).toBe(true);
    expect(g.jobHits.length).toBeGreaterThanOrEqual(2);
  });

  it('non scambia i benefit di un annuncio per vocabolario promozionale', () => {
    // Estratto reale dell'apprendistato Griesser: `Sprachaufenthalte` e
    // «CHF 1000 Gutschein fuer einen Laptop» sono cio' che il datore OFFRE, non
    // cio' che vende. Con `aufenthalt` e `gutschein` fra i segnali contrari
    // questo annuncio vero veniva bocciato — una prima versione del vocabolario
    // lo faceva davvero.
    const apprendistato = `Lehrstelle Informatiker:in EFZ Plattformentwicklung (all genders) Aadorf 100%
      Deine Aufgaben: Entwicklung von Plattformen. Jetzt bewerben.
      Wir bieten: Kostenbeteiligung bei internationalen Sprachdiplomen, zusaetzlicher bezahlter
      Urlaub fuer Sprachaufenthalte, CHF 1000 Gutschein fuer einen Laptop fuer die Berufsfachschule.`;
    expect(gradeJobLike(apprendistato).jobLike).toBe(true);
  });

  it('tiene la percentuale nuda fuori dal veto, dentro il grado', () => {
    // «Aadorf 100%» e «50% di sconto» hanno la stessa forma. Nel grado il
    // margine la assorbe; in un veto — che UN gruppo decide da solo —
    // salverebbe la pagina commerciale che il chiamante deve scartare.
    expect(hasAnyJobSignal('approfitta del 50% di sconto sulla camera')).toBe(false);
    expect(gradeJobLike('Lehrstelle Aadorf 100% Deine Aufgaben Jetzt bewerben').jobLike).toBe(true);
  });

  it('boccia una pagina istituzionale senza segnale in nessuna direzione', () => {
    expect(gradeJobLike(paginaAziendale).jobLike).toBe(false);
  });

  it('il veto condiviso riconosce i token che shared-jobs-crawler gli ha ceduto', () => {
    // `isLikelyCommercialPromoContent` in `scripts/lib/shared-jobs-crawler.mjs`
    // scarta un record quando abbastanza vocabolario commerciale scatta E
    // nessun vocabolario di lavoro lo fa. Questi cinque token stavano nel suo
    // elenco locale e ora arrivano da qui: se smettessero di essere coperti, il
    // veto si restringerebbe e quel rilevatore butterebbe annunci veri.
    for (const t of ['responsibilities', 'requirements', 'requisiti', 'employment type', 'apply now']) {
      expect(hasAnyJobSignal(t)).toBe(true);
    }
    expect(hasAnyJobSignal('carrello spedizione shipping wishlist sneakers denim 5% off')).toBe(false);
  });

  it('non giudica byte che non sa leggere', () => {
    // Diversi datori pubblicano l'annuncio in PDF: letto come testo e' binario,
    // e bocciarlo sarebbe un difetto della misura, non un esito.
    expect(isReadableText('%PDF-1.7\n%âãÏÓ')).toBe(false);
    expect(isReadableText('<html><body>Offerte di lavoro</body></html>')).toBe(true);
  });
});

describe('careers trail', () => {
  it('collapses a doubled anchor label', () => {
    expect(cleanAnchorText('Ocean Freight &amp; Cargo Ocean Freight &amp; Cargo')).toBe('Ocean Freight & Cargo');
    expect(cleanAnchorText('Lavora con noi')).toBe('Lavora con noi');
  });

  it('finds a careers link that carries nested markup', () => {
    const html = '<a class="work" href="/it/azienda/lavora-con-noi/"><span>Lavora</span> con noi</a>';
    const [link] = extractLinks(html, 'https://acme.ch/');
    expect(isCareerLink(link)).toBe(true);
  });

  it('only accepts unlabelled third-party links in relaxed mode', () => {
    const links = [{ url: 'https://acme.ats.example/', text: '', host: 'acme.ats.example' }];
    expect(externalAtsLinks(links, 'acme.ch')).toEqual([]);
    expect(externalAtsLinks(links, 'acme.ch', { relaxed: true })).toHaveLength(1);
  });

  it('rejects semantic homepage aliases and global-chrome-only career signals', () => {
    const home = '<html><title>Hotel</title><body><nav><a href="/jobs">Jobs</a></nav><main>Benvenuti</main></body></html>';
    const alias = '<html data-path="/lavora-con-noi"><title>Hotel</title><body><nav><a href="/jobs">Jobs</a></nav><main>Benvenuti</main></body></html>';
    const generic = '<html><title>Hotel - contatti</title><body><nav><a href="/jobs">Jobs</a></nav><main>Contatti e orari</main></body></html>';
    expect(isDistinctCareerSurface(home, alias, 'https://hotel.example/lavora-con-noi')).toBe(false);
    expect(isDistinctCareerSurface(home, generic, 'https://hotel.example/lavora-con-noi')).toBe(false);
  });

  it('keeps a distinct careers page and its legitimate external ATS', () => {
    const home = '<html><title>Hotel</title><body><a href="https://partner.example/">Partner</a><main>Benvenuti</main></body></html>';
    const careers = '<html><title>Hotel careers</title><body><h1>Lavora con noi</h1><a href="https://partner.example/">Partner</a><a href="https://tenant.real-ats.example/openings"></a></body></html>';
    expect(isDistinctCareerSurface(home, careers, 'https://hotel.example/jobs')).toBe(true);

    const homeLinks = extractLinks(home, 'https://hotel.example/');
    const pageLinks = extractLinks(careers, 'https://hotel.example/jobs');
    expect(externalAtsLinks(pageLinks, 'hotel.example', { relaxed: true, globalLinks: homeLinks }))
      .toEqual([{ host: 'tenant.real-ats.example', url: 'https://tenant.real-ats.example/openings', text: '' }]);
  });

  it('resolves relative evidence against each document actual URL', () => {
    const home = '<html><title>Hotel</title><body><a href="jobs.html">Jobs</a><main>Benvenuti</main></body></html>';
    const careers = '<html><title>Hotel</title><body><a href="jobs.html">Jobs</a><main>Informazioni per il team</main></body></html>';
    expect(isDistinctCareerSurface(
      home,
      careers,
      'https://hotel.example/careers/index.html',
      'https://hotel.example/about/index.html',
    )).toBe(true);
  });
});

describe('tenant enumeration', () => {
  it('derives tenant ids from an employer name', () => {
    expect(tenantSlugCandidates('Cippà Trasporti SA')).toContain('cippatrasporti');
    expect(tenantSlugCandidates('Bio Recycling Sagl')).toContain('biorecycling');
  });

  it('refuses to probe names against an opaque tenant space', () => {
    expect(tenantIdsAreNameLike({ domain: 'umantis.com', hostHits: { 'recruitingapp-2761.umantis.com': 3 } })).toBe(false);
    expect(tenantIdsAreNameLike({ domain: 'softgarden.io', hostHits: { 'vaudoise.softgarden.io': 2 } })).toBe(true);
  });

  it('reads the employer name out of vendor furniture', () => {
    expect(employerNameFromPage('<title>Bewerberportal MPI AGE Stellen</title>', 'x.umantis.com')).toBe('MPI AGE');
    expect(employerNameFromPage('<title>Cipp&agrave; Trasporti S.A. | Lavora con noi</title>', 'y.example.com')).toBe('Cippà Trasporti S.A.');
    // Nothing identifying: fall back to the tenant id, never to "Jobs".
    expect(employerNameFromPage('<title>Offene Stellen</title>', 'recruitingapp-2731.umantis.com')).toBe('recruitingapp-2731');
  });

  it('finds a logo tag when its double-quoted class contains an apostrophe', () => {
    const html = `<title>Jobs</title><img class="marchio d'azienda logo" alt="L'Oréal Suisse">`;
    expect(employerNameFromPage(html, 'loreal.example.com')).toBe("L'Oréal Suisse");
  });
});

describe('coverage', () => {
  it('normalises away legal forms and geography', () => {
    expect(normalizeCompanyName('Artisa Group SA')).toBe('artisa');
    expect(normalizeCompanyName('AXA Svizzera')).toBe('axa');
  });

  it('matches a known crawler by key slug even when the name normalises short', () => {
    const coverage = { keys: new Set(['axa-svizzera']), names: new Set(), domains: new Set(), crawlerCount: 1 };
    expect(isCovered(coverage, { name: 'AXA Svizzera' })).toMatchObject({ covered: true, via: 'key-slug' });
  });

  it('does not claim an unknown employer', () => {
    const coverage = { keys: new Set(['artisa-group']), names: new Set(['artisa']), domains: new Set(), crawlerCount: 1 };
    expect(isCovered(coverage, { name: 'Polverini Spazzacamino Sagl' }).covered).toBe(false);
  });
});

describe('sector signal', () => {
  it('flags transport/logistics employer names across IT/DE/FR/EN', () => {
    expect(isTransportLogistics('Autotrasporti Rossi SA')).toBe(true);
    expect(isTransportLogistics('Spedizioni Ticino Sagl')).toBe(true);
    expect(isTransportLogistics('Muster Transport AG')).toBe(true);
    expect(isTransportLogistics('Logistik Schweiz GmbH')).toBe(true);
    expect(isTransportLogistics('Transports Léman Sàrl')).toBe(true);
    expect(isTransportLogistics('Acme Freight Forwarding Ltd')).toBe(true);
  });

  it('does not flag unrelated employer names', () => {
    expect(isTransportLogistics('Ristorante Centrale')).toBe(false);
    expect(isTransportLogistics('Studio Legale Bianchi')).toBe(false);
    expect(isTransportLogistics('')).toBe(false);
  });
});

describe('domain resolution', () => {
  it('never guesses a single generic token for a multi-word name', () => {
    const guesses = domainGuesses('CANTINA IL CAVALIERE SA');
    // `il` is a stopword, so the guess is built from the identifying tokens only.
    expect(guesses).toContain('cantinacavaliere.ch');
    expect(guesses).not.toContain('cantina.ch');
  });

  it('needs more than one weak signal to accept ownership', () => {
    const weak = verifyOwnership('<html><body>cantina di paese</body></html>', { name: 'Cantina Il Cavaliere SA', city: 'Contone', zip: '6594' });
    expect(weak.score).toBeLessThan(3);
    // Realistic length: verifyOwnership refuses to judge a page under 200
    // characters of text, because a holding page or an error stub would
    // otherwise "match" on a single token.
    const filler = 'Trasporti internazionali, logistica e magazzino. '.repeat(6);
    const strong = verifyOwnership(
      `<html><head><title>Cippà Trasporti SA</title></head><body>Cippà Trasporti SA, 6830 Chiasso, Svizzera. ${filler}</body></html>`,
      { name: 'Cippà Trasporti SA', city: 'Chiasso', zip: '6830' },
    );
    expect(strong.score).toBeGreaterThanOrEqual(3);
  });
});

describe('quality grading', () => {
  it('scores token overlap on words, not substrings', () => {
    expect(tokenOverlap('Ocean Freight Operations', 'Ocean Freight Operations Specialist | Acme')).toBe(1);
    expect(tokenOverlap('Ocean Freight Operations', 'Chi siamo contatti')).toBe(0);
  });

  it('refuses to grade on too small a sample', async () => {
    const report = await gradeExtraction({ companyKey: 'x' }, [], { sampleSize: 4 });
    expect(report.verdict).toBe('insufficient');
    expect(report.score).toBe(0);
  });

  it('flags a listing whose titles are all the same', async () => {
    const dup = Array.from({ length: 5 }, (_, i) => ({ title: 'Candidatura spontanea', url: `https://x.example/j/${i}` }));
    const report = await gradeExtraction({ companyKey: 'x' }, dup, { sampleSize: 0 });
    expect(report.distinctRate).toBeLessThan(0.6);
    expect(report.problems.join(' ')).toMatch(/titoli ripetuti/);
  });

  it('riporta jobLikeRate null quando non ha giudicato nessuna pagina', () => {
    // `null` = non misurato, mai "misurato e va bene": e' la distinzione su cui
    // poggia il gate.
    return gradeExtraction({ companyKey: 'x' }, [], { sampleSize: 0 }).then((report) => {
      expect(report.jobLikeRate).toBeNull();
    });
  });
});

describe('crawler synthesis', () => {
  it('keys a crawler off the tenant label', () => {
    expect(crawlerKeyFor({ tenantHost: 'cippatrasporti.altamiraweb.com' })).toBe('cippatrasporti');
  });

  it('finds the template shared by a listing', () => {
    expect(commonUrlTemplate([
      'https://x.example/annunci-lavoro/A-1.htm',
      'https://x.example/annunci-lavoro/B-2.htm',
    ])).toBe('/annunci-lavoro/*');
  });

  it('reads the page language', () => {
    expect(detectPageLang('<html lang="it"><body>x</body></html>')).toBe('it');
    expect(detectPageLang('<html><body>Wir suchen und bieten für die neue Stellen mit unsere Arbeit bei der das</body></html>')).toBe('de');
  });

  it('tells expected decode noise apart from a genuine programming bug', () => {
    expect(isExpectedSynthesisError(new URIError('URI malformed'))).toBe(true);
    expect(isExpectedSynthesisError(new TypeError('Cannot read properties of undefined'))).toBe(false);
    expect(isExpectedSynthesisError(new Error('boom'))).toBe(false);
  });
});

describe('promotion gate', () => {
  /** A candidate graded good on `days` distinct days. */
  const graded = (days, over = {}) => ({
    status: 'promoted',
    crawlerKey: 'acme',
    vacancyCount: 6,
    mode: 'template',
    detailEnrichment: true,
    qualityScore: 0.97,
    validationHistory: Array.from({ length: days }, (_, i) => ({
      at: `2026-08-${String(10 + i).padStart(2, '0')}T03:00:00Z`,
      verdict: 'good',
      score: 0.97,
      sampled: 4,
      reachableRate: 1,
      titleMatchRate: 1,
      contentfulRate: 1,
      locationSourceRate: 1,
      distinctRate: 1,
      jobLikeRate: 1,
      logoFound: true,
      vacancyCount: 6,
    })),
    ...over,
  });

  it('ships a candidate proven on two distinct days', () => {
    expect(evaluatePromotion(graded(2)).passed).toBe(true);
  });

  it('refuses a candidate proven only once, however good', () => {
    const res = evaluatePromotion(graded(1));
    expect(res.passed).toBe(false);
    expect(res.reasons.join(' ')).toMatch(/giorno/);
  });

  // Regressione hotel-international (2026-08-24): quattro offerte di camere
  // d'albergo promosse in produzione con reachable/titleMatch/contentful/
  // distinct tutti a 1.00. Nessuna delle quattro chiedeva se la pagina fosse
  // un annuncio di lavoro; questa quinta lo chiede.
  it('rifiuta un listing che estrae contenuto promozionale, per quanto coerente', () => {
    const promo = graded(2);
    promo.validationHistory.forEach((h) => { h.jobLikeRate = 0; h.score = 0.83; });
    const res = evaluatePromotion(promo);
    expect(res.passed).toBe(false);
    expect(res.checks.jobLike).toBe(false);
    expect(res.reasons.join(' ')).toMatch(/annuncio di lavoro/);
  });

  it('rifiuta un candidato la cui ultima validazione e\' anteriore al controllo semantico', () => {
    // Campo ASSENTE = mai misurato. Trattarlo come "passato" riaprirebbe
    // esattamente il buco: i candidati gia' in coda sono stati graduati dal
    // gate cieco, e la prossima validazione fornisce il dato.
    const legacy = graded(2);
    legacy.validationHistory.forEach((h) => { delete h.jobLikeRate; });
    const res = evaluatePromotion(legacy);
    expect(res.passed).toBe(false);
    expect(res.checks.jobLike).toBe(false);
    expect(res.reasons.join(' ')).toMatch(/nuova validazione/);
  });

  // Logo aziendale obbligatorio, stessa disciplina di jobLike: senza logo
  // verificabile il candidato pubblicherebbe pagine annuncio col badge generico
  // a iniziali colorate invece del brand del datore.
  it('rifiuta un candidato senza logo aziendale verificabile', () => {
    const noLogo = graded(2);
    noLogo.validationHistory.forEach((h) => { h.logoFound = false; });
    const res = evaluatePromotion(noLogo);
    expect(res.passed).toBe(false);
    expect(res.checks.logo).toBe(false);
    expect(res.reasons.join(' ')).toMatch(/logo/);
  });

  it('rifiuta un candidato la cui ultima validazione e\' anteriore al controllo del logo', () => {
    // Campo ASSENTE = mai misurato, stesso trattamento di jobLikeRate assente:
    // i candidati gia' in coda dal gate cieco restano bloccati finche' non
    // vengono ri-validati, la prossima validazione fornisce il dato.
    const legacy = graded(2);
    legacy.validationHistory.forEach((h) => { delete h.logoFound; });
    const res = evaluatePromotion(legacy);
    expect(res.passed).toBe(false);
    expect(res.checks.logo).toBe(false);
    expect(res.reasons.join(' ')).toMatch(/nuova validazione/);
  });

  it('rifiuta un template senza localita source-backed sull\'intero campione', () => {
    const missingLocation = graded(2);
    missingLocation.validationHistory.at(-1).locationSourceRate = 0.75;
    const res = evaluatePromotion(missingLocation);
    expect(res.passed).toBe(false);
    expect(res.checks.sourceBackedLocation).toBe(false);
    expect(res.reasons.join(' ')).toMatch(/source-backed/);
  });

  it('rifiuta un template legacy che non ha mai misurato la localita source-backed', () => {
    const legacy = graded(2);
    legacy.validationHistory.forEach((h) => { delete h.locationSourceRate; });
    const res = evaluatePromotion(legacy);
    expect(res.passed).toBe(false);
    expect(res.reasons.join(' ')).toMatch(/nuova validazione/);
  });

  it('applica la prova source-backed anche a JSON-LD e microdata', () => {
    const structured = graded(2, { mode: 'jsonld', detailEnrichment: false });
    structured.validationHistory.at(-1).locationSourceRate = 0;
    expect(evaluatePromotion(structured).checks.sourceBackedLocation).toBe(false);

    structured.validationHistory.at(-1).locationSourceRate = 1;
    expect(evaluatePromotion(structured).passed).toBe(true);
  });

  it('non punisce un datore che pubblica gli annunci in PDF', () => {
    // `null` = misurato, byte illeggibili. Diverso da assente.
    const pdf = graded(2);
    pdf.validationHistory.forEach((h) => { h.jobLikeRate = null; });
    expect(evaluatePromotion(pdf).checks.jobLike).toBe(true);
  });

  it('refuses two gradings that landed on the SAME day', () => {
    const sameDay = graded(2);
    sameDay.validationHistory[1].at = sameDay.validationHistory[0].at;
    expect(evaluatePromotion(sameDay).passed).toBe(false);
  });

  it('refuses a listing whose vacancies collapsed since the best run', () => {
    const collapsing = graded(2);
    collapsing.validationHistory[1].vacancyCount = 1; // 6 -> 1
    const res = evaluatePromotion(collapsing);
    expect(res.passed).toBe(false);
    expect(res.reasons.join(' ')).toMatch(/scesi/);
  });

  // `needSample` is computed from `latest` alone, so a candidate whose two good
  // days have wildly different vacancyCount is never re-checked against the
  // OLDER day's own numbers. The two directions of that gap have to be sane:
  // growing is not a defect, collapsing has to be caught by something.
  it('promotes a listing that grew sharply between its two good days (2 -> 30)', () => {
    const growing = graded(2, { vacancyCount: 30 });
    growing.validationHistory[0].vacancyCount = 2;
    growing.validationHistory[0].sampled = 2;
    growing.validationHistory[1].vacancyCount = 30;
    growing.validationHistory[1].sampled = 4;
    expect(evaluatePromotion(growing).passed).toBe(true);
  });

  it('refuses a listing that collapsed sharply between its two good days (30 -> 2), caught by retention not sampling', () => {
    const collapsing = graded(2, { vacancyCount: 2 });
    collapsing.validationHistory[0].vacancyCount = 30;
    collapsing.validationHistory[0].sampled = 4;
    collapsing.validationHistory[1].vacancyCount = 2;
    collapsing.validationHistory[1].sampled = 2;
    const res = evaluatePromotion(collapsing);
    expect(res.passed).toBe(false);
    // The latest day's own sample (2 of 2) is complete on its own terms —
    // it is the retention check, comparing against the day-1 peak, that blocks.
    expect(res.checks.sampled).toBe(true);
    expect(res.checks.retention).toBe(false);
    expect(res.reasons.join(' ')).toMatch(/scesi/);
  });

  it('promotes a two-vacancy micro-employer graded on both', () => {
    // Una soglia fissa a 3 pagine di dettaglio escluderebbe per sempre il
    // segmento per cui il loop esiste. Due su due e' copertura totale.
    const micro = graded(2, { vacancyCount: 2 });
    for (const h of micro.validationHistory) { h.vacancyCount = 2; h.sampled = 2; }
    expect(evaluatePromotion(micro).passed).toBe(true);
  });

  it('still demands a real sample from an employer with many vacancies', () => {
    const big = graded(2, { vacancyCount: 40 });
    for (const h of big.validationHistory) { h.vacancyCount = 40; h.sampled = 2; }
    const res = evaluatePromotion(big);
    expect(res.passed).toBe(false);
    expect(res.reasons.join(' ')).toMatch(/pagine di dettaglio/);
  });

  it('refuses a candidate already inside an open promotion PR', () => {
    // Il passaggio a `production` vive sul branch della PR, non su main. Senza
    // questo stato il giro successivo — che riparte da main fresco — lo
    // riscaffolderebbe, aprendo una seconda PR con gli stessi file.
    const inFlight = graded(2, { status: 'promoting', promotionPr: '6245' });
    const res = evaluatePromotion(inFlight);
    expect(res.passed).toBe(false);
    expect(res.reasons.join(' ')).toMatch(/gia' in promozione nella PR 6245/);
  });

  it('refuses an aggregator even when every number is perfect', () => {
    expect(evaluatePromotion(graded(2, { aggregator: true })).passed).toBe(false);
  });

  it('refuses a key that already exists in production', () => {
    const res = evaluatePromotion(graded(2), { existingKeys: new Set(['acme']) });
    expect(res.passed).toBe(false);
    expect(res.reasons.join(' ')).toMatch(/esiste gia/);
  });

  it('non lascia che la leva di verifica DISATTIVI il vincolo sui giorni', () => {
    // A 0 la condizione diventa `distinctDays >= 0`, sempre vera: il vincolo
    // sparisce mentre l'etichetta dice ancora «ridotto a 1 giorno». L'input
    // arriva da workflow_dispatch e non e' validato.
    expect(clampMinDays(0)).toBe(GATE_DEFAULTS.minDistinctDays);
    expect(clampMinDays(-3)).toBe(GATE_DEFAULTS.minDistinctDays);
    expect(clampMinDays('non-un-numero')).toBe(GATE_DEFAULTS.minDistinctDays);
    expect(clampMinDays(undefined)).toBe(GATE_DEFAULTS.minDistinctDays);
    // Il caso d'uso vero resta possibile.
    expect(clampMinDays(1)).toBe(1);
    expect(clampMinDays('1')).toBe(1);
  });

  it('con un giorno solo il gate si allenta, ma di quel tanto e basta', () => {
    const oneDay = graded(1);
    expect(evaluatePromotion(oneDay, {}, { minDistinctDays: 1, minRuns: 1 }).passed).toBe(true);
    // Le altre condizioni NON si allentano insieme.
    const oneDayBadTitles = graded(1);
    oneDayBadTitles.validationHistory[0].titleMatchRate = 0.3;
    expect(evaluatePromotion(oneDayBadTitles, {}, { minDistinctDays: 1, minRuns: 1 }).passed).toBe(false);
  });

  it('riconosce una PR di promozione gia` in volo', () => {
    // Due PR aperte rigenerano gli stessi 22 crawler-group-*.yml dalla stessa
    // base: conflitto garantito e nessuna delle due mergia piu'. Misurato su
    // #6292 e #6297, 25 file in comune, entrambe bloccate.
    const rows = [
      { number: 6300, headRefName: 'fix/issue-1', title: 'altro', author: { login: 'valerielinc-ops' } },
      {
        number: 6297, headRefName: 'prospector/promote-2026-08-23', createdAt: '2026-08-23T04:39:39Z', title: 'promuove 10',
        author: { login: 'app/frontaliere-automation' },
      },
    ];
    expect(findOpenPromotionPr(rows)?.number).toBe('6297');
    // La REST API grezza spelle lo stesso autore diversamente da `gh pr list --json`.
    expect(findOpenPromotionPr([
      { number: 6298, headRefName: 'prospector/promote-2026-08-24', title: 'promuove 3', author: { login: 'frontaliere-automation[bot]' } },
    ])?.number).toBe('6298');
  });

  it('non scambia una PR qualsiasi per una promozione', () => {
    expect(findOpenPromotionPr([{ number: 1, headRefName: 'fix/issue-9' }])).toBeNull();
    expect(findOpenPromotionPr([])).toBeNull();
    // Un branch che CONTIENE il prefisso ma non ci comincia non conta.
    expect(findOpenPromotionPr([{ number: 2, headRefName: 'wip/prospector/promote-x' }])).toBeNull();
  });

  it('ignora un branch con lo stesso prefisso ma aperto da qualcun altro', () => {
    // Un test manuale con lo stesso prefisso non deve bloccare il loop
    // indefinitamente, scambiato per una promozione reale (#6305 item 3).
    const rows = [
      { number: 6301, headRefName: 'prospector/promote-manual-test', title: 'test a mano', author: { login: 'valerielinc-ops' } },
    ];
    expect(findOpenPromotionPr(rows)).toBeNull();
  });

  it('caps how many ship in one run and reports the overflow', () => {
    const many = Array.from({ length: GATE_DEFAULTS.maxPerRun + 4 }, (_, i) => graded(2, { crawlerKey: `acme-${i}` }));
    const { promotable, capped } = selectForPromotion(many);
    expect(promotable).toHaveLength(GATE_DEFAULTS.maxPerRun);
    expect(capped).toBe(4);
  });

  it('ships the biggest inventory first', () => {
    const small = graded(2, { crawlerKey: 'small', vacancyCount: 2 });
    const big = graded(2, { crawlerKey: 'big', vacancyCount: 40 });
    expect(selectForPromotion([small, big]).promotable[0].crawlerKey).toBe('big');
  });
});

describe('production spec runtime', () => {
  it('arricchisce anche le spec template legacy prive del flag', () => {
    expect(needsDetailEnrichment({ mode: 'template', detailEnrichment: false } as any)).toBe(true);
    expect(needsDetailEnrichment({ mode: 'microdata', detailEnrichment: false } as any)).toBe(false);
  });

  it('accetta solo geografia svizzera estratta dalla sorgente', () => {
    expect(resolveSourceBackedSwissGeography('  Winterthur  ')).toEqual({ location: 'Winterthur', canton: 'ZH' });
    expect(resolveSourceBackedSwissGeography('Geneva, Switzerland; Paris, France')).toEqual({
      location: 'Geneva, Switzerland; Paris, France',
      canton: 'GE',
    });
    expect(resolveSourceBackedSwissGeography('Brügg BE, Bern, Switzerland')).toEqual({
      location: 'Brügg BE, Bern, Switzerland',
      canton: 'BE',
    });
    expect(resolveSourceBackedSwissGeography('Example Company AG, Zürich, Switzerland')).toEqual({
      location: 'Example Company AG, Zürich, Switzerland',
      canton: 'ZH',
    });
    for (const foreign of [
      'Singapore (SG)',
      'Tbilisi (GE)',
      'Geneva NY US',
      'Zurich ON CA',
      'Baden DE',
      'Brussels (BE)',
      'Athens (GR)',
      'Geneva ny us',
      'Baden, DE 76530',
      'de 76530 Baden',
    ]) expect(resolveSourceBackedSwissGeography(foreign), foreign).toBeNull();
    expect(resolveSourceBackedSwissGeography('Geneva, NY', 'US')).toBeNull();
    expect(resolveSourceBackedSwissGeography('Geneva NY', 'CH')).toBeNull();
    expect(resolveSourceBackedSwissGeography('Geneva GE', 'Switzerland (CH)')).toEqual({
      location: 'Geneva GE',
      canton: 'GE',
      addressCountry: 'Switzerland (CH)',
    });
    expect(resolveSourceBackedSwissGeography('Geneva GE CH')).toEqual({ location: 'Geneva GE CH', canton: 'GE' });
    expect(resolveSourceBackedSwissGeography('St. Gallen SG, CH')).toEqual({
      location: 'St. Gallen SG, CH',
      canton: 'SG',
    });
    for (const [location, canton] of [
      ['St. Gallen', 'SG'],
      ['St Gallen', 'SG'],
      ['St. Moritz', 'GR'],
      ['St. Gallen Switzerland', 'SG'],
      ['La Chaux-de-Fonds', 'NE'],
      ['Le Locle', 'NE'],
      ['La Tour-de-Peilz', 'VD'],
    ]) {
      expect(resolveSourceBackedSwissGeography(location), location).toMatchObject({ location, canton });
    }
    for (const [location, canton] of [
      ['Zürich HQ', 'ZH'],
      ['Zürich HO', 'ZH'],
      ['Lausanne EP', 'VD'],
    ]) {
      expect(resolveSourceBackedSwissGeography(location), location).toEqual({ location, canton });
    }
    expect(resolveSourceBackedSwissGeography('Brügg be')).toEqual({ location: 'Brügg be', canton: 'BE' });
    expect(resolveSourceBackedSwissGeography('Brügg be, Bern, Switzerland')).toEqual({
      location: 'Brügg be, Bern, Switzerland',
      canton: 'BE',
    });
    expect(resolveSourceBackedSwissGeography('Baden, ag 5400')).toEqual({ location: 'Baden, ag 5400', canton: 'AG' });
    for (const [location, canton] of [
      ['Buchs AG', 'AG'],
      ['Stein AG', 'AG'],
      ['Küsnacht ZH', 'ZH'],
    ]) {
      expect(resolveSourceBackedSwissGeography(location, 'CH'), location).toEqual({
        location,
        canton,
        addressCountry: 'CH',
      });
    }
    for (const [addressLocality, addressRegion] of [
      ['Buchs', 'AG'],
      ['Stein', 'AG'],
      ['Küsnacht', 'ZH'],
      ['Zürich', 'CH-ZH'],
    ]) {
      const locationCandidates = schemaJobLocationCandidates({
        address: { addressLocality, addressRegion, addressCountry: 'CH' },
      });
      expect(locationCandidates).toEqual([expect.objectContaining({
        location: `${addressLocality}, ${addressRegion}`,
        addressCountry: 'CH',
        addressLocality,
        addressRegion,
      })]);
      expect(resolveDetailOrListingSwissGeography({ locationCandidates }, {}).geography).toEqual({
        location: `${addressLocality}, ${addressRegion}`,
        canton: addressRegion.replace(/^CH-/, ''),
        addressCountry: 'CH',
      });
    }
    for (const punctuation of ['.', ':', '!', '?']) {
      expect(resolveSourceBackedSwissGeography(`Brügg be${punctuation}`)).toEqual({
        location: `Brügg be${punctuation}`,
        canton: 'BE',
      });
      expect(resolveSourceBackedSwissGeography(`Sika AG${punctuation}`)).toBeNull();
    }
    expect(resolveSourceBackedSwissGeography('Example Company ag, Zürich')).toEqual({
      location: 'Example Company ag, Zürich',
      canton: 'ZH',
    });
    for (const foreignSubdivision of [
      'Geneva NY',
      'Zurich ON',
      'Geneva Illinois',
      'Baden-Württemberg',
      'Geneva NY14456',
      'Zurich ON N0J1Z0',
      'Geneva Illinois60134',
      'Baden-Württemberg76530',
      'Geneva NSW2000',
      'Geneva HH20095',
      'Geneva NY 14456-6789',
      'Geneva New York 14456-6789',
    ]) expect(resolveSourceBackedSwissGeography(foreignSubdivision), foreignSubdivision).toBeNull();
    expect(resolveSourceBackedSwissGeography('Buchs')).toBeNull();
    expect(resolveSourceBackedSwissGeography('Reinach')).toBeNull();
    expect(resolveSourceBackedSwissGeography('Buchs, Switzerland')).toBeNull();
    expect(resolveSourceBackedSwissGeography('Reinach, Switzerland')).toBeNull();
    expect(resolveSourceBackedSwissGeography({
      location: 'Buchs', addressLocality: 'Buchs', addressRegion: 'Buchs', addressCountry: 'CH',
    })).toBeNull();
    expect(SUBDIVISION_INVENTORY_VERSION).toMatch(/^ISO-3166-2:/);
    expect([...`BW BY BE BB HB HH HE MV NI NW RP SL SN ST SH TH`.split(' ')].every(
      (code) => FOREIGN_SUBDIVISION_CODES.has(code),
    )).toBe(true);
    expect(resolveDetailOrListingSwissGeography(
      { locationCandidates: [{ location: 'Geneva, NY', addressCountry: 'US' }] },
      { location: 'Geneva' },
    )).toMatchObject({ geography: null, explicitlyForeign: true, candidate: { location: '', addressCountry: '' } });
    expect(resolveDetailOrListingSwissGeography(
      { location: 'Remote' },
      { location: 'Chiasso' },
    ).geography).toMatchObject({ location: 'Chiasso', canton: 'TI' });
    const typedDecision = resolveDetailOrListingSwissGeography(
      { locationCandidates: [{
        location: 'Pratteln, BL', addressCountry: 'CH', addressLocality: 'Pratteln',
        addressRegion: 'BL', postalCode: '4133', streetAddress: 'Grüssenweg 1',
      }] },
      {},
    );
    expectTypeOf(typedDecision.candidate).toMatchTypeOf<{
      location: string;
      addressCountry: string;
      addressLocality: string;
      addressRegion: string;
      postalCode: string;
      streetAddress: string;
    }>();
    expect(geographyFieldsForDecision(typedDecision)).toMatchObject({
      location: 'Pratteln, BL',
      canton: 'BL',
      addressLocality: 'Pratteln',
      addressRegion: 'BL',
      postalCode: '4133',
      streetAddress: 'Grüssenweg 1',
    });
    expect(resolveSourceBackedSwissGeography('')).toBeNull();
    expect(resolveSourceBackedSwissGeography('Paris')).toBeNull();
    expect(resolveSourceBackedSwissGeography('Aix-en-Provence, France')).toBeNull();
    expect(resolveSourceBackedSwissGeography('Mercure Aix en Provence Beaumanoir, Aix-en-Provence, France')).toBeNull();
    expect(resolveSourceBackedSwissGeography('Como')).toBeNull();
    expect(resolveSourceBackedSwissGeography('Varese')).toBeNull();
    expect(resolveSourceBackedSwissGeography('Evian')).toBeNull();
  });

  it('usa un inventario ISO versionato e respinge nomi paese terminali non-CH', () => {
    expect(COUNTRY_INVENTORY_VERSION).toMatch(/^ISO-3166-1:/);
    expect(ISO_ALPHA2_COUNTRY_CODES.size).toBe(249);
    expect(FOREIGN_COUNTRY_NAME_LABELS.size).toBeGreaterThan(700);
    for (const location of [
      'Zurich, Netherlands',
      'Geneva, Czech Republic',
      'Buchs, Liechtenstein',
      'Basel, Luxembourg',
      'Geneva, Hong Kong',
      'Santiago, Chile',
      'Swiss Employer, Geneva, Netherlands',
      'Zürich, Paesi Bassi',
      'Genève, République tchèque',
      'Lugano, Fürstentum Liechtenstein',
    ]) {
      expect(resolveSourceBackedSwissGeography(location), location).toBeNull();
    }
    for (const location of [
      'Zürich, Switzerland',
      'Genève, Suisse',
      'Lugano, Svizzera',
      'Chur, Schweiz',
      'Chur, Svizra',
    ]) {
      expect(resolveSourceBackedSwissGeography(location), location).not.toBeNull();
    }
  });

  it('enforces an exact public-origin policy before every spec fetch', async () => {
    const publicLookup = async () => [{ address: '93.184.216.34', family: 4 }];
    const policy = createSpecUrlPolicy(
      { seedUrls: ['https://jobs.example.com/list'] } as any,
      { lookupImpl: publicLookup as any },
    );
    await expect(policy('https://jobs.example.com/job/1')).resolves.toBe('https://jobs.example.com/job/1');
    await expect(policy('https://evil.example/job/1')).rejects.toThrow(/origin not allowed/);
    const credentialedUrl = ['https://user:pass', 'jobs.example.com/job/1'].join('@');
    await expect(policy(credentialedUrl)).rejects.toThrow(/credentials forbidden/);
    await expect(policy('file:///etc/passwd')).rejects.toThrow(/protocol/);

    const explicitCdnPolicy = createSpecUrlPolicy({
      seedUrls: ['https://jobs.example.com/list'],
      allowedDetailOrigins: ['https://cdn.example.com'],
    } as any, { lookupImpl: publicLookup as any });
    await expect(explicitCdnPolicy('https://cdn.example.com/job/1')).resolves.toBe('https://cdn.example.com/job/1');

    const nonPublicIpv4Cases = [
      ['0.0.0.0/8', '0.0.0.1'],
      ['10.0.0.0/8', '10.0.0.1'],
      ['100.64.0.0/10', '100.64.0.1'],
      ['127.0.0.0/8', '127.0.0.1'],
      ['169.254.0.0/16', '169.254.169.254'],
      ['172.16.0.0/12', '172.16.0.1'],
      ['192.0.0.0/24', '192.0.0.1'],
      ['192.0.2.0/24', '192.0.2.1'],
      ['192.88.99.0/24', '192.88.99.1'],
      ['192.168.0.0/16', '192.168.0.1'],
      ['198.18.0.0/15', '198.18.0.1'],
      ['198.51.100.0/24', '198.51.100.1'],
      ['203.0.113.0/24', '203.0.113.1'],
      ['224.0.0.0/4', '224.0.0.1'],
      ['240.0.0.0/4', '240.0.0.1'],
      ['240.0.0.0/4 broadcast', '255.255.255.255'],
    ];
    for (const [cidr, address] of nonPublicIpv4Cases) {
      const seed = `http://${address}/jobs`;
      const privatePolicy = createSpecUrlPolicy({ seedUrls: [seed] } as any, { lookupImpl: publicLookup as any });
      await expect(privatePolicy(seed), cidr).rejects.toThrow(/unsafe prospector URL host/);
    }
    for (const address of ['192.0.0.9', '192.0.0.10']) {
      const seed = `https://${address}/jobs`;
      const publicExceptionPolicy = createSpecUrlPolicy({ seedUrls: [seed] } as any, { lookupImpl: publicLookup as any });
      await expect(publicExceptionPolicy(seed), address).resolves.toBe(seed);
    }

    for (const [embeddedIpv4, address] of [
      ['127.0.0.1', '64:ff9b::7f00:1'],
      ['169.254.169.254', '64:ff9b::a9fe:a9fe'],
      ['10.0.0.1', '64:ff9b::a00:1'],
      ['192.0.2.1', '64:ff9b::c000:201'],
    ]) {
      const seed = `https://[${address}]/jobs`;
      const nat64Policy = createSpecUrlPolicy({ seedUrls: [seed] } as any, { lookupImpl: publicLookup as any });
      await expect(nat64Policy(seed), embeddedIpv4).rejects.toThrow(/unsafe prospector URL host/);
    }

    const nonPublicIpv6Cases = [
      ['::/128', '::'],
      ['::1/128', '::1'],
      ['::ffff:0:0/96', '::ffff:7f00:1'],
      ['64:ff9b:1::/48', '64:ff9b:1::1'],
      ['100::/64', '100::1'],
      ['100:0:0:1::/64', '100:0:0:1::1'],
      ['2001::/32 TEREDO', '2001::1'],
      ['2001:2::/48', '2001:2::1'],
      ['2001:10::/28 deprecated ORCHID', '2001:10::1'],
      ['2001::/23 unallocated gap', '2001:5::1'],
      ['2001::/23 unallocated gap', '2001:40::1'],
      ['2001::/23 unallocated gap', '2001:1ff::1'],
      ['2001:db8::/32', '2001:db8::1'],
      ['2002::/16 6to4', '2002::1'],
      ['3fff::/20', '3fff::1'],
      ['5f00::/16', '5f00::1'],
      ['fc00::/7', 'fc00::1'],
      ['fe80::/10', 'fe80::1'],
      ['ff00::/8', 'ff02::1'],
      ['deprecated site-local', 'fec0::1'],
      ['deprecated site-local upper edge', 'fedf::1'],
      ['unallocated top-level prefix', '4000::1'],
      ['unallocated top-level prefix', '8000::1'],
      ['legacy IPv4-compatible', '::7f00:1'],
      ['unallocated GUA gap', '2001:1000::1'],
      ['reserved GUA gap', '2b00::1'],
    ];
    for (const [cidr, address] of nonPublicIpv6Cases) {
      const seed = `http://[${address}]/jobs`;
      const privatePolicy = createSpecUrlPolicy({ seedUrls: [seed] } as any, { lookupImpl: publicLookup as any });
      await expect(privatePolicy(seed), cidr).rejects.toThrow(/unsafe prospector URL host/);
    }
    // The two common textual forms of IPv4-mapped IPv6 must stay equivalent.
    for (const seed of [
      'http://[::ffff:127.0.0.1]/jobs',
      'http://[::ffff:a9fe:a9fe]/jobs',
    ]) {
      const privatePolicy = createSpecUrlPolicy({ seedUrls: [seed] } as any, { lookupImpl: publicLookup as any });
      await expect(privatePolicy(seed), seed).rejects.toThrow(/unsafe prospector URL host/);
    }

    const publicIpv6Cases = [
      ['64:ff9b::/96 public 8.8.8.8', '64:ff9b::808:808'],
      ['64:ff9b::/96 public IANA exception 192.0.0.9', '64:ff9b::c000:9'],
      ['2001:1::1/128', '2001:1::1'],
      ['2001:1::2/128', '2001:1::2'],
      ['2001:1::3/128', '2001:1::3'],
      ['2001:3::/32', '2001:3::1'],
      ['2001:4:112::/48', '2001:4:112::1'],
      ['2001:20::/28', '2001:20::1'],
      ['2001:30::/28', '2001:30::1'],
      ['2620:4f:8000::/48', '2620:4f:8000::1'],
      ['allocated APNIC GUA', '2001:200::1'],
      ['allocated APNIC GUA upper block', '2001:b000::1'],
      ['allocated RIPE GUA', '2003::1'],
      ['allocated APNIC 2024 block', '2410::1'],
      ['allocated ARIN direct block', '2610::1'],
      ['allocated ARIN direct block', '2620::1'],
      ['allocated ARIN 2019 block', '2630::1'],
      ['allocated LACNIC GUA', '2800::1'],
      ['allocated RIPE 2019 block', '2a10::1'],
      ['allocated ARIN GUA', '2606:4700:4700::1111'],
      ['allocated RIPE GUA', '2a00:1450:4000::1'],
      ['allocated AFRINIC GUA', '2c0f:f248::1'],
    ];
    for (const [cidr, address] of publicIpv6Cases) {
      const seed = `https://[${address}]/jobs`;
      const publicSpecialPolicy = createSpecUrlPolicy({ seedUrls: [seed] } as any, { lookupImpl: publicLookup as any });
      await expect(publicSpecialPolicy(seed), cidr).resolves.toBe(seed);
    }
  });

  it('vincola al socket la risoluzione pubblica e non riusa un pre-check DNS vulnerabile al rebinding', async () => {
    const answers = [
      [{ address: '93.184.216.34', family: 4 }],
      [{ address: '10.0.0.7', family: 4 }],
    ];
    let calls = 0;
    const policy = createSpecUrlPolicy(
      { seedUrls: ['https://jobs.example.com/list'] } as any,
      { lookupImpl: (async () => answers[Math.min(calls++, answers.length - 1)]) as any },
    ) as any;
    // Structural URL validation performs no separately cached DNS pre-check.
    await expect(policy('https://jobs.example.com/job/1')).resolves.toBe('https://jobs.example.com/job/1');
    expect(calls).toBe(0);

    const connect = () => new Promise<{ address: string, family: number }>((resolve, reject) => {
      policy.connectionLookup('jobs.example.com', { family: 4 }, (error: Error | null, address: string, family: number) => {
        if (error) reject(error);
        else resolve({ address, family });
      });
    });
    await expect(connect()).resolves.toEqual({ address: '93.184.216.34', family: 4 });
    await expect(connect()).rejects.toThrow(/unsafe prospector DNS target/);
    expect(calls).toBe(2);
    expect(policy.dispatcher?.constructor?.name).toBe('Agent');
    await policy.dispatcher.close();

    const privateTargetUrl = 'http://jobs.example.test/list';
    const privateTargetPolicy = createSpecUrlPolicy(
      { seedUrls: [privateTargetUrl] } as any,
      { lookupImpl: (async () => [{ address: '127.0.0.1', family: 4 }]) as any },
    ) as any;
    try {
      await fetchFollowingValidatedRedirects(privateTargetUrl, {
        validateUrl: privateTargetPolicy,
        requestOptions: { dispatcher: privateTargetPolicy.dispatcher } as any,
      });
      throw new Error('expected the connection-time DNS guard to reject loopback');
    } catch (error: any) {
      expect(error?.cause?.message || error?.message).toMatch(/unsafe prospector DNS target/);
    } finally {
      await privateTargetPolicy.dispatcher.close();
    }
  });

  it('validates redirect and effective URLs without fetching a forbidden target', async () => {
    const policy = createSpecUrlPolicy(
      { seedUrls: ['https://jobs.example.com/list'] } as any,
      { lookupImpl: (async () => [{ address: '93.184.216.34', family: 4 }]) as any },
    );
    const fetched = [] as string[];
    const redirectingFetch = async (url: string) => {
      fetched.push(url);
      return {
        ok: false,
        status: 302,
        url,
        headers: { get: () => 'http://169.254.169.254/latest/meta-data' },
      } as any;
    };
    await expect(fetchFollowingValidatedRedirects('https://jobs.example.com/list', {
      fetchImpl: redirectingFetch as any,
      validateUrl: policy,
    })).rejects.toThrow(/origin not allowed|unsafe prospector URL host/);
    expect(fetched).toEqual(['https://jobs.example.com/list']);

    const forgedEffectiveFetch = async (url: string) => ({
      ok: true,
      status: 200,
      url: 'https://evil.example/job/1',
      headers: { get: () => null },
      text: async () => '<h1>Job</h1>',
    }) as any;
    await expect(fetchFollowingValidatedRedirects('https://jobs.example.com/list', {
      fetchImpl: forgedEffectiveFetch as any,
      validateUrl: policy,
    })).rejects.toThrow(/origin not allowed/);

    let observedDispatcher: unknown;
    const html = await fetchHtml('https://jobs.example.com/list', {
      fetchImpl: (async (url: string, options: any) => {
        observedDispatcher = options.dispatcher;
        return {
          ok: true,
          status: 200,
          url,
          headers: { get: () => null },
          text: async () => '<h1>Job</h1>',
        } as any;
      }) as any,
      validateRedirectUrl: policy,
      dispatcher: (policy as any).dispatcher,
    });
    expect(html).toBe('<h1>Job</h1>');
    expect(observedDispatcher).toBe((policy as any).dispatcher);
    await (policy as any).dispatcher.close();
  });

  it('non lascia fallback geografici nei parser prodotti dal prospector', () => {
    const parserDir = path.resolve(process.cwd(), 'scripts/lib');
    const parsers = fs.readdirSync(parserDir)
      .filter((name) => name.endsWith('-job-parser.mjs'))
      .map((name) => ({ name, source: fs.readFileSync(path.join(parserDir, name), 'utf8') }))
      .filter(({ source }) => source.includes('runSpecInProduction(spec)'));
    expect(parsers.length).toBeGreaterThan(0);
    for (const { name, source } of parsers) {
      expect(source, name).not.toMatch(/listing\.location\s*\|\|\s*['"]Lugano['"]/);
      expect(source, name).toContain('resolveSourceBackedSwissGeography(listing.location)');
      expect(source, name).toContain('listing.addressLocality');
      expect(source, name).toContain('listing.addressRegion');
      expect(source, name).toContain('listing.postalCode');
      expect(source, name).toContain('listing.streetAddress');
      expect(source, name).toContain('if (!descriptionText) continue;');
      expect(source, name).not.toMatch(/description(?:ByLocale)?:.*descriptionText\s*\|\|/);
    }
    const scaffold = fs.readFileSync(path.resolve(process.cwd(), 'scripts/scaffold-crawler.mjs'), 'utf8');
    expect(scaffold).toContain('listing.addressLocality');
    expect(scaffold).toContain('listing.streetAddress');
    expect(scaffold).toContain('if (!descriptionText) continue;');
  });

  it('non lascia fallback HQ nei sibling dedicati con sorgenti multi-localita', () => {
    const parserDir = path.resolve(process.cwd(), 'scripts/lib');
    const forbiddenByParser = {
      'givaudan-job-parser.mjs': ["raw.city || 'Vernier, Switzerland'", '|| `${HQ.city}, Switzerland`'],
      'hermes-job-parser.mjs': ["|| 'Genève'", "|| 'GE'"],
      'hilti-job-parser.mjs': ['location: location || HQ.addressLocality', 'inferredCanton || HQ.canton'],
      'ikea-job-parser.mjs': ['|| HQ_CANTON', '|| HQ_CITY'],
      'implenia-job-parser.mjs': ['|| HQ.city', '|| HQ.canton'],
      'mabetex-job-parser.mjs': ["listing.location || 'Lugano'", "getCompanyDefaults('mabetex')"],
      'proton-job-parser.mjs': ["listing.location || 'Geneva'", "|| 'TI'"],
      'sika-job-parser.mjs': ['|| `${HQ.city}, ${HQ.addressRegion}, Switzerland`', '|| HQ.canton'],
      'thermo-fisher-scientific-job-parser.mjs': ['raw?.city || HQ.city', '|| `${HQ.city}, Switzerland`'],
    };

    for (const [name, forbidden] of Object.entries(forbiddenByParser)) {
      const source = fs.readFileSync(path.join(parserDir, name), 'utf8');
      const resolverReferences = source.match(
        /resolve(?:SourceBacked|DetailOrListing)SwissGeography/g,
      )?.length || 0;
      expect(resolverReferences, name).toBeGreaterThanOrEqual(2);
      for (const fragment of forbidden) expect(source, `${name}: ${fragment}`).not.toContain(fragment);
    }
  });

  it('accepts only URLs the learned template matches', () => {
    const rx = templateToRegex('/annunci-lavoro/*');
    expect(rx.test('/annunci-lavoro/Autista-CE-111111.htm')).toBe(true);
    // Navigation and deeper paths are chrome, and unattended chrome becomes a
    // published fake vacancy.
    expect(rx.test('/chi-siamo')).toBe(false);
    expect(rx.test('/annunci-lavoro/a/b')).toBe(false);
  });

  it('honours a numeric placeholder', () => {
    expect(templateToRegex('/job/#').test('/job/12345')).toBe(true);
    expect(templateToRegex('/job/#').test('/job/about')).toBe(false);
  });
});

describe('classificazione degli errori di sintesi', () => {
  it('non riassorbe un errore qualsiasi col nome sovrascritto', () => {
    // Il duck-typing sul solo `.name` avrebbe fatto passare per «rumore
    // atteso» un errore di tutt'altra natura — cioe' esattamente il bug che la
    // distinzione vuole rendere visibile.
    const spoofed = { name: 'URIError', message: 'non sono un Error' };
    expect(isExpectedSynthesisError(spoofed)).toBe(false);
  });

  it('riconosce un URIError vero, anche ri-lanciato', () => {
    expect(isExpectedSynthesisError(new URIError('URI malformed'))).toBe(true);
    const rethrown = new Error('URI malformed');
    rethrown.name = 'URIError';
    expect(isExpectedSynthesisError(rethrown)).toBe(true);
  });

  it('non scambia un bug di programmazione per rumore', () => {
    expect(isExpectedSynthesisError(new TypeError('x is not a function'))).toBe(false);
    expect(isExpectedSynthesisError(new Error('boom'))).toBe(false);
    expect(isExpectedSynthesisError(null)).toBe(false);
  });
});

describe('identificatori del crawler generato', () => {
  it('non lascia un trattino dentro il nome di funzione', () => {
    // Il difetto: `replace(/-([a-z])/g, ...)` toglieva il trattino solo davanti
    // a una lettera MINUSCOLA, quindi `recruitingapp-2862` generava
    // `isRecruitingapp-2862Job` — non JavaScript. Nessun crawler scritto a mano
    // l'aveva colpito, perche' le loro chiavi non hanno cifre dopo un trattino;
    // le chiavi che arrivano dai tenant di un ATS ce l'hanno quasi sempre.
    expect(pascalIdentifier('recruitingapp-2862')).toBe('Recruitingapp2862');
    expect(`is${pascalIdentifier('recruitingapp-2862')}Job`).toMatch(/^[A-Za-z_$][A-Za-z0-9_$]*$/);
  });

  it('resta compatibile con le chiavi scritte a mano', () => {
    expect(pascalIdentifier('a-plus-plus-group')).toBe('APlusPlusGroup');
    expect(constPrefix('a-plus-plus-group')).toBe('A_PLUS_PLUS_GROUP');
  });

  it('non produce un identificatore che inizia con una cifra', () => {
    expect(pascalIdentifier('2862-tenant')).toBe('C2862Tenant');
    expect(pascalIdentifier('2862-tenant')).toMatch(/^[A-Za-z_$]/);
  });

  it('preferisce il nome dell`azienda quando il tenant id e` opaco', () => {
    // `recruitingapp-2862` non dice di chi e' il crawler, e finisce nei nomi
    // dei file, nel manifest e nei gruppi di workflow.
    expect(crawlerKeyFor({ tenantHost: 'recruitingapp-2862.umantis.com', name: 'Mammut eRecruiting' }))
      .toBe('mammut-erecruiting');
    // Un tenant leggibile resta la chiave migliore: e' stabile e unico.
    expect(crawlerKeyFor({ tenantHost: 'vaudoise.softgarden.io', name: 'Vaudoise Assurances' })).toBe('vaudoise');
  });
});
