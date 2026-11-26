import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  buildFastLaneExpectedPagePlan,
  buildFastLaneHubVisibleJobIdsByLocale,
  checkJobPageContracts,
} from '../scripts/publish-jobs-fast.mjs';
import {
  ACTIVE_JOB_PAGE_LOCALES,
  buildActiveJobPathOwners,
  localizedActiveJobSlug,
} from '../build-plugins/shared/activeJobPageSelection';
import { buildCanonicalJobDetailPath } from '../build-plugins/shared/jobDetailPath';

const roots: string[] = [];
const controlledEnvNames = [
  'BUILD_LOCALE',
  'BUILD_STAGE',
  'FAST_BUILD',
  'JOBPOSTING_COVERAGE_OUT',
  'JOBS_FAST_DIST_DIR',
  'JOBS_FAST_RESULT_FILE',
  'JOBS_SEO_FALLBACK_WORKERS',
  'JOBS_SEO_SAMPLE',
] as const;
let previousEnv: Record<(typeof controlledEnvNames)[number], string | undefined>;
let resetJobsSeoSignal: (() => void) | undefined;
let resetLocaleJobsSplitSignal: (() => void) | undefined;

function daysAgo(days: number): string {
  return new Date(Date.now() - days * 86_400_000).toISOString();
}

function makeRoot(job: Record<string, unknown>): { root: string; distDir: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jobs-fast-isolated-render-'));
  roots.push(root);
  const dataDir = path.join(root, 'data');
  const appDistDir = path.join(root, 'dist');
  const distDir = path.join(root, '.fast-dist');
  fs.mkdirSync(dataDir, { recursive: true });
  fs.mkdirSync(appDistDir, { recursive: true });
  fs.mkdirSync(distDir, { recursive: true });
  fs.symlinkSync(path.resolve('scripts'), path.join(root, 'scripts'), 'dir');
  fs.copyFileSync(
    path.resolve('data/canton-url-slugs.json'),
    path.join(dataDir, 'canton-url-slugs.json'),
  );
  fs.writeFileSync(path.join(dataDir, 'jobs.json'), JSON.stringify([job]));
  fs.writeFileSync(path.join(dataDir, 'expired-jobs.json'), '[]');
  fs.writeFileSync(path.join(dataDir, 'employer-profiles.json'), JSON.stringify({ profiles: [], belowFloor: [] }));
  fs.writeFileSync(
    path.join(appDistDir, 'index.html'),
    '<!doctype html><html><head><script type="module" src="/assets/index-test.js"></script></head><body><div id="root"></div></body></html>',
  );
  return { root, distDir };
}

async function loadBuildModules() {
  vi.resetModules();
  const [jobRenderer, employerRenderer, signals, inventory, canton] = await Promise.all([
    import('../build-plugins/jobsSeoPagesPlugin'),
    import('../build-plugins/employerProfilePagesPlugin'),
    import('../build-plugins/shared/buildSignals'),
    import('../services/jobBoardInventory'),
    import('../build-plugins/shared/cantonSection'),
  ]);
  resetJobsSeoSignal = signals._resetJobsSeoPagesSignalForTests;
  resetLocaleJobsSplitSignal = signals._resetLocaleJobsSplitSignalForTests;
  return { jobRenderer, employerRenderer, signals, inventory, canton };
}

