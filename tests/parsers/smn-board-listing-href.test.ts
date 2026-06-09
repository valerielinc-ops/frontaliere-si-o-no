/**
 * Regression tests for the Swiss Medical Network `/offene-stellen/{slug}/{uuid}`
 * board listing parsers (issue #1518, follow-up of #1506).
 *
 * The original listing regexes were pinned to *absolute* `https://…` hrefs whose
 * detail path ended in a strict 36-char hex-hyphen UUID with the closing quote
 * immediately after it. A markup variant emitting root-relative hrefs or a
 * non-UUID (slug-like) detail segment → 0 matches → all jobs silently dropped.
 *
 * These two boards share the exact same SMN template, so both were hardened to:
 *   - accept absolute AND root-relative hrefs (relative normalized to absolute)
 *   - relax the strict trailing UUID to any single slug-like segment
 *
 * Covered:
 *   - scripts/lib/spital-zofingen-job-parser.mjs (34 jobs)
 *   - scripts/lib/pbl-job-parser.mjs (PBL board)
 *   - scripts/lib/bls-job-parser.mjs (jobs.bls.ch — same SMN template)
 */
import { describe, it, expect } from 'vitest';
import { parseSpitalZofingenListing } from '../../scripts/lib/spital-zofingen-job-parser.mjs';
import { parseJobListHtml as parsePblListing } from '../../scripts/lib/pbl-job-parser.mjs';
import { parseListingPage as parseBlsListing } from '../../scripts/lib/bls-job-parser.mjs';

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

  it('parses root-relative hrefs and normalizes them to absolute', () => {
    const out = parseBlsListing(
      '<a href="/offene-stellen/lokfuehrer/0123abcd-4567-89ef-0123-456789abcdef">Lokführer</a>'
    );
    expect(out).toHaveLength(1);
    expect(out[0].url).toBe('https://jobs.bls.ch/offene-stellen/lokfuehrer/0123abcd-4567-89ef-0123-456789abcdef');
  });

  it('parses a non-UUID (slug-like) detail segment', () => {
    const out = parseBlsListing(
      '<a href="https://jobs.bls.ch/offene-stellen/lokfuehrer/job-42">Lokführer</a>'
    );
    expect(out).toHaveLength(1);
    expect(out[0].url).toBe('https://jobs.bls.ch/offene-stellen/lokfuehrer/job-42');
  });
});
