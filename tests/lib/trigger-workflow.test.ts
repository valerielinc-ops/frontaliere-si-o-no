// Tests for scripts/lib/trigger-workflow.sh — the shared workflow_dispatch
// engine behind trigger-deploy.sh, trigger-self.sh and the fast-publish
// dispatches (issue #4837).
//
// Regression origin: the engine originally read its inputs argument as
// `INPUTS_JSON="${2:-{}}"`. Bash ends that parameter expansion at the FIRST
// `}`, so the default is `{` and the remaining `}` is appended literally to
// the expansion result — a caller-supplied `{"article_id":"x"}` arrived as
// `{"article_id":"x"}}`. JSON.parse rejected it, a silent catch swallowed the
// error, and the dispatch went out with `ref` only. Every dispatch still
// returned HTTP 204, so callers saw a "successful" trigger of a run that never
// received its article id — fast-publish-article.yml would have been dispatched
// with no article to publish at all.
import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { resolve, join } from 'node:path';
import { mkdtempSync, readFileSync, chmodSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';

const SCRIPT = resolve('scripts/lib/trigger-workflow.sh');

/** Stub `curl` on PATH so no dispatch leaves the machine; capture its argv. */
function dispatchWith(inputsJson: string | undefined, env: Record<string, string> = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'trigger-workflow-'));
  const capture = join(dir, 'args');
  const stub = join(dir, 'curl');
  writeFileSync(stub, `#!/usr/bin/env bash\nprintf '%s\\n' "$@" > ${JSON.stringify(capture)}\necho 204\n`);
  chmodSync(stub, 0o755);

  const args = inputsJson === undefined ? ['generate-article.yml'] : ['generate-article.yml', inputsJson];
  const stdout = execFileSync('bash', [SCRIPT, ...args], {
    env: { PATH: `${dir}:${process.env.PATH}`, GITHUB_PAT: 'fake-token', ...env },
    encoding: 'utf8',
    timeout: 10000,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  const lines = readFileSync(capture, 'utf8').split('\n');
  const payload = lines[lines.indexOf('-d') + 1] ?? '';
  return { stdout, payload };
}

describe('scripts/lib/trigger-workflow.sh', () => {
  it('forwards caller inputs verbatim into the dispatch payload', () => {
    const { payload } = dispatchWith(JSON.stringify({ article_id: 'x-y-z', section: 'svizzera', sha: 'deadbeef' }));
    const parsed = JSON.parse(payload);
    expect(parsed.inputs).toEqual({ article_id: 'x-y-z', section: 'svizzera', sha: 'deadbeef' });
  });

  it('does not append a stray brace when the inputs argument is supplied', () => {
    // The exact shape of the original bug: valid JSON in, valid JSON out.
    const { payload } = dispatchWith('{"article_id":"only-one-key"}');
    expect(() => JSON.parse(payload)).not.toThrow();
    expect(payload).not.toContain('}}}');
    expect(JSON.parse(payload).inputs.article_id).toBe('only-one-key');
  });

  it('omits the inputs key entirely when no inputs are supplied', () => {
    const { payload } = dispatchWith(undefined);
    const parsed = JSON.parse(payload);
    expect(parsed.ref).toBe('main');
    expect(parsed.inputs).toBeUndefined();
  });

  it('honours TRIGGER_REF for the dispatch ref', () => {
    const { payload } = dispatchWith('{}', { TRIGGER_REF: 'release-branch' });
    expect(JSON.parse(payload).ref).toBe('release-branch');
  });

  it('fails loudly on malformed inputs JSON instead of dispatching without inputs', () => {
    // Silently dropping inputs is what hid the original bug — a caller bug must
    // surface, not produce a green no-input dispatch.
    expect(() => dispatchWith('{not valid json')).toThrow();
  });
});
