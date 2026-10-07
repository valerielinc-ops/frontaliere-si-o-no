import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import YAML from 'yaml';
import {
  DOMAIN_OVERRIDES,
  auditIssueReason,
  buildResidualReport,
  domainCandidates,
  selectAuditCandidates,
} from '../scripts/lib/company-logo-acquisition.mjs';
import {
  downloadForKey,
  extractOfficialLogoImages,
  shouldAcquireTarget,
} from '../scripts/download-missing-company-logos.mjs';

const ROOT = path.resolve(__dirname, '..');
const workflowPath = path.join(ROOT, '.github/workflows/audit-missing-company-logos.yml');

function pngBytes(width = 128, height = 128) {
  const bytes = Buffer.alloc(24);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  bytes.writeUInt32BE(width, 16);
  bytes.writeUInt32BE(height, 20);
  return bytes;
}

const ACQUIRED_ASSET_KEYS = [
  '1a-hunkeler', 'anicura', 'answerconsulting', 'apply', 'artificialy', 'atec-personal', 'benu',
  'blatters-hotel', 'brefispersonal', 'bucherer', 'buersten-technik',
  'christinavassalli', 'clariant', 'comadur-swatch-group', 'elprom', 'endeso', 'fisba',
  'gim-architekten', 'grischapersonal',
  'integra-biosciences', 'kone', 'mcm-group', 'mueller-steinmaur',
  'neoproconseils', 'nord-anglia', 'pantr-ch', 'parmag', 'protectas-sa',
  'schweizerhof-flims', 'yellowshark',
];

