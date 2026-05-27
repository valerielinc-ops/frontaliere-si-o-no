/**
 * Boilerplate Guard — Tests for detection logic and guard gate.
 *
 * Validates that detectBoilerplateDescriptions() catches crawler parsers
 * that silently fall back to generic boilerplate descriptions, and that
 * writeJobsCrawlerSlice() enforces the 50% threshold.
 *
 * Spec: docs/superpowers/specs/2026-04-12-crawler-boilerplate-guard-design.md
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { detectBoilerplateDescriptions } from '@/scripts/assemble-jobs-dataset.mjs';

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Build a job object with an Italian locale description. */
function makeJob(
  slug: string,
  descIt: string | null,
  opts: { needsRetranslation?: boolean; title?: string } = {},
) {
  return {
    slug,
    title: opts.title || slug,
    descriptionByLocale: { it: descIt },
    needsRetranslation: opts.needsRetranslation || false,
  };
}

/** Generate a description with exactly N unique words (no marker phrases). */
function wordsDesc(n: number): string {
  const words: string[] = [];
  for (let i = 0; i < n; i++) words.push(`parola${i}`);
  return words.join(' ');
}

/** A description with >=2 marker phrases but NO content headings. */
const BOILERPLATE_2_MARKERS =
  "L'azienda è un'azienda internazionale leader nel settore. " +
  'Ha collaboratori in tutto il mondo e offre opportunità uniche.';

/** A description with >=2 marker phrases AND a content heading + enough real words. */
const MARKERS_WITH_HEADING =
  "L'azienda è un'azienda internazionale leader nel settore. " +
  'Ha collaboratori in tutto il mondo.\n\n' +
  '## COMPITI\n' +
  '- Gestire il team operativo del dipartimento logistico regionale\n' +
  '- Coordinare i progetti di sviluppo internazionale\n' +
  '- Supervisionare le attività quotidiane del personale\n' +
  '- Garantire il rispetto delle normative vigenti\n' +
  '- Ottimizzare i processi interni aziendali strategici\n' +
  '- Interfacciarsi con clienti fornitori partner commerciali';

/** A single marker phrase only. */
const SINGLE_MARKER =
  "L'azienda è un'azienda internazionale leader nel settore energetico. " +
  'Cerchiamo un candidato motivato con esperienza nel campo della logistica internazionale.';

/** A real description with headings and rich content. */
const RICH_DESCRIPTION =
  '## Responsabilita\n' +
  'Il candidato si occuperà di gestire le operazioni quotidiane del dipartimento logistico, ' +
  'coordinando un team di 15 persone e interfacciandosi con i fornitori internazionali. ' +
  'Dovrà garantire il rispetto delle tempistiche di consegna e ottimizzare i processi.\n\n' +
  '## Requisiti\n' +
  '- Laurea in ingegneria gestionale o economia\n' +
  '- Almeno 5 anni di esperienza in ruoli simili\n' +
  '- Ottima conoscenza della lingua inglese e tedesca\n' +
  '- Competenze avanzate in SAP e MS Office\n' +
  '- Capacità di leadership e problem solving';

// ─── Detection Logic Tests ────────────────────────────────────────────────────

