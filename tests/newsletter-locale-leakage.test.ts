/**
 * Multi-locale newsletter render-time regression guards.
 *
 * Renders the newsletter HTML directly via `buildNewsletter` for each of the
 * four supported locales (it / en / de / fr) using static fixtures (no DB,
 * no AI, no Firebase) and asserts:
 *   1. No Italian-only phrasings leak into non-IT renders.
 *   2. Internal href URLs are prefixed with `/${locale}/` (with documented
 *      exceptions for hash-routed handlers, social media, and the brand root).
 *   3. The preferences URL uses the locale-correct slug.
 *   4. The featured article URL uses the locale-correct blog section.
 *   5. The job-board CTA uses the locale-correct slug.
 *
 * These tests are explicit regression guards for four locale-leakage bugs:
 *   - locale-blind AI briefing example
 *   - missing /en/ prefix on featured article URL
 *   - hardcoded IT preferences URL
 *   - hardcoded IT featured-tool name ("Calcola Stipendio")
 *
 * NOTE: at the time this file is committed, the four fixes may not yet be
 * merged. The assertions here describe the post-fix expected behaviour and
 * SHOULD fail today; they are intentionally a "ratchet forward" guard.
 */

import { describe, expect, it } from 'vitest';
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore - .mjs module without bundled types
import { buildNewsletter } from '../services/newsletter-template.mjs';

type Locale = 'it' | 'en' | 'de' | 'fr';

const LOCALES: readonly Locale[] = ['it', 'en', 'de', 'fr'] as const;

const BLOG_PATHS: Record<Locale, string> = {
  it: 'articoli-frontaliere',
  en: 'cross-border-articles',
  de: 'grenzgaenger-artikel',
  fr: 'articles-frontalier',
};

const PREFS_SLUGS: Record<Locale, string> = {
  it: 'preferenze-newsletter',
  en: 'newsletter-preferences',
  de: 'newsletter-einstellungen',
  fr: 'preferences-newsletter',
};

const JOB_BOARD_SLUGS: Record<Locale, string> = {
  it: 'cerca-lavoro-ticino',
  en: 'find-jobs-ticino',
  de: 'jobs-im-tessin',
  fr: 'trouver-emploi-tessin',
};

// Locale-correct featured-tool ("salary calculator") name. The IT brand
// "Calcola Stipendio" must NOT appear in non-IT renders.
const TOOL_CALC_NAMES: Record<Locale, string> = {
  it: 'Calcola Stipendio',
  en: 'Salary Calculator',
  de: 'Gehaltsrechner',
  fr: 'Calcul de salaire',
};

const localePrefix = (locale: Locale): string => (locale === 'it' ? '' : `/${locale}`);

const renderForLocale = (locale: Locale): string => {
  const prefix = localePrefix(locale);
  // Cast: buildNewsletter's JSDoc type omits some optional fields
  // (issueNumber, preferencesUrl, resubscribeUrl) that the implementation
  // does accept. The cast is intentional and scoped to this fixture builder.
  return buildNewsletter({
    locale,
    issueNumber: 42,
    aiBriefing: '<p>Briefing for testing.</p>',
    exchangeRate: { rate: 0.94, previousRate: 0.945 },
    matchedJobs: [
      {
        title: 'Test job title',
        company: 'TestCo',
        location: 'Lugano',
        contract: 'CDI',
        url: 'https://example.com/jobs/test-1',
      },
      {
        title: 'Another job',
        company: 'OtherCo',
        location: 'Bellinzona',
        url: 'https://example.com/jobs/test-2',
      },
    ],
    totalJobs: 1234,
    weeklyFact: { text: 'Test fact.', source: 'Test' },
    metrics: { unemploymentRate: '3.1%', lamalPremium: 'CHF 467' },
    article: {
      title: 'Test article',
      excerpt: 'Excerpt body',
      url: `${prefix}/${BLOG_PATHS[locale]}/test-slug`,
      badge: true,
    },
    // featuredTool is documented as legacy/ignored in v3, but pass it so the
    // signature contract is fully exercised.
    featuredTool: {
      icon: '\ud83d\udcb0',
      title: TOOL_CALC_NAMES[locale],
      description: 'Tool description',
      toolUrl: '/calcola-stipendio',
    },
    unsubscribeUrl:
      'https://frontaliereticino.ch/?action=unsubscribe&email=qa@frontaliereticino.ch',
    resubscribeUrl:
      'https://frontaliereticino.ch/?action=resubscribe&email=qa@frontaliereticino.ch',
    preferencesUrl: `https://frontaliereticino.ch${prefix}/${PREFS_SLUGS[locale]}?email=qa@frontaliereticino.ch`,
  } as Parameters<typeof buildNewsletter>[0]);
};

