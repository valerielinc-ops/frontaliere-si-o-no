// W0-G (F0.10): immediate build-memory interventions that are not the rewrite of the
// SSG. Swap sized to a TOTAL; explicit heap on every `node` reading dist.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import YAML from 'yaml';
import { PREFLIGHT_MIN_SWAP_MB } from '../build-plugins/shared/buildMemoryGuard';

const SCRIPT = path.resolve('scripts/ci/grow-build-swap.sh');

describe('grow-build-swap.sh sizes the swapfile to a total', () => {
  const dirs: string[] = [];
  afterEach(() => { for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true }); });

  function plan(swapTotalKb: number | null) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'grow-swap-'));
    dirs.push(dir);
    const meminfo = path.join(dir, 'meminfo');
    fs.writeFileSync(meminfo, [
      'MemTotal:       16373792 kB',
      'MemFree:         1000000 kB',
      ...(swapTotalKb === null ? [] : [`SwapTotal:      ${swapTotalKb} kB`]),
      'SwapFree:       3000000 kB',
    ].join('\n'));
    const out = execFileSync('bash', [SCRIPT], {
      env: { PATH: process.env.PATH, GROW_SWAP_PLAN_ONLY: '1', GROW_SWAP_MEMINFO: meminfo },
      encoding: 'utf8',
    });
    return Object.fromEntries(
      out.trim().replace(/^plan:\s*/, '').split(/\s+/).map((kv) => kv.split('=')),
    ) as Record<string, string>;
  }

  it('adds the difference to a 12 GiB total: nothing on the image -> +12 GiB', () => {
    expect(plan(0)).toEqual({ current_mb: '0', target_mb: '12288', add_mb: '12288' });
  });
  it('adds the difference when the image already has the classic 3 GiB swap', () => {
    expect(plan(3 * 1024 * 1024)).toMatchObject({ current_mb: '3072', add_mb: '9216' });
  });
  it('the run 43520109946 leg (8191 MB total) is topped up, not left short', () => {
    expect(plan(8191 * 1024)).toMatchObject({ current_mb: '8191', add_mb: '4097' });
  });
  it('adds nothing when the image already has enough', () => {
    expect(plan(12 * 1024 * 1024)).toMatchObject({ add_mb: '0' });
    expect(plan(16 * 1024 * 1024)).toMatchObject({ add_mb: '0' });
  });
  it('treats an unreadable SwapTotal as 0 (and so asks for the full target)', () => {
    expect(plan(null)).toMatchObject({ current_mb: '0', add_mb: '12288' });
  });
  it('has a single total constant and no fixed +8 GB size', () => {
    const src = fs.readFileSync(SCRIPT, 'utf8');
    expect(src).toMatch(/^TARGET_TOTAL_GB=12$/m);
    expect(src).not.toMatch(/^SIZE_GB=/m);
    expect(src).toContain('/proc/meminfo');
    expect(src).toContain('::warning::');          // still fail-open with a warning
    expect(src).toMatch(/swap totale/);            // prints the final total
  });
  it('keeps the preflight floor below the target, so a rounding image does not trip it', () => {
    expect(PREFLIGHT_MIN_SWAP_MB).toBeLessThan(12 * 1024);
  });
});

describe('every node that reads dist has an explicit heap limit in deploy.yml', () => {
  const doc = YAML.parse(fs.readFileSync(path.resolve('.github/workflows/deploy.yml'), 'utf8')) as any;
  // The locale publish provenance step belongs to the publish workstream.
  const NOT_THIS_PR = new Set(['Write locale publish provenance']);
  const READS_DIST = /\bnode\s+scripts\/\S+\.mjs\b[^\n]*(?:\bdist\b)/;
  const HEAP = /--max-old-space-size=(\d+)/;

  const steps = Object.entries<any>(doc.jobs).flatMap(([job, def]) =>
    (def.steps ?? []).map((step: any) => ({ job, step })));
  const readers = steps.filter(({ step }) =>
    typeof step.run === 'string' && READS_DIST.test(step.run) && !NOT_THIS_PR.has(step.name));

  it('finds the dist readers of build-locale', () => {
    const names = readers.map(({ step }) => step.name);
    expect(names).toEqual(expect.arrayContaining([
      'Prune to locale shard',
      'Hreflang index manifest (pre-barrier, no rewrite)',
      'Hreflang index manifest (keep only reciprocal indexable clusters)',
      'Validate locale shard output',
      'Assert active JobPosting coverage',
    ]));
  });

  it.each(readers.map(({ job, step }) => [`${job} / ${step.name}`, step]))('%s', (_label, step: any) => {
    const heap = HEAP.exec(String(step.env?.NODE_OPTIONS ?? '')) ?? HEAP.exec(String(step.run));
    expect(heap, 'missing --max-old-space-size').not.toBeNull();
    const mb = Number(heap![1]);
    // enough for ~1.2 GB of real use, well under the build's 14336 MB wall
    expect(mb).toBeGreaterThanOrEqual(4096);
    expect(mb).toBeLessThanOrEqual(8192);
  });

  it('does not raise the build wall or the build heap', () => {
    const pkg = JSON.parse(fs.readFileSync(path.resolve('package.json'), 'utf8'));
    expect(pkg.scripts['build:ci']).toContain('--max-old-space-size=14336');
  });
});
