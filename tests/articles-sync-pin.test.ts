/**
 * The consistency pin that makes `tests/blog-slugs-sitemap-sync.test.ts` a gate
 * on real divergence instead of a race detector (issue #5298).
 *
 * That gate compares the slug registry against the committed sitemaps. Both are
 * written by ONE run of `sync-articles-sitemaps.yml`, but from two sources with
 * different freshness — `pull-articles-corpus.mjs` cloned the corpus repo's
 * branch tip, `pull-articles-api.mjs` fetches the API built from an earlier
 * state of it. The pair could therefore disagree with nobody at fault, and the
 * tell was that the SIGN inverted between runs: slugs missing from the sitemap
 * while the API lagged, sitemap URLs missing from the registry once an article
 * had been withdrawn upstream but was still in the published surface.
 *
 * The invariant this file defends: the two artifacts describe the SAME corpus
 * commit, or neither is written. Three properties, tested at the level each one
 * actually lives at:
 *
 *   1. the decision itself (`pinVerdict`) — pure, so tested as a unit;
 *   2. the corpus pull checking out the API's commit rather than the tip, and
 *      SKIPPING when it cannot — tested by running the real script against a
 *      throwaway git remote, because "which commit got checked out" is not a
 *      value the script returns, it is what it did;
 *   3. the workflow refusing to commit either half after a skip — tested by
 *      reading the YAML, since a dropped `if:` is exactly the edit that would
 *      silently restore the half-committed state.
 *
 * Not covered here, deliberately: the happy path all the way to a mirrored tree.
 * It needs a fixture above `MIN_BODY_FILES` (5000) plus parseable registries and
 * a redirect ledger on both sides — scaffolding whose upkeep would exceed what
 * it proves, given the pin is already observable at the checkout.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml } from 'yaml';

import {
  COMMIT_RE,
  PIN_ENV,
  normalizeCommit,
  pinVerdict,
} from '../scripts/lib/articles-sync-pin.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CORPUS_SCRIPT = path.join(ROOT, 'scripts', 'pull-articles-corpus.mjs');
const API_SCRIPT = path.join(ROOT, 'scripts', 'pull-articles-api.mjs');
const WORKFLOW = path.join(ROOT, '.github', 'workflows', 'sync-articles-sitemaps.yml');

const SHA_A = 'a'.repeat(40);
const SHA_B = 'b'.repeat(40);

// ─────────────────────────────────────────────────────────────────────────────
// 1. The decision
// ─────────────────────────────────────────────────────────────────────────────

describe('pinVerdict: which runs are allowed to write', () => {
  it('accepts a full sha and hands it back normalised', () => {
    const v = pinVerdict({ pinned: null, manifestCommit: `  ${SHA_A.toUpperCase()}  ` });
    expect(v.ok).toBe(true);
    expect(v.commit).toBe(SHA_A);
  });

  it('accepts a pin that still matches what the API reports', () => {
    expect(pinVerdict({ pinned: SHA_A, manifestCommit: SHA_A })).toMatchObject({
      ok: true,
      commit: SHA_A,
    });
  });

  it('refuses when the API moved off the pin — the corpus is already mirrored elsewhere', () => {
    const v = pinVerdict({ pinned: SHA_A, manifestCommit: SHA_B });
    expect(v.ok).toBe(false);
    expect(v.kind).toBe('moved');
    // Both shas in the reason: a run log that names only one leaves the reader
    // guessing which half of the pair is the stale one.
    expect(v.reason).toContain(SHA_A);
    expect(v.reason).toContain(SHA_B);
  });

  it.each([
    ['missing', undefined],
    ['null', null],
    ['empty', ''],
    ['not a string', 12345],
    // The pin's only job is to be the argument of `git fetch origin <sha>`, and
    // the protocol resolves nothing shorter than a full sha. A short one is not
    // a weaker pin, it is a guaranteed skip that would read as a stuck mirror.
    ['an abbreviated sha', SHA_A.slice(0, 12)],
    ['a placeholder', 'unknown'],
    ['not hex', 'z'.repeat(40)],
  ])('refuses a manifest whose commit is %s', (_label, value) => {
    const v = pinVerdict({ pinned: null, manifestCommit: value as never });
    expect(v.ok).toBe(false);
    expect(v.kind).toBe('no-commit');
  });

  it('normalizeCommit and COMMIT_RE agree on what a pin is', () => {
    expect(normalizeCommit(SHA_A)).toBe(SHA_A);
    expect(normalizeCommit(SHA_A.slice(0, 39))).toBeNull();
    expect(COMMIT_RE.test(SHA_A)).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. The corpus pull, run for real against a throwaway remote
// ─────────────────────────────────────────────────────────────────────────────

/**
 * A tiny corpus repo with two commits, so "tip" and "the API's commit" differ.
 *
 * `extraFiles` pads it past MIN_BODY_FILES for the one test that has to get past
 * the absolute floor; every other test wants the cheap version, so padding is
 * opt-in rather than the default.
 */