afterEach(() => {
  vi.restoreAllMocks();
  resetJobsSeoSignal?.();
  resetLocaleJobsSplitSignal?.();
  resetJobsSeoSignal = undefined;
  resetLocaleJobsSplitSignal = undefined;
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
  for (const name of controlledEnvNames) {
    const value = previousEnv[name];
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
});

describe('fast publisher isolated renderer dist', () => {
  it('renders a non-empty publisher batch, writes the receipt, and passes its render contract without a full slug map', async () => {
    previousEnv = Object.fromEntries(controlledEnvNames.map((name) => [name, process.env[name]])) as typeof previousEnv;
    for (const name of controlledEnvNames) delete process.env[name];
    process.env.JOBS_SEO_FALLBACK_WORKERS = '0';

    const job = {
      id: 'fast-publish-runtime-active',
      slug: 'fast-publish-runtime-master',
      slugByLocale: {
        it: 'fast-publish-runtime-master',
        en: 'fast-publish-runtime-en',
        de: 'fast-publish-runtime-de',
        fr: 'fast-publish-runtime-fr',
      },
      previousSlugs: ['fast-publish-runtime-previous'],
      previousSlugsByLocale: { en: ['fast-publish-runtime-previous-en'] },
      title: 'Specialista amministrativo',
      titleByLocale: {
        it: 'Specialista amministrativo',
        en: 'Administrative specialist',
        de: 'Verwaltungsspezialist',
        fr: 'Spécialiste administratif',
      },
      company: 'Fast Publisher Runtime Example AG',
      companyKey: 'fast-publisher-runtime-example',
      canton: 'ZH',
      location: 'Zürich',
      addressLocality: 'Zürich',
      postalCode: '8001',
      streetAddress: 'Bahnhofstrasse 1',
      description: 'La posizione richiede esperienza professionale, precisione e capacità organizzative. Il team offre formazione continua, un contratto stabile e condizioni trasparenti. La persona selezionata collaborerà con il gruppo di lavoro e gestirà le attività quotidiane nel rispetto delle procedure aziendali. Lavorerà con i reparti interni, seguirà le procedure di qualità, contribuirà alla pianificazione dei progetti e comunicherà con colleghi e responsabili. Sono richieste affidabilità, autonomia e disponibilità a imparare. L’azienda mette a disposizione strumenti adeguati, un ambiente collaborativo e colloqui periodici per accompagnare lo sviluppo professionale.',
      descriptionByLocale: {
        it: 'La posizione richiede esperienza professionale, precisione e capacità organizzative. Il team offre formazione continua, un contratto stabile e condizioni trasparenti. La persona selezionata collaborerà con il gruppo di lavoro e gestirà le attività quotidiane nel rispetto delle procedure aziendali. Lavorerà con i reparti interni, seguirà le procedure di qualità, contribuirà alla pianificazione dei progetti e comunicherà con colleghi e responsabili. Sono richieste affidabilità, autonomia e disponibilità a imparare. L’azienda mette a disposizione strumenti adeguati, un ambiente collaborativo e colloqui periodici per accompagnare lo sviluppo professionale.',
        en: 'The role requires professional experience, precision, and strong organizational skills. The team offers continued training, a stable contract, and transparent conditions.',
        de: 'Die Stelle erfordert Berufserfahrung, Genauigkeit und Organisationstalent. Das Team bietet Weiterbildung, einen unbefristeten Vertrag und transparente Bedingungen.',
        fr: 'Le poste demande une expérience professionnelle, de la précision et un bon sens de l’organisation. L’équipe propose une formation continue, un contrat stable et des conditions transparentes.',
      },
      employmentType: 'FULL_TIME',
      contract: 'full-time',
      salaryMin: 70000,
      salaryMax: 90000,
      url: 'https://example.test/careers/fast-publish-runtime-active/',
      postingDateSource: 'reported',
      datePosted: daysAgo(2),
      postedDate: daysAgo(2),
      firstSeenAt: daysAgo(3),
      crawledAt: daysAgo(1),
    };
    const { root, distDir } = makeRoot(job);
    const receiptFile = path.join(root, 'tmp', 'render-receipt.json');
    process.env.JOBS_FAST_DIST_DIR = distDir;
    process.env.JOBS_FAST_RESULT_FILE = receiptFile;

    const { jobRenderer, employerRenderer, signals, inventory, canton } = await loadBuildModules();
    const batchIds = [job.id];
    const validJobs = [inventory.normalizeListingIdentity(job)];
    const helpers = {
      buildCanonicalJobDetailPath,
      resolveJobCanton: canton.resolveJobCanton,
    };
    const pathOwners = buildActiveJobPathOwners(
      validJobs,
      ACTIVE_JOB_PAGE_LOCALES,
      helpers.resolveJobCanton,
      localizedActiveJobSlug,
    );
    const expectedPagePlan = buildFastLaneExpectedPagePlan(validJobs, batchIds, helpers, pathOwners);
    const fastLaneVisibleJobIdsByLocale = buildFastLaneHubVisibleJobIdsByLocale(
      validJobs,
      batchIds,
      '',
      helpers,
    );

    await employerRenderer.employerProfilePagesPlugin(root, {
      metadataOnlySlugs: ['fast-publisher-runtime-example'],
    }).closeBundle();

    const mapPath = path.resolve(distDir, 'data', 'jobs-slug-map.json');
    const mapAccesses: string[] = [];
    const existsSync = fs.existsSync.bind(fs);
    const readFileSync = fs.readFileSync.bind(fs);
    vi.spyOn(fs, 'existsSync').mockImplementation((filePath) => {
      if (path.resolve(String(filePath)) === mapPath) {
        mapAccesses.push('existsSync');
        return false;
      }
      return existsSync(filePath);
    });
    vi.spyOn(fs, 'readFileSync').mockImplementation((filePath, options) => {
      if (path.resolve(String(filePath)) === mapPath) {
        mapAccesses.push('readFileSync');
        throw new Error('fast lane attempted to read the full-build Worker slug map');
      }
      return readFileSync(filePath, options as BufferEncoding);
    });

    const renderer = jobRenderer.jobsSeoPagesPlugin(root, {
      activeJobIds: batchIds,
      fastLaneVisibleJobIdsByLocale,
      fastLaneDistDir: distDir,
      fastLane: true,
      fastLaneResultFile: receiptFile,
    });
    await (renderer.closeBundle as () => Promise<void>).call(renderer);

    expect(mapAccesses).toEqual([]);
    expect(existsSync(mapPath)).toBe(false);
    await expect(signals.jobsSeoPagesFlushed).resolves.toBeUndefined();

    const fullBuildSitemapLocs = signals.getJobSitemapAllowlist();
    expect(fullBuildSitemapLocs).not.toBeNull();
    const receipt = JSON.parse(fs.readFileSync(receiptFile, 'utf8'));
    checkJobPageContracts(receipt, expectedPagePlan);
    expect(receipt.schema).toBe('jobs-fast-render/v1');
    expect(receipt.requestedIds).toEqual(batchIds);
    expect(receipt.pages.length).toBeGreaterThan(0);
    expect(receipt.pages.length).toBe(expectedPagePlan.pagesById.get(job.id)?.length);

    for (const locale of ['en', 'de', 'fr'] as const) {
      const legacyLocaleRoute = buildCanonicalJobDetailPath(locale, job, job.slug, 'ZH');
      expect(fs.existsSync(path.join(distDir, legacyLocaleRoute.slice(1), 'index.html'))).toBe(false);
    }
    const legacyTiRoute = buildCanonicalJobDetailPath('it', job, job.slug, 'TI');
    expect(fs.existsSync(path.join(distDir, legacyTiRoute.slice(1), 'index.html'))).toBe(false);
    const previousSlugRoute = buildCanonicalJobDetailPath('it', job, job.previousSlugs[0], 'ZH');
    expect(fs.existsSync(path.join(distDir, previousSlugRoute.slice(1), 'index.html'))).toBe(false);
    const previousLocaleSlugRoute = buildCanonicalJobDetailPath('en', job, job.previousSlugsByLocale.en[0], 'ZH');
    expect(fs.existsSync(path.join(distDir, previousLocaleSlugRoute.slice(1), 'index.html'))).toBe(false);
  });

  it('keeps the non-fast full-build Worker-map loader valid and fail-closed', async () => {
    previousEnv = Object.fromEntries(controlledEnvNames.map((name) => [name, process.env[name]])) as typeof previousEnv;
    for (const name of controlledEnvNames) delete process.env[name];
    const { root, distDir } = makeRoot({});
    const { jobRenderer } = await loadBuildModules();
    const mapPath = path.join(distDir, 'data', 'jobs-slug-map.json');

    expect(() => jobRenderer.readFinalWorkerSlugMap(distDir)).toThrow(
      '[job-alias-redirect-gate] final Worker slug map is missing before bridge classification',
    );
    fs.mkdirSync(path.dirname(mapPath), { recursive: true });
    fs.writeFileSync(mapPath, '{invalid');
    expect(() => jobRenderer.readFinalWorkerSlugMap(distDir)).toThrow(
      '[job-alias-redirect-gate] final Worker slug map is not valid JSON',
    );
    fs.writeFileSync(mapPath, '{}');
    expect(() => jobRenderer.readFinalWorkerSlugMap(distDir)).toThrow(
      '[job-alias-redirect-gate] final Worker slug map is not an array',
    );
    fs.writeFileSync(mapPath, '[]');
    expect(jobRenderer.readFinalWorkerSlugMap(distDir)).toEqual([]);
  });

  it('rebuilds the full-build sitemap allowlist without rendering a zero-page batch', async () => {
    previousEnv = Object.fromEntries(controlledEnvNames.map((name) => [name, process.env[name]])) as typeof previousEnv;
    for (const name of controlledEnvNames) delete process.env[name];
    process.env.JOBS_SEO_FALLBACK_WORKERS = '0';

    const job = {
      id: 'fast-publish-sitemap-maintenance',
      slug: 'fast-publish-sitemap-maintenance',
      title: 'Specialista amministrativo',
      company: 'Sitemap Maintenance Example AG',
      companyKey: 'sitemap-maintenance-example',
      canton: 'ZH',
      location: 'Zürich',
      addressLocality: 'Zürich',
      postalCode: '8001',
      streetAddress: 'Bahnhofstrasse 1',
      description: 'La posizione richiede esperienza professionale, precisione e capacità organizzative. Il team offre formazione continua, un contratto stabile e condizioni trasparenti. La persona selezionata collaborerà con il gruppo di lavoro e gestirà le attività quotidiane nel rispetto delle procedure aziendali. Lavorerà con i reparti interni, seguirà le procedure di qualità, contribuirà alla pianificazione dei progetti e comunicherà con colleghi e responsabili. Sono richieste affidabilità, autonomia e disponibilità a imparare. L’azienda mette a disposizione strumenti adeguati, un ambiente collaborativo e colloqui periodici per accompagnare lo sviluppo professionale.',
      employmentType: 'FULL_TIME',
      contract: 'full-time',
      salaryMin: 70000,
      salaryMax: 90000,
      url: 'https://example.test/careers/fast-publish-sitemap-maintenance/',
      datePosted: daysAgo(2),
      postedDate: daysAgo(2),
      firstSeenAt: daysAgo(3),
      crawledAt: daysAgo(1),
    };
    const { root, distDir } = makeRoot(job);
    const receiptFile = path.join(root, 'tmp', 'render-receipt.json');
    process.env.JOBS_FAST_DIST_DIR = distDir;
    process.env.JOBS_FAST_RESULT_FILE = receiptFile;

    const { jobRenderer, signals } = await loadBuildModules();
    const renderer = jobRenderer.jobsSeoPagesPlugin(root, {
      activeJobIds: [],
      fastLaneVisibleJobIdsByLocale: { it: [], en: [], de: [], fr: [] },
      fastLaneDistDir: distDir,
      fastLane: true,
      fastLaneSitemapOnly: true,
      fastLaneResultFile: receiptFile,
    });
    await (renderer.closeBundle as () => Promise<void>).call(renderer);

    await expect(signals.jobsSeoPagesFlushed).resolves.toBeUndefined();
    const fullBuildSitemapLocs = signals.getJobSitemapAllowlist();
    expect(fullBuildSitemapLocs).not.toBeNull();
    expect(fullBuildSitemapLocs?.size).toBeGreaterThan(0);
    expect(JSON.parse(fs.readFileSync(receiptFile, 'utf8'))).toEqual({
      schema: 'jobs-fast-render/v1',
      requestedIds: [],
      pages: [],
      sitemapEntries: [],
      hubUpdates: [],
    });
  });
});
