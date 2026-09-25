import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

/**
 * Guards the "dedup a monte" contract (ISSUES.md, issue #5121).
 *
 * Monitors must open issues through `scripts/lib/github-issue-creator.mjs` with
 * a STABLE title. The helper dedups on the first 60 characters of the title: it
 * finds the canonical open issue and comments `🔁 Recurrence…` on it instead of
 * minting a new one. Six monitor sites bypassed that — they called `gh issue
 * create` directly AND interpolated a run date or a counter into the title, so
 * a condition that persisted week after week produced one new issue per run.
 *
 * That is not cosmetic backlog noise: every duplicate consumes a turn of the
 * serialized automatic fixer, stealing capacity from real issues.
 *
 * Two invariants, both mechanically checkable, both derived from the issue's
 * "Fatto quando":
 *   1. No workflow shell step calls `gh issue create` directly.
 *   2. Every title handed to the helper is constant across runs of the same
 *      condition — no date, timestamp, run number or counter inside the 60-char
 *      dedup window.
 */

const WORKFLOWS_DIR = path.resolve(__dirname, '..', '.github', 'workflows');

const DEDUP_TITLE_PREFIX_LEN = 60; // mirrors github-issue-creator.mjs

/**
 * Workflows allowed to keep a raw `gh issue create`, each for a reason that has
 * been checked against the actual code — NOT a blanket exemption.
 */
const RAW_CREATE_ALLOWED: Record<string, string> = {
  // Bespoke three-state machine: pending → confirmed → auto-closed. It already
  // dedups, by LABEL (`gh issue list --label traffic-stale{,-pending}` returns
  // early), and its promotion step REWRITES the issue title in place. The
  // helper dedups on title, so routing this through it would break the
  // promotion the moment the title changes. Different mechanism, same goal.
  'traffic-data-freshness.yml':
    'label-state machine (pending→confirmed) that rewrites the title on promotion; already deduped by label',
  // Same mechanism as the entry above, and verified against the CODE of the
  // `Report push-retry exhaustion` step (#6296), not against its intent:
  //  • it early-returns on BOTH labels before ever reaching `gh issue create`
  //    (`thin-promotions-push-exhausted` → comment + `exit 0`; `…-pending` →
  //    promote + `exit 0`), so at most one pending issue can be open and a
  //    second run cannot mint a duplicate;
  //  • promotion REWRITES the title in place (`[pending] … — 1st occurrence`
  //    → `… on consecutive runs`), which is exactly what routing through the
  //    helper would break: it dedups on the first 60 chars, so the rename
  //    would orphan the issue and the next run would open a fresh one — the
  //    very duplicate this guard exists to prevent;
  //  • the created title carries no date, timestamp or counter, so it stays
  //    stable across runs inside the dedup window.
  'refresh-thin-promotions.yml':
    'label-state machine (pending→confirmed→auto-close) that rewrites the title on promotion; deduped by label, with an early exit before create',
  // Same mechanism, verified against the same `Debounce push-retry-exhausted
  // alert` step shape (issue #6667 follow-up of #6648): early-returns on both
  // `publisher-jobs-push-exhausted{,-pending}` labels before reaching `gh
  // issue create`, promotion rewrites the title in place, and the created
  // title carries no date/timestamp/counter.
  'publisher-jobs-sync.yml':
    'label-state machine (pending→confirmed→auto-close) that rewrites the title on promotion; deduped by label, with an early exit before create',
  // Fourth instance of the same shape, verified against the CODE of the
  // `Report push-retry exhaustion` step, not against its intent:
  //  • it lists `discover-404s-cf-push-exhausted` first and, when an issue is
  //    open, comments + `exit 0`; then lists `…-pending` and, when one is
  //    open, promotes + `exit 0`. Both early-returns precede the only
  //    `gh issue create`, so a second run cannot mint a duplicate;
  //  • promotion REWRITES the title in place (`[pending] … — 1st occurrence`
  //    → `… on consecutive runs`), which routing through the helper would
  //    break: it dedups on the first 60 chars, so the rename would orphan the
  //    issue and the next run would open a fresh one;
  //  • the created title carries no date, timestamp or counter, so it stays
  //    stable across runs inside the dedup window.
  'discover-404s-via-cloudflare.yml':
    'label-state machine (pending→confirmed→auto-close) that rewrites the title on promotion; deduped by label, with an early exit before create',
};

