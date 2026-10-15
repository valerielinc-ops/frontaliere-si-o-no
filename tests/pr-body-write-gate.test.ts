// @vitest-environment node
import { afterEach, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  BODY_REWRITE_REASON_ENV,
  CLAIM_TTL_MS,
  MIN_REASON_LENGTH,
  blockMessage,
  resolveRewriteReason,
} from '../scripts/ci/pr-body-write-gate.mjs';
import { findPrBodyWrite, splitCommandPrefix } from '../scripts/ci/lib/hook-command-parser.mjs';
import { claimMarker } from '../scripts/ci/lib/hook-state.mjs';

const GATE = join(dirname(fileURLToPath(import.meta.url)), '..', 'scripts', 'ci', 'pr-body-write-gate.mjs');
const REPO = 'nanakokyobashi-rgb/frontaliere-articles';
const roots: string[] = [];

afterEach(() => {
  while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true });
});

function stateDir(): string {
  const root = mkdtempSync(join(tmpdir(), 'pr-body-write-gate-'));
  roots.push(root);
  return root;
}

/** Run the gate exactly as the PreToolUse hook does: JSON payload on stdin. */
function runGate(command: string, extraEnv: Record<string, string> = {}) {
  const payload = JSON.stringify({ tool_input: { command }, cwd: process.cwd() });
  const result = spawnSync(process.execPath, [GATE], {
    input: payload,
    encoding: 'utf8',
    env: { ...process.env, ...extraEnv },
  });
  return {
    code: result.status ?? -1,
    stdout: String(result.stdout ?? ''),
    stderr: String(result.stderr ?? ''),
  };
}

const edit = (extra = '') =>
  `${extra}gh pr edit 1599 --repo ${REPO} --body-file /tmp/body.md`;

describe('pr-body-write-gate: the escape hatch is reachable from the command', () => {
  it('blocks the second write and names the in-command declaration', () => {
    const dir = stateDir();
    const env = { FRONTALIERE_HOOK_STATE_DIR: dir, [BODY_REWRITE_REASON_ENV]: '' };

    expect(runGate(edit(), env).code).toBe(0);

    const blocked = runGate(edit(), env);
    expect(blocked.code).toBe(2);
    // The message must carry the form that actually works: the declaration on
    // the same line as the command, not a shell `export` the hook cannot see.
    expect(blocked.stderr).toContain(`${BODY_REWRITE_REASON_ENV}='`);
    expect(blocked.stderr).toMatch(/gh pr edit .*--body-file/);
    expect(blocked.stderr).toContain("non vede l'ambiente della tua shell");
  });

  it('allows the rewrite when the reason rides the command line', () => {
    const dir = stateDir();
    const env = { FRONTALIERE_HOOK_STATE_DIR: dir, [BODY_REWRITE_REASON_ENV]: '' };
    expect(runGate(edit(), env).code).toBe(0);

    const declared = runGate(
      edit(`${BODY_REWRITE_REASON_ENV}='la review #1599 chiede la correzione del body' `),
      env,
    );
    expect(declared.code).toBe(0);
    expect(declared.stderr).toContain('riscrittura autorizzata');
    expect(declared.stderr).toContain('dichiarata nel comando');
  });

  it('reads the declaration through an `env NAME=value` prefix too', () => {
    const dir = stateDir();
    const env = { FRONTALIERE_HOOK_STATE_DIR: dir, [BODY_REWRITE_REASON_ENV]: '' };
    expect(runGate(edit(), env).code).toBe(0);
    expect(
      runGate(edit(`env ${BODY_REWRITE_REASON_ENV}='review 1599: body corretto su richiesta' `), env)
        .code,
    ).toBe(0);
  });

  it('refuses a declaration that reached the hook unexpanded', () => {
    const dir = stateDir();
    const env = { FRONTALIERE_HOOK_STATE_DIR: dir, [BODY_REWRITE_REASON_ENV]: '' };
    expect(runGate(edit(), env).code).toBe(0);

    const unexpanded = runGate(edit(`${BODY_REWRITE_REASON_ENV}="$MOTIVO" `), env);
    expect(unexpanded.code).toBe(2);
    expect(unexpanded.stderr).toContain('non espansa');
  });

  it('refuses a reason too short to say who asked for the rewrite', () => {
    const short = resolveRewriteReason({ [BODY_REWRITE_REASON_ENV]: 'fix' }, {});
    expect(short.ok).toBe(false);
    expect((short as { problem: string }).problem).toContain(String(MIN_REASON_LENGTH));
  });

  it('prefers the in-command reason over the hook process environment', () => {
    const resolved = resolveRewriteReason(
      { [BODY_REWRITE_REASON_ENV]: 'dichiarata nel comando dalla review' },
      { [BODY_REWRITE_REASON_ENV]: 'ereditata dal processo hook' },
    );
    expect(resolved).toMatchObject({ ok: true, source: 'command' });

    // The historical env path still works for CI, where it IS settable.
    expect(
      resolveRewriteReason({}, { [BODY_REWRITE_REASON_ENV]: 'correzione del contratto in CI' }),
    ).toMatchObject({ ok: true, source: 'env' });
  });

  it('still blocks an undeclared rewrite: the fleet guard is intact', () => {
    const dir = stateDir();
    const env = { FRONTALIERE_HOOK_STATE_DIR: dir, [BODY_REWRITE_REASON_ENV]: '' };
    expect(runGate(edit(), env).code).toBe(0);
    expect(runGate(edit(), env).code).toBe(2);
    expect(runGate(edit(), env).code).toBe(2);
  });

  it('leaves non-body `gh pr edit` mutations alone', () => {
    const dir = stateDir();
    const env = { FRONTALIERE_HOOK_STATE_DIR: dir };
    const labels = `gh pr edit 1599 --repo ${REPO} --add-label ready`;
    expect(runGate(labels, env).code).toBe(0);
    expect(runGate(labels, env).code).toBe(0);
  });
});

