import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect } from 'vitest';
import {
  coverageSeries,
  evaluateCoverage,
  classifyKind,
  ma3AlertTitle,
  cohortAlertTitle,
  KIND_DATA,
  KIND_MEASURE,
  KIND_UNKNOWN,
  MIN_COHORT_JOBS,
} from '../scripts/monitor-translation-coverage.mjs';
import {
  computePredicateVersion,
  auditPredicateCoverage,
  currentPredicateVersion,
  moduleClosure,
  repoFileReader,
  stripComments,
  PREDICATE_ENTRY,
  PREDICATE_MODULES,
} from '../scripts/lib/incomplete-predicate-version.mjs';
import { isIncomplete } from '../scripts/relocalize-pending-jobs.mjs';
import { normalizeForLengthComparison } from '../scripts/lib/dedicated-crawler-common.mjs';
import {
  summarizeJobs,
  mergeCounters,
  emptyCounters,
  finalizeEntry,
  formatReport,
} from '../scripts/log-translation-stats.mjs';
import { searchSafePrefix } from '../scripts/lib/github-issue-creator.mjs';
import { createTranslationObservabilitySnapshot } from '../scripts/lib/translation-observability.mjs';

/**
 * WS2-MAP (workspace issue 2, mappa di convergenza delle traduzioni). La quota
 * `complete` è scesa dal 91% al 33% senza un allarme, e un terzo del calo era
 * un cambio di predicato (8f20e9e5ff5) indistinguibile dai dati. Qui:
 *   - la regola del monitor (MA3 −10 pp sotto il max a 7 giorni, coorte 24-48 h
 *     sotto il 50%) e la sua classificazione «misura» / «dato»;
 *   - l'impronta del predicato, che deve cambiare quando cambia ciò che conta
 *     e restare ferma quando cambia solo un commento;
 *   - le due colonne nuove della history (`predicateVersion`, `freshCohort`).
 */

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const HOUR = 3600 * 1000;
const DAY = 24 * HOUR;
const T0 = Date.parse('2026-10-01T00:00:00.000Z');

type Row = Record<string, unknown>;

function afterRow(dayOffset: number, ratio: number, extra: Row = {}): Row {
  const total = 10_000;
  return {
    timestamp: new Date(T0 + dayOffset * DAY).toISOString(),
    label: 'after',
    total,
    complete: Math.round(total * ratio),
    incomplete: total - Math.round(total * ratio),
    predicateVersion: 'aaaaaaaaaaaaaaaa',
    ...extra,
  };
}

