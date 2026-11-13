/**
 * Synthetic coverage for published-slug stability and exact served-path
 * matching. All filesystem fixtures stay under the OS temporary directory.
 */
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { buildCanonicalJobDetailPath } from '../build-plugins/shared/jobDetailPath.ts';
import { hardenJobLocaleFields } from '../scripts/lib/dedicated-crawler-common.mjs';
import { ensureLocaleFields } from '../scripts/lib/shared-jobs-crawler.mjs';
import {
  URL_FIRST_SEEN_SHARD_IDS,
  urlFirstSeenShardFileName,
} from '../scripts/lib/url-first-seen-store.mjs';
import {
  jobSlugsUnpublished,
  jobDetailPathsFor,
  mayReplacePublishedSlug,
  publishedSlugKeepsIdentity,
  slugWasServed,
} from '../scripts/lib/published-slug-stability.mjs';

const PREFERRED_SLUG = 'synthetic-role-synthetic-employer-sampletown';
const TITLE_DERIVED_SLUG = 'synthetic-support-specialist-synthetic-employer-sampletown';
const COMPANY = 'Synthetic Employer';
const LOCATION = 'Sampletown';
const DESCRIPTION = [
  'Synthetic fixture text used to exercise slug preservation behavior.',
  'It describes an example role at an example employer in a fictional location.',
  'No production record, route, metric, or personal information is represented.',
].join(' ');

function daysAgo(n: number): string {
  return new Date(Date.now() - n * 86_400_000).toISOString();
}

function servedDate(daysAgoCount: number): string {
  return daysAgo(daysAgoCount).slice(0, 10);
}

function syntheticJob(overrides: Record<string, unknown> = {}) {
  return {
    id: 'synthetic-job-0001',
    slug: PREFERRED_SLUG,
    slugByLocale: {
      it: PREFERRED_SLUG,
      en: 'synthetic-support-specialist-en',
      de: 'synthetic-support-specialist-de',
      fr: 'synthetic-support-specialist-fr',
    },
    company: COMPANY,
    companyKey: 'synthetic-employer',
    title: 'Synthetic Support Specialist',
    titleByLocale: {
      it: 'Synthetic Support Specialist',
      en: 'Synthetic Support Specialist',
      de: 'Synthetische Support-Fachkraft',
      fr: 'Spécialiste du support synthétique',
    },
    description: DESCRIPTION,
    descriptionByLocale: { it: DESCRIPTION, en: DESCRIPTION, de: DESCRIPTION, fr: DESCRIPTION },
    location: LOCATION,
    addressLocality: LOCATION,
    canton: 'TI',
    sourceLang: 'it',
    url: 'https://example.invalid/synthetic-job/0001',
    crawledAt: daysAgo(1),
    datePosted: daysAgo(30),
    previousSlugsByLocale: { it: ['synthetic-previous-role'] },
    previousSlugs: ['synthetic-previous-role'],
    ...overrides,
  };
}

const tmpFiles: string[] = [];
let seq = 0;
const previousRegistryOverride = process.env.SLUG_REGISTRY_PATH_OVERRIDE;
const previousLedgerOverride = process.env.URL_FIRST_SEEN_PATH_OVERRIDE;
afterEach(() => {
  for (const file of tmpFiles.splice(0)) {
    fs.rmSync(file, { recursive: true, force: true });
  }
  if (previousRegistryOverride === undefined) delete process.env.SLUG_REGISTRY_PATH_OVERRIDE;
  else process.env.SLUG_REGISTRY_PATH_OVERRIDE = previousRegistryOverride;
  if (previousLedgerOverride === undefined) delete process.env.URL_FIRST_SEEN_PATH_OVERRIDE;
  else process.env.URL_FIRST_SEEN_PATH_OVERRIDE = previousLedgerOverride;
});

function canonicalPath(locale: string, job: object, slug: string): string {
  return buildCanonicalJobDetailPath(locale, job, slug).replace(/\/$/, '');
}

function syntheticLedger(job: object) {
  return {
    [canonicalPath('it', job, PREFERRED_SLUG)]: servedDate(80),
    [canonicalPath('it', job, TITLE_DERIVED_SLUG)]: servedDate(20),
    [canonicalPath('en', job, TITLE_DERIVED_SLUG)]: servedDate(80),
  };
}

/** A file-shaped override keeps these tests independent of the deploy ledger. */
function useLedger(entries: Record<string, string> | null) {
  const ledgerPath = path.join(os.tmpdir(), `published-slug-ledger-${process.pid}-${seq++}.json`);
  if (entries) {
    fs.writeFileSync(ledgerPath, JSON.stringify(entries), 'utf8');
    tmpFiles.push(ledgerPath);
  }
  process.env.URL_FIRST_SEEN_PATH_OVERRIDE = ledgerPath;
}

