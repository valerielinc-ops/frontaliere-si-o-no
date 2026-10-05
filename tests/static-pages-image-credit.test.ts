// The Wikimedia Commons cover credit on the 44 hand-written article pages that
// build-plugins/staticPagesPlugin.ts still renders (P14 S2).
//
// Same contract as the engine page (S1, tests/article-hero-image-integrity.test.ts):
// a cover with a credit record (`packages/articles/content/image-credits/blog/
// <cover>.json`) carries the photo's own creator and licence in its ImageObject
// and a visible credit at the end of the article body; a cover without one
// renders exactly as before.
//
// The ImageObject half runs on fixtures through the helper the page uses.
// Where the credit sits in the page is read from the template source, for the
// reason the existing hero tests give: rendering one of these pages needs a
// fully built dist.
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

import { blogDetailHeroImageObject } from '../build-plugins/staticPagesPlugin';
import { renderImageCreditHtml, type ImageCreditRecord } from '../packages/articles/engine/shared/imageCredits.mjs';
import { SITE_LICENSE_PAGE } from '../services/seo/imageObjectLd';

const rootDir = path.resolve(__dirname, '..');

const record: ImageCreditRecord = {
  schema: 1,
  cover: '/images/blog/fixture-hand-written.webp',
  source: 'wikimedia-commons',
  commons: { title: 'Fixture Station.jpg', pageUrl: 'https://commons.wikimedia.org/wiki/File:Fixture_Station.jpg' },
  author: { text: 'Fixture Archive', name: 'Fixture Archive', url: null, type: 'Organization' },
  attribution: null,
  licence: { name: 'CC BY 4.0', url: 'https://creativecommons.org/licenses/by/4.0/', family: 'cc-by', attributionRequired: true },
  restrictions: [],
  modified: 'resized',
  fetchedAt: '2026-10-04',
  status: 'ok',
  curation: null,
};

const hero = { url: 'https://frontaliereticino.ch/images/blog/fixture-hand-written.webp', width: 1200, height: 901 };

/** A literal as seo-pages.ts writes it today: the site's claim on the photo. */
const siteClaimLiteral = {
  '@type': 'ImageObject',
  acquireLicensePage: SITE_LICENSE_PAGE,
  copyrightNotice: '© 2024–2026 Frontaliere Ticino. Tutti i diritti riservati.',
  license: SITE_LICENSE_PAGE,
  creator: { '@type': 'Organization', name: 'Frontaliere Ticino', url: 'https://frontaliereticino.ch/' },
  creditText: 'Frontaliere Ticino',
  url: 'https://frontaliereticino.ch/images/blog/fixture-hand-written.webp',
  width: 1344,
  height: 756,
  caption: 'Didascalia di prova',
};

/** The same literal after P14: the five rights fields stripped. */
const { acquireLicensePage: _a, copyrightNotice: _c, license: _l, creator: _cr, creditText: _ct, ...strippedLiteral } = siteClaimLiteral;

const CREDIT_FIELDS = {
  creator: { '@type': 'Organization', name: 'Fixture Archive' },
  creditText: 'Fixture Archive / Wikimedia Commons',
  copyrightNotice: '© Fixture Archive',
  license: 'https://creativecommons.org/licenses/by/4.0/',
  acquireLicensePage: 'https://commons.wikimedia.org/wiki/File:Fixture_Station.jpg',
  isBasedOn: 'https://commons.wikimedia.org/wiki/File:Fixture_Station.jpg',
};

const RIGHTS_KEYS = ['acquireLicensePage', 'copyrightNotice', 'license', 'creator', 'creditText'] as const;

