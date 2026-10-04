import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Ratchet: a loop exporter must not read a source the repository itself has
 * switched off. PostHog product events are hard-stopped when
 * `POSTHOG_EVENT_SAMPLE_RATE` is zero (`services/posthogQuota.ts`); a HogQL
 * count over a non-exempt event then succeeds and returns zero, which a loop
 * reads as a real measurement (L1 reported `usefulSessions: 0` for two weeks).
 *
 * While the rate is <= 0 every `scripts/ci/export-*.mjs` that queries PostHog
 * must be listed below with the card that migrates it and the reason it may
 * still run. An entry whose file no longer queries PostHog is stale and fails
 * too, so the list can only shrink.
 *
 * Failure title: "Loop export: lettore PostHog non registrato con campionamento a zero".
 */
const KNOWN_POSTHOG_READERS: Record<string, { scheda: string; motivo: string }> = {
  'export-l7-experiment-outcomes.mjs': {
    scheda: 'NX-09',
    motivo: 'L7 reads PostHog only when data/experiments/active-experiments.json declares an experiment, and today it declares none; the first entry must move the reader to GA4 (rule below)',
  },
  'export-l8-affiliate-outcomes.mjs': {
    scheda: 'L8 (no open issue)',
    motivo: 'eventi affiliate non esenti, da migrare quando L8 riporta esposizioni',
  },
};

const EXPORT_DIR = path.resolve('scripts/ci');
const ACTIVE_EXPERIMENTS_PATH = path.resolve('data/experiments/active-experiments.json');
const L7_EXPORTER = 'export-l7-experiment-outcomes.mjs';
const QUOTA_PATH = path.resolve('services/posthogQuota.ts');

