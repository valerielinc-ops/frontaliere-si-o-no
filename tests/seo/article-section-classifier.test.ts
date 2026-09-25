/**
 * Guard for the editorial-article section matcher (scripts/lib/articleSections.mjs)
 * and the audit feature classifier that consumes it (scripts/audit-title-length.mjs
 * → also imported by audit-h1-title-duplicates + audit-title-no-disambig-hash;
 * mirrored in audit-text-html-ratio, audit-page-weight, audit-dist-multi).
 *
 * Regression context (2026-06-24 post-deploy validate-dist failure `spa-locale 91>90`):
 * the title-length classifier's `blog` regex only ever listed the `frontaliere`
 * article-section slugs. The parallel `svizzera` mirror section (PR #1173) ships
 * its own localized hub/archive landings (`/en/swiss-articles/…`,
 * `/de/schweiz-artikel/…`, `/fr/articles-suisse/…` — see services/articleSections.ts
 * ARTICLE_SECTIONS.svizzera.indexSlug) but was never added, so those en/de/fr
 * svizzera article pages fell into the volatile `spa-locale` bucket instead of
 * `blog` and drifted its ratchet over cap on a normal article batch, with no real
 * SEO change. They must classify as `blog` (the article bucket, with deliberate
 * data-volatile headroom) for EVERY locale, and the matcher must stay in sync
 * with ARTICLE_SECTIONS so the drift cannot recur. Same class as the fuel-section
 * leak (#2853) and the job-board section leak (#1300+).
 */
import { describe, it, expect } from 'vitest';
import { classifyFeature } from '../../scripts/audit-title-length.mjs';
import { isBlogSectionPath, BLOG_SECTION_RX } from '../../scripts/lib/articleSections.mjs';

// classifyFeature takes a dist-relative path (with `dist/` prefix + index.html).
const rel = (p: string) => `dist${p}index.html`;

describe('editorial-article section matcher', () => {
  const articlePaths = [
    // frontaliere section (already matched before the fix — must keep matching)
    '/articoli-frontaliere/come-funziona-il-conguaglio/',
    '/en/cross-border-articles/some-long-keyword-rich-headline/',
    '/de/grenzgaenger-artikel/lange-ueberschrift/',
    '/fr/articles-frontalier/titre-long/',
    // svizzera section (the leak — en/de/fr were drifting into spa-locale)
    '/articoli-svizzera/panoramica-cantoni/',
    '/en/swiss-articles/a-very-long-switzerland-wide-section-headline/',
    '/de/schweiz-artikel/eine-lange-schweizweite-ueberschrift/',
    '/fr/articles-suisse/un-titre-suisse-tres-long/',
  ];

  it.each(articlePaths)('classifies %s as blog', (p) => {
    expect(isBlogSectionPath(p)).toBe(true);
    expect(classifyFeature(rel(p))).toBe('blog');
  });

  // Every CURRENT canonical hub slug from ARTICLE_SECTIONS[*].indexSlug must
  // match — the sync invariant that prevents the svizzera (and any future
  // section/locale) drift from recurring.
  const canonicalHubSlugs = [
    'articoli-frontaliere', 'cross-border-articles', 'grenzgaenger-artikel', 'articles-frontalier',
    'articoli-svizzera', 'swiss-articles', 'schweiz-artikel', 'articles-suisse',
  ];
  it.each(canonicalHubSlugs)('matches canonical hub slug %s', (slug) => {
    expect(isBlogSectionPath(`/${slug}/`)).toBe(true);
    expect(isBlogSectionPath(`/en/${slug}/x/`)).toBe(true);
  });

  const nonArticlePaths = [
    // Non-article en/de/fr landings that legitimately STAY in spa-locale.
    '/fr/salaires-schaffhouse/',
    '/en/tax/',
    '/de/grenzgaenger-ratgeber/versteckte-kosten-chf-eur-wechselkurs/',
    // Fuel pages keep their own bucket, not blog.
    '/fr/prix-gasoil-suisse/italie/bardello-con-malgesso-e-bregano/aujourd-hui/',
    // Profession-canton job landings keep their own bucket.
    '/en/jobs-zurich-cook/',
  ];
  it.each(nonArticlePaths)('does NOT classify %s as blog', (p) => {
    expect(isBlogSectionPath(p)).toBe(false);
    expect(classifyFeature(rel(p))).not.toBe('blog');
  });

  it('regex is anchored on a path boundary (no mid-segment false match)', () => {
    // A deeper segment merely containing "articles" mid-word must not match.
    expect(BLOG_SECTION_RX.test('/en/swiss-articles-archive-old/')).toBe(false);
    // The hub slug needs a trailing `/` (a bare slug with no child is the hub
    // index itself, classified elsewhere — must not partial-match).
    expect(BLOG_SECTION_RX.test('/en/swiss-articles')).toBe(false);
  });

  it('validator form: "/" + dist-relative path matches the article section', () => {
    expect(isBlogSectionPath('/' + 'en/swiss-articles/x/index.html')).toBe(true);
  });
});
