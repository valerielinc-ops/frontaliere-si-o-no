// Which urls the gate reads is the decision that failed on 2026-08-08 — not
// how it compares what it read.
//
// The run that published `salario-medio-professioni-svizzera-2026-basilea`
// closed green in every step, the article was live at its own url, and it was
// absent from `/articoli-svizzera/`. The gate passed too, because it read the
// overlay ONLY under the five-minute rotating key, reasoning that the rotating
// key is never the stale variant. That is true. What it assumed is that the
// client doing the requesting is the one in this repo — and the edge was
// serving a chunk from three days earlier that asks for the BARE url:
//
//   assets/runtimeArticleResolution.js  Origin sent → 2026-08-05T11:35:07Z (age 37h)
//                                       no Origin   → 2026-08-07T02:43:20Z
//
// So the gate read a cache entry no visitor requested. The entry every visitor
// DID request held 637 articles against the corpus's 647, on six of the eight
// blog-index files, 12 to 16 hours old.
//
// These pin the two decisions that close that hole: read both identities and
// make the gate model the same union the current runtime uses. Either identity
// may lead during publication (run 38079614519 caught the reverse direction).
import { describe, it, expect } from 'vitest';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { parse } from 'yaml';
import { missingFromClient } from '../scripts/lib/hydratedParity.mjs';

const SRC = readFileSync(resolve(__dirname, '../scripts/ci/check-hydrated-article-parity.mjs'), 'utf8');
const WORKFLOW = readFileSync(resolve(__dirname, '../.github/workflows/hydrated-article-parity.yml'), 'utf8');
const WORKFLOW_DOCUMENT = parse(WORKFLOW);
const CHECK_STEP = WORKFLOW_DOCUMENT.jobs.parity.steps.find(
  (step: { name?: string }) => step.name === 'Check hydrated article parity',
);

describe('the surfaces the gate reads', () => {
  it('reads the overlay at the bare url, not only under the rotating key', () => {
    // Non-vacuity: both names must exist, or the assertions below pass by
    // matching nothing after a rename.
    expect(SRC).toContain('const OVERLAY_BASE');
    expect(SRC).toContain('const OVERLAY_ROTATED');
    expect(SRC).toMatch(/\[\s*\['bare', OVERLAY_BASE\],\s*\['rotated', OVERLAY_ROTATED\]\s*\]/);
  });

  it('builds the bare url without a `v=` key — that is the whole point of reading it', () => {
    const base = SRC.match(/const OVERLAY_BASE = flag\('overlay', `([^`]+)`\)/)?.[1];
    expect(base).toBeDefined();
    expect(base).not.toContain('v=');
    expect(base).toContain('blog-index-');
  });

  it('feeds clientIds from both reads, matching the current runtime', () => {
    expect(SRC).toMatch(/for \(const id of overlayIds\.bare\) clientIds\.add\(id\)/);
    expect(SRC).toMatch(/for \(const id of overlayIds\.rotated\) clientIds\.add\(id\)/);
  });

  it('rejects a rotating-only id whose empty title makes it unusable at runtime', async () => {
    const server = createServer((request, response) => {
      response.statusCode = 200;
      response.setHeader('content-type', 'application/json');
      const url = new URL(request.url ?? '/', 'http://localhost');
      if (url.pathname === '/articoli-frontaliere/') {
        response.setHeader('content-type', 'text/html');
        response.end('<div class="ssg-article-grid"><a href="/articoli-frontaliere/article-x/" aria-label="x" class="ssg-art-card"><h3>x</h3></a></div>');
      } else if (url.pathname === '/slugs.json') {
        response.end(JSON.stringify({ blogReverse: { it: { 'article-x': 'x' } } }));
      } else if (url.pathname === '/data/blog-index-frontaliere-it.json') {
        response.end(JSON.stringify({
          articles: url.searchParams.has('v') ? [{ id: 'x', title: '' }] : [],
        }));
      } else {
        response.setHeader('content-type', 'text/javascript');
        response.end('export default [];');
      }
    });

    await new Promise<void>((resolveListen) => server.listen(0, '127.0.0.1', resolveListen));
    try {
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('fixture server has no TCP address');
      const base = `http://127.0.0.1:${address.port}`;
      const result = await new Promise<{ code: number | null; stdout: string; stderr: string }>((resolveRun) => {
        const child = spawn(process.execPath, [
          resolve(__dirname, '../scripts/ci/check-hydrated-article-parity.mjs'),
          `--base=${base}`,
          `--cdn=${base}`,
          `--api=${base}`,
          '--section=frontaliere',
          '--locale=it',
          '--json',
        ]);
        let stdout = '';
        let stderr = '';
        child.stdout.setEncoding('utf8').on('data', (chunk) => { stdout += chunk; });
        child.stderr.setEncoding('utf8').on('data', (chunk) => { stderr += chunk; });
        child.on('close', (code) => resolveRun({ code, stdout, stderr }));
      });
      expect(result.stdout, result.stderr).not.toBe('');
      const report = JSON.parse(result.stdout);

      expect(result.code).toBe(1);
      expect(report.missing).toEqual(['article-x (id: x)']);
      expect(result.stderr).toContain('1/1 rendered articles are absent');
    } finally {
      await new Promise<void>((resolveClose, rejectClose) => {
        server.close((error) => error ? rejectClose(error) : resolveClose());
      });
    }
  });

  it('reads the chunks that carry the overlay mechanism, so a stale client is visible', () => {
    expect(SRC).toContain('assets/runtimeArticleResolution.js');
    expect(SRC).toContain('assets/BlogArticles.js');
    // They are code: read for the divergence check, never parsed for ids.
    expect(SRC).toMatch(/for \(const url of CODE_SURFACES\)/);
    expect(SRC).not.toMatch(/idsInRegistryChunk\([^)]*\)[\s\S]{0,80}CODE_SURFACES/);
  });
});