function workflowFiles(): string[] {
  return fs
    .readdirSync(WORKFLOWS_DIR)
    .filter((f) => f.endsWith('.yml') || f.endsWith('.yaml'))
    .map((f) => path.join(WORKFLOWS_DIR, f));
}

/**
 * Lines that INVOKE `gh issue create` as a shell command. A workflow may quote
 * the command inside prose — an agent prompt, a comment explaining what was
 * replaced — and that is not an invocation. Requiring the trimmed line to START
 * with the command keeps prose out without an allowlist.
 */
function rawCreateInvocations(source: string): number[] {
  const hits: number[] = [];
  source.split('\n').forEach((line, i) => {
    if (/^gh issue create\b/.test(line.trim())) hits.push(i + 1);
  });
  return hits;
}

/**
 * Substitutions that are constant for a given workflow, so they cannot make a
 * title vary between two runs of the same condition.
 */
const STABLE_SUBSTITUTIONS = [/\$\{\{\s*github\.workflow\s*\}\}/g, /\$\{\{\s*github\.repository\s*\}\}/g];

/**
 * Per-ENTITY discriminants: values that identify WHICH thing is broken, not
 * WHEN it broke or HOW MANY. One issue per crawler / per gate / per shard is
 * the intended granularity — the same entity failing again must still land on
 * the same issue, which it does because the value is constant for that entity.
 *
 * This list is deliberately explicit and per-file. A regex cannot tell
 * `${slug}` (one issue per crawler, correct) from `${count}` (a new issue every
 * time the number moves, the bug), so adding an entry here has to be a decision
 * someone makes and a reviewer can see.
 */
const ENTITY_DISCRIMINANTS: Record<string, string[]> = {
  'cathedral-seo-gates-check.yml': ['${name}'], // one issue per regressed gate
  'crawler-health-monitor.yml': ['${slug}'], // one issue per crawler
  'deploy.yml': ['${{ matrix.locale }}'], // one issue per locale shard
  'rerender-article-corpus.yml': ['${{ matrix.section }}'], // one issue per section shard
  // Same granularity as rerender-article-corpus.yml directly above, and for
  // the same reason: `section` ranges over a CLOSED set of two values
  // (frontaliere, svizzera), so it says WHICH shard family is broken, never
  // when or how many. The same section failing again resolves to the same
  // 60-char prefix and lands on the same issue as a `🔁 Recurrence` comment —
  // which is the behaviour wanted here, because a hub re-render that keeps
  // failing for one section is one standing condition, not a new one per run.
  //
  // Spelled `$INPUT_SECTION` rather than `${{ matrix.section }}` because that
  // workflow hands the matrix value to the shell through `env:` instead of
  // interpolating it into the script text — the form
  // scripts/ci/check-workflow-input-injection.mjs requires, and a rule this
  // very workflow already tripped over once. Rewriting the title to
  // `${{ matrix.section }}` would satisfy this list by reopening that finding.
  // The env token is the correct shape; the allowlist is what has to know it.
  'rerender-article-hubs.yml': ['$INPUT_SECTION'], // one issue per section shard
  // One issue per social channel. `CH` ranges over a CLOSED set of three names
  // (instagram, tiktok, reddit) produced by
  // `scripts/check-social-publish-readiness.mjs --ready-channels`, so it says
  // WHICH channel became publishable — never when, never how many. The same
  // channel flipping ready again resolves to the same 60-char prefix and lands
  // on the existing issue as a `🔁 Recurrence` comment, which is what is wanted:
  // a channel that is unblocked and still not activated is one standing
  // condition, not a new one per morning.
  //
  // The discriminant is deliberately FIRST in the title ("$CH publishing is
  // unblocked — …"): the dedup window is 60 characters, and a title that opened
  // with the shared prose would collapse all three channels onto whichever
  // issue was minted first.
  //
  // Spelled `$CH` because the value is a shell loop variable over
  // `$READY_CHANNELS`, which the workflow hands to the step through `env:`
  // rather than interpolating `${{ }}` into the script text — the form
  // scripts/ci/check-workflow-input-injection.mjs requires.
  'social-publish-readiness-watch.yml': ['$CH'], // one issue per social channel
};

