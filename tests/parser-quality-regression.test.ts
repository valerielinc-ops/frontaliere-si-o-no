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
import { normalizeDescriptionBullets } from '../scripts/lib/crawler-template.mjs';
import { htmlToText } from '../scripts/lib/hospital-custom-html-helpers.mjs';
import {
  applySourceDetailResults,
  sourceDetailSeverity,
} from '../scripts/audit-parser-quality.mjs';
import {
  createSourceDetailEvidence,
  createSourceDetailEvidenceBundle,
  replaySourceDetailEvidenceBundle,
} from '../scripts/lib/parser-quality-source-detail-replay.mjs';

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

describe('parser-quality regression — source-detail artifact replay', () => {
  it('replays the same nine CRITICAL observations from audit run 33530688671', () => {
    // The historical artifact preserved these PII-safe locations but not the
    // response bodies. W0 turns that exact gap into the fixture contract: each
    // future live observation persists the same normalized blob plus body/url
    // digests, so the historical verdict is reproducible without publishing
    // descriptions or signed source URLs.
    const fixture = JSON.parse(fs.readFileSync(
      path.join(FIXTURE_DIR, 'source-detail-replay-33530688671.json'),
      'utf8',
    ));
    const records = fixture.cases.map((entry: {
      crawlerKey: string;
      publishedLocation: string;
      sourceLocation: string;
      locationEvidence: string;
    }) => createSourceDetailEvidence({
      crawlerKey: entry.crawlerKey,
      sourceUrl: `https://evidence.invalid/${entry.crawlerKey}`,
      body: `source-detail-observation:${entry.crawlerKey}:${entry.sourceLocation}`,
      provenance: fixture.provenance,
      versions: fixture.versions,
      observation: {
        location: {
          checked: true,
          matchesPublished: false,
          inconclusive: false,
          evidence: entry.locationEvidence,
          authority: 'source-detail',
          published: entry.publishedLocation,
          source: entry.sourceLocation,
        },
        description: {
          publishedDescriptionLength: 300,
          sourceDescriptionLength: 300,
          publishedWordCount: 20,
          overlapWordCount: 20,
        },
      },
    }));
    const requestedSamples = fixture.cases.map((entry: { crawlerKey: string }) => ({
      crawlerKey: entry.crawlerKey,
      url: `https://evidence.invalid/${entry.crawlerKey}`,
    }));
    const expected = {
      provenance: fixture.provenance,
      versions: fixture.versions,
      requestedCount: requestedSamples.length,
      requestedSamples,
    };
    const sourceResults = records.map((record: any, index: number) => ({
      ...requestedSamples[index],
      sourceDetailEvidence: record,
    }));
    const bundle = createSourceDetailEvidenceBundle(sourceResults, expected);
    const firstReplay = replaySourceDetailEvidenceBundle(bundle, expected);
    const secondReplay = replaySourceDetailEvidenceBundle(bundle, expected);
    expect(secondReplay).toEqual(firstReplay);
    expect(bundle).toMatchObject({ requestedCount: 9, replayableCount: 9 });

    const report = Object.fromEntries(fixture.cases.map((entry: { crawlerKey: string }) => [
      entry.crawlerKey,
      { total: 1, issues: [], severity: 'OK' },
    ]));
    applySourceDetailResults(report, firstReplay, firstReplay.length);

    expect(Object.keys(report)).toEqual(fixture.cases.map((entry: { crawlerKey: string }) => entry.crawlerKey));
    expect(Object.values(report).every((entry: any) => sourceDetailSeverity(entry) === 'CRITICAL')).toBe(true);
    expect(Object.values(report).every((entry: any) => (
      entry.issues.some((issue: any) => issue.type === 'source-detail-mismatch' && issue.locationMismatches === 1)
    ))).toBe(true);
    expect(firstReplay.every((result: any) => (
      result.evidenceProvenance.repoHeadSha === fixture.provenance.repoHeadSha
      && result.evidenceProvenance.datasetCommitSha === fixture.provenance.datasetLastCommit.sha
    ))).toBe(true);
  });
});
