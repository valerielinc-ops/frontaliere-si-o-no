import { describe, expect, it, beforeEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const mocks = vi.hoisted(() => ({
  verifyIdToken: vi.fn(),
  serverTimestamp: vi.fn(() => ({ __serverTimestamp: true })),
}));

vi.mock('firebase-admin/auth', () => ({
  getAuth: () => ({ verifyIdToken: mocks.verifyIdToken }),
}));

vi.mock('firebase-admin/firestore', () => ({
  FieldValue: { serverTimestamp: mocks.serverTimestamp },
}));

vi.mock('../functions/src/newsletterResendWebhookCore.js', () => ({
  getAdminDb: vi.fn(),
}));

vi.mock('../functions/src/remoteConfigSecrets.js', () => ({
  getRemoteConfigValue: vi.fn(async (key: string) => ({
    GITHUB_PAT: 'github-pat-test',
    GITHUB_REPO_OWNER: 'valerielinc-ops',
    GITHUB_REPO_NAME: 'frontaliere-si-o-no',
  }[key] || '')),
}));

vi.mock('../functions/src/recaptchaVerification.js', () => ({
  createAssessment: vi.fn(),
}));

import { assertSiteAdmin } from '../functions/src/adminAuth.js';
import { handleAdminGithub } from '../functions/src/githubProxy.js';
import { handleAdminJobsCrawlerConfig } from '../functions/src/adminJobsCrawlerConfig.js';
import { JOBS_CRAWLER_CONFIG_DEFAULTS } from '../functions/src/jobsCrawlerConfig.js';
import {
  expectedWorkflowTimeoutMs,
  isExpectedWorkflowDuration,
} from '../services/adminWorkflowTimeout';

function request(method: string, body: unknown, token = 'id-token') {
  return {
    method,
    body,
    headers: { authorization: `Bearer ${token}` },
  } as any;
}

function jsonResponse(status: number, body: unknown, headers: HeadersInit = {}) {
  return {
    status,
    ok: status >= 200 && status < 300,
    headers: new Headers(headers),
    text: vi.fn(async () => JSON.stringify(body)),
  } as any;
}

function streamResponse(status: number, body: string, headers: HeadersInit = {}) {
  const bytes = Buffer.from(body, 'utf8');
  let offset = 0;
  const read = vi.fn(async () => {
    if (offset >= bytes.length) return { done: true, value: undefined };
    const nextOffset = Math.min(bytes.length, offset + 64 * 1024);
    const value = Uint8Array.from(bytes.subarray(offset, nextOffset));
    offset = nextOffset;
    return { done: false, value };
  });
  const text = vi.fn(async () => {
    throw new Error('stream response must not be materialized with text()');
  });
  return {
    status,
    ok: status >= 200 && status < 300,
    headers: new Headers(headers),
    body: { getReader: () => ({ read, releaseLock: vi.fn() }) },
    text,
  } as any;
}

function createConfigDb(
  initial: Record<string, unknown> | null = null,
  options: { rejectAudit?: boolean; rejectAuditUpdate?: boolean } = {},
) {
  let document = initial;
  const writes: Array<{ data: Record<string, unknown>; options: unknown }> = [];
  const audits: Record<string, unknown>[] = [];
  const auditOperations: Array<{ kind: 'add' | 'update'; data: Record<string, unknown> }> = [];
  const db = {
    collection: (name: string) => ({
      doc: () => ({
        get: async () => ({ exists: document !== null, data: () => document || {} }),
        set: async (data: Record<string, unknown>, options: unknown) => {
          document = { ...(document || {}), ...data };
          writes.push({ data, options });
        },
      }),
      add: async (data: Record<string, unknown>) => {
        if (name !== 'admin_audit_log') return undefined;
        if (options.rejectAudit) throw new Error('audit add rejected');
        audits.push(data);
        auditOperations.push({ kind: 'add', data: { ...data } });
        return {
          update: async (patch: Record<string, unknown>) => {
            if (options.rejectAuditUpdate) throw new Error('audit update rejected');
            Object.assign(data, patch);
            auditOperations.push({ kind: 'update', data: { ...patch } });
          },
        };
      },
    }),
  };
  return { db, writes, audits, auditOperations };
}

describe('site-admin identity and GitHub proxy', () => {
  beforeEach(() => {
    mocks.verifyIdToken.mockReset();
    mocks.serverTimestamp.mockClear();
    mocks.verifyIdToken.mockResolvedValue({
      uid: 'aAqGpXr2mUQNQlio3gCxut4bBzH3',
      email: 'ValerieLinc@gmail.com',
      email_verified: true,
    });
  });

  it('requires the shared verified UID and email allowlist', async () => {
    await expect(assertSiteAdmin(request('POST', {}))).resolves.toEqual({
      ok: true,
      uid: 'aAqGpXr2mUQNQlio3gCxut4bBzH3',
      email: 'valerielinc@gmail.com',
    });

    mocks.verifyIdToken.mockResolvedValueOnce({
      uid: 'wrong-uid',
      email: 'valerielinc@gmail.com',
      email_verified: true,
    });
    await expect(assertSiteAdmin(request('POST', {}))).resolves.toMatchObject({ status: 403, error: 'not_admin' });
  });

  it('forwards an allowlisted read without exposing the PAT to the request body', async () => {
    const fetchImpl = vi.fn(async (_url: string, options: RequestInit) => {
      expect(options.headers).toMatchObject({ Authorization: 'Bearer github-pat-test' });
      expect(options.headers).toMatchObject({ 'X-GitHub-Api-Version': '2022-11-28' });
      expect(options.body).toBeUndefined();
      expect(options.signal).toBeInstanceOf(AbortSignal);
      return jsonResponse(200, { workflow_runs: [{ id: 42 }] });
    });
    const result = await handleAdminGithub(request('POST', {
      method: 'GET',
      path: '/actions/workflows/crawler-group-01.yml/runs?per_page=20',
    }), { fetchImpl });

    expect(result).toEqual({ status: 200, body: { ok: true, data: { workflow_runs: [{ id: 42 }] } } });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('allows aggregate runs, deploy-run filters and the explicit account rate-limit endpoint', async () => {
    const urls: string[] = [];
    const fetchImpl = vi.fn(async (url: string) => {
      urls.push(url);
      return jsonResponse(200, { workflow_runs: [] });
    });
    const aggregate = await handleAdminGithub(request('POST', {
      method: 'GET',
      path: '/actions/runs?created=%3E%3D2026-10-23T00%3A00%3A00.000Z&per_page=100&page=2&status=completed&branch=main',
    }), { fetchImpl });
    const rateLimit = await handleAdminGithub(request('POST', {
      method: 'GET',
      path: '/rate_limit',
    }), { fetchImpl });

    expect(aggregate.status).toBe(200);
    expect(rateLimit.status).toBe(200);
    expect(urls[0]).toBe('https://api.github.com/repos/valerielinc-ops/frontaliere-si-o-no/actions/runs?created=%3E%3D2026-10-23T00%3A00%3A00.000Z&per_page=100&page=2&status=completed&branch=main');
    expect(urls[1]).toBe('https://api.github.com/rate_limit');
  });

  it('rejects unapproved runs queries and rate-limit query parameters', async () => {
    const fetchImpl = vi.fn();
    for (const path of ['/actions/runs?foo=bar', '/actions/runs?per_page=101', '/actions/runs?page=0', '/actions/runs?page=11', '/actions/runs?page=1.5', '/actions/runs?page=01', '/actions/runs?page=1&page=2', '/rate_limit?per_page=1']) {
      const result = await handleAdminGithub(request('POST', { method: 'GET', path }), { fetchImpl });
      expect(result).toEqual({ status: 400, body: { ok: false, error: 'path_not_allowed' } });
    }
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('rejects paths outside the explicit GitHub allowlist', async () => {
    const fetchImpl = vi.fn();
    const result = await handleAdminGithub(request('POST', {
      method: 'GET',
      path: '/repos/valerielinc-ops/frontaliere-si-o-no/issues',
    }), { fetchImpl });

    expect(result).toEqual({ status: 400, body: { ok: false, error: 'path_not_allowed' } });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('returns a non-admin response before contacting GitHub', async () => {
    mocks.verifyIdToken.mockRejectedValueOnce(new Error('expired'));
    const fetchImpl = vi.fn();
    const result = await handleAdminGithub(request('POST', {
      method: 'GET',
      path: '/actions/runs/42',
    }), { fetchImpl });

    expect(result).toEqual({ status: 401, body: { ok: false, error: 'invalid_id_token' } });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('writes a pending audit intent before dispatch and updates it with the upstream status', async () => {
    const { db, audits, auditOperations } = createConfigDb();
    const fetchImpl = vi.fn(async (_url: string, options: RequestInit) => {
      expect(auditOperations).toHaveLength(1);
      expect(auditOperations[0].data.status).toBe('pending');
      expect(options.headers).toMatchObject({ 'X-GitHub-Api-Version': '2026-03-10' });
      return jsonResponse(200, {
      workflow_run_id: 9001,
      run_url: 'https://api.github.com/repos/valerielinc-ops/frontaliere-si-o-no/actions/runs/9001',
      html_url: 'https://github.com/valerielinc-ops/frontaliere-si-o-no/actions/runs/9001',
      });
    });
    const result = await handleAdminGithub(request('POST', {
      method: 'POST',
      path: '/actions/workflows/orchestrate-crawlers.yml/dispatches',
      body: { ref: 'main', inputs: { group: 'all', dry_run: 'false' } },
    }), { fetchImpl, db });

    expect(result.status).toBe(200);
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({
      uid: 'aAqGpXr2mUQNQlio3gCxut4bBzH3',
      action: 'workflow_dispatch',
      target: 'orchestrate-crawlers.yml',
      inputs: { group: 'all', dry_run: 'false' },
      status: 200,
    });
    expect(auditOperations.map(({ kind }) => kind)).toEqual(['add', 'update']);
    expect(auditOperations[0].data.status).toBe('pending');
    expect(auditOperations[1].data).toEqual({ status: 200 });
    expect(mocks.serverTimestamp).toHaveBeenCalled();
  });

  it('keeps the GitHub request best-effort when the audit intent cannot be written', async () => {
    const { db } = createConfigDb(null, { rejectAudit: true });
    const fetchImpl = vi.fn(async () => jsonResponse(502, { message: 'upstream unavailable' }));
    const result = await handleAdminGithub(request('POST', {
      method: 'POST',
      path: '/actions/workflows/orchestrate-crawlers.yml/dispatches',
      body: { ref: 'main', inputs: { group: 'all' } },
    }), { fetchImpl, db });

    expect(result).toEqual({ status: 502, body: { ok: false, error: 'upstream unavailable', message: 'upstream unavailable' } });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('keeps the GitHub response when the final audit update fails', async () => {
    const { db, audits, auditOperations } = createConfigDb(null, { rejectAuditUpdate: true });
    const fetchImpl = vi.fn(async () => jsonResponse(204, {}));
    const result = await handleAdminGithub(request('POST', {
      method: 'POST',
      path: '/actions/workflows/orchestrate-crawlers.yml/dispatches',
      body: { ref: 'main', inputs: { group: 'all' } },
    }), { fetchImpl, db });

    expect(result.status).toBe(204);
    expect(audits).toHaveLength(1);
    expect(audits[0].status).toBe('pending');
    expect(auditOperations.map(({ kind }) => kind)).toEqual(['add']);
  });

  it('keeps the pending-to-final audit order for a successful 204 dispatch', async () => {
    const { db, audits, auditOperations } = createConfigDb();
    const fetchImpl = vi.fn(async () => jsonResponse(204, {}));
    const result = await handleAdminGithub(request('POST', {
      method: 'POST',
      path: '/actions/workflows/orchestrate-crawlers.yml/dispatches',
      body: { ref: 'main', inputs: { group: 'all' } },
    }), { fetchImpl, db });

    expect(result.status).toBe(204);
    expect(audits[0].status).toBe(204);
    expect(auditOperations.map(({ kind }) => kind)).toEqual(['add', 'update']);
    expect(auditOperations[0].data.status).toBe('pending');
    expect(auditOperations[1].data).toEqual({ status: 204 });
  });

  it('records the not-configured dispatch outcome without contacting GitHub', async () => {
    const { db, audits, auditOperations } = createConfigDb();
    const fetchImpl = vi.fn();
    const result = await handleAdminGithub(request('POST', {
      method: 'POST',
      path: '/actions/workflows/orchestrate-crawlers.yml/dispatches',
      body: { ref: 'main', inputs: { group: 'all' } },
    }), { fetchImpl, db, repoConfig: { pat: '', owner: 'owner', repo: 'repo' } });

    expect(result).toEqual({ status: 503, body: { ok: false, error: 'github_not_configured' } });
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(audits[0]).toMatchObject({ status: 503, target: 'orchestrate-crawlers.yml' });
    expect(auditOperations.map(({ kind }) => kind)).toEqual(['add', 'update']);
  });

  it('follows job-log redirects without auth and keeps a UTF-8-safe tail capped at 256 KiB', async () => {
    const logText = `${'x'.repeat(300 * 1024)}\n🙂 ERROR: boom`;
    const logResponse = streamResponse(200, logText);
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(jsonResponse(302, {}, { location: 'https://blob.example/log' }))
      .mockResolvedValueOnce(logResponse);
    const result = await handleAdminGithub(request('POST', {
      method: 'GET',
      path: '/actions/jobs/77/logs',
    }), { fetchImpl });

    expect(result.status).toBe(200);
    const text = (result.body as any).text;
    expect(Buffer.byteLength(text, 'utf8')).toBeLessThanOrEqual(256 * 1024);
    expect(text.startsWith('[log troncato: mostrati gli ultimi 256 KB]\n')).toBe(true);
    expect(text.endsWith('🙂 ERROR: boom')).toBe(true);
    expect(text).not.toContain('\uFFFD');
    expect(logResponse.text).not.toHaveBeenCalled();
    expect(fetchImpl).toHaveBeenNthCalledWith(
      2,
      'https://blob.example/log',
      expect.objectContaining({ method: 'GET', redirect: 'follow', signal: expect.any(AbortSignal) }),
    );
    expect(fetchImpl.mock.calls[0][1].signal).toBeInstanceOf(AbortSignal);
  });

  it('keeps every legacy crawler seed and restores the Swatch country filter', () => {
    const legacySeeds = {
      'vfc.com': [
        'https://vfc.wd5.myworkdayjobs.com/vfc_careers?Location_Country=187134fccb084a0ea9b4b95f23890dbe',
      ],
      'swatchgroup.com': ['https://www.swatchgroup.com/en/job-finder?jf_country=40'],
      'ubs.com': [
        'https://www.ubs.com/global/en/careers/search-jobs.html',
        'https://www.ubs.com/global/en/careers.html',
      ],
      'schindler.com': [
        'https://job.schindler.com',
        'https://www.schindler.com/com/internet/en/careers.html',
      ],
      'avaloq.com': ['https://www.avaloq.com/careers'],
      'nozominetworks.com': ['https://www.nozominetworks.com/company/careers/'],
      'medacta.com': ['https://www.medacta.com/EN/careers'],
      'cler.ch': [
        'https://www.cler.ch/it/banca-cler/jobs-und-karriere/cercare-candidatura/offene-stellen',
      ],
    };

    for (const [host, seeds] of Object.entries(legacySeeds)) {
      expect(JOBS_CRAWLER_CONFIG_DEFAULTS.sourceSeeds.byDomain[host]).toEqual(seeds);
    }
  });

  it('uses an explicit 30-minute fallback for malformed workflow durations', () => {
    const root = resolve(__dirname, '..');
    const declaredDurations = [
      readFileSync(resolve(root, 'components/pages/AdminPanel.tsx'), 'utf8'),
      readFileSync(resolve(root, 'build-plugins/crawlerRegistryPlugin.ts'), 'utf8'),
    ].flatMap((source) => [...source.matchAll(/expectedDuration:\s*'([^']+)'/g)].map((match) => match[1]));
    expect(declaredDurations.length).toBeGreaterThan(0);
    expect(declaredDurations.every(isExpectedWorkflowDuration)).toBe(true);
    expect(isExpectedWorkflowDuration('variabile')).toBe(false);
    expect(expectedWorkflowTimeoutMs('variabile')).toBe(45 * 60_000);
    expect(expectedWorkflowTimeoutMs('60-90 min')).toBe(120 * 60_000);
  });
});

describe('admin crawler configuration function', () => {
  beforeEach(() => {
    mocks.serverTimestamp.mockClear();
  });

  it('returns a default source when the Firestore document does not exist', async () => {
    const { db } = createConfigDb();
    const result = await handleAdminJobsCrawlerConfig(request('GET', {}), { db });
    expect(result).toMatchObject({ status: 200, body: { ok: true, source: 'default', updatedAt: null, updatedBy: null } });
  });

  it('clamps, normalizes, writes server metadata and audits changed fields', async () => {
    const { db, writes, audits } = createConfigDb();
    const result = await handleAdminJobsCrawlerConfig(request('POST', {
      domainWhitelist: ['https://WWW.Example.CH/jobs', 'example.ch'],
      domainBlacklist: [],
      minQualityScore: 99,
      minDescriptionChars: 9999,
      aiLocalizationEnabled: true,
      aiLocalizationMaxJobsPerRun: 9999,
      contentReuse: {
        enabled: false,
        similarityThreshold: 9,
        minSourceChars: 99999,
        maxLengthDeltaRatio: -1,
      },
      companyPriority: { byDomain: { 'example.ch': 2 }, byName: {} },
      sourceSeeds: { byDomain: { 'example.ch': ['https://example.ch/careers'] }, byName: {} },
    }), { db });

    expect(result.status).toBe(200);
    expect((result.body as any).config).toMatchObject({
      domainWhitelist: ['example.ch'],
      minQualityScore: 10,
      minDescriptionChars: 1200,
      aiLocalizationMaxJobsPerRun: 500,
      contentReuse: { similarityThreshold: 1, minSourceChars: 8000, maxLengthDeltaRatio: 0.02 },
    });
    expect(writes[0].data.updatedBy).toBe('valerielinc@gmail.com');
    expect(audits[0]).toMatchObject({ action: 'crawler_config_update', target: 'admin_config/jobsCrawler' });
    expect((audits[0].changedFields as string[]).length).toBeGreaterThan(0);
  });
});

describe('admin identity consistency', () => {
  it('keeps the stable site-admin UID aligned across runtime, rules and functions', () => {
    const root = resolve(__dirname, '..');
    const uid = 'aAqGpXr2mUQNQlio3gCxut4bBzH3';
    expect(readFileSync(resolve(root, 'services/adminIdentity.ts'), 'utf8')).toContain(uid);
    expect(readFileSync(resolve(root, 'firestore.rules'), 'utf8')).toContain(uid);
    expect(readFileSync(resolve(root, 'functions/src/adminAuth.js'), 'utf8')).toContain(uid);
  });
});
