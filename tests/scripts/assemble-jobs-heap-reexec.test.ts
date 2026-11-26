// @vitest-environment node
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import YAML from 'yaml';
import {
  availableMemoryBytes,
  buildReexecArgs,
  planHeapReexec,
} from '../../scripts/lib/cli-heap-reexec.mjs';

const ROOT = path.resolve(__dirname, '../..');
const ASSEMBLER = path.join(ROOT, 'scripts/assemble-jobs-dataset.mjs');
const HELPER_URL = pathToFileURL(path.join(ROOT, 'scripts/lib/cli-heap-reexec.mjs')).href;
const GUARD = 'HEAP_REEXEC_FIXTURE_GUARD';
const LOW_HEAP = '--max-old-space-size=512';
const RELAUNCH_RX = /relaunching once/g;
const MB = 1024 * 1024;
const GB = 1024 * MB;

let tmpRoot = '';
let fixture = '';

beforeAll(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'heap-reexec-'));
  fixture = path.join(tmpRoot, 'fixture.mjs');
  fs.writeFileSync(fixture, `
import v8 from 'node:v8';
import { reexecWithLargerHeap } from ${JSON.stringify(HELPER_URL)};
if (!reexecWithLargerHeap({ guardEnvVar: ${JSON.stringify(GUARD)} })) {
  console.log(JSON.stringify({
    heapLimitMb: v8.getHeapStatistics().heap_size_limit / 1048576,
    args: process.argv.slice(2),
    execArgv: process.execArgv,
    nodeOptions: process.env.NODE_OPTIONS ?? '',
    guard: process.env[${JSON.stringify(GUARD)}] ?? null,
  }));
  if (process.env.FIXTURE_MODE === 'exit') process.exit(3);
  if (process.env.FIXTURE_MODE === 'self-signal') {
    process.kill(process.pid, 'SIGTERM');
    setInterval(() => {}, 1000);
  }
  if (process.env.FIXTURE_MODE === 'await-signal') {
    process.on('SIGTERM', () => process.exit(7));
    console.log('ready');
    setInterval(() => {}, 1000);
  }
}
`);
});

