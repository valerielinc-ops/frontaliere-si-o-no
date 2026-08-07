import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';
import { checkPrBodySections } from '../../scripts/lib/pr-body-sections-check.mjs';
import { checkClosesLines } from '../../scripts/lib/pr-body-closes-check.mjs';

/**
 * The code half of the two-repo cycle must have a transport, and that transport
 * must be incapable of touching the corpus (issue #4974).
 *
 * CLAUDE.md: "il codice scende dal sito al corpus, i dati risalgono dal corpus
 * al sito". After the 2026-08-02 cutover only the data direction still worked.
 * The code direction's single carrier, mirror-articles-corpus.yml, was disabled
 * because it does `rm -rf content && cp -R packages/articles/content` and nanako
 * now GENERATES the corpus — an automatic run would delete every article this
 * repo has never seen. Correct, and it left the engine with no way down.
 *
 * Nothing noticed for three days. Three engine PRs merged here on 2026-08-05
 * (#5101 hero intrinsic dimensions, #5107 topical related articles, and the
 * ARTICLE_FOOTER_ROOT portal target) never reached nanako, which is what renders
 * article pages now. Every article published in between shipped from the pre-fix
 * engine: `<main class="seo-static-content">` present, `<div id="footer-root">`
 * absent — measured on production, and the reason audit:footer-root-presence
 * went from 23 offenders to 3608.
 *
 * mirror-articles-engine.yml restores the direction by carrying `engine/` alone.
 * That split is the entire safety argument, so it is the thing tested here: the
 * old mirror's destructive behaviour was all about `content/`, and an
 * engine-only mirror that cannot name `content/` is safe to fire on `push` —
 * which is what makes it automatic, which is what makes the drift stop being
 * invisible.
 *
 * These assertions are about the workflow's SHAPE, not its prose. Each one
 * fails if the corresponding safety property is removed.
 */

const ROOT = path.resolve(__dirname, '..', '..');
const WF_DIR = path.join(ROOT, '.github', 'workflows');
const ENGINE_MIRROR = 'mirror-articles-engine.yml';

const src = fs.readFileSync(path.join(WF_DIR, ENGINE_MIRROR), 'utf-8');
const doc = YAML.parse(src) as Record<string, any>;

