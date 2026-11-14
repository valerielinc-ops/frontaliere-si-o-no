import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import YAML from 'yaml';
import {
  PRODUCTION_WRITERS,
  readActiveProductionWriters,
  selectActiveProductionWriters,
} from '../scripts/ci/production-canary-admission.mjs';

const ROOT = resolve(import.meta.dirname, '..');

const run = (over: Record<string, unknown> = {}) => ({
  id: 123,
  status: 'in_progress',
  path: '.github/workflows/deploy.yml',
  name: 'Deploy to GitHub Pages',
  html_url: 'https://github.com/example/repo/actions/runs/123',
  ...over,
});

describe('production-canary-admission', () => {
  it('selects active live-site writers and ignores unrelated or completed runs', () => {
    const selected = selectActiveProductionWriters([
      run(),
      run({ id: 124, status: 'queued', path: '.github/workflows/deploy-publish.yml', name: 'Publish to GitHub Pages (deploy + validate)' }),
      run({ id: 125, status: 'completed' }),
      run({ id: 126, path: '.github/workflows/unrelated.yml', name: 'Unrelated workflow' }),
    ]);
    expect(selected.map((candidate) => candidate.id)).toEqual([123, 124]);
  });

  it('fails closed when the active run identity is unreadable', () => {
    expect(() => selectActiveProductionWriters([run({ path: '', name: '' })])).toThrow(/no workflow path or name/);
    expect(() => selectActiveProductionWriters([run({ id: '', path: '.github/workflows/deploy.yml' })])).toThrow(/missing its id/);
  });

  it('reads each writer collection and deduplicates a run observed during a status transition', async () => {
    const requests: string[] = [];
    const fetchImpl = async (url: string) => {
      requests.push(url);
      const parsed = new URL(url);
      if (parsed.searchParams.has('status')) return new Response('status filter is forbidden', { status: 403 });
      const workflow = parsed.pathname.split('/').at(-2);
      const body = workflow === 'deploy.yml'
        ? { total_count: 2, workflow_runs: [run({ id: 321, status: 'in_progress' }), run({ id: 321, status: 'queued' })] }
        : { total_count: 0, workflow_runs: [] };
      return new Response(JSON.stringify(body), { status: 200 });
    };

    const selected = await readActiveProductionWriters({
      repository: 'example/repo',
      token: 'test-token',
      fetchImpl,
    });

    expect(requests).toHaveLength(PRODUCTION_WRITERS.length);
    expect(new Set(requests.map((url) => new URL(url).pathname))).toEqual(
      new Set(PRODUCTION_WRITERS.map(({ path }) => `/repos/example/repo/actions/workflows/${path.split('/').at(-1)}/runs`)),
    );
    expect(requests.every((url) => {
      const parsed = new URL(url);
      return parsed.searchParams.get('per_page') === '100'
        && parsed.searchParams.get('page') === '1'
        && !parsed.searchParams.has('status');
    })).toBe(true);
    expect(selected.map((candidate) => candidate.id)).toEqual([321]);
  });

  it('queries each writer workflow directly and keeps waiting runs visible without a status filter', async () => {
    const requests: string[] = [];
    const fetchImpl = async (url: string) => {
      requests.push(url);
      const parsed = new URL(url);
      if (parsed.searchParams.has('status')) return new Response('status filter is forbidden', { status: 403 });
      const workflow = parsed.pathname.split('/').at(-2);
      if (workflow === 'deploy-publish.yml') {
        return new Response(JSON.stringify({
          total_count: 1,
          workflow_runs: [run({
            id: 321,
            status: 'waiting',
            path: '.github/workflows/deploy-publish.yml',
            name: 'Publish to GitHub Pages (deploy + validate)',
          })],
        }), { status: 200 });
      }
      return new Response(JSON.stringify({ total_count: 0, workflow_runs: [] }), { status: 200 });
    };

    const selected = await readActiveProductionWriters({
      repository: 'example/repo',
      token: 'test-token',
      fetchImpl,
    });

    expect(requests).toHaveLength(PRODUCTION_WRITERS.length);
    expect(requests.every((url) => new URL(url).pathname.includes('/actions/workflows/'))).toBe(true);
    expect(requests.every((url) => !new URL(url).searchParams.has('status'))).toBe(true);
    expect(requests.some((url) => new URL(url).pathname.endsWith('/actions/runs'))).toBe(false);
    expect(selected.map((candidate) => candidate.id)).toEqual([321]);
  });

  it('accepts a terminal page when total_count is stale during a run transition', async () => {
    let pageRequests = 0;
    const fetchImpl = async (url: string) => {
      pageRequests += 1;
      if (new URL(url).pathname.endsWith('/deploy.yml/runs') && pageRequests === 1) {
        return new Response(JSON.stringify({ total_count: 1, workflow_runs: [] }), { status: 200 });
      }
      return new Response(JSON.stringify({ total_count: 0, workflow_runs: [] }), { status: 200 });
    };

    await expect(readActiveProductionWriters({
      repository: 'example/repo',
      token: 'test-token',
      fetchImpl,
    })).resolves.toEqual([]);
    expect(pageRequests).toBe(PRODUCTION_WRITERS.length);
  });

  it('retries a short page that advertises another page before accepting it', async () => {
    let deployPageRequests = 0;
    const fetchImpl = async (url: string) => {
      const parsed = new URL(url);
      const workflow = parsed.pathname.split('/').at(-2);
      if (workflow === 'deploy.yml' && parsed.searchParams.get('page') === '1') {
        deployPageRequests += 1;
        if (deployPageRequests === 1) {
          return new Response(JSON.stringify({ total_count: 1, workflow_runs: [] }), {
            status: 200,
            headers: {
              Link: '<https://api.github.com/repos/example/repo/actions/workflows/deploy.yml/runs?per_page=100&page=2>; rel="next"',
            },
          });
        }
      }
      return new Response(JSON.stringify({ total_count: 0, workflow_runs: [] }), { status: 200 });
    };

    await expect(readActiveProductionWriters({
      repository: 'example/repo',
      token: 'test-token',
      fetchImpl,
    })).resolves.toEqual([]);
    expect(deployPageRequests).toBe(2);
  });

  it('follows a non-empty writer page before deciding that no active run exists', async () => {
    const requests: string[] = [];
    const fetchImpl = async (url: string) => {
      requests.push(url);
      const parsed = new URL(url);
      const workflow = parsed.pathname.split('/').at(-2);
      if (workflow === 'deploy.yml' && parsed.searchParams.get('page') === '1') {
        return new Response(JSON.stringify({
          total_count: 2,
          workflow_runs: [run({ id: 320, status: 'completed' })],
        }), {
          status: 200,
          headers: {
            Link: '<https://api.github.com/repos/example/repo/actions/workflows/deploy.yml/runs?per_page=100&page=2>; rel="next"',
          },
        });
      }
      if (workflow === 'deploy.yml' && parsed.searchParams.get('page') === '2') {
        return new Response(JSON.stringify({
          total_count: 2,
          workflow_runs: [run({ id: 321, status: 'waiting' })],
        }), { status: 200 });
      }
      return new Response(JSON.stringify({ total_count: 0, workflow_runs: [] }), { status: 200 });
    };

    await expect(readActiveProductionWriters({
      repository: 'example/repo',
      token: 'test-token',
      fetchImpl,
    })).resolves.toEqual([expect.objectContaining({ id: 321, status: 'waiting' })]);
    expect(requests.filter((url) => new URL(url).pathname.endsWith('/deploy.yml/runs'))).toHaveLength(2);
  });

  it('rejects an unreadable GitHub API response instead of admitting the probe', async () => {
    const fetchImpl = async () => new Response('{}', { status: 200 });
    await expect(readActiveProductionWriters({
      repository: 'example/repo',
      token: 'test-token',
      fetchImpl,
    })).rejects.toThrow(/no workflow_runs array/);
  });
});

describe('production-canary workflow wiring', () => {
  const workflow = YAML.parse(readFileSync(resolve(ROOT, '.github/workflows/production-canary.yml'), 'utf8')) as any;
  const job = workflow.jobs.probe;
  const steps = job.steps as Array<Record<string, any>>;
  const admissionIndex = steps.findIndex((step) => step.id === 'admission');
  const probeIndex = steps.findIndex((step) => step.id === 'probe');

  it('can read Actions run state and places admission before the live probe', () => {
    expect(workflow.permissions.actions).toBe('write');
    expect(admissionIndex).toBeGreaterThan(-1);
    expect(probeIndex).toBeGreaterThan(admissionIndex);
    expect(steps[admissionIndex].run).toContain('scripts/ci/production-canary-admission.mjs');
    expect(steps[probeIndex].if).toBe("steps.admission.outputs.skip_probe != 'true'");
  });

  it('keeps the writer registry explicit and non-empty', () => {
    expect(PRODUCTION_WRITERS.length).toBeGreaterThanOrEqual(3);
    expect(PRODUCTION_WRITERS.every(({ path, name }) => path.startsWith('.github/workflows/') && name.length > 0)).toBe(true);
  });
});
