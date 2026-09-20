import { existsSync, readFileSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  auditCompanyLogos,
  classifyLogoReference,
  loadCanonicalJobs,
} from '../scripts/lib/company-logo-audit.mjs';

const PNG_BYTES = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function imageResponse(status = 200) {
  return new Response(PNG_BYTES, {
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
    expect(auditWorkflow).toContain('cache: npm');
    expect(auditWorkflow).toContain(installMarker);
    expect(auditWorkflow.indexOf(installMarker)).toBeLessThan(auditWorkflow.indexOf(assembleMarker));
    expect(auditWorkflow).toContain('./node_modules/.bin/tsx scripts/audit-missing-company-logos.mjs');
    expect(auditWorkflow).toContain('--regenerate-cmd "./node_modules/.bin/tsx scripts/audit-missing-company-logos.mjs; git add data/company-logos-missing.json"');

    for (const workflow of [auditWorkflow, verifyWorkflow]) {
      expect(workflow).toContain('node scripts/assemble-jobs-dataset.mjs --no-summaries');
      expect(workflow).toContain("COMPANY_LOGO_AUDIT_MIN_JOBS: '1000'");
      expect(workflow).toContain('COMPANY_LOGO_AUDIT_ASSET_BASE_URL: https://cdn.frontaliereticino.ch');
      expect(workflow).toMatch(/(?:npx tsx|\.\/node_modules\/\.bin\/tsx) scripts\//);
      expect(workflow).not.toContain('|| true; git add data/company-logos');
    }
  });
});
