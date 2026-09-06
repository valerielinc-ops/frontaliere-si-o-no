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

  it('#7501 — no artifact listing turns a gh failure into a zero count', () => {
    // `has=$(gh api …/artifacts --jq '…|length' 2>/dev/null || echo 0)` reads
    // an API/token failure as "this run has no artifact": the candidate is
    // dropped in silence and the A/B pair slides onto two older deploys, so
    // the delta is plausible but between the wrong two runs. Every listing
    // must let the exit code out and treat a non-zero one as fatal.
    const offenders: string[] = [];
    for (const f of allGithubShellFiles()) {
      const src = codeOnly(f);
      // The listing line plus the three that can still close its command
      // substitution — a lazy `[\s\S]*?\n` would stop at the first newline
      // and never see the fallback, which is always on a continuation line.
      const re = /gh\s+api\s+"[^"]*\/artifacts"[^\n]*(?:\n[^\n]*){0,3}/g;
      for (const m of src.matchAll(re)) {
        if (/2>\/dev\/null|\|\|\s*echo\b/.test(m[0])) offenders.push(`${f}: ${m[0].trim()}`);
      }
    }
    expect(offenders).toEqual([]);
    // …and the two files that list artifacts themselves say so out loud.
    for (const f of [ACTION_PATH, join(WORKFLOWS_DIR, 'measure-deploy-delta.yml')]) {
      const src = codeOnly(f);
      expect(src, f).toMatch(/gh api failed while listing artifacts/);
      // The branch that reports it must EXIT, not continue onto an older run.
      const after = src.slice(src.indexOf('gh api failed while listing artifacts'));
      expect(/\n\s*(continue|exit)\b/.exec(after)?.[1], f).toBe('exit');
    }
  });

  it('#7505 — a while-read fed by a file never shares its stdin with the body', () => {
    // `while read … done < "$CANDS"` makes the candidate FILE the loop's stdin,
    // and every external command in the body inherits it. Whatever one of them
    // reads is a line the next `read` never sees: the walk-back stops early and
    // reports "no successful deploy.yml run … still has a 'github-pages'
    // artifact" — a wrong diagnosis that reads exactly like the right one. It
    // does not depend on what `gh`/`unzip`/`node` do today: none of them
    // contracts that it leaves stdin alone. A dedicated fd removes the question.
    //   printf 'a\nb\nc\n' > f; while read -r x; do cat >/dev/null; done < f
    //   → 1 iteration; the same loop on `read -u 9` … `done 9< f` → 3.
    // Only loops whose body actually runs a command that CAN consume stdin are
    // offenders: `cat "$log"`, `cp`, `mkdir` take their input from arguments and
    // are safe by construction.
    // `m`: without it `^` only matches the start of the whole body, so a
    // consumer on a line of its own — `gh issue close "$num"`, preceded by
    // nothing but a newline and its indent, which is the commonest shape of
    // all — never matched and three of the six sites here were invisible.
    const CONSUMERS =
      /(^|[;&|(]|\bthen\b|\bdo\b|\belse\b)[ \t]*(gh|unzip|node|npx|ssh|curl|xargs|git)\b/m;
    // `while …` line, body, and a `done` at the SAME indentation whose redirect
    // is a plain file (`< "$f"`), not a process substitution (`< <(…)`, which is
    // matched by the negative lookahead and left alone — it has the same defect
    // but the fix there is the same fd, and none of the current ones qualify).
    // The lookahead has to sit right after the redirect operator and swallow
    // the spacing ITSELF: `<[ \t]*(?!\()` lets the engine backtrack `[ \t]*`
    // to zero and pass the lookahead on the space, so `done < <(…)` matched
    // anyway. And the character to refuse is the `<` of the substitution, not
    // the `(` — after the redirect operator of `done < <(…)` comes `<`.
    const LOOP =
      /^([ \t]*)while\b[^\n]*\bread\b[^\n]*\n([\s\S]*?)^\1done[ \t]+(\d*)<(?![ \t]*<?\()[^\n]*$/gm;
    const offenders: string[] = [];
    for (const f of allGithubShellFiles()) {
      const src = codeOnly(f);
      for (const m of src.matchAll(LOOP)) {
        const [, , body, fd] = m;
        if (!CONSUMERS.test(body)) continue;
        const head = m[0].slice(0, m[0].indexOf('\n'));
        if (!fd || !new RegExp(`read\\b[^\\n]*-u[ \\t]+${fd}\\b`).test(head)) {
          offenders.push(`${f}: ${head.trim()} … done ${fd}<`);
        }
      }
    }
    expect(offenders).toEqual([]);
    // And the walk-back itself, positively — the regex above only proves the
    // absence of the shape, not that this loop is still the one being read.
    expect(codeOnly(ACTION_PATH)).toMatch(/while IFS=\$'\\t' read -r -u 9 cand created sha; do/);
    expect(codeOnly(ACTION_PATH)).toMatch(/done 9< "\$CANDS"/);
  });

  it('#7504 — every deploy-run page is shape-checked before it is counted', () => {
    // A 2xx body is not necessarily a runs collection: the secondary-rate-limit
    // guard answers HTTP 200 with an object carrying `message`, and a truncated
    // response is not JSON at all. `jq '.workflow_runs | length'` then prints
    // `null`, and `[ null -lt 50 ]` exits 2 — invisible to `set -e` as the FIRST
    // member of an `&&` list, so the loop kept paginating and the failure
    // surfaced downstream as a raw jq error instead of the ::error:: built for
    // it. Same class as #7393, through a different door.
    const offenders: string[] = [];
    for (const f of allGithubShellFiles()) {
      const src = codeOnly(f);
      if (!/\.workflow_runs\s*\|\s*length/.test(src)) continue;
      // The shape check has to come BEFORE the count, on the same file.
      const guard = src.search(/has\("workflow_runs"\)/);
      const count = src.search(/\.workflow_runs\s*\|\s*length/);
      if (guard < 0 || guard > count) offenders.push(f);
    }
    expect(offenders).toEqual([]);
    // …and both files that page deploy runs say which failure it is.
    for (const f of [ACTION_PATH, join(WORKFLOWS_DIR, 'measure-deploy-delta.yml')]) {
      const src = codeOnly(f);
      expect(src, f).toMatch(/2xx body without a \.workflow_runs array/);
      const after = src.slice(src.indexOf('2xx body without a .workflow_runs array'));
      expect(/\n\s*(continue|exit)\b/.exec(after)?.[1], f).toBe('exit');
    }
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

  it('#7503 — a unzip WARNING (exit 1) does not discard a valid artifact', () => {
    // `unzip` exits 1 when it extracted everything but had a warning to
    // report (extra bytes before the central directory, an odd attribute),
    // and reserves >= 2 for the real errors. Testing `-ne 0` walked back onto
    // an OLDER deploy for a benign warning — the same silent-wrong-answer
    // class the download branch is deliberately fatal about.
    const code = codeOnly(ACTION_PATH);
    expect(code).not.toMatch(/\[\s*"\$uzrc"\s+-ne\s+0\s*\]/);
    expect(code).toMatch(/\[\s*"\$uzrc"\s+-eq\s+1\s*\]/);
    expect(code).toMatch(/\[\s*"\$uzrc"\s+-ge\s+2\s*\]/);
    // Only the >= 2 branch may walk back, and the artifact.tar contract check
    // must survive as the thing that catches a warning that DID lose the file.
    const warnBranch = code.slice(code.indexOf('-eq 1'), code.indexOf('-ge 2'));
    expect(warnBranch).not.toMatch(/\n\s*continue\b/);
    expect(code).toMatch(/if \[ ! -f "\$OUTDIR\/artifact\.tar" \]/);
  });

  it('#7503 — no shell gates an extraction on `unzip` exiting 0', () => {
    // Every call must capture the exit code (`|| uzrc=$?`, `|| true`) and
    // decide on it, or on the extracted file. A bare call under `set -e`, and
    // one chained with `&&` into the success path, both read a warning as a
    // failed extraction.
    const files = [
      ...allGithubShellFiles(),
      'scripts/lib/deploy-it-pages-prep.sh',
      'scripts/lib/upload-cdn-file.sh',
    ];
    const offenders: string[] = [];
    for (const f of files) {
      for (const line of codeOnly(f).split('\n')) {
        // Command position only (line start, `&&`, `||`, `;`, subshell) —
        // the word also appears inside log messages. `unzip -p`/`-Z` only
        // read the archive; they extract nothing.
        if (!/(?:^|&&|\|\||;|\()\s*unzip\s+-(?![pZ]\b)/.test(line)) continue;
        if (!line.includes('||')) offenders.push(`${f}: ${line.trim()}`);
      }
    }
    expect(offenders).toEqual([]);
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
