/**
 * Contract test for the local/remote issue claim mutex.
 *
 * The real script talks to `gh`; a tiny stateful fake keeps this test
 * deterministic and exercises the CLI boundary, including the fail-closed
 * path that a pure helper test would miss.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { execFileSync } from 'node:child_process';

const SCRIPT = join(process.cwd(), 'scripts/ci/claim-issue-in-flight.mjs');
const tempDirs: string[] = [];

const FAKE_GH = `#!/usr/bin/env node
import fs from 'node:fs';

const statePath = process.env.FAKE_GH_STATE;
const args = process.argv.slice(2);
const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
const failView = process.env.FAKE_GH_FAIL_VIEW === '1';

if (args[0] === 'issue' && args[1] === 'view') {
  if (failView) process.exit(1);
  console.log(JSON.stringify({ labels: state.labels.map((name) => ({ name })) }));
  process.exit(0);
}
if (args[0] === 'label' && args[1] === 'create') process.exit(0);
if (args[0] === 'issue' && args[1] === 'comment') process.exit(0);
if (args[0] === 'issue' && args[1] === 'edit') {
  for (let i = 0; i < args.length - 1; i++) {
    if (args[i] === '--add-label') {
      const value = args[++i];
      state.labels.push(value);
    }
    if (args[i] === '--remove-label') {
      const value = args[++i];
      state.labels = state.labels.filter((name) => name !== value);
    }
  }
  state.labels = [...new Set(state.labels)];
  fs.writeFileSync(statePath, JSON.stringify(state));
  process.exit(0);
}
process.exit(0);
`;

function fixture(labels: string[] = []) {
  const dir = mkdtempSync(join(tmpdir(), 'frontaliere-claim-'));
  tempDirs.push(dir);
  const gh = join(dir, 'gh');
  const state = join(dir, 'state.json');
  writeFileSync(gh, FAKE_GH, { mode: 0o755 });
  chmodSync(gh, 0o755);
  writeFileSync(state, JSON.stringify({ labels }));
  return { dir, state };
}

function runClaim(fx: ReturnType<typeof fixture>, extra: Record<string, string>) {
  const env = {
    ...process.env,
    PATH: `${fx.dir}${delimiter}${process.env.PATH || ''}`,
    FAKE_GH_STATE: fx.state,
    GH_REPO: 'owner/repo',
    ISSUE_NUMBER: '42',
    ...extra,
  };
  return execFileSync(process.execPath, [SCRIPT], { env, encoding: 'utf8' });
}

function labels(fx: ReturnType<typeof fixture>) {
  return JSON.parse(readFileSync(fx.state, 'utf8')).labels as string[];
}

afterEach(() => {
  while (tempDirs.length) rmSync(tempDirs.pop()!, { recursive: true, force: true });
});

describe('claim-issue-in-flight CLI', () => {
  it('acquisisce un claim locale e rende visibili entrambi i flag', () => {
    const fx = fixture();
    const out = runClaim(fx, { CLAIM_OWNER: 'local', CLAIM_ACTION: 'acquire' });
    expect(out).toContain('in_flight=false');
    expect(out).toContain('claim_acquired=true');
    expect(out).toContain('claim_owner=local');
    expect(out).toContain('claim_error=false');
    expect(labels(fx)).toEqual(['agent:in-progress', 'agent:local']);
  });

  it('il remoto non può acquisire né rilasciare un claim locale', () => {
    const fx = fixture(['agent:in-progress', 'agent:local']);
    const acquire = runClaim(fx, { CLAIM_OWNER: 'remote', CLAIM_ACTION: 'acquire' });
    expect(acquire).toContain('in_flight=true');
    expect(acquire).toContain('claim_owner=local');
    const release = runClaim(fx, { CLAIM_OWNER: 'remote', CLAIM_ACTION: 'release' });
    expect(release).toContain('in_flight=true');
    expect(release).toContain('claim_owner=local');
    expect(labels(fx)).toEqual(['agent:in-progress', 'agent:local']);
  });

  it('il proprietario locale rilascia owner e mutex insieme', () => {
    const fx = fixture(['agent:in-progress', 'agent:local']);
    const out = runClaim(fx, { CLAIM_OWNER: 'local', CLAIM_ACTION: 'release' });
    expect(out).toContain('in_flight=false');
    expect(out).toContain('claim_owner=local');
    expect(labels(fx)).toEqual([]);
  });

  it('un errore di lettura è fail-closed e non avvia il fixer', () => {
    const fx = fixture();
    const out = runClaim(fx, { CLAIM_OWNER: 'remote', CLAIM_ACTION: 'acquire', FAKE_GH_FAIL_VIEW: '1' });
    expect(out).toContain('in_flight=true');
    expect(out).toContain('claim_acquired=false');
    expect(out).toContain('claim_error=true');
    expect(labels(fx)).toEqual([]);
  });

  it('un issue number mancante è fail-closed', () => {
    const fx = fixture();
    const out = runClaim(fx, {
      CLAIM_OWNER: 'remote',
      CLAIM_ACTION: 'acquire',
      ISSUE_NUMBER: '',
    });
    expect(out).toContain('in_flight=true');
    expect(out).toContain('claim_acquired=false');
    expect(out).toContain('claim_error=true');
    expect(labels(fx)).toEqual([]);
  });
});
