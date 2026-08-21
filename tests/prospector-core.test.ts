/**
 * Prospector — unit tests for the pieces that decide what gets crawled.
 *
 * These cover the judgements that are expensive to get wrong: what counts as
 * the same organisation, what counts as a platform, and what counts as a
 * vacancy. A defect in any of them does not fail loudly — it quietly files
 * thousands of wrong candidates or drops a whole vendor's tenant base.
 */
import { describe, expect, it } from 'vitest';
import { registrableDomain, tenantLabel, sameOrg, normalizeHost } from '../scripts/lib/prospector/registrable.mjs';
import { parseRobots, robotsAllows } from '../scripts/lib/prospector/polite-fetch.mjs';
import {
  loadRegistry, observePlatform, isPlatformEligible, enumerablePlatforms,
  sharedHostPlatforms, listingPathHints,
} from '../scripts/lib/prospector/platform-registry.mjs';
import { pathTemplate, extractByTemplate, extractJsonLd, scoreVacancyPage, textOf } from '../scripts/lib/prospector/extract.mjs';
import { cleanAnchorText, extractLinks, isCareerLink, externalAtsLinks } from '../scripts/lib/prospector/careers-trail.mjs';
import { tenantSlugCandidates, tenantIdsAreNameLike, employerNameFromPage } from '../scripts/lib/prospector/tenant-enum.mjs';
import { normalizeCompanyName, isCovered } from '../scripts/lib/prospector/coverage.mjs';
import { domainGuesses, verifyOwnership } from '../scripts/lib/prospector/domain-resolve.mjs';
import { tokenOverlap, gradeExtraction } from '../scripts/lib/prospector/validate.mjs';
import { commonUrlTemplate, crawlerKeyFor, detectPageLang } from '../scripts/lib/prospector/synthesize.mjs';

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

  it('scores a page with no vacancy signal at zero', () => {
    const { score } = scoreVacancyPage('<html><body><p>Certificazioni e qualita</p></body></html>', 'https://sgs.example/', []);
    expect(score).toBe(0);
  });

  it('strips scripts and styles from text', () => {
    expect(textOf('<style>a{}</style><script>var x=1</script><p>Ciao</p>')).toBe('Ciao');
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
});
