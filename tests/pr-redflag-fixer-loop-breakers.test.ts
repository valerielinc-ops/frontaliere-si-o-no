// Tre interruttori del loop 🔴-fixer ↔ autorebase (misurato su #9959: 11 run
// redflag in 5h, tutte «round 1/3»; 8 run redflag rosse su 40 per cause
// benigne). Questi test eseguono i pezzi veri di `pr-redflag-fixer.yml`:
//  1. preflight: `needs-human` → notice, `actionable=false`, nessun job a valle;
//  2. claim cambiato per una sostituzione benigna → notice «run sostituita» ed
//     exit 0; claim illeggibile/malformato → resta rosso;
//  3. push respinto perché un altro writer ha avanzato il branch → notice,
//     `advanced=by-other-writer`, exit 0; remoto invariato → resta rosso.
import { describe, expect, it } from 'vitest';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { execFileSync, spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import YAML from 'yaml';
import {
  prFixClaimDedupeKey,
  prFixClaimKey,
  validateRedflagClaimSnapshot,
} from '../scripts/ci/pr-fixer-claim.mjs';
import { reviewInputRevisionFromPullRequest } from '../scripts/ci/lib/review-input-revision.mjs';

const ROOT = path.resolve(__dirname, '..');
const SOURCE = readFileSync(path.join(ROOT, '.github/workflows/pr-redflag-fixer.yml'), 'utf8');
const WF = YAML.parse(SOURCE) as any;

function step(job: string, name: string): any {
  const found = WF.jobs[job].steps.find((s: any) => s.name === name);
  if (!found) throw new Error(`step ${job}/${name} non trovato`);
  return found;
}

function fakeBin(dir: string, name: string, body: string): string {
  const file = path.join(dir, name);
  writeFileSync(file, `#!/bin/bash\n${body}\n`);
  chmodSync(file, 0o755);
  return file;
}

describe('1. preflight: needs-human ferma il loop prima di ogni job', () => {
  const pre = step('preflight', 'PR still actionable?').run as string;
  // Il prefisso del preflight usa `grep -P` (GNU): sul runner c'è, in locale
  // (macOS) no. Si esegue il tratto che decide l'azionabilità di una PR già in
  // scope: dalla lettura dello stato fino alla fine.
  const tail = pre.slice(pre.indexOf('state=$('));

  function runTail(labelsNeedsHuman: string) {
    const dir = mkdtempSync(path.join(tmpdir(), 'redflag-preflight-'));
    try {
      const log = path.join(dir, 'gh.log');
      const out = path.join(dir, 'out');
      writeFileSync(log, '');
      writeFileSync(out, '');
      const gh = fakeBin(dir, 'gh', `echo "$*" >> "${log}"
case "$*" in
  *"--json state"*) echo OPEN ;;
  *"--json labels"*) echo "$FAKE_NEEDS_HUMAN" ;;
  *branches*) echo x ;;
esac`);
      const r = spawnSync('bash', ['-c', `set -uo pipefail\n${tail}`], {
        encoding: 'utf8',
        env: {
          PATH: process.env.PATH, TRUSTED_GH_BIN: gh, GITHUB_OUTPUT: out, REPO: 'o/r',
          PR_NUMBER: '9959', HEAD_REF: 'fix/issue-9312', FAKE_NEEDS_HUMAN: labelsNeedsHuman,
        },
      });
      return { ...r, out: readFileSync(out, 'utf8'), log: readFileSync(log, 'utf8') };
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  it('needs-human → notice + actionable=false, senza leggere il branch', () => {
    const r = runTail('true');
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toContain('::notice::PR #9959 ha la label needs-human');
    expect(r.out).toBe('actionable=false\n');
    expect(r.log).not.toContain('branches/');
  });

  it('senza needs-human (o label illeggibile) il preflight procede come prima', () => {
    const r = runTail('false');
    expect(r.status, r.stderr).toBe(0);
    expect(r.out).toBe('actionable=true\n');
    const unreadable = runTail('');
    expect(unreadable.out).toBe('actionable=true\n');
  });

  it('actionable=false porta a skip ogni job a valle', () => {
    expect(WF.jobs.preflight.outputs.actionable).toBe('${{ steps.pre.outputs.actionable }}');
    for (const job of ['scope', 'declassified-notice', 'redflag-fix']) {
      expect(String(WF.jobs[job].if), job).toContain("needs.preflight.outputs.actionable == 'true'");
    }
  });
});

describe('2. claim sostituito in modo benigno → run verde, non rossa', () => {
  const HEAD = 'a'.repeat(40);
  const NEXT = 'b'.repeat(40);
  const reviewBody = 'scripts/x.mjs:L3: 🔴 Important: rotto';
  const prBody = '## Implementato\n- x\n\n## Non implementato (ancora)\n- y in questa PR\n';

  function snapshot() {
    const pr = { state: 'open', body: prBody, head: { sha: HEAD } };
    const revision = reviewInputRevisionFromPullRequest(pr);
    return {
      pr,
      reviews: [[{ id: 42, user: { type: 'Bot', login: 'frontaliere-automation[bot]' }, state: 'COMMENTED', commit_id: HEAD, body: reviewBody }]],
      claim: { workflow: 'redflag', headSha: HEAD, reviewRevision: revision, eventKey: 'review:42', verdictKey: 'findings:x' },
    };
  }

  it('HEAD / body revision / review spostate sono sostituzioni', () => {
    const s = snapshot();
    expect(validateRedflagClaimSnapshot({ ...s, pr: { ...s.pr, head: { sha: NEXT } } }))
      .toMatchObject({ valid: false, superseded: true, reason: 'HEAD cambiata dopo il claim' });
    expect(validateRedflagClaimSnapshot({ ...s, pr: { ...s.pr, body: `${prBody}\nedit` } }))
      .toMatchObject({ valid: false, superseded: true, reason: 'body revision cambiata dopo il claim' });
    expect(validateRedflagClaimSnapshot({ ...s, reviews: [[{ ...s.reviews[0][0], commit_id: NEXT }]] }))
      .toMatchObject({ valid: false, superseded: true, reason: 'review del claim non più sulla HEAD corrente' });
  });

  it('claim illeggibile o malformato NON è una sostituzione', () => {
    const s = snapshot();
    for (const verdict of [
      validateRedflagClaimSnapshot({ ...s, pr: { ...s.pr, head: { sha: 'nope' } } }),
      validateRedflagClaimSnapshot({ ...s, claim: { ...s.claim, eventKey: 'garbage' } }),
      validateRedflagClaimSnapshot({ ...s, reviews: [[{ ...s.reviews[0][0], id: 43 }]] }),
      validateRedflagClaimSnapshot({ ...s, claim: undefined }),
    ]) {
      expect(verdict.valid).toBe(false);
      expect(verdict.superseded).not.toBe(true);
    }
  });

  it('i campi malformati del claim sono validati PRIMA dei confronti (review #10068)', () => {
    // Accettazione della review: un claim senza HEAD o senza revision non
    // combacia con niente, ma non è una sostituzione — deve restare rosso.
    const pr = { state: 'open', head: { sha: HEAD }, body: '' };
    const bad = { workflow: 'redflag', eventKey: 'bad', verdictKey: 'bad' };
    for (const claim of [
      { ...bad, headSha: '', reviewRevision: 'x' },
      { ...bad, headSha: HEAD, reviewRevision: '' },
    ]) {
      const verdict = validateRedflagClaimSnapshot({ pr, reviews: [[]], claim });
      expect(verdict.valid).toBe(false);
      expect(verdict.superseded === true).toBe(false);
    }
    // Stessi campi malformati anche con HEAD/revision/review che non combaciano.
    const s = snapshot();
    const moved = { ...s, pr: { ...s.pr, head: { sha: NEXT }, body: `${prBody}\nedit` } };
    for (const claim of [
      { ...s.claim, headSha: 'nope' },
      { ...s.claim, reviewRevision: '' },
      { ...s.claim, reviewRevision: 'body:zz' },
      { ...s.claim, eventKey: 'review:0' },
      { ...s.claim, verdictKey: '' },
    ]) {
      const verdict = validateRedflagClaimSnapshot({ ...moved, claim });
      expect(verdict.valid).toBe(false);
      expect(verdict.superseded === true, JSON.stringify(claim)).toBe(false);
    }
  });

  it('la CLI verify esporta claim_superseded=true su HEAD cambiata', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'redflag-claim-verify-'));
    try {
      const revision = reviewInputRevisionFromPullRequest({ body: prBody });
      const context = {
        workflow: 'redflag', prNumber: '9959', headSha: HEAD, eventKey: 'review:42',
        verdictKey: 'findings:x', reviewRevision: revision,
      };
      const event = {
        version: 1, token: 'tok', ...context,
        key: prFixClaimKey(context), dedupeKey: prFixClaimDedupeKey(context),
        state: 'active', issuedAt: 1, expiresAt: 4_000_000_000, runId: '',
      };
      writeFileSync(path.join(dir, 'comments.json'), JSON.stringify([[{
        id: 1, user: { login: 'github-actions[bot]' }, body: `<!-- PR_FIX_CLAIM: ${JSON.stringify(event)} -->\n`,
      }]]));
      writeFileSync(path.join(dir, 'pr.json'), JSON.stringify({ state: 'open', body: prBody, head: { sha: NEXT } }));
      writeFileSync(path.join(dir, 'reviews.json'), JSON.stringify([[]]));
      const gh = fakeBin(dir, 'gh', `case "$*" in
  *issues/9959/comments*) cat "${dir}/comments.json" ;;
  *pulls/9959/reviews*) cat "${dir}/reviews.json" ;;
  *pulls/9959*) cat "${dir}/pr.json" ;;
  *) exit 9 ;;
esac`);
      const out = path.join(dir, 'out');
      writeFileSync(out, '');
      const r = spawnSync(process.execPath, [path.join(ROOT, 'scripts/ci/pr-fixer-claim.mjs'), '--claim'], {
        encoding: 'utf8',
        env: {
          PATH: process.env.PATH, TRUSTED_GH_BIN: gh, GITHUB_OUTPUT: out, GH_REPO: 'o/r',
          CLAIM_ACTION: 'verify', CLAIM_KIND: 'redflag', PR_NUMBER: '9959', HEAD_SHA: HEAD,
          REVIEW_REVISION: revision, EVENT_KEY: 'review:42', VERDICT_KEY: 'findings:x', CLAIM_TOKEN: 'tok',
        },
      });
      const written = readFileSync(out, 'utf8');
      expect(written, r.stdout + r.stderr).toContain('claim_superseded=true\n');
      expect(written).toContain('claim_valid=false\n');
      expect(written).toContain('claim_reason=HEAD cambiata dopo il claim\n');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  for (const [name, id] of [
    ['Stop when redflag claim changed before model', 'claim_verify'],
    ['Stop when final redflag claim changed before model', 'claim_verify_final'],
  ] as const) {
    const s = step('redflag-fix', name);

    function runStop(superseded: string) {
      const dir = mkdtempSync(path.join(tmpdir(), 'redflag-claim-stop-'));
      try {
        const env = path.join(dir, 'env');
        const out = path.join(dir, 'out');
        writeFileSync(env, '');
        writeFileSync(out, '');
        const r = spawnSync('bash', ['-e', '-c', s.run], {
          encoding: 'utf8',
          env: {
            PATH: process.env.PATH, GITHUB_ENV: env, GITHUB_OUTPUT: out,
            CLAIM_SUPERSEDED: superseded, CLAIM_REASON: 'HEAD cambiata dopo il claim',
          },
        });
        return { ...r, env: readFileSync(env, 'utf8'), out: readFileSync(out, 'utf8') };
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    }

    it(`${name}: legge claim_superseded dal proprio verify`, () => {
      expect(s.env.CLAIM_SUPERSEDED).toBe(`\${{ steps.${id}.outputs.claim_superseded }}`);
    });

    it(`${name}: sostituzione → notice + exit 0 + claim rilasciato`, () => {
      const r = runStop('true');
      expect(r.status, r.stderr).toBe(0);
      expect(r.stdout).toContain('::notice::run sostituita (HEAD cambiata dopo il claim)');
      expect(r.stdout).not.toContain('::error::');
      expect(r.env).toBe('CLAIM_STATUS=released\n');
    });

    it(`${name}: claim non sostituito resta rosso`, () => {
      for (const value of ['false', '']) {
        const r = runStop(value);
        expect(r.status).toBe(1);
        expect(r.stdout).toContain('::error::');
        expect(r.env).toBe('');
      }
    });
  }

  it('dopo lo stop finale sostituito non gira nessun lavoro a valle', () => {
    expect(step('redflag-fix', 'Stop when final redflag claim changed before model').id).toBe('final_claim_stop');
    for (const name of [
      'Advance HEAD after a PR-body fix (un body nuovo non è rivedibile senza un commit)',
      'Publish the per-finding response (zero-Claude)',
      'Classify outcome (work-done, not CLI exit)',
    ]) {
      expect(String(step('redflag-fix', name).if), name)
        .toContain("steps.final_claim_stop.outputs.superseded != 'true'");
    }
  });
});

describe('3. push respinto: un altro writer ha avanzato il branch', () => {
  const BRANCH = 'fix/issue-9312';

  function setup(stepName: string, { otherWriter }: { otherWriter: boolean }) {
    const run = step('redflag-fix', stepName).run as string;
    const dir = mkdtempSync(path.join(tmpdir(), 'redflag-push-race-'));
    const remote = path.join(dir, 'remote.git');
    const repo = path.join(dir, 'repo');
    const other = path.join(dir, 'other');
    const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
    const ident = ['-c', 'user.name=Valerie Linc', '-c', 'user.email=valerielinc@gmail.com'];
    execFileSync('git', ['init', '-q', '--bare', remote]);
    mkdirSync(repo);
    git(repo, 'init', '-q');
    git(repo, 'config', 'user.name', 'Valerie Linc');
    git(repo, 'config', 'user.email', 'valerielinc@gmail.com');
    writeFileSync(path.join(repo, 'a.txt'), 'a\n');
    git(repo, 'add', 'a.txt');
    git(repo, 'commit', '-q', '-m', 'base');
    git(repo, 'remote', 'add', 'origin', remote);
    git(repo, 'push', '-q', 'origin', `HEAD:refs/heads/${BRANCH}`);
    const start = git(repo, 'rev-parse', 'HEAD');
    let otherSha = '';
    if (otherWriter) {
      // pr-autorebase fa il merge di main e pusha mentre il round lavora.
      execFileSync('git', ['clone', '-q', '-b', BRANCH, remote, other]);
      writeFileSync(path.join(other, 'main.txt'), 'main\n');
      git(other, 'add', 'main.txt');
      git(other, ...ident, 'commit', '-q', '-m', 'Merge origin/main (autorebase)');
      git(other, 'push', '-q', 'origin', `HEAD:${BRANCH}`);
      otherSha = git(other, 'rev-parse', 'HEAD');
    } else {
      // Remoto invariato ma push rifiutato comunque: hook che respinge.
      writeFileSync(path.join(remote, 'hooks', 'pre-receive'), '#!/bin/sh\necho rejected-by-hook >&2\nexit 1\n');
      chmodSync(path.join(remote, 'hooks', 'pre-receive'), 0o755);
    }
    const temp = path.join(dir, 'tmp');
    mkdirSync(temp);
    writeFileSync(path.join(temp, 'redflag-response.md'), '- `a.mjs:L1` — disputed: già coperto.\n');
    const gh = fakeBin(dir, 'gh', `case "$*" in
  *"pulls/9959 --jq"*) echo "body rewritten" ;;
  *comments*) echo "" ;;
esac`);
    const output = path.join(dir, 'out');
    writeFileSync(output, '');
    const r = spawnSync('bash', ['-c', run], {
      cwd: repo,
      encoding: 'utf8',
      env: {
        ...process.env, TRUSTED_GH_BIN: gh, REPO: 'o/r', PR_NUMBER: '9959', HEAD_REF: BRANCH,
        START_SHA: start, BASE_SHA: start, BASE_BODY_DIGEST: 'f'.repeat(64), BODY_ONLY: 'true',
        FIX_ROUND: '1', REVIEW_ID: '1', RUNNER_TEMP: temp, GITHUB_OUTPUT: output,
      },
    });
    const remoteHead = git(remote, 'rev-parse', BRANCH);
    const out = readFileSync(output, 'utf8');
    rmSync(dir, { recursive: true, force: true });
    return { r, out, remoteHead, otherSha, start };
  }

  for (const name of [
    'Advance HEAD after a PR-body fix (un body nuovo non è rivedibile senza un commit)',
    'Publish the per-finding response (zero-Claude)',
  ]) {
    it(`${name}: branch avanzato da un altro writer → notice + by-other-writer + exit 0`, () => {
      const { r, out, remoteHead, otherSha } = setup(name, { otherWriter: true });
      expect(r.status, r.stdout + r.stderr).toBe(0);
      expect(r.stdout).toContain('::notice::run sostituita');
      expect(r.stdout).not.toContain('::error::');
      expect(out).toContain('advanced=by-other-writer\n');
      // Niente escalation needs-human per una corsa benigna.
      expect(r.stdout).not.toContain('needs-human');
      expect(remoteHead).toBe(otherSha);
    });

    it(`${name}: remoto invariato → il push fallito resta rosso`, () => {
      const { r, out, remoteHead, start } = setup(name, { otherWriter: false });
      expect(r.status).toBe(1);
      expect(r.stdout).toContain('::error::Push del commit');
      expect(out).not.toContain('by-other-writer');
      expect(remoteHead).toBe(start);
    });
  }

  it('entrambi gli step ricevono la baseline remota del round', () => {
    for (const name of [
      'Advance HEAD after a PR-body fix (un body nuovo non è rivedibile senza un commit)',
      'Publish the per-finding response (zero-Claude)',
    ]) {
      expect(step('redflag-fix', name).env.START_SHA).toBe('${{ steps.align.outputs.start_sha }}');
    }
  });
});
