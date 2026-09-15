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
