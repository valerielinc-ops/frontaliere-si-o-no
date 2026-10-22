import fs from 'node:fs';
import np from 'node:path';
import type {
  SectorHubJobLike,
  SectorHubPublication,
  SectorHubPublicationRegistry,
} from '../../data/sector-hub-publications';
import { normalizeSectorHubLabel, sectorHubMatchesJob } from '../../data/sector-hub-publications';
import {
  isListingInventoryJob,
  normalizeListingIdentity,
  type ListingInventoryJob,
} from '../../services/jobBoardInventory';
import { isFixtureJob } from '../../scripts/lib/fixture-data-filter.mjs';
import { resolveJobCanton } from './cantonSection';

export type AutoSectorJob = SectorHubJobLike & Record<string, unknown>;

function isPublishableListingJob(job: AutoSectorJob): job is AutoSectorJob & ListingInventoryJob {
  return !isFixtureJob(job) && isListingInventoryJob(job);
}

const EMPTY_REGISTRY: SectorHubPublicationRegistry = {
  schemaVersion: 1,
  generatedAt: '',
  sourceWeek: '',
  hubs: [],
};

function isPublication(value: unknown): value is SectorHubPublication {
  if (!value || typeof value !== 'object') return false;
  const hub = value as Partial<SectorHubPublication>;
  return typeof hub.slug === 'string'
    && /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(hub.slug)
    && (hub.routeKind === 'dynamic' || hub.routeKind === 'static-category')
    && typeof hub.label === 'string'
    && Boolean(hub.labelByLocale && typeof hub.labelByLocale === 'object'
      && Object.entries(hub.labelByLocale).every(([locale, label]) =>
        ['it', 'en', 'de', 'fr'].includes(locale) && typeof label === 'string' && Boolean(label.trim())))
    && Array.isArray(hub.sourceFields)
    && hub.sourceFields.every((field) => field === 'category' || field === 'sector')
    && Array.isArray(hub.matchLabels)
    && hub.matchLabels.every((label) => typeof label === 'string')
    && typeof hub.firstPublishedAt === 'string'
    && (hub.status === 'active' || hub.status === 'cooling-off' || hub.status === 'retired');
}

export function readSectorHubPublicationRegistry(rootDir: string): SectorHubPublicationRegistry {
  const file = np.join(rootDir, 'data', 'sector-hub-publications.json');
  if (!fs.existsSync(file)) return EMPTY_REGISTRY;
  const raw: unknown = JSON.parse(fs.readFileSync(file, 'utf-8'));
  if (!raw || typeof raw !== 'object') throw new Error('data/sector-hub-publications.json must contain an object.');
  const registry = raw as Partial<SectorHubPublicationRegistry>;
  if (registry.schemaVersion !== 1 || !Array.isArray(registry.hubs) || !registry.hubs.every(isPublication)) {
    throw new Error('data/sector-hub-publications.json has an unsupported schema or invalid hub entry.');
  }
  return registry as SectorHubPublicationRegistry;
}

function isActiveTicinoJob(job: AutoSectorJob): boolean {
  if (job.expired || resolveJobCanton({
    canton: typeof job.canton === 'string' ? job.canton : undefined,
    location: typeof job.location === 'string' ? job.location : undefined,
  }) !== 'TI') return false;
  const locale = 'it';
  const needsRetranslation = job.needsRetranslation;
  if (needsRetranslation === true && locale !== (job.sourceLang || 'it')) return false;
  if (needsRetranslation && typeof needsRetranslation === 'object' && needsRetranslation[locale]) return false;
  const localizedDescription = job.descriptionByLocale?.[locale];
  const description = localizedDescription && localizedDescription.trim().length > 0
    ? localizedDescription
    : (typeof job.description === 'string' ? job.description : '');
  return description.trim().split(/\s+/).filter(Boolean).length >= 50;
}

function jobIdentity(job: AutoSectorJob, index: number): string {
  return String(job.id || job.slug || `${job.companyKey || job.company || ''}:${job.title || ''}:${index}`);
}

export interface AutoSectorHubInventory {
  registry: SectorHubPublicationRegistry;
  jobsBySlug: Map<string, AutoSectorJob[]>;
}

/** Read the exact active TI inventory that candidate discovery measures. */
export function readAutoSectorHubInventory(rootDir: string): AutoSectorHubInventory {
  const registry = readSectorHubPublicationRegistry(rootDir);
  const jobsFile = np.join(rootDir, 'data', 'jobs.json');
  let jobs: AutoSectorJob[] = [];
  if (fs.existsSync(jobsFile)) {
    const raw: unknown = JSON.parse(fs.readFileSync(jobsFile, 'utf-8'));
    if (!Array.isArray(raw)) throw new Error('data/jobs.json must contain an array.');
    jobs = raw
      .filter((job): job is AutoSectorJob => Boolean(job && typeof job === 'object'))
      .filter(isPublishableListingJob)
      .map((job) => normalizeListingIdentity(job));
  }

  const jobsBySlug = new Map<string, AutoSectorJob[]>();
  for (const publication of registry.hubs) {
    const seen = new Set<string>();
    const matching = jobs.filter((job, index) => {
      if (!isActiveTicinoJob(job) || !sectorHubMatchesJob(publication, job)) return false;
      const id = jobIdentity(job, index);
      if (seen.has(id)) return false;
      seen.add(id);
      return true;
    });
    jobsBySlug.set(publication.slug, matching);
  }
  return { registry, jobsBySlug };
}

export function countAutoSectorHubEmployers(jobs: readonly AutoSectorJob[]): number {
  return new Set(jobs.map((job) => normalizeSectorHubLabel(job.companyKey || job.companyDomain || job.company))
    .filter(Boolean)).size;
}
