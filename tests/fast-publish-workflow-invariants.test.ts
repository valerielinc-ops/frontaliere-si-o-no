// Invariants of the fast-publish path (#4837) that are NOT observable from a
// green CI run.
//
// Every defect pinned here was live at some point and shipped green: the
// pipeline is deliberately fault-tolerant (per-locale `|| fail=1`,
// `continue-on-error`, best-effort scripts that exit 0), so a broken fast path
// degrades to "the article just goes live via the slow deploy instead" and
// nothing turns red. These assertions are the only thing standing between a
// well-meaning edit and a silently inert feature.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const read = (p: string) => readFileSync(resolve(p), 'utf8');

describe('fast-publish workflow invariants', () => {
  const workflow = read('.github/workflows/fast-publish-article.yml');

  it('serializes per article, not per section', () => {
    // A per-section group cannot keep batched dispatches: GitHub holds exactly
    // ONE pending run per group, so a third queued run cancels the pending one.
    // publish-journalist-articles.yml (one dispatch per published id) and
    // reconcile-fast-publish-articles.mjs (one per backlogged article) would
    // both silently lose their middle articles.
    const group = /concurrency:\s*\n\s*group:\s*(.+)/.exec(workflow)?.[1] ?? '';
    expect(group).toContain('inputs.article_id');
  });

  it('never installs dependencies on the critical path', () => {
    // The whole point is skipping the full build; `npm ci` would add ~1-2 min
    // to a path whose entire render takes under a second.
    expect(workflow).not.toMatch(/^\s*run:\s*npm ci\b/m);
  });

  it('pings search engines only after live verification, never before', () => {
    const notifyIdx = workflow.indexOf('Notify search engines');
    const verifyIdx = workflow.indexOf('Verify shard URLs are live');
    expect(verifyIdx).toBeGreaterThan(-1);
    expect(notifyIdx).toBeGreaterThan(verifyIdx);
    // and it must be gated on that step's outcome, not merely ordered after it
    const notifyBlock = workflow.slice(notifyIdx, notifyIdx + 400);
    expect(notifyBlock).toMatch(/steps\.verify\.outcome\s*==\s*'success'/);
  });
});

