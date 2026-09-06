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
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { extractEpflDetailDescription } from '../scripts/lib/epfl-job-parser.mjs';
import { extractEthZurichDetailDescription } from '../scripts/lib/eth-zurich-job-parser.mjs';
import { normalizeDescriptionBullets } from '../scripts/lib/crawler-template.mjs';
import { htmlToText } from '../scripts/lib/hospital-custom-html-helpers.mjs';
import { stableStringify } from '../scripts/lib/stable-stringify.mjs';
import {
  applySourceDetailResults,
  fetchFailureCause,
  sourceDetailSeverity,
  tenantConstantSourceLocations,
} from '../scripts/audit-parser-quality.mjs';
import {
  classifySourceDetailObservation,
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

describe('parser-quality regression — the artifact carries its own request manifest', () => {
  // #7352. The receipts were already verifiable one record at a time, and a
  // tampered observation was already rejected. What the published artifact did
  // NOT carry was the manifest of what had been requested, so the claim the
  // bundle actually makes — «these are the N samples asked for, in this order,
  // none dropped» — could only be checked by whoever still held the request
  // URLs, i.e. the run itself. Replaying a downloaded artifact stopped at
  // `missing-evidence`, which is why pinning 1,20 MB of it would have been a
  // fixture that verified less than it looked like.
  const provenance = {
    repoHeadSha: '56dc609d080f0b2fe8faf8f9329beadb2e563567',
    datasetLastCommit: { sha: 'eefc1b0e4ca67fd7be480cd07ec404be903c0270', committedAt: '2026-09-05T13:13:37Z' },
  };
  const versions = { extractor: 'a'.repeat(64), normalizer: 'b'.repeat(64) };
  const requestedSamples = ['a-group', 'b-group', 'c-group'].map((crawlerKey) => ({
    crawlerKey, url: `https://evidence.invalid/${crawlerKey}/1`,
  }));
  const expected = { provenance, versions, requestedCount: requestedSamples.length, requestedSamples };
  const build = () => createSourceDetailEvidenceBundle(
    requestedSamples.map((s, i) => ({ ...s, fetchFailed: true, status: i === 0 ? 403 : 0 })),
    expected,
  );

  it('replays end to end with nothing but the artifact', () => {
    const bundle = build();
    expect(bundle.requestedSamples).toHaveLength(3);
    // No raw URL travels with the manifest: it commits to the same digests the
    // samples do, which is what lets the bundle be published at all.
    expect(JSON.stringify(bundle.requestedSamples)).not.toContain('evidence.invalid');
    const fromArtifactAlone = replaySourceDetailEvidenceBundle(bundle, { provenance, versions });
    expect(fromArtifactAlone).toEqual(replaySourceDetailEvidenceBundle(bundle, expected));
    expect(fromArtifactAlone).toHaveLength(3);
  });

  it('a pre-#7352 artifact still replays with the request list, and without it says why', () => {
    // Re-sealed without the manifest: exactly the shape of every artifact
    // published before this change.
    const { requestedSamples: _dropped, bundleSha256: _old, ...legacy } = build();
    const legacyBundle = {
      ...legacy,
      bundleSha256: createHash('sha256').update(stableStringify(legacy)).digest('hex'),
    };
    expect(replaySourceDetailEvidenceBundle(legacyBundle as never, expected)).toHaveLength(3);
    expect(() => replaySourceDetailEvidenceBundle(legacyBundle as never, { provenance, versions }))
      .toThrow(/requestedSamples are required/);
  });

  it('rejects a manifest edited to match a doctored sample list', () => {
    const bundle = build();
    const tampered = {
      ...bundle,
      requestedSamples: bundle.requestedSamples.map((s: { crawlerKey: string }, i: number) => (
        i === 0 ? { ...s, crawlerKey: 'someone-else' } : s
      )),
    };
    // Two seals have to be forged, not one: the manifest no longer hashes to
    // `requestSha256`, and the bundle no longer hashes to `bundleSha256`.
    expect(() => replaySourceDetailEvidenceBundle(tampered, { provenance, versions }))
      .toThrow(/digest does not match/);
    expect(() => replaySourceDetailEvidenceBundle(
      { ...tampered, bundleSha256: undefined } as never, { provenance, versions },
    )).toThrow();
  });

  it('rejects a truncated manifest', () => {
    const bundle = build();
    expect(() => replaySourceDetailEvidenceBundle(
      { ...bundle, requestedSamples: bundle.requestedSamples.slice(0, 2) } as never,
      { provenance, versions },
    )).toThrow();
  });
});

describe('parser-quality regression — an unobservable source-detail sample is not a pass', () => {
  // Verbatim observations from the three crawlers named by the cluster, replayed
  // locally against the live detail pages on 2026-09-05: `jobs.coopjobs.ch`,
  // `jobs.fenaco.com` and `stellen.ksuri.ch` all answered 200 with a body, and
  // the extractor read NOTHING out of any of them — no source location, zero
  // chars of source description. Before this guard all six samples scored as a
  // clean pass and the audit printed "0 critical" for all three crawlers, which
  // is how a source-detail run can be green while proving nothing. The same
  // shape covers 208 of the 924 fetched samples of CI run 33953283741.
  const unobservable = [
    { crawlerKey: 'jumbo', published: 'Bern Marktgasse', publishedDescriptionLength: 1013, publishedWordCount: 77 },
    { crawlerKey: 'jumbo', published: 'Baden-Dättwil', publishedDescriptionLength: 1013, publishedWordCount: 77 },
    { crawlerKey: 'volg-fenaco', published: 'Wetzikon', publishedDescriptionLength: 1452, publishedWordCount: 109 },
    { crawlerKey: 'volg-fenaco', published: 'Höri', publishedDescriptionLength: 1256, publishedWordCount: 89 },
    { crawlerKey: 'kantonsspital-uri', published: 'Altdorf', publishedDescriptionLength: 51, publishedWordCount: 4 },
    { crawlerKey: 'kantonsspital-uri', published: 'Altdorf', publishedDescriptionLength: 65, publishedWordCount: 4 },
  ];

  function resultsFrom(samples: typeof unobservable) {
    return samples.map((sample, index) => ({
      crawlerKey: sample.crawlerKey,
      url: `https://evidence.invalid/${sample.crawlerKey}/${index}`,
      ...classifySourceDetailObservation({
        location: {
          checked: false,
          matchesPublished: false,
          inconclusive: false,
          evidence: 'generic',
          authority: 'source-detail',
          published: sample.published,
          source: '',
        },
        description: {
          publishedDescriptionLength: sample.publishedDescriptionLength,
          sourceDescriptionLength: 0,
          publishedWordCount: sample.publishedWordCount,
          overlapWordCount: 0,
        },
      }),
    }));
  }

  it('counts a fetched-but-unreadable sample as unobserved instead of swallowing it', () => {
    const results = resultsFrom(unobservable);
    const report: Record<string, any> = {
      jumbo: { total: 178, issues: [] },
      'volg-fenaco': { total: 553, issues: [] },
      'kantonsspital-uri': { total: 26, issues: [] },
    };
    const summary = applySourceDetailResults(report, results, results.length);

    // The old counters: every one of these six still scores zero, which is
    // precisely why they have to be counted somewhere else.
    expect(summary.fetched).toBe(6);
    expect(summary.locationMismatches).toBe(0);
    expect(summary.descriptionMismatches).toBe(0);
    expect(summary.authoritativeLocationChecks).toBe(0);
    expect(summary.inconclusiveLocationObservations).toBe(0);

    expect(summary.unobserved).toBe(6);
    for (const key of Object.keys(report)) {
      const issue = report[key].issues.find((i: any) => i.type === 'source-detail-unobserved');
      expect(issue, `${key} must report its unobservable samples`).toBeTruthy();
      expect(issue.count).toBe(2);
      expect(issue.details).toHaveLength(2);
    }
  });

  it('leaves a sample that actually observed something out of the unobserved count', () => {
    // Same ksuri page, read correctly: 1685 chars of source description against
    // the 51 published. That is a real finding and must stay a mismatch, not be
    // reclassified as "nothing was observed".
    const observed = [{
      crawlerKey: 'kantonsspital-uri',
      url: 'https://evidence.invalid/kantonsspital-uri/observed',
      ...classifySourceDetailObservation({
        location: {
          checked: false, matchesPublished: false, inconclusive: false,
          evidence: 'generic', authority: 'source-detail', published: 'Altdorf', source: '',
        },
        description: {
          publishedDescriptionLength: 51,
          sourceDescriptionLength: 1685,
          publishedWordCount: 4,
          overlapWordCount: 0,
        },
      }),
    }];
    const report: Record<string, any> = { 'kantonsspital-uri': { total: 26, issues: [] } };
    const summary = applySourceDetailResults(report, observed, observed.length);
    expect(summary.unobserved).toBe(0);
    expect(summary.descriptionMismatches).toBe(1);
    expect(report['kantonsspital-uri'].issues.some((i: any) => i.type === 'source-detail-unobserved')).toBe(false);
  });
});


describe('parser-quality regression — a location repeated across different workplaces is the tenant address', () => {
  // Verbatim from run 33953283741. The two jumbo vacancies are different
  // stores and `jobs.coopjobs.ch` declares Coop's own Reservatstrasse site for
  // both: at most one of two different workplaces can sit at one address, so
  // the value carries no per-vacancy information and must not accuse either.
  function observation(crawlerKey: string, published: string, source: string, matches: boolean) {
    return {
      crawlerKey,
      url: `https://evidence.invalid/${crawlerKey}/${published}`,
      ...classifySourceDetailObservation({
        location: {
          checked: true, matchesPublished: matches, inconclusive: false,
          evidence: 'jsonld', authority: 'source-detail', published, source,
        },
        description: {
          publishedDescriptionLength: 900, sourceDescriptionLength: 900,
          publishedWordCount: 60, overlapWordCount: 55,
        },
      }),
    };
  }

  it('demotes the repeated tenant address to inconclusive instead of accusing both stores', () => {
    const results = [
      observation('jumbo', 'Bern Marktgasse', 'Dietikon, Dietikon', false),
      observation('jumbo', 'Baden-Dättwil', 'Dietikon, Dietikon', false),
    ];
    expect(tenantConstantSourceLocations(results).size).toBe(1);

    const report: Record<string, any> = { jumbo: { total: 178, issues: [] } };
    const summary = applySourceDetailResults(report, results, results.length);
    expect(summary.locationMismatches).toBe(0);
    expect(summary.tenantConstantLocationObservations).toBe(2);
    expect(summary.inconclusiveLocationObservations).toBe(2);
    expect(sourceDetailSeverity(report.jumbo)).toBe(null);
    const issue = report.jumbo.issues.find((i: any) => i.type === 'source-detail-unobserved');
    expect(issue.tenantConstantObservations).toBe(2);
  });

  it('keeps the mismatch when one vacancy sharing that source location does agree with it', () => {
    // agroscope on the same run: the source says Wädenswil, one record
    // publishes Wädenswil correctly and the other publishes Zürich. The value
    // is a real workplace, so the disagreement is a finding — this is the case
    // the rule's `everMatched` guard exists to protect, and without it the
    // detector silently ate a genuine red.
    const results = [
      observation('agroscope', 'Wädenswil', 'Wädenswil, Wädenswil', true),
      observation('agroscope', 'Zürich', 'Wädenswil, Wädenswil', false),
    ];
    expect(tenantConstantSourceLocations(results).size).toBe(0);

    const report: Record<string, any> = { agroscope: { total: 40, issues: [] } };
    const summary = applySourceDetailResults(report, results, results.length);
    expect(summary.locationMismatches).toBe(1);
    expect(summary.tenantConstantLocationObservations).toBe(0);
    expect(sourceDetailSeverity(report.agroscope)).toBe('CRITICAL');
  });

  it('does not fire on two vacancies genuinely in the same town', () => {
    const results = [
      observation('psgn', 'Pfäfers', 'Pfäfers, Pfäfers', true),
      observation('psgn', 'Pfäfers', 'Pfäfers, Pfäfers', true),
    ];
    expect(tenantConstantSourceLocations(results).size).toBe(0);
  });
});


describe('parser-quality regression — a fetch failure says why, not just that', () => {
  it('splits the aggregate into causes that demand different responses', () => {
    // Statuses taken from the non-replayable samples of run 33953283741: a
    // vacancy that is simply gone is expected churn, a 403 is coverage we have
    // lost, and `fetchFailed` alone cannot tell them apart.
    const results = [
      { crawlerKey: 'a', url: 'https://evidence.invalid/a/1', fetchFailed: true, status: 404 },
      { crawlerKey: 'a', url: 'https://evidence.invalid/a/2', fetchFailed: true, status: 403 },
      { crawlerKey: 'a', url: 'https://evidence.invalid/a/3', fetchFailed: true, status: 403 },
      { crawlerKey: 'a', url: 'https://evidence.invalid/a/4', fetchFailed: true, status: 0 },
      { crawlerKey: 'a', url: 'https://evidence.invalid/a/5', fetchFailed: true, status: 503 },
      { crawlerKey: 'a', url: 'https://evidence.invalid/a/6', fetchFailed: true, status: 429 },
    ];
    const report: Record<string, any> = { a: { total: 10, issues: [] } };
    const summary = applySourceDetailResults(report, results, results.length);
    expect(summary.fetchFailed).toBe(6);
    expect(summary.fetchFailureCauses).toEqual({
      'expired-vacancy': 1,
      'blocked-by-source': 2,
      'transport-other': 1,
      'source-server-error': 1,
      'rate-limited': 1,
    });
  });

  it('names every cause it can be handed', () => {
    expect(fetchFailureCause(410)).toBe('expired-vacancy');
    expect(fetchFailureCause(401)).toBe('blocked-by-source');
    expect(fetchFailureCause(undefined)).toBe('transport-other');
    expect(fetchFailureCause(418)).toBe('http-418');
  });

  it('a status-less failure carries the transport kind, not the word «transport»', () => {
    // #7351: 65 of 120 failures on run 33969036485 landed in one bucket named
    // after the layer instead of the cause. DNS says the host is gone, TLS says
    // its certificate is broken, a timeout may well be us — three answers.
    expect(fetchFailureCause(0, { transportError: 'dns' })).toBe('transport-dns');
    expect(fetchFailureCause(0, { transportError: 'tls' })).toBe('transport-tls');
    expect(fetchFailureCause(0, { transportError: 'timeout' })).toBe('transport-timeout');
    expect(fetchFailureCause(0, { transportError: 'reset' })).toBe('transport-reset');
    expect(fetchFailureCause(0, { blockedByRobots: true })).toBe('blocked-by-robots');
    expect(fetchFailureCause(0, { policyBlocked: true })).toBe('blocked-by-policy');
  });
});

describe('parser-quality regression — a source that refuses everything is not an unexplained failure', () => {
  const sample = (crawlerKey: string, n: number, patch: Record<string, unknown>) => ({
    crawlerKey, url: `https://evidence.invalid/${crawlerKey}/${n}`, fetchFailed: true, ...patch,
  });

  it('separates what the source explains from what we still owe an answer for', () => {
    // Shape taken from artifact parser-quality-report-33969036485-1: the source
    // detail sampler draws 2 details per crawler, so a source that refuses BOTH
    // is stating a policy, while one refusal out of two on a source that
    // answered the other is ours.
    const results = [
      sample('refuses-everything', 1, { status: 403 }),
      sample('refuses-everything', 2, { status: 403 }),
      sample('host-is-gone', 1, { status: 0, transportError: 'dns' }),
      sample('host-is-gone', 2, { status: 0, transportError: 'tls' }),
      sample('vacancy-rotated', 1, { status: 404 }),
      sample('vacancy-rotated', 2, { status: 410 }),
      sample('flaky', 1, { status: 0, transportError: 'timeout' }),
      { crawlerKey: 'flaky', url: 'https://evidence.invalid/flaky/2', sourceDetailEvidence: null, fetchFailed: false },
    ];
    const report: Record<string, any> = Object.fromEntries(
      ['refuses-everything', 'host-is-gone', 'vacancy-rotated', 'flaky'].map((k) => [k, { total: 2, issues: [] }]),
    );
    const summary = applySourceDetailResults(report, results, results.length);

    expect(summary.fetchFailed).toBe(7);
    expect(summary.expiredVacancies).toBe(2);
    // Two sources, four samples: the 403 pair and the unreachable pair. The
    // mixed dns/tls pair still counts as ONE source-level finding — a host that
    // is not there is not two different bugs.
    expect(summary.sourceLevelFailures.sourceCount).toBe(2);
    expect(summary.sourceLevelFailures.samples).toBe(4);
    expect(Object.keys(summary.sourceLevelFailures.sources).sort()).toEqual(['host-is-gone', 'refuses-everything']);
    // What is left is the single scattered timeout — and it stays unexplained.
    expect(summary.unexplainedFetchFailures).toBe(1);
    expect(summary.unexplainedFetchFailureRatePct).toBeCloseTo(12.5, 4);
  });

  it('never promotes OUR OWN url-policy refusal to a source policy', () => {
    // The failure mode this whole reclassification could have introduced: a
    // crawler emitting non-public or non-canonical URLs has every sample
    // rejected by our `public-fetch-policy` — a bug of ours — and, if
    // `blocked-by-policy` were read as «the source declined», it would be
    // subtracted from the unexplained count and vanish from the --strict gate.
    // `blocked-by-robots` stays a statement by the source and is promoted.
    const results = [
      sample('our-url-bug', 1, { status: 0, policyBlocked: true }),
      sample('our-url-bug', 2, { status: 0, policyBlocked: true }),
      sample('robots-says-no', 1, { status: 0, blockedByRobots: true }),
      sample('robots-says-no', 2, { status: 0, blockedByRobots: true }),
    ];
    const report: Record<string, any> = {
      'our-url-bug': { total: 2, issues: [] }, 'robots-says-no': { total: 2, issues: [] },
    };
    const summary = applySourceDetailResults(report, results, results.length);

    expect(summary.fetchFailureCauses).toEqual({ 'blocked-by-policy': 2, 'blocked-by-robots': 2 });
    expect(Object.keys(summary.sourceLevelFailures.sources)).toEqual(['robots-says-no']);
    expect(summary.unexplainedFetchFailures).toBe(2);
    expect(summary.unexplainedFetchFailureRatePct).toBeCloseTo(50, 4);
  });

  it('never promotes a runner with no route to «that host is unreachable»', () => {
    // #7536 follow-up: ENETUNREACH/EHOSTUNREACH is OUR runner saying it never
    // reached the network, so it observed nothing about the source. Read as
    // `source-unreachable` it became a source-level finding and was subtracted
    // from the unexplained count — a failure of ours certifying itself as a
    // property of the host, exactly the pattern this split exists to remove.
    // A real DNS loss on the other host still is a source-level finding.
    const results = [
      sample('no-route-from-runner', 1, { status: 0, transportError: 'unreachable-network' }),
      sample('no-route-from-runner', 2, { status: 0, transportError: 'unreachable-network' }),
      sample('host-is-gone', 1, { status: 0, transportError: 'dns' }),
      sample('host-is-gone', 2, { status: 0, transportError: 'dns' }),
    ];
    const report: Record<string, any> = {
      'no-route-from-runner': { total: 2, issues: [] }, 'host-is-gone': { total: 2, issues: [] },
    };
    const summary = applySourceDetailResults(report, results, results.length);

    expect(summary.fetchFailureCauses).toEqual({
      'transport-unreachable-network': 2, 'transport-dns': 2,
    });
    expect(Object.keys(summary.sourceLevelFailures.sources)).toEqual(['host-is-gone']);
    expect(summary.unexplainedFetchFailures).toBe(2);
    expect(summary.unexplainedFetchFailureRatePct).toBeCloseTo(50, 4);
  });

  it('refuses to call a single loss a source policy', () => {
    // The reclassification must not become a way to make the number go away:
    // one failure on a source that answered its other sample is a per-vacancy
    // failure, and no amount of it turns into «the source declined».
    const results = [
      sample('half-broken', 1, { status: 403 }),
      { crawlerKey: 'half-broken', url: 'https://evidence.invalid/half-broken/2', fetchFailed: false },
    ];
    const report: Record<string, any> = { 'half-broken': { total: 2, issues: [] } };
    const summary = applySourceDetailResults(report, results, results.length);
    expect(summary.sourceLevelFailures.sourceCount).toBe(0);
    expect(summary.unexplainedFetchFailures).toBe(1);
  });
});
