#!/usr/bin/env -S npx tsx
/**
 * Compare JobPosting field coverage and quality before/after enrichment on
 * one unchanged active-job snapshot.
 *
 *   npx tsx scripts/measure-jobposting-eligibility.mjs [data/jobs/by-crawler]
 *
 * `before` reproduces the previous emitter's city-table and deadline fallbacks;
 * `after` runs the production schema and field resolvers. The script fails if
 * either required field loses coverage against that same input snapshot.
 * The datePosted block retains the eligibility readout for issue #11394.
 */
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const root = process.cwd();
const load = (relative) => import(pathToFileURL(path.resolve(root, relative)).href);
const { buildJobPostingSchema, resolveJobPostingAddress } = await load('build-plugins/shared/jobPostingSchema.ts');
const { validateMandatoryJobPostingFields } = await load('scripts/lib/jobposting-mandatory-fields.mjs');
const { resolveSchemaPostingDate } = await load('scripts/lib/job-posting-date.mjs');
const {
  CANTON_CAPITAL_ADDRESSES,
  CITY_FALLBACK_ADDRESSES,
  COMPANY_HQ_ADDRESSES,
  localityMatchesHq,
  resolveFallbackAddress,
} = await load('build-plugins/shared/companyHqAddresses.mjs');
const {
  isPlaceholderStreetAddress,
  isSourceStreetAddress,
  isFullyRemoteListing,
} = await load('scripts/lib/jobposting-field-provenance.mjs');
const {
  resolveActiveJobPostingDeadline,
  resolveJobPostingStreetAddress,
} = await load('scripts/lib/jobposting-field-enrichment.mjs');

const OLD_REMOTE_RE = /remote|telelavor|smart[-\s]?working|home office|hybrid/i;
const DAY_MS = 86_400_000;
const dir = path.resolve(root, process.argv[2] || 'data/jobs/by-crawler');
const now = new Date();
const report = {
  dir: path.relative(root, dir) || '.',
  now: now.toISOString(),
  active: 0,
  emitted: 0,
  contractFailures: 0,
  eligible: 0,
  datePosted: { reported: 0, 'first-seen': 0, observed: 0, 'build-clock': 0, unverifiedDate: 0 },
  coverage: {
    baseline: 'previous-emitter on the same snapshot',
    streetAddress: { before: null, after: null, regression: false },
    validThrough: { before: null, after: null, regression: false },
  },
  validThrough: {
    sourceOnRecord: 0,
    emittedPast: 0,
    maxDaysAhead: 0,
    sourceLevels: {},
  },
  telecommute: { oldDescriptionRegex: 0, emitted: 0 },
};

function newFieldStats() {
  return { covered: 0, coveragePercent: 0, sourceLevels: {}, toEnrich: 0, placeholders: 0 };
}

function addLevel(stats, level) {
  stats.sourceLevels[level] = (stats.sourceLevels[level] || 0) + 1;
}

function addField(stats, value, source) {
  if (!String(value || '').trim()) return;
  stats.covered++;
  addLevel(stats, source);
}

function addStreet(stats, street, source) {
  if (!String(street || '').trim()) return;
  if (isPlaceholderStreetAddress(street)) {
    stats.placeholders++;
    return;
  }
  addField(stats, street, source);
  if (source === 'to-enrich') stats.toEnrich++;
}

function previousStreet(job, address) {
  const locality = String(address?.addressLocality || job.addressLocality || job.city || job.location || '').trim();
  const region = String(address?.addressRegion || job.addressRegion || job.canton || '').trim().toUpperCase();
  const raw = String(job.streetAddress || job.address || '').trim();
  if (isSourceStreetAddress(raw, locality)) return { streetAddress: raw, source: 'listing-source' };

  const companySlug = String(job.companySlug || job.companyKey || '').trim().toLowerCase();
  const hq = COMPANY_HQ_ADDRESSES[companySlug];
  if (hq && String(hq.addressRegion || '').toUpperCase() === region && localityMatchesHq(locality, hq)) {
    return { streetAddress: hq.streetAddress, source: 'curated-company-city' };
  }

  const fallback = resolveFallbackAddress(companySlug, locality.toLowerCase(), region);
  const cityEntry = CITY_FALLBACK_ADDRESSES[locality.toLowerCase()];
  const capitalEntry = CANTON_CAPITAL_ADDRESSES[region];
  const isCityTable = cityEntry && fallback.streetAddress === cityEntry.streetAddress;
  const isCapital = capitalEntry && fallback.streetAddress === capitalEntry.streetAddress;
  return {
    streetAddress: fallback.streetAddress,
    source: isCityTable ? 'municipality-table' : isCapital ? 'canton-capital-table' : 'previous-fallback',
  };
}

