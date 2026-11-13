#!/usr/bin/env node
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isInvokedDirectly } from '../lib/is-invoked-directly.mjs';
import { intFromEnv } from '../lib/int-from-env.mjs';
import { parseFanoutAutoThreshold, decideSectionTreeFanout } from '../lib/section-tree-fanout-policy.mjs';
import {
  readSectionTreeLayoutRegistry,
  registerSectionTreeFanout,
} from '../lib/section-tree-layout-registry.mjs';
import { requireWorkerSectionTreeLayout } from '../lib/section-tree-layout-stage.mjs';
import { sectionTreeLayoutSections } from '../../infra/cloudflare-worker/section-tree-layout-schema.js';

const LOCALES = Object.freeze(['it', 'en', 'de', 'fr']);
const DEFAULT_SECTION_TREE_LIMIT_BYTES = 52_428_800;
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const SECTION_SLUGS_PATH = path.join(REPO_ROOT, 'scripts/lib/section-shard-slugs.json');

function normalizeLocales(locales = LOCALES) {
  if (!Array.isArray(locales) || locales.length === 0
    || locales.some((locale) => !LOCALES.includes(locale))
    || new Set(locales).size !== locales.length) {
    throw new Error('[section-tree-layout] locales must be a non-empty unique subset of it,en,de,fr');
  }
  return locales;
}

function sectionSubPath(sectionSlugs, section, locale) {
  const slug = sectionSlugs[section]?.[locale];
  if (typeof slug !== 'string' || slug.length === 0) {
    throw new Error(`[section-tree-layout] cannot build Worker probe path for ${section}/${locale}`);
  }
  return locale === 'it' ? slug : path.posix.join(locale, slug);
}

function displayPct(value) {
  return Number(value.toFixed(2));
}

function validateMetric(metric, locale, sourceRunId, sourceRunAttempt, sourceSha, treeLimitBytes, sectionNames) {
  if (!metric || metric.version !== 1 || metric.locale !== locale
    || metric.sourceRunId !== sourceRunId || metric.sourceSha !== sourceSha
    || !Number.isSafeInteger(metric.sourceRunAttempt) || metric.sourceRunAttempt < 1
    || metric.sourceRunAttempt > sourceRunAttempt
    || metric.treeLimitBytes !== treeLimitBytes || !metric.sections || typeof metric.sections !== 'object') {
    throw new Error(`[section-tree-layout] invalid or mismatched metrics envelope for ${locale}`);
  }
  const names = Object.keys(metric.sections).sort();
  if (names.length !== sectionNames.length || names.some((name, index) => name !== sectionNames[index])) {
    throw new Error(`[section-tree-layout] metrics for ${locale} do not cover the current section set`);
  }
  for (const section of sectionNames) {
    const entry = metric.sections[section];
    if (!entry || !Number.isSafeInteger(entry.bytes) || entry.bytes < 0
      || typeof entry.pct !== 'number' || !Number.isFinite(entry.pct) || entry.pct < 0
      || Math.abs(entry.pct - (entry.bytes * 100 / treeLimitBytes)) > 1e-10) {
      throw new Error(`[section-tree-layout] invalid metric for ${section}/${locale}`);
    }
  }
  return metric;
}

