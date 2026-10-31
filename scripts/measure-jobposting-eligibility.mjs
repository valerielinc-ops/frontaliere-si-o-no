#!/usr/bin/env -S npx tsx
/**
 * How many active jobs stay eligible for JobPosting, and on what evidence.
 *
 *   npx tsx scripts/measure-jobposting-eligibility.mjs [data/jobs/by-crawler]
 *
 * Runs the real builder and the real mandatory-field contract over every
 * record of the active inventory, one crawler file at a time. `eligible` is a
 * schema that passes the contract and whose source deadline has not passed.
 * The `datePosted` block answers issue 11394: a rule that withheld the schema
 * without a verified date would remove every job counted in `unverifiedDate`.
 */
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const root = process.cwd();
const load = (relative) => import(pathToFileURL(path.resolve(root, relative)).href);
const { buildJobPostingSchema } = await load('build-plugins/shared/jobPostingSchema.ts');
const { validateMandatoryJobPostingFields } = await load('scripts/lib/jobposting-mandatory-fields.mjs');
const { resolveSchemaPostingDate } = await load('scripts/lib/job-posting-date.mjs');

const OLD_REMOTE_RE = /remote|telelavor|smart[-\s]?working|home office|hybrid/i;
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
  validThrough: { sourceOnRecord: 0, emitted: 0, emittedPast: 0, droppedAsSystemDefault: 0, absent: 0, maxDaysAhead: 0 },
  telecommute: { oldDescriptionRegex: 0, emitted: 0 },
  streetAddress: { emitted: 0, placeholderEmitted: 0, absent: 0 },
};

const isRemoteNow = await load('scripts/lib/jobposting-field-provenance.mjs')
  .then((module) => module.isFullyRemoteListing || null);

for (const file of readdirSync(dir).filter((name) => name.endsWith('.json')).sort()) {
  const parsed = JSON.parse(readFileSync(path.join(dir, file), 'utf8'));
  for (const job of Array.isArray(parsed) ? parsed : parsed.jobs || []) {
    report.active += 1;
    const { provenance } = resolveSchemaPostingDate(job, now);
    report.datePosted[provenance] += 1;
    if (provenance !== 'reported') report.datePosted.unverifiedDate += 1;

    const oldRemote = OLD_REMOTE_RE.test(`${job.title || ''} ${job.description || ''} ${job.location || ''}`);
    if (oldRemote) report.telecommute.oldDescriptionRegex += 1;
    const isRemote = isRemoteNow ? isRemoteNow({ title: job.title, location: job.location }) : oldRemote;

    let schema;
    try {
      schema = buildJobPostingSchema(
        { ...job, sector: job.category, isRemote },
        { locale: 'it', url: `https://frontaliereticino.ch/lavoro/${job.slug || job.id}/`, now },
      );
    } catch {
      report.contractFailures += 1;
      continue;
    }
    report.emitted += 1;
    if (schema.jobLocationType === 'TELECOMMUTE') report.telecommute.emitted += 1;

    const source = Date.parse(String(job.validThrough || ''));
    const emitted = Date.parse(String(schema.validThrough || ''));
    if (Number.isFinite(source)) report.validThrough.sourceOnRecord += 1;
    if (Number.isFinite(emitted)) {
      report.validThrough.emitted += 1;
      if (emitted < now.getTime()) report.validThrough.emittedPast += 1;
      const days = Math.round((emitted - now.getTime()) / 86_400_000);
      report.validThrough.maxDaysAhead = Math.max(report.validThrough.maxDaysAhead, days);
    } else {
      report.validThrough.absent += 1;
      if (Number.isFinite(source)) report.validThrough.droppedAsSystemDefault += 1;
    }

    const street = schema.jobLocation.address.streetAddress;
    if (!street) report.streetAddress.absent += 1;
    else {
      report.streetAddress.emitted += 1;
      if (/(?:city centre|stadtzentrum|centre-ville|\bcentro)$/i.test(street)) report.streetAddress.placeholderEmitted += 1;
    }

    const contractOk = validateMandatoryJobPostingFields(schema).length === 0;
    if (!contractOk) report.contractFailures += 1;
    if (contractOk && !(Number.isFinite(emitted) && emitted < now.getTime())) report.eligible += 1;
  }
}

console.log(JSON.stringify(report, null, 2));
