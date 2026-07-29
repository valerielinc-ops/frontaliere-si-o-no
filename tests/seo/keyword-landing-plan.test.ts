/**
 * GSC keyword landings with unresolvable hreflang — `audit:hreflang`'s 75
 * `missingTarget` offenders on post-deploy run 30376520728 (issue #4905).
 *
 * The `/{section}/{ricerca|search|suche|recherche}-{slug}/` family is emitted
 * per locale from per-locale query data, so a keyword can earn a landing in FR
 * and not in IT while the emitter still writes the full four-locale alternate
 * set. Verified on production: `/fr/trouver-emploi-tessin/
 * recherche-groupe-mutuel-emploi/` serves 200 with four alternates, its IT, EN
 * and DE siblings all 301.
 *
 * `hreflangGuard` would normally catch that by stat-ing dist/, but a
 * BUILD_LOCALE shard cannot — an alternate for a locale it does not emit is
 * absent by design, so it is kept unchecked. The plan supplies the judgement
 * the shard cannot make from disk.
 *
 * The repair deletes no page; it drops the unresolvable hreflang block. These
 * tests pin that, and pin the two ways it could do damage instead: firing on a
 * page whose alternates are all real, or firing while the plan is only
 * half-registered.
 */

import { describe, it, expect, beforeEach } from 'vitest';

import {
  registerKeywordLandingPaths,
  hasKeywordLandingPlan,
  isKeywordLandingPath,
  isStaleKeywordLanding,
  isPlannedKeywordLanding,
  landingPathFromDistRelative,
  normalizeLandingPath,
  keywordLandingPlanSize,
  __resetKeywordLandingPlanForTests,
} from '../../build-plugins/shared/keywordLandingPlan';
import { transformHreflang } from '../../build-plugins/hreflangPostprocessPlugin';

const BASE = 'https://frontaliereticino.ch';
const LIVE = '/cerca-lavoro-ticino/ricerca-jobs-scuol';
const STALE = '/fr/trouver-emploi-tessin/recherche-groupe-mutuel-emploi';

/** Register both owners so the plan is sealed and authoritative. */
function sealPlanWith(paths: string[]): void {
  registerKeywordLandingPaths('related-search-clusters', paths);
  registerKeywordLandingPaths('jobs-seo-pages', []);
}

beforeEach(() => {
  __resetKeywordLandingPlanForTests();
});

describe('normalizeLandingPath / landingPathFromDistRelative', () => {
  it('normalises absolute URLs, trailing slashes, query and hash', () => {
    expect(normalizeLandingPath(`${BASE}${LIVE}/`)).toBe(LIVE);
    expect(normalizeLandingPath(`${BASE}${LIVE}?a=1#x`)).toBe(LIVE);
    expect(normalizeLandingPath(`cerca-lavoro-ticino/ricerca-jobs-scuol`)).toBe(LIVE);
  });

  it('maps both dist serving shapes to the same URL path', () => {
    expect(landingPathFromDistRelative('cerca-lavoro-ticino/ricerca-jobs-scuol/index.html')).toBe(LIVE);
    expect(landingPathFromDistRelative('cerca-lavoro-ticino/ricerca-jobs-scuol.html')).toBe(LIVE);
  });

  it('handles Windows separators', () => {
    expect(landingPathFromDistRelative('cerca-lavoro-ticino\\ricerca-jobs-scuol\\index.html')).toBe(LIVE);
  });
});

describe('isKeywordLandingPath', () => {
  it.each([
    '/cerca-lavoro-ticino/ricerca-x',
    '/en/find-jobs-zurigo/search-x',
    '/de/jobs-im-tessin/suche-x',
    '/fr/trouver-emploi-tessin/recherche-x',
  ])('recognises %s', (p) => expect(isKeywordLandingPath(p)).toBe(true));

  it.each([
    '/cerca-lavoro-ticino/',
    '/cerca-lavoro-ticino/azienda-abb',
    '/articoli-frontaliere/foo',
    '/',
  ])('does not claim %s', (p) => expect(isKeywordLandingPath(p)).toBe(false));
});

describe('plan sealing', () => {
  it('is not authoritative until BOTH owners have registered', () => {
    registerKeywordLandingPaths('jobs-seo-pages', ['/cerca-lavoro-ticino/ricerca-only-jobs']);
    expect(hasKeywordLandingPlan()).toBe(false);
    // A partial plan must never call a live cluster page stale.
    expect(isStaleKeywordLanding(LIVE)).toBe(false);

    registerKeywordLandingPaths('related-search-clusters', [LIVE]);
    expect(hasKeywordLandingPlan()).toBe(true);
  });

  it('accumulates paths across repeated registrations from one owner', () => {
    registerKeywordLandingPaths('jobs-seo-pages', ['/cerca-lavoro-ticino/ricerca-a']);
    registerKeywordLandingPaths('jobs-seo-pages', ['/cerca-lavoro-ticino/ricerca-b']);
    registerKeywordLandingPaths('related-search-clusters', [LIVE]);
    expect(keywordLandingPlanSize()).toBe(3);
    expect(isPlannedKeywordLanding('/cerca-lavoro-ticino/ricerca-a/')).toBe(true);
  });
});

