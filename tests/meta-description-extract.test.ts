/**
 * Guard for the shared quote-agnostic `<meta name=description>` reader
 * (scripts/lib/meta-description-extract.mjs).
 *
 * The defect this pins: html-minifier's `removeAttributeQuotes` (baked in by
 * PR #478) emits `name=description` WITHOUT quotes on every minified page, and
 * every reader in the repo matched `name\s*=\s*["']description["']`. Measured
 * on 200 production job-funnel pages on 2026-08-11: the old readers reported
 * 200/200 as "missing description"; 200/200 actually had one. The blind spot
 * covered exactly the highest-CPC family on the property.
 *
 * These are unit tests on the parser, not on dist/ — they run in the `vitest`
 * job with no build, which is the point: the dist-driven gates in this repo
 * (tests/dist-duplicate-meta-description.test.ts) are opt-in and currently do
 * not run anywhere, so the parser needs a guard that always does.
 */
import { describe, expect, it } from 'vitest';
import {
  extractMetaDescription,
  extractMetaDescriptionRaw,
} from '../scripts/lib/meta-description-extract.mjs';

const DESC = 'Scopri 6049 offerte di lavoro in Ticino aggiornate oggi.';

function page(head: string): string {
  return `<!doctype html><html lang="it"><head><meta charset="utf-8">${head}</head><body><h1>x</h1></body></html>`;
}

describe('meta-description-extract — quote-agnostic reader', () => {
  describe('quoting forms', () => {
    it('reads the double-quoted form (unminified emitters)', () => {
      expect(extractMetaDescription(page(`<meta name="description" content="${DESC}">`))).toBe(DESC);
    });

    it('reads the single-quoted form', () => {
      expect(extractMetaDescription(page(`<meta name='description' content='${DESC}'>`))).toBe(DESC);
    });

    it('reads the UNQUOTED name form — the whole job funnel in dist/', () => {
      // This is the exact byte shape served on /lavoro-ticino-infermiere/:
      // `name` loses its quotes (single token), `content` keeps them (spaces).
      expect(extractMetaDescription(page(`<meta name=description content="${DESC}">`))).toBe(DESC);
    });

    it('reads a fully unquoted tag (no spaces in the content)', () => {
      expect(extractMetaDescription(page('<meta name=description content=Frontaliere>')))
        .toBe('Frontaliere');
    });

    it('reads mixed quoting (unquoted name, single-quoted content)', () => {
      expect(extractMetaDescription(page(`<meta name=description content='${DESC}'>`))).toBe(DESC);
    });

    it('is order-agnostic, quoted and unquoted alike', () => {
      expect(extractMetaDescription(page(`<meta content="${DESC}" name="description">`))).toBe(DESC);
      expect(extractMetaDescription(page(`<meta content="${DESC}" name=description>`))).toBe(DESC);
    });

    it('tolerates a self-closing tag and extra attributes', () => {
      expect(extractMetaDescription(page(`<meta data-rh=true name=description content="${DESC}" />`)))
        .toBe(DESC);
    });

    it('tolerates whitespace around the equals signs', () => {
      expect(extractMetaDescription(page(`<meta name = description content = "${DESC}">`))).toBe(DESC);
    });

    it('is case-insensitive on the tag and attribute names', () => {
      expect(extractMetaDescription(page(`<META NAME=DESCRIPTION CONTENT="${DESC}">`))).toBe(DESC);
    });
  });

  describe('does not over-match — the risk of an unquoted pattern', () => {
    it('ignores og:description and twitter:description', () => {
      const head = `<meta property=og:description content="OG"><meta name=twitter:description content="TW">`;
      expect(extractMetaDescription(page(head))).toBeNull();
    });

    it('ignores an unquoted name that merely STARTS with description', () => {
      // The trap of dropping the quotes: `name=description` must not match
      // `name=descriptionX`. An unquoted value ends at whitespace, not mid-token.
      expect(extractMetaDescription(page('<meta name=descriptionx content="nope">'))).toBeNull();
      expect(extractMetaDescription(page('<meta name=description-long content="nope">'))).toBeNull();
    });

    it('ignores property=description (wrong attribute)', () => {
      expect(extractMetaDescription(page('<meta property=description content="nope">'))).toBeNull();
    });

    it('does not swallow the neighbouring attribute of an unquoted tag', () => {
      // `content` is unquoted here: its value must stop at the space before
      // `data-x`, not run to the end of the tag.
      expect(extractMetaDescription(page('<meta name=description content=Ticino data-x=y>')))
        .toBe('Ticino');
    });

    it('returns null when there is no description at all', () => {
      expect(extractMetaDescription(page('<meta name=robots content=noindex>'))).toBeNull();
    });

    it('skips an empty description and keeps looking', () => {
      expect(extractMetaDescription(page(`<meta name=description content=""><meta name=description content="${DESC}">`)))
        .toBe(DESC);
    });

    it('does not let a > inside a quoted content truncate the tag', () => {
      expect(extractMetaDescription(page('<meta name=description content="a > b">'))).toBe('a > b');
    });
  });

  describe('raw vs normalised', () => {
    it('raw keeps entities and newlines, normalised decodes and collapses them', () => {
      const head = '<meta name=description content="Tasse &amp; pensione\n   per   frontalieri">';
      expect(extractMetaDescriptionRaw(page(head))).toBe('Tasse &amp; pensione\n   per   frontalieri');
      expect(extractMetaDescription(page(head))).toBe('Tasse & pensione per frontalieri');
    });

    it('decodes the apostrophe entities the emitters produce', () => {
      expect(extractMetaDescription(page('<meta name=description content="CHF 78&#39;000 l&#x27;anno">')))
        .toBe("CHF 78'000 l'anno");
    });

    it('returns null on empty / non-string input instead of throwing', () => {
      expect(extractMetaDescription('')).toBeNull();
      expect(extractMetaDescriptionRaw(undefined as unknown as string)).toBeNull();
    });
  });

  describe('regression: the old quoted-only pattern', () => {
    const OLD = (html: string) =>
      html.match(/<meta[^>]*\bname\s*=\s*["']description["'][^>]*\bcontent\s*=\s*(?:"([^"]*)"|'([^']*)')[^>]*>/i);

    it('reproduces the blind spot the shared reader removes', () => {
      const minified = page(`<meta name=description content="${DESC}">`);
      expect(OLD(minified)).toBeNull();               // what CI saw: "missing"
      expect(extractMetaDescription(minified)).toBe(DESC); // what was on the page
    });
  });
});