describe('monitor-translation-coverage — la regola MA3', () => {
  it('legge solo le righe after e calcola la MA3 dal terzo punto', () => {
    const series = coverageSeries([
      afterRow(0, 0.9),
      { ...afterRow(0.1, 0.1), label: 'before' },
      afterRow(1, 0.6),
      afterRow(2, 0.3),
    ]);
    expect(series.map((row) => row.ratio)).toEqual([0.9, 0.6, 0.3]);
    expect(series[0].ma3).toBeNull();
    expect(series[1].ma3).toBeNull();
    expect(series[2].ma3).toBeCloseTo(0.6, 10);
  });

  it('scatta quando la MA3 scende di oltre 10 punti sotto il massimo a 7 giorni', () => {
    const history = [0.9, 0.9, 0.9, 0.85, 0.8, 0.75, 0.7].map((r, i) => afterRow(i, r));
    const verdict = evaluateCoverage(history);
    expect(verdict.ma3.max).toBeCloseTo(0.9, 10);
    expect(verdict.ma3.current).toBeCloseTo(0.75, 10);
    expect(verdict.ma3.fired).toBe(true);
    expect(verdict.ma3.kind).toBe(KIND_DATA);
  });

  it('non scatta su un calo di esattamente 10 punti («oltre», non «almeno»)', () => {
    const history = [0.9, 0.9, 0.9, 0.8, 0.8, 0.8].map((r, i) => afterRow(i, r));
    const verdict = evaluateCoverage(history);
    expect(verdict.ma3.drop).toBeCloseTo(0.1, 10);
    expect(verdict.ma3.fired).toBe(false);
  });

  it('scatta per un calo reale appena superiore a 10 punti', () => {
    const history = [1, 1, 1, 0.69988].map((r, i) => afterRow(i, r));
    const verdict = evaluateCoverage(history);
    expect(verdict.ma3.drop).toBeGreaterThan(0.1);
    expect(verdict.ma3.fired).toBe(true);
  });

  it('il massimo esce dalla finestra dopo 7 giorni', () => {
    // La MA3 del giorno 10 contiene ancora due punti a 0,9: il crollo resta
    // visibile finché quel punto è nella finestra, e sparisce dopo.
    const lows = Array.from({ length: 10 }, () => 0.5);
    const history = [
      ...[0.9, 0.9, 0.9].map((r, i) => afterRow(i, r)),
      ...lows.map((r, i) => afterRow(10 + i, r)),
    ];
    expect(evaluateCoverage(history.slice(0, 3 + 4)).ma3.fired).toBe(true);
    const verdict = evaluateCoverage(history);
    expect(verdict.ma3.fired).toBe(false);
  });

  it('con meno di tre righe after non giudica', () => {
    const verdict = evaluateCoverage([afterRow(0, 0.9), afterRow(1, 0.1)]);
    expect(verdict.ma3.fired).toBe(false);
    expect(verdict.ma3.current).toBeNull();
  });
});

describe('monitor-translation-coverage — misura contro dato', () => {
  it('un cambio di predicateVersion fra le righe confrontate è «misura»', () => {
    const history = [
      ...[0.9, 0.9, 0.9].map((r, i) => afterRow(i, r)),
      ...[0.6, 0.6, 0.6].map((r, i) => afterRow(3 + i, r, { predicateVersion: 'bbbbbbbbbbbbbbbb' })),
    ];
    const verdict = evaluateCoverage(history);
    expect(verdict.ma3.fired).toBe(true);
    expect(verdict.ma3.kind).toBe(KIND_MEASURE);
  });

  it('una riga senza predicateVersion rende il confronto «predicato ignoto», mai «dato»', () => {
    const history = [
      ...[0.9, 0.9].map((r, i) => afterRow(i, r, { predicateVersion: undefined })),
      ...[0.9, 0.6, 0.6, 0.6].map((r, i) => afterRow(2 + i, r)),
    ];
    const verdict = evaluateCoverage(history);
    expect(verdict.ma3.fired).toBe(true);
    expect(verdict.ma3.kind).toBe(KIND_UNKNOWN);
  });

  it('classifyKind: tutte uguali → dato', () => {
    expect(classifyKind([{ predicateVersion: 'x' }, { predicateVersion: 'x' }])).toBe(KIND_DATA);
    expect(classifyKind([{ predicateVersion: 'x' }, { predicateVersion: 'y' }])).toBe(KIND_MEASURE);
    expect(classifyKind([{ predicateVersion: 'x' }, { predicateVersion: null }])).toBe(KIND_UNKNOWN);
  });
});

describe('monitor-translation-coverage — coorte 24-48 h', () => {
  const base = [0.9, 0.9, 0.9].map((r, i) => afterRow(i, r));

  it('scatta sotto il 50% complete', () => {
    const history = [...base, afterRow(3, 0.9, { freshCohort: { window: '24-48h', total: 1192, complete: 150 } })];
    const verdict = evaluateCoverage(history);
    expect(verdict.cohort.measured).toBe(true);
    expect(verdict.cohort.ratio).toBeCloseTo(150 / 1192, 10);
    expect(verdict.cohort.fired).toBe(true);
    expect(verdict.cohort.kind).toBe(KIND_DATA);
  });

  it('non scatta al 74% (il valore dell\'11-09)', () => {
    const history = [...base, afterRow(3, 0.9, { freshCohort: { total: 1000, complete: 742 } })];
    expect(evaluateCoverage(history).cohort.fired).toBe(false);
  });

  it('sotto il minimo di annunci la coorte non decide', () => {
    const history = [...base, afterRow(3, 0.9, { freshCohort: { total: MIN_COHORT_JOBS - 1, complete: 0 } })];
    const verdict = evaluateCoverage(history);
    expect(verdict.cohort.measured).toBe(false);
    expect(verdict.cohort.fired).toBe(false);
  });

  it('una riga senza freshCohort (prima del 04-10) non è misurata', () => {
    const verdict = evaluateCoverage(base);
    expect(verdict.cohort.measured).toBe(false);
    expect(verdict.cohort.fired).toBe(false);
  });
});

