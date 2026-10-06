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
import { downloadForKey } from '../scripts/download-missing-company-logos.mjs';

const ROOT = path.resolve(__dirname, '..');
const workflowPath = path.join(ROOT, '.github/workflows/audit-missing-company-logos.yml');
const ACQUIRED_ASSET_KEYS = [
  '1a-hunkeler', 'anicura', 'apply', 'artificialy', 'atec-personal', 'benu',
  'blatters-hotel', 'brefispersonal', 'bucherer', 'buersten-technik',
  'christinavassalli', 'clariant', 'elprom', 'endeso', 'fisba',
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

  it('selects only missing audit entries and preserves official-source candidates', () => {
    const entries = [
      { companyKey: 'yellowshark', status: 'missing', companyName: 'yellowshark AG' },
      { companyKey: 'broken', status: 'broken', companyName: 'Broken AG' },
      { companyKey: 'low-quality', status: 'low-quality', companyName: 'Low Quality AG' },
    ];

    expect(selectAuditCandidates(entries)).toEqual([entries[0]]);
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
