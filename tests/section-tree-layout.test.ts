import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-expect-error — runtime-neutral Worker modules have no separate declarations.
import { SECTION_TREE_FANOUT_SECTIONS } from '../infra/cloudflare-worker/ticino-tree-bucket.js';
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-expect-error — runtime-neutral Worker modules have no separate declarations.
import { createSectionTreeLayoutReader, SECTION_TREE_LAYOUT_CACHE_TTL_MS } from '../infra/cloudflare-worker/section-tree-layout.js';
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-expect-error — script helpers are executable ESM modules without declarations.
import {
  readSectionTreeLayoutRegistry,
  registerSectionTreeFanout,
  SECTION_TREE_LAYOUT_REGISTRY_KEY,
} from '../scripts/lib/section-tree-layout-registry.mjs';
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-expect-error — script helpers are executable ESM modules without declarations.
import { decideSectionTreeFanout, parseFanoutAutoThreshold } from '../scripts/lib/section-tree-fanout-policy.mjs';
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-expect-error — script helpers are executable ESM modules without declarations.
import { requireWorkerSectionTreeLayout, stageSectionTreeLayout } from '../scripts/lib/section-tree-layout-stage.mjs';
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-expect-error — script helpers are executable ESM modules without declarations.
import { rewriteSectionTreeIndex, unfanoutSectionTree } from '../scripts/lib/ticino-tree-fanout.mjs';

const tempDirs: string[] = [];

