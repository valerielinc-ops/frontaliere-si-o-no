/**
 * Regression tests for the Swiss Medical Network `/offene-stellen/{slug}/{uuid}`
 * board listing parsers (issue #1518, follow-up of #1506).
 *
 * The original listing regexes were pinned to *absolute* `https://…` hrefs whose
 * detail path ended in a strict 36-char hex-hyphen UUID with the closing quote
 * immediately after it. A markup variant emitting root-relative hrefs or a
 * non-UUID (slug-like) detail segment → 0 matches → all jobs silently dropped.
 *
 * These boards share the exact same SMN template, so all were hardened to relax
 * the strict trailing UUID to any single slug-like segment. Host handling splits
 * by topology:
 *   - same-host boards (spital-zofingen, pbl: the jobs.* subdomain serves its own
 *     listing) also accept root-relative hrefs, normalized to absolute.
 *   - cross-domain boards (bls: listing on www.bls.ch → details on jobs.bls.ch;
 *     soH: listing on www.solothurnerspitaeler.ch → details on jobs.so-h.ch) stay
 *     ABSOLUTE-pinned, because a root-relative href would resolve to the corporate
 *     host, not the jobs subdomain.
 *
 * Covered:
 *   - scripts/lib/spital-zofingen-job-parser.mjs (34 jobs — same-host)
 *   - scripts/lib/pbl-job-parser.mjs (PBL board — same-host)
 *   - scripts/lib/bls-job-parser.mjs (jobs.bls.ch — cross-domain, absolute-pinned)
 *   - scripts/lib/soh-solothurner-spitaeler-job-parser.mjs (jobs.so-h.ch —
 *     cross-domain, absolute-pinned, detail-segment relaxed only)
 */
import { describe, it, expect } from 'vitest';
import { parseSpitalZofingenListing } from '../../scripts/lib/spital-zofingen-job-parser.mjs';
import { parseJobListHtml as parsePblListing } from '../../scripts/lib/pbl-job-parser.mjs';
import { parseListingPage as parseBlsListing } from '../../scripts/lib/bls-job-parser.mjs';
import { parseSohListing } from '../../scripts/lib/soh-solothurner-spitaeler-job-parser.mjs';

describe('Spital Zofingen listing — href hardening', () => {
  it('parses absolute UUID hrefs (today’s markup)', () => {
    const html = `
      <a href="https://jobs.spitalzofingen.ch/offene-stellen/pflegefachperson/0123abcd-4567-89ef-0123-456789abcdef">Job</a>
    `;
    expect(parseSpitalZofingenListing(html)).toEqual([
      'https://jobs.spitalzofingen.ch/offene-stellen/pflegefachperson/0123abcd-4567-89ef-0123-456789abcdef',
    ]);
  });

  it('parses root-relative hrefs and normalizes them to absolute', () => {
    const html = `<a href="/offene-stellen/oberarzt/0123abcd-4567-89ef-0123-456789abcdef">Job</a>`;
    expect(parseSpitalZofingenListing(html)).toEqual([
      'https://jobs.spitalzofingen.ch/offene-stellen/oberarzt/0123abcd-4567-89ef-0123-456789abcdef',
    ]);
  });

  it('parses a non-UUID (slug-like) detail segment', () => {
    const html = `<a href="https://jobs.spitalzofingen.ch/offene-stellen/pflege/job-42-pflegefachperson">Job</a>`;
    expect(parseSpitalZofingenListing(html)).toEqual([
      'https://jobs.spitalzofingen.ch/offene-stellen/pflege/job-42-pflegefachperson',
    ]);
  });

  it('dedupes repeated hrefs', () => {
    const u = 'https://jobs.spitalzofingen.ch/offene-stellen/pflege/0123abcd-4567-89ef-0123-456789abcdef';
    expect(parseSpitalZofingenListing(`<a href="${u}">A</a><a href="${u}">A again</a>`)).toEqual([u]);
  });

  it('does not match the listing index page itself', () => {
    expect(parseSpitalZofingenListing('<a href="/offene-stellen/">All</a>')).toEqual([]);
    expect(parseSpitalZofingenListing('<a href="/offene-stellen/pflege">Category</a>')).toEqual([]);
  });
});

