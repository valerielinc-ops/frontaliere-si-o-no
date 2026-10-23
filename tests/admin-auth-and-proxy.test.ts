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

function createConfigDb(initial: Record<string, unknown> | null = null) {
  let document = initial;
  const writes: Array<{ data: Record<string, unknown>; options: unknown }> = [];
  const audits: Record<string, unknown>[] = [];
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
        if (name === 'admin_audit_log') audits.push(data);
      },
    }),
  };
  return { db, writes, audits };
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
      return jsonResponse(200, { workflow_runs: [{ id: 42 }] });
    });
    const result = await handleAdminGithub(request('POST', {
      method: 'GET',
      path: '/actions/workflows/crawler-group-01.yml/runs?per_page=20',
    }), { fetchImpl });

    expect(result).toEqual({ status: 200, body: { ok: true, data: { workflow_runs: [{ id: 42 }] } } });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
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

  it('audits workflow dispatches with the upstream HTTP status and inputs', async () => {
    const { db, audits } = createConfigDb();
    const fetchImpl = vi.fn(async (_url: string, options: RequestInit) => {
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
      email: 'valerielinc@gmail.com',
      action: 'workflow_dispatch',
      target: 'orchestrate-crawlers.yml',
      inputs: { group: 'all', dry_run: 'false' },
      status: 200,
    });
    expect(mocks.serverTimestamp).toHaveBeenCalled();
  });

  it('follows job-log redirects without auth and keeps a UTF-8-safe tail capped at 256 KiB', async () => {
    const logText = `${'x'.repeat(300 * 1024)}\n🙂 ERROR: boom`;
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(jsonResponse(302, {}, { location: 'https://blob.example/log' }))
      .mockResolvedValueOnce({
        status: 200,
        ok: true,
        text: vi.fn(async () => logText),
      });
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
    expect(fetchImpl).toHaveBeenNthCalledWith(2, 'https://blob.example/log', { method: 'GET', redirect: 'follow' });
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
