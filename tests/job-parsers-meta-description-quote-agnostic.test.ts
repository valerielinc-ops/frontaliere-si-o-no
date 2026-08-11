import { describe, expect, it } from 'vitest';
import { extractMetaDescription as extractKispiMetaDescription } from '../scripts/lib/kispi-job-parser.mjs';
import { extractMetaDescription as extractSolinaMetaDescription } from '../scripts/lib/solina-job-parser.mjs';

/**
 * Both funnel-critical hospital parsers used to read `<meta name=description>`
 * with their OWN quote-strict regex:
 *
 *   kispi : /<meta[^>]+name="description"[^>]+content="([^"]*)"/i
 *   solina: /<meta\s+name="description"\s+content="([^"]+)"/i
 *
 * — the same "one regex per call site, and it drifts" defect this PR removed
 * from the three `dist/` readers. Here the HTML is EXTERNAL (kispi-jobs.ch,
 * jobs.solina.ch), so the quoting is decided by someone else's build: the day
 * either site minifies its head, `name=description` loses its quotes, the
 * regex stops matching and the reader returns '' with no error. On kispi that
 * '' is the second tier of the job description fallback
 * (`detail.metaDesc` → `description`), on solina it is the only source of
 * pensum + city — i.e. the failure lands in published job data, silently.
 *
 * Both now read through scripts/lib/meta-description-extract.mjs. These tests
 * pin BOTH halves of that swap: the shapes served today keep working
 * byte-for-byte (including each parser's own entity decoding), and the shapes
 * that used to return '' now return the description.
 */

/* ── Shapes served TODAY (measured 2026-08-11, curl on both origins) ─────── */

// stellen.kispi-jobs.ch detail page: name/content both quoted, og: and
// twitter: variants carry the SAME text right after it.
const KISPI_LIVE_HEAD = `<!DOCTYPE html><html lang="de"><head>
<title>Kinderspital Zürich: Leitende Ärztin / Leitender Arzt</title>
<meta name="description" content="Du übernimmst die ärztliche und administrative Leitung der Abteilung Gastroenterologie.">
<meta property="og:description" content="OG COPY — must not win">
<meta name="twitter:description" content="TWITTER COPY — must not win">
</head><body></body></html>`;

// jobs.solina.ch detail page: the description is "{pensum}, {city}, {availability}"
// and the source is DOUBLE-encoded (`&amp;nbsp;`), which is what makes the
// "decode exactly once, with the parser's own decoder" requirement observable.
const SOLINA_LIVE_HEAD = `<!DOCTYPE html><html lang="de"><head>
<meta name="description" content="ab&amp;nbsp;60%, Steffisburg Ziegelei, ab November 2026 oder nach Vereinbarung">
<meta property="og:description" content="ab&amp;nbsp;60%, Steffisburg Ziegelei, ab November 2026 oder nach Vereinbarung">
</head><body></body></html>`;

/* ── Shapes that used to return '' ──────────────────────────────────────── */

// `name` unquoted — exactly what html-minifier's removeAttributeQuotes emits
// for a single-token attribute value, and what broke the `dist/` readers.
const UNQUOTED_NAME = `<head><meta name=description content="Pflegefachperson HF, 80-100%, Zürich."></head>`;

// attribute order swapped — legal HTML, and neither old regex allowed it.
const ORDER_SWAPPED = `<head><meta content="Fachfrau Gesundheit EFZ, 60-80%, Thun." name="description"></head>`;

// single quotes on both attributes.
const SINGLE_QUOTED = `<head><meta name='description' content='Assistenzarzt Pädiatrie, 100%, Zürich.'></head>`;

const NO_DESCRIPTION = `<head><meta property="og:description" content="only og here"><title>x</title></head>`;

const READERS: Array<[string, (html: string) => string]> = [
  ['kispi', extractKispiMetaDescription],
  ['solina', extractSolinaMetaDescription],
];

describe.each(READERS)('%s parser — meta description reader', (_name, read) => {
  it('reads the quoted shape served today', () => {
    expect(read(`<head><meta name="description" content="Pflegefachperson HF, 80-100%, Zürich."></head>`))
      .toBe('Pflegefachperson HF, 80-100%, Zürich.');
  });

  it('reads an UNQUOTED name= attribute (returned "" before this change)', () => {
    expect(read(UNQUOTED_NAME)).toBe('Pflegefachperson HF, 80-100%, Zürich.');
  });

  it('reads a content-before-name tag (returned "" before this change)', () => {
    expect(read(ORDER_SWAPPED)).toBe('Fachfrau Gesundheit EFZ, 60-80%, Thun.');
  });

  it('reads single-quoted attributes (returned "" before this change)', () => {
    expect(read(SINGLE_QUOTED)).toBe('Assistenzarzt Pädiatrie, 100%, Zürich.');
  });

  it('returns the empty string — not null/undefined — when there is no description', () => {
    const out = read(NO_DESCRIPTION);
    expect(out).toBe('');
    expect(typeof out).toBe('string');
  });

  it('never mistakes og:description / twitter:description for the description', () => {
    const out = read(NO_DESCRIPTION);
    expect(out).not.toContain('only og here');
  });

  it('is a superset, never a regression: everything the old regex matched still matches', () => {
    // The old regexes required, in order: `<meta`, `name="description"`,
    // `content="…"`. Any HTML they matched has that exact shape.
    const legacyShape = '<meta charset="utf-8"><meta name="description" content="Koch/Köchin, 100%, Bern." />';
    expect(read(legacyShape)).toBe('Koch/Köchin, 100%, Bern.');
  });
});

describe('kispi parser — meta description reader', () => {
  it('picks name=description over the og:/twitter: copies on a live-shaped head', () => {
    expect(extractKispiMetaDescription(KISPI_LIVE_HEAD))
      .toBe('Du übernimmst die ärztliche und administrative Leitung der Abteilung Gastroenterologie.');
  });

  it('still collapses whitespace, as normalizeSpace did', () => {
    const html = `<head><meta name="description" content="Pflegefachperson   HF,\n  80-100%,\tZürich."></head>`;
    expect(extractKispiMetaDescription(html)).toBe('Pflegefachperson HF, 80-100%, Zürich.');
  });

  it('still decodes numeric entities, which the shared normaliser does not', () => {
    const html = `<head><meta name="description" content="Z&#252;rich &amp; Umgebung"></head>`;
    expect(extractKispiMetaDescription(html)).toBe('Zürich & Umgebung');
  });
});

describe('solina parser — meta description reader', () => {
  it('decodes the double-encoded live value exactly once, as before', () => {
    // `&amp;nbsp;` → `&nbsp;`: decoding twice would yield a NBSP and change the
    // pensum token that parseMetaDescription splits on.
    expect(extractSolinaMetaDescription(SOLINA_LIVE_HEAD))
      .toBe('ab&nbsp;60%, Steffisburg Ziegelei, ab November 2026 oder nach Vereinbarung');
  });
});