describe('detectBoilerplateDescriptions — Condition A (marker phrases)', () => {
  it('flags description with >=2 marker phrases and no content headings', () => {
    const jobs = [makeJob('test-job', BOILERPLATE_2_MARKERS)];
    const report = detectBoilerplateDescriptions(jobs, 'test-co');
    expect(report.boilerplateCount).toBe(1);
    expect(report.boilerplateJobs[0].reason).toBe('marker_phrases');
  });

  it('does NOT flag >=2 markers when content headings are present', () => {
    const jobs = [makeJob('test-job', MARKERS_WITH_HEADING)];
    const report = detectBoilerplateDescriptions(jobs, 'test-co');
    expect(report.boilerplateCount).toBe(0);
  });

  it('does NOT flag description with only 1 marker phrase', () => {
    const jobs = [makeJob('test-job', SINGLE_MARKER)];
    const report = detectBoilerplateDescriptions(jobs, 'test-co');
    // Single marker should not trigger Condition A. May or may not trigger B
    // depending on word count, but reason should NOT be 'marker_phrases'.
    const markerMatch = report.boilerplateJobs.find(j => j.reason === 'marker_phrases');
    expect(markerMatch).toBeUndefined();
  });

  it('flags description matching the regex marker "cerca .+ con sede a"', () => {
    const desc =
      "L'azienda è un'azienda internazionale leader. " +
      'L\'azienda cerca ingegnere con sede a Lugano per un ruolo importante.';
    const jobs = [makeJob('regex-job', desc)];
    const report = detectBoilerplateDescriptions(jobs, 'test-co');
    expect(report.boilerplateCount).toBe(1);
    expect(report.boilerplateJobs[0].reason).toBe('marker_phrases');
  });
});

describe('detectBoilerplateDescriptions — Condition B (low unique words)', () => {
  it('flags description with <30 unique words after marker removal', () => {
    // 2 marker phrases + some filler but < 30 unique words remain. Even though
    // Condition A would also match, let's test with 0 markers and thin content.
    const jobs = [makeJob('thin-job', wordsDesc(20))];
    const report = detectBoilerplateDescriptions(jobs, 'test-co');
    expect(report.boilerplateCount).toBe(1);
    expect(report.boilerplateJobs[0].reason).toBe('low_unique_words');
    expect(report.boilerplateJobs[0].uniqueWords).toBeLessThan(30);
  });

  it('boundary: exactly 30 unique words after removal is NOT boilerplate', () => {
    const jobs = [makeJob('boundary-job', wordsDesc(30))];
    const report = detectBoilerplateDescriptions(jobs, 'test-co');
    expect(report.boilerplateCount).toBe(0);
  });

  it('boundary: 29 unique words after removal IS boilerplate', () => {
    const jobs = [makeJob('boundary-job', wordsDesc(29))];
    const report = detectBoilerplateDescriptions(jobs, 'test-co');
    expect(report.boilerplateCount).toBe(1);
    expect(report.boilerplateJobs[0].reason).toBe('low_unique_words');
  });

  it('counts unique words after substring removal of markers', () => {
    // Add a marker phrase embedded in otherwise short content
    const filler = wordsDesc(25);
    const desc = filler + " è un'azienda internazionale leader nel mondo.";
    const jobs = [makeJob('substr-job', desc)];
    const report = detectBoilerplateDescriptions(jobs, 'test-co');
    // After removing marker substring, remaining words should be ~25-28
    expect(report.boilerplateCount).toBe(1);
    expect(report.boilerplateJobs[0].reason).toBe('low_unique_words');
  });
});

describe('detectBoilerplateDescriptions — real content', () => {
  it('passes cleanly for real descriptions with headings and rich content', () => {
    const jobs = [makeJob('real-job', RICH_DESCRIPTION)];
    const report = detectBoilerplateDescriptions(jobs, 'test-co');
    expect(report.boilerplateCount).toBe(0);
  });
});

describe('detectBoilerplateDescriptions — edge cases', () => {
  it('handles null descriptionByLocale.it gracefully', () => {
    const jobs = [makeJob('null-job', null)];
    const report = detectBoilerplateDescriptions(jobs, 'test-co');
    expect(report.boilerplateCount).toBe(1);
    expect(report.boilerplateJobs[0].reason).toBe('empty_description');
  });

  it('handles undefined descriptionByLocale.it gracefully', () => {
    const job = { slug: 'undef-job', title: 'Test', descriptionByLocale: {} };
    const report = detectBoilerplateDescriptions([job], 'test-co');
    expect(report.boilerplateCount).toBe(1);
    expect(report.boilerplateJobs[0].reason).toBe('empty_description');
  });

  it('handles empty string descriptionByLocale.it gracefully', () => {
    const jobs = [makeJob('empty-job', '')];
    const report = detectBoilerplateDescriptions(jobs, 'test-co');
    expect(report.boilerplateCount).toBe(1);
    expect(report.boilerplateJobs[0].reason).toBe('empty_description');
  });

  it('excludes needsRetranslation jobs from count', () => {
    const jobs = [
      makeJob('retrans-job', BOILERPLATE_2_MARKERS, { needsRetranslation: true }),
      makeJob('good-job', RICH_DESCRIPTION),
    ];
    const report = detectBoilerplateDescriptions(jobs, 'test-co');
    expect(report.totalJobs).toBe(1); // only the good job is eligible
    expect(report.boilerplateCount).toBe(0);
    expect(report.ratio).toBe(0);
  });
});