function tempDir(prefix: string) {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function git(dir: string, ...args: string[]) {
  return execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8' }).trim();
}

function fakeRegistryRequest() {
  let payload: Record<string, unknown> | null = null;
  let etag = 0;
  let puts = 0;
  const request = vi.fn(async ({ method, key, body, headers = {} }: {
    method: string;
    key: string;
    body?: string;
    headers?: Record<string, string>;
  }) => {
    expect(key).toBe(SECTION_TREE_LAYOUT_REGISTRY_KEY);
    if (method === 'GET') {
      if (!payload) return new Response('', { status: 404 });
      return new Response(JSON.stringify(payload), { status: 200, headers: { etag: `"${etag}"` } });
    }
    expect(method).toBe('PUT');
    const ifMatch = headers['if-match'];
    const ifNoneMatch = headers['if-none-match'];
    if ((ifNoneMatch === '*' && payload !== null) || (ifMatch && ifMatch !== `"${etag}"`)) {
      return new Response('', { status: 412 });
    }
    payload = JSON.parse(body ?? '{}');
    etag += 1;
    puts += 1;
    return new Response('', { status: 200, headers: { etag: `"${etag}"` } });
  });
  return { request, get payload() { return payload; }, get puts() { return puts; } };
}

function treeSizes(stage: string, tree: string) {
  const sizes = [Number(git(stage, 'cat-file', '-s', tree))];
  const rows = execFileSync('git', ['-C', stage, 'ls-tree', '-r', '-d', '-z', tree]);
  for (const row of rows.toString('utf8').split('\0').filter(Boolean)) {
    const oid = row.slice(0, row.indexOf('\t')).split(' ')[2];
    sizes.push(Number(git(stage, 'cat-file', '-s', oid)));
  }
  return sizes;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe('automatic section tree fan-out policy', () => {
  it('defaults to 40%, rejects thresholds above the safe 80% ceiling, and sticks once fanned', () => {
    expect(parseFanoutAutoThreshold(undefined)).toBe(40);
    expect(parseFanoutAutoThreshold('79.5')).toBe(79.5);
    expect(() => parseFanoutAutoThreshold('80.01')).toThrow(/at most 80/u);
    expect(decideSectionTreeFanout({ percent: 39.99 })).toBe('keep');
    expect(decideSectionTreeFanout({ percent: 40 })).toBe('fan');
    expect(decideSectionTreeFanout({ percent: 1, alreadyFanned: true })).toBe('already');
  });

  it('writes the registry idempotently and merges concurrent additions without removing entries', async () => {
    const store = fakeRegistryRequest();
    const now = () => new Date('2026-11-12T12:00:00.000Z');
    const [first, second] = await Promise.all([
      registerSectionTreeFanout('lucerna', { locale: 'de', pct: 44.2 }, { request: store.request, now, sleep: async () => {} }),
      registerSectionTreeFanout('grigioni', { locale: 'fr', pct: 48.1 }, { request: store.request, now, sleep: async () => {} }),
    ]);
    expect(first.added || second.added).toBe(true);
    const before = await readSectionTreeLayoutRegistry({ request: store.request });
    expect(Object.keys(before.sections).sort()).toEqual(['grigioni', 'lucerna']);
    const writesBefore = store.puts;
    const duplicate = await registerSectionTreeFanout('lucerna', { locale: 'it', pct: 60 }, { request: store.request, now, sleep: async () => {} });
    expect(duplicate.added).toBe(false);
    expect(store.puts).toBe(writesBefore);
    expect((await readSectionTreeLayoutRegistry({ request: store.request })).sections.lucerna).toEqual({
      layout: 'hash-v1',
      since: '2026-11-12T12:00:00.000Z',
      reason: { locale: 'de', pct: 44.2 },
    });
    const staticFloorWriteCount = store.puts;
    await registerSectionTreeFanout('zurigo', { locale: 'de', pct: 109.24 }, { request: store.request, now });
    expect(store.puts).toBe(staticFloorWriteCount);
  });

  it('writes, probes, and fans a synthetic section that crosses the threshold in that order', async () => {
    const stage = tempDir('section-tree-layout-stage-');
    const sub = 'de/jobs-in-lucerne';
    const root = join(stage, sub);
    mkdirSync(root, { recursive: true });
    writeFileSync(join(root, 'index.html'), '<html>index</html>');
    for (let index = 0; index < 220; index += 1) {
      writeFileSync(join(root, `sample-job-${String(index).padStart(4, '0')}.html`), `<p>job ${index}</p>`);
    }
    execFileSync('git', ['-C', stage, 'init', '-q']);
    git(stage, 'add', '--', sub);
    const canonicalTree = git(stage, 'write-tree');
    const canonicalSectionTree = git(stage, 'rev-parse', `${canonicalTree}:${sub}`);
    const canonicalBytes = Number(git(stage, 'cat-file', '-s', canonicalSectionTree));
    const remoteLimit = Math.ceil(canonicalBytes * 2);
    const pct = canonicalBytes * 100 / remoteLimit;
    const order: string[] = [];
    const stderr: string[] = [];
    const result = await stageSectionTreeLayout({
      section: 'lucerna',
      locale: 'de',
      percent: pct,
      threshold: 40,
      stage,
      sub,
      mode: 'filesystem',
      readRegistry: async () => ({ version: 1, sections: {} }),
      register: async (section: string, reason: { locale: string; pct: number }) => {
        order.push(`registry:${section}:${reason.locale}`);
        return {
          added: true,
          registry: { version: 1, sections: { [section]: { layout: 'hash-v1', since: '2026-11-12T12:00:00.000Z', reason } } },
        };
      },
      probeWorker: async (section: string) => { order.push(`probe:${section}`); },
      stderr: (message: string) => stderr.push(message),
    });
    expect(result.decision).toBe('fan');
    expect(order).toEqual(['registry:lucerna:de', 'probe:lucerna']);
    expect(stderr.some((message) => message.includes('[tree-fanout] section=lucerna locale=de pct='))).toBe(true);
    expect(stderr.some((message) => message.includes('warning=unfanned-tree-at-least-30'))).toBe(true);
    expect(readdirSync(root)).toContain('_tree');
    expect(readdirSync(root)).not.toContain('sample-job-0001.html');

    git(stage, 'add', '--all', '--', sub);
    const fannedTree = git(stage, 'write-tree');
    expect(Math.max(...treeSizes(stage, fannedTree))).toBeLessThan(remoteLimit);
    unfanoutSectionTree(root);
    expect(existsSync(join(root, 'sample-job-0001.html'))).toBe(true);
    expect(existsSync(join(root, '_tree'))).toBe(false);
  });

  it('applies a sticky registry section to another locale even when its local tree is below threshold', async () => {
    const order: string[] = [];
    const result = await stageSectionTreeLayout({
      section: 'lucerna',
      locale: 'en',
      percent: 12,
      threshold: 40,
      stage: '/unused',
      sub: 'en/jobs-in-lucerne',
      mode: 'index',
      readRegistry: async () => ({
        version: 1,
        sections: { lucerna: { layout: 'hash-v1', since: '2026-11-12T12:00:00.000Z', reason: { locale: 'de', pct: 44.2 } } },
      }),
      probeWorker: async (section: string, sub: string) => { order.push(`probe:${section}:${sub}`); },
      applyIndexFanout: () => { order.push('index-fanout'); return 32; },
      stderr: () => {},
    });
    expect(result.decision).toBe('already');
    expect(result.moved).toBe(32);
    expect(order).toEqual(['probe:lucerna:en/jobs-in-lucerne', 'index-fanout']);
  });

  it('does not fan or publish when the live Worker probe is missing', async () => {
    const order: string[] = [];
    await expect(stageSectionTreeLayout({
      section: 'grigioni',
      locale: 'fr',
      percent: 82,
      threshold: 40,
      stage: '/unused',
      sub: 'fr/emplois-grisons',
      mode: 'index',
      readRegistry: async () => ({ version: 1, sections: {} }),
      register: async (section: string, reason: { locale: string; pct: number }) => {
        order.push(`registry:${section}`);
        return {
          added: true,
          registry: { version: 1, sections: { [section]: { layout: 'hash-v1', since: '2026-11-12T12:00:00.000Z', reason } } },
        };
      },
      probeWorker: async () => { order.push('probe'); throw new Error('probe missing'); },
      applyIndexFanout: () => { order.push('apply'); return 1; },
      stderr: () => {},
    })).rejects.toThrow('probe missing');
    expect(order).toEqual(['registry:grigioni', 'probe']);
  });

  it('maps every path on the first index fan-out so the delta can enter its resumable path', () => {
    const stage = tempDir('section-tree-layout-index-');
    const sub = 'de/jobs-in-lucerne';
    mkdirSync(join(stage, sub), { recursive: true });
    writeFileSync(join(stage, sub, 'index.html'), 'index');
    writeFileSync(join(stage, sub, 'lucerne-job.html'), 'job');
    execFileSync('git', ['-C', stage, 'init', '-q']);
    git(stage, 'add', '--all');
    const moved = rewriteSectionTreeIndex(stage, 'lucerna', sub, 'hash-v1');
    expect(moved).toBe(1);
    const indexed = git(stage, 'ls-files', '--', sub).split('\n');
    expect(indexed).toContain(`${sub}/index.html`);
    expect(indexed.some((path) => path.includes(`${sub}/_tree/`))).toBe(true);
    expect(indexed).not.toContain(`${sub}/lucerne-job.html`);

    const publisher = readFileSync(new URL('../scripts/lib/push-section-shard.sh', import.meta.url), 'utf8');
    expect(publisher).toContain('SHARD_DELTA_LAYOUT_MOVED_PATHS * 2');
    expect(publisher).toMatch(/SHARD_DELTA_LAYOUT_MOVED_PATHS.*-gt 0.*SHARD_DELTA_RESUME_THRESHOLD/su);
  });

  it('retries the live Worker probe for the registry TTL and fails closed without its section header', async () => {
    const urls: string[] = [];
    const fetchImpl = vi.fn(async (url: string) => {
      urls.push(url);
      return urls.length === 1
        ? new Response(null, { status: 204 })
        : new Response(null, { status: 204, headers: { 'x-frontaliere-section-tree-layout': 'hash-v1', 'x-frontaliere-section': 'lucerna' } });
    });
    await requireWorkerSectionTreeLayout('lucerna', 'de/jobs-in-lucerne', {
      fetchImpl,
      sleep: async () => {},
      attempts: 3,
      retryMs: 0,
    });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(urls[0]).toContain('__frontaliere_section_tree_layout=hash-v1');
    expect(urls[0]).toContain('section=lucerna');

    await expect(requireWorkerSectionTreeLayout('lucerna', 'de/jobs-in-lucerne', {
      fetchImpl: async () => new Response(null, { status: 204 }),
      sleep: async () => {},
      attempts: 2,
      retryMs: 0,
    })).rejects.toThrow(/refusing to publish hashed paths/u);
  });

  it('Worker layout cache holds for five minutes, keeps the last good value on failure, then falls back to the static floor', async () => {
    let now = 0;
    let shouldFail = false;
    let calls = 0;
    const reader = createSectionTreeLayoutReader({
      url: 'https://cdn.example/edge/section-tree-layout.json',
      now: () => now,
      fetchImpl: async () => {
        calls += 1;
        if (shouldFail) throw new Error('network error');
        return new Response(JSON.stringify({
          version: 1,
          sections: { lucerna: { layout: 'hash-v1', since: '2026-11-12T00:00:00.000Z', reason: { locale: 'de', pct: 44.2 } } },
        }), { status: 200 });
      },
    });
    const first = await reader.sections();
    expect(first.has('lucerna')).toBe(true);
    now += SECTION_TREE_LAYOUT_CACHE_TTL_MS - 1;
    expect((await reader.sections()).has('lucerna')).toBe(true);
    expect(calls).toBe(1);
    now += 2;
    shouldFail = true;
    expect((await reader.sections()).has('lucerna')).toBe(true);
    expect(calls).toBe(2);

    reader.reset();
    const coldFailure = createSectionTreeLayoutReader({
      url: 'https://cdn.example/edge/section-tree-layout.json',
      now: () => now,
      fetchImpl: async () => { throw new Error('network error'); },
    });
    expect(await coldFailure.sections()).toEqual(new Set(SECTION_TREE_FANOUT_SECTIONS));
  });
});
