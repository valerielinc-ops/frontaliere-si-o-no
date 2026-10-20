#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { fetchGa4Pages } from './lib/evidence/ga4Fetcher.mjs';
import { fetchGscQueries } from './lib/evidence/gscFetcher.mjs';
import { DEFAULT_GA4_PROPERTY_ID, ga4DateRange } from './lib/ga4-service-account.mjs';
import { writeJsonAtomic } from './lib/atomic-write-json.mjs';
import { freeTranslateWithRetry } from './lib/free-translate.mjs';
import { localizeSectorHubLabel } from './lib/sector-hub-label-localization';
import {
  buildSectorHubDiscoveryReport,
  buildAutomaticSectorHubPublicationRegistry,
  type DiscoveryJob,
  HUB_DISCOVERY_WINDOW_DAYS,
  type PreviousSectorHubCandidate,
  type TrafficSnapshot,
} from './lib/sector-hub-discovery';
import type { SectorHubPublicationRegistry } from '../data/sector-hub-publications';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_JOBS = path.join(ROOT, 'data/jobs.json');
const DEFAULT_POPULARITY = path.join(ROOT, 'data/job-popularity.json');
const DEFAULT_POPULARITY_META = path.join(ROOT, 'data/job-popularity.meta.json');
const DEFAULT_OUTPUT = path.join(ROOT, 'data/sector-hub-candidates.json');
const DEFAULT_PUBLICATIONS_OUTPUT = path.join(ROOT, 'data/sector-hub-publications.json');

type Args = {
  jobsFile: string;
  popularityFile: string;
  popularityMetaFile: string;
  outputFile: string;
  publicationsOutputFile: string;
  trafficInput?: string;
  trafficOutput?: string;
  windowDays: number;
  help: boolean;
};

function parseArgs(argv: string[]): Args {
  const args: Args = {
    jobsFile: DEFAULT_JOBS,
    popularityFile: DEFAULT_POPULARITY,
    popularityMetaFile: DEFAULT_POPULARITY_META,
    outputFile: DEFAULT_OUTPUT,
    publicationsOutputFile: DEFAULT_PUBLICATIONS_OUTPUT,
    windowDays: HUB_DISCOVERY_WINDOW_DAYS,
    help: false,
  };
  const values = new Map<string, keyof Args>([
    ['--jobs-file', 'jobsFile'],
    ['--popularity-file', 'popularityFile'],
    ['--popularity-meta-file', 'popularityMetaFile'],
    ['--output', 'outputFile'],
    ['--publications-output', 'publicationsOutputFile'],
    ['--traffic-input', 'trafficInput'],
    ['--traffic-output', 'trafficOutput'],
  ]);
  for (let index = 0; index < argv.length; index += 1) {
    const option = argv[index];
    if (option === '--help' || option === '-h') {
      args.help = true;
      continue;
    }
    if (option === '--window-days') {
      const days = Number(argv[index + 1]);
      if (!Number.isSafeInteger(days) || days < 7 || days > 90) throw new Error('--window-days must be an integer from 7 to 90');
      args.windowDays = days;
      index += 1;
      continue;
    }
    const key = values.get(option);
    if (!key) throw new Error(`Unknown option: ${option}`);
    const value = argv[index + 1];
    if (!value || value.startsWith('--')) throw new Error(`${option} requires a value`);
    (args as unknown as Record<string, unknown>)[key] = path.resolve(value);
    index += 1;
  }
  return args;
}

function readJson<T>(file: string, fallback: T): T {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8')) as T;
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') return fallback;
    throw error;
  }
}

async function fetchTraffic(windowDays: number, now: Date): Promise<TrafficSnapshot> {
  const window = ga4DateRange(windowDays, 2, now);
  const [gsc, ga4] = await Promise.all([
    fetchGscQueries({ ...window, rowLimit: 25_000 }),
    fetchGa4Pages({
      propertyId: process.env.GA4_PROPERTY_ID || DEFAULT_GA4_PROPERTY_ID,
      ...window,
      minSessions: 1,
    }),
  ]);
  return {
    generatedAt: now.toISOString(),
    window,
    gsc: {
      queries: gsc.queries || {},
      pages: gsc.pages || {},
      ...(gsc.error ? { error: gsc.error } : {}),
    },
    ga4: {
      pages: ga4.pages || {},
      ...(ga4.coverage ? { coverage: ga4.coverage } : {}),
      ...(ga4.error ? { error: ga4.error } : {}),
    },
  };
}