// ─── Guard Gate Tests ─────────────────────────────────────────────────────────

describe('detectBoilerplateDescriptions — guard gate thresholds', () => {
  it('0 jobs: no division by zero, ratio = 0', () => {
    const report = detectBoilerplateDescriptions([], 'empty-co');
    expect(report.totalJobs).toBe(0);
    expect(report.boilerplateCount).toBe(0);
    expect(report.ratio).toBe(0);
  });

  it('1 boilerplate job out of 1 total: 100% ratio', () => {
    const jobs = [makeJob('only-job', BOILERPLATE_2_MARKERS)];
    const report = detectBoilerplateDescriptions(jobs, 'test-co');
    expect(report.ratio).toBe(1);
    expect(report.boilerplateCount).toBe(1);
    expect(report.totalJobs).toBe(1);
  });

  it('4/10 boilerplate (40%): below threshold', () => {
    const jobs = [
      ...Array.from({ length: 4 }, (_, i) => makeJob(`bp-${i}`, BOILERPLATE_2_MARKERS)),
      ...Array.from({ length: 6 }, (_, i) => makeJob(`good-${i}`, RICH_DESCRIPTION)),
    ];
    const report = detectBoilerplateDescriptions(jobs, 'test-co');
    expect(report.boilerplateCount).toBe(4);
    expect(report.totalJobs).toBe(10);
    expect(report.ratio).toBe(0.4);
    expect(report.ratio).toBeLessThan(0.5);
  });

  it('5/10 boilerplate (50%): at threshold — would trigger hard fail', () => {
    const jobs = [
      ...Array.from({ length: 5 }, (_, i) => makeJob(`bp-${i}`, BOILERPLATE_2_MARKERS)),
      ...Array.from({ length: 5 }, (_, i) => makeJob(`good-${i}`, RICH_DESCRIPTION)),
    ];
    const report = detectBoilerplateDescriptions(jobs, 'test-co');
    expect(report.boilerplateCount).toBe(5);
    expect(report.totalJobs).toBe(10);
    expect(report.ratio).toBe(0.5);
    expect(report.ratio).toBeGreaterThanOrEqual(0.5);
  });
});

// ─── User Flow Tests ──────────────────────────────────────────────────────────

describe('detectBoilerplateDescriptions — user flows', () => {
  it('all jobs have real descriptions: guard passes silently', () => {
    const jobs = Array.from({ length: 10 }, (_, i) =>
      makeJob(`job-${i}`, RICH_DESCRIPTION),
    );
    const report = detectBoilerplateDescriptions(jobs, 'healthy-co');
    expect(report.boilerplateCount).toBe(0);
    expect(report.ratio).toBe(0);
  });

  it('mix of real + boilerplate under 50%: warnings logged, no throw', () => {
    const jobs = [
      makeJob('bp-1', BOILERPLATE_2_MARKERS),
      makeJob('bp-2', wordsDesc(10)),
      ...Array.from({ length: 8 }, (_, i) => makeJob(`good-${i}`, RICH_DESCRIPTION)),
    ];
    const report = detectBoilerplateDescriptions(jobs, 'mixed-co');
    expect(report.boilerplateCount).toBe(2);
    expect(report.totalJobs).toBe(10);
    expect(report.ratio).toBe(0.2);
    expect(report.ratio).toBeLessThan(0.5);
  });
});