describe('missing company-logo acquisition', () => {
  it('does not probe a guessed domain for a future audit key', async () => {
    const auditInput = { companyKey: 'acme', status: 'missing' };
    const [candidate] = selectAuditCandidates([auditInput]);
    const originalFetch = globalThis.fetch;
    let probes = 0;
    globalThis.fetch = async () => {
      probes += 1;
      throw new Error('unexpected network probe');
    };

    try {
      expect(domainCandidates(candidate.companyKey, {
        companyDomains: new Set(['acme.example']),
        urlHosts: new Set(['acme.jobs.example']),
      }, { fromAudit: true })).toEqual([]);
      const result = await downloadForKey(candidate.companyKey, {}, { fromAudit: true });
      expect(result.accepted).toBe(false);
      expect(result.reason).toBe('no-official-domain');
      expect(probes).toBe(0);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('uses exactly the declared override in audit mode and keeps legacy guesses separate', () => {
    expect(domainCandidates('yellowshark', {
      companyDomains: new Set(['yellowshark.ch']),
      urlHosts: new Set(['yellowshark.example']),
    }, { fromAudit: true })).toEqual(['yellowshark.com']);
    expect(domainCandidates('acme')).toEqual(['acme.ch', 'acme.com']);
  });

  it('selects missing and quality-deficient audit entries, preserving official-source candidates', () => {
    const entries = [
      { companyKey: 'yellowshark', status: 'missing', companyName: 'yellowshark AG' },
      { companyKey: 'broken', status: 'broken', companyName: 'Broken AG' },
      { companyKey: 'low-quality', status: 'low-quality', companyName: 'Low Quality AG' },
    ];

    expect(selectAuditCandidates(entries)).toEqual([entries[0], entries[2]]);
  });

  it('extracts structured employer logo declarations from official pages', () => {
    const links = extractOfficialLogoImages(`
      <meta property="og:logo" content="https://media.example.test/answer.svg">
      <script type="application/ld+json">
        {"@type":"Organization","logo":"https://media.example.test/answer-large.png"}
      </script>
    `, 'https://answerconsulting.ch/', 'answerconsulting.ch');

    expect(links).toContain('https://media.example.test/answer.svg');
    expect(links).toContain('https://media.example.test/answer-large.png');
  });

  it('uses an official career-page logo before a group homepage fallback', async () => {
    const sourceUrl = 'https://www.swatchgroup.com/fr/job/33350';
    const logoUrl = 'https://www.swatchgroup.com/sites/default/files/brands-logos/comadur.png';
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (url) => {
      if (url === sourceUrl) {
        return new Response(`<script type="application/ld+json">{"logo":"${logoUrl}"}</script>`, {
          headers: { 'content-type': 'text/html' },
        });
      }
      if (url === logoUrl) return new Response(pngBytes(513, 117), {
        headers: { 'content-type': 'image/png' },
      });
      throw new Error(`unexpected fetch ${url}`);
    };

    try {
      const result = await downloadForKey('comadur-swatch-group', {
        sourceUrls: new Set([sourceUrl]),
      }, { fromAudit: true });
      expect(result).toEqual(expect.objectContaining({
        accepted: true,
        source: 'official-career-page-icon',
        sourceDomain: 'swatchgroup.com',
        width: 513,
        height: 117,
      }));
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('refreshes an existing manifest entry when the audit still marks it low-quality', () => {
    expect(shouldAcquireTarget({
      manifestAliases: ['mediamarkt'],
      qualityDeficient: true,
    }, { mediamarkt: '/images/brands/mediamarkt.png' })).toBe(true);
    expect(shouldAcquireTarget({
      manifestAliases: ['valid'],
      qualityDeficient: false,
    }, { valid: '/images/brands/valid.png' })).toBe(false);
  });

  it('does not accept a generic favicon in strict audit mode', async () => {
    const sourceUrl = 'https://www.swatchgroup.com/fr/job/33350';
    const genericFavicon = 'https://www.swatchgroup.com/favicon.png';
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (url) => {
      if (url === sourceUrl || url === 'https://swatchgroup.com/' || url === 'https://www.swatchgroup.com/') {
        return new Response(`<link rel="icon" href="${genericFavicon}">`, {
          headers: { 'content-type': 'text/html' },
        });
      }
      if (url === genericFavicon) return new Response(pngBytes(128, 128), {
        headers: { 'content-type': 'image/png' },
      });
      throw new Error(`unexpected fetch ${url}`);
    };

    try {
      const result = await downloadForKey('comadur-swatch-group', {
        sourceUrls: new Set([sourceUrl]),
      }, { fromAudit: true });
      expect(result.accepted).toBe(false);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('leaves an explicit reason for every unresolved company', () => {
    const entries = [
      {
        companyKey: 'yellowshark',
        companyName: 'yellowshark AG',
        status: 'missing',
        missingJobCount: 887,
        affectedJobCount: 887,
      },
      {
        companyKey: 'pantr-ch',
        companyName: 'Pantr GmbH',
        status: 'missing',
        missingJobCount: 8,
        affectedJobCount: 8,
      },
      {
        companyKey: 'broken',
        companyName: 'Broken AG',
        status: 'broken',
        brokenJobCount: 1,
        affectedJobCount: 1,
      },
    ];
    const residual = buildResidualReport(
      { affectedCompanies: entries },
      {
        acquired: 1,
        failed: 1,
        targets: [
          { companyKey: 'yellowshark', status: 'verified' },
          { companyKey: 'pantr-ch', status: 'failed', reason: 'sorgente ufficiale irraggiungibile' },
        ],
      },
    );

    expect(residual.affectedCompanies.map((company) => [company.companyKey, company.reason])).toEqual([
      ['pantr-ch', 'sorgente ufficiale irraggiungibile'],
      ['broken', 'sorgente ufficiale irraggiungibile o riferimento rotto'],
    ]);
    expect(auditIssueReason({ status: 'low-quality' })).toBe('qualità insufficiente');
  });

  it('reports the declared-domain residual reason', () => {
    const residual = buildResidualReport(
      {
        affectedCompanies: [
          { companyKey: 'acme', status: 'missing', missingJobCount: 1, affectedJobCount: 1 },
        ],
      },
      {
        targets: [{ companyKey: 'acme', status: 'failed', reason: 'no-official-domain' }],
      },
    );

    expect(residual.affectedCompanies[0]?.reason).toBe('nessun dominio ufficiale dichiarato');
  });

  it('keeps checkout assets visible as pending-deploy in the residual report', () => {
    const residual = buildResidualReport(
      {
        affectedCompanies: [
          {
            companyKey: 'pending',
            status: 'pending-deploy',
            pendingDeployJobCount: 2,
            affectedJobCount: 2,
          },
        ],
      },
      { targets: [], acquired: 0, failed: 0, qualityRejected: 0 },
    );

    expect(residual.pendingDeploy).toBeGreaterThan(0);
    expect(residual.pendingDeployJobCount).toBeGreaterThan(0);
    expect(residual.affectedCompanies[0]?.reason).toBe('asset presente nel checkout, in attesa del deploy CDN');
  });

  it('keeps every acquired PR asset covered by an explicit override', () => {
    const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'data/company-logos-manifest.json'), 'utf8')) as Record<string, string>;

    for (const key of ACQUIRED_ASSET_KEYS) {
      const publicPath = manifest[key];
      expect(publicPath).toMatch(/^\/images\/brands\//);
      expect(fs.existsSync(path.join(ROOT, 'public', publicPath.replace(/^\/+/, '')))).toBe(true);
      expect(domainCandidates(key, {
        companyDomains: new Set([`${key}.ch`]),
        urlHosts: new Set([`${key}.com`]),
      }, { fromAudit: true })).toEqual(DOMAIN_OVERRIDES[key]);
    }
  });

  it('requires acquisition and quality verification before the stable PR publisher', () => {
    const source = fs.readFileSync(workflowPath, 'utf8');
    const workflow = YAML.parse(source) as {
      jobs?: { audit?: { steps?: Array<{ name?: string; run?: string; if?: string }> } };
    };
    const steps = workflow.jobs?.audit?.steps ?? [];
    const indexOf = (name: string) => steps.findIndex((step) => step.name === name);
    const auditIndex = indexOf('Audit missing company logos');
    const acquisitionIndex = indexOf('Acquire missing company logos');
    const qualityIndex = indexOf('Verify acquired company logos');
    const residualIndex = indexOf('Report missing-logo residual');
    const prIndex = indexOf('Publish verified company logos through stable PR');

    expect(auditIndex).toBeGreaterThanOrEqual(0);
    expect(acquisitionIndex).toBeGreaterThan(auditIndex);
    expect(qualityIndex).toBeGreaterThan(acquisitionIndex);
    expect(residualIndex).toBeGreaterThan(qualityIndex);
    expect(prIndex).toBeGreaterThan(qualityIndex);
    expect(steps[acquisitionIndex]?.run).toContain('download-missing-company-logos.mjs --from-audit');
    expect(steps[qualityIndex]?.run).toContain('verify-company-logo-acquisition.mjs');
    expect(steps[prIndex]?.if).toContain("steps.verify.outputs.eligible == 'true'");
    expect(source).not.toMatch(/download-missing-company-logos\.mjs(?!\s+--from-audit)/);
    expect(source).toContain('scripts/lib/open-data-refresh-pr.sh');
    expect(source).toContain('--branch "$DATA_REFRESH_BRANCH"');
    expect(source).toContain('pull-requests: write');
    expect(source).not.toContain('git-push-with-retry.sh');
    expect(source).not.toMatch(/HEAD:main/);
  });
});