describe('monitor-translation-coverage — titoli stabili', () => {
  it('il titolo MA3 è quello della scheda', () => {
    expect(ma3AlertTitle(KIND_DATA)).toBe(
      '[translation] quota complete MA3 -10pp sotto il max a 7 giorni (dato) — translation-stats-history',
    );
  });

  it('le varianti «dato» / «misura» / «predicato ignoto» dedupano sulla stessa issue', () => {
    for (const title of [ma3AlertTitle, cohortAlertTitle]) {
      const prefixes = new Set([KIND_DATA, KIND_MEASURE, KIND_UNKNOWN].map((kind) => searchSafePrefix(title(kind))));
      expect(prefixes.size).toBe(1);
    }
    expect(searchSafePrefix(ma3AlertTitle(KIND_DATA))).not.toBe(searchSafePrefix(cohortAlertTitle(KIND_DATA)));
  });
});

describe('incomplete-predicate-version — impronta del predicato', () => {
  const readFile = repoFileReader(ROOT);
  const entrySource = readFile(PREDICATE_ENTRY);
  const functionSources = { normalizeForLengthComparison: normalizeForLengthComparison.toString() };

  function versionWith(overrides: Record<string, string> = {}, predicateSource = isIncomplete.toString()) {
    const read = (rel: string) => (rel in overrides ? overrides[rel] : readFile(rel));
    return computePredicateVersion({ predicateSource, entrySource, functionSources, readFile: read }).version;
  }

  it('ogni import e ogni nome locale che isIncomplete usa è coperto dall\'impronta', () => {
    const audit = auditPredicateCoverage({ predicateSource: isIncomplete.toString(), entrySource, readFile });
    expect(audit.uncovered).toEqual([]);
    for (const rel of PREDICATE_MODULES) expect(audit.coveredModules).toContain(rel);
  });

  it('l\'audit vede un helper nuovo non coperto', () => {
    const predicate = isIncomplete.toString().replace('return false;\n}', 'return sortByPriority(job);\n}');
    const entryWithHelper = `${entrySource}\nfunction sortByPriority() { return false; }\n`;
    const audit = auditPredicateCoverage({ predicateSource: predicate, entrySource: entryWithHelper, readFile });
    expect(audit.uncovered.some((name: string) => name.startsWith('sortByPriority'))).toBe(true);
  });

  it('è 16 hex e deterministica', () => {
    const v = currentPredicateVersion({ isIncomplete, helpers: { normalizeForLengthComparison }, root: ROOT });
    expect(v).toMatch(/^[0-9a-f]{16}$/);
    expect(versionWith()).toBe(v);
  });

  it('cambia quando cambia un modulo del predicato, anche transitivo', () => {
    const closure = moduleClosure(PREDICATE_MODULES, readFile);
    const transitive = closure.find((rel: string) => !PREDICATE_MODULES.includes(rel));
    expect(transitive).toBeTruthy();
    for (const rel of [PREDICATE_MODULES[0], transitive as string]) {
      expect(versionWith({ [rel]: `${readFile(rel)}\nexport const extra = 1;\n` })).not.toBe(versionWith());
    }
  });

  it('cambia quando cambia il corpo di isIncomplete', () => {
    const stricter = isIncomplete.toString().replace('return false;\n}', 'return true;\n}');
    expect(stricter).not.toBe(isIncomplete.toString());
    expect(versionWith({}, stricter)).not.toBe(versionWith());
  });

  it('non cambia per un commento riscritto', () => {
    const rel = PREDICATE_MODULES[0];
    expect(versionWith({ [rel]: `// nota riscritta\n${readFile(rel)}` })).toBe(versionWith());
    expect(stripComments("const u = 'https://x'; // c\n/* b */ f();")).toBe("const u = 'https://x'; \n  f();");
  });
});

