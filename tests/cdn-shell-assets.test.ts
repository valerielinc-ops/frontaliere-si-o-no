// @vitest-environment node
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

import { GTAG_INIT_CONTENT, GTAG_INIT_VERSIONED_FILENAME } from '../build-plugins/constants';
import { listStaticScriptFiles } from '../build-plugins/staticScriptsPlugin';
import { main as ensureMain } from '../scripts/ci/ensure-cdn-shell-assets.mjs';
import {
  SHELL_ASSET_CACHE_CONTROL,
  SHELL_ASSET_CDN_ORIGIN,
  checkStoredAsset,
  ensureCdnShellAssets,
  probeCdnAsset,
  shellAssetsFromStaticScripts,
  uploadShellAsset,
} from '../scripts/lib/cdn-shell-assets.mjs';

/**
 * #12270 — a fast emitter never publishes HTML that references a static shell
 * script the CDN does not have.
 *
 * Failure title if this goes red:
 *   «Percorsi veloci: l'HTML punta a uno script della shell che la CDN non ha»
 *
 * On 2026-10-07 the shell started to reference gtag-init-<hash>.js. The corpus
 * re-render pushed that HTML within minutes; the file would have reached the
 * CDN only with the full deploy, hours later. Every re-rendered article page
 * loaded a 404 in place of its static GA4 page_view for 2 h 40 min, and the
 * `::warning::` scripts/lib/cdn-asset-existence.mjs printed about it sat in two
 * green runs.
 */

const ROOT = resolve(import.meta.dirname, '..');
const read = (path: string) => readFileSync(resolve(ROOT, path), 'utf8');

const ENSURE_SCRIPT = 'scripts/ci/ensure-cdn-shell-assets.mjs';
const INCREMENTAL_PUSH = 'scripts/lib/push-article-shard-incremental.sh';

type Outcome = { key: string; outcome: string };
type Probed = 'present' | 'absent' | 'unknown';
type Stored = 'exists' | 'missing' | 'indeterminate';

/** A CDN and a bucket that hold `stored`, as the three collaborators the library takes. */
function fakeCdn(stored: Iterable<string>, {
  probeAnswer = (_key: string, has: boolean): Probed => (has ? 'present' : 'absent'),
  storeAnswer = (_key: string, has: boolean): Stored => (has ? 'exists' : 'missing'),
  uploadWorks = true,
} = {}) {
  const bucket = new Set(stored);
  const calls = { probe: [] as string[], checkStored: [] as string[], upload: [] as Array<[string, string]> };
  return {
    bucket,
    calls,
    probe: async (key: string) => {
      calls.probe.push(key);
      return probeAnswer(key, bucket.has(key));
    },
    checkStored: (key: string) => {
      calls.checkStored.push(key);
      return storeAnswer(key, bucket.has(key));
    },
    upload: (key: string, content: string) => {
      calls.upload.push([key, content]);
      if (uploadWorks) bucket.add(key);
      return uploadWorks;
    },
    log: () => {},
  };
}