describe('push-article-shard-incremental.sh invariants', () => {
  const raw = read('scripts/lib/push-article-shard-incremental.sh');
  // Strip comment lines: this file documents at length WHY it never
  // force-pushes and what commit-tree needs, so matching the raw text finds the
  // prose instead of the code.
  const script = raw
    .split('\n')
    .filter((line) => !/^\s*#/.test(line))
    .join('\n');

  it('configures a git identity before commit-tree', () => {
    // An Actions runner has no default identity, so `git commit-tree` dies with
    // "Author identity unknown" — on every retry, for every locale, every run.
    // Local runs hide this because developer machines have a global identity.
    const identityIdx = Math.max(
      script.indexOf('config user.email'),
      script.indexOf('config user.name'),
    );
    const commitTreeIdx = script.indexOf('commit-tree');
    expect(identityIdx).toBeGreaterThan(-1);
    expect(commitTreeIdx).toBeGreaterThan(identityIdx);
  });

  it('uses write-tree --missing-ok so a partial clone stays partial', () => {
    // Plain `write-tree` eagerly fetches a blob for EVERY index entry, which on
    // an 86 MB shard means re-downloading the whole repo per article and
    // defeats the --filter=blob:none clone.
    expect(script).toMatch(/write-tree\s+--missing-ok/);
  });

  it('never force-pushes', () => {
    // Merge-only by construction: the commit is built on the remote tip, so a
    // loser must re-clone and rebuild rather than clobber a concurrent writer.
    expect(script).not.toMatch(/push\s+(-f|--force)\b/);
  });
});

describe('wait-for-live-article-shards.mjs invariants', () => {
  const script = read('scripts/wait-for-live-article-shards.mjs');

  it('sends a User-Agent on the content fetch', () => {
    // undici's fetch sends none, and the zone firewall answers an empty UA with
    // 403 plus a challenge page — measured: plain fetch -> 403/5730B, same URL
    // with a UA -> 200/23505B. Without this the content check can never match
    // and every publish burns its full timeout reporting failure.
    expect(script).toContain('DEFAULT_LIVE_CHECK_USER_AGENT');
  });

  it('verifies served content, not just HTTP status', () => {
    // A re-published article answers 200 from the old bytes for ~40s while the
    // push propagates; status-only would green-light the search-engine ping on
    // stale content. Observed live: 42s to converge, 200 throughout.
    expect(script).toMatch(/createHash\(['"]sha256['"]\)/);
  });
});

describe('producer wiring stays connected', () => {
  // Removing a dispatch step breaks nothing loudly: the article simply falls
  // back to the 30min-2h deploy and the fast path quietly stops applying to
  // that producer. Same silent-inert class as everything else in this file.
  const producers = [
    '.github/workflows/generate-article.yml',
    '.github/workflows/publish-journalist-articles.yml',
  ];

  for (const producer of producers) {
    it(`${producer} dispatches fast-publish-article.yml`, () => {
      const yml = read(producer);
      expect(yml).toContain('fast-publish-article.yml');
      // Must go through the shared dispatch engine, which is what waits for the
      // pushed SHA to be visible on main before firing.
      expect(yml).toMatch(/trigger-workflow\.sh"?\s+"fast-publish-article\.yml"/);
    });
  }

  it('the reconciler re-dispatches articles the deploy raced past', () => {
    const yml = read('.github/workflows/fast-publish-reconcile.yml');
    // Must key off the deploy build SHA, otherwise it cannot tell which
    // articles the completed build predates.
    expect(yml).toContain('workflow_run.head_sha');
    expect(yml).toContain('reconcile-fast-publish-articles.mjs');
    // It runs without npm ci, so Remote Config must be reachable without
    // firebase-admin or it silently loads no GITHUB_PAT and dispatches nothing.
    expect(yml).not.toMatch(/^\s*run:\s*npm ci\b/m);
    expect(read('scripts/load-rc-env.mjs')).toContain('fetchTemplateViaRest');
  });
});

// A shard push that landed but is not being served yet is NOT an incident, and
// telling the two apart is the whole point of exit code 2. On 2026-08-06 (run
// 31093424415) four URLs timed out during a GitHub Pages `major_outage`, the
// run failed, a priority:high issue was opened — and all four were serving
// correctly when checked afterwards. A false alarm there is not free: it feeds
// the issue-fix loop and burns the shared Claude quota this repo guards.
//
// The trap in "just don't fail on it" is that a step exiting 0 reports
// `outcome == 'success'`, which would let the search-engine ping fire at bytes
// that are not being served — precisely what the verification exists to stop.
// So `delayed` must gate every side-effect too, and these pin both halves.
describe('fast-publish: a delayed publish is not a failure, and not a success either', () => {
  const workflow = read('.github/workflows/fast-publish-article.yml');
  const probe = read('scripts/wait-for-live-article-shards.mjs');

  it('the probe separates "not reachable" from "reachable but stale"', () => {
    expect(probe).toMatch(/process\.exit\(2\)/);
    // Exit 1 must stay reserved for the case where the push did not land.
    const oneIdx = probe.lastIndexOf('process.exit(1)');
    expect(probe.slice(Math.max(0, oneIdx - 600), oneIdx)).toMatch(/NOT REACHABLE|absent/);
  });

  // The two halves of the fix for #5250. They live in different files and
  // nothing links them at runtime: rename either side and the probe silently
  // falls back to "every 404 is a lost push", which is the pre-fix behaviour
  // that failed a run and opened a priority:high issue for an article that was
  // serving correctly minutes later. Exactly the silent-inert class this file
  // exists for — the exit codes themselves are covered behaviourally in
  // tests/wait-for-live-article-shards.test.ts.
  const CONFIRMED_PUSH_ENV = 'FAST_PUBLISH_PUSHED_LOCALES';

  it('the shard-push step publishes which locales actually landed', () => {
    // Only this step can observe the git push result; the probe only ever sees
    // the public URL. Must reach the probe's process, i.e. GITHUB_ENV.
    const pushIdx = workflow.indexOf('Push locale shards');
    const verifyIdx = workflow.indexOf('Verify shard URLs are live');
    const pushBlock = workflow.slice(pushIdx, verifyIdx);
    expect(pushBlock).toContain(`${CONFIRMED_PUSH_ENV}=`);
    expect(pushBlock).toContain('GITHUB_ENV');
  });

  it('the probe classifies from that confirmation, not from reachability alone', () => {
    expect(probe).toContain(CONFIRMED_PUSH_ENV);
    // A first publish 404s for the whole propagation window BECAUSE the push
    // landed, so an unreachable URL may only be condemned once its push is
    // known not to be confirmed.
    expect(probe).toMatch(/absent\s*=\s*unreachable\.filter\(\(url\) => !pushConfirmed\(url\)\)/);
  });

  it('documents exit 2, so a caller cannot mistake it for success', () => {
    expect(probe).toMatch(/\*\s+2 =/);
  });

  it('treats exit 2 as non-fatal in the workflow', () => {
    expect(workflow).toMatch(/delayed=true/);
  });

  it('still refuses to ping search engines while the bytes are stale', () => {
    // The gate is what stops "not fatal" from silently becoming "as good as
    // live". Every side-effecting step must carry it, not just the ping.
    const gated = workflow.match(/steps\.verify\.outputs\.delayed != 'true'/g) ?? [];
    expect(gated.length).toBeGreaterThanOrEqual(3);
    const notify = workflow.slice(workflow.indexOf('Notify search engines') - 400,
                                  workflow.indexOf('Notify search engines') + 200);
    expect(notify).toContain("steps.verify.outputs.delayed != 'true'");
  });
});
