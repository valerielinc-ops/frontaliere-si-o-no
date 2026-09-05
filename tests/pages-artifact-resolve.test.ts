import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Guardrail for the #7392–#7397 class of bug.
 *
 * Resolving the `github-pages` artifact of a deploy run — list the successful
 * deploy.yml runs, order them, skip the ones whose artifact expired, download
 * the zip, retry on a 410 — used to be copy-pasted into eight workflows. The
 * copies drifted, and every one of the six issues in that cluster is a place
 * where ONE copy was missing something the others had:
 *
 *   #7392 `select(.name=="github-pages")` without `and .expired==false`
 *   #7393 `for cand in $(gh api …)` — a failing command substitution in a
 *         for-LIST is invisible to `set -e`, so an API error read as an
 *         empty candidate list and the step marched on
 *   #7394 the walk-back trusted the REST response order instead of sorting
 *         on `created_at` client-side
 *   #7395 a fixed `per_page` window with no pagination and no declared cap
 *   #7396 a 410 between resolve and download killed the job instead of
 *         re-entering the walk-back
 *   #7397 no `created_at` anywhere in the log, so a wrong pick left nothing
 *         to diagnose it with
 *
 * The fix was structural: `.github/actions/fetch-pages-artifact/action.yml`
 * is now the ONLY implementation, and callers pass a run id (or nothing, to
 * get the walk-back). These assertions fail when a second implementation
 * reappears — which is the only way the drift can come back.
 */

const WORKFLOWS_DIR = '.github/workflows';
const ACTION_PATH = '.github/actions/fetch-pages-artifact/action.yml';

const workflowFiles = readdirSync(WORKFLOWS_DIR)
  .filter((f) => f.endsWith('.yml') || f.endsWith('.yaml'))
  .map((f) => join(WORKFLOWS_DIR, f));

const actionSource = readFileSync(ACTION_PATH, 'utf8');

/**
 * Source with whole-line YAML/shell comments removed. The comments in these
 * files QUOTE the very anti-patterns below to explain what they replaced;
 * matching on them would make every check self-fulfilling.
 */
function codeOnly(file: string): string {
  return readFileSync(file, 'utf8').replace(/^[ \t]*#.*$/gm, '');
}

/** Every `.github` file that could hold a shell copy of the resolve. */
function allGithubShellFiles(): string[] {
  const out = [...workflowFiles];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, entry.name);
      if (entry.isDirectory()) walk(p);
      else if (p.endsWith('.yml') || p.endsWith('.yaml')) out.push(p);
    }
  };
  walk('.github/actions');
  return out;
}