/** Message of the error `run` rejects with, or '' when it resolves. */
async function failureOf(run: () => Promise<unknown>): Promise<string> {
  try {
    await run();
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  return '';
}

const ASSETS = [
  { key: 'assets/one.js', content: 'one()' },
  { key: 'assets/two.js', content: 'two()' },
];

describe('ensureCdnShellAssets', () => {
  it('reads nothing from R2 and uploads nothing when the CDN serves every file', async () => {
    const cdn = fakeCdn(['assets/one.js', 'assets/two.js']);
    const results: Outcome[] = await ensureCdnShellAssets({ assets: ASSETS, ...cdn });

    expect(results.map((result) => result.outcome)).toEqual(['served', 'served']);
    expect(cdn.calls.checkStored).toEqual([]);
    expect(cdn.calls.upload).toEqual([]);
  });

  it('uploads the file the CDN does not have, with the content it was given', async () => {
    const cdn = fakeCdn(['assets/one.js']);
    const results: Outcome[] = await ensureCdnShellAssets({ assets: ASSETS, ...cdn });

    expect(results).toEqual([
      { key: 'assets/one.js', outcome: 'served' },
      { key: 'assets/two.js', outcome: 'uploaded' },
    ]);
    expect(cdn.calls.upload).toEqual([['assets/two.js', 'two()']]);
  });

  it('stops when the missing file cannot be uploaded', async () => {
    const cdn = fakeCdn(['assets/one.js'], { uploadWorks: false });
    const message = await failureOf(() => ensureCdnShellAssets({ assets: ASSETS, ...cdn }));

    expect(message).toContain('assets/two.js');
    expect(message).toContain('the upload failed');
    expect(message).toContain('must not be published');
  });

  // A runner the edge challenges gets 403 for a file that is there. R2 decides:
  // nothing is replaced, and publishing goes on.
  it.each(['unknown', 'absent'] as const)('never replaces an object R2 holds when the probe says %s', async (answer) => {
    const cdn = fakeCdn(['assets/one.js', 'assets/two.js'], { probeAnswer: () => answer });
    const results: Outcome[] = await ensureCdnShellAssets({ assets: ASSETS, ...cdn });

    expect(results.map((result) => result.outcome)).toEqual(['stored', 'stored']);
    expect(cdn.calls.upload).toEqual([]);
  });

  it.each(['unknown', 'absent'] as const)('stops without uploading when the probe says %s and R2 cannot be read', async (answer) => {
    const cdn = fakeCdn([], { probeAnswer: () => answer, storeAnswer: () => 'indeterminate' });
    const message = await failureOf(() => ensureCdnShellAssets({ assets: ASSETS, ...cdn }));

    expect(message).toContain('R2 could not be read');
    expect(message).toContain('must not be published');
    expect(cdn.calls.upload).toEqual([]);
  });

  it('replays 2026-10-07: only the content-addressed GA4 producer is uploaded, from GTAG_INIT_CONTENT', async () => {
    const assets = shellAssetsFromStaticScripts(listStaticScriptFiles());
    const versioned = `assets/${GTAG_INIT_VERSIONED_FILENAME}`;
    // What the CDN held that evening: every file of the last full deploy,
    // which had been built before the shell learned the versioned name.
    const cdn = fakeCdn(assets.map((asset) => asset.key).filter((key) => key !== versioned));

    const results: Outcome[] = await ensureCdnShellAssets({ assets, ...cdn });

    expect(cdn.calls.upload).toEqual([[versioned, GTAG_INIT_CONTENT]]);
    expect(results.filter((result) => result.outcome === 'uploaded').map((result) => result.key)).toEqual([versioned]);
    expect(cdn.bucket.has(versioned)).toBe(true);
  });
});

describe('shellAssetsFromStaticScripts', () => {
  it('turns every file the static-scripts plugin writes into an assets/ key', () => {
    const files = listStaticScriptFiles();
    const assets = shellAssetsFromStaticScripts(files);

    expect(assets.map((asset) => asset.key)).toEqual(files.map(([name]) => `assets/${name}`));
    expect(assets.map((asset) => asset.key)).toContain(`assets/${GTAG_INIT_VERSIONED_FILENAME}`);
  });

  it.each([
    ['an empty list', [], 'no static shell script'],
    ['a file without content', [['a.js', '']], 'has no content'],
    ['a name that is a path', [['../a.js', 'x']], 'no usable file name'],
    ['an undefined name', [[undefined, 'x']], 'no usable file name'],
    ['the same name twice', [['a.js', 'x'], ['a.js', 'y']], 'listed twice'],
  ])('refuses %s', (_label, files, expected) => {
    expect(() => shellAssetsFromStaticScripts(files)).toThrow(expected);
  });
});

describe('probeCdnAsset', () => {
  // The probe reads ok, status and the content-type header, nothing else.
  const answer = (status: number, contentType: string) => (async () => ({
    ok: status >= 200 && status < 300,
    status,
    headers: new Headers({ 'content-type': contentType }),
  })) as unknown as typeof fetch;

  it.each([
    [200, 'application/javascript; charset=utf-8', 'present'],
    [404, 'text/html', 'absent'],
    [410, 'text/html', 'absent'],
    // The site origin answers 200 text/html on any path: that is not the script.
    [200, 'text/html; charset=utf-8', 'absent'],
    // Not an answer about the object: a challenge, a rate limit, the CDN itself.
    [403, 'text/html', 'unknown'],
    [429, 'text/plain', 'unknown'],
    [503, 'text/html', 'unknown'],
  ])('reads HTTP %i %s as %s', async (status, contentType, expected) => {
    expect(await probeCdnAsset('assets/a.js', { fetchImpl: answer(status, contentType) })).toBe(expected);
  });

  it('reads a request that does not complete as unknown', async () => {
    const fetchImpl = (async () => {
      throw new Error('timeout');
    }) as unknown as typeof fetch;
    expect(await probeCdnAsset('assets/a.js', { fetchImpl })).toBe('unknown');
  });

  it('asks the CDN with a query the edge has never cached, and with a User-Agent', async () => {
    const seen: Array<{ url: string; init: { method?: string; headers?: Record<string, string> } }> = [];
    const fetchImpl = (async (url: string, init: { method?: string; headers?: Record<string, string> }) => {
      seen.push({ url, init });
      return { ok: true, status: 200, headers: new Headers({ 'content-type': 'text/css' }) };
    }) as unknown as typeof fetch;

    await probeCdnAsset('assets/critical.css', { fetchImpl, now: () => 111 });
    await probeCdnAsset('assets/critical.css', { fetchImpl, now: () => 222 });

    expect(seen.map((call) => call.url)).toEqual([
      `${SHELL_ASSET_CDN_ORIGIN}/assets/critical.css?ensure=111`,
      `${SHELL_ASSET_CDN_ORIGIN}/assets/critical.css?ensure=222`,
    ]);
    expect(seen[0].init.method).toBe('HEAD');
    expect(String(seen[0].init.headers?.['User-Agent'])).toMatch(/FrontaliereTicino/);
  });
});

describe('upload-cdn-file.sh adapters', () => {
  const helperSays = (output: string) => {
    const calls: string[][] = [];
    const spawn = (_command: string, args: string[]) => {
      calls.push(args);
      return { stdout: output, stderr: '' };
    };
    return { calls, spawn };
  };

  it.each([
    ['✅ exists assets/a.js\n', 'exists'],
    ['❌ missing assets/a.js\n', 'missing'],
    ['⚠️ check indeterminate for assets/a.js: R2_* credentials missing\n', 'indeterminate'],
    ['', 'indeterminate'],
    // Another key's line is not an answer about this one.
    ['✅ exists assets/a.js.map\n', 'indeterminate'],
  ])('checkStoredAsset reads %j as %s', (output, expected) => {
    const helper = helperSays(output);
    expect(checkStoredAsset('assets/a.js', { spawn: helper.spawn, env: {} })).toBe(expected);
    expect(helper.calls[0].slice(1)).toEqual(['--check', 'assets/a.js']);
    expect(helper.calls[0][0]).toMatch(/upload-cdn-file\.sh$/);
  });

  it('uploadShellAsset puts the content under the key with the assets/ Cache-Control', () => {
    let uploadedContent = '';
    const calls: string[][] = [];
    const spawn = (_command: string, args: string[]) => {
      calls.push(args);
      uploadedContent = readFileSync(args[1], 'utf8');
      return { stdout: '✅ uploaded x -> y (Content-Type: application/javascript; charset=utf-8)\n', stderr: '' };
    };

    expect(uploadShellAsset('assets/a.js', 'content()', { spawn, env: {} })).toBe(true);
    expect(uploadedContent).toBe('content()');
    expect(calls[0].slice(2)).toEqual(['assets/a.js', SHELL_ASSET_CACHE_CONTROL]);
  });

  it('uploadShellAsset reports a PUT the helper did not confirm', () => {
    const helper = helperSays('::warning::[cdn-upload] upload failed for assets/a.js after 2 attempts\n');
    expect(uploadShellAsset('assets/a.js', 'content()', { spawn: helper.spawn, env: {} })).toBe(false);
  });
});

describe('lockstep with the full deploy', () => {
  it('gives an uploaded file the Cache-Control the deploy gives the assets/ class', () => {
    const deployed = /_r2_sync\s+\d+\s+"\$stage\/assets"\s+assets\s+"([^"]+)"/.exec(read('scripts/lib/deploy-it-pages-prep.sh'))?.[1];
    expect(deployed).toBe(SHELL_ASSET_CACHE_CONTROL);
  });

  it('probes the origin the runtime watchdog walks', () => {
    const walked = /export const CDN_ASSETS_BASE = '([^']+)'/.exec(read('scripts/ci/cdn-chunk-graph.mjs'))?.[1];
    expect(walked).toBe(`${SHELL_ASSET_CDN_ORIGIN}/assets/`);
  });
});