function stripStableSubstitutions(s: string, file: string): string {
  let out = s;
  for (const re of STABLE_SUBSTITUTIONS) out = out.replace(re, 'X');
  for (const token of ENTITY_DISCRIMINANTS[file] ?? []) out = out.split(token).join('X');
  return out;
}

/** Any shell/Actions interpolation left in the dedup window makes the title unstable. */
function unstableTokenIn(title: string, file: string): string | null {
  const window = stripStableSubstitutions(title, file).slice(0, DEDUP_TITLE_PREFIX_LEN);
  const m = window.match(/\$\([^)]*\)|\$\{\{[^}]*\}\}|\$\{[A-Za-z_][A-Za-z0-9_]*\}|\$[A-Za-z_][A-Za-z0-9_]*/);
  return m ? m[0] : null;
}

/** `--title "…"` arguments passed to the helper, literal or via a shell var. */
function helperTitleArgs(source: string): string[] {
  const out: string[] = [];
  const re = /github-issue-creator\.mjs[\s\S]{0,400}?--title\s+"([^"]*)"/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(source)) !== null) out.push(m[1]);
  return out;
}

/**
 * Titles handed to the diagnostic reporter action (`.github/actions/report-failure`,
 * issue #5437) as a `title:` input instead of a `--title` flag.
 *
 * Without this, adopting the action would silently move a workflow OUT of the
 * stability check above: the helper is still what opens the issue (the action
 * calls it), so the 60-char dedup rule still applies verbatim — only the syntax
 * carrying the title changed. A guard that follows one syntax and not the other
 * is the blind spot this repo has been bitten by before.
 */
function actionTitleArgs(source: string): string[] {
  const out: string[] = [];
  const re = /uses:\s*\.\/\.github\/actions\/report-failure[\s\S]{0,600}?^\s{2,}title:\s*(.+)$/gm;
  let m: RegExpExecArray | null;
  while ((m = re.exec(source)) !== null) {
    let v = m[1].trim();
    if ((v.startsWith("'") && v.endsWith("'")) || (v.startsWith('"') && v.endsWith('"'))) {
      v = v.slice(1, -1);
    }
    out.push(v);
  }
  return out;
}

/** Shell assignments `NAME="value"` (single line), collected per file. */
function shellAssignments(source: string): Map<string, string[]> {
  const map = new Map<string, string[]>();
  const re = /^\s*([A-Za-z_][A-Za-z0-9_]*)="([^"]*)"\s*$/gm;
  let m: RegExpExecArray | null;
  while ((m = re.exec(source)) !== null) {
    const list = map.get(m[1]) ?? [];
    list.push(m[2]);
    map.set(m[1], list);
  }
  return map;
}

/** Resolve `$VAR` / `${VAR}` title args to every literal assigned to that name. */
function resolveTitles(source: string): string[] {
  const assignments = shellAssignments(source);
  const resolved: string[] = [];
  for (const arg of [...helperTitleArgs(source), ...actionTitleArgs(source)]) {
    const varOnly = arg.match(/^\$\{?([A-Za-z_][A-Za-z0-9_]*)\}?$/);
    if (varOnly) {
      const values = assignments.get(varOnly[1]);
      // Unresolvable (assigned from a command substitution or another step's
      // output) — nothing to assert, and asserting on the raw `$VAR` would be
      // a false positive.
      if (values) resolved.push(...values);
      continue;
    }
    resolved.push(arg);
  }
  return resolved;
}

/* ── Script-side callers ────────────────────────────────────────────────── */

const SCRIPTS_DIR = path.resolve(__dirname, '..', 'scripts');

/**
 * Per-ENTITY / per-PERIOD discriminants on the script side, same rule and same
 * explicitness as ENTITY_DISCRIMINANTS above.
 */
const SCRIPT_TITLE_DISCRIMINANTS: Record<string, string[]> = {
  // One issue per template family — the family IS the thing that regressed.
  'monitor-seo-ctr-by-template.mjs': ['${family.label}'],
  // Per-MONTH on purpose: the HERE free tier RESETS monthly, so August's
  // overrun and September's are genuinely different conditions with different
  // remediation windows — not one standing condition re-reported.
  'reconcile-here-usage.mjs': ['${monthKey}'],
};

function scriptFiles(dir: string, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules') continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) scriptFiles(full, out);
    else if (/\.(mjs|ts|js)$/.test(entry.name)) out.push(full);
  }
  return out;
}