describe('log-translation-stats — predicateVersion e coorte 24-48 h nella history', () => {
  const NOW = Date.parse('2026-10-04T12:00:00.000Z');
  const LONG = 'x'.repeat(200);
  const complete = {
    sourceLang: 'de',
    title: 'Physiotherapeut/in Stationär mit Fachverantwortung Neurologie',
    description: LONG,
    company: 'ZURZACH Care',
    titleByLocale: {
      de: 'Physiotherapeut/in Stationär mit Fachverantwortung Neurologie',
      it: 'Fisioterapista di reparto con responsabilità in neurologia',
      en: 'Physiotherapist, inpatient, responsible for neurology',
      fr: 'Physiothérapeute hospitalier, responsable neurologie',
    },
    descriptionByLocale: { de: LONG, it: `${LONG}it`, en: `${LONG}en`, fr: `${LONG}fr` },
  };
  const seen = (hoursAgo: number) => new Date(NOW - hoursAgo * HOUR).toISOString();

  it('conta solo gli annunci visti fra 24 e 48 ore prima, e fra loro i complete', () => {
    const jobs = [
      { ...complete, url: 'a', firstSeenAt: seen(30) },
      { ...complete, url: 'b', firstSeenAt: seen(47), titleByLocale: { de: 'x' } },
      { ...complete, url: 'c', firstSeenAt: seen(12) },
      { ...complete, url: 'd', firstSeenAt: seen(50) },
      { ...complete, url: 'e' },
    ];
    const counters = mergeCounters(emptyCounters(), summarizeJobs(jobs, { now: NOW }));
    const entry = finalizeEntry(counters, { label: 'after', now: NOW, predicateVersion: '0123456789abcdef' });
    expect(entry.freshCohort).toEqual({ window: '24-48h', total: 2, complete: 1 });
    expect(entry.predicateVersion).toBe('0123456789abcdef');
    const text = formatReport(entry).join('\n');
    expect(text).toContain('Complete, first seen 24-48h:');
    expect(text).toContain('0123456789abcdef');
  });

  it('senza impronta la riga dice null, non una stringa vuota', () => {
    expect(finalizeEntry(emptyCounters(), { label: 'after', now: NOW }).predicateVersion).toBeNull();
  });

  it('la riga scritta dal logger è letta dal monitor', () => {
    const counters = summarizeJobs([{ ...complete, url: 'a', firstSeenAt: seen(30) }], { now: NOW });
    const entry = finalizeEntry(counters, { label: 'after', now: NOW, timestamp: new Date(NOW).toISOString(), predicateVersion: 'v' });
    const [row] = coverageSeries([entry]);
    expect(row.predicateVersion).toBe('v');
    expect(row.freshCohort).toEqual({ window: '24-48h', total: 1, complete: 1 });
  });

  it('anche la serie di observability, contata con lo stesso predicato, porta la stessa impronta', () => {
    const v = currentPredicateVersion({ isIncomplete, helpers: { normalizeForLengthComparison }, root: ROOT });
    const snap = createTranslationObservabilitySnapshot([{ ...complete, url: 'a' }], { now: NOW });
    expect(snap.metrics.predicateVersion).toBe(v);
  });

  it('la history committata resta leggibile dal monitor', () => {
    const history = JSON.parse(fs.readFileSync(path.join(ROOT, 'data/translation-stats-history.json'), 'utf8'));
    expect(coverageSeries(history).length).toBeGreaterThan(0);
  });
});
