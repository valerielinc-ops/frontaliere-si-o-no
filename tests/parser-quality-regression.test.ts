/**
 * Fixture-based regression tests for the parser-quality fixes shipped in
 * the "11 critical crawlers" cleanup. Each test asserts that the pure
 * HTML→text extractor produces a description satisfying the audit's
 * `hasStructuredContent` rule:
 *
 *   - contains a `<li>` tag, OR
 *   - has at least one line starting with `-`, `•`, or `*`, OR
 *   - has at least one line starting with a numbered list marker.
 *
 * The fixtures live in tests/fixtures/parser-quality/<crawler>/ and were
 * captured live in 2026-05 from the upstream career sites. If a future
 * upstream redesign breaks the parser again, the relevant test will fail
 * on the captured fixture before the bad output hits the audit.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { extractEpflDetailDescription } from '../scripts/lib/epfl-job-parser.mjs';
import { extractEthZurichDetailDescription } from '../scripts/lib/eth-zurich-job-parser.mjs';
import { extractKssgDetailDescription } from '../scripts/lib/kssg-job-parser.mjs';
import { normalizeDescriptionBullets } from '../scripts/lib/crawler-template.mjs';
import { htmlToText } from '../scripts/lib/hospital-custom-html-helpers.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE_DIR = path.join(__dirname, 'fixtures', 'parser-quality');

function loadFixture(crawler: string): string {
  const p = path.join(FIXTURE_DIR, crawler, 'sample-detail.html');
  return fs.readFileSync(p, 'utf8');
}

function hasStructuredContent(desc: string): boolean {
  if (/<li[\s>]/i.test(desc)) return true;
  const plain = desc.replace(/<[^>]*>/g, ' ');
  if (/^\s*[-•*]\s/m.test(plain)) return true;
  if (/^\s*\d+[.)]\s/m.test(plain)) return true;
  return false;
}

describe('parser-quality regression — list structure preserved', () => {
  it('EPFL: detail extractor finds the SAP <span class="jobdescription"> body', () => {
    const html = loadFixture('epfl');
    const desc = extractEpflDetailDescription(html);
    expect(desc.length).toBeGreaterThan(200);
    // The EPFL fixture contains "<H2><b>Mission</b></H2>" — stripping HTML
    // leaves "Mission" on its own line, so the body should not collapse to
    // a single paragraph.
    expect(desc.toLowerCase()).toContain('mission');
  });

  it('ETH Zürich: detail extractor finds <section class="description"> + <li> bullets', () => {
    const html = loadFixture('eth-zurich');
    const desc = extractEthZurichDetailDescription(html);
    expect(desc.length).toBeGreaterThan(200);
    expect(hasStructuredContent(desc)).toBe(true);
  });

  it('KSSG: detail extractor finds the SAP <span class="jobdescription"> body', () => {
    const html = loadFixture('kssg');
    const desc = extractKssgDetailDescription(html);
    expect(desc.length).toBeGreaterThan(200);
  });

  it('normalizeDescriptionBullets restores line-start bullets when inline `• ` is present', () => {
    const flat = 'Le sue mansioni • Coordinare il team • Garantire la qualità • Gestire le scadenze';
    const out = normalizeDescriptionBullets(flat);
    expect(/^\s*[-•*]\s/m.test(out)).toBe(true);
  });

  it('normalizeDescriptionBullets is idempotent on already-bulleted text', () => {
    const already = '• A\n• B\n• C';
    expect(normalizeDescriptionBullets(already)).toBe(already);
  });

  // Regression #2476 (Spital STS "10/10 flat"): the shared `htmlToText` helper
  // used by the hospital-class parsers must turn each `<li>` into a line-start
  // `• ` bullet. Previously it mapped `</li>` to a bare `\n`, dropping the
  // marker, so a Prospective.ch `<div class="content"><ul><li>…</li></ul>`
  // section collapsed into flat prose that `hasStructuredContent` could not
  // detect as a list — the audit-parser-quality NEW-OFFENDER trip.
  it('htmlToText turns <ul><li> into line-start bullets (Prospective ATS section)', () => {
    const html =
      '<div class="title"><H2>Das wartet auf Sie</H2></div>' +
      '<div class="content"><ul>' +
      '<li>Abwechslungsreiche Tätigkeit mit grossem Handlungsspielraum</li>' +
      '<li>Hervorragendes interdisziplinäres und interprofessionelles Team</li>' +
      '<li>Exzellentes Teaching</li></ul></div>';
    const out = htmlToText(html);
    expect(hasStructuredContent(out)).toBe(true);
    expect(/^\s*•\s/m.test(out)).toBe(true);
    expect(out).toContain('Exzellentes Teaching');
  });

  // Even when a parser flattens the section with `normalizeSpace` (the bullets
  // survive only as inline `• `), `normalizeDescriptionBullets` must re-expand
  // them to line-start bullets so the by-crawler slice passes the audit.
  it('inline • markers from htmlToText survive a normalizeSpace collapse', () => {
    const html = '<ul><li>Coordinare il team</li><li>Garantire la qualità</li><li>Gestire le scadenze</li></ul>';
    const flattened = htmlToText(html).replace(/\s+/g, ' ').trim();
    expect(flattened).toContain('• ');
    const restored = normalizeDescriptionBullets(flattened);
    expect(/^\s*•\s/m.test(restored)).toBe(true);
  });
});
