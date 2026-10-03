import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  buildL6FactualityOutcome,
  buildUnavailableL6FactualityOutcome,
  exportL6,
  validateEditorialFactualityLedger,
} from '../scripts/ci/export-l6-factuality-outcomes.mjs';

const NOW = new Date('2026-09-15T12:00:00.000Z');
const POLICY = {
  loopId: 'L6',
  sourceRefs: ['editorial-source-evidence', 'quality-alert-history'],
  outcome: {
    outcomeId: 'confirmed-factuality-defect',
    sourceRefs: ['editorial-source-evidence', 'quality-alert-history'],
  },
};

function review(overrides: Record<string, unknown> = {}) {
  return {
    reviewedAt: '2026-09-15T10:00:00.000Z',
    articleId: 'article-1',
    locale: 'it',
    verdict: 'confirmed_defect',
    reviewerType: 'human',
    observationRef: 'B.6.embedding-store-outdated',
    evidence: {
      sourceRef: 'editorial-source-2026-09-15-1',
      externalSourceVerified: true,
      localeVerified: true,
    },
    ...overrides,
  };
}

const SOURCE_URL = 'https://www.ti.ch/fonte-ufficiale/tabella-2026/';

function automatedReview(overrides: Record<string, unknown> = {}, evidenceOverrides: Record<string, unknown> = {}) {
  return {
    reviewedAt: '2026-09-15T10:00:00.000Z',
    articleId: 'automated-article',
    locale: 'de',
    verdict: 'supported',
    reviewerType: 'automated-source-check',
    observationRef: 'L6.source-check.automated-article.de',
    evidence: {
      method: 'figures-in-source+locale-numeric-parity',
      sourceUrl: SOURCE_URL,
      sourceRefs: [SOURCE_URL],
      sourceHttpStatus: 200,
      sourceFetchedAt: '2026-09-15T09:58:00.000Z',
      sourceSha256: 'a'.repeat(64),
      figuresChecked: 4,
      figuresMatched: 4,
      externalSourceVerified: true,
      localeVerified: true,
      ...evidenceOverrides,
    },
    ...overrides,
  };
}

function automatedEvidenceWithout(field: string) {
  const row = automatedReview();
  delete (row.evidence as Record<string, unknown>)[field];
  return row;
}

function singleRow(row: unknown) {
  return validateEditorialFactualityLedger(JSON.stringify(row), { now: NOW, maxAgeHours: 36 });
}