/** Every hardening call gets isolated registry and job files under tmpdir. */
function harden(jobs: object[]) {
  const registryPath = path.join(os.tmpdir(), `published-slug-registry-${process.pid}-${seq++}.json`);
  fs.writeFileSync(registryPath, '{}', 'utf8');
  tmpFiles.push(registryPath);
  process.env.SLUG_REGISTRY_PATH_OVERRIDE = registryPath;
  const jobsPath = path.join(os.tmpdir(), `published-slug-harden-${process.pid}-${seq++}.json`);
  tmpFiles.push(jobsPath);
  fs.writeFileSync(jobsPath, JSON.stringify(jobs), 'utf8');
  hardenJobLocaleFields({ dataJobsPath: jobsPath });
  return JSON.parse(fs.readFileSync(jobsPath, 'utf8'));
}

describe('script-only published-slug imports', () => {
  it('does not load route matching code until a served ledger needs it', () => {
    const loaderPath = path.join(os.tmpdir(), `published-slug-loader-${process.pid}-${seq++}.mjs`);
    const moduleUrl = pathToFileURL(path.resolve(process.cwd(), 'scripts/lib/published-slug-stability.mjs')).href;
    fs.writeFileSync(loaderPath, `
export async function resolve(specifier, context, nextResolve) {
  if (specifier.endsWith('/job-board-detail-path-core.mjs')) {
    throw new Error('route matcher loaded eagerly');
  }
  return nextResolve(specifier, context);
}
`, 'utf8');
    try {
      const result = spawnSync(process.execPath, [
        '--experimental-loader', pathToFileURL(loaderPath).href,
        '--input-type=module',
        '--eval',
        `import { publishedSlugKeepsIdentity } from ${JSON.stringify(moduleUrl)};
if (!publishedSlugKeepsIdentity('${PREFERRED_SLUG}', { company: '${COMPANY}', location: '${LOCATION}' })) process.exit(2);`,
      ], { encoding: 'utf8' });
      expect(result.error).toBeUndefined();
      expect(result.status).toBe(0);
      expect(result.stderr).not.toContain('route matcher loaded eagerly');
    } finally {
      fs.rmSync(loaderPath, { force: true });
    }
  });
});

describe('published slug identity', () => {
  it('keeps a slug carrying the employer and location when title words change', () => {
    useLedger(null);
    const identity = { company: COMPANY, location: LOCATION };
    expect(publishedSlugKeepsIdentity(PREFERRED_SLUG, identity)).toBe(true);
    expect(publishedSlugKeepsIdentity(TITLE_DERIVED_SLUG, identity)).toBe(true);
    expect(mayReplacePublishedSlug(PREFERRED_SLUG, identity)).toBe(false);
  });

  it('allows re-derivation after a move or when identity tokens are missing', () => {
    const identity = { company: COMPANY, location: LOCATION };
    expect(mayReplacePublishedSlug('synthetic-role-synthetic-employer-oldtown', identity)).toBe(true);
    expect(mayReplacePublishedSlug('synthetic-role-oldtown', identity)).toBe(true);
    expect(mayReplacePublishedSlug('', identity)).toBe(true);
  });

  it('does not treat a shared location token as employer identity', () => {
    expect(mayReplacePublishedSlug(
      'synthetic-role-sampletown',
      { company: 'Different Organization', location: LOCATION },
    )).toBe(true);
  });
});

