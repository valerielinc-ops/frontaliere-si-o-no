// Loop autorebase ↔ 🔴-fixer su PR `needs-human` (misurato su #9959: 45 merge
// di main in 24h → 43 review Codex, ~27% dei minuti CI del sito).
//
// Due difetti di `pr-autorebase.mjs`, entrambi chiusi qui:
//  (a) un `## LGTM` su QUALUNQUE commit passato rendeva la PR «quasi pronta»
//      per sempre, anche con un 🔴 su ogni HEAD successiva; col vitest rosso
//      del gate di review `rebaseActionForLgtmPr` rispondeva `rebase` a ogni
//      avanzamento di main;
//  (b) `needs-human` non fermava il rebase nemmeno con un ultimo verdetto
//      bloccante: ogni merge di main produceva una HEAD nuova, una review
//      nuova e un altro «round 1/3» del 🔴-fixer.
import { describe, expect, it } from 'vitest';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  isTerminalReviewState,
  latestReviewerVerdict,
  latestReviewerSnapshot,
  needsHumanBlocksAutorebase,
  reviewerSnapshotChanged,
} from '../scripts/ci/pr-autorebase.mjs';

const HEAD = 'a'.repeat(40);
const OLD = 'b'.repeat(40);
const BOT = { login: 'frontaliere-automation[bot]', type: 'Bot' };
const AUTOREBASE_SOURCE = readFileSync(new URL('../scripts/ci/pr-autorebase.mjs', import.meta.url), 'utf8');
const PROCESS_PR = AUTOREBASE_SOURCE.slice(AUTOREBASE_SOURCE.indexOf('async function processPR(pr) {'));

const review = (body: string, commit: string, at: string, user = BOT, state = 'COMMENTED') => ({
  user, body, commit_id: commit, submitted_at: at, state,
});
const LGTM = '## Findings (Important: 0)\n\n## LGTM';
const RED = 'scripts/x.mjs:L3: 🔴 Important: rotto';

describe('latestReviewerVerdict: conta solo l\'ultima review del reviewer', () => {
  it('un LGTM vecchio non vale contro un 🔴 sulla HEAD corrente (#9959)', () => {
    expect(latestReviewerVerdict([
      review(LGTM, OLD, '2026-09-26T10:00:00Z'),
      review(RED, HEAD, '2026-09-27T10:00:00Z'),
    ], HEAD)).toBe('blocking');
  });

  it('la review sulla HEAD corrente prevale anche su una più recente altrove', () => {
    expect(latestReviewerVerdict([
      review(LGTM, HEAD, '2026-09-27T09:00:00Z'),
      review(RED, OLD, '2026-09-27T10:00:00Z'),
    ], HEAD)).toBe('lgtm');
  });

  it('senza review sulla HEAD vale la più recente in assoluto', () => {
    expect(latestReviewerVerdict([
      review(RED, OLD, '2026-09-26T10:00:00Z'),
      review(LGTM, 'c'.repeat(40), '2026-09-27T10:00:00Z'),
    ], HEAD)).toBe('lgtm');
    expect(latestReviewerVerdict([
      review(LGTM, OLD, '2026-09-26T10:00:00Z'),
      review(RED, 'c'.repeat(40), '2026-09-27T10:00:00Z'),
    ], HEAD)).toBe('blocking');
  });

  it('ordina per submitted_at, non per posizione nella risposta', () => {
    expect(latestReviewerVerdict([
      review(RED, HEAD, '2026-09-27T12:00:00Z'),
      review(LGTM, HEAD, '2026-09-27T08:00:00Z'),
    ], HEAD)).toBe('blocking');
  });

  it('ignora le review umane e distingue none/unknown', () => {
    const human = { login: 'valerielinc-ops', type: 'User' };
    expect(latestReviewerVerdict([
      review(LGTM, HEAD, '2026-09-27T08:00:00Z'),
      review('## LGTM', HEAD, '2026-09-27T12:00:00Z', human),
      review(RED, HEAD, '2026-09-27T13:00:00Z', human),
    ], HEAD)).toBe('lgtm');
    expect(latestReviewerVerdict([review(LGTM, HEAD, '2026-09-27T08:00:00Z', human)], HEAD)).toBe('none');
    expect(latestReviewerVerdict([], HEAD)).toBe('none');
    expect(latestReviewerVerdict(null, HEAD)).toBe('unknown');
  });

  it('ignora PENDING e DISMISSED prima di scegliere il verdetto terminale', () => {
    expect(isTerminalReviewState('COMMENTED')).toBe(true);
    expect(isTerminalReviewState('APPROVED')).toBe(true);
    expect(isTerminalReviewState('CHANGES_REQUESTED')).toBe(true);
    expect(isTerminalReviewState('PENDING')).toBe(false);
    expect(isTerminalReviewState('DISMISSED')).toBe(false);
    expect(latestReviewerVerdict([
      review(LGTM, HEAD, '2026-09-27T08:00:00Z'),
      review(RED, HEAD, '2026-09-27T12:00:00Z', BOT, 'PENDING'),
    ], HEAD)).toBe('lgtm');
    expect(latestReviewerVerdict([
      review(RED, HEAD, '2026-09-27T08:00:00Z'),
      review(LGTM, HEAD, '2026-09-27T12:00:00Z', BOT, 'DISMISSED'),
    ], HEAD)).toBe('blocking');
    expect(latestReviewerVerdict([
      review(LGTM, HEAD, '2026-09-27T08:00:00Z', BOT, 'PENDING'),
    ], HEAD)).toBe('unknown');
  });

  it('rileva anche una nuova review con lo stesso verdetto durante il TOCTOU', () => {
    const before = latestReviewerSnapshot([review(RED, HEAD, '2026-09-27T08:00:00Z')], HEAD);
    const after = latestReviewerSnapshot([
      review(RED, HEAD, '2026-09-27T08:00:00Z'),
      review(RED, HEAD, '2026-09-27T09:00:00Z'),
    ], HEAD);
    expect(before.verdict).toBe('blocking');
    expect(after.verdict).toBe('blocking');
    expect(reviewerSnapshotChanged(before, after)).toBe(true);
  });
});