describe('pr-body-write-gate: the claim expires', () => {
  it('takes over a claim older than the TTL', () => {
    const dir = stateDir();
    const env = { FRONTALIERE_HOOK_STATE_DIR: dir, [BODY_REWRITE_REASON_ENV]: '' };
    expect(runGate(edit(), env).code).toBe(0);
    expect(runGate(edit(), env).code).toBe(2);

    // Age the claim the way a dead session would have: only the clock moves.
    const scope = join(dir, 'pr-body-writes');
    const [marker] = readdirSync(scope).filter((name) => name.endsWith('.json'));
    const record = JSON.parse(readFileSync(join(scope, marker), 'utf8'));
    record.createdAt = new Date(Date.now() - CLAIM_TTL_MS - 60_000).toISOString();
    writeFileSync(join(scope, marker), `${JSON.stringify(record)}\n`, 'utf8');

    const afterTtl = runGate(edit(), env);
    expect(afterTtl.code).toBe(0);
    expect(afterTtl.stderr).toContain('claim precedente scaduto');

    // The takeover re-arms the gate rather than disabling it.
    expect(runGate(edit(), env).code).toBe(2);
  });

  it('keeps a claim that is merely old, not expired', () => {
    const dir = stateDir();
    const env = { FRONTALIERE_HOOK_STATE_DIR: dir, [BODY_REWRITE_REASON_ENV]: '' };
    expect(runGate(edit(), env).code).toBe(0);

    const scope = join(dir, 'pr-body-writes');
    const [marker] = readdirSync(scope).filter((name) => name.endsWith('.json'));
    const record = JSON.parse(readFileSync(join(scope, marker), 'utf8'));
    record.createdAt = new Date(Date.now() - CLAIM_TTL_MS + 10 * 60_000).toISOString();
    writeFileSync(join(scope, marker), `${JSON.stringify(record)}\n`, 'utf8');

    const blocked = runGate(edit(), env);
    expect(blocked.code).toBe(2);
    expect(blocked.stderr).toMatch(/scade da sola?|scade da solo/);
  });

  it('blockMessage reports the remaining life when the age is known', () => {
    expect(blockMessage(CLAIM_TTL_MS - 20 * 60_000)).toContain('fra ~20 min');
    expect(blockMessage(undefined)).toContain('90 min');
  });
});

describe('claimMarker TTL semantics', () => {
  const record = () => ({ createdAt: new Date().toISOString() });

  it('reports `exists` without a TTL, exactly as before', () => {
    const dir = stateDir();
    process.env.FRONTALIERE_HOOK_STATE_DIR = dir;
    try {
      expect(claimMarker({ scope: 'ttl-test', key: 'a', record: record() }).status).toBe('claimed');
      expect(claimMarker({ scope: 'ttl-test', key: 'a', record: record() }).status).toBe('exists');
    } finally {
      delete process.env.FRONTALIERE_HOOK_STATE_DIR;
    }
  });

  it('treats a marker with an unreadable timestamp as fresh, never as expired', () => {
    const dir = stateDir();
    process.env.FRONTALIERE_HOOK_STATE_DIR = dir;
    try {
      const first = claimMarker({
        scope: 'ttl-test',
        key: 'b',
        record: { createdAt: 'non-una-data' },
      });
      expect(first.status).toBe('claimed');
      // mtime is the fallback and it is seconds old → not expired.
      expect(claimMarker({ scope: 'ttl-test', key: 'b', record: record(), ttlMs: 1000 * 60 }).status)
        .toBe('exists');
    } finally {
      delete process.env.FRONTALIERE_HOOK_STATE_DIR;
    }
  });

  it('takes an expired marker over and reports the takeover', () => {
    const dir = stateDir();
    process.env.FRONTALIERE_HOOK_STATE_DIR = dir;
    try {
      claimMarker({
        scope: 'ttl-test',
        key: 'c',
        record: { createdAt: new Date(Date.now() - 7_200_000).toISOString() },
      });
      const again = claimMarker({ scope: 'ttl-test', key: 'c', record: record(), ttlMs: 60_000 });
      expect(again).toMatchObject({ status: 'claimed', takeover: true });
      // And the fresh claim holds the slot again.
      expect(claimMarker({ scope: 'ttl-test', key: 'c', record: record(), ttlMs: 60_000 }).status)
        .toBe('exists');
    } finally {
      delete process.env.FRONTALIERE_HOOK_STATE_DIR;
    }
  });
});

describe('splitCommandPrefix', () => {
  it('returns the assignments that precede the command', () => {
    const write = findPrBodyWrite(`A=1 B='due parole' ${edit()}`);
    expect(write?.assignments).toMatchObject({ A: '1', B: 'due parole' });
    expect(write?.prNumber).toBe('1599');
  });

  it('drops a name that `env -u` unset', () => {
    const { words, assignments } = splitCommandPrefix(['env', 'A=1', '-u', 'A', 'gh', 'pr', 'edit']);
    expect(words[0]).toBe('gh');
    expect(assignments).not.toHaveProperty('A');
  });

  it('does not treat an assignment inside the arguments as a declaration', () => {
    const write = findPrBodyWrite(`${edit()} --title ${BODY_REWRITE_REASON_ENV}=finto`);
    expect(write?.assignments).not.toHaveProperty(BODY_REWRITE_REASON_ENV);
  });
});
