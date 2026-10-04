/**
 * Job locale slots: name the blocking records in `prep`, before the dist gate.
 *
 * `validate:translation-completeness` blocks the publish on a record whose
 * title/description slot is missing in one of the four published locales — but
 * it runs on the reassembled dist in post-deploy-validate-dist.yml, hours after
 * `prep` of deploy.yml wrote the dataset the build inherits. On 2026-10-03 the
 * gate failed on two SRG SSR records (8 `missing/short title (0 chars)` lines,
 * run 37108268564) and the only way to learn which parser produced them was to
 * download the build's `jobs-master` artifact by hand.
 *
 * This module runs the SAME blocking predicate (`collectBlockingIssues`,
 * imported, never copied: the rules live in one place) on the dataset as it
 * sits ON DISK after cleanup-jobs.mjs wrote it — what the `prepared-snapshot`
 * carries to the build — and names the crawler of each blocking record.
 *
 * It is a REPORT. It never removes, filters or rewrites a record and never
 * changes the caller's exit code: the gate that blocks is still the one on the
 * dist, with its rules. Making this blocking in `prep` would be a wider gate
 * than today's (the IT section shards are pushed by build-locale, before the
 * dist validation) and is a separate decision.
 */
import fs from 'node:fs';
import path from 'node:path';
import { collectBlockingIssues } from '../validate-translation-completeness.mjs';
import { listSliceFilePaths } from './crawler-slice-files.mjs';

export const ANNOTATION_TITLE = 'Job locale slots blocking';
export const SLUG_SAMPLE_LIMIT = 5;

/**
 * Records that the dist gate would block, each with its own issues.
 *
 * @param {object[]} jobs
 * @returns {{ job: object, issues: {slug: string, locale: string, reason: string}[] }[]}
 */
export function collectBlockedJobs(jobs) {
  const blocked = [];
  for (const job of jobs) {
    // A non-object entry would make the predicate throw and lose the whole
    // report; skip it here (the dist predicate itself stays unchanged).
    if (!job || typeof job !== 'object') continue;
    const issues = collectBlockingIssues([job]);
    if (issues.length > 0) blocked.push({ job, issues });
  }
  return blocked;
}

/** Lookup keys in order of reliability: id, then url, then slug. */
function lookupKeys(job) {
  const keys = [];
  const id = String(job?.id ?? '').trim().toLowerCase();
  if (id) keys.push(`id:${id}`);
  const url = String(job?.url ?? '').trim();
  if (url) keys.push(`url:${url}`);
  const slug = String(job?.slug ?? '').trim().toLowerCase();
  if (slug) keys.push(`slug:${slug}`);
  return keys;
}

/**
 * Map each blocked record to the slice (crawler key) that holds it.
 *
 * Assembly keeps the record `id` and `url`, while hardening may rename the
 * slug, so the lookup goes id → url → slug. The slices are read only when
 * something is blocked: on a clean dataset this costs nothing.
 *
 * @param {object[]} blockedJobs
 * @param {string} slicesDir
 * @returns {Map<object, string>} job → crawler key
 */
export function attributeCrawlerKeys(blockedJobs, slicesDir) {
  const wanted = new Map();
  for (const job of blockedJobs) {
    for (const key of lookupKeys(job)) wanted.set(key, null);
  }
  if (wanted.size === 0) return new Map();

  for (const slicePath of listSliceFilePaths(slicesDir)) {
    let slice;
    try {
      slice = JSON.parse(fs.readFileSync(slicePath, 'utf8'));
    } catch {
      continue;
    }
    const sliceJobs = Array.isArray(slice?.jobs) ? slice.jobs : (Array.isArray(slice) ? slice : []);
    const crawlerKey = String(slice?.crawlerKey || path.basename(slicePath, '.json'));
    for (const sourceJob of sliceJobs) {
      for (const key of lookupKeys(sourceJob)) {
        if (wanted.get(key) === null) wanted.set(key, crawlerKey);
      }
    }
  }

  const byJob = new Map();
  for (const job of blockedJobs) {
    const hit = lookupKeys(job).map((key) => wanted.get(key)).find(Boolean);
    if (hit) byJob.set(job, hit);
  }
  return byJob;
}

/**
 * The label a reader can act on: the slice key when the record was found in a
 * slice, otherwise the parser name the record carries in `source`.
 */
export function crawlerLabel(job, crawlerKeyByJob) {
  return crawlerKeyByJob?.get(job) || String(job?.source || '').trim() || '(unknown)';
}

/**
 * @param {{ job: object, issues: object[] }[]} blocked
 * @param {Map<object, string>} crawlerKeyByJob
 * @returns {{ crawler: string, jobs: number, issues: number, slugs: string[], reasons: string[] }[]}
 *   sorted by blocked records, descending, then crawler name
 */