describe('the propagation retry window', () => {
  it('rechecks failed surfaces in global five-minute rounds', () => {
    expect(WORKFLOW).toContain('while [ -s parity-targets.txt ] && [ "$attempt" -le "$PARITY_ATTEMPTS" ]');
    expect(WORKFLOW).toContain('while read -r -u 9 section locale');
    expect(WORKFLOW).toContain('done 9< parity-targets.txt');
    expect(WORKFLOW).toContain('run_probe "$section" "$locale" </dev/null 2>&1');
    expect(WORKFLOW).toContain('sleep "$PARITY_RETRY_SLEEP_SECONDS"');
    expect(WORKFLOW).not.toContain('sleep 45');
  });

  it('exposes an explicit workflow-dispatch fixture for the all-red path', () => {
    const input = WORKFLOW_DOCUMENT.on.workflow_dispatch.inputs.force_probe_failure;
    expect(input.type).toBe('boolean');
    expect(input.default).toBe(false);
    expect(CHECK_STEP.env.PARITY_FORCE_PROBE_FAILURE).toContain('force_probe_failure');
    expect(CHECK_STEP.run).toContain('forced parity failure for $1/$2');
    expect(CHECK_STEP.run).toContain('cat parity-report.txt');
  });

  it('bounds the all-red path below the 25-minute job timeout', () => {
    const env = CHECK_STEP.env;
    const attempts = Number(env.PARITY_ATTEMPTS);
    const sleepSeconds = Number(env.PARITY_RETRY_SLEEP_SECONDS);
    const probeSeconds = Number(env.PARITY_PROBE_TIMEOUT_SECONDS);
    const killGraceSeconds = Number(env.PARITY_PROBE_KILL_AFTER_SECONDS);
    const allEightTargetsSeconds = (attempts - 1) * sleepSeconds
      + attempts * 8 * (probeSeconds + killGraceSeconds);

    expect(allEightTargetsSeconds).toBe(1128);
    expect(allEightTargetsSeconds).toBeLessThanOrEqual(20 * 60);
    expect(WORKFLOW_DOCUMENT.jobs.parity['timeout-minutes']).toBe(25);
  });

  it('reports all eight targets after all 24 probes fail', () => {
    const fixture = mkdtempSync(resolve(tmpdir(), 'hydrated-parity-retry-'));
    const bin = resolve(fixture, 'bin');
    const calls = resolve(fixture, 'calls.txt');
    const sleeps = resolve(fixture, 'sleeps.txt');
    try {
      spawnSync('mkdir', ['-p', bin], { encoding: 'utf8' });
      const executables = {
        node: `#!/bin/sh\nprintf '%s\\n' "$*" >> "$PARITY_TEST_CALLS"\nprintf 'forced failure %s\\n' "$*"\nexit 1\n`,
        sleep: `#!/bin/sh\nprintf '%s\\n' "$1" >> "$PARITY_TEST_SLEEPS"\n`,
        timeout: `#!/bin/sh\nwhile [ "$#" -gt 0 ]; do\n  case "$1" in\n    --signal=*|--kill-after=*) shift ;;\n    *s) shift; break ;;\n    *) break ;;\n  esac\ndone\nexec "$@"\n`,
      };
      for (const [name, body] of Object.entries(executables)) {
        const path = resolve(bin, name);
        writeFileSync(path, body);
        chmodSync(path, 0o755);
      }

      const startedAt = performance.now();
      const run = spawnSync('bash', ['-c', CHECK_STEP.run], {
        cwd: fixture,
        encoding: 'utf8',
        env: {
          ...process.env,
          ...Object.fromEntries(Object.entries(CHECK_STEP.env).map(([key, value]) => [key, String(value)])),
          SECTION_INPUT: 'both',
          PARITY_TEST_CALLS: calls,
          PARITY_TEST_SLEEPS: sleeps,
          PARITY_FORCE_PROBE_FAILURE: 'false',
          PATH: `${bin}:${process.env.PATH}`,
        },
      });
      const elapsedMs = performance.now() - startedAt;
      const report = readFileSync(resolve(fixture, 'parity-report.txt'), 'utf8');

      expect(run.status).toBe(1);
      expect(readFileSync(calls, 'utf8').trim().split('\n')).toHaveLength(24);
      expect(readFileSync(sleeps, 'utf8').trim().split('\n')).toEqual(['300', '300']);
      expect(report.match(/^### (?:frontaliere|svizzera)\/(?:it|en|de|fr)$/gm)).toHaveLength(8);
      expect(elapsedMs).toBeLessThan(5_000);
    } finally {
      rmSync(fixture, { recursive: true, force: true });
    }
  });
});

describe('why both cache identities decide the current runtime verdict', () => {
  // Recorded from the live edge on 2026-08-08, same url within the same second.
  const RENDERED = ['salario-medio-professioni-svizzera-2026-basilea', 'salari-medi-zurigo-2026-confronto'];
  const reverse = Object.fromEntries(RENDERED.map((s) => [s, s]));

  const bareRead = new Set(['salari-medi-zurigo-2026-confronto']); // 637-article copy
  const rotatedRead = new Set(RENDERED); // 647-article copy

  it('names the lost article when the copy the served client requests is stale', () => {
    expect(missingFromClient(RENDERED, reverse, bareRead)).toEqual([
      'salario-medio-professioni-svizzera-2026-basilea',
    ]);
  });

  it('is exactly what the rotating-key-only read hid', () => {
    // Same hub, same corpus, same second — and a clean bill of health. This is
    // the green run of 2026-08-08 reproduced.
    expect(missingFromClient(RENDERED, reverse, rotatedRead)).toEqual([]);
  });

  it('also covers a rotating bucket populated before the bare URL was purged', () => {
    const bareFresh = new Set(RENDERED);
    const rotatedStale = new Set(['salari-medi-zurigo-2026-confronto']);
    const runtimeIds = new Set([...bareFresh, ...rotatedStale]);
    expect(missingFromClient(RENDERED, reverse, runtimeIds)).toEqual([]);
  });
});