describe('served-path ledger matching', () => {
  const tiJob = syntheticJob();
  const agJob = syntheticJob({ canton: 'AG', location: 'Sampletown East', addressLocality: 'Sampletown East' });

  it('does not treat synthetic content paths as job details', () => {
    useLedger({
      '/synthetic-content/sample-entry/': servedDate(10),
      '/synthetic-news/sample-entry/': servedDate(10),
    });
    expect(slugWasServed('it', 'sample-entry', tiJob)).toBe(false);
  });

  it('does not treat a company hub shape as a job detail', () => {
    const detail = canonicalPath('it', tiJob, 'synthetic-employer-key');
    const companyHub = detail.replace(/[^/]+$/, 'company-synthetic-employer');
    useLedger({ [companyHub]: servedDate(10) });
    expect(slugWasServed('it', 'company-synthetic-employer', tiJob)).toBe(false);
  });

  it('does not let another canton section pin the same final slug', () => {
    const otherCantonPath = canonicalPath('it', agJob, PREFERRED_SLUG);
    useLedger({ [otherCantonPath]: servedDate(10) });
    expect(slugWasServed('it', PREFERRED_SLUG, tiJob)).toBe(false);
    expect(slugWasServed('it', PREFERRED_SLUG, agJob)).toBe(true);
  });

  it('matches the renderer path with its locale and canton section', () => {
    const slug = 'synthetic-east-role';
    const renderedPath = buildCanonicalJobDetailPath('de', agJob, slug);
    expect(jobDetailPathsFor('de', slug, agJob)).toEqual([renderedPath.replace(/\/$/, '')]);
    useLedger({ [renderedPath]: servedDate(40) });
    expect(slugWasServed('de', slug, agJob)).toBe(true);
    expect(slugWasServed('en', slug, agJob)).toBe(false);
  });

  it('accepts only the explicit Italian legacy mirror for an active non-TI slug', () => {
    const slug = PREFERRED_SLUG;
    const renderedPath = buildCanonicalJobDetailPath('it', agJob, slug);
    const paths = jobDetailPathsFor('it', slug, agJob);
    expect(paths[0]).toBe(renderedPath.replace(/\/$/, ''));
    expect(paths).toHaveLength(2);
    expect(jobDetailPathsFor('de', slug, agJob)).toHaveLength(1);
    const legacyMirror = paths[1];
    useLedger({ [legacyMirror]: servedDate(100) });
    expect(slugWasServed('it', slug, agJob)).toBe(true);
    expect(slugWasServed('de', slug, agJob)).toBe(false);
  });

  it('keeps identical final slug text separate across locales', () => {
    const italianPath = canonicalPath('it', tiJob, TITLE_DERIVED_SLUG);
    useLedger({ [italianPath]: servedDate(40) });
    expect(slugWasServed('it', TITLE_DERIVED_SLUG, tiJob)).toBe(true);
    expect(slugWasServed('en', TITLE_DERIVED_SLUG, tiJob)).toBe(false);
  });

  it('rejects an extra nested segment even when the final slug matches', () => {
    const detail = canonicalPath('it', tiJob, PREFERRED_SLUG);
    const nestedPath = detail.replace(/\/([^/]+)$/, '/synthetic-city/$1');
    useLedger({ [nestedPath]: servedDate(10) });
    expect(slugWasServed('it', PREFERRED_SLUG, tiJob)).toBe(false);
  });

  it('keeps the served Italian slug stable without pinning the English title slug', () => {
    useLedger({
      [canonicalPath('it', tiJob, PREFERRED_SLUG)]: servedDate(80),
      [canonicalPath('it', tiJob, TITLE_DERIVED_SLUG)]: servedDate(20),
    });
    expect(slugWasServed('it', PREFERRED_SLUG, tiJob)).toBe(true);
    expect(slugWasServed('it', TITLE_DERIVED_SLUG, tiJob)).toBe(true);
    expect(slugWasServed('en', TITLE_DERIVED_SLUG, tiJob)).toBe(false);
    expect(mayReplacePublishedSlug(TITLE_DERIVED_SLUG, { company: COMPANY, location: LOCATION }, {
      job: tiJob,
      locale: 'en',
    })).toBe(true);
  });

  it('distinguishes an absent ledger from a present but unreadable ledger', () => {
    useLedger(null);
    expect(slugWasServed('it', PREFERRED_SLUG, tiJob)).toBeNull();
    const broken = path.join(os.tmpdir(), `published-slug-ledger-broken-${process.pid}-${seq++}.json`);
    fs.writeFileSync(broken, '{"synthetic-path": ', 'utf8');
    tmpFiles.push(broken);
    process.env.URL_FIRST_SEEN_PATH_OVERRIDE = broken;
    expect(() => slugWasServed('it', PREFERRED_SLUG, tiJob)).toThrow(/present but unreadable/);
  });

  it('fails closed when a present sharded ledger contains an unreadable shard', () => {
    const ledgerDir = fs.mkdtempSync(path.join(os.tmpdir(), `published-slug-shards-${process.pid}-`));
    tmpFiles.push(ledgerDir);
    for (const shardId of URL_FIRST_SEEN_SHARD_IDS) {
      fs.writeFileSync(path.join(ledgerDir, urlFirstSeenShardFileName(shardId)), '{}', 'utf8');
    }
    const brokenShard = path.join(ledgerDir, urlFirstSeenShardFileName(URL_FIRST_SEEN_SHARD_IDS[0]));
    fs.writeFileSync(brokenShard, '{"synthetic-path": ', 'utf8');
    process.env.URL_FIRST_SEEN_PATH_OVERRIDE = ledgerDir;
    expect(() => slugWasServed('it', PREFERRED_SLUG, tiJob)).toThrow(/present but unreadable/);
  });
});