export async function loadSectionTreeLayoutMetricsFromArtifacts({
  metricsDir,
  sourceRunId,
  sourceRunAttempt,
  sourceSha,
  sourceHasMetricsContract = true,
} = {}) {
  if (typeof metricsDir !== 'string' || metricsDir.length === 0) throw new Error('metricsDir is required');
  if (typeof sourceRunId !== 'string' || !/^\d+$/u.test(sourceRunId)) throw new Error('sourceRunId must be a decimal run id');
  if (!Number.isSafeInteger(Number(sourceRunAttempt)) || Number(sourceRunAttempt) < 1) throw new Error('sourceRunAttempt must be a positive safe integer');
  if (typeof sourceSha !== 'string' || !/^[a-f0-9]{40}$/iu.test(sourceSha)) throw new Error('sourceSha must be a 40-character Git SHA');
  if (typeof sourceHasMetricsContract !== 'boolean') throw new Error('sourceHasMetricsContract must be a boolean');

  await mkdir(metricsDir, { recursive: true });
  const available = await readdir(metricsDir, { withFileTypes: true });
  const latest = new Map();
  for (const artifact of available) {
    if (!artifact.isDirectory()) continue;
    const match = artifact.name.match(/^section-tree-layout-metrics-(it|en|de|fr)-(\d+)-(\d+)$/u);
    if (!match) throw new Error(`[section-tree-layout] unexpected downloaded metrics artifact: ${artifact.name}`);
    const [, locale, artifactRunId, attemptText] = match;
    const attempt = Number(attemptText);
    if (artifactRunId !== sourceRunId || !Number.isSafeInteger(attempt) || attempt < 1 || attempt > sourceRunAttempt) {
      throw new Error(`[section-tree-layout] metrics artifact identity mismatch: ${artifact.name}`);
    }
    const metric = JSON.parse(await readFile(path.join(metricsDir, artifact.name, `${locale}.json`), 'utf8'));
    if (metric?.locale !== locale || metric?.sourceRunId !== sourceRunId
      || metric?.sourceRunAttempt !== attempt || metric?.sourceSha !== sourceSha) {
      throw new Error(`[section-tree-layout] metric payload identity mismatch: ${artifact.name}`);
    }
    const current = latest.get(locale);
    if (current && current.attempt === attempt) {
      throw new Error(`[section-tree-layout] duplicate metrics artifacts for ${locale} attempt ${attempt}`);
    }
    if (!current || attempt > current.attempt) latest.set(locale, { attempt, metric });
  }

  if (latest.size === 0 && !sourceHasMetricsContract) return null;

  const metricsByLocale = {};
  for (const locale of LOCALES) {
    const entry = latest.get(locale);
    if (!entry) throw new Error(`[section-tree-layout] source run is missing metrics for ${locale} across its attempts`);
    metricsByLocale[locale] = entry.metric;
  }
  return metricsByLocale;
}

export async function runSectionTreeLayoutPreflight({
  metricsByLocale,
  locales = LOCALES,
  sourceRunId,
  sourceRunAttempt = Number.MAX_SAFE_INTEGER,
  sourceSha,
  threshold = parseFanoutAutoThreshold(process.env.FANOUT_AUTO_THRESHOLD_PCT),
  treeLimitBytes = intFromEnv('SHARD_REMOTE_TREE_LIMIT_BYTES', DEFAULT_SECTION_TREE_LIMIT_BYTES),
  slugs,
  readRegistry = readSectionTreeLayoutRegistry,
  register = registerSectionTreeFanout,
  probeWorker = requireWorkerSectionTreeLayout,
  stderr = console.error,
} = {}) {
  const pushLocales = normalizeLocales(locales);
  if (typeof sourceRunId !== 'string' || !/^\d+$/u.test(sourceRunId)) throw new Error('sourceRunId must be a decimal run id');
  if (typeof sourceSha !== 'string' || !/^[a-f0-9]{40}$/iu.test(sourceSha)) throw new Error('sourceSha must be a 40-character Git SHA');
  if (!Number.isSafeInteger(treeLimitBytes) || treeLimitBytes <= 0) throw new Error('treeLimitBytes must be a positive safe integer');

  const sectionSlugs = slugs ?? JSON.parse(await readFile(SECTION_SLUGS_PATH, 'utf8'));
  let registry = await readRegistry();
  let registeredSections = sectionTreeLayoutSections(registry);

  if (metricsByLocale === null) {
    stderr('[section-tree-layout] legacy source without metrics: sticky registry only');
    await Promise.all(registeredSections.flatMap((section) => pushLocales.map(async (locale) => {
      await probeWorker(section, sectionSubPath(sectionSlugs, section, locale));
    })));
    return { ready: true, legacy: true, decisions: {}, sections: registeredSections, locales: pushLocales };
  }

  if (!metricsByLocale || typeof metricsByLocale !== 'object') throw new Error('metricsByLocale is required');
  const sectionNames = Object.keys(sectionSlugs).filter((section) => !section.startsWith('_')).sort();
  for (const locale of LOCALES) {
    validateMetric(metricsByLocale[locale], locale, sourceRunId, sourceRunAttempt, sourceSha, treeLimitBytes, sectionNames);
  }

  const decisions = {};
  const pendingProbes = [];
  for (const section of sectionNames) {
    let maximum = { locale: LOCALES[0], pct: metricsByLocale[LOCALES[0]].sections[section].pct };
    for (const locale of LOCALES.slice(1)) {
      const pct = metricsByLocale[locale].sections[section].pct;
      if (pct > maximum.pct) maximum = { locale, pct };
    }
    const alreadyFanned = registeredSections.includes(section);
    const decision = decideSectionTreeFanout({ percent: maximum.pct, threshold, alreadyFanned });
    decisions[section] = { decision, maxLocale: maximum.locale, maxPct: maximum.pct };

    for (const locale of LOCALES) {
      const pct = metricsByLocale[locale].sections[section].pct;
      if (!alreadyFanned && pct >= 30) {
        stderr(`::warning::[tree-fanout] section=${section} locale=${locale} pct=${displayPct(pct)} warning=unfanned-tree-at-least-30`);
      }
      stderr(`[tree-fanout] section=${section} locale=${locale} pct=${displayPct(pct)} decision=${decision}`);
    }

    if (decision === 'fan') pendingProbes.push({ section, locale: maximum.locale, pct: maximum.pct });
  }

  // Finish every monotonic registry write before the first probe. The Worker
  // caches the object for five minutes; probing between additions would make
  // each later section wait out a separate stale-cache window.
  for (const pending of pendingProbes) {
    const { section, locale, pct } = pending;
    const result = await register(section, { locale, pct });
    registry = result?.registry ?? await readRegistry();
    registeredSections = sectionTreeLayoutSections(registry);
    if (!registeredSections.includes(section)) {
      throw new Error(`[section-tree-layout] registry did not persist hash-v1 for ${section}; refusing all section pushes`);
    }
  }
  // Probe every section already committed to the durable registry, including
  // the static fan-out sections and sections registered above, for every
  // locale that this publish will push. A metrics source used to probe only
  // newly registered sections here, leaving sticky sections to fail later in
  // parallel shard jobs while the Worker rollout was still propagating.
  await Promise.all(registeredSections.flatMap((section) => pushLocales.map(async (locale) => {
    await probeWorker(section, sectionSubPath(sectionSlugs, section, locale));
  })));
  return { ready: true, decisions, sections: registeredSections, locales: pushLocales };
}

