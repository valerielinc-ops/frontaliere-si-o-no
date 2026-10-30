// @vitest-environment jsdom

import { beforeAll, describe, expect, it, afterEach } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import {
  ADMIN_SECTION_GROUPS,
  ADMIN_SECTION_SLUGS,
  ADMIN_SECTIONS,
  getVisibleAdminSections,
} from '@/components/admin/adminSections';
import {
  ADMIN_ROUTE_SLUG,
  emitAdminStaticShells,
} from '@/build-plugins/adminDataPlugin';
import { DEFAULT_JOBS_CRAWLER_CONFIG } from '@/components/admin/lib/jobsCrawlerConfig';
import { JOBS_CRAWLER_CONFIG_DEFAULTS } from '../functions/src/jobsCrawlerConfig.js';

const ADMIN_ROOT = resolve(__dirname, '..', 'components', 'admin');
const SERVICES_ROOT = resolve(__dirname, '..', 'services');
const routerDataAvailable = [
  'routerBlogData.ts', 'routerSwissData.ts', 'blogArticleIds.ts',
].every((file) => existsSync(resolve(__dirname, '..', 'services', file)));
const ALL_LOCALES = ['it', 'en', 'de', 'fr'] as const;
const EXPECTED_LIVE_SLUGS = [
  '', 'crawler', 'automazioni', 'configurazione-crawler', 'aziende', 'candidature', 'servizio-candidature',
  'redazione', 'giornalisti', 'newsletter', 'salute',
  'flag', 'registro',
] as const;
const BASE_ADMIN_CLOUD_FUNCTIONS = [
  'adminGithub',
  'adminJobsCrawlerConfig',
  'adminEmployerInsights',
  'adminSendColdEmail',
  'manageJournalistRole',
  'manageRedazioneAdmin',
  'geminiGenerate',
  'manageAssistedApplicationAdmin',
  'applicationConcierge',
  'manageApplicationConcierge',
  'adminAuditLog',
  'adminRemoteConfig',
] as const;

function adminFiles(root: string): string[] {
  return readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
    const path = join(root, entry.name);
    return entry.isDirectory() ? adminFiles(path) : [path];
  });
}

describe('admin fase 1 registry', () => {
  it('keeps live and planned slugs distinct and grouped', () => {
    expect(ADMIN_SECTION_SLUGS).toEqual(EXPECTED_LIVE_SLUGS);
    expect(new Set(ADMIN_SECTIONS.map((section) => section.slug)).size).toBe(ADMIN_SECTIONS.length);
    expect(ADMIN_SECTIONS.filter((section) => section.slug === '')).toHaveLength(1);
    expect(ADMIN_SECTIONS.filter((section) => section.slug !== '').every((section) => /^[a-z0-9-]+$/.test(section.slug))).toBe(true);
    expect(ADMIN_SECTIONS.every((section) => ADMIN_SECTION_GROUPS.includes(section.group))).toBe(true);
    expect(ADMIN_SECTIONS.filter((section) => section.planned).map((section) => section.slug)).toEqual([]);
    expect(getVisibleAdminSections().map((section) => section.slug)).toEqual(EXPECTED_LIVE_SLUGS);
  });

});

describe('admin crawler configuration defaults', () => {
  it('maps the client state from the Cloud Function defaults', () => {
    expect(DEFAULT_JOBS_CRAWLER_CONFIG).toEqual({
      domainWhitelist: JOBS_CRAWLER_CONFIG_DEFAULTS.domainWhitelist,
      domainBlacklist: JOBS_CRAWLER_CONFIG_DEFAULTS.domainBlacklist,
      minQualityScore: JOBS_CRAWLER_CONFIG_DEFAULTS.minQualityScore,
      minDescriptionChars: JOBS_CRAWLER_CONFIG_DEFAULTS.minDescriptionChars,
      aiLocalizationEnabled: JOBS_CRAWLER_CONFIG_DEFAULTS.aiLocalizationEnabled,
      aiLocalizationMaxJobsPerRun: JOBS_CRAWLER_CONFIG_DEFAULTS.aiLocalizationMaxJobsPerRun,
      contentReuseEnabled: JOBS_CRAWLER_CONFIG_DEFAULTS.contentReuse.enabled,
      contentReuseSimilarityThreshold: JOBS_CRAWLER_CONFIG_DEFAULTS.contentReuse.similarityThreshold,
      contentReuseMinSourceChars: JOBS_CRAWLER_CONFIG_DEFAULTS.contentReuse.minSourceChars,
      contentReuseMaxLengthDeltaRatio: JOBS_CRAWLER_CONFIG_DEFAULTS.contentReuse.maxLengthDeltaRatio,
      companyPriorityByDomain: JOBS_CRAWLER_CONFIG_DEFAULTS.companyPriority.byDomain,
      companyPriorityByName: JOBS_CRAWLER_CONFIG_DEFAULTS.companyPriority.byName,
      sourceSeedsByDomain: JOBS_CRAWLER_CONFIG_DEFAULTS.sourceSeeds.byDomain,
      sourceSeedsByName: JOBS_CRAWLER_CONFIG_DEFAULTS.sourceSeeds.byName,
    });
  });
});