describe('github-pages artifact resolve has exactly one implementation', () => {
  it('#7392 — no call-site selects the artifact without `.expired==false`', () => {
    // An expired artifact stays LISTED by the REST API for a while. Without
    // the filter it gets picked, the walk-back stops, and the failure lands on
    // the download as a 410 wearing the wrong diagnosis ("no artifact").
    const offenders = allGithubShellFiles().filter((f) =>
      /select\(\s*\.name\s*==\s*"github-pages"\s*\)/.test(codeOnly(f)),
    );
    expect(offenders).toEqual([]);
  });

  it('#7393 — no loop iterates a `gh api` command substitution directly', () => {
    // `for x in $(gh api …)`: under `set -euo pipefail` the substitution's
    // exit code is discarded in a for-list, so a network error becomes an
    // empty list and a silently skipped loop body.
    const offenders = allGithubShellFiles().filter((f) =>
      /for\s+[A-Za-z_][A-Za-z0-9_]*\s+in\s+\$\(\s*gh\s+api/.test(codeOnly(f)),
    );
    expect(offenders).toEqual([]);
  });

  it('#7394 — every walk-back orders candidates on created_at client-side', () => {
    // The two files that still list deploy runs themselves. The REST endpoint
    // does not contract `created_at desc`; the old code relied on having
    // observed it.
    for (const f of [ACTION_PATH, join(WORKFLOWS_DIR, 'measure-deploy-delta.yml')]) {
      expect(readFileSync(f, 'utf8'), f).toContain('sort_by(.created_at)');
    }
  });

  it('#7395 — the walk-back paginates under a named, explicit cap', () => {
    for (const f of [ACTION_PATH, join(WORKFLOWS_DIR, 'measure-deploy-delta.yml')]) {
      const src = readFileSync(f, 'utf8');
      expect(src, f).toMatch(/MAX_PAGES=\d+/);
      expect(src, f).toMatch(/PER_PAGE=\d+/);
      expect(src, f).toContain('&page=$page');
    }
    // …and says which of the two ways it ran out, because "cap reached" and
    // "nothing ever succeeded" want opposite remedies.
    expect(actionSource).toContain('Walk-back cap reached');
  });

  it('#7396 — an EXPIRY during download re-enters the walk-back, nothing else does', () => {
    // The resolve and the download are separated by real time. An artifact at
    // the edge of its 8-day retention can die in between.
    expect(actionSource).toMatch(/HTTP 410/);
    expect(actionSource).toMatch(/410 Gone\)\s*—\s*trying older/);
    // The single grep that buys a walk-back, asserted on its own terms.
    const walkBackGrep = /^\s*if grep .*dl\.err.*$/m.exec(actionSource)?.[0] ?? '';
    expect(walkBackGrep).toContain('410');
    // 404 must NOT be in it: on this endpoint GitHub answers 404 for a
    // resource the token may not read, so accepting it would turn a missing
    // `actions: read` on any caller into a silent audit of an older deploy.
    expect(walkBackGrep).not.toContain('404');
    // …and it must match gh's status line, not the substring anywhere in
    // stderr, or an error body that merely contains "410" buys a walk-back.
    expect(walkBackGrep).toContain('[[:space:]]*$');
    // …and any non-expiry failure must exit, not continue. Anchored on the
    // branch's structure — the first control-flow keyword after the error —
    // so that rewording the message cannot flip this assertion.
    const nonExpiry = actionSource.slice(actionSource.indexOf('is NOT an expiry'));
    expect(/\n\s*(continue|exit)\b/.exec(nonExpiry)?.[1]).toBe('exit');
  });

  it('#7397 — the chosen run is logged with its created_at', () => {
    expect(actionSource).toContain('created_at');
    expect(actionSource).toMatch(/Using deploy run \$cand \(created_at \$created/);
    // The four seed workflows must not resolve a run themselves any more:
    // `gh run list --limit=1 --json databaseId` gave no branch filter, no
    // expiry check and no timestamp to reason about afterwards.
    for (const f of workflowFiles.filter((p) => p.includes('seed-'))) {
      expect(codeOnly(f), f).not.toMatch(/gh run list/);
    }
  });

  it('downloading the artifact zip happens only inside the composite action', () => {
    const offenders = allGithubShellFiles().filter((f) => {
      if (f === ACTION_PATH) return false;
      // restore-from-artifact.yml re-uploads the raw zip instead of extracting
      // artifact.tar, so it is a different contract — see the PR body.
      if (f.endsWith('restore-from-artifact.yml')) return false;
      return /actions\/artifacts\/\S*\/zip/.test(codeOnly(f));
    });
    expect(offenders).toEqual([]);
  });

  it('#7502 — every run-artifact listing filters on the name server-side, paginated', () => {
    // `runs/<id>/artifacts` answers with `per_page=30` by default and
    // deploy.yml uploads 22 artifacts, some of them inside a 4-locale matrix.
    // A client-side `select(.name=="github-pages")` over a truncated page is
    // indistinguishable from a run that has no artifact at all, so the
    // walk-back rejects every candidate and dies claiming no deploy has one.
    // `?name=github-pages&per_page=100` makes the response un-truncatable.
    const offenders: string[] = [];
    for (const f of allGithubShellFiles()) {
      // measure-deploy-delta.yml carries the same listing and is exempt only
      // because PR #7573 is rewriting those exact lines — see the
      // `## Non implementato (ancora)` of the #7502 PR. Delete this line with
      // the fix; the follow-up that lands it is what re-arms this assertion.
      if (f.endsWith('measure-deploy-delta.yml')) continue;
      for (const m of codeOnly(f).matchAll(/actions\/runs\/[^\s"']*\/artifacts([^\s"']*)/g)) {
        const query = m[1];
        if (!/[?&]per_page=\d+/.test(query) || !/[?&]name=github-pages/.test(query)) {
          offenders.push(`${f}: ${m[0]}`);
        }
      }
    }
    expect(offenders).toEqual([]);
    // …and the name filter left the jq, which now only has to drop expired
    // artifacts (#7392) — a filter no query parameter replaces.
    expect(actionSource).toMatch(/--jq '\.artifacts\[\] \| select\(\.expired==false\)/);
  });

  it('every caller of the action reaches it through a checkout', () => {
    // A LOCAL composite action must exist on disk. A job that calls
    // `./.github/actions/...` without checking the repo out dies at step
    // start with a bare "Can't find action.yml", which is the same
    // unreadable failure mode as a YAML syntax error.
    const callers = workflowFiles.filter((f) =>
      readFileSync(f, 'utf8').includes('uses: ./.github/actions/fetch-pages-artifact'),
    );
    expect(callers.length).toBeGreaterThanOrEqual(7);
    for (const f of callers) {
      const src = readFileSync(f, 'utf8');
      const checkoutAt = src.indexOf('actions/checkout@');
      const usesAt = src.indexOf('uses: ./.github/actions/fetch-pages-artifact');
      expect(checkoutAt, `${f}: no checkout step`).toBeGreaterThan(-1);
      expect(checkoutAt, `${f}: checkout must precede the action`).toBeLessThan(usesAt);
      // A sparse checkout must actually include the action directory — in
      // BOTH YAML spellings. The block-scalar-only form of this regex skipped
      // inspect-dist-composition.yml, whose `sparse-checkout: <path>` is the
      // inline scalar, i.e. it skipped the one checkout this work added and
      // the only one narrow enough to plausibly lose the action.
      // Anchored at line start: the inline-scalar branch would otherwise match
      // the string inside a prose comment (recover-prev-slugs.yml and
      // audit-missing-company-logos.yml already contain one), and `.exec`
      // takes the FIRST match in the file.
      const sparse = /^[ \t]*sparse-checkout:[ \t]*(\|[\s\S]*?\n\s{0,10}[a-z-]+:|[^\n]+)/m.exec(src);
      if (sparse && !sparse[1].includes('/*')) {
        expect(sparse[1], `${f}: sparse checkout omits the action`).toContain(
          '.github/actions/fetch-pages-artifact',
        );
      }
    }
  });
});