describe('L6 automated-source-check verdict contract', () => {
  it('accepts a complete, coherent automated source check and counts it as reviewed', () => {
    const verdict = singleRow(automatedReview());
    expect(verdict.issues).toEqual([]);
    expect(verdict).toMatchObject({ quality: 'observed', independent: true });
    expect(verdict.snapshot).toMatchObject({ reviewedArticles: 1, confirmedDefects: 0 });
  });

  it('accepts a coherent automated confirmed_defect that names the missing figures', () => {
    const verdict = singleRow(automatedReview({ verdict: 'confirmed_defect' }, { figuresMatched: 3, missingFigures: ['4.2%'] }));
    expect(verdict.issues).toEqual([]);
    expect(verdict.snapshot).toMatchObject({ reviewedArticles: 1, confirmedDefects: 1, reopenedDefects: 0 });
  });

  it.each([
    ['own site as source', { sourceUrl: 'https://www.frontaliereticino.ch/fonte/', sourceRefs: ['https://www.frontaliereticino.ch/fonte/'] }, /evidence\.sourceUrl/],
    ['apex own site as source', { sourceUrl: 'https://frontaliereticino.ch/fonte/', sourceRefs: ['https://frontaliereticino.ch/fonte/'] }, /evidence\.sourceUrl/],
    ['IPv4 literal host', { sourceUrl: 'https://203.0.113.7/fonte', sourceRefs: ['https://203.0.113.7/fonte'] }, /evidence\.sourceUrl/],
    ['IPv6 literal host', { sourceUrl: 'https://[2001:db8::1]/fonte', sourceRefs: ['https://[2001:db8::1]/fonte'] }, /evidence\.sourceUrl/],
    ['localhost', { sourceUrl: 'https://localhost/fonte', sourceRefs: ['https://localhost/fonte'] }, /evidence\.sourceUrl/],
    ['plain http', { sourceUrl: 'http://www.ti.ch/fonte/', sourceRefs: ['http://www.ti.ch/fonte/'] }, /evidence\.sourceUrl/],
    ['unparsable URL', { sourceUrl: 'not a url', sourceRefs: ['not a url'] }, /evidence\.sourceUrl/],
    ['declared refs differ from the downloaded URL', { sourceRefs: ['https://www.admin.ch/altra-fonte/'] }, /evidence\.sourceRefs/],
    ['an extra undownloaded ref', { sourceRefs: [SOURCE_URL, 'https://www.admin.ch/altra-fonte/'] }, /evidence\.sourceRefs/],
    ['HTTP 404', { sourceHttpStatus: 404 }, /evidence\.sourceHttpStatus must be 200 for automated-source-check/],
    ['source fetched 40h ago', { sourceFetchedAt: '2026-09-13T20:00:00.000Z' }, /evidence\.sourceFetchedAt/],
    ['source fetched after the review', { sourceFetchedAt: '2026-09-15T10:30:00.000Z' }, /evidence\.sourceFetchedAt/],
    ['source fetched in the future', { sourceFetchedAt: '2026-09-15T13:00:00.000Z' }, /evidence\.sourceFetchedAt/],
    ['sha256 of 63 characters', { sourceSha256: 'a'.repeat(63) }, /evidence\.sourceSha256/],
    ['uppercase sha256', { sourceSha256: 'A'.repeat(64) }, /evidence\.sourceSha256/],
    ['zero figures checked', { figuresChecked: 0, figuresMatched: 0 }, /evidence\.figuresChecked/],
    ['more figures matched than checked', { figuresMatched: 5 }, /evidence\.figuresMatched/],
    ['fractional figures matched', { figuresMatched: 3.5 }, /evidence\.figuresMatched/],
    ['model-based method', { method: 'llm-check' }, /evidence\.method/],
    ['unknown deterministic method', { method: 'figures-in-source' }, /evidence\.method/],
    ['external source not verified', { externalSourceVerified: false }, /evidence\.externalSourceVerified/],
    ['locale not verified', { localeVerified: false }, /evidence\.localeVerified/],
  ])('rejects an automated row with %s', (_label, evidenceOverrides, reason) => {
    const verdict = singleRow(automatedReview({}, evidenceOverrides));
    expect(verdict.snapshot.reviewedArticles).toBe(0);
    expect(verdict.independent).toBe(false);
    expect(verdict.invalidRecords[0]?.reason).toMatch(reason);
  });

  it.each(['sourceSha256', 'sourceUrl', 'sourceHttpStatus', 'sourceFetchedAt', 'method', 'figuresChecked', 'figuresMatched'])(
    'rejects an automated row without evidence.%s',
    (field) => {
      const verdict = singleRow(automatedEvidenceWithout(field));
      expect(verdict.snapshot.reviewedArticles).toBe(0);
      expect(verdict.invalidRecords[0]?.reason).toMatch(new RegExp(`evidence\\.${field}`));
    },
  );

  it('rejects verdicts that the figure counts do not support', () => {
    const verdict = validateEditorialFactualityLedger([
      JSON.stringify(automatedReview({ articleId: 'partial-support' }, { figuresMatched: 3 })),
      JSON.stringify(automatedReview({ articleId: 'defect-without-missing', verdict: 'confirmed_defect' }, { figuresMatched: 3 })),
      JSON.stringify(automatedReview({ articleId: 'defect-empty-missing', verdict: 'confirmed_defect' }, { figuresMatched: 3, missingFigures: ['  '] })),
      JSON.stringify(automatedReview({ articleId: 'defect-all-matched', verdict: 'confirmed_defect' }, { missingFigures: ['4.2%'] })),
      JSON.stringify(automatedReview({ articleId: 'automated-reopen', verdict: 'reopened' }, { figuresMatched: 3, missingFigures: ['4.2%'] })),
    ].join('\n'), { now: NOW });
    expect(verdict.snapshot.reviewedArticles).toBe(0);
    const reasons = verdict.invalidRecords.map((record) => record.reason);
    expect(reasons[0]).toMatch(/supported requires evidence\.figuresMatched === evidence\.figuresChecked/);
    expect(reasons[1]).toMatch(/evidence\.missingFigures/);
    expect(reasons[2]).toMatch(/evidence\.missingFigures/);
    expect(reasons[3]).toMatch(/confirmed_defect requires evidence\.figuresMatched < evidence\.figuresChecked/);
    expect(reasons[4]).toMatch(/reopened is not allowed for automated-source-check/);
  });

  it('still rejects model-like reviewer types and model fields next to automated rows', () => {
    const verdict = validateEditorialFactualityLedger([
      JSON.stringify(automatedReview({ articleId: 'ai-reviewer', reviewerType: 'ai-source-check' })),
      JSON.stringify({ ...automatedReview({ articleId: 'model-field' }), modelName: 'any' }),
    ].join('\n'), { now: NOW });
    expect(verdict.snapshot.reviewedArticles).toBe(0);
    expect(verdict.invalidRecords[0]?.reason).toMatch(/reviewerType must be human, external-editorial or automated-source-check/);
    expect(verdict.invalidRecords[1]?.reason).toMatch(/model\/suggestion fields are not allowed/);
  });

  it('keeps human and external-editorial rows valid next to automated ones', () => {
    const verdict = validateEditorialFactualityLedger([
      JSON.stringify(review()),
      JSON.stringify(review({ articleId: 'article-2', locale: 'fr', verdict: 'supported', reviewerType: 'external-editorial' })),
      JSON.stringify(review({ articleId: 'article-3', verdict: 'reopened' })),
      JSON.stringify(automatedReview()),
    ].join('\n'), { now: NOW });
    expect(verdict.issues).toEqual([]);
    expect(verdict.snapshot.reviewedArticles).toBe(verdict.records.length);
    expect(verdict.invalidRecords).toEqual([]);
    const outcome = buildL6FactualityOutcome({ verdict, policy: POLICY, now: NOW });
    expect(outcome.evidence.reviewerTypes).toEqual(['human', 'external-editorial', 'automated-source-check']);
  });
});