function usage(): string {
  return [
    'Discover and rank non-curated job sectors from the assembled active Ticino inventory.',
    '',
    'Usage: npx tsx scripts/discover-sector-hub-candidates.ts [options]',
    '  --jobs-file <path>            Assembled jobs JSON (default: data/jobs.json)',
    '  --popularity-file <path>      Firestore job_views export',
    '  --popularity-meta-file <path> Popularity export metadata',
    '  --output <path>               Candidate report destination',
    '  --publications-output <path>   Automatically promoted hub registry destination',
    `  --window-days <7..90>         Settled GA4/GSC traffic window (default: ${HUB_DISCOVERY_WINDOW_DAYS})`,
    '  --traffic-output <path>       Save the fetched evidence for a retry',
    '  --traffic-input <path>        Reuse a previously fetched evidence snapshot',
  ].join('\n');
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(usage());
    return;
  }
  if (!fs.existsSync(args.jobsFile)) {
    throw new Error(`Assembled jobs dataset missing: ${args.jobsFile}`);
  }
  const jobs = readJson<DiscoveryJob[]>(args.jobsFile, []);
  if (!Array.isArray(jobs) || jobs.length === 0) {
    throw new Error('Assembled jobs dataset is empty; refusing to replace the candidate report with zero inventory.');
  }

  const now = new Date();
  const traffic = args.trafficInput
    ? readJson<TrafficSnapshot>(args.trafficInput, null as unknown as TrafficSnapshot)
    : await fetchTraffic(args.windowDays, now);
  if (!traffic || !traffic.window || !traffic.gsc || !traffic.ga4) {
    throw new Error('Traffic evidence snapshot is malformed.');
  }
  if (args.trafficOutput) writeJsonAtomic(args.trafficOutput, traffic);

  const popularity = readJson<Record<string, number>>(args.popularityFile, {});
  const popularityMeta = readJson<{ scannedAt?: string }>(args.popularityMetaFile, {});
  const previous = readJson<{ candidates?: PreviousSectorHubCandidate[] }>(args.outputFile, {});
  const previousPublications = readJson<SectorHubPublicationRegistry | null>(args.publicationsOutputFile, null);
  const report = buildSectorHubDiscoveryReport({
    jobs,
    popularity,
    popularityScannedAt: popularityMeta.scannedAt,
    traffic,
    previous,
    now,
  });
  writeJsonAtomic(args.outputFile, report);
  const previousLabelsBySlug = new Map((previousPublications?.hubs || []).map((hub) => [hub.slug, hub]));
  const localizedCandidates: Array<(typeof report.candidates)[number]> = [];
  for (const candidate of report.candidates) {
    if (!candidate.automaticPromotionEligible) {
      localizedCandidates.push(candidate);
      continue;
    }
    const previousHub = previousLabelsBySlug.get(candidate.suggestedSlug);
    const existingLabels = previousHub?.label === candidate.label ? previousHub.labelByLocale : {};
    const labelByLocale = await localizeSectorHubLabel({
      label: candidate.label,
      sourceLocale: candidate.sourceLocale,
      existingLabels: { ...existingLabels, ...candidate.labelByLocale },
      translate: async (text, sourceLocale, targetLocale) => freeTranslateWithRetry({
        text,
        sourceLang: sourceLocale,
        targetLang: targetLocale,
        fieldType: 'title',
        maxRetries: 1,
      }),
    });
    localizedCandidates.push({ ...candidate, labelByLocale });
  }
  const publicationReport = { ...report, candidates: localizedCandidates };
  const publications = buildAutomaticSectorHubPublicationRegistry({ report: publicationReport, previous: previousPublications });
  writeJsonAtomic(args.publicationsOutputFile, publications);

  const eligible = report.candidates.filter((candidate) => candidate.automaticPromotionEligible).length;
  const promising = report.candidates.filter((candidate) => candidate.status === 'promising').length;
  const activePublications = publications.hubs.filter((hub) => hub.status === 'active').length;
  const coolingPublications = publications.hubs.filter((hub) => hub.status === 'cooling-off').length;
  console.log(`[sector-hub-discovery] ${report.sourceCoverage.jobs.activeTicinoJobs} active TI ads; ${report.existingHubPerformance.length} curated hubs measured; ${report.candidates.length} candidates retained (${promising} promising, ${eligible} automatically publishable).`);
  console.log(`[sector-hub-discovery] ${activePublications} automatic hubs active, ${coolingPublications} cooling off; GA4 ${report.sourceCoverage.ga4.status}; GSC ${report.sourceCoverage.gsc.status}.`);
  console.log(`[sector-hub-discovery] wrote ${path.relative(ROOT, args.outputFile)} and ${path.relative(ROOT, args.publicationsOutputFile)}.`);
}

main().catch((error) => {
  console.error(`[sector-hub-discovery] ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