describe('the hand-written article ImageObject (P14)', () => {
  it('takes creator and licence from the cover’s record, not the literal’s site claim', () => {
    expect(blogDetailHeroImageObject(siteClaimLiteral, hero, record)).toEqual({
      '@type': 'ImageObject',
      ...CREDIT_FIELDS,
      url: hero.url,
      contentUrl: hero.url,
      width: hero.width,
      height: hero.height,
      caption: 'Didascalia di prova',
    });
  });

  it('gives a stripped literal the five licence fields the dist gate requires, from the record', () => {
    const image = blogDetailHeroImageObject(strippedLiteral, hero, record);
    for (const key of RIGHTS_KEYS) expect(image, key).toHaveProperty(key);
    expect(image).toMatchObject(CREDIT_FIELDS);
    for (const key of ['license', 'acquireLicensePage'] as const) expect(String(image[key])).toMatch(/^https:\/\//);
  });

  it('public domain and CC0: the same credited ImageObject, and no visible line (owner decision 2026-10-05)', () => {
    const page = 'https://commons.wikimedia.org/wiki/File:Fixture_Station.jpg';
    const cases: Array<[ImageCreditRecord['licence'], string, string]> = [
      [{ name: 'Public domain', url: null, family: 'pd', attributionRequired: false }, 'Public domain', page],
      [{ name: 'CC0', url: 'https://creativecommons.org/publicdomain/zero/1.0/', family: 'cc0', attributionRequired: false }, 'CC0', 'https://creativecommons.org/publicdomain/zero/1.0/'],
    ];
    for (const [licence, notice, license] of cases) {
      const free: ImageCreditRecord = { ...record, licence };
      expect(blogDetailHeroImageObject(strippedLiteral, hero, free), licence.family).toMatchObject({
        creator: { '@type': 'Organization', name: 'Fixture Archive' },
        creditText: 'Fixture Archive / Wikimedia Commons',
        copyrightNotice: notice,
        license,
        acquireLicensePage: page,
        isBasedOn: page,
      });
      // `blogDetailCreditHtml` is this call (see below): an empty footer.
      for (const locale of ['it', 'en', 'de', 'fr']) expect(renderImageCreditHtml(free, locale), `${licence.family} ${locale}`).toBe('');
    }
    // CC BY keeps its line.
    expect(renderImageCreditHtml(record, 'it')).toMatch(/^<footer class="ft-image-credit/);
  });

  it('keeps the literal as it is when the cover has no record (today’s output)', () => {
    expect(blogDetailHeroImageObject(siteClaimLiteral, hero, null)).toEqual({
      ...siteClaimLiteral,
      url: hero.url,
      contentUrl: hero.url,
      width: hero.width,
      height: hero.height,
    });
  });
});

describe('the cover credit on the hand-written page (P14)', () => {
  const SOURCE = fs.readFileSync(path.join(rootDir, 'build-plugins/staticPagesPlugin.ts'), 'utf-8');
  // Booleans, never the 6.000-line source itself: `toContain` would print the
  // whole haystack on failure.
  const has = (needle: string | RegExp): boolean =>
    typeof needle === 'string' ? SOURCE.includes(needle) : needle.test(SOURCE);

  it('reads the record of the page hero with the engine’s reader', () => {
    expect(has(/createImageCreditReader\(fs,\s*np\.resolve\(rootDir,\s*'packages\/articles\/content\/image-credits'\)\)/),
      'no reader over the synced records').toBe(true);
    expect(has(/const blogDetailCredit = blogDetailHeroSrc \? imageCredits\.get\(blogDetailHeroSrc\) : null;/),
      'the record is not the hero’s').toBe(true);
  });

  it('feeds the record into the JSON-LD ImageObject', () => {
    expect(has(/const sdForPage[\s\S]{0,800}?blogDetailHeroImageObject\([^)]*blogDetailCredit\)/),
      'sdForPage does not pass the record').toBe(true);
  });

  it('closes the article body with the credit, before the in-article ad reserve', () => {
    expect(has('const blogDetailCreditHtml = blogDetailCredit ? renderImageCreditHtml(blogDetailCredit, localeKey) : \'\';'),
      'the footer is not rendered from the record in the page locale').toBe(true);
    expect(has('<div class="s-6z0aHu ft-blog-body">${blogArticleHtml}${blogSourcesHtml}${blogDetailCreditHtml}</div>${adPlaceholderInline}${relatedHtml}</article>${adPlaceholderEnd}'),
      'the credit is not the last thing inside .ft-blog-body, right before the ad reserve').toBe(true);
  });

  it('leaves both ad reserves as they were (AGENTS.md #7)', () => {
    expect(has(/const adPlaceholderInline = adReserve\(\s*resolveSlotPlaceholderMinHeight\(inlineCfg\.slot, inlineCfg\.format, inlineCfg\.layout\)/)).toBe(true);
    expect(has(/const adPlaceholderEnd = adReserve\(\s*resolveSlotPlaceholderMinHeight\(endCfg\.slot, endCfg\.format,/)).toBe(true);
    expect(SOURCE.match(/\$\{adPlaceholderInline\}/g)?.length).toBe(1);
    expect(SOURCE.match(/\$\{adPlaceholderEnd\}/g)?.length).toBe(1);
  });
});

/**
 * The 44 hand-written blog literals in services/seo/seo-pages.ts. P14 strips
 * the five rights fields from those of credited Commons covers — the record
 * then supplies them (above) — and leaves the others whole. A literal left
 * with only some of the five would ship an ImageObject the dist gate rejects
 * whenever its cover has no record.
 */
describe('hand-written blog literals carry the rights fields whole or not at all', () => {
  const SEO_PAGES = fs.readFileSync(path.join(rootDir, 'services/seo/seo-pages.ts'), 'utf-8');

  /** The balanced `{…}` starting at `open`, skipping strings and template literals. */
  function balanced(src: string, open: number): string {
    let depth = 0;
    let quote: string | null = null;
    for (let i = open; i < src.length; i += 1) {
      const c = src[i];
      if (quote) {
        if (c === '\\') { i += 1; continue; }
        if (c === quote) quote = null;
        continue;
      }
      if (c === '"' || c === "'" || c === '`') { quote = c; continue; }
      if (c === '{') depth += 1;
      else if (c === '}' && --depth === 0) return src.slice(open, i + 1);
    }
    return '';
  }

  const literals = [...SEO_PAGES.matchAll(/^\s*'(blog-[^']+)':\s*\{/gm)].map((m) => {
    const entry = balanced(SEO_PAGES, m.index! + m[0].length - 1);
    const imageAt = entry.search(/"image"\s*:\s*\{/);
    const image = imageAt < 0 ? '' : balanced(entry, entry.indexOf('{', imageAt));
    return { key: m[1], image };
  });

  it('finds the hand-written blog literals and their images', () => {
    expect(literals.length).toBeGreaterThan(0);
    for (const { key, image } of literals) expect(image, `${key} has no ImageObject`).toMatch(/"@type":\s*"ImageObject"/);
  });

  it('never leaves a partial set', () => {
    const partial = literals
      .map(({ key, image }) => ({ key, present: RIGHTS_KEYS.filter((k) => image.includes(`"${k}"`)) }))
      .filter(({ present }) => present.length !== 0 && present.length !== RIGHTS_KEYS.length);
    expect(partial).toEqual([]);
  });
});