afterAll(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

function childEnv(extra: Record<string, string> = {}) {
  const env: NodeJS.ProcessEnv = { ...process.env };
  delete env.NODE_OPTIONS;
  delete env.CRAWLER_SLICE_ONLY;
  delete env[GUARD];
  delete env.ASSEMBLE_JOBS_HEAP_REEXEC;
  return { ...env, ...extra };
}

function run(args: string[], extraEnv: Record<string, string> = {}) {
  return spawnSync(process.execPath, args, {
    cwd: tmpRoot,
    env: childEnv(extraEnv),
    encoding: 'utf8',
    timeout: 60_000,
  });
}

function reports(stdout: string) {
  return stdout.split('\n').filter((line) => line.startsWith('{')).map((line) => JSON.parse(line));
}

describe('planHeapReexec', () => {
  const plan = (heapMb: number, ramBytes: number) =>
    planHeapReexec({ heapLimitBytes: heapMb * MB, memoryBytes: ramBytes });

  it('raises the Node default to 8 GB on a 16 GB runner', () => {
    expect(plan(4144, 16 * GB)).toBe(8192);
  });

  it('keeps an adequate or higher limit', () => {
    expect(plan(8288, 16 * GB)).toBeNull();
    expect(plan(12384, 16 * GB)).toBeNull();
    expect(plan(12384, 8 * GB)).toBeNull();
  });

  it('scales the target down to the available RAM', () => {
    expect(plan(2096, 8 * GB)).toBe(6144);
    expect(plan(4144, 7 * GB)).toBe(5376);
    expect(plan(4144, 4 * GB)).toBeNull();
  });

  it('honours a cgroup limit only when one is set', () => {
    expect(availableMemoryBytes({ totalBytes: 16 * GB, constrainedBytes: 0 })).toBe(16 * GB);
    expect(availableMemoryBytes({ totalBytes: 16 * GB, constrainedBytes: 6 * GB })).toBe(6 * GB);
    expect(availableMemoryBytes({ totalBytes: 16 * GB, constrainedBytes: 2 ** 64 })).toBe(16 * GB);
  });

  it('replaces only the heap flag in execArgv', () => {
    for (const heapFlag of [['--max-old-space-size=2048'], ['--max_old_space_size', '2048']]) {
      expect(buildReexecArgs({
        execArgv: ['--expose-gc', ...heapFlag, '--no-warnings'],
        scriptPath: '/x/cli.mjs',
        args: ['--stats', '--max-old-space-size=1'],
        heapMb: 8192,
      })).toEqual([
        '--expose-gc', '--no-warnings', '--max-old-space-size=8192',
        '/x/cli.mjs', '--stats', '--max-old-space-size=1',
      ]);
    }
  });
});

describe('reexecWithLargerHeap in a real process', () => {
  it('relaunches once, keeping argv, execArgv and NODE_OPTIONS', () => {
    const nodeOptions = `${LOW_HEAP} --no-deprecation`;
    const result = run(['--no-warnings', fixture, '--stats', 'a b'], { NODE_OPTIONS: nodeOptions });
    expect(result.status).toBe(0);
    expect(result.stderr.match(RELAUNCH_RX)).toHaveLength(1);
    const seen = reports(result.stdout);
    expect(seen).toHaveLength(1);
    expect(seen[0].heapLimitMb).toBeGreaterThan(1000);
    expect(seen[0].args).toEqual(['--stats', 'a b']);
    expect(seen[0].execArgv).toContain('--no-warnings');
    expect(seen[0].nodeOptions).toBe(nodeOptions);
    // Removed in the child, so its own descendants are not silenced.
    expect(seen[0].guard).toBeNull();
  });

  it('overrides a low limit given on the command line', () => {
    const result = run([LOW_HEAP, fixture]);
    expect(result.status).toBe(0);
    expect(reports(result.stdout)[0].heapLimitMb).toBeGreaterThan(1000);
  });

  it('never relaunches twice, even if the child is still short of heap', () => {
    const result = run([LOW_HEAP, fixture], { [GUARD]: '1' });
    expect(result.status).toBe(0);
    expect(result.stderr).not.toMatch(RELAUNCH_RX);
    expect(reports(result.stdout)[0].heapLimitMb).toBeLessThan(1000);
  });

  it('stays in process when the caller already asked for more', () => {
    const result = run(['--max-old-space-size=12288', fixture]);
    expect(result.status).toBe(0);
    expect(result.stderr).not.toMatch(RELAUNCH_RX);
    expect(reports(result.stdout)[0].heapLimitMb).toBeGreaterThan(12000);
  });

  it('propagates the exit code', () => {
    expect(run([LOW_HEAP, fixture], { FIXTURE_MODE: 'exit' }).status).toBe(3);
  });

  it('ends by the same signal that ended the child', () => {
    const result = run([LOW_HEAP, fixture], { FIXTURE_MODE: 'self-signal' });
    expect(result.signal).toBe('SIGTERM');
  });

  it('forwards a signal sent to the parent', async () => {
    const parent = spawn(process.execPath, [LOW_HEAP, fixture], {
      cwd: tmpRoot,
      env: childEnv({ FIXTURE_MODE: 'await-signal' }),
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    let stdout = '';
    const code = await new Promise<number | null>((resolve, reject) => {
      parent.on('error', reject);
      parent.on('exit', resolve);
      parent.stdout.on('data', (chunk) => {
        const wasReady = stdout.includes('ready');
        stdout += chunk;
        if (!wasReady && stdout.includes('ready')) parent.kill('SIGTERM');
      });
    });
    expect(code).toBe(7);
  }, 60_000);
});

describe('assemble-jobs-dataset heap floor', () => {
  it('relaunches once when run as a CLI with a small heap', () => {
    // Slice-only mode returns before reading or writing any dataset file.
    const result = run([LOW_HEAP, ASSEMBLER, '--stats'], { CRAWLER_SLICE_ONLY: '1' });
    expect(result.status).toBe(0);
    expect(result.stderr.match(RELAUNCH_RX)).toHaveLength(1);
    expect(result.stdout.match(/Slice-only mode/g)).toHaveLength(1);
  }, 60_000);

  it('never relaunches an importer', () => {
    const importer = path.join(tmpRoot, 'importer.mjs');
    fs.writeFileSync(importer, `
await import(${JSON.stringify(pathToFileURL(ASSEMBLER).href)});
console.log('imported', process.pid);
`);
    const result = run([LOW_HEAP, importer]);
    expect(result.status).toBe(0);
    expect(result.stderr).not.toMatch(RELAUNCH_RX);
    expect(result.stdout.trim()).toBe(`imported ${result.pid}`);
  }, 60_000);

  it('gives the deploy prep assemble step an explicit 8 GB heap', () => {
    const workflow = YAML.parse(fs.readFileSync(path.join(ROOT, '.github/workflows/deploy.yml'), 'utf8'));
    const step = workflow.jobs.prep.steps.find((s: { id?: string }) => s.id === 'assemble_jobs');
    expect(step.env.NODE_OPTIONS).toBe('--max-old-space-size=8192');
  });
});