function readPostHogQuota(source: string) {
  const rate = source.match(/export const POSTHOG_EVENT_SAMPLE_RATE\s*=\s*([0-9.]+)\s*;/);
  const exemptBlock = source.match(/export const POSTHOG_QUOTA_EXEMPT_EVENTS\s*=\s*Object\.freeze\(\[([\s\S]*?)\]/);
  const exemptEvents = exemptBlock
    ? [...exemptBlock[1].replace(/\/\/.*$/gm, '').matchAll(/'([^']+)'/g)].map((match) => match[1])
    : [];
  return { sampleRate: rate ? Number(rate[1]) : Number.NaN, exemptEvents };
}

function queriesPostHog(source: string) {
  return /\brunHogQL\(/.test(source) || /from\s+['"][^'"]*posthog-client(?:\.mjs)?['"]/.test(source);
}

/** Best-effort list of event names a HogQL query in the file filters on (diagnostic only). */
function queriedEvents(source: string) {
  const events = new Set<string>();
  for (const match of source.matchAll(/\bevent\s*(?:=|IN\s*\()\s*['"]([^'"]+)['"]/g)) {
    if (!match[1].includes('${')) events.add(match[1]);
  }
  for (const match of source.matchAll(/quoteHogQLString\(\s*'([^']+)'\s*\)/g)) events.add(match[1]);
  return [...events];
}

function findPostHogReaderViolations({
  files,
  sampleRate,
  exemptEvents,
  known,
}: {
  files: Record<string, string>;
  sampleRate: number;
  exemptEvents: string[];
  known: Record<string, unknown>;
}) {
  const violations: string[] = [];
  const readers = Object.keys(files).filter((name) => queriesPostHog(files[name]));
  if (sampleRate <= 0) {
    for (const name of readers) {
      if (Object.prototype.hasOwnProperty.call(known, name)) continue;
      const nonExempt = queriedEvents(files[name]).filter((event) => !exemptEvents.includes(event));
      violations.push(
        `${name} queries PostHog while POSTHOG_EVENT_SAMPLE_RATE = ${sampleRate}`
        + ` (non-exempt events: ${nonExempt.length ? nonExempt.join(', ') : 'not statically resolvable'});`
        + ' read the source from GA4 or register the file in KNOWN_POSTHOG_READERS with its card and reason',
      );
    }
  }
  for (const name of Object.keys(known)) {
    if (!(name in files)) {
      violations.push(`${name} is listed in KNOWN_POSTHOG_READERS but does not exist: remove the entry`);
    } else if (!queriesPostHog(files[name])) {
      violations.push(`${name} no longer queries PostHog: remove its KNOWN_POSTHOG_READERS entry`);
    }
  }
  return violations;
}

function activeExperimentReaderViolations(experiments: Array<{ experimentId?: string }>, known: Record<string, unknown>) {
  if (!experiments.length || !Object.prototype.hasOwnProperty.call(known, L7_EXPORTER)) return [];
  return experiments.map((entry) => `${entry.experimentId ?? 'an experiment'} is declared active while ${L7_EXPORTER}`
    + ' is still a registered PostHog reader: move the L7 reader to GA4 and drop its KNOWN_POSTHOG_READERS entry');
}

function readExporters() {
  return Object.fromEntries(
    fs.readdirSync(EXPORT_DIR)
      .filter((name) => /^export-.*\.mjs$/.test(name))
      .map((name) => [name, fs.readFileSync(path.join(EXPORT_DIR, name), 'utf8')]),
  );
}

describe('loop exporters read only live sources', () => {
  const quota = readPostHogQuota(fs.readFileSync(QUOTA_PATH, 'utf8'));

  it('parses the PostHog quota contract instead of silently skipping it', () => {
    expect(Number.isFinite(quota.sampleRate)).toBe(true);
    expect(quota.exemptEvents).toContain('$snapshot');
  });

  it('allows no unregistered PostHog reader while product events are hard-stopped, and no stale entry', () => {
    const files = readExporters();
    expect(Object.keys(files).length).toBeGreaterThan(0);
    expect(findPostHogReaderViolations({ files, ...quota, known: KNOWN_POSTHOG_READERS })).toEqual([]);
    for (const entry of Object.values(KNOWN_POSTHOG_READERS)) {
      expect(entry.scheda.trim().length).toBeGreaterThan(0);
      expect(entry.motivo.trim().length).toBeGreaterThan(20);
    }
  });

  it('lets the L7 reader stay on PostHog only while no experiment is declared active', () => {
    // An experiment declared active must be measured on a live source: the
    // L7 entry above is tolerated only while L7 is idle and never queries.
    // Failure title: "L7: esperimento attivo senza emettitore o senza sorgente viva".
    const { experiments } = JSON.parse(fs.readFileSync(ACTIVE_EXPERIMENTS_PATH, 'utf8'));
    expect(Array.isArray(experiments)).toBe(true);
    expect(activeExperimentReaderViolations(experiments, KNOWN_POSTHOG_READERS)).toEqual([]);
    expect(activeExperimentReaderViolations([{ experimentId: 'g4' }], { [L7_EXPORTER]: {} }))
      .toEqual([expect.stringContaining('g4 is declared active')]);
    expect(activeExperimentReaderViolations([{ experimentId: 'g4' }], {})).toEqual([]);
  });

  it('turns red on a new PostHog reader at a zero rate and on a stale entry', () => {
    const files = {
      'export-new.mjs': "import { runHogQL } from '../lib/posthog-client.mjs';\nrunHogQL(\"SELECT count() FROM events WHERE event = '$pageview'\");",
      'export-ga4.mjs': 'export const ok = true;',
    };
    const violations = findPostHogReaderViolations({
      files,
      sampleRate: 0,
      exemptEvents: quota.exemptEvents,
      known: { 'export-ga4.mjs': {} },
    });
    expect(violations).toEqual([
      expect.stringContaining('export-new.mjs queries PostHog while POSTHOG_EVENT_SAMPLE_RATE = 0 (non-exempt events: $pageview)'),
      expect.stringContaining('export-ga4.mjs no longer queries PostHog'),
    ]);
    // With sampling back on, a reader needs no entry; stale entries still fail.
    expect(findPostHogReaderViolations({ files, sampleRate: 0.1, exemptEvents: quota.exemptEvents, known: {} })).toEqual([]);
  });
});