describe('ensure-cdn-shell-assets.mjs', () => {
  it('checks every file the static-scripts plugin writes', async () => {
    let received: Array<{ key: string; content: string }> = [];
    await ensureMain({
      ensure: async ({ assets }: { assets: Array<{ key: string; content: string }> }) => {
        received = assets;
        return [];
      },
    });

    expect(received).toEqual(shellAssetsFromStaticScripts(listStaticScriptFiles()));
    expect(received.length).toBeGreaterThan(1);
  });
});

/**
 * The emitters, found from the code rather than listed: a top-level script
 * that spawns the merge-only shard push renders shell HTML and publishes it
 * without a build. A workflow that runs one — or the push itself — must have
 * made the shell scripts available first.
 */
describe('fast emitters run the ensure step before they publish', () => {
  const emitterScripts = readdirSync(resolve(ROOT, 'scripts'))
    .filter((name) => name.endsWith('.mjs'))
    .filter((name) => read(`scripts/${name}`).includes('push-article-shard-incremental.sh'))
    .map((name) => `scripts/${name}`);
  const escapeRx = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const invocationOf = (paths: string[]) => new RegExp(
    String.raw`(?:^|[\s;&|(])(?:node|bash|tsx(?:@[\w.]+)?)\s+(?:${paths.map(escapeRx).join('|')})(?![\w.-])`,
    'm',
  );
  const publishes = invocationOf([...emitterScripts, INCREMENTAL_PUSH]);
  const ensures = invocationOf([ENSURE_SCRIPT]);
  /** A step's shell script without its comment lines. */
  const commands = (step: { run?: unknown }) => String(step.run ?? '')
    .split('\n')
    .filter((line) => !line.trim().startsWith('#'))
    .join('\n');

  const publishingJobs: Array<{ workflow: string; job: string; steps: Array<Record<string, unknown>> }> = [];
  for (const workflow of readdirSync(resolve(ROOT, '.github/workflows')).filter((name) => /\.ya?ml$/.test(name))) {
    const jobs = parse(read(`.github/workflows/${workflow}`))?.jobs ?? {};
    for (const [job, definition] of Object.entries(jobs as Record<string, { steps?: Array<Record<string, unknown>> }>)) {
      const steps = definition?.steps ?? [];
      if (steps.some((step) => publishes.test(commands(step)))) publishingJobs.push({ workflow, job, steps });
    }
  }

  it('finds the emitters this repository has today', () => {
    expect(emitterScripts).toContain('scripts/publish-article-fast.mjs');
    expect(emitterScripts).toContain('scripts/rerender-article-corpus.mjs');
    expect(emitterScripts).toContain('scripts/rerender-article-hubs.mjs');

    const workflows = publishingJobs.map((entry) => entry.workflow);
    expect(workflows).toContain('fast-publish-article.yml');
    expect(workflows).toContain('rerender-article-corpus.yml');
    expect(workflows).toContain('rerender-article-hubs.yml');
  });

  it('every job that publishes ensures first, and cannot ignore the verdict', () => {
    const offenders: string[] = [];
    for (const { workflow, job, steps } of publishingJobs) {
      const firstPublish = steps.findIndex((step) => publishes.test(commands(step)));
      const ensure = steps.findIndex((step) => ensures.test(commands(step)));
      if (ensure === -1) {
        offenders.push(`${workflow} › ${job}: publishes without running ${ENSURE_SCRIPT}`);
        continue;
      }
      if (ensure > firstPublish) offenders.push(`${workflow} › ${job}: runs ${ENSURE_SCRIPT} after its first emitter`);
      if (steps[ensure]['continue-on-error']) offenders.push(`${workflow} › ${job}: the ensure step is continue-on-error`);
      if (/ensure-cdn-shell-assets\.mjs[^\n]*\|\|/.test(commands(steps[ensure]))) {
        offenders.push(`${workflow} › ${job}: the ensure step discards its exit code`);
      }
    }
    expect(offenders).toEqual([]);
  });
});
