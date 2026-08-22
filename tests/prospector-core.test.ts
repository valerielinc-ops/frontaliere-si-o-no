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
import { evaluatePromotion, selectForPromotion, clampMinDays, GATE_DEFAULTS } from '../scripts/lib/prospector/promotion-gate.mjs';
import { templateToRegex } from '../scripts/lib/prospector/spec-crawler.mjs';
import { constPrefix, pascalIdentifier } from '../scripts/lib/crawler-identifier.mjs';

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

describe('promotion gate', () => {
  /** A candidate graded good on `days` distinct days. */
  const graded = (days, over = {}) => ({
    status: 'promoted',
    crawlerKey: 'acme',
    vacancyCount: 6,
    qualityScore: 0.97,
    validationHistory: Array.from({ length: days }, (_, i) => ({
      at: `2026-08-${String(10 + i).padStart(2, '0')}T03:00:00Z`,
      verdict: 'good',
      score: 0.97,
      sampled: 4,
      reachableRate: 1,
      titleMatchRate: 1,
      contentfulRate: 1,
      distinctRate: 1,
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
