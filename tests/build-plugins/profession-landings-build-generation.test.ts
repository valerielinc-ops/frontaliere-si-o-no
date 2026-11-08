import { afterEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as np from 'node:path';
import type { Plugin } from 'vite';
import { jobSectorPagesPlugin } from '../../build-plugins/jobSectorPagesPlugin';
import { professionLandingsPlugin } from '../../build-plugins/professionLandingsPlugin';
import { buildProfessionLandingPath } from '../../build-plugins/professionLandingsData';
import { _resetProfessionJobsAggregateCache } from '../../build-plugins/professionJobsAggregate';

const tempRoots: string[] = [];

function daysAgo(days: number): string {
  return new Date(Date.now() - days * 86_400_000).toISOString();
}

function nurseJob(index: number): Record<string, unknown> {
  return {
    id: `generation-nurse-${index}`,
    slug: `generation-nurse-${index}`,
    title: `Infermiere SSS ${index}`,
    company: `Clinica ${index}`,
    canton: 'TI',
    location: 'Lugano',
    addressLocality: 'Lugano',
    postedDate: daysAgo(2),
  };
}

function makeRoot(jobs: readonly Record<string, unknown>[]): string {
  const root = fs.mkdtempSync(np.join(os.tmpdir(), 'profession-build-generation-'));
  fs.mkdirSync(np.join(root, 'data'), { recursive: true });
  fs.mkdirSync(np.join(root, 'dist'), { recursive: true });
  fs.writeFileSync(np.join(root, 'data', 'jobs.json'), JSON.stringify(jobs), 'utf8');
  fs.writeFileSync(np.join(root, 'data', 'expired-jobs.json'), '[]', 'utf8');
  tempRoots.push(root);
  return root;
}

async function runBuildGeneration(producer: Plugin, consumer: Plugin): Promise<void> {
  // The production Vite lifecycle invokes buildStart before the parallel
  // closeBundle hooks. Keep the optional guard so this regression also proves
  // the old implementation fails on the stale resolved promise.
  if (typeof producer.buildStart === 'function') {
    await (producer.buildStart as () => void)();
  }
  await (producer.closeBundle as () => Promise<void>)();
  await (consumer.closeBundle as () => Promise<void>)();
}

function sectorPage(root: string): string {
  return fs.readFileSync(
    np.join(root, 'dist', 'cerca-lavoro-ticino', 'infermieri', 'index.html'),
    'utf8',
  );
}

afterEach(() => {
  vi.unstubAllEnvs();
  _resetProfessionJobsAggregateCache();
  while (tempRoots.length > 0) {
    fs.rmSync(tempRoots.pop()!, { recursive: true, force: true });
  }
});

describe('profession landing build signal generations', () => {
  it('does not reuse emitted profession paths across two sequential builds', async () => {
    vi.stubEnv('FAST_BUILD', '');
    vi.stubEnv('BUILD_LOCALE', '');

    const root = makeRoot([nurseJob(1), nurseJob(2), nurseJob(3)]);
    const producer = professionLandingsPlugin(root);
    const consumer = jobSectorPagesPlugin(root);

    await runBuildGeneration(producer, consumer);
    const professionPath = buildProfessionLandingPath('it', 'infermiere');
    expect(sectorPage(root)).toContain(`href="${professionPath}#profession-requirements"`);

    // The second build has no above-floor profession landing. The producer
    // emits a bridge, resolves [], and the sector consumer must fall back to
    // the role search instead of retaining the first build's href.
    fs.writeFileSync(np.join(root, 'data', 'jobs.json'), '[]', 'utf8');
    _resetProfessionJobsAggregateCache();
    await runBuildGeneration(producer, consumer);
    expect(sectorPage(root)).not.toContain(professionPath);
  });
});
