/**
 * job-translation-queue — the population both locale ratchets skip on purpose.
 *
 * WHY IT NEEDS ITS OWN TEST. `measureDescriptionLocales` excludes
 * `needsRetranslation` jobs from the DEFECT count with a stated justification:
 * "queued slots are expected to hold source-language fallbacks until
 * translate-pending processes them". The justification is sound for a quality
 * rate and load-bearing for its stability — but it contains an assumption
 * ("until") that nothing checked. A job that is queued and STAYS queued serves
 * German text on an Italian page every day it sits there, and until this
 * measurement no number counted it: not the rate (skipped), not
 * `MIN_SERVED_SHARE` (a catastrophe floor at 20%, against 42% queued), not
 * `QUEUE_AGE_ALERT_DAYS` (the age of the single oldest job, 127d against a 150d
 * ratchet — correctly quiet while 371 jobs were stale).
 *
 * NO DATASET, NO CLOCK. Every fixture is synthetic and `now` is injected, so
 * this runs in a sparse worktree and cannot rot on a calendar boundary — the
 * `daysAgo()` discipline AGENTS.md requires of pipeline fixtures.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { parseDocument } from 'yaml';
import {
  QUEUE_STALE_DAYS,
  measureTranslationQueue,
} from '../scripts/audit-job-description-locale.mjs';

const NOW = Date.parse('2026-08-19T00:00:00Z');
const daysAgo = (n: number) => new Date(NOW - n * 86_400_000).toISOString();

/** 120+ chars, the floor the audit shares with the gate. */
const GERMAN = 'Als Masterdata Specialist sind Sie verantwortlich für die Pflege, Qualität und '
  + 'Weiterentwicklung unserer Produkt- und Materialstammdaten in einem dynamischen Umfeld.';
const ITALIAN = 'In qualità di Masterdata Specialist sei responsabile della cura, della qualità e '
  + 'dello sviluppo dei nostri dati anagrafici di prodotto e materiale in un contesto dinamico.';

type Job = Record<string, unknown>;

function job(overrides: Job = {}): Job {
  return {
    company: 'Rado Watch Co. Ltd.',
    companyKey: 'rado',
    slug: 'masterdata-specialista-60-rado',
    sourceLang: 'de',
    needsRetranslation: true,
    firstSeenAt: daysAgo(30),
    descriptionByLocale: { de: GERMAN, it: GERMAN, en: GERMAN, fr: GERMAN },
    ...overrides,
  };
}

const measure = (jobs: Job[]) => measureTranslationQueue(jobs, { now: NOW });

const JOBS_DATA_PIPELINE_GROUP = 'jobs-data-pipeline';
const WORKFLOWS_DIR = '.github/workflows';
const PORTABLE_TRANSLATE_WORKFLOW = '.github/corpus-workflows/translate-pending.yml';

function workflowConfig(workflowPath: string): Record<string, unknown> {
  const document = parseDocument(readFileSync(workflowPath, 'utf8'), { prettyErrors: true, uniqueKeys: true });
  if (document.errors.length > 0) {
    throw new Error(`Invalid workflow YAML in ${workflowPath}: ${document.errors.map(String).join('; ')}`);
  }

  const workflow = document.toJS();
  if (workflow === null || typeof workflow !== 'object' || Array.isArray(workflow)) {
    throw new Error(`Workflow ${workflowPath} must be a YAML mapping`);
  }

  return workflow as Record<string, unknown>;
}

function concurrencyConfig(workflowPath: string): Record<string, unknown> {
  const concurrency = workflowConfig(workflowPath).concurrency;
  if (concurrency === null || typeof concurrency !== 'object' || Array.isArray(concurrency)) {
    throw new Error(`Workflow ${workflowPath} must define concurrency as a YAML mapping`);
  }

  return concurrency as Record<string, unknown>;
}

/**
 * Textual mention, unlike strict `group === JOBS_DATA_PIPELINE_GROUP`: catches a
 * `group` built from a GH expression (`${{ ... }}`) that resolves to the same
 * queue at runtime but is a different literal string at YAML-parse time, which
 * the strict-equality inventory below would silently miss.
 */
function concurrencyMentionsJobsDataPipeline(workflowPath: string): boolean {
  const concurrency = workflowConfig(workflowPath).concurrency;
  if (concurrency === null || typeof concurrency !== 'object' || Array.isArray(concurrency)) {
    return false;
  }

  return JSON.stringify(concurrency).includes(JOBS_DATA_PIPELINE_GROUP);
}

