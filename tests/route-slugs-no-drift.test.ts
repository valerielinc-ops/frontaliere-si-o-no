// Anti-drift guard for #4315: `services/routeSlugs.data.ts` is now the single
// source of truth for localized route slugs. Consumers outside the router's
// TSX graph (Node scripts, build plugins) must derive from it instead of
// hand-copying literal tables — a hand-copy silently stops following a slug
// rename in routeSlugs.data.ts.
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { SLUG_TABLES } from '../services/routeSlugs.data';

const root = path.resolve(__dirname, '..');
const read = (relPath: string) => fs.readFileSync(path.resolve(root, relPath), 'utf-8');

describe('route-slugs anti-drift guard (#4315)', () => {
  it('router.ts no longer defines SLUG_TABLES locally and imports the shared module', () => {
    const src = read('services/router.ts');
    expect(src).not.toMatch(/^const SLUG_TABLES/m);
    expect(src).not.toMatch(/^interface SlugTable/m);
    expect(src).toMatch(/from '\.\/routeSlugs\.data'/);
  });

  it.each([
    ['build-plugins/shared/hubChrome.ts', /from '..\/..\/services\/routeSlugs\.data'/, "jobBoard: 'cerca-lavoro-ticino'"],
    ['services/newsletter-seasonal.mjs', /from '\.\/routeSlugs\.data\.ts'/, "calcolatore: 'calcola-stipendio'"],
    ['scripts/lib/articleContent.mjs', /from '\.\.\/\.\.\/services\/routeSlugs\.data\.ts'/, "it: 'articoli-frontaliere'"],
    ['build-plugins/eventsSeoPagesPlugin.ts', /from '\.\.\/services\/routeSlugs\.data'/, "it: '/cerca-lavoro-ticino/'"],
    ['build-plugins/exchangeRatePagesPlugin.ts', /from '\.\.\/services\/routeSlugs\.data'/, "it: '/calcola-stipendio/',"],
    ['build-plugins/shared/employerCtaBlock.ts', /from '\.\.\/\.\.\/services\/routeSlugs\.data'/, "it: '/per-le-aziende/',"],
    ['build-plugins/blogContextualLinksPlugin.ts', /from '\.\.\/services\/routeSlugs\.data\.ts'/, "it: 'articoli-frontaliere',"],
    ['build-plugins/ogPagesPlugin.ts', /from '\.\.\/services\/routeSlugs\.data'/, "const stBlock = routerSrc.match"],
    ['components/vita/TicineseDialect.tsx', /from '@\/services\/routeSlugs\.data'/, "'/dialetto-ticinese/'"],
    ['scripts/validate-critical-dist-pages.mjs', /from '\.\.\/services\/routeSlugs\.data\.ts'/, "'calcola-stipendio/index.html'"],
    ['build-plugins/seoHubsData.ts', /from '\.\.\/services\/routeSlugs\.data'/, "articlesAll: '/articoli-frontaliere/tutti/'"],
    ['tests/regression/recency-router-guards.test.ts', /from '\.\.\/\.\.\/services\/routeSlugs\.data'/, "it: 'cerca-lavoro-ticino'"],
  ])('%s derives from shared SLUG_TABLES instead of hand-copying literals', (file, importPattern, oldLiteral) => {
    const src = read(file as string);
    expect(src).toMatch(importPattern as RegExp);
    expect(src).not.toContain(oldLiteral as string);
  });

  // scripts/send-newsletter.mjs and scripts/send-job-alerts.mjs used to each
  // hand-copy their own PREFERENCES_SLUG(S) table derived from SLUG_TABLES
  // (the pattern the block above guards). That was itself a sibling-pattern
  // duplication (AGENTS.md #6, docs/AGENTS-HISTORY.md#sibling-pattern-fix):
  // both scripts, plus the welcome-email Cloud Function, need the exact same
  // makePreferencesUrl(email, locale) URL builder, so the slug table AND the
  // builder now live once in functions/src/lib/newsletterUrls.js (guarded
  // against SLUG_TABLES drift by the test below) and are imported here via
  // services/newsletterUrls.mjs instead of hand-copied.
  it.each(['scripts/send-newsletter.mjs', 'scripts/send-job-alerts.mjs'])(
    '%s imports makePreferencesUrl from the shared builder instead of hand-copying a slug table',
    (file) => {
      const src = read(file);
      expect(src).toMatch(/makePreferencesUrl/);
      expect(src).toMatch(/from '\.\.\/services\/newsletterUrls\.mjs'/);
      expect(src).not.toMatch(/^const PREFERENCES_SLUGS?\s*=/m);
      expect(src).not.toMatch(/^function makePreferencesUrl/m);
    },
  );

  // services/seoService.ts, services/seo/seo-pages.ts and build-plugins/editorialContent.ts
  // keep a hand-written IT-only literal on purpose: the first two are read as raw
  // text and regex-parsed at build time by staticPagesPlugin/llmsTxtPlugin/
  // ogPagesPlugin (`key: '...'`), so a template-literal/import-derived value would
  // silently stop matching that regex and drop the page from static output.
  // editorialContent.ts's key is one of ~100+ unrelated content-registry keys, not
  // a SLUG_TABLES mirror. Guard their literal value against drift instead.
  it('IT-only permit-quiz literals (regex-parsed / registry-keyed files) stay in sync with SLUG_TABLES.it.permitQuiz', () => {
    const canonical = SLUG_TABLES.it.permitQuiz;
    expect(canonical).toBe('quiz-permesso-b-o-g');
    expect(read('services/seoService.ts')).toContain(`path: '/${canonical}'`);
    expect(read('services/seo/seo-pages.ts')).toContain(`canonicalPath: '/${canonical}/'`);
    expect(read('build-plugins/editorialContent.ts')).toContain(`'/${canonical}': {`);
  });

  // functions/src is a SEPARATE Firebase Functions deployable (firebase.json
  // `source: "functions"` uploads only that dir) with no build step that could
  // resolve a cross-package import of services/routeSlugs.data.ts — it's a real
  // architectural boundary, not a false positive. Guard the literal instead.
  it('publisherRenewalCore.js DASHBOARD_URL stays in sync with SLUG_TABLES.it.publisherDashboard', () => {
    const src = read('functions/src/publisherRenewalCore.js');
    expect(src).toContain(`https://frontaliereticino.ch/${SLUG_TABLES.it.publisherDashboard}`);
  });

  // functions/src/lib/newsletterUrls.js's PREFERENCES_SLUG is the same kind of
  // forced runtime copy as publisherRenewalCore.js's DASHBOARD_URL above — the
  // welcome-email Cloud Function (functions/src/newsletterWelcomeEmail.js)
  // needs the newsletter-preferences slug per locale, and can't cross the
  // functions/ deploy boundary to import this (TypeScript) file. Unlike the
  // HMAC token / URL-shape builders in that module (made impossible-by-
  // construction via a services/newsletterUrls.mjs re-export shim), the slug
  // table itself has no shared-module escape hatch, so it is guarded here
  // instead: import both tables and assert they agree for all 4 locales.
  it('functions/src/lib/newsletterUrls.js PREFERENCES_SLUG stays in sync with SLUG_TABLES.*.newsletterPreferences', async () => {
    const { PREFERENCES_SLUG } = await import('../functions/src/lib/newsletterUrls.js');
    for (const locale of ['it', 'en', 'de', 'fr'] as const) {
      expect(PREFERENCES_SLUG[locale]).toBe(SLUG_TABLES[locale].newsletterPreferences);
    }
  });
});