describe('read-only L6 editorial factuality outcome exporter', () => {
  it('accepts independently evidenced human/editorial verdicts', () => {
    const verdict = validateEditorialFactualityLedger([
      JSON.stringify(review()),
      JSON.stringify(review({ articleId: 'article-2', locale: 'fr', verdict: 'supported', reviewerType: 'external-editorial' })),
    ].join('\n'), { now: NOW });
    expect(verdict).toMatchObject({ quality: 'observed', independent: true });
    expect(verdict.snapshot).toMatchObject({ reviewedArticles: 2, confirmedDefects: 1, externallyVerifiedDefects: 1, reopenedDefects: 0 });
  });

  it('rejects model verdicts, duplicates and incomplete source/locale evidence', () => {
    const verdict = validateEditorialFactualityLedger([
      JSON.stringify(review()),
      JSON.stringify(review({ articleId: 'article-2', reviewerType: 'llm' })),
      JSON.stringify(review({ articleId: 'article-3', evidence: { sourceRef: 'source', externalSourceVerified: true, localeVerified: false } })),
      JSON.stringify(review()),
    ].join('\n'), { now: NOW });
    expect(verdict.independent).toBe(false);
    expect(verdict.snapshot.reviewedArticles).toBe(1);
    expect(verdict.issues.join(' ')).toMatch(/model|duplicate|localeVerified/);
  });

  it('keeps the outcome non-measurable when any valid review is stale', () => {
    const verdict = validateEditorialFactualityLedger([
      JSON.stringify(review({ articleId: 'stale-article', reviewedAt: '2026-09-13T00:00:00.000Z' })),
      JSON.stringify(review({ articleId: 'fresh-article', reviewedAt: '2026-09-15T10:00:00.000Z', verdict: 'supported' })),
    ].join('\n'), { now: NOW, maxAgeHours: 36 });
    expect(verdict).toMatchObject({ quality: 'stale', independent: false });
    expect(verdict.snapshot).toMatchObject({ reviewedArticles: 2, latestReviewedAt: '2026-09-15T10:00:00.000Z' });
    expect(verdict.issues.join(' ')).toMatch(/stale/);
  });

  it('never exposes measurements from an invalid or missing ledger', () => {
    const outcome = buildL6FactualityOutcome({
      verdict: { quality: 'partial', independent: false, snapshot: { reviewedArticles: 12, confirmedDefects: 3, externallyVerifiedDefects: 3, reopenedDefects: 0 }, invalidRecords: [{}] },
      policy: POLICY,
      now: NOW,
    });
    expect(outcome).toMatchObject({
      independent: false,
      reviewedArticles: null,
      confirmedDefects: null,
      export: { generatorIsNotOracle: true, publishedContentUntouched: true, mutationsPerformed: false },
    });
    expect(buildUnavailableL6FactualityOutcome({ now: NOW, policy: POLICY })).toMatchObject({
      independent: false,
      reviewedArticles: null,
      evidence: { status: 'unavailable' },
    });
  });

  it('writes a registry-sourced outcome without touching published content', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'loop-l6-export-test-'));
    const ledgerPath = path.join(directory, 'editorial.jsonl');
    const outputPath = path.join(directory, 'outcome.json');
    const registryPath = path.join(directory, 'registry.json');
    fs.writeFileSync(ledgerPath, `${JSON.stringify(review())}\n`);
    fs.writeFileSync(registryPath, JSON.stringify({ loops: [POLICY] }));
    const result = exportL6({ ledgerPath, outputPath, registryPath, now: NOW });
    expect(result.outcome).toMatchObject({
      independent: true,
      reviewedArticles: 1,
      confirmedDefects: 1,
      evidence: { externalSourceVerified: true, localeVerified: true },
      export: { readOnly: true, publishedContentUntouched: true },
    });
    expect(JSON.parse(fs.readFileSync(outputPath, 'utf8'))).toEqual(result.outcome);
  });
});
