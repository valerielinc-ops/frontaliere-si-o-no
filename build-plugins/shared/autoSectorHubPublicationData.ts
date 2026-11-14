import fs from 'node:fs';
import np from 'node:path';
import { iterateJsonArrayFile } from '../../scripts/lib/read-large-json.mjs';
import type {
  SectorHubJobLike,
  SectorHubPublication,
  SectorHubPublicationRegistry,
  SectorPublicationLocale,
} from '../../data/sector-hub-publications';
import {
  isIndexableSectorHubPublication,
  normalizeSectorHubLabel,
  sectorHubMatchesJob,
} from '../../data/sector-hub-publications';
import { buildAutoSectorHubPath } from './autoSectorHubPaths';
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
    && (hub.status === 'active' || hub.status === 'cooling-off' || hub.status === 'retired')
    && (hub.retirementReason === undefined
      || (hub.status === 'retired' && typeof hub.retirementReason === 'string'
        && Boolean(hub.retirementReason.trim())));
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

export interface AutoSectorHubIndexLink {
  slug: string;
  href: string;
  label: string;
}

/** Shared eligibility for the generated sector directory and its build links. */
export function listIndexableAutoSectorHubLinks(
  inventory: AutoSectorHubInventory,
  locale: SectorPublicationLocale,
): AutoSectorHubIndexLink[] {
  const links: AutoSectorHubIndexLink[] = [];
  for (const publication of inventory.registry.hubs) {
    const jobs = inventory.jobsBySlug.get(publication.slug) || [];
    const label = publication.labelByLocale[locale]?.trim();
    if (!label || !isIndexableSectorHubPublication(
      publication,
      jobs.length,
      countAutoSectorHubEmployers(jobs),
      locale,
    )) continue;
    links.push({
      slug: publication.slug,
      href: buildAutoSectorHubPath(locale, publication.slug, publication.routeKind),
      label,
    });
  }
  return links;
}

/** Read the exact active TI inventory that candidate discovery measures. */
export function readAutoSectorHubInventory(rootDir: string): AutoSectorHubInventory {
  const registry = readSectorHubPublicationRegistry(rootDir);
  const jobsFile = np.join(rootDir, 'data', 'jobs.json');
  const jobsBySlug = new Map<string, AutoSectorJob[]>();
  const seenBySlug = new Map<string, Set<string>>();
  for (const publication of registry.hubs) {
    jobsBySlug.set(publication.slug, []);
    seenBySlug.set(publication.slug, new Set<string>());
  }

  if (fs.existsSync(jobsFile)) {
    let jobIndex = 0;
    for (const value of iterateJsonArrayFile(jobsFile)) {
      if (!value || typeof value !== 'object') continue;
      const rawJob = value as AutoSectorJob;
      if (!isPublishableListingJob(rawJob)) continue;
      const job = normalizeListingIdentity(rawJob);
      const sourceIndex = jobIndex;
      jobIndex += 1;
      if (!isActiveTicinoJob(job)) continue;

      for (const publication of registry.hubs) {
        if (!sectorHubMatchesJob(publication, job)) continue;
        const seen = seenBySlug.get(publication.slug);
        const matching = jobsBySlug.get(publication.slug);
        if (!seen || !matching) continue;
        const id = jobIdentity(job, sourceIndex);
        if (seen.has(id)) continue;
        seen.add(id);
        matching.push(job);
      }
    }
  }
  return { registry, jobsBySlug };
}

export function countAutoSectorHubEmployers(jobs: readonly AutoSectorJob[]): number {
  return new Set(jobs.map((job) => normalizeSectorHubLabel(job.companyKey || job.companyDomain || job.company))
    .filter(Boolean)).size;
}