describe('measureTranslationQueue', () => {
  it('keeps every jobs-data-pipeline workflow queued without cancellation', () => {
    const matchingWorkflows = readdirSync(WORKFLOWS_DIR)
      .filter((name) => /\.ya?ml$/.test(name))
      .sort()
      .map((name) => join(WORKFLOWS_DIR, name))
      .filter((workflowPath) => {
        const concurrency = workflowConfig(workflowPath).concurrency;
        return concurrency !== null
          && typeof concurrency === 'object'
          && !Array.isArray(concurrency)
          && (concurrency as Record<string, unknown>).group === JOBS_DATA_PIPELINE_GROUP;
      });

    expect(matchingWorkflows.sort()).toEqual([
      '.github/workflows/backfill-expired-from-history.yml',
      '.github/workflows/cleanup-stale-jobs.yml',
      '.github/workflows/sync-gsc-orphans.yml',
      '.github/workflows/translate-pending.yml',
    ]);

    // Fail closed: any workflow whose concurrency block mentions the group
    // string at all — literal or inside a `${{ }}` expression — must be one
    // of the ones already covered by strict equality above. A workflow that
    // shows up here but not in `matchingWorkflows` would resolve to the same
    // queue at runtime while evading the strict-equality inventory.
    const mentioningWorkflows = readdirSync(WORKFLOWS_DIR)
      .filter((name) => /\.ya?ml$/.test(name))
      .sort()
      .map((name) => join(WORKFLOWS_DIR, name))
      .filter(concurrencyMentionsJobsDataPipeline);

    expect(mentioningWorkflows.sort()).toEqual(matchingWorkflows.sort());

    for (const workflowPath of [...matchingWorkflows, PORTABLE_TRANSLATE_WORKFLOW]) {
      const concurrency = concurrencyConfig(workflowPath);
      expect(concurrency.group).toBe(JOBS_DATA_PIPELINE_GROUP);
      expect(concurrency['cancel-in-progress']).toBe(false);
      expect(concurrency.queue).toBe('max');
    }
  });

  it('counts a queued job whose target slots are byte-identical to the source', () => {
    const q = measure([job()]);
    expect(q.queuedJobs).toBe(1);
    expect(q.sourceCopyJobs).toBe(1);
    expect(q.staleSourceCopyJobs).toBe(1);
    expect(q.samples[0]).toMatchObject({
      companyKey: 'rado', sourceLang: 'de', waitedDays: 30,
    });
    expect(q.samples[0].copiedLocales.sort()).toEqual(['en', 'fr', 'it']);
  });

  it('does not count a job that was actually translated', () => {
    const q = measure([job({ descriptionByLocale: { de: GERMAN, it: ITALIAN, en: ITALIAN, fr: ITALIAN } })]);
    expect(q.queuedJobs).toBe(1);
    expect(q.sourceCopyJobs).toBe(0);
    expect(q.staleSourceCopyJobs).toBe(0);
  });

  it('counts a partial translation — one copied slot is one served defect', () => {
    const q = measure([job({ descriptionByLocale: { de: GERMAN, it: GERMAN, en: ITALIAN, fr: ITALIAN } })]);
    expect(q.sourceCopyJobs).toBe(1);
    expect(q.samples[0].copiedLocales).toEqual(['it']);
  });

  it('ignores whitespace: a re-wrapped copy is still a copy', () => {
    const rewrapped = GERMAN.replace(/ /g, '\n  ');
    const q = measure([job({ descriptionByLocale: { de: GERMAN, it: rewrapped, en: ITALIAN, fr: ITALIAN } })]);
    expect(q.sourceCopyJobs).toBe(1);
  });

  it('leaves jobs that are not queued alone — this measures the QUEUE, not quality', () => {
    // Byte-identical AND old, but the pipeline is not holding it: that is the
    // ratchet's population, and double-counting it here would make the two
    // numbers argue with each other.
    const q = measure([job({ needsRetranslation: false })]);
    expect(q.queuedJobs).toBe(0);
    expect(q.sourceCopyJobs).toBe(0);
  });

  it('separates fresh churn from a stuck queue at the stale threshold', () => {
    const fresh = job({ firstSeenAt: daysAgo(QUEUE_STALE_DAYS - 1) });
    const stale = job({ firstSeenAt: daysAgo(QUEUE_STALE_DAYS + 1) });
    const q = measure([fresh, stale]);
    expect(q.sourceCopyJobs).toBe(2);
    // Both are serving source text; only one has been passed over long enough
    // to mean the queue is not draining for it.
    expect(q.staleSourceCopyJobs).toBe(1);
    expect(q.oldestStaleDays).toBe(QUEUE_STALE_DAYS + 1);
  });

  it('buckets by wait so a stuck tail is visible next to normal churn', () => {
    const q = measure([
      job({ firstSeenAt: daysAgo(1) }),
      job({ firstSeenAt: daysAgo(20) }),
      job({ firstSeenAt: daysAgo(60) }),
      job({ firstSeenAt: daysAgo(200) }),
      job({ firstSeenAt: undefined, crawledAt: undefined }),
    ]);
    expect(q.byAge).toEqual({ '0-7d': 1, '8-30d': 1, '31-90d': 1, '>90d': 1, unknown: 1 });
    // A job with no usable timestamp is counted and bucketed, never silently
    // dropped: an unknown age is a reporting gap, not evidence of freshness.
    expect(q.sourceCopyJobs).toBe(5);
    expect(q.staleSourceCopyJobs).toBe(3);
  });

  it('falls back to crawledAt when firstSeenAt is absent', () => {
    const q = measure([job({ firstSeenAt: undefined, crawledAt: daysAgo(45) })]);
    expect(q.staleSourceCopyJobs).toBe(1);
    expect(q.samples[0].waitedDays).toBe(45);
  });

  it('skips a source description under the shared 120-char floor', () => {
    const short = 'Kurze Beschreibung.';
    const q = measure([job({ descriptionByLocale: { de: short, it: short, en: short, fr: short } })]);
    expect(q.queuedJobs).toBe(1);
    expect(q.sourceCopyJobs).toBe(0);
  });

  it('names the crawlers the backlog concentrates in', () => {
    const q = measure([
      job({ company: 'Roche', companyKey: 'roche' }),
      job({ company: 'Roche', companyKey: 'roche' }),
      job({ company: 'Sulzer', companyKey: 'sulzer' }),
    ]);
    expect(q.topCompanies).toEqual([
      { key: 'Roche', count: 2 },
      { key: 'Sulzer', count: 1 },
    ]);
  });

  it('does not measure the location dimension unless a predicate is injected', () => {
    // The real predicate reads data/canton-municipalities.json at module scope.
    // Not importing it is what lets this whole measurement run in a sparse
    // worktree — so its absence must read as "not measured", never as "0
    // foreign jobs", which would be a health claim nobody made.
    const q = measure([job({ location: 'Shanghai' })]);
    expect(q.staleNonSwissMeasured).toBe(false);
    expect(q.staleNonSwiss).toBe(0);
    expect(q.topLocations).toEqual([]);
  });

  it('counts and ranks the non-Swiss locations when a predicate is injected', () => {
    // Real shape: 357 of the 376 stale jobs measured on 2026-08-19 sit outside
    // Switzerland — Shanghai 35, Madrid 32, Petaling Jaya 14. Those postings
    // earn no cross-border traffic, so the traffic-first queue ordering never
    // reaches them, which is why they are stuck rather than merely slow.
    const isSwissLocation = (loc: string) => ['Lugano', 'Basel', 'Rotkreuz'].includes(loc);
    const q = measureTranslationQueue(
      [
        job({ location: 'Shanghai' }),
        job({ location: 'Shanghai' }),
        job({ location: 'Madrid' }),
        job({ location: 'Lugano' }),
      ],
      { now: NOW, isSwissLocation },
    );
    expect(q.staleSourceCopyJobs).toBe(4);
    expect(q.staleNonSwissMeasured).toBe(true);
    expect(q.staleNonSwiss).toBe(3);
    expect(q.topLocations).toEqual([
      { key: 'Shanghai', count: 2 },
      { key: 'Madrid', count: 1 },
    ]);
  });

  it('reports an empty location as non-Swiss under its own label', () => {
    const q = measureTranslationQueue([job({ location: '' })], { now: NOW, isSwissLocation: () => false });
    expect(q.staleNonSwiss).toBe(1);
    expect(q.topLocations).toEqual([{ key: '(vuota)', count: 1 }]);
  });

  it('skips a job with no declared sourceLang instead of guessing one', () => {
    // Guessing the source slot would turn a wrong guess into a confident defect
    // count. 0 of the 11,637 queued jobs measured on 2026-08-19 lack the field,
    // so this costs nothing — it just cannot start lying later.
    const q = measure([job({ sourceLang: undefined })]);
    expect(q.queuedJobs).toBe(1);
    expect(q.sourceCopyJobs).toBe(0);
  });

  it('is empty and safe on junk input', () => {
    for (const input of [[], null, undefined, [null, {}, { needsRetranslation: true }]]) {
      const q = measureTranslationQueue(input as never, { now: NOW });
      expect(q.staleSourceCopyJobs).toBe(0);
      expect(q.samples).toEqual([]);
    }
  });

  it('caps samples so a stuck queue cannot blow the 65,536-char issue body', () => {
    const q = measure(Array.from({ length: 500 }, (_, i) => job({ slug: `job-${i}` })));
    expect(q.staleSourceCopyJobs).toBe(500);
    expect(q.samples).toHaveLength(20);
    expect(q.topCompanies).toHaveLength(1);
  });
});