function makeCorpusRemote(
  { extraFiles = 0 }: { extraFiles?: number } = {},
): { url: string; dir: string; head: string; older: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'corpus-remote-'));
  const git = (...args: string[]) =>
    execFileSync('git', ['-C', dir, ...args], { encoding: 'utf-8' }).trim();

  execFileSync('git', ['init', '--quiet', '--initial-branch', 'main', dir]);
  git('config', 'user.email', 'fixture@example.invalid');
  git('config', 'user.name', 'Fixture');
  // The two capabilities the script's fetch relies on. GitHub enables the
  // reachable-SHA1 variant of the first (verified against the real mirror: the
  // published manifest's commit fetches cleanly while `main` is ahead of it),
  // and the partial-clone filter; a bare local remote enables neither by default.
  git('config', 'uploadpack.allowAnySHA1InWant', 'true');
  git('config', 'uploadpack.allowFilter', 'true');

  fs.mkdirSync(path.join(dir, 'content'));
  fs.writeFileSync(path.join(dir, 'content', 'marker.txt'), 'older\n');
  for (let i = 0; i < extraFiles; i++) {
    fs.writeFileSync(path.join(dir, 'content', `pad-${i}.txt`), 'x');
  }
  git('add', '-A');
  git('commit', '--quiet', '-m', 'older');
  const older = git('rev-parse', 'HEAD');

  fs.writeFileSync(path.join(dir, 'content', 'marker.txt'), 'newer\n');
  git('add', '-A');
  git('commit', '--quiet', '-m', 'newer');
  const head = git('rev-parse', 'HEAD');

  return { url: `file://${dir}`, dir, head, older };
}

/**
 * A checkout for the script to write into. Only the paths it reads before the
 * pin decision matter, so this stays deliberately thin.
 */
function makeSiteCheckout(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'site-checkout-'));
  fs.mkdirSync(path.join(dir, 'packages', 'articles', 'content'), { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'packages', 'articles', 'content', 'sentinel.txt'),
    'must survive a skipped sync\n',
  );
  return dir;
}

/**
 * Async on purpose: the manifest server lives in THIS process, so a blocking
 * spawnSync would park the event loop and the child's first fetch would hang
 * against a server that cannot answer. The deadlock looks exactly like a slow
 * test, which is why it is worth saying out loud.
 */
function runScript(
  script: string,
  cwd: string,
  env: Record<string, string>,
): Promise<{ code: number | null; out: string }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [script], {
      cwd,
      env: {
        ...process.env,
        // The sandbox exports a proxy; the fixture server is loopback.
        NO_PROXY: '127.0.0.1,localhost',
        no_proxy: '127.0.0.1,localhost',
        ...env,
      },
    });
    let out = '';
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (out += d));
    child.on('close', (code) => resolve({ code, out }));
  });
}