describe.skipIf(!routerDataAvailable)('admin fase 1 router', () => {
  let router: typeof import('@/services/router');

  beforeAll(async () => {
    router = await import('@/services/router');
  });

  it.each(ALL_LOCALES)('round-trips every section with the %s locale prefix', (locale) => {
    for (const slug of ADMIN_SECTION_SLUGS) {
      const path = router.buildPath({ activeTab: 'admin', adminSection: slug }, locale);
      expect(path.endsWith('/')).toBe(true);
      const parsed = router.parsePath(`${path}?q=condivisibile`).route;
      expect(parsed.activeTab).toBe('admin');
      expect(parsed.adminSection).toBe(slug);
    }
  });

  it('falls back to the admin root for an unknown section', () => {
    const parsed = router.parsePath('/en/gestione-contenuti-xk9mp2q/non-esiste/').route;
    expect(parsed.activeTab).toBe('admin');
    expect(parsed.adminSection).toBe('');
  });

  it('keeps query state when the router pushes the same admin path', () => {
    const path = router.buildPath({ activeTab: 'admin', adminSection: 'aziende' }, 'it');
    window.history.replaceState({}, '', `${path}?q=acme&azienda=acme-key`);
    router.pushRoute({ activeTab: 'admin', adminSection: 'aziende' });
    expect(window.location.pathname).toBe(path);
    expect(window.location.search).toBe('?q=acme&azienda=acme-key');
  });
});

describe('admin static shells', () => {
  let temporaryRoot: string | undefined;

  afterEach(() => {
    if (temporaryRoot) rmSync(temporaryRoot, { recursive: true, force: true });
    temporaryRoot = undefined;
  });

  it('emits one noindex shell per live section and none for planned sections', () => {
    temporaryRoot = mkdtempSync(join(tmpdir(), 'frontaliere-admin-shells-'));
    const shell = '<!doctype html><html><head><meta name="robots" content="index,follow"></head><body></body></html>';
    const emitted = emitAdminStaticShells(temporaryRoot, shell);
    expect(emitted).toHaveLength(EXPECTED_LIVE_SLUGS.length);

    for (const slug of EXPECTED_LIVE_SLUGS) {
      const relative = slug ? join(ADMIN_ROUTE_SLUG, slug, 'index.html') : join(ADMIN_ROUTE_SLUG, 'index.html');
      const target = join(temporaryRoot, relative);
      expect(existsSync(target), relative).toBe(true);
      expect(readFileSync(target, 'utf8')).toMatch(/name="robots" content="noindex, nofollow"/);
    }
    expect(existsSync(join(temporaryRoot, ADMIN_ROUTE_SLUG, 'flag', 'index.html'))).toBe(true);
    expect(existsSync(join(temporaryRoot, ADMIN_ROUTE_SLUG, 'registro', 'index.html'))).toBe(true);
  });

  it('keeps shared admin links on the non-localized canonical route', () => {
    const source = readFileSync(resolve(__dirname, '..', 'components', 'admin', 'lib', 'adminNavigation.ts'), 'utf8');
    expect(source).toContain("buildPath({ activeTab: 'admin', adminSection: section }, 'it')");
  });
});

describe('admin article corpus import boundary', () => {
  it('keeps blog-articles-data imports inside the redazione section', () => {
    const offenders = adminFiles(ADMIN_ROOT).filter((file) => {
      if (file.endsWith(join('sections', 'RedazioneSection.tsx'))) return false;
      if (!statSync(file).isFile()) return false;
      return /(?:@\/data\/blog-articles-data|blog-articles-data)/.test(readFileSync(file, 'utf8'));
    });
    expect(offenders).toEqual([]);
  });
});

describe('admin fase 1 section boundaries', () => {
  it('has no legacy section adapter and keeps every admin file below the review ceiling', () => {
    const files = adminFiles(ADMIN_ROOT);
    expect(files.some((file) => file.endsWith('AdminLegacySection.tsx'))).toBe(false);
    expect(files.every((file) => statSync(file).size >= 0)).toBe(true);
    const oversized = files.filter((file) => readFileSync(file, 'utf8').split('\n').length > 900);
    expect(oversized).toEqual([]);
    expect(readFileSync(resolve(__dirname, '..', 'components', 'pages', 'AdminPanel.tsx'), 'utf8').split('\n').length).toBeLessThanOrEqual(30);
  });

  it('loads each live section as an independent lazy module', () => {
    const source = readFileSync(resolve(ADMIN_ROOT, 'AdminApp.tsx'), 'utf8');
    for (const name of ['Oggi', 'Crawler', 'Automazioni', 'ConfigurazioneCrawler', 'Aziende', 'Candidature', 'Redazione', 'Giornalisti', 'Newsletter', 'Salute', 'Flag', 'Registro']) {
      expect(source).toContain(`const ${name}Section = lazy(() => import('./sections/${name}Section'))`);
    }
  });
});

describe('admin Cloud Function endpoint parity', () => {
  it('keeps every endpoint used by the base admin surface in an admin module or service', () => {
    const source = [...adminFiles(ADMIN_ROOT), ...adminFiles(SERVICES_ROOT)]
      .filter((file) => /\.(?:ts|tsx|js|mjs)$/.test(file))
      .filter((file) => existsSync(file) && statSync(file).isFile())
      .map((file) => readFileSync(file, 'utf8'))
      .join('\n');
    expect(BASE_ADMIN_CLOUD_FUNCTIONS.filter((endpoint) => !source.includes(endpoint))).toEqual([]);
  });
});
