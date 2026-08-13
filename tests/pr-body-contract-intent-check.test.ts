import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import YAML from 'yaml';

/**
 * Observer for issue #5784 — «Chiude #N» reaches GitHub as prose, not as a
 * closing keyword, and the PR merges while the issue it was meant to close
 * stays open forever, looking like backlog. Measured: PR #5776 said `Chiude
 * #5725` and #5725 stayed open until closed by hand; same shape on #5724,
 * near-miss on #5774.
 *
 * The DETECTION already existed, fully unit-tested, in
 * scripts/lib/pr-body-closes-check.mjs (see tests/pr-body-closes-check.test.ts)
 * — but that helper only reached PRs through auto-merge-eval.mjs's narrow
 * drift-fallback path (PRs that touch pr-review-loop.yml with no Claude
 * review). The actual gate every PR goes through, `pr-body-contract.yml`,
 * mirrors OTHER parts of the same helper (the multi-issue-Closes chain, the
 * aggregate-close veto) inline in its `script:` step — deliberately inline,
 * because that step runs `actions/github-script` WITHOUT a checkout, so it
 * cannot `require()` a repo module (see the step's own comment). It did NOT
 * mirror the ineffective-closing-keyword check, so an Italian body sailed
 * through untouched.
 *
 * This test does not re-test the shared regex (tests/pr-body-closes-check.test.ts
 * already does that exhaustively). It proves the GATE itself — by extracting
 * the REAL inline script from pr-body-contract.yml and running it, with
 * `github`/`context`/`core` mocked, exactly the way `actions/github-script`
 * would invoke it. Not a reimplementation: if the mirror in the YAML regresses
 * (or is reverted), THIS test goes red, because it executes that exact text.
 *
 * Verified by hand against the pre-fix file (`git show HEAD:...`): a body of
 * `Chiude #123` produced `setFailed: []` — the bug this test guards against.
 */

const ROOT = resolve(import.meta.dirname, '..');
const WORKFLOW_PATH = resolve(ROOT, '.github/workflows/pr-body-contract.yml');
const WORKFLOW_YML = readFileSync(WORKFLOW_PATH, 'utf-8');

function extractContractScript(): string {
  const doc = YAML.parse(WORKFLOW_YML);
  const step = doc?.jobs?.contract?.steps?.[0];
  const script = step?.with?.script;
  if (typeof script !== 'string' || script.length === 0) {
    throw new Error(
      'pr-body-contract.yml: contract job step[0].with.script not found — has the step shape changed? Update this extractor.',
    );
  }
  return script;
}

interface ContractResult {
  setFailed: string[];
  comments: string[];
}

/**
 * Runs the REAL `script:` body of the `contract` job's first step against a
 * synthetic PR body, mocking the three globals `actions/github-script`
 * injects (`github`, `context`, `core`). No network, no repo checkout needed
 * — the step itself has none either.
 */
async function runContractCheck(body: string): Promise<ContractResult> {
  const script = extractContractScript();
  const calls: ContractResult = { setFailed: [], comments: [] };
  const core = {
    setFailed: (msg: string) => { calls.setFailed.push(msg); },
    info: () => {},
    warning: () => {},
  };
  const github = {
    paginate: async () => [] as unknown[],
    rest: {
      issues: {
        listComments: async () => ({ data: [] }),
        createComment: async ({ body: b }: { body: string }) => { calls.comments.push(b); },
        updateComment: async ({ body: b }: { body: string }) => { calls.comments.push(b); },
        // Neutral closed-issue stub: no labels → never trips the aggregate-close check,
        // which is out of scope for this observer.
        get: async () => ({ data: { labels: [] as string[] } }),
      },
    },
  };
  const context = {
    repo: { owner: 'valerielinc-ops', repo: 'frontaliere-si-o-no' },
    payload: { pull_request: { number: 1, body } },
  };
  // eslint-disable-next-line no-new-func -- deliberately sandboxing the real workflow script, see file header
  const fn = new Function('github', 'context', 'core', `return (async () => {\n${script}\n})();`);
  await fn(github, context, core);
  return calls;
}

const wrap = (line: string) =>
  `## Implementato\n- roba fatta\n\n${line}\n\n## Non implementato (ancora)\nNessuno\n`;

describe('pr-body-contract.yml — ineffective closing keyword (issue #5784)', () => {
  it('flags «Chiude #123» — GitHub does not honor it, the issue would stay open', async () => {
    const { setFailed, comments } = await runContractCheck(wrap('Chiude #123'));
    expect(setFailed.length).toBeGreaterThan(0);
    expect(setFailed.join(' ')).toMatch(/ineffective closing keyword/);
    expect(comments.join(' ')).toMatch(/Keyword di chiusura inefficace/);
    expect(comments.join(' ')).toMatch(/#123/);
  });

  it('does NOT flag «Closes #123» — the correct English keyword', async () => {
    const { setFailed } = await runContractCheck(wrap('Closes #123'));
    expect(setFailed.join(' ')).not.toMatch(/ineffective closing keyword/);
  });

  it('does NOT flag «Refs #123» — naming an issue is not claiming to close it (the case that matters: a noisy gate here gets ignored)', async () => {
    const { setFailed } = await runContractCheck(wrap('Refs #123'));
    expect(setFailed).toEqual([]);
  });

  it('does NOT flag other legitimate non-closing references', async () => {
    for (const line of ['vedi #123', 'il residuo va in #123', 'Related to #123', 'Supersedes #123']) {
      const { setFailed } = await runContractCheck(wrap(line));
      expect(setFailed.join(' '), `false positive on: ${line}`).not.toMatch(/ineffective closing keyword/);
    }
  });

  it('does NOT flag when `Closes #N` already covers the same ref (redundant prose, not a missed closure)', async () => {
    const { setFailed } = await runContractCheck(wrap('Closes #123\n\nQuesta PR chiude #123.'));
    expect(setFailed.join(' ')).not.toMatch(/ineffective closing keyword/);
  });

  it('does NOT flag a quoted example — a body that DOCUMENTS the bug must not trip on itself', async () => {
    const { setFailed } = await runContractCheck(
      wrap('Non scrivere `Chiude #123`, usa `Closes #123`.'),
    );
    expect(setFailed.join(' ')).not.toMatch(/ineffective closing keyword/);
  });

  it('matches the measured recurrence shape (PR #5776 → issue #5725)', async () => {
    const { setFailed } = await runContractCheck(wrap('Chiude #5725'));
    expect(setFailed.join(' ')).toMatch(/ineffective closing keyword/);
  });
});
