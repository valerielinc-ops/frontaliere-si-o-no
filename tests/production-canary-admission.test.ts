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

  it('reads every active status and deduplicates a run observed during a status transition', async () => {
    const requests: string[] = [];
    const fetchImpl = async (url: string) => {
      requests.push(url);
      const status = new URL(url).searchParams.get('status');
      const body = status === 'in_progress' || status === 'queued'
        ? { total_count: 1, workflow_runs: [run({ id: 321, status })] }
        : { total_count: 0, workflow_runs: [] };
      return new Response(JSON.stringify(body), { status: 200 });
    };

    const selected = await readActiveProductionWriters({
      repository: 'example/repo',
      token: 'test-token',
      fetchImpl,
    });

    expect(requests).toHaveLength(5);
    expect(new Set(requests.map((url) => new URL(url).pathname))).toEqual(new Set(['/repos/example/repo/actions/runs']));
    expect(selected.map((candidate) => candidate.id)).toEqual([321]);
  });

  it('reads every page before admitting a writer that is beyond the first page', async () => {
    const requests: string[] = [];
    const fetchImpl = async (url: string) => {
      requests.push(url);
      const parsed = new URL(url);
      const status = parsed.searchParams.get('status');
      const page = parsed.searchParams.get('page');
      if (status === 'queued' && page === '1') {
        return new Response(JSON.stringify({
          total_count: 101,
          workflow_runs: Array.from({ length: 100 }, (_, index) => ({
            id: index + 1,
            status,
            path: '.github/workflows/unrelated.yml',
            name: 'Unrelated workflow',
          })),
        }), { status: 200 });
      }
      if (status === 'queued' && page === '2') {
        return new Response(JSON.stringify({ total_count: 101, workflow_runs: [run({ id: 321, status })] }), { status: 200 });
      }
      return new Response(JSON.stringify({ total_count: 0, workflow_runs: [] }), { status: 200 });
    };

    const selected = await readActiveProductionWriters({
      repository: 'example/repo',
      token: 'test-token',
      fetchImpl,
    });

    expect(requests.some((url) => {
      const parsed = new URL(url);
      return parsed.searchParams.get('status') === 'queued' && parsed.searchParams.get('page') === '2';
    })).toBe(true);
    expect(selected.map((candidate) => candidate.id)).toEqual([321]);
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
    expect(workflow.permissions.actions).toBe('read');
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