/** Comments explain the disabled/rejected shapes on purpose — ignore them. */
function withoutComments(text: string): string {
  return text
    .split('\n')
    .filter((l) => !/^\s*#/.test(l))
    .join('\n');
}
const live = withoutComments(src);

/** `on:` survives YAML 1.1's boolean coercion as `true` in some parsers. */
const on = (doc.on ?? doc[true as unknown as string]) as Record<string, any>;

describe('the articles engine has an automatic transport to the corpus (#4974)', () => {
  it('fires on pushes that change the engine — it is not dispatch-only', () => {
    expect(on, 'no `on:` block').toBeTruthy();
    expect(
      on.push,
      `${ENGINE_MIRROR} must be push-triggered. Dispatch-only is what left the ` +
        'engine stranded for three days after the cutover: a transport nobody ' +
        'runs is a transport that does not exist.',
    ).toBeTruthy();

    const paths: string[] = on.push.paths ?? [];
    expect(
      paths,
      'the push trigger must watch the engine folder',
    ).toContain('packages/articles/engine/**');

    expect(
      on.push.branches,
      'only main is mirrored — a side branch must never reach the corpus',
    ).toEqual(['main']);
  });

  it('keeps a schedule, because a GITHUB_TOKEN push never fires `push`', () => {
    // Same lesson mirror-articles-corpus.yml wrote down before it was disabled:
    // GitHub's anti-recursion rule means a push made by automation triggers
    // nothing, so the `push:` filter alone has a hole exactly where automated
    // engine changes land. Remove the schedule and the drift comes back through
    // the door it used the first time.
    expect(
      on.schedule,
      'the schedule is the safety net for engine changes pushed with GITHUB_TOKEN',
    ).toBeTruthy();
    expect(Array.isArray(on.schedule) && on.schedule.length > 0).toBe(true);
  });

  it('never names the corpus — content/ is nanako\'s, and the mirror cannot reach it', () => {
    // The load-bearing assertion. mirror-articles-corpus.yml is unusable
    // precisely because it wipes and replaces `content/`; this workflow is safe
    // to automate only for as long as it has no analogue of that step.
    expect(
      /rm\s+-rf[^\n]*content/.test(live),
      'the engine mirror must never rm -rf anything named content — that is the ' +
        'step that makes the corpus mirror undeployable',
    ).toBe(false);

    expect(
      /packages\/articles\/content/.test(live),
      'the engine mirror must not reference packages/articles/content at all. ' +
        'nanako generates the corpus; this repo pulls it back via ' +
        'scripts/pull-articles-corpus.mjs. Carrying it downward again would ' +
        'delete every article generated since the last pull.',
    ).toBe(false);
  });

  it('fails closed on any staged path outside the engine', () => {
    // A guard that only warns is a guard that ships the bad diff. The run must
    // stop, so assert both the allowlist and a non-zero exit next to it.
    expect(
      /git diff --cached --name-only/.test(live),
      'the mirror must inspect what it actually staged, not what it intended to stage',
    ).toBe(true);

    expect(
      /grep -vE '\^\(engine\//.test(live),
      'the staged-path allowlist must be anchored on engine/',
    ).toBe(true);

    // Scope to the allowlist branch itself. Slicing a fixed window from the
    // first `git diff --cached` instead let the NEXT guard's `exit 1` (the
    // deletion cap) satisfy this assertion, so deleting the allowlist's own
    // exit left the test green — caught by mutating exactly that line.
    const start = live.indexOf('if [ -n "$bad" ]; then');
    expect(start, 'the allowlist guard branch is missing').toBeGreaterThan(-1);
    const guard = live.slice(start, live.indexOf('\n          fi', start));
    expect(
      /exit 1/.test(guard),
      'an unrecognised staged path must end the run, not warn about it: the ' +
        'allowlist branch itself has to exit non-zero',
    ).toBe(true);
  });

  it('pushes only to a workflow-owned side branch, never the corpus default branch', () => {
    // A direct push to nanako's main would put an untested engine in front of
    // the generator that publishes articles, with no CI and no parity golden
    // between the change and production.
    const pushes = live.match(/git push[^\n]*/g) ?? [];
    expect(pushes.length, 'expected at least one git push').toBeGreaterThan(0);

    for (const p of pushes) {
      expect(
        /HEAD:main\b|HEAD:master\b|origin\s+main\b/.test(p),
        `the engine mirror must not push to the corpus default branch: ${p.trim()}`,
      ).toBe(false);
      expect(
        /TARGET_BRANCH/.test(p),
        `every push must target the workflow-owned side branch: ${p.trim()}`,
      ).toBe(true);
    }
  });

  it('watches every file it copies, so the two lists cannot drift apart', () => {
    // The copy step carries index.ts and articleSections.ts alongside engine/.
    // If one is added to the copy and not to `paths:`, changing it stops
    // triggering the mirror — silently, which is this issue's whole failure mode.
    const paths: string[] = on.push.paths ?? [];
    const copied = [...live.matchAll(/for f in ([^;]+); do/g)]
      .flatMap((m) => m[1].trim().split(/\s+/))
      .filter((f) => f.endsWith('.ts'));

    expect(copied.length, 'expected the sibling-file copy loop to name some files').toBeGreaterThan(0);

    for (const f of copied) {
      expect(
        paths,
        `${f} is copied to the corpus but no push path watches it — a change to ` +
          'it would never trigger the mirror',
      ).toContain(`packages/articles/${f}`);
    }
  });

  it('checks the sparse checkout actually produced an engine', () => {
    // A sparse pattern that selects nothing yields an empty folder, an empty
    // diff, and a green "already in sync" run while the repos drift. Same
    // silent-success shape the mirror exists to remove.
    expect(
      /sparse-checkout/.test(live),
      'the checkout must stay sparse — a full one materialises the 14k-file corpus',
    ).toBe(true);
    expect(
      /engine\/siteShell\.ts/.test(live),
      'the run must verify the engine materialised before mirroring it',
    ).toBe(true);
  });
});

/**
 * A mirror whose PRs the destination rejects is not a mirror.
 *
 * nanako gates every PR body on `scripts/ci/pr-body-contract.mjs`, which is
 * built on the same two modules this repo ships (`scripts/lib/pr-body-*.mjs`,
 * byte-identical on both sides and watched by the loop-sync manifest). The
 * first body this workflow ever generated had neither required header, so the
 * `contract` check went red the moment the PR opened — with `test`, `detect`,
 * `publish`, `dry-run` and `tests (node --test)` all green. A red required
 * check means the PR cannot close on its own, which means the engine keeps
 * diverging, which is the single failure mode this workflow exists to end.
 * Measured while it was live: site `engine/ogPagesPlugin.ts` at 1612 lines vs
 * corpus at 1509.
 *
 * So the body is not asserted by eye or by regex resemblance. The generating
 * shell is sliced out of the workflow, RUN under bash with stubbed inputs, and
 * the bytes it produces are handed to the very checker nanako runs.
 */
const BODY_START = '# >>> pr-body >>>';
const BODY_END = '# <<< pr-body <<<';

/** Run the workflow's own body-building shell with `env` pre-seeded, return the body. */
function renderPrBody(env: Record<string, string>): string {
  const from = src.indexOf(BODY_START);
  const to = src.indexOf(BODY_END);
  expect(from, `${ENGINE_MIRROR} lost its ${BODY_START} marker`).toBeGreaterThan(-1);
  expect(to, `${ENGINE_MIRROR} lost its ${BODY_END} marker`).toBeGreaterThan(from);

  const snippet = src.slice(from + BODY_START.length, to);
  const script = [
    'set -euo pipefail',
    // Single-quoted, with any embedded quote escaped the POSIX way: the values
    // below are fixtures, but a body built from unescaped interpolation is a
    // body that breaks on the first commit subject containing an apostrophe.
    ...Object.entries(env).map(([k, v]) => `${k}='${v.replace(/'/g, `'\\''`)}'`),
    snippet,
    'cat "$body"',
    'rm -f "$body"',
  ].join('\n');

  return execFileSync('bash', ['-c', script], { encoding: 'utf-8' });
}

const FULL_ENV = {
  SHA: '0123456789abcdef0123456789abcdef01234567',
  n_changed: '2',
  n_deleted: '0',
  changed_paths: ['engine/ogPagesPlugin.ts', 'engine/siteShell.ts'].join('\n'),
  carried: [
    "ab12cd34 fix(seo): hero articolo — l'immagine reale, dimensioni reali",
    'ef56ab78 feat(engine): indice related-articles topicale',
  ].join('\n'),
};

/** Everything the two best-effort lookups can fail to produce, all at once. */
const DEGRADED_ENV = { SHA: '0123456789abcdef', n_changed: '0', n_deleted: '0', changed_paths: '', carried: '' };

describe('the lockstep PR body satisfies the contract nanako gates on', () => {
  it('passes the section contract with the lookups populated', () => {
    const body = renderPrBody(FULL_ENV);
    const { violations } = checkPrBodySections(body);
    expect(
      violations,
      'the generated PR body must satisfy scripts/lib/pr-body-sections-check.mjs — ' +
        'nanako runs exactly this module and blocks the PR when it fails:\n' +
        violations.map((v) => `  ${v.message}`).join('\n'),
    ).toEqual([]);
  });

  it('still passes when both best-effort lookups come back empty', () => {
    // The commit range and the path list are read over the network AFTER the
    // push has already happened, and are guarded so a failure never fails the
    // mirror. That guard is only correct if the body is still contract-valid
    // without them — otherwise a transient API hiccup silently reintroduces the
    // red `contract` check this whole fix is about.
    const body = renderPrBody(DEGRADED_ENV);
    expect(checkPrBodySections(body).violations).toEqual([]);
  });

  it('carries the two headers literally, with "(ancora)"', () => {
    // The gate matches `#{2,3}` + the exact wording. `## Summary`, `## Non
    // implementato` without "(ancora)", or a bold line instead of a heading all
    // read as "missing" — which is how the first version failed.
    const body = renderPrBody(FULL_ENV);
    expect(body).toMatch(/^## Implementato$/m);
    expect(body).toMatch(/^## Non implementato \(ancora\)$/m);
  });

  it('says what it is carrying, rather than filling the sections to pass', () => {
    // The gate accepts any non-empty bullet, so it cannot tell a description
    // from a placeholder. These assertions can: the section has to name the
    // commit being mirrored and the commits it brings down.
    const body = renderPrBody(FULL_ENV);
    const impl = body.slice(
      body.indexOf('## Implementato'),
      body.indexOf('## Non implementato (ancora)'),
    );
    expect(impl, 'the mirrored site commit must appear in ## Implementato').toContain('01234567');
    for (const sha of ['ab12cd34', 'ef56ab78']) {
      expect(impl, `commit ${sha} is carried by this PR but is not listed`).toContain(sha);
    }

    const notImpl = body.slice(body.indexOf('## Non implementato (ancora)'));
    expect(
      /\bNessun[oa]\b/.test(notImpl),
      '"Nessuno" would claim there is no deferred scope, and there is: merging ' +
        'this PR does not regenerate a single already-published page, and the ' +
        'host/ half of SiteShellContract never travels with the engine',
    ).toBe(false);
    expect(notImpl).toMatch(/publish-api\.yml/);
    expect(notImpl).toMatch(/host\//);
  });

  it('survives a path list longer than the inline cap, and says so', () => {
    // The cap used to be a `head -25`, which SIGPIPEs its producer; under
    // `set -o pipefail` + `set -e` that is a dead step, not a truncated list.
    // Reproduced on a real commit before the cap moved inside awk.
    const many = Array.from({ length: 40 }, (_, i) => `engine/file${i}.ts`).join('\n');
    const body = renderPrBody({ ...FULL_ENV, n_changed: '40', changed_paths: many });
    expect(body).toContain('`engine/file0.ts`');
    expect(body).toContain('and 15 more');
    expect(checkPrBodySections(body).violations).toEqual([]);
  });

  it('never chains issue refs after one closing keyword', () => {
    // The other half of nanako's gate: `Closes #a #b` closes only #a, and the
    // rest stay open in silence.
    const body = renderPrBody(FULL_ENV);
    expect(checkClosesLines(body).violations).toEqual([]);
  });
});

describe('every workflow that opens a PR produces a contract-conforming body', () => {
  // The engine mirror is checked byte-for-byte above; this is the cheap sweep
  // that stops the same omission from arriving in the NEXT workflow. Both
  // repos gate on the same two headers, so a `gh pr create` anywhere in
  // .github/workflows without them is a PR that is red before anyone looks.
  const openers = fs
    .readdirSync(WF_DIR)
    .filter((f) => f.endsWith('.yml') || f.endsWith('.yaml'))
    .map((f) => ({ file: f, raw: fs.readFileSync(path.join(WF_DIR, f), 'utf-8') }))
    // Only live calls: several workflows mention `gh pr create` in a comment to
    // explain why they deliberately do NOT open one.
    .filter(({ raw }) => /gh pr create/.test(withoutComments(raw)));

  it('finds the workflows that open PRs at all', () => {
    // A sweep that silently matches nothing is a sweep that passes forever.
    expect(openers.map((o) => o.file)).toContain(ENGINE_MIRROR);
    expect(openers.length).toBeGreaterThanOrEqual(2);
  });

  it.each(openers.map((o) => o.file))('%s writes both required headers', (file) => {
    // Raw source, not `withoutComments`: a `## Implementato` line inside a body
    // template or an agent prompt starts with `#` and would be stripped as if
    // it were a YAML comment.
    //
    // The optional quote matters: a heredoc and an agent prompt write the header
    // bare, but a `printf '%s\n' ...` list writes it as `'## Implementato' \`.
    // Requiring a bare line failed on the engine mirror itself.
    const raw = openers.find((o) => o.file === file)!.raw;
    expect(
      /^[ \t]*['"]?## Implementato\b/m.test(raw),
      `${file} calls gh pr create but never writes \`## Implementato\` — the ` +
        'body-contract gate rejects the PR on arrival',
    ).toBe(true);
    expect(
      /^[ \t]*['"]?## Non implementato \(ancora\)/m.test(raw),
      `${file} calls gh pr create but never writes \`## Non implementato (ancora)\` ` +
        '— note the literal "(ancora)": the gate rejects the header without it',
    ).toBe(true);
  });
});

describe('the two mirrors stay different workflows', () => {
  it('the corpus mirror is still the dispatch-only one', () => {
    // Guards against "simplifying" the two into one workflow again. They differ
    // in the only way that matters: this one may fire by itself, that one may
    // not, because that one wipes content/.
    const corpus = fs.readFileSync(path.join(WF_DIR, 'mirror-articles-corpus.yml'), 'utf-8');
    const corpusLive = withoutComments(corpus);
    expect(/^\s+push:/m.test(corpusLive)).toBe(false);
    expect(/^\s+workflow_dispatch:/m.test(corpusLive)).toBe(true);
  });
});