/** `title: \`…\`` / `title: '…'` literals inside a createGithubIssue call. */
function scriptTitleLiterals(source: string): string[] {
  const out: string[] = [];
  // The window is generous because a call site may carry a several-line
  // comment between `create({` and `title:`. Only literals are matched — a
  // title produced by a helper function (harvest-agent-lessons' escalationTitle)
  // is out of reach of a text scan and is not claimed to be covered here.
  const re = /create\s*\(\s*\{[\s\S]{0,900}?title:\s*(`[^`]*`|'[^']*'|"[^"]*")/g;
  const re2 = /createGithubIssue\s*\(\s*\{[\s\S]{0,900}?title:\s*(`[^`]*`|'[^']*'|"[^"]*")/g;
  for (const r of [re, re2]) {
    let m: RegExpExecArray | null;
    while ((m = r.exec(source)) !== null) out.push(m[1].slice(1, -1));
  }
  return out;
}

describe('monitor issues are deduped at the source (#5121)', () => {
  it('no workflow shell step calls `gh issue create` directly', () => {
    const offenders: string[] = [];
    for (const file of workflowFiles()) {
      const base = path.basename(file);
      if (base in RAW_CREATE_ALLOWED) continue;
      const lines = rawCreateInvocations(fs.readFileSync(file, 'utf-8'));
      for (const line of lines) offenders.push(`${base}:${line}`);
    }
    // A raw create has no dedup: the same condition opens a new issue on every
    // run. Route it through scripts/lib/github-issue-creator.mjs, or add it to
    // RAW_CREATE_ALLOWED with a reason that has been verified against the code.
    expect(offenders).toEqual([]);
  });

  it('every allowlisted exception still carries a written reason', () => {
    for (const [file, reason] of Object.entries(RAW_CREATE_ALLOWED)) {
      expect(fs.existsSync(path.join(WORKFLOWS_DIR, file))).toBe(true);
      expect(reason.length).toBeGreaterThan(20);
    }
  });

  it('no title passed to the dedup helper varies between runs', () => {
    const offenders: string[] = [];
    for (const file of workflowFiles()) {
      const source = fs.readFileSync(file, 'utf-8');
      const base = path.basename(file);
      for (const title of resolveTitles(source)) {
        const token = unstableTokenIn(title, base);
        if (token) offenders.push(`${base}: "${title}" — unstable token ${token}`);
      }
    }
    // A varying date/score/counter inside the first 60 chars defeats the
    // helper's dedup exactly as a raw `gh issue create` would: the values
    // belong in the BODY, which is where the metric's history is read.
    expect(offenders).toEqual([]);
  });

  it('no title built by a monitor SCRIPT varies between runs', () => {
    const offenders: string[] = [];
    for (const file of scriptFiles(SCRIPTS_DIR)) {
      const rel = path.relative(SCRIPTS_DIR, file);
      if (rel === path.join('lib', 'github-issue-creator.mjs')) continue;
      const source = fs.readFileSync(file, 'utf-8');
      if (!source.includes('github-issue-creator')) continue;
      for (const title of scriptTitleLiterals(source)) {
        let stripped = title;
        for (const token of SCRIPT_TITLE_DISCRIMINANTS[rel] ?? []) stripped = stripped.split(token).join('X');
        const token = stripped.slice(0, DEDUP_TITLE_PREFIX_LEN).match(/\$\{[^}]*\}/);
        if (token) offenders.push(`${rel}: "${title}" — unstable token ${token[0]}`);
      }
    }
    // Same rule as the workflow side: a value that changes when the SAME
    // condition is re-reported defeats the dedup and mints a duplicate.
    expect(offenders).toEqual([]);
  });

  it('the migrated monitors invoke the helper', () => {
    const migrated = [
      'ai-visibility-check.yml',
      'gsc-frontaliere-monitor.yml',
      'sitemap-shard-size-monitor.yml',
      'cathedral-seo-gates-check.yml',
      'crawler-health-monitor.yml',
      'guard-data-integrity.yml',
      'probe-bazg.yml',
    ];
    for (const base of migrated) {
      const source = fs.readFileSync(path.join(WORKFLOWS_DIR, base), 'utf-8');
      expect(source.includes('scripts/lib/github-issue-creator.mjs')).toBe(true);
    }
  });
});
