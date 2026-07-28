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
