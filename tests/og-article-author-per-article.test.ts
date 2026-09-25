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
import { AUTHORS, getAuthorBySlug } from '../data/authors';
import { resolveArticleProvenance } from '../services/articleProvenance';

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

  it('the SPA emitter derives the URL from the authors registry, not the SEO blob', () => {
    const src = readFileSync(join(ROOT, EMITTERS[1]), 'utf-8');
    // Issue #7241 item 1 moved this contract. Reading `sd.author` (the
    // content/seo/** blob) made the blob a second source of truth for the same
    // fact the registry already holds, and the two had already diverged on 1712
    // of the 3692 articles — the blob still carried the legacy Organization node,
    // so hydration overwrote a correct static tag with the team page. The value
    // now comes from `authorSlug` + data/authors.ts, the SSG's own source.
    expect(src).toMatch(/updateOrCreateMetaTag\(\s*'property',\s*'article:author',\s*articleAuthorUrl\s*\)/);
    expect(src).toMatch(/articleAuthorUrl = resolveArticleAuthorUrl\(/);
  });

  it('the shared derivation prefers the registry and keeps the blob as fallback', () => {
    const src = readFileSync(join(ROOT, 'services/seo/articleAuthorUrl.ts'), 'utf-8');
    // Order is the whole point: registry first, blob Person second, team page
    // last. Flipping the first two re-opens the drift this module closed.
    const registryAt = src.indexOf('getAuthorBySlug(article.authorSlug)');
    const blobAt = src.search(/blobAuthor\?\.\['@type'\]\s*===\s*'Person'/);
    expect(registryAt).toBeGreaterThan(-1);
    expect(blobAt).toBeGreaterThan(registryAt);
  });
});

/**
 * Second half of the same incident. The editorial-transparency aside is the
 * only place on the article page that states HOW the piece came to exist, and
 * it printed "bozza assistita da intelligenza artificiale, revisionata dalla
 * redazione" on every article unconditionally — including the ones a guest
 * journalist wrote himself and submitted through the dashboard. On those it is
 * simply false, and it reads as if the redazione, not the author, had produced
 * the piece: the same complaint, on the surface the reader actually sees.
 *
 * The discriminator is `uid` in the author registry — a Firebase Auth uid,
 * documented as set for guest journalists only. Everyone else is an editorial
 * persona for AI-drafted content.
 */
describe('editorial transparency disclosure matches how the article was produced', () => {
  it('uid marks the guest journalists and nobody else', () => {
    // The registry must keep at least one, or the gate below is dead code.
    expect(AUTHORS.some((a) => a.uid)).toBe(true);
    expect(getAuthorBySlug('samuele-valente')?.uid).toBeTruthy();

    // The editorial personas must never carry one: a uid on any of them makes
    // the disclosure claim AI-drafted articles were written by a human.
    // Asserted on the property, not on a frozen list, so adding a real guest
    // journalist does not fail this — adding a persona with a uid does.
    for (const author of AUTHORS.filter((a) => a.uid)) {
      expect(author.slug).not.toBe('redazione');
      expect(author.role).not.toContain('Team editoriale');
    }
  });

  it('the AI-drafted wording is gated, not printed unconditionally', () => {
    const src = readFileSync(join(ROOT, 'components/community/BlogArticles.tsx'), 'utf-8');

    // The claim still exists — this gate is about when it is shown, not about
    // dropping the Google News disclosure.
    expect(src).toContain('bozza assistita da intelligenza artificiale');

    // ...and it sits in the false branch of the human-contributor check.
    expect(src).toMatch(
      /isHumanContributor[\s\S]{0,400}bozza assistita da intelligenza artificiale/,
    );
    // ...and the gate reads the article's provenance, not the author's `uid`
    // directly. A bare `Boolean(bylineAuthor?.uid)` here is the assumption
    // this module exists to remove: it answers "how was THIS article made"
    // with a property of the person, so a guest journalist's AI-assisted
    // piece would carry the "no AI assistance" claim.
    expect(src).toMatch(/const isHumanContributor = !resolveArticleProvenance\(article, bylineAuthor\)\.aiAssisted/);
    expect(src).not.toMatch(/isHumanContributor\s*=\s*Boolean\(bylineAuthor\?\.uid\)/);
  });
});

/**
 * The reviewer's counterpart to the incident: the fix above stops the AI
 * wording from printing over a human byline, but a disclosure derived from the
 * author registry can still be false in the other direction — a guest
 * journalist drafting one piece with AI support would be announced as having
 * used none. `resolveArticleProvenance` makes the fact declarable per article
 * and keeps the registry only as the default.
 */
describe('article provenance is declared per article, inferred only as a default', () => {
  it('an explicit declaration wins over the registry, in both directions', () => {
    const guest = { uid: 'firebase-uid' };
    const persona = {};

    // The case the registry cannot express: a human contributor who did use AI.
    expect(resolveArticleProvenance({ aiAssisted: true }, guest))
      .toEqual({ aiAssisted: true, basis: 'declared' });
    // ...and its mirror: a persona byline on a piece written without AI.
    expect(resolveArticleProvenance({ aiAssisted: false }, persona))
      .toEqual({ aiAssisted: false, basis: 'declared' });
  });

  it('without a declaration it reproduces the behaviour #7227 shipped', () => {
    expect(resolveArticleProvenance({}, { uid: 'firebase-uid' }))
      .toEqual({ aiAssisted: false, basis: 'inferred-from-uid' });
    expect(resolveArticleProvenance({}, {}))
      .toEqual({ aiAssisted: true, basis: 'inferred-from-uid' });
    expect(resolveArticleProvenance(undefined, undefined))
      .toEqual({ aiAssisted: true, basis: 'inferred-from-uid' });
  });

  it('a malformed declaration falls back instead of reading as "no AI"', () => {
    // The overlay index is untrusted JSON published by another repo. A string
    // or a null there must not become a "written without AI assistance" claim
    // by truthiness — it is not a declaration, so the default applies.
    for (const bad of ['false', 0, null, '']) {
      expect(resolveArticleProvenance({ aiAssisted: bad as never }, {}))
        .toEqual({ aiAssisted: true, basis: 'inferred-from-uid' });
    }
  });

  it('the overlay can carry the declaration for articles this build does not ship', () => {
    // Freshly published articles reach the page only through the overlay, so a
    // field that stops at the bundled record would be dead for exactly them.
    const src = readFileSync(join(ROOT, 'services/articlesOverlay.ts'), 'utf-8');
    expect(src).toMatch(/aiAssisted\?: boolean/);
  });
});
