import { describe, expect, it } from 'vitest';
import {
  buildTranslationObservabilityReport,
  createTranslationObservabilitySnapshot,
  finalizeTranslationObservabilityReport,
} from '../scripts/lib/translation-observability.mjs';
import { rollupTranslationObservability } from '../scripts/rollup-translation-observability.mjs';

const NOW = Date.parse('2026-08-31T00:00:00Z');
const DESCRIPTION = 'Una descrizione italiana abbastanza lunga da superare il limite minimo richiesto dal validatore canonico. '.repeat(2);
const GERMAN = 'Eine deutsche Stellenbeschreibung ist ebenfalls ausreichend lang und enthält alle notwendigen Einzelheiten für diese Teststelle. '.repeat(2);

function job(overrides: Record<string, unknown> = {}) {
  return {
    id: 'internal-private-id', url: 'https://example.invalid/jobs/private-url', title: 'Private title', description: DESCRIPTION,
    companyKey: 'acme', sourceLang: 'it', firstSeenAt: '2026-08-01T00:00:00Z',
    titleByLocale: { it: 'Titolo', en: 'Title', de: 'Titel', fr: 'Titre' },
    descriptionByLocale: { it: DESCRIPTION, en: DESCRIPTION, de: GERMAN, fr: DESCRIPTION },
    ...overrides,
  };
}

describe('translation observability', () => {
  it('is deterministic, bounded and reports ingress/drain without job text, URL or id', () => {
    const before = createTranslationObservabilitySnapshot([job({ needsRetranslation: true }), job({ id: 'gone', url: 'https://example.invalid/gone', needsRetranslation: true })], { now: NOW });
    const final = createTranslationObservabilitySnapshot([job(), job({ id: 'new', url: 'https://example.invalid/new', titleByLocale: { it: '', en: '', de: '', fr: '' } })], { now: NOW });
    const input = { before, final, runId: '7', startedAt: '2026-08-31T00:00:00Z', finishedAt: '2026-08-31T00:01:00Z', sourceCommit: 'abc', outcome: 'failure' };
    const one = finalizeTranslationObservabilityReport(buildTranslationObservabilityReport(input), null);
    const two = finalizeTranslationObservabilityReport(buildTranslationObservabilityReport(input), null);
    expect(one.digest).toBe(two.digest);
    expect(one).toMatchObject({ finalCommit: null, outcome: 'failure', delta: { added: 1, removed: 1, drain: 1, ingress: 1 } });
    expect(one.reappearance.scope).toMatch(/expired archive/);
    expect(one.reappearance.interpretation).toMatch(/not a delete-to-readd/);
    expect(JSON.stringify(one)).not.toContain('Private title');
    expect(JSON.stringify(one)).not.toContain('private-url');
    expect(JSON.stringify(one)).not.toContain('internal-private-id');
    expect(JSON.stringify(one)).not.toContain('acme');
    expect(one.reappearance.fingerprints).toHaveLength(2);
    expect(Buffer.byteLength(JSON.stringify(one))).toBeLessThanOrEqual(1_048_576);
  });

  it('caps companies, fingerprints, weeks, months and its first fourteen baseline reports', () => {
    const jobs = Array.from({ length: 140 }, (_, index) => job({ id: `id-${index}`, url: `https://example.invalid/${index}`, companyKey: `company-${index}`, titleByLocale: { it: '', en: '', de: '', fr: '' } }));
    const snapshot = createTranslationObservabilitySnapshot(jobs, { now: NOW });
    const report = finalizeTranslationObservabilityReport(buildTranslationObservabilityReport({ before: snapshot, final: snapshot, runId: '1', startedAt: '2026-08-31T00:00:00Z', sourceCommit: 'abc' }), 'def');
    expect(report.cohorts.topCompanies).toHaveLength(20);
    expect(report.cohorts.topCompanies.every((row: any) => /^sha256:[a-f0-9]{64}$/.test(row.companyFingerprint))).toBe(true);
    let history: any = null;
    for (let index = 0; index < 110; index++) {
      history = rollupTranslationObservability(history, { ...report, runId: String(index), digest: `sha256:${index}`, finishedAt: new Date(Date.UTC(2016 + index, 0, 1)).toISOString() });
    }
    expect(history.weeks.length).toBeLessThanOrEqual(104);
    expect(history.months.length).toBeLessThanOrEqual(36);
    expect(history.baselineReports).toHaveLength(14);
    expect(history.seenReports.length).toBeLessThanOrEqual(500);
    expect(rollupTranslationObservability(history, { ...report, runId: '109', digest: 'sha256:109', finishedAt: new Date(Date.UTC(2125, 0, 1)).toISOString() })).toEqual(history);
  });
});