export function groupBlockedByCrawler(blocked, crawlerKeyByJob) {
  const groups = new Map();
  for (const { job, issues } of blocked) {
    const crawler = crawlerLabel(job, crawlerKeyByJob);
    const group = groups.get(crawler) || { crawler, jobs: 0, issues: 0, slugs: [], reasons: new Set() };
    group.jobs += 1;
    group.issues += issues.length;
    if (group.slugs.length < SLUG_SAMPLE_LIMIT) group.slugs.push(job?.slug || '(unknown)');
    for (const issue of issues) group.reasons.add(`${issue.locale}: ${issue.reason}`);
    groups.set(crawler, group);
  }
  return [...groups.values()]
    .map((group) => ({ ...group, reasons: [...group.reasons].sort() }))
    .sort((a, b) => b.jobs - a.jobs || a.crawler.localeCompare(b.crawler));
}

/** GitHub workflow-command data escaping (`%`, CR, LF). */
export function escapeAnnotationData(value) {
  return String(value).replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A');
}

/**
 * @param {ReturnType<typeof groupBlockedByCrawler>} groups
 * @param {string} stage
 * @returns {string[]} one `::error` line per crawler
 */
export function formatAnnotations(groups, stage) {
  return groups.map((group) => {
    const more = group.jobs > group.slugs.length ? ` (+${group.jobs - group.slugs.length} more)` : '';
    const message = `crawler ${group.crawler}: ${group.jobs} job(s), ${group.issues} blocking locale slot(s) after ${stage}`
      + ` — ${group.slugs.join(', ')}${more}`;
    return `::error title=${ANNOTATION_TITLE}::${escapeAnnotationData(message)}`;
  });
}

function markdownCell(value) {
  return String(value).replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');
}

/**
 * @param {ReturnType<typeof groupBlockedByCrawler>} groups
 * @param {{ total: number, stage: string }} meta
 * @returns {string} markdown block for GITHUB_STEP_SUMMARY
 */
export function formatStepSummary(groups, { total, stage }) {
  const blockedJobs = groups.reduce((sum, group) => sum + group.jobs, 0);
  const lines = [
    `### ${ANNOTATION_TITLE} (${stage})`,
    '',
    `${blockedJobs} of ${total} job(s) would fail \`validate:translation-completeness\` on the dist. Report only: no record was removed and the exit code is unchanged.`,
    '',
    '| Crawler | Jobs | Slots | Reasons | First slugs |',
    '|---|---:|---:|---|---|',
  ];
  for (const group of groups) {
    lines.push(`| ${markdownCell(group.crawler)} | ${group.jobs} | ${group.issues} | ${markdownCell(group.reasons.join('; '))} | ${markdownCell(group.slugs.join(', '))} |`);
  }
  lines.push('');
  return lines.join('\n');
}

/**
 * Re-read the dataset from disk, run the dist gate's blocking predicate and
 * print the verdict. Never throws and never touches `process.exitCode`.
 *
 * @param {{
 *   dataJobsPath: string,
 *   slicesDir: string,
 *   stage?: string,
 *   summaryPath?: string,
 *   log?: (line: string) => void,
 * }} opts
 * @returns {{ checked: number, blockedJobs: number, groups: ReturnType<typeof groupBlockedByCrawler> } | null}
 *   null when there was nothing to read
 */
export function reportBlockingLocaleSlots({
  dataJobsPath,
  slicesDir,
  stage = 'cleanup-jobs',
  summaryPath = process.env.GITHUB_STEP_SUMMARY,
  log = (line) => console.log(line),
}) {
  try {
    if (!fs.existsSync(dataJobsPath)) return null;
    const raw = JSON.parse(fs.readFileSync(dataJobsPath, 'utf8'));
    const jobs = Array.isArray(raw) ? raw : (Array.isArray(raw?.jobs) ? raw.jobs : null);
    if (!jobs) {
      log(`::warning title=${ANNOTATION_TITLE}::${escapeAnnotationData(`${path.basename(dataJobsPath)} is not a job array — locale slots not checked`)}`);
      return null;
    }

    const blocked = collectBlockedJobs(jobs);
    if (blocked.length === 0) {
      log(`🔎 Locale slots (${stage}): 0/${jobs.length} jobs would fail validate:translation-completeness.`);
      return { checked: jobs.length, blockedJobs: 0, groups: [] };
    }

    const crawlerKeyByJob = attributeCrawlerKeys(blocked.map((entry) => entry.job), slicesDir);
    const groups = groupBlockedByCrawler(blocked, crawlerKeyByJob);
    log(`🔎 Locale slots (${stage}): ${blocked.length}/${jobs.length} jobs would fail validate:translation-completeness (report only — exit code unchanged, no record removed).`);
    for (const line of formatAnnotations(groups, stage)) log(line);
    if (summaryPath) {
      try {
        fs.appendFileSync(summaryPath, formatStepSummary(groups, { total: jobs.length, stage }));
      } catch {
        /* the summary is a convenience; the annotations above already carry the verdict */
      }
    }
    return { checked: jobs.length, blockedJobs: blocked.length, groups };
  } catch (err) {
    log(`::warning title=${ANNOTATION_TITLE}::${escapeAnnotationData(`locale slot report failed: ${err?.message || err}`)}`);
    return null;
  }
}