describe('pull-articles-corpus: the corpus follows the published API, not the branch tip', () => {
  let server: http.Server;
  let apiBase: string;
  let manifestBody: string;
  const cleanup: string[] = [];

  beforeAll(async () => {
    server = http.createServer((req, res) => {
      if ((req.url ?? '').replace(/^\//, '') !== 'manifest.json') {
        res.writeHead(404).end('not found');
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json' }).end(manifestBody);
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    apiBase = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  });

  afterAll(async () => {
    await new Promise<void>((r) => server.close(() => r()));
    for (const d of cleanup) fs.rmSync(d, { recursive: true, force: true });
  });

  const manifest = (commit: unknown) =>
    JSON.stringify({ schema: 1, commit, counts: { articles: 3116 } });

  it('checks out the commit the manifest names even when the mirror has moved past it', async () => {
    const remote = makeCorpusRemote();
    const site = makeSiteCheckout();
    cleanup.push(remote.dir, site);
    manifestBody = manifest(remote.older);

    const { out } = await runScript(CORPUS_SCRIPT, site, {
      ARTICLES_API_BASE: apiBase,
      ARTICLES_CORPUS_REMOTE: remote.url,
    });

    // The property under test. Before the fix the clone took `--branch main` and
    // this line would have named the tip — the sitemaps being written by the
    // sibling step describe `remote.older`, so a registry from `remote.head` is
    // the mismatch the whole gate trips on.
    expect(out).toContain(`corpus pinned to ${remote.older}`);
    expect(out).not.toContain(`corpus pinned to ${remote.head}`);
    // And it says so: a pin that silently differs from the tip is a fact the
    // next person debugging a stale hub needs in the log.
    expect(out).toContain(remote.head.slice(0, 8));
  });

  it('takes the tip when the API is already caught up with it', async () => {
    const remote = makeCorpusRemote();
    const site = makeSiteCheckout();
    cleanup.push(remote.dir, site);
    manifestBody = manifest(remote.head);

    const { out } = await runScript(CORPUS_SCRIPT, site, {
      ARTICLES_API_BASE: apiBase,
      ARTICLES_CORPUS_REMOTE: remote.url,
    });

    expect(out).toContain(`corpus pinned to ${remote.head} (main tip)`);
  });

  it('SKIPS, writing nothing, when the mirror cannot serve the commit the API names', async () => {
    const remote = makeCorpusRemote();
    const site = makeSiteCheckout();
    cleanup.push(remote.dir, site);
    // A well-formed sha that is simply not in this repo — what a force-push or a
    // mirror that has not received the publisher's push yet looks like.
    manifestBody = manifest('c0ffee'.repeat(6) + 'cafe');

    const { code, out } = await runScript(CORPUS_SCRIPT, site, {
      ARTICLES_API_BASE: apiBase,
      ARTICLES_CORPUS_REMOTE: remote.url,
    });

    // Exit 0: a skip is not a failure. Nothing was written, so the committed
    // pair is still internally consistent and the next dispatch retries. Making
    // this red would put the gate's own flakiness back one layer down.
    expect(code).toBe(0);
    expect(out).toContain('::warning::[pull-articles-corpus] sync skipped');
    // Untouched — not "restored afterwards". The decision happens before the
    // mirror, so there is no window in which the registry is half-replaced.
    expect(
      fs.readFileSync(path.join(site, 'packages/articles/content/sentinel.txt'), 'utf-8'),
    ).toBe('must survive a skipped sync\n');
  });

  /**
   * The condition the pin MAKES normal, so it gets a real fixture rather than a
   * note. Pinning means checking out a commit that is at or behind the corpus
   * tip, so a sync landing while the API catches up legitimately sees fewer
   * files than the tree this repo already committed. That used to be `refusing`
   * — measured on the first real run of the pinned code: mirror at b8669256 with
   * 15090 files, published API still at c6897c28 with 15088, and the sync would
   * have sat red for hours over something the next publish clears.
   *
   * The fixture pays MIN_BODY_FILES (5000) because the absolute floor is checked
   * first and must stay a hard refusal: under the pin no genuine corpus commit is
   * that small, so a tree below it means a broken clone, not a lagging producer.
   */
  it('SKIPS rather than refuses when the pinned commit is behind the corpus already committed here', async () => {
    const remote = makeCorpusRemote({ extraFiles: 5000 });
    const site = makeSiteCheckout();
    cleanup.push(remote.dir, site);
    // One more file than the pinned tree carries: the shape of a site whose
    // registry came from a later publish than the one the API is serving.
    const dest = path.join(site, 'packages', 'articles', 'content');
    for (let i = 0; i < 5002; i++) fs.writeFileSync(path.join(dest, `f${i}.txt`), 'x');
    manifestBody = manifest(remote.head);

    const { code, out } = await runScript(CORPUS_SCRIPT, site, {
      ARTICLES_API_BASE: apiBase,
      ARTICLES_CORPUS_REMOTE: remote.url,
    });

    expect(code).toBe(0);
    expect(out).toContain('::warning::[pull-articles-corpus] sync skipped');
    expect(out).toContain('has not caught up');
    // Still not a mirror: a shrunken corpus reaches the checkout on neither path.
    expect(fs.existsSync(path.join(dest, 'sentinel.txt'))).toBe(true);
  });

  it('SKIPS when the manifest carries no usable commit — there is nothing to pin to', async () => {
    const remote = makeCorpusRemote();
    const site = makeSiteCheckout();
    cleanup.push(remote.dir, site);
    manifestBody = manifest(null);

    const { code, out } = await runScript(CORPUS_SCRIPT, site, {
      ARTICLES_API_BASE: apiBase,
      ARTICLES_CORPUS_REMOTE: remote.url,
    });

    expect(code).toBe(0);
    expect(out).toContain('::warning::[pull-articles-corpus] sync skipped');
    expect(out).toContain('no usable commit');
  });
});

describe('pull-articles-api: refuses to write sitemaps the registry will not match', () => {
  let server: http.Server;
  let apiBase: string;
  let manifestBody: string;
  const cleanup: string[] = [];

  beforeAll(async () => {
    server = http.createServer((req, res) => {
      if ((req.url ?? '').replace(/^\//, '') !== 'manifest.json') {
        res.writeHead(404).end('not found');
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json' }).end(manifestBody);
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    apiBase = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  });

  afterAll(async () => {
    await new Promise<void>((r) => server.close(() => r()));
    for (const d of cleanup) fs.rmSync(d, { recursive: true, force: true });
  });

  it('skips when the surface moved between the corpus clone and this pull', async () => {
    const site = fs.mkdtempSync(path.join(os.tmpdir(), 'site-api-'));
    cleanup.push(site);
    fs.mkdirSync(path.join(site, 'public'));
    manifestBody = JSON.stringify({ commit: SHA_B, counts: { articles: 3116 } });

    const { code, out } = await runScript(API_SCRIPT, site, {
      ARTICLES_API_BASE: apiBase,
      // What the corpus pull exported before the ~15k-file clone. nanako
      // publishes every 10-20 minutes during generation hours, so this window is
      // measured, not hypothetical.
      [PIN_ENV]: SHA_A,
    });

    expect(code).toBe(0);
    expect(out).toContain('::warning::[pull-articles-api] sync skipped');
    // It bails at the manifest, before fetching — let alone writing — any of the
    // fourteen artifacts. The 404-only fixture server proves it: reaching the
    // sitemaps would have failed loudly instead.
    expect(fs.readdirSync(path.join(site, 'public'))).toHaveLength(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. The workflow, which is where a half-commit would actually happen
// ─────────────────────────────────────────────────────────────────────────────

describe('sync-articles-sitemaps.yml: a skip stops the whole run, not just one step', () => {
  const steps = (() => {
    const doc = parseYaml(fs.readFileSync(WORKFLOW, 'utf-8')) as {
      permissions: Record<string, string>;
      jobs: { sync: { steps: Array<{ name?: string; id?: string; if?: string; run?: string }> } };
    };
    return doc;
  })();

  const byName = (fragment: string) =>
    steps.jobs.sync.steps.find((s) => s.name?.includes(fragment));

  it('does not pull the published surface once the corpus pull has given up', () => {
    expect(byName('Pull published sitemaps')?.if).toContain(
      "steps.pull-corpus.outputs.skipped != 'true'",
    );
  });

  it('gates every writing step on the same decision', () => {
    // The commit is the half-state; the convergence check would then report a
    // divergence the run itself created. Both must stand down together.
    for (const name of ['Commit if changed', 'Verify registry ↔ sitemap convergence']) {
      expect(byName(name)?.if, `${name} must be gated`).toContain(
        "steps.gate.outputs.skipped != 'true'",
      );
    }
  });

  it('escalates a run of skips instead of trusting a green log', () => {
    const escalate = byName('Escalate a sync that keeps being skipped');
    expect(escalate?.if).toContain("steps.gate.outputs.skipped == 'true'");
    // The threshold is the whole point of the step: one skip self-heals, three
    // in a row means the mirror is stuck. Pinned here so it cannot drift to the
    // library default without someone re-reading why 3 was chosen.
    expect(escalate?.run).toContain('--consecutive-gate 3');
    expect(escalate?.run).toContain('--gate-window-hours 36');
    // Opening it needs the scope; `contents: write` alone fails silently.
    expect(steps.permissions.issues).toBe('write');
  });

  it('closes the escalation when a sync succeeds, so "consecutive" means consecutive', () => {
    const resolve = byName('Clear the skip escalation');
    expect(resolve?.if).toContain("steps.gate.outputs.skipped != 'true'");
    expect(resolve?.run).toContain('--resolve');
    // Same stable title on both sides or the counter never resets and the issue
    // never closes.
    const title = 'Article sync skipped: corpus mirror behind the published API';
    expect(byName('Escalate a sync that keeps being skipped')?.run).toContain(title);
    expect(resolve?.run).toContain(title);
  });

  it('replays BOTH pulls when a rebase conflict forces a regenerate', () => {
    // The helper hard-resets to origin/main first, which discards the corpus
    // half too. Regenerating only the API half rebuilds the sitemaps against
    // whatever registry origin/main carries — #5298, reintroduced on the
    // conflict path.
    const commit = byName('Commit if changed');
    expect(commit?.run).toContain(
      '--regenerate-cmd "node scripts/pull-articles-corpus.mjs && node scripts/pull-articles-api.mjs',
    );
  });
});