function previousDeadline(job, datePosted) {
  const explicit = job.validThrough ? new Date(String(job.validThrough)) : null;
  if (explicit && Number.isFinite(explicit.getTime())) {
    return { validThrough: explicit.toISOString(), source: 'source-or-ATS-default' };
  }
  const crawled = job.crawledAt ? new Date(String(job.crawledAt)) : null;
  const anchor = crawled && Number.isFinite(crawled.getTime()) ? crawled : new Date(datePosted);
  if (!Number.isFinite(anchor.getTime())) return { validThrough: null, source: 'unresolved' };
  const out = new Date(anchor);
  out.setUTCDate(out.getUTCDate() + (crawled ? 60 : 90));
  return { validThrough: out.toISOString(), source: crawled ? 'crawledAt+60d' : 'datePosted+90d' };
}

const streetBefore = newFieldStats();
const streetAfter = newFieldStats();
const validThroughBefore = newFieldStats();
const validThroughAfter = newFieldStats();

for (const file of readdirSync(dir).filter((name) => name.endsWith('.json')).sort()) {
  const parsed = JSON.parse(readFileSync(path.join(dir, file), 'utf8'));
  for (const job of Array.isArray(parsed) ? parsed : parsed.jobs || []) {
    report.active++;
    // Match the crawler write pipeline: firstSeenAt is carried/backfilled
    // before persisted JobPosting fields are evaluated.
    const afterJob = {
      ...job,
      firstSeenAt: job.firstSeenAt || job.crawledAt || now.toISOString(),
    };
    const { value: datePosted, provenance } = resolveSchemaPostingDate(afterJob, now);
    report.datePosted[provenance] += 1;
    if (provenance !== 'reported') report.datePosted.unverifiedDate += 1;

    const oldRemote = OLD_REMOTE_RE.test(`${job.title || ''} ${job.description || ''} ${job.location || ''}`);
    if (oldRemote) report.telecommute.oldDescriptionRegex++;
    const isRemote = isFullyRemoteListing({ title: job.title, location: job.location });
    const oldStreet = previousStreet(job, {});
    addStreet(streetBefore, oldStreet.streetAddress, oldStreet.source);
    const oldDeadline = previousDeadline(job, datePosted);
    if (oldDeadline.validThrough) addField(validThroughBefore, oldDeadline.validThrough, oldDeadline.source);

    const emittedAddress = resolveJobPostingAddress(job, 'it');
    const addressAfter = resolveJobPostingStreetAddress(job, {
      addressLocality: emittedAddress.addressLocality,
      addressRegion: emittedAddress.addressRegion,
      postalCode: emittedAddress.postalCode,
    });
    addStreet(streetAfter, addressAfter.streetAddress, addressAfter.streetAddressSource);

    const deadlineAfter = resolveActiveJobPostingDeadline(afterJob, now);
    if (deadlineAfter.validThrough) {
      addField(validThroughAfter, deadlineAfter.validThrough, deadlineAfter.validThroughSource);
      report.validThrough.sourceLevels[deadlineAfter.validThroughSource] =
        (report.validThrough.sourceLevels[deadlineAfter.validThroughSource] || 0) + 1;
      const days = Math.round((Date.parse(deadlineAfter.validThrough) - now.getTime()) / DAY_MS);
      report.validThrough.maxDaysAhead = Math.max(report.validThrough.maxDaysAhead, days);
      if (days < 0) report.validThrough.emittedPast++;
    }
    if (Number.isFinite(Date.parse(String(job.validThrough || '')))) report.validThrough.sourceOnRecord++;

    let schema;
    try {
      schema = buildJobPostingSchema(
        { ...afterJob, sector: job.category, isRemote },
        { locale: 'it', url: `https://frontaliereticino.ch/lavoro/${job.slug || job.id}/`, now },
      );
    } catch {
      report.contractFailures++;
      continue;
    }
    report.emitted++;
    if (schema.jobLocationType === 'TELECOMMUTE') report.telecommute.emitted++;
    if (validateMandatoryJobPostingFields(schema).length) report.contractFailures++;
    else if (Date.parse(schema.validThrough) >= now.getTime()) report.eligible++;
  }
}

for (const stats of [streetBefore, streetAfter, validThroughBefore, validThroughAfter]) {
  stats.coveragePercent = report.active ? Number((stats.covered * 100 / report.active).toFixed(2)) : 0;
}
report.coverage.streetAddress = {
  before: streetBefore,
  after: streetAfter,
  regression: streetAfter.covered < streetBefore.covered,
};
report.coverage.validThrough = {
  before: validThroughBefore,
  after: validThroughAfter,
  regression: validThroughAfter.covered < validThroughBefore.covered,
};

console.log(JSON.stringify(report, null, 2));
if (report.coverage.streetAddress.regression || report.coverage.validThrough.regression) {
  process.exitCode = 1;
}
