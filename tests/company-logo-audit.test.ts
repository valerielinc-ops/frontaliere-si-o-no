import { existsSync, readFileSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  assessLogoQuality,
  auditCompanyLogos,
  classifyLogoReference,
  companyKeyForJob,
  loadCanonicalJobs,
  readImageDimensions,
} from '../scripts/lib/company-logo-audit.mjs';
import { directLogoSources, loadLogoRegistry } from '../scripts/lib/company-logo-registry.mjs';
import { companyLogoKeyForJob } from '../scripts/lib/company-logo-key.mjs';
import { resolveCompanyLogoUrl } from '../services/jobDataNormalization.ts';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function pngBytes(width = 128, height = 128) {
  const bytes = Buffer.alloc(24);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  bytes.writeUInt32BE(width, 16);
  bytes.writeUInt32BE(height, 20);
  return bytes;
}

function icoBytes(entries) {
  const bytes = Buffer.alloc(6 + entries.length * 16);
  bytes.writeUInt16LE(1, 2);
  bytes.writeUInt16LE(entries.length, 4);
  entries.forEach(([width, height], index) => {
    const offset = 6 + index * 16;
    bytes[offset] = width === 256 ? 0 : width;
    bytes[offset + 1] = height === 256 ? 0 : height;
  });
  return bytes;
}

function imageResponse(status = 200, body = pngBytes()) {
  return new Response(body, {
    status,
    headers: { 'content-type': 'image/png' },
  });
}