function flag(args, name, fallback) {
  const index = args.indexOf(name);
  if (index === -1) return fallback;
  if (!args[index + 1]) throw new Error(`${name} requires a value`);
  return args[index + 1];
}

async function main(args = process.argv.slice(2)) {
  const metricsDir = flag(args, '--metrics-dir');
  const sourceRunId = flag(args, '--source-run-id');
  const sourceRunAttempt = Number(flag(args, '--source-run-attempt', process.env.SOURCE_RUN_ATTEMPT || '1'));
  const sourceSha = flag(args, '--source-sha');
  const sourceHasMetricsContractValue = flag(args, '--source-has-metrics-contract', 'true');
  if (!['true', 'false'].includes(sourceHasMetricsContractValue)) {
    throw new Error('--source-has-metrics-contract must be true or false');
  }
  const locales = normalizeLocales(flag(args, '--locales', LOCALES.join(',')).split(','));
  const threshold = parseFanoutAutoThreshold(flag(args, '--threshold', process.env.FANOUT_AUTO_THRESHOLD_PCT));
  const treeLimitBytes = Number(flag(
    args,
    '--tree-limit',
    String(intFromEnv('SHARD_REMOTE_TREE_LIMIT_BYTES', DEFAULT_SECTION_TREE_LIMIT_BYTES)),
  ));
  const metricsByLocale = await loadSectionTreeLayoutMetricsFromArtifacts({
    metricsDir,
    sourceRunId,
    sourceRunAttempt,
    sourceSha,
    sourceHasMetricsContract: sourceHasMetricsContractValue === 'true',
  });
  const result = await runSectionTreeLayoutPreflight({
    metricsByLocale, locales, sourceRunId, sourceRunAttempt, sourceSha, threshold, treeLimitBytes,
  });
  const output = flag(args, '--github-output', process.env.GITHUB_OUTPUT);
  if (output) await writeFile(output, 'ready=true\n', { flag: 'a' });
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

if (isInvokedDirectly(import.meta.url)) {
  try {
    await main();
  } catch (error) {
    console.error(`::error::${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