describe('synthetic publication windows', () => {
  const identity = { company: 'Synthetic Employer', location: 'Sampletown' };
  const copiedSlug = 'synthetic-workshop-specialist-synthetic-employer-sampletown';

  it('does not classify an unknown synthetic employer as translation-gated', () => {
    const job = syntheticJob({ translationHoldSince: daysAgo(2) });
    expect(jobSlugsUnpublished(job)).toBe(false);
  });

  it('opens the recent-release window only for translate-run regeneration', () => {
    const released = syntheticJob({ translationHoldReleasedAt: daysAgo(0.05) });
    expect(jobSlugsUnpublished(released, { justReleased: true })).toBe(true);
    expect(mayReplacePublishedSlug(copiedSlug, identity, { job: released, justReleased: true })).toBe(true);
    expect(jobSlugsUnpublished(released)).toBe(false);
    expect(mayReplacePublishedSlug(copiedSlug, identity, { job: released })).toBe(false);
    const releasedLongAgo = { ...released, translationHoldReleasedAt: daysAgo(3) };
    expect(mayReplacePublishedSlug(copiedSlug, identity, { job: releasedLongAgo, justReleased: true })).toBe(false);
  });
});

describe('hardenJobLocaleFields keeps a served slug when only the title changes', () => {
  it('keeps a served preferred slug and retains a served title-derived alias', () => {
    const job = syntheticJob();
    useLedger(syntheticLedger(job));
    const [after] = harden([job]);
    expect(after.slugByLocale.it).toBe(PREFERRED_SLUG);
    expect(after.slug).toBe(PREFERRED_SLUG);
    expect(after.previousSlugsByLocale.it).toContain(TITLE_DERIVED_SLUG);
    expect(after.previousSlugsByLocale.it).not.toContain(PREFERRED_SLUG);
  });

  it('keeps the slice slug and mints no bridge when the ledger is absent', () => {
    useLedger(null);
    const [after] = harden([syntheticJob()]);
    expect(after.slugByLocale.it).toBe(PREFERRED_SLUG);
    expect(after.previousSlugsByLocale?.it ?? []).not.toContain(TITLE_DERIVED_SLUG);
  });

  it('is idempotent across repeated passes', () => {
    const job = syntheticJob();
    useLedger(syntheticLedger(job));
    const [first] = harden([job]);
    const [second] = harden([first]);
    expect(second.slugByLocale).toEqual(first.slugByLocale);
    expect(second.slug).toBe(first.slug);
    expect(second.previousSlugsByLocale).toEqual(first.previousSlugsByLocale);
  });

  it('keeps a served title-derived slug when the preferred slice slug was never served', () => {
    const job = syntheticJob();
    useLedger({ [canonicalPath('it', job, TITLE_DERIVED_SLUG)]: servedDate(20) });
    const [after] = harden([job]);
    expect(after.slugByLocale.it).toBe(TITLE_DERIVED_SLUG);
  });

  it('preserves existing collision handling for synthetic duplicate jobs', () => {
    const job = syntheticJob();
    useLedger(syntheticLedger(job));
    const twin = syntheticJob({ id: 'synthetic-job-0002', url: 'https://example.invalid/synthetic-job/0002' });
    const [first, second] = harden([job, twin]);
    expect(first.slugByLocale.it).toBe(TITLE_DERIVED_SLUG);
    expect(second.slugByLocale.it).toBe(TITLE_DERIVED_SLUG);
  });

  it('still re-derives a slug after the synthetic job moves', () => {
    useLedger(null);
    const moved = syntheticJob({
      slug: 'synthetic-role-synthetic-employer-oldtown',
      location: 'Newtown',
      addressLocality: 'Newtown',
      slugByLocale: {
        it: 'synthetic-role-synthetic-employer-oldtown',
        en: 'synthetic-support-specialist-oldtown',
        de: 'synthetic-support-specialist-altstadt',
        fr: 'synthetic-support-specialist-vieilleville',
      },
    });
    const [after] = harden([moved]);
    expect(after.slugByLocale.it).toBe('synthetic-support-specialist-synthetic-employer-newtown');
    expect(after.previousSlugsByLocale.it).toContain('synthetic-role-synthetic-employer-oldtown');
  });

  it('still fills a missing locale slug', () => {
    useLedger(null);
    const job = syntheticJob();
    delete (job.slugByLocale as Record<string, string>).fr;
    const [after] = harden([job]);
    expect(String(after.slugByLocale.fr || '')).not.toBe('');
  });
});

describe('ensureLocaleFields keeps a published translated slug', () => {
  it('does not discard a non-Italian slug copied from the preferred locale once served', () => {
    useLedger(null);
    const job = syntheticJob({
      slugByLocale: {
        it: PREFERRED_SLUG,
        en: PREFERRED_SLUG,
        de: 'synthetic-support-specialist-sampletown',
        fr: 'synthetic-support-specialist-sampletown',
      },
      titleByLocale: {
        it: 'Synthetic Support Specialist',
        en: 'Synthetic Support Specialist',
        de: 'Synthetic Support Specialist',
        fr: 'Synthetic Support Specialist',
      },
    });
    const output = ensureLocaleFields(job);
    expect(output.slugByLocale.en).toBe(PREFERRED_SLUG);
  });
});