describe('isStaleKeywordLanding', () => {
  it('flags a landing the build no longer plans to emit', () => {
    sealPlanWith([LIVE]);
    expect(isStaleKeywordLanding(STALE)).toBe(true);
  });

  it('never flags a planned landing, in either URL shape', () => {
    sealPlanWith([LIVE]);
    expect(isStaleKeywordLanding(LIVE)).toBe(false);
    expect(isStaleKeywordLanding(`${BASE}${LIVE}/`)).toBe(false);
  });

  it('never flags a path outside the keyword-landing family', () => {
    sealPlanWith([LIVE]);
    expect(isStaleKeywordLanding('/cerca-lavoro-ticino/azienda-abb')).toBe(false);
    expect(isStaleKeywordLanding('/articoli-frontaliere/telelavoro')).toBe(false);
  });
});

describe('transformHreflang — stale landing repair', () => {
  const alt = (loc: string, url: string) =>
    `<link rel="alternate" hreflang="${loc}" href="${url}">`;
  const page = (self: string) =>
    `<html><head><link rel="canonical" href="${BASE}${self}/">\n` +
    alt('it', `${BASE}/cerca-lavoro-ticino/ricerca-groupe-mutuel-emploi/`) + '\n' +
    alt('en', `${BASE}/en/find-jobs-ticino/search-groupe-mutuel-emploi/`) + '\n' +
    alt('de', `${BASE}/de/jobs-im-tessin/suche-groupe-mutuel-emploi/`) + '\n' +
    alt('fr', `${BASE}${STALE}/`) + '\n' +
    alt('x-default', `${BASE}/cerca-lavoro-ticino/ricerca-groupe-mutuel-emploi/`) +
    `</head><body>x</body></html>`;

  it('drops the whole block on a stale landing — not a partial set', () => {
    sealPlanWith([LIVE]);
    const r = transformHreflang(page(STALE), '/dist', BASE, () => true, `${STALE.slice(1)}/index.html`);
    expect(r).not.toBeNull();
    expect(r!.dropped).toBe(5);
    expect(r!.kept).toBe(0);
    expect(r!.html).not.toContain('hreflang=');
    // Everything else on the page is untouched — no content is removed.
    expect(r!.html).toContain('rel="canonical"');
    expect(r!.html).toContain('<body>x</body>');
  });

  it('leaves a live landing alone when every alternate is planned', () => {
    sealPlanWith([
      STALE,
      '/cerca-lavoro-ticino/ricerca-groupe-mutuel-emploi',
      '/en/find-jobs-ticino/search-groupe-mutuel-emploi',
      '/de/jobs-im-tessin/suche-groupe-mutuel-emploi',
    ]);
    const r = transformHreflang(page(STALE), '/dist', BASE, () => true, `${STALE.slice(1)}/index.html`);
    expect(r).toBeNull(); // all alternates planned and present — nothing to rewrite
  });

  it('drops the block on a CURRENT page whose sibling locale is not emitted', () => {
    // The page itself is planned, so it is not stale — but its IT sibling was
    // never emitted. The cross-shard existence check cannot see that; the plan
    // can. This is the asymmetry half of the same defect.
    sealPlanWith([
      STALE,
      '/en/find-jobs-ticino/search-groupe-mutuel-emploi',
      '/de/jobs-im-tessin/suche-groupe-mutuel-emploi',
    ]);
    const r = transformHreflang(page(STALE), '/dist', BASE, () => true, `${STALE.slice(1)}/index.html`);
    expect(r).not.toBeNull();
    expect(r!.html).not.toContain('hreflang=');
    expect(r!.dropped).toBe(5);
  });

  it('leaves every page alone while the plan is half-registered', () => {
    registerKeywordLandingPaths('jobs-seo-pages', []);
    const r = transformHreflang(page(STALE), '/dist', BASE, () => true, `${STALE.slice(1)}/index.html`);
    expect(r).toBeNull();
  });

  it('leaves a non-landing page alone when its alternates are all planned', () => {
    sealPlanWith([
      '/cerca-lavoro-ticino/ricerca-groupe-mutuel-emploi',
      '/en/find-jobs-ticino/search-groupe-mutuel-emploi',
      '/de/jobs-im-tessin/suche-groupe-mutuel-emploi',
      STALE,
    ]);
    const r = transformHreflang(
      page('/articoli-frontaliere/telelavoro'),
      '/dist',
      BASE,
      () => true,
      'articoli-frontaliere/telelavoro/index.html',
    );
    expect(r).toBeNull();
  });

  it('repairs any page whose alternates point at unplanned landings', () => {
    // The rule keys off the TARGETS, not only the page: an article that links
    // out to a landing the build does not emit is just as broken.
    sealPlanWith([LIVE]);
    const r = transformHreflang(
      page('/articoli-frontaliere/telelavoro'),
      '/dist',
      BASE,
      () => true,
      'articoli-frontaliere/telelavoro/index.html',
    );
    expect(r).not.toBeNull();
    expect(r!.html).not.toContain('hreflang=');
  });

  it('ignores pages whose alternates are outside the landing family', () => {
    sealPlanWith([LIVE]);
    const article =
      `<html><head>` +
      `<link rel="alternate" hreflang="it" href="${BASE}/articoli-frontaliere/x/">` +
      `<link rel="alternate" hreflang="fr" href="${BASE}/fr/articles-frontaliers/x/">` +
      `</head><body>a</body></html>`;
    expect(transformHreflang(article, '/dist', BASE, () => true, 'articoli-frontaliere/x/index.html')).toBeNull();
  });

  it('still repairs broken targets when no pagePath is supplied', () => {
    // Without pagePath the staleness half is unavailable, but an alternate
    // pointing at an unplanned landing is still detectable.
    sealPlanWith([LIVE]);
    const r = transformHreflang(page(STALE), '/dist', BASE, () => true);
    expect(r).not.toBeNull();
    expect(r!.html).not.toContain('hreflang=');
  });
});