describe('needsHumanBlocksAutorebase: veto solo con un verdetto bloccante', () => {
  it('needs-human + ultimo verdetto bloccante (o illeggibile) → nessun rebase', () => {
    expect(needsHumanBlocksAutorebase({ labels: ['needs-human'], verdict: 'blocking' })).toBe(true);
    expect(needsHumanBlocksAutorebase({ labels: [{ name: 'needs-human' }], verdict: 'blocking' })).toBe(true);
    expect(needsHumanBlocksAutorebase({ labels: ['needs-human'], verdict: 'unknown' })).toBe(true);
  });

  it('la label da sola resta tracking: il rosso ereditato va ancora ri-testato (#6253)', () => {
    expect(needsHumanBlocksAutorebase({ labels: ['needs-human'], verdict: 'none' })).toBe(false);
    expect(needsHumanBlocksAutorebase({ labels: ['needs-human'], verdict: 'lgtm' })).toBe(false);
    expect(needsHumanBlocksAutorebase({ labels: ['stale-review'], verdict: 'blocking' })).toBe(false);
  });
});

describe('processPR: il veto precede ogni scrittura sul branch', () => {
  function runSweep(labels: string[], reviews: unknown[]) {
    const fakeBin = mkdtempSync(join(tmpdir(), 'pr-autorebase-verdict-'));
    const callLog = join(fakeBin, 'calls.log');
    const reviewsFile = join(fakeBin, 'reviews.json');
    const script = fileURLToPath(new URL('../scripts/ci/pr-autorebase.mjs', import.meta.url));
    const pullRequests = JSON.stringify([[{
      number: 1,
      draft: false,
      head: { ref: 'fix/1', sha: HEAD },
      labels: labels.map((name) => ({ name })),
    }]]);
    writeFileSync(callLog, '');
    writeFileSync(reviewsFile, JSON.stringify(reviews));
    writeFileSync(join(fakeBin, 'gh'), `#!/bin/sh
printf 'gh %s\\n' "$*" >> "$CALL_LOG"
case "$*" in
  *'pulls?state=open&per_page=100'*) printf '%s\\n' '${pullRequests}';;
  *'compare/main...'*) printf '1\\n';;
  *'/check-runs?per_page=100'*) printf '%s\\n' '{"check_runs":[]}';;
  *'/actions/workflows/tests.yml/runs?'*) printf '%s\\n' '{"workflow_runs":[]}';;
  *'/pulls/1/reviews'*) cat "$REVIEWS_FILE";;
  *'/pulls/1'*) printf '%s\\n' '{"body":"","head":{"sha":"${HEAD}"}}';;
  *'/issues/1/comments'*) printf '[]\\n';;
  *) printf '%s\\n' '[]';;
esac
`);
    // fetch e merge-tree puliti: la rilevazione conflitti passa e si arriva
    // davvero al punto di decisione del rebase.
    writeFileSync(join(fakeBin, 'git'), `#!/bin/sh
printf 'git %s\\n' "$*" >> "$CALL_LOG"
exit 0
`);
    chmodSync(join(fakeBin, 'gh'), 0o755);
    chmodSync(join(fakeBin, 'git'), 0o755);
    try {
      const result = spawnSync(process.execPath, [script], {
        encoding: 'utf8',
        env: {
          ...process.env,
          PATH: `${fakeBin}:${process.env.PATH ?? ''}`,
          CALL_LOG: callLog,
          REVIEWS_FILE: reviewsFile,
          GITHUB_REPOSITORY: 'owner/repo',
          GH_TOKEN: 'test-token',
          GITHUB_RUN_NUMBER: '1',
        },
      });
      return { result, out: `${result.stdout}${result.stderr}`, calls: readFileSync(callLog, 'utf8') };
    } finally {
      rmSync(fakeBin, { recursive: true, force: true });
    }
  }

  const noWrites = (calls: string) => {
    expect(calls).not.toMatch(/gh (pr (comment|close|reopen|update-branch)|workflow run)/);
    expect(calls).not.toMatch(/git .*\b(checkout|reset|commit|push)\b|git merge\s/);
  };

  it('needs-human + 🔴 sulla HEAD: notice e nessun rebase, anche con stale-review', () => {
    const r = runSweep(['needs-human', 'stale-review'], [
      review(LGTM, OLD, '2026-09-26T10:00:00Z'),
      review(RED, HEAD, '2026-09-27T10:00:00Z'),
    ]);
    expect(r.result.status, r.out).toBe(0);
    expect(r.out).toMatch(/::notice::PR #1 needs-human con ultimo verdetto del reviewer blocking/);
    noWrites(r.calls);
  });

  it('un LGTM vecchio non rende più la PR near-merge', () => {
    const r = runSweep([], [
      review(LGTM, OLD, '2026-09-26T10:00:00Z'),
      review(RED, HEAD, '2026-09-27T10:00:00Z'),
    ]);
    expect(r.result.status, r.out).toBe(0);
    expect(r.out).toMatch(/PR #1 non near-merge/);
    expect(r.out).not.toMatch(/needs-human con ultimo verdetto/);
    noWrites(r.calls);
  });

  it('needs-human senza verdetto bloccante non introduce il veto', () => {
    const r = runSweep(['needs-human'], []);
    expect(r.result.status, r.out).toBe(0);
    expect(r.out).not.toMatch(/needs-human con ultimo verdetto/);
    expect(r.out).toMatch(/PR #1 non near-merge/);
  });

  it('rilegge il verdetto terminale subito prima del push e può fare reset senza pubblicare il merge locale', () => {
    const merge = PROCESS_PR.lastIndexOf("git(['merge', '--no-edit', 'origin/main'], { allowFail: true });");
    const reread = PROCESS_PR.lastIndexOf('const reviewerBeforePush = readReviewerSnapshot(num, head);');
    const push = PROCESS_PR.lastIndexOf('const pushed = pushBranch(branch);');
    expect(merge).toBeGreaterThan(-1);
    expect(reread).toBeGreaterThan(merge);
    expect(reread).toBeLessThan(push);
    expect(PROCESS_PR.slice(reread, push)).toContain('reviewerSnapshotChanged');
    expect(PROCESS_PR.slice(reread, push)).toContain("git(['reset', '--hard', head]");
  });
});
