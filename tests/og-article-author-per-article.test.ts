/**
 * Regression gate: `article:author` must name the article's own author, never
 * the editorial team page.
 *
 * Incident (2026-09-03). A guest author reported that the article he had just
 * published was attributed to the Redazione. The visible byline, the JSON-LD
 * `author`, the `/autori/<slug>/` link and the corpus record were all correct
 * — the byline said "Di Samuele Valente" on the static page and after
 * hydration alike. The one surface that disagreed was the Open Graph
 * `article:author` tag, hardcoded to `${BASE_URL}/chi-siamo/` in BOTH
 * emitters, so every OG consumer (Facebook, LinkedIn, aggregators, anything
 * scraping the head instead of the body) read every article on the site as
 * the Redazione's.
 *
 * The tag was left behind by #author-eeat, which moved every *other* author
 * surface from a single hardcoded Person to the per-article one; `/chi-siamo/`
 * survived because at the time it was the only author page that existed.
 * `/autori/<slug>/` pages exist now and are what the JSON-LD `author.url`
 * already points at.
 *
 * This is a source gate, not a render gate, because the two emitters live on
 * opposite sides of the SSG/SPA split and the defect is exactly a *literal*:
 * a hardcoded team-page URL sitting where a per-article value belongs. The
 * assertion is deliberately narrow — it forbids the hardcoded pairing, not any
 * particular implementation, and `/chi-siamo/` remains the correct fallback
 * for articles whose author is the Organization.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = join(__dirname, '..');

/** The two files that emit `article:author`: SSG static head, and SPA runtime. */
const EMITTERS = [
  'packages/articles/engine/ogPagesPlugin.ts',
  'services/seoService.ts',
];

/**
 * A hardcoded team-page URL in the same expression as `article:author`.
 * Matches both emitter shapes:
 *   <meta property="article:author" content="${BASE_URL}/chi-siamo/">
 *   updateOrCreateMetaTag('property', 'article:author', `${BASE_URL}/chi-siamo/`);
 * The window is capped so an unrelated `/chi-siamo/` further down the file
 * (the Organization fallback, which is legitimate) is not swept in.
 */
const HARDCODED_TEAM_PAGE = /article:author['"]?[^\n]{0,80}\/chi-siamo\//;

describe('article:author names the article author, not the Redazione', () => {
  for (const rel of EMITTERS) {
    it(`${rel} does not hardcode the team page as article:author`, () => {
      const src = readFileSync(join(ROOT, rel), 'utf-8');

      // Sanity: this gate is worthless if the tag moved away from this file.
      expect(src).toMatch(/article:author/);

      expect(src).not.toMatch(HARDCODED_TEAM_PAGE);
    });
  }

  it('the static emitter reuses the same URL the JSON-LD author declares', () => {
    const src = readFileSync(join(ROOT, EMITTERS[0]), 'utf-8');
    // `authorObj` is the object serialised into the JSON-LD `author`; its
    // `url` is `/autori/<slug>/` for a Person and `/chi-siamo/` for the
    // Organization fallback. Sourcing the meta tag from it is what makes the
    // two impossible to drift apart again.
    expect(src).toMatch(/article:author"\s+content="\$\{[^}]*authorObj\.url[^}]*\}"/);
  });

  it('the SPA emitter reuses the structured data author URL', () => {
    const src = readFileSync(join(ROOT, EMITTERS[1]), 'utf-8');
    // Same contract on the client: the value comes from the `author` of the
    // structured data already in the document, so the tag and the JSON-LD in
    // the same page cannot disagree.
    expect(src).toMatch(/updateOrCreateMetaTag\(\s*'property',\s*'article:author',\s*articleAuthorUrl\s*\)/);
    expect(src).toMatch(/sdAuthor\?\.\['@type'\]\s*===\s*'Person'/);
  });
});