// ── Italian-only phrasings that MUST NOT leak into non-IT renders ─────────
const ITALIAN_LEAK_TOKENS: readonly RegExp[] = [
  /\bpresso\b/i,
  /dai\s+un[''']occhiata/i,
  /alla\s+posizione\s+di/i,
  /Calcola\s+Stipendio/, // IT-branded tool name
  /Confronta\s+i\s+tassi\s+di\s+cambio/i, // IT exchange-rate CTA
  /Tutte\s+le\s+\d+\s+offerte/i, // IT "all jobs" CTA
];

// ── Documented href exceptions (locale-prefix not required) ───────────────
const HREF_EXCEPTIONS: readonly RegExp[] = [
  // hash-routed handlers (un/resubscribe + autologin params)
  /^\/\?(?:action=unsubscribe|action=resubscribe|ne=|ac=)/,
  // bare brand root
  /^\/$/,
  // anchor-only links
  /^#/,
  // social + brand asset URLs
  /^https?:\/\/(?:www\.)?(?:facebook|linkedin|twitter|x|instagram)\.com/i,
];

const isException = (path: string): boolean => HREF_EXCEPTIONS.some((rx) => rx.test(path));

/**
 * Extract internal site paths from `href="…"` attributes in the rendered HTML.
 * Returns each href's path-and-query (relative form), filtering out documented
 * exceptions. Absolute URLs on `frontaliereticino.ch` are normalised to their
 * relative path; absolute URLs on other hosts (e.g. social media) are skipped.
 */
const extractInternalPaths = (html: string): string[] => {
  const out: string[] = [];
  const hrefRe = /href="([^"]+)"/g;
  let m: RegExpExecArray | null;
  while ((m = hrefRe.exec(html)) !== null) {
    const raw = m[1];
    let path = raw;
    // Normalise absolute frontaliereticino.ch URLs → relative.
    const abs = raw.match(/^https?:\/\/(?:www\.)?frontaliereticino\.ch(\/.*)?$/i);
    if (abs) {
      path = abs[1] || '/';
    } else if (/^https?:\/\//i.test(raw)) {
      // Off-site URL (social, external job board, etc.) — handled by exception.
      if (isException(raw)) continue;
      // Anything else off-site is skipped (not an internal path).
      continue;
    }
    if (isException(path)) continue;
    out.push(path);
  }
  return out;
};

describe('newsletter render — locale leakage guards', () => {
  for (const locale of LOCALES) {
    describe(`locale=${locale}`, () => {
      it('renders without throwing', () => {
        expect(() => renderForLocale(locale)).not.toThrow();
      });

      it('contains <html lang="…"> set to the right locale', () => {
        const html = renderForLocale(locale);
        expect(html).toMatch(new RegExp(`<html\\s+lang="${locale}"`));
      });

      if (locale !== 'it') {
        it('does NOT contain Italian-only phrasings or brand names', () => {
          const html = renderForLocale(locale);
          for (const tok of ITALIAN_LEAK_TOKENS) {
            expect(
              html,
              `locale=${locale} leaked Italian phrase ${tok}`,
            ).not.toMatch(tok);
          }
        });

        it('every internal href starts with the locale prefix', () => {
          const html = renderForLocale(locale);
          const paths = extractInternalPaths(html);
          const offenders = paths.filter((p) => !p.startsWith(`/${locale}/`));
          expect(
            offenders,
            `locale=${locale} unprefixed paths: ${JSON.stringify(offenders, null, 2)}`,
          ).toEqual([]);
        });

        it('uses the locale-correct featured-tool name (no IT brand leak)', () => {
          const html = renderForLocale(locale);
          expect(html).toContain(TOOL_CALC_NAMES[locale]);
        });
      }

      it('preferences URL uses locale-correct slug', () => {
        const html = renderForLocale(locale);
        expect(html).toContain(PREFS_SLUGS[locale]);
      });

      it('article URL uses locale-correct blog section', () => {
        const html = renderForLocale(locale);
        const expected =
          locale === 'it'
            ? `/${BLOG_PATHS[locale]}/`
            : `/${locale}/${BLOG_PATHS[locale]}/`;
        expect(html).toContain(expected);
      });

      it('job board CTA uses locale-correct slug', () => {
        const html = renderForLocale(locale);
        expect(html).toContain(JOB_BOARD_SLUGS[locale]);
      });
    });
  }
});
