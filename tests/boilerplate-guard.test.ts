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
import { detectBoilerplateDescriptions, isSystemicBoilerplateFailure } from '@/scripts/assemble-jobs-dataset.mjs';

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

  it('does NOT flag a job with empty IT locale but a real source-language description (translation backlog)', () => {
    const job = {
      slug: 'de-source-job',
      title: 'Verkäufer:in Food',
      sourceLang: 'de',
      descriptionByLocale: {
        it: '',
        de:
          '## Aufgaben\n' +
          'Du berätst unsere Kundschaft kompetent und sorgst für ein gepflegtes Ladenbild. ' +
          'Du bewirtschaftest die Regale, kontrollierst Frische und Qualität der Produkte ' +
          'und unterstützt das Team an der Kasse bei hohem Kundenaufkommen täglich.\n\n' +
          '## Anforderungen\n' +
          '- Abgeschlossene Berufsausbildung im Detailhandel\n' +
          '- Erfahrung mit Frischprodukten und Warenpräsentation\n' +
          '- Flexibilität, Teamgeist und Freude am Kundenkontakt',
      },
    };
    const report = detectBoilerplateDescriptions([job], 'coop-ticino');
    expect(report.boilerplateCount).toBe(0);
    expect(report.ratio).toBe(0);
  });

  it('does NOT flag a job with empty locales but a real top-level description', () => {
    const job = {
      slug: 'desc-only-job',
      title: 'Magazziniere',
      descriptionByLocale: { it: '' },
      description: RICH_DESCRIPTION,
    };
    const report = detectBoilerplateDescriptions([job], 'test-co');
    expect(report.boilerplateCount).toBe(0);
  });

  it('still flags empty_description when IT locale, source locale and description are all empty', () => {
    const job = {
      slug: 'all-empty-job',
      title: 'Test',
      sourceLang: 'de',
      descriptionByLocale: { it: '', de: '' },
      description: '',
    };
    const report = detectBoilerplateDescriptions([job], 'test-co');
    expect(report.boilerplateCount).toBe(1);
    expect(report.boilerplateJobs[0].reason).toBe('empty_description');
  });

  it('still flags low_unique_words when the source-language fallback is thin', () => {
    const job = {
      slug: 'thin-de-job',
      title: 'Test',
      sourceLang: 'de',
      descriptionByLocale: { it: '', de: 'Verkauf in der Filiale' },
    };
    const report = detectBoilerplateDescriptions([job], 'test-co');
    expect(report.boilerplateCount).toBe(1);
    expect(report.boilerplateJobs[0].reason).toBe('low_unique_words');
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

// ─── Sample-Size Floor Tests (isSystemicBoilerplateFailure) ────────────────────
// Regression coverage for issue #3254 (Diakoniewerk Neumünster, 2026-07-02):
// a low-volume dedicated crawler had only 2 jobs eligible for the boilerplate
// check; 1 of them was a naturally-short-but-legitimate description, which hit
// the 50% ratio and hard-failed the whole run (discarding 6 well-localized
// jobs). isSystemicBoilerplateFailure() adds an absolute sample-size floor on
// top of the ratio so a tiny sample can no longer brick the run by itself.

describe('isSystemicBoilerplateFailure — sample-size floor', () => {
  it('reproduces the #3254 Diakoniewerk incident: 1/2 (50%) is NOT systemic', () => {
    const report = { ratio: 0.5, boilerplateCount: 1, totalJobs: 2 };
    expect(isSystemicBoilerplateFailure(report)).toBe(false);
  });

  it('1/1 (100%) on a single-job crawler is NOT systemic (below both floors)', () => {
    const report = { ratio: 1, boilerplateCount: 1, totalJobs: 1 };
    expect(isSystemicBoilerplateFailure(report)).toBe(false);
  });

  it('2/3 (67%) is NOT systemic (totalJobs below the eligible-jobs floor)', () => {
    const report = { ratio: 2 / 3, boilerplateCount: 2, totalJobs: 3 };
    expect(isSystemicBoilerplateFailure(report)).toBe(false);
  });

  it('2/4 (50%) meets both floors: IS systemic', () => {
    const report = { ratio: 0.5, boilerplateCount: 2, totalJobs: 4 };
    expect(isSystemicBoilerplateFailure(report)).toBe(true);
  });

  it('5/10 (50%) on a large crawler: IS systemic (unchanged from pre-floor behavior)', () => {
    const report = { ratio: 0.5, boilerplateCount: 5, totalJobs: 10 };
    expect(isSystemicBoilerplateFailure(report)).toBe(true);
  });

  it('4/10 (40%) below the ratio threshold: NOT systemic regardless of sample size', () => {
    const report = { ratio: 0.4, boilerplateCount: 4, totalJobs: 10 };
    expect(isSystemicBoilerplateFailure(report)).toBe(false);
  });

  it('a single boilerplate job on a large crawler (1/20 = 5%) stays below ratio: NOT systemic', () => {
    const report = { ratio: 0.05, boilerplateCount: 1, totalJobs: 20 };
    expect(isSystemicBoilerplateFailure(report)).toBe(false);
  });

  it('integration: detectBoilerplateDescriptions output for the #3254 shape is NOT systemic', () => {
    const jobs = [
      makeJob('eligible-good', RICH_DESCRIPTION),
      makeJob('eligible-thin', wordsDesc(29)),
      // 4 freshly-discovered jobs excluded from the eligible sample, mirroring
      // the real run (needsRetranslation=true until AI localization clears it).
      ...Array.from({ length: 4 }, (_, i) =>
        makeJob(`fresh-${i}`, wordsDesc(5), { needsRetranslation: true }),
      ),
    ];
    const report = detectBoilerplateDescriptions(jobs, 'diakoniewerk-neumuenster');
    expect(report.totalJobs).toBe(2);
    expect(report.boilerplateCount).toBe(1);
    expect(report.ratio).toBe(0.5);
    expect(isSystemicBoilerplateFailure(report)).toBe(false);
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
