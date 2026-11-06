/**
 * Exit-code behaviour of scripts/wait-for-live-article-shards.mjs.
 *
 * This probe decides, for every fast publish, whether a page that is not being
 * served yet is an INCIDENT (exit 1 → job fails → priority:high issue) or a
 * DELAY (exit 2 → job passes, no search-engine ping). Getting that wrong in
 * either direction is expensive and invisible from a green CI run, so the
 * decision is pinned here by actually running the script against a local
 * server, not by matching its source text.
 *
 * The classification it must NOT go back to is "unreachable ⇒ the push did not
 * land". That holds only for a re-publish. A brand-new article 404s for the
 * whole Pages propagation window precisely BECAUSE the push landed, so
 * reachability files the ordinary case under "lost push" — issue #5250, run
 * 31148285623: all four shard pushes confirmed on the remote, en/de/fr live in
 * ~40s, `it` still 404 at the 300s deadline, run failed, issue re-opened at
 * priority:high, page a healthy 200 shortly after.
 *
 * Sibling of tests/wait-for-live-article-meta.test.ts, which drives the
 * single-URL probe the same way (spawn + local http server).
 */
import http from 'node:http';
import { once } from 'node:events';
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const SCRIPT_PATH = resolve(process.cwd(), 'scripts/wait-for-live-article-shards.mjs');

const servers: http.Server[] = [];
const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(
    servers.map(
      (server) =>
        new Promise<void>((done, fail) => {
          server.close((error) => (error ? fail(error) : done()));
        }),
    ),
  );
  servers.length = 0;
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
  tempDirs.length = 0;
});

/** Serves 200 for any path starting with `/live`, 404 for anything else. */
async function startServer(body = '<!doctype html><html><body>live</body></html>') {
  const server = http.createServer((req, res) => {
    const pathname = new URL(req.url || '/', 'http://localhost').pathname;
    if (pathname.startsWith('/live')) {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(body);
      return;
    }
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('not found');
  });
  servers.push(server);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return `http://127.0.0.1:${(server.address() as { port: number }).port}`;
}

type Shard = { locale: string; url: string; paths?: string[] };

/**
 * Writes a summary JSON in a scratch dir and runs the probe against it.
 * `renderedHtml` (when given) is written to `<dist>/<locale>/index.html`, which
 * is what turns on the sha256 content check for that locale — without it the
 * probe falls back to status-only, which is the right default for these tests.
 */
async function runProbe(
  shards: Shard[],
  opts: { pushedLocales?: string; renderedHtml?: string } = {},
) {
  const dir = mkdtempSync(join(tmpdir(), 'fast-publish-probe-'));
  tempDirs.push(dir);

  const withPaths = shards.map((shard) =>
    opts.renderedHtml ? { ...shard, paths: [`${shard.locale}/index.html`] } : shard,
  );
  if (opts.renderedHtml) {
    for (const shard of withPaths) {
      mkdirSync(join(dir, 'dist', shard.locale), { recursive: true });
      writeFileSync(join(dir, 'dist', shard.locale, 'index.html'), opts.renderedHtml);
    }
  }
  const summaryPath = join(dir, 'summary.json');
  writeFileSync(summaryPath, JSON.stringify({ shards: withPaths }));

  const env: NodeJS.ProcessEnv = {
    ...process.env,
    FAST_PUBLISH_WAIT_TIMEOUT_MS: '1200',
    FAST_PUBLISH_WAIT_INTERVAL_MS: '100',
  };
  // Deliberately DELETED, not set to '', when the caller vouches for nothing:
  // an inherited value from the surrounding shell would silently confirm
  // locales this test never pushed.
  delete env.FAST_PUBLISH_PUSHED_LOCALES;
  if (opts.pushedLocales !== undefined) env.FAST_PUBLISH_PUSHED_LOCALES = opts.pushedLocales;

  return await new Promise<{ code: number | null; stdout: string; stderr: string }>((done, fail) => {
    const child = spawn(process.execPath, [SCRIPT_PATH, summaryPath], { env });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (c) => (stdout += c.toString()));
    child.stderr.on('data', (c) => (stderr += c.toString()));
    child.on('error', fail);
    child.on('close', (code) => done({ code, stdout, stderr }));
  });
}

describe('wait-for-live-article-shards: incident vs delay', () => {
  it('exits 0 when every shard URL serves the pushed content', async () => {
    const base = await startServer();
    const result = await runProbe([
      { locale: 'it', url: `${base}/live/it/` },
      { locale: 'en', url: `${base}/live/en/` },
    ]);
    expect(result.code, result.stdout || result.stderr).toBe(0);
    expect(result.stdout).toContain('All shard URLs are live');
  });

  it('exits 1 for an unreachable URL whose push is NOT confirmed landed', async () => {
    // No vouching from the caller ⇒ the probe cannot rule out a lost push, so a
    // 404 stays a real incident. This is also the behaviour any OTHER caller of
    // this script keeps by doing nothing.
    const base = await startServer();
    const result = await runProbe([
      { locale: 'it', url: `${base}/live/it/` },
      { locale: 'en', url: `${base}/missing/en/` },
    ]);
    expect(result.code, result.stdout || result.stderr).toBe(1);
    expect(result.stderr).toContain('NOT REACHABLE');
  });

  it('exits 2 — not 1 — for an unreachable URL whose push IS confirmed landed', async () => {
    // The exact shape of run 31148285623: the push reached the shard remote and
    // the shard's Pages build has simply not published it yet. Nobody must act.
    const base = await startServer();
    const result = await runProbe(
      [
        { locale: 'it', url: `${base}/missing/it/` },
        { locale: 'en', url: `${base}/live/en/` },
      ],
      { pushedLocales: 'it,en' },
    );
    expect(result.code, result.stdout || result.stderr).toBe(2);
    expect(result.stderr).toContain('::warning::');
    expect(result.stderr).toContain('not published yet');
    // Must not have been reported as a lost push.
    expect(result.stderr).not.toContain('NOT REACHABLE');
  });

  it('still exits 1 when only SOME of the missing URLs have a confirmed push', async () => {
    // A genuinely lost push must stay as loud as it was even when a sibling
    // locale is merely delayed in the same run — otherwise the delay case would
    // become a blanket amnesty.
    const base = await startServer();
    const result = await runProbe(
      [
        { locale: 'it', url: `${base}/missing/it/` },
        { locale: 'en', url: `${base}/missing/en/` },
      ],
      { pushedLocales: 'it' },
    );
    expect(result.code, result.stdout || result.stderr).toBe(1);
    expect(result.stderr).toContain('NOT REACHABLE');
    // and the delayed sibling is still reported, just not as the cause
    expect(result.stderr).toContain('Pages has not published it yet');
  });

  it('exits 2 for a reachable URL still serving older bytes, with no vouching needed', async () => {
    // Pre-existing behaviour, pinned so the new confirmation input cannot be
    // mistaken for a precondition of the stale path: a 200 already proves the
    // URL exists, so staleness was never evidence of a lost push.
    const base = await startServer('<!doctype html><html><body>OLD BYTES</body></html>');
    const result = await runProbe(
      [{ locale: 'it', url: `${base}/live/it/` }],
      { renderedHtml: '<!doctype html><html><body>NEW BYTES</body></html>' },
    );
    expect(result.code, result.stdout || result.stderr).toBe(2);
    expect(result.stderr).toContain('still serving older bytes');
  });
});