describe('company-logo-audit', () => {
  it('classifies resolver output without treating initials as a real logo', () => {
    expect(classifyLogoReference(null)).toEqual({ kind: 'missing', reference: null });
    expect(classifyLogoReference('data:image/svg+xml;utf8,abc').kind).toBe('initials');
    expect(classifyLogoReference('/images/brands/acme.png')).toEqual({
      kind: 'local',
      reference: '/images/brands/acme.png',
    });
    expect(classifyLogoReference('https://acme.test/logo.svg')).toEqual({
      kind: 'external',
      reference: 'https://acme.test/logo.svg',
    });
    expect(classifyLogoReference('logo:acme').kind).toBe('invalid');
  });

  it('flags raster logos that are too small for the rendered logo slots', () => {
    expect(readImageDimensions(pngBytes(16, 16))).toEqual({
      width: 16,
      height: 16,
      vector: false,
    });
    expect(assessLogoQuality({ format: 'png', width: 16, height: 16 })).toEqual(expect.objectContaining({
      status: 'low-quality',
      reason: 'intrinsic-dimensions-too-small',
      maxDimension: 16,
    }));
    expect(assessLogoQuality({ format: 'png', width: 128, height: 64 }).status).toBe('good');
    expect(assessLogoQuality({ format: 'svg' })).toEqual({ status: 'good', reason: 'vector' });
    expect(readImageDimensions(icoBytes([[16, 16], [128, 64]])).width).toBe(128);
  });

  it('fails closed when the canonical dataset is missing or below the floor', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'company-logo-audit-'));
    try {
      await expect(loadCanonicalJobs({ root })).rejects.toThrow('Canonical job dataset not found');
      await writeFile(path.join(root, 'jobs.json'), JSON.stringify({ jobs: [] }));
      await expect(loadCanonicalJobs({ root, file: 'jobs.json', minJobs: 1 }))
        .rejects.toThrow('unexpectedly small');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('reports missing, broken and partial coverage from the effective resolver', async () => {
    const jobs = [
      { id: 'missing-1', companyKey: 'missing', company: 'Missing AG', url: 'https://missing.test/1' },
      { id: 'broken-1', companyKey: 'broken', company: 'Broken AG', url: 'https://broken.test/1' },
      { id: 'partial-1', companyKey: 'partial', company: 'Partial AG', url: 'https://partial.test/1' },
      { id: 'partial-2', companyKey: 'partial', company: 'Partial AG', url: 'https://partial.test/2' },
      { id: 'valid-1', companyKey: 'valid', company: 'Valid AG', url: 'https://valid.test/1' },
    ];
    const resolveLogo = (job: { companyKey?: string }) => {
      if (job.companyKey === 'broken') return 'https://broken.test/logo.svg';
      if (job.companyKey === 'partial' && job === jobs[2]) return '/images/brands/partial.png';
      if (job.companyKey === 'valid') return '/images/brands/valid.png';
      return null;
    };
    const fetchImpl = async (url: string) => {
      if (url === 'https://cdn.test/images/brands/partial.png') return imageResponse();
      if (url === 'https://cdn.test/images/brands/valid.png') return imageResponse();
      if (url === 'https://broken.test/logo.svg') return imageResponse(404);
      throw new Error(`unexpected fetch ${url}`);
    };

    const report = await auditCompanyLogos(jobs, {
      resolveLogo,
      assetBaseUrl: 'https://cdn.test',
      fetchImpl,
    });

    expect(report.companiesTotal).toBe(4);
    expect(report.withLogo).toBe(1);
    expect(report.missing).toBe(1);
    expect(report.missingJobCount).toBe(1);
    expect(report.broken).toBe(1);
    expect(report.brokenJobCount).toBe(1);
    expect(report.partial).toBe(1);
    expect(report.partialJobCount).toBe(1);
    expect(report.referenceCount).toBe(3);
    expect(report.validReferenceCount).toBe(2);
    expect(report.qualityOkReferenceCount).toBe(2);
    expect(report.affectedCompanies.map((company) => company.companyKey)).toEqual([
      'broken',
      'missing',
      'partial',
    ]);
    expect(report.references).toEqual([
      expect.objectContaining({
        reference: 'https://broken.test/logo.svg',
        status: 'broken',
        reason: 'http-404',
      }),
    ]);
  });

  it('aggregates legacy Ticino Comune records by municipality employer, not by crawler family', async () => {
    const jobs = [
      {
        company: 'Comune di Uno',
        companyKey: 'comuni-ticino',
        municipalityKey: 'comune-di-uno',
        url: 'https://uno.example/1',
      },
      {
        company: 'Comune di Due',
        companyKey: 'comuni-ticino',
        municipalityKey: 'comune-di-due',
        url: 'https://due.example/1',
      },
    ];

    expect(jobs.map(companyKeyForJob)).toEqual(['comune-di-uno', 'comune-di-due']);
    const report = await auditCompanyLogos(jobs, {
      resolveLogo: () => null,
    });

    expect(report.affectedCompanies.map((company) => company.companyKey)).toEqual([
      'comune-di-due',
      'comune-di-uno',
    ]);
  });

  it('does not count a reachable external URL as stable CDN coverage', async () => {
    const jobUrl = 'https://external.test/job/1';
    const report = await auditCompanyLogos([
      { companyKey: 'external', company: 'External AG', url: jobUrl },
    ], {
      resolveLogo: () => 'https://external.test/logo.png',
      fetchImpl: async () => imageResponse(),
    });

    expect(report.withLogo).toBe(0);
    expect(report.external).toBe(1);
    expect(report.externalJobCount).toBe(1);
    expect(report.affectedCompanies[0]).toMatchObject({
      companyKey: 'external',
      status: 'external',
      externalJobCount: 1,
      examples: { external: jobUrl },
    });
    expect(report.references[0]).toEqual(expect.objectContaining({
      kind: 'external',
      status: 'valid',
    }));
  });

  it('rejects a successful HTTP response that is not an image', async () => {
    const report = await auditCompanyLogos([
      { companyKey: 'html', company: 'HTML AG', url: 'https://html.test/1' },
    ], {
      resolveLogo: () => 'https://html.test/logo',
      fetchImpl: async () => new Response('<html>not a logo</html>', {
        status: 200,
        headers: { 'content-type': 'text/html' },
      }),
    });

    expect(report.broken).toBe(1);
    expect(report.brokenJobCount).toBe(1);
    expect(report.references[0]).toEqual(expect.objectContaining({
      status: 'broken',
      reason: 'not-an-image',
    }));
  });

  it('reports checkout assets pending CDN deployment without counting coverage as valid', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'company-logo-pending-'));
    try {
      await mkdir(path.join(root, 'public/images/brands'), { recursive: true });
      await writeFile(path.join(root, 'public/images/brands/pending.png'), pngBytes(128, 128));
      const jobUrl = 'https://pending.test/job/1';
      const report = await auditCompanyLogos([
        { companyKey: 'pending', company: 'Pending AG', url: jobUrl },
      ], {
        resolveLogo: () => '/images/brands/pending.png',
        assetBaseUrl: 'https://cdn.test',
        localAssetRoot: root,
        fetchImpl: async () => imageResponse(404),
      });

      expect(report.withLogo).toBe(0);
      expect(report.broken).toBe(0);
      expect(report.pendingDeploy).toBeGreaterThan(0);
      expect(report.pendingDeployJobCount).toBeGreaterThan(0);
      expect(report.affectedCompanies[0]).toMatchObject({
        companyKey: 'pending',
        status: 'pending-deploy',
        pendingDeployJobCount: 1,
        examples: { pendingDeploy: jobUrl },
      });
      expect(report.references[0]).toEqual(expect.objectContaining({
        status: 'pending-deploy',
        reason: 'asset-present-in-checkout',
        cdnStatus: 'broken',
        localPath: '/images/brands/pending.png',
      }));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('reports low-quality logos separately from missing and broken coverage', async () => {
    const jobUrl = 'https://nsn.test/job/1';
    const report = await auditCompanyLogos([
      { companyKey: 'nsn-medical', company: 'NSN Medical Group', url: jobUrl },
    ], {
      resolveLogo: () => 'https://cdn.test/images/brands/nsn-medical.png',
      fetchImpl: async () => imageResponse(200, pngBytes(16, 16)),
      assetBaseUrl: 'https://cdn.test',
    });

    expect(report.missing).toBe(0);
    expect(report.broken).toBe(0);
    expect(report.lowQuality).toBe(1);
    expect(report.lowQualityJobCount).toBe(1);
    expect(report.qualityOkReferenceCount).toBe(0);
    expect(report.affectedCompanies[0]).toMatchObject({
      companyKey: 'nsn-medical',
      status: 'low-quality',
      qualityStatus: 'low-quality',
      lowQualityJobCount: 1,
      examples: { lowQuality: jobUrl },
    });
    expect(report.references[0]).toEqual(expect.objectContaining({
      qualityStatus: 'low-quality',
      qualityReason: 'intrinsic-dimensions-too-small',
      width: 16,
      height: 16,
    }));
  });

  it('keeps the verified Conservatorio raster above the quality floor', () => {
    const dimensions = readImageDimensions(readFileSync(
      path.join(REPO_ROOT, 'public/images/brands/conservatorio.png'),
    ));

    expect(dimensions).toEqual(expect.objectContaining({
      vector: false,
      width: expect.any(Number),
      height: expect.any(Number),
    }));
    expect(Math.max(dimensions.width || 0, dimensions.height || 0))
      .toBeGreaterThanOrEqual(96);
    expect(assessLogoQuality({
      format: 'png',
      width: dimensions.width,
      height: dimensions.height,
    })).toEqual(expect.objectContaining({ status: 'good' }));
  });

  it('rejects an HTML error page even when the server lies about its MIME type', async () => {
    const report = await auditCompanyLogos([
      { companyKey: 'mislabeled', company: 'Mislabeled AG', url: 'https://html.test/1' },
    ], {
      resolveLogo: () => 'https://html.test/logo',
      fetchImpl: async () => new Response('<html>not a logo</html>', {
        status: 200,
        headers: { 'content-type': 'image/png' },
      }),
    });

    expect(report.broken).toBe(1);
    expect(report.references[0].reason).toBe('not-an-image');
  });

  it('keeps every manifest path backed by a local public asset', () => {
    const manifest = JSON.parse(readFileSync(
      path.join(REPO_ROOT, 'data/company-logos-manifest.json'),
      'utf8',
    ));

    for (const [companyKey, publicPath] of Object.entries(manifest)) {
      expect(publicPath, `${companyKey} has an invalid manifest path`).toMatch(/^\/images\//);
      // The blocking test checkout materializes the small brands bucket; the
      // legacy curated SVGs under /images/logos/ belong to a different profile.
      if (!publicPath.startsWith('/images/brands/')) continue;
      expect(
        existsSync(path.join(REPO_ROOT, 'public', publicPath.slice(1))),
        `${companyKey} points to a missing local asset: ${publicPath}`,
      ).toBe(true);
    }
  });

  it('keeps every directly declared registry source mapped to a stable CDN asset', async () => {
    const manifest = JSON.parse(readFileSync(
      path.join(REPO_ROOT, 'data/company-logos-manifest.json'),
      'utf8',
    ));
    const directSources = directLogoSources(await loadLogoRegistry(REPO_ROOT));

    expect(directSources.length).toBeGreaterThan(0);
    for (const { slug } of directSources) {
      expect(manifest[slug], `${slug} has no stable manifest entry`).toMatch(/^\/images\//);
    }
  });

  it('keeps both scheduled workflows on the canonical dataset and tsx resolver path', () => {
    const auditWorkflow = readFileSync(
      path.join(REPO_ROOT, '.github/workflows/audit-missing-company-logos.yml'),
      'utf8',
    );
    const verifyWorkflow = readFileSync(
      path.join(REPO_ROOT, '.github/workflows/verify-company-logos-weekly.yml'),
      'utf8',
    );

    const installMarker = 'run: npm ci --ignore-scripts --no-audit --no-fund';
    const assembleMarker = 'run: node scripts/assemble-jobs-dataset.mjs --no-summaries';
    expect(auditWorkflow).toContain('./node_modules/.bin/tsx scripts/audit-missing-company-logos.mjs');
    expect(auditWorkflow).toContain('node scripts/download-missing-company-logos.mjs --from-audit');
    expect(auditWorkflow).toContain('node scripts/verify-company-logo-acquisition.mjs');
    expect(auditWorkflow).toContain('scripts/lib/open-data-refresh-pr.sh');
    expect(auditWorkflow).not.toContain('scripts/lib/git-push-with-retry.sh');
    expect(auditWorkflow).not.toMatch(/HEAD:main/);

    for (const workflow of [auditWorkflow, verifyWorkflow]) {
      expect(workflow).toContain('cache: npm');
      expect(workflow).toContain(installMarker);
      expect(workflow.indexOf(installMarker)).toBeLessThan(workflow.indexOf(assembleMarker));
      expect(workflow).toContain('node scripts/assemble-jobs-dataset.mjs --no-summaries');
      expect(workflow).toContain("COMPANY_LOGO_AUDIT_MIN_JOBS: '1000'");
      expect(workflow).toContain('COMPANY_LOGO_AUDIT_ASSET_BASE_URL: https://cdn.frontaliereticino.ch');
      expect(workflow).toMatch(/(?:npx tsx|\.\/node_modules\/\.bin\/tsx) scripts\//);
      expect(workflow).not.toContain('|| true; git add data/company-logos');
    }
  });

  it('groups a multi-employer source by the employer logo key, never by its shared crawler key', async () => {
    const jobs = [
      {
        id: 'seco-a', company: 'Adecco SA', companyKey: 'seco-jobroom', companyLogoKey: 'adecco-sa',
        url: 'https://www.job-room.ch/job-search/seco-a',
      },
      {
        id: 'seco-b', company: 'Altra SA', companyKey: 'seco-jobroom', companyLogoKey: 'altra-sa',
        url: 'https://www.job-room.ch/job-search/seco-b',
      },
    ];
    const report = await auditCompanyLogos(jobs, {
      resolveLogo: (job) => job.companyLogoKey === 'adecco-sa' ? '/images/brands/adecco.png' : null,
      assetBaseUrl: 'https://cdn.test',
      fetchImpl: async (url) => url === 'https://cdn.test/images/brands/adecco.png'
        ? imageResponse()
        : new Response('', { status: 404 }),
    });

    expect(report.affectedCompanies.map((company) => company.companyKey)).toEqual(['altra-sa']);
    expect(report.affectedCompanies.map((company) => company.companyKey)).not.toContain('seco-jobroom');
  });

  it('keeps verified ZAUGG legacy coverage separate from same-name non-official jobs', async () => {
    const officialLegacyJob = {
      company: 'ZAUGG AG',
      companyKey: 'zaugg-ag',
      companyDomain: 'zaugg.swiss',
      url: 'https://www.zaugg.swiss/stellen/3728',
    };
    const lookalikeJob = {
      company: 'Zaugg Bau AG',
      companyKey: 'zaugg-ag',
      companyDomain: 'zaugg-bau.example',
      url: 'https://zaugg-bau.example/jobs/1',
    };

    expect(companyLogoKeyForJob(officialLegacyJob)).toBe('zaugg');
    expect(resolveCompanyLogoUrl(officialLegacyJob)).toBe('/images/brands/zaugg.png');
    expect(companyLogoKeyForJob(lookalikeJob)).toBe('zaugg-ag');

    const report = await auditCompanyLogos([officialLegacyJob, lookalikeJob], {
      resolveLogo: (job) => companyLogoKeyForJob(job) === 'zaugg'
        ? '/images/brands/zaugg.png'
        : null,
      assetBaseUrl: 'https://cdn.test',
      fetchImpl: async (url) => url === 'https://cdn.test/images/brands/zaugg.png'
        ? imageResponse(200, pngBytes(128, 128))
        : new Response('', { status: 404 }),
    });

    expect(report.affectedCompanies.map((company) => company.companyKey)).toEqual(['zaugg-ag']);
    expect(report.affectedCompanies[0].affectedJobCount).toBe(1);
  });
});
