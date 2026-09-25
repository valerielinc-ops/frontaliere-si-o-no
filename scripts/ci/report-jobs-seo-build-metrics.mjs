#!/usr/bin/env node
/**
 * Parse and report the jobs SEO memory/bridge checkpoints emitted by
 * jobsSeoPagesPlugin.
 *
 * Production uses this in full-corpus mode. The matrix experiment uses the
 * same parser in report-only mode because its sampled and stop-after runs are
 * useful measurements but are not production evidence.
 */
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ANSI_RE = /\u001b\[[0-?]*[ -\/]*[@-~]/gu;
const MARKER_RE = /^\[(?:mem|jobs-seo-profile|jobs-seo-sample|build-stop-after|incremental-manifest|post-walk|jobs-seo-reuse)/u;
const MEMORY_RE = /^\[mem\]\s+jobsSeoPages:\s+(.+?)\s+heapUsed=(\d+(?:\.\d+)?)MB\b[\s\S]*?\brss=(\d+(?:\.\d+)?)MB\b/u;
const PROFILE_RE = /^\[jobs-seo-profile\]\s+(\S+)\s+(.+)$/u;
const SAMPLE_RE = /^\[jobs-seo-sample\](?:\s|$)/u;
const STOP_AFTER_RE = /^\[build-stop-after\](?:\s|$)/u;

const REQUIRED_BRIDGE_PROFILES = [
  'previous-slug-bridge',
  'previous-slug-bridge-legacy-ti',
];

function numericField(fields, key) {
  const raw = fields[key];
  if (raw === undefined) return null;
  const match = String(raw).match(/^-?\d+(?:\.\d+)?/u);
  return match ? Number(match[0]) : null;
}

function parseFields(line) {
  const fields = {};
  const fieldRe = /\b([A-Za-z][A-Za-z0-9_]*)=([^\s()]+)/gu;
  for (const match of line.matchAll(fieldRe)) fields[match[1]] = match[2];
  return fields;
}

function parseProfileLine(line) {
  const match = PROFILE_RE.exec(line);
  if (!match) return null;

  // The profiler emits: count total_ms % avg_ms p50_ms p99_ms min_ms max_ms.
  // Keep the percentage even though the validator currently needs only count
  // and total_ms; parsing the emitted schema here prevents silent column drift.
  const values = match[2].trim().split(/\s+/u).map(Number);
  if (values.length !== 8 || values.some((value) => !Number.isFinite(value))) return null;
  const [count, totalMs, percent, avgMs, p50Ms, p99Ms, minMs, maxMs] = values;
  if (!Number.isInteger(count) || count < 0) return null;

  return {
    category: match[1],
    count,
    totalMs,
    percent,
    avgMs,
    p50Ms,
    p99Ms,
    minMs,
    maxMs,
    line,
  };
}

function phaseMatches(memory, prefix) {
  return memory?.phase === prefix || memory?.phase.startsWith(`${prefix} `);
}

function lastMatchingMemory(memories, prefix) {
  return [...memories].reverse().find((memory) => phaseMatches(memory, prefix)) ?? null;
}

/** Parse one build log into data-only structures used by CI and tests. */
export function parseJobsSeoBuildLog(input) {
  const normalized = String(input ?? '').replace(ANSI_RE, '');
  const lines = normalized.split(/\r?\n/u);
  const markerLines = lines.filter((line) => MARKER_RE.test(line));
  const memories = [];
  const profiles = new Map();
  let sampleMarkers = 0;
  let stopAfterMarkers = 0;

  for (const line of lines) {
    if (SAMPLE_RE.test(line)) sampleMarkers += 1;
    if (STOP_AFTER_RE.test(line)) stopAfterMarkers += 1;

    const memoryMatch = MEMORY_RE.exec(line);
    if (memoryMatch) {
      const fields = parseFields(line);
      memories.push({
        phase: memoryMatch[1].trim(),
        heapUsedMb: Number(memoryMatch[2]),
        rssMb: Number(memoryMatch[3]),
        fields,
        validJobs: numericField(fields, 'validJobs'),
        bridgeCount: numericField(fields, 'bridgeCount'),
        previousSlugEntries: numericField(fields, 'previousSlugEntries'),
        releasedValidJobs: numericField(fields, 'releasedValidJobs'),
        releasedJobHtmlCache: numericField(fields, 'releasedJobHtmlCache'),
        releasedRelatedIndexes: numericField(fields, 'releasedRelatedIndexes'),
        line,
      });
      continue;
    }

    const profile = parseProfileLine(line);
    if (profile) profiles.set(profile.category, profile);
  }

  return {
    logPresent: normalized.trim().length > 0,
    normalized,
    markerLines,
    memories,
    profiles,
    sampleMarkers,
    stopAfterMarkers,
    activePages: lastMatchingMemory(memories, 'after-active-pages'),
    previousSlugBridges: lastMatchingMemory(memories, 'after-previous-slug-bridges'),
    corpusRelease: lastMatchingMemory(memories, 'after corpus-release'),
  };
}

/**
 * Validate the minimum evidence needed to call a production run a full-corpus
 * jobs SEO measurement. This checks observability and bridge coverage; it
 * deliberately does not turn the historical 2 GB improvement target into a
 * deploy threshold. A missed improvement remains a root-cause/revert signal,
 * not proof that the build log is invalid.
 */
export function validateFullCorpusMeasurement(report) {
  const errors = [];
  const active = report.activePages;
  const bridges = report.previousSlugBridges;
  const release = report.corpusRelease;

  if (!report.logPresent) errors.push('build log is empty or missing');
  if (report.sampleMarkers > 0) {
    errors.push(`[jobs-seo-sample] marker present (${report.sampleMarkers}); this is not a full-corpus run`);
  }
  if (report.stopAfterMarkers > 0) {
    errors.push(`[build-stop-after] marker present (${report.stopAfterMarkers}); this is not a complete production run`);
  }

  if (!active) {
    errors.push('jobsSeoPages: after-active-pages marker is missing');
  } else {
    if (!Number.isInteger(active.validJobs) || active.validJobs <= 0) {
      errors.push('after-active-pages has no positive validJobs population');
    }
    if (!Number.isFinite(active.heapUsedMb) || !Number.isFinite(active.rssMb)) {
      errors.push('after-active-pages has incomplete heapUsed/rss memory fields');
    }
  }

  if (!bridges) {
    errors.push('jobsSeoPages: after-previous-slug-bridges marker is missing');
  } else {
    if (!Number.isInteger(bridges.bridgeCount) || bridges.bridgeCount <= 0) {
      errors.push('after-previous-slug-bridges has no positive bridgeCount');
    }
    // previousSlugEntries counts previous-slug URLs advertised in
    // sitemap-jobs.xml, not emitted bridges. The plugin renders every bridge
    // but keeps INCLUDE_PREV_SLUG_SITEMAP_ENTRIES = false (since #645), so a
    // healthy production build reports 0 here. Bridge coverage is proven by
    // bridgeCount above; this field only has to be observable. Requiring it
    // to be positive failed every production deploy (run 36065965021).
    if (!Number.isInteger(bridges.previousSlugEntries) || bridges.previousSlugEntries < 0) {
      errors.push('after-previous-slug-bridges has no previousSlugEntries field (expected a non-negative integer)');
    }
  }

  for (const category of REQUIRED_BRIDGE_PROFILES) {
    const profile = report.profiles.get(category);
    if (!profile) {
      errors.push(`[jobs-seo-profile] ${category} row is missing`);
    } else if (!Number.isInteger(profile.count) || profile.count <= 0) {
      errors.push(`[jobs-seo-profile] ${category} has no positive count`);
    } else if (!Number.isFinite(profile.totalMs) || profile.totalMs < 0) {
      errors.push(`[jobs-seo-profile] ${category} has an invalid total_ms`);
    }
  }

  if (!release) {
    errors.push('jobsSeoPages: after corpus-release marker is missing');
  } else {
    for (const [key, label] of [
      ['releasedValidJobs', 'validJobs'],
      ['releasedJobHtmlCache', 'jobHtmlCache'],
      ['releasedRelatedIndexes', 'related indexes'],
    ]) {
      if (release[key] !== 1) errors.push(`after corpus-release did not release ${label} (expected ${key}=1)`);
    }
  }

  return { ok: errors.length === 0, errors };
}

function formatMetric(value, suffix = '') {
  return value === null || value === undefined || Number.isNaN(value) ? '?' : `${value}${suffix}`;
}

function escapeTableCell(value) {
  return String(value).replace(/\|/gu, '&#124;');
}

function profileMetric(report, category, field, suffix = '') {
  return formatMetric(report.profiles.get(category)?.[field], suffix);
}

/** Render the bounded marker artifact consumed by humans and later audits. */
export function renderMarkerFile(report, {
  buildLog = '?',
  wallSeconds = '?',
  stopAfter = '',
} = {}) {
  const lines = [
    `build-log=${buildLog}`,
    `wall-time-build=${wallSeconds || '?'}s`,
  ];
  if (stopAfter) {
    lines.push(`build-stop-after=${stopAfter}`);
    lines.push(`wall-time-build-status=stopped after ${stopAfter}`);
  }
  if (report.markerLines.length > 0) lines.push(...report.markerLines);
  else lines.push(`[markers] build log missing or no selected markers: ${buildLog}`);
  return `${lines.join('\n')}\n`;
}

export function renderSummary(report, {
  label = 'jobs SEO',
  wallSeconds = '?',
  stopAfter = '',
  validation = null,
} = {}) {
  const active = report.activePages;
  const bridges = report.previousSlugBridges;
  const release = report.corpusRelease;
  const population = active?.validJobs ?? null;
  const fullCorpus = report.sampleMarkers === 0
    && report.stopAfterMarkers === 0
    && population !== null
    && population > 0;
  const validationText = validation
    ? (validation.ok ? 'PASS' : `FAIL: ${validation.errors.join('; ')}`)
    : 'report-only';
  const rows = [
    ['wall-time build', `${wallSeconds || '?'}s${stopAfter ? ` (stopped after ${stopAfter})` : ''}`],
    ['full-corpus population', fullCorpus ? `${population} validJobs (no sample/stop marker)` : `not proven (${population ?? '?'})`],
    ['after-active-pages heapUsed/rss', active ? `${active.heapUsedMb}MB / ${active.rssMb}MB` : '?'],
    ['previous-slug checkpoint', bridges ? `${bridges.bridgeCount ?? '?'} bridges / ${bridges.previousSlugEntries ?? '?'} sitemap entries` : '?'],
    ['previous-slug-bridge count / total', `${profileMetric(report, 'previous-slug-bridge', 'count')} / ${profileMetric(report, 'previous-slug-bridge', 'totalMs', 'ms')}`],
    ['previous-slug-bridge-legacy-ti count / total', `${profileMetric(report, 'previous-slug-bridge-legacy-ti', 'count')} / ${profileMetric(report, 'previous-slug-bridge-legacy-ti', 'totalMs', 'ms')}`],
    ['after corpus-release heapUsed/rss', release ? `${release.heapUsedMb}MB / ${release.rssMb}MB` : '?'],
    ['corpus release flags', release
      ? `validJobs=${formatMetric(release.releasedValidJobs)} jobHtmlCache=${formatMetric(release.releasedJobHtmlCache)} relatedIndexes=${formatMetric(release.releasedRelatedIndexes)}`
      : '?'],
    ['full-corpus validation', validationText],
  ];

  const output = [
    `### Jobs SEO build metrics — ${label}`,
    '',
    '| metric | value |',
    '|---|---|',
    ...rows.map(([metric, value]) => `| ${escapeTableCell(metric)} | ${escapeTableCell(value)} |`),
    '',
  ];

  if (validation && !validation.ok) {
    output.push('Validation failures:', ...validation.errors.map((error) => `- ${error}`), '');
  }

  if (report.markerLines.length > 0) {
    output.push('Selected raw markers:', '', '```text', ...report.markerLines, '```', '');
  }

  return `${output.join('\n')}\n`;
}

function parseArgs(argv) {
  const args = {
    logPath: null,
    markersOut: null,
    summaryLabel: 'jobs SEO',
    wallSeconds: '?',
    stopAfter: '',
    requireFullCorpus: false,
    reportOnly: false,
  };

  for (const arg of argv) {
    if (arg === '--help' || arg === '-h') args.help = true;
    else if (arg === '--require-full-corpus') args.requireFullCorpus = true;
    else if (arg === '--report-only') args.reportOnly = true;
    else if (arg.startsWith('--markers-out=')) args.markersOut = arg.slice('--markers-out='.length);
    else if (arg.startsWith('--summary-label=')) args.summaryLabel = arg.slice('--summary-label='.length);
    else if (arg.startsWith('--wall-seconds=')) args.wallSeconds = arg.slice('--wall-seconds='.length) || '?';
    else if (arg.startsWith('--stop-after=')) args.stopAfter = arg.slice('--stop-after='.length);
    else if (!arg.startsWith('--') && args.logPath === null) args.logPath = arg;
    else throw new Error(`unknown argument: ${arg}`);
  }

  args.logPath ??= path.join(process.env.RUNNER_TEMP || process.cwd(), 'build.log');
  return args;
}

function usage() {
  return [
    'Uso: node scripts/ci/report-jobs-seo-build-metrics.mjs <build.log> [opzioni]',
    '  --markers-out=<file>       scrive il referto marker normalizzato',
    '  --summary-label=<label>    intestazione del riepilogo Actions',
    '  --wall-seconds=<n>         durata della build',
    '  --stop-after=<phase>       annota un esperimento troncato',
    '  --report-only              non applica il gate full-corpus',
    '  --require-full-corpus      fallisce se la prova full-corpus e incompleta',
  ].join('\n');
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(usage());
    return;
  }

  const logPresent = existsSync(args.logPath);
  const log = logPresent ? readFileSync(args.logPath, 'utf8') : '';
  const report = parseJobsSeoBuildLog(log);
  const validation = args.requireFullCorpus && !args.reportOnly
    ? validateFullCorpusMeasurement(report)
    : null;

  if (args.markersOut) {
    writeFileSync(args.markersOut, renderMarkerFile(report, {
      buildLog: args.logPath,
      wallSeconds: args.wallSeconds,
      stopAfter: args.stopAfter,
    }));
  }

  const summary = renderSummary(report, {
    label: args.summaryLabel,
    wallSeconds: args.wallSeconds,
    stopAfter: args.stopAfter,
    validation,
  });
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, summary);
  process.stdout.write(summary);

  if (validation && !validation.ok) {
    console.error(`[report-jobs-seo-build-metrics] FAIL: ${validation.errors.join('; ')}`);
    process.exitCode = 1;
  } else if (validation) {
    console.log('[report-jobs-seo-build-metrics] PASS: full-corpus jobs SEO evidence is complete');
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  try {
    main();
  } catch (error) {
    console.error(`[report-jobs-seo-build-metrics] FAIL: ${error?.message || error}`);
    process.exitCode = 1;
  }
}