describe('PBL listing — href hardening', () => {
  const anchor = (href: string) =>
    `<a class="job-title" href="${href}" title="Pflegefachperson HF 80%"><span>Pflegefachperson HF</span><p class="job-meta">Lachen</p></a>`;

  it('parses absolute UUID hrefs (today’s markup)', () => {
    const out = parsePblListing(anchor('https://jobs.pbl.ch/offene-stellen/pflege/0123abcd-4567-89ef-0123-456789abcdef'));
    expect(out).toHaveLength(1);
    expect(out[0].detailUrl).toBe('https://jobs.pbl.ch/offene-stellen/pflege/0123abcd-4567-89ef-0123-456789abcdef');
    expect(out[0].slug).toBe('pflege');
  });

  it('parses root-relative hrefs and normalizes them to absolute', () => {
    const out = parsePblListing(anchor('/offene-stellen/pflege/0123abcd-4567-89ef-0123-456789abcdef'));
    expect(out).toHaveLength(1);
    expect(out[0].detailUrl).toBe('https://jobs.pbl.ch/offene-stellen/pflege/0123abcd-4567-89ef-0123-456789abcdef');
  });

  it('parses a non-UUID (slug-like) detail segment', () => {
    const out = parsePblListing(anchor('https://jobs.pbl.ch/offene-stellen/pflege/job-42'));
    expect(out).toHaveLength(1);
    expect(out[0].detailUrl).toBe('https://jobs.pbl.ch/offene-stellen/pflege/job-42');
  });
});

describe('BLS listing — href hardening', () => {
  it('parses absolute UUID hrefs (today’s markup)', () => {
    const out = parseBlsListing(
      '<a href="https://jobs.bls.ch/offene-stellen/lokfuehrer/0123abcd-4567-89ef-0123-456789abcdef">Lokführer</a>'
    );
    expect(out).toHaveLength(1);
    expect(out[0].url).toBe('https://jobs.bls.ch/offene-stellen/lokfuehrer/0123abcd-4567-89ef-0123-456789abcdef');
    expect(out[0].slug).toBe('lokfuehrer');
  });

  it('does NOT match root-relative hrefs (cross-domain: listing on www.bls.ch, details on jobs.bls.ch)', () => {
    // Unlike spital-zofingen/pbl (same-host), the bls listing is fetched from
    // www.bls.ch while details live on jobs.bls.ch. A root-relative href on the
    // corporate page would resolve to the wrong host, so the parser stays
    // absolute-pinned — the same cross-domain carve-out as soH.
    const out = parseBlsListing(
      '<a href="/offene-stellen/lokfuehrer/0123abcd-4567-89ef-0123-456789abcdef">Lokführer</a>'
    );
    expect(out).toHaveLength(0);
  });

  it('parses a non-UUID (slug-like) detail segment', () => {
    const out = parseBlsListing(
      '<a href="https://jobs.bls.ch/offene-stellen/lokfuehrer/job-42">Lokführer</a>'
    );
    expect(out).toHaveLength(1);
    expect(out[0].url).toBe('https://jobs.bls.ch/offene-stellen/lokfuehrer/job-42');
  });
});

describe('soH (Solothurner Spitäler) listing — href hardening', () => {
  // Same SMN `/offene-stellen/{slug}/{detail}` template, but the host stays
  // absolute-pinned: this listing is scraped cross-domain from
  // www.solothurnerspitaeler.ch, so root-relative hrefs are intentionally NOT
  // accepted (they would resolve to the wrong host). Only the strict hex-UUID
  // detail segment is relaxed to a slug-like token.
  it('parses absolute UUID hrefs (today’s markup)', () => {
    const u = 'https://jobs.so-h.ch/offene-stellen/pflegefachperson/0123abcd-4567-89ef-0123-456789abcdef';
    expect(parseSohListing(`<a href="${u}">Job</a>`)).toEqual([u]);
  });

  it('parses a non-UUID (slug-like) detail segment', () => {
    const u = 'https://jobs.so-h.ch/offene-stellen/pflege/job-42-pflegefachperson';
    expect(parseSohListing(`<a href="${u}">Job</a>`)).toEqual([u]);
  });

  it('dedupes the ≥2 anchors emitted per card', () => {
    const u = 'https://jobs.so-h.ch/offene-stellen/pflege/0123abcd-4567-89ef-0123-456789abcdef';
    expect(parseSohListing(`<a href="${u}">Titel</a><a href="${u}">Zur Stellenanzeige</a>`)).toEqual([u]);
  });

  it('does not match the listing index page itself', () => {
    expect(parseSohListing('<a href="https://jobs.so-h.ch/offene-stellen/">All</a>')).toEqual([]);
    expect(parseSohListing('<a href="https://jobs.so-h.ch/offene-stellen/pflege">Category</a>')).toEqual([]);
  });
});
