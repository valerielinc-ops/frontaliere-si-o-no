import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-expect-error — runtime-neutral Worker helper has no separate declarations.
import { sectionTreeBucket, ticinoTreeBucket } from '../infra/cloudflare-worker/ticino-tree-bucket.js';
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-expect-error — runtime-neutral fan-out helper has no separate declarations.
import {
  SECTION_TREE_FANOUT_SECTIONS as SCRIPT_FANOUT_SECTIONS,
  sectionTreePhysicalPath,
  ticinoTreePhysicalPath,
} from '../scripts/lib/ticino-tree-fanout.mjs';
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-expect-error — plain JS Worker module, no type declarations.
import { SECTION_TREE_FANOUT_SECTIONS as WORKER_FANOUT_SECTIONS } from '../infra/cloudflare-worker/locale-router.js';

const HELPER = join(process.cwd(), 'scripts/lib/ticino-tree-fanout.sh');
const TOOL = join(process.cwd(), 'scripts/lib/ticino-tree-fanout.mjs');
const PUSH_SCRIPT = join(process.cwd(), 'scripts/lib/push-section-shard.sh');

describe('Ticino shard tree fan-out', () => {
  it('keeps the Worker and publisher static floor in sync', () => {
    expect(SCRIPT_FANOUT_SECTIONS).toEqual(['ticino', 'zurigo', 'berna']);
    expect(WORKER_FANOUT_SECTIONS).toEqual(SCRIPT_FANOUT_SECTIONS);
  });

  it('keeps existing Ticino and Zurich layout markers while adapting Bern', () => {
    const output = execFileSync(
      'bash',
      [
        '-c',
        'source "$1"; printf "%s\\n" "$(section_tree_layout ticino)" "$(section_tree_layout zurigo)" "$(section_tree_layout berna)" "$(section_tree_layout svizzera)"',
        'section-layout-marker-test',
        HELPER,
      ],
      { encoding: 'utf8' },
    );
    expect(output).toBe('ticino-hash-v1\nzurigo-hash-v1\nticino-hash-v1\ncanonical\n');
  });

  it('measures the canonical tree, persists/probes before layout change, and gates the fanned tree', () => {
    const script = readFileSync(PUSH_SCRIPT, 'utf8');
    const helper = readFileSync(HELPER, 'utf8');
    expect(script).toContain('source "$(dirname "${BASH_SOURCE[0]}")/ticino-tree-fanout.sh"');
    expect(script).toContain('if section_tree_uses_hash_fanout "$section" && [ "$SHARD_PUSH_MODE" = delta ]');
    expect(script).toContain('skipping advisory delta verifier');
    expect(script).toContain('section_tree_require_worker_layout "$section" "$sub"');
    expect(script.indexOf('section_tree_require_worker_layout "$section" "$sub"')).toBeLessThan(
      script.indexOf('# ── Stage subtree + offload'),
    );
    expect(helper).toContain('section_tree_measure_unfanned_pct');
    expect(helper).toContain('SECTION_TREE_WORKER_LAYOUT_CONFIRMATION');
    expect(helper).toContain('--worker-layout-confirmed');
    expect(script).toContain('section_tree_evaluate_and_apply "$section" "$loc" "$stage" "$sub" index');
    expect(script).toContain('section_tree_evaluate_and_apply "$section" "$loc" "$stage" "$sub" filesystem');
    expect(helper).not.toContain('--allow-local-transition');
    expect(script).toContain('SHARD_DELTA_LAYOUT_MOVED_PATHS * 2');
  });

  it('maps dynamic registry sections through the same section-neutral bucket function', () => {
    const previous = process.env.SECTION_TREE_LAYOUT_SECTIONS_JSON;
    try {
      process.env.SECTION_TREE_LAYOUT_SECTIONS_JSON = '["lucerna"]';
      expect(sectionTreePhysicalPath('lucerna', 'lucerne-job/index.html')).toBe(
        `_tree/${sectionTreeBucket('lucerne-job')}/lucerne-job/index.html`,
      );
      const marker = execFileSync(
        'bash',
        ['-c', 'source "$1" && section_tree_layout lucerna', 'dynamic-layout-marker-test', HELPER],
        { encoding: 'utf8', env: { ...process.env, SECTION_TREE_LAYOUT_SECTIONS_JSON: '["lucerna"]' } },
      );
      expect(marker).toBe('ticino-hash-v1');
    } finally {
      if (previous === undefined) delete process.env.SECTION_TREE_LAYOUT_SECTIONS_JSON;
      else process.env.SECTION_TREE_LAYOUT_SECTIONS_JSON = previous;
    }
  });

  it('fails closed when the fan-out classifier is unavailable', () => {
    const temp = mkdtempSync(join(tmpdir(), 'section-tree-missing-tool-'));
    const root = join(temp, 'section');
    try {
      mkdirSync(root, { recursive: true });
      const output = execFileSync(
        'bash',
        [
          '-c',
          'source "$1"; TICINO_TREE_FANOUT_TOOL="$2/missing.mjs"; '
            + 'if section_tree_fanout_stage berna "$3"; then exit 10; fi; '
            + 'if section_tree_unfanout_stage berna "$3"; then exit 11; fi; '
            + 'if section_tree_require_worker_layout berna de/jobs-in-bern; then exit 12; fi; '
            + 'if section_tree_layout berna >/dev/null; then exit 13; fi; '
            + 'printf "failed-closed\\n"',
          'fanout-missing-tool-test',
          HELPER,
          temp,
          root,
        ],
        { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
      );
      expect(output).toBe('failed-closed\n');
    } finally {
      rmSync(temp, { recursive: true, force: true });
    }
  });

  it('moves first-level entries into shared hash buckets and keeps the root index', () => {
    const temp = mkdtempSync(join(tmpdir(), 'ticino-tree-fanout-'));
    const root = join(temp, 'de', 'jobs-im-tessin');
    try {
      mkdirSync(root, { recursive: true });
      writeFileSync(join(root, 'index.html'), 'section shell');
      mkdirSync(join(root, 'Ir-Job-123'), { recursive: true });
      writeFileSync(join(root, 'Ir-Job-123', 'index.html'), 'job');
      mkdirSync(join(root, 'aa-company'), { recursive: true });
      writeFileSync(join(root, 'aa-company', 'index.html'), 'company');
      writeFileSync(join(root, 'zz-flat.html'), 'flat');

      execFileSync(
        'bash',
        ['-c', 'source "$1" && ticino_tree_fanout_stage ticino "$2"', 'fanout-test', HELPER, root],
        { stdio: 'pipe' },
      );

      expect(readFileSync(join(root, 'index.html'), 'utf8')).toBe('section shell');
      expect(readFileSync(join(root, '_tree', ticinoTreeBucket('Ir-Job-123'), 'Ir-Job-123', 'index.html'), 'utf8')).toBe('job');
      expect(readFileSync(join(root, '_tree', ticinoTreeBucket('aa-company'), 'aa-company', 'index.html'), 'utf8')).toBe('company');
      expect(readFileSync(join(root, '_tree', ticinoTreeBucket('zz-flat.html'), 'zz-flat.html'), 'utf8')).toBe('flat');
    } finally {
      rmSync(temp, { recursive: true, force: true });
    }
  });

  it('maps source paths to the same physical layout used by the fan-out', () => {
    expect(ticinoTreePhysicalPath('index.html')).toBe('index.html');
    expect(ticinoTreePhysicalPath('Ir-Job-123/index.html')).toBe(
      `_tree/${ticinoTreeBucket('Ir-Job-123')}/Ir-Job-123/index.html`,
    );
    expect(ticinoTreePhysicalPath('zz-flat.html')).toBe(
      `_tree/${ticinoTreeBucket('zz-flat.html')}/zz-flat.html`,
    );
    expect(sectionTreePhysicalPath('zurigo', 'new-offer/index.html')).toBe(
      `_tree/${sectionTreeBucket('new-offer')}/new-offer/index.html`,
    );
    expect(sectionTreePhysicalPath('berna', 'new-offer/index.html')).toBe(
      `_tree/${sectionTreeBucket('new-offer')}/new-offer/index.html`,
    );
    expect(sectionTreePhysicalPath('svizzera', 'new-offer/index.html')).toBe('new-offer/index.html');
  });

  it.each(SCRIPT_FANOUT_SECTIONS)('stages and rehydrates the %s section layout', (section) => {
    const temp = mkdtempSync(join(tmpdir(), `section-tree-${section}-`));
    const root = join(temp, 'section');
    try {
      mkdirSync(root, { recursive: true });
      mkdirSync(join(root, 'first-entry'), { recursive: true });
      writeFileSync(join(root, 'first-entry', 'index.html'), 'page');

      execFileSync(
        'bash',
        ['-c', 'source "$1" && section_tree_fanout_stage "$2" "$3" && section_tree_unfanout_stage "$2" "$3"', 'section-layout-test', HELPER, section, root],
        { stdio: 'pipe' },
      );

      expect(readFileSync(join(root, 'first-entry', 'index.html'), 'utf8')).toBe('page');
      expect(() => readFileSync(join(root, '_tree'))).toThrow();
    } finally {
      rmSync(temp, { recursive: true, force: true });
    }
  });

  it('maps NUL-delimited path records through the CLI', () => {
    const input = Buffer.from(['index.html', 'Ir-Job-123/index.html', '', 'zz-flat.html', ''].join('\0'));
    const output = execFileSync(process.execPath, [TOOL, 'map-paths'], { input });

    expect(output.toString('utf8').split('\0').filter(Boolean)).toEqual([
      'index.html',
      `_tree/${ticinoTreeBucket('Ir-Job-123')}/Ir-Job-123/index.html`,
      `_tree/${ticinoTreeBucket('zz-flat.html')}/zz-flat.html`,
    ]);

    const zurigoInput = Buffer.from(['new-offer/index.html', ''].join('\0'));
    const zurigoOutput = execFileSync(process.execPath, [TOOL, 'map-paths', 'zurigo'], { input: zurigoInput });
    expect(zurigoOutput.toString('utf8').split('\0').filter(Boolean)).toEqual([
      `_tree/${sectionTreeBucket('new-offer')}/new-offer/index.html`,
    ]);
  });

  it('spreads adversarial same-prefix slugs far below GitHub’s per-tree limit', () => {
    const bucketCounts = new Uint32Array(256);
    const sampleSize = 50_000;
    for (let index = 0; index < sampleSize; index += 1) {
      const slug = `AA-job-${String(index).padStart(6, '0')}`;
      bucketCounts[Number.parseInt(ticinoTreeBucket(slug), 16)] += 1;
    }

    const maxBucketEntries = Math.max(...bucketCounts);
    const projectedEntries = Math.ceil((maxBucketEntries * 578_757) / sampleSize);
    // Git tree records are at most 282 bytes for a filesystem component of
    // 255 bytes. Project the observed worst bucket onto run 377875's 578,757
    // files, without materializing that production-sized tree in this test.
    expect([...bucketCounts].every((count) => count > 0)).toBe(true);
    expect(projectedEntries * 282).toBeLessThan(50 * 1024 * 1024);
  });

  it('fans out the Zurich section tree with the same physical layout', () => {
    const temp = mkdtempSync(join(tmpdir(), 'zurigo-tree-fanout-'));
    const root = join(temp, 'section');
    try {
      mkdirSync(root, { recursive: true });
      writeFileSync(join(root, 'index.html'), 'section');
      mkdirSync(join(root, 'entry'), { recursive: true });
      writeFileSync(join(root, 'entry', 'index.html'), 'page');
      execFileSync(
        'bash',
        ['-c', 'source "$1" && section_tree_fanout_stage zurigo "$2"', 'fanout-test', HELPER, root],
        { stdio: 'pipe' },
      );
      expect(readFileSync(join(root, 'index.html'), 'utf8')).toBe('section');
      expect(readFileSync(join(root, '_tree', sectionTreeBucket('entry'), 'entry', 'index.html'), 'utf8')).toBe('page');
    } finally {
      rmSync(temp, { recursive: true, force: true });
    }
  });

  it('leaves non-hash section trees untouched', () => {
    const temp = mkdtempSync(join(tmpdir(), 'non-ticino-tree-'));
    const root = join(temp, 'section');
    try {
      mkdirSync(root, { recursive: true });
      writeFileSync(join(root, 'entry.html'), 'page');
      execFileSync(
        'bash',
        ['-c', 'source "$1" && ticino_tree_fanout_stage svizzera "$2"', 'fanout-test', HELPER, root],
        { stdio: 'pipe' },
      );
      expect(readFileSync(join(root, 'entry.html'), 'utf8')).toBe('page');
    } finally {
      rmSync(temp, { recursive: true, force: true });
    }
  });

  it('restores a physical Ticino tree to canonical paths for rehydration', () => {
    const temp = mkdtempSync(join(tmpdir(), 'ticino-tree-unfanout-'));
    const root = join(temp, 'de', 'jobs-im-tessin');
    try {
      const bucket = ticinoTreeBucket('Ir-Job-123');
      mkdirSync(join(root, '_tree', bucket, 'Ir-Job-123'), { recursive: true });
      mkdirSync(join(root, '_tree', '.w'), { recursive: true });
      writeFileSync(join(root, 'index.html'), 'section shell');
      writeFileSync(join(root, '_tree', bucket, 'Ir-Job-123', 'index.html'), 'job');
      writeFileSync(join(root, '_tree', '.w', '.well-known'), 'metadata');

      execFileSync(
        'bash',
        ['-c', 'source "$1" && ticino_tree_unfanout_stage ticino "$2"', 'unfanout-test', HELPER, root],
        { stdio: 'pipe' },
      );

      expect(readFileSync(join(root, 'Ir-Job-123', 'index.html'), 'utf8')).toBe('job');
      expect(readFileSync(join(root, '.well-known'), 'utf8')).toBe('metadata');
      expect(readFileSync(join(root, 'index.html'), 'utf8')).toBe('section shell');
      expect(() => readFileSync(join(root, '_tree', bucket, 'Ir-Job-123', 'index.html'))).toThrow();
    } finally {
      rmSync(temp, { recursive: true, force: true });
    }
  });

  // `section_tree_require_worker_layout` delegates to the Node probe
  // (`section-tree-layout-stage.mjs probe`), which uses `fetch`. These tests run
  // the real shell helper and the real probe, and replace only the network edge:
  // a preloaded module stubs `globalThis.fetch` (and shortens the probe's
  // 20 s inter-attempt wait) so no request leaves the machine.
  const FETCH_STUB = [
    "import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';",
    "const realSetTimeout = globalThis.setTimeout;",
    "globalThis.setTimeout = (fn, ms, ...args) => realSetTimeout(fn, ms > 1000 ? 0 : ms, ...args);",
    "globalThis.fetch = async (url, init) => {",
    "  appendFileSync(process.env.TICINO_PROBE_ARGS, `${url} ${init?.method} ${init?.headers?.['User-Agent']}\\n`);",
    "  if (process.env.TICINO_PROBE_ATTEMPTS) {",
    "    let attempts = 0;",
    "    try { attempts = Number(readFileSync(process.env.TICINO_PROBE_ATTEMPTS, 'utf8')); } catch {}",
    "    attempts += 1;",
    "    writeFileSync(process.env.TICINO_PROBE_ATTEMPTS, String(attempts));",
    "    if (attempts < 2) throw new DOMException('The operation was aborted due to timeout', 'TimeoutError');",
    "  }",
    "  const [status, ...headerLines] = process.env.TICINO_PROBE_RESPONSE.split('\\n');",
    "  const headers = new Headers();",
    "  for (const line of headerLines.filter(Boolean)) {",
    "    const at = line.indexOf(':');",
    "    headers.set(line.slice(0, at).trim(), line.slice(at + 1).trim());",
    "  }",
    "  return new Response(null, { status: Number(status.split(' ')[1]), headers });",
    "};",
    '',
  ].join('\n');

  it('fails closed unless the active Worker advertises hash-v1', () => {
    const temp = mkdtempSync(join(tmpdir(), 'ticino-layout-probe-'));
    const fetchStub = join(temp, 'fetch-stub.mjs');
    const argsFile = join(temp, 'probe-args.txt');
    try {
      writeFileSync(fetchStub, FETCH_STUB);
      const invoke = (response: string) => {
        try {
          return execFileSync(
            'bash',
            ['-c', 'source "$1" && ticino_tree_require_worker_layout "$2" && echo probe-ok', 'probe-test', HELPER, 'de/jobs-im-tessin'],
            {
              encoding: 'utf8',
              stdio: ['ignore', 'pipe', 'ignore'],
              env: {
                ...process.env,
                NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ''} --import ${pathToFileURL(fetchStub).href}`.trim(),
                TICINO_PROBE_RESPONSE: response,
                TICINO_PROBE_ARGS: argsFile,
              },
            },
          );
        } catch (error) {
          return (error as { status?: number }).status;
        }
      };

      expect(invoke('HTTP/2 204\nx-frontaliere-section-tree-layout: hash-v1\nx-frontaliere-section: ticino')).toBe('probe-ok\n');
      const firstProbe = readFileSync(argsFile, 'utf8').split('\n')[0];
      expect(firstProbe).toContain(
        'https://frontaliereticino.ch/de/jobs-im-tessin/?__frontaliere_section_tree_layout=hash-v1&section=ticino',
      );
      // The shared probe is a HEAD request carrying the descriptive publisher User-Agent.
      expect(firstProbe).toMatch(/ HEAD \S.{8,}$/u);
      expect(firstProbe).not.toContain('undefined');
      expect(invoke('HTTP/2 204\nx-frontaliere-ticino-tree-layout: hash-v1')).toBe('probe-ok\n');
      // Every non-confirming answer exhausts the probe budget and stays fail-closed.
      expect(invoke('HTTP/2 200\nx-frontaliere-section-tree-layout: hash-v1\nx-frontaliere-section: ticino')).toBe(1);
      expect(invoke('HTTP/2 302\nx-frontaliere-section-tree-layout: hash-v1\nx-frontaliere-section: ticino')).toBe(1);
      expect(invoke('HTTP/2 200\n')).toBe(1);
    } finally {
      rmSync(temp, { recursive: true, force: true });
    }
  });

  it('retries a transient layout probe timeout before publishing hashed paths', () => {
    const temp = mkdtempSync(join(tmpdir(), 'ticino-layout-probe-retry-'));
    const fetchStub = join(temp, 'fetch-stub.mjs');
    const attemptsFile = join(temp, 'attempts.txt');
    try {
      writeFileSync(fetchStub, FETCH_STUB);
      const output = execFileSync(
        'bash',
        ['-c', 'source "$1" && ticino_tree_require_worker_layout "$2" && echo probe-ok', 'probe-retry-test', HELPER, 'de/jobs-im-tessin'],
        {
          encoding: 'utf8',
          stdio: ['ignore', 'pipe', 'ignore'],
          env: {
            ...process.env,
            NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ''} --import ${pathToFileURL(fetchStub).href}`.trim(),
            TICINO_PROBE_ARGS: join(temp, 'probe-args.txt'),
            TICINO_PROBE_ATTEMPTS: attemptsFile,
            TICINO_PROBE_RESPONSE: 'HTTP/2 204\nx-frontaliere-section-tree-layout: hash-v1\nx-frontaliere-section: ticino',
          },
        },
      );

      expect(output).toContain('probe-ok');
      expect(readFileSync(attemptsFile, 'utf8')).toBe('2');
    } finally {
      rmSync(temp, { recursive: true, force: true });
    }
  });

  it('revalidates the Worker after measurement before applying the layout change', () => {
    const temp = mkdtempSync(join(tmpdir(), 'ticino-layout-post-measurement-'));
    const fakeStageTool = join(temp, 'stage-tool.mjs');
    const attemptsFile = join(temp, 'attempts.txt');
    const stage = join(temp, 'stage');
    const mutation = join(temp, 'stage-mutated');
    try {
      mkdirSync(stage);
      writeFileSync(join(stage, 'index.html'), 'before');
      // Stands in for section-tree-layout-stage.mjs: the first `probe` confirms
      // the Worker, the post-measurement one no longer does, and `stage` records
      // that the layout change was applied.
      writeFileSync(
        fakeStageTool,
        "import { readFileSync, writeFileSync } from 'node:fs';\n"
          + "if (process.argv[2] === 'probe') {\n"
          + "  let attempts = 0;\n"
          + "  try { attempts = Number(readFileSync(process.env.TICINO_PROBE_ATTEMPTS, 'utf8')); } catch {}\n"
          + "  attempts += 1;\n"
          + "  writeFileSync(process.env.TICINO_PROBE_ATTEMPTS, String(attempts));\n"
          + "  process.exit(attempts === 1 ? 0 : 1);\n"
          + "}\n"
          + "writeFileSync(process.env.STAGE_MUTATION, 'mutated');\n"
          + "process.stdout.write(JSON.stringify({ decision: 'already', moved: 0, sections: ['ticino'] }) + '\\n');\n",
      );

      const script = [
        'source "$1"',
        'section_tree_uses_hash_fanout() { return 0; }',
        'section_tree_measure_unfanned_pct() { printf "50"; }',
        'if ! section_tree_require_worker_layout ticino de/jobs-im-tessin; then exit 10; fi',
        'if section_tree_evaluate_and_apply ticino de "$3" de/jobs-im-tessin filesystem test-label; then exit 11; fi',
        '[ "$(cat "$3/index.html")" = before ]',
        '[ ! -e "$4" ]',
      ].join('\n');
      execFileSync(
        'bash',
        ['-c', script, 'post-measurement-probe-test', HELPER, fakeStageTool, stage, mutation],
        {
          stdio: 'pipe',
          env: {
            ...process.env,
            TICINO_PROBE_ATTEMPTS: attemptsFile,
            SECTION_TREE_LAYOUT_STAGE_TOOL: fakeStageTool,
            STAGE_MUTATION: mutation,
          },
        },
      );
      // One probe before the measurement, one after it; the second one blocked the change.
      expect(readFileSync(attemptsFile, 'utf8')).toBe('2');
    } finally {
      rmSync(temp, { recursive: true, force: true });
    }
  });
});
