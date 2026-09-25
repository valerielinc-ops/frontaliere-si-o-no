import { describe, expect, it } from 'vitest';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { execFileSync, spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import YAML from 'yaml';
import {
  claimStatusFromOutcome,
  activeClaimsForArbitration,
  latestPrFixClaims,
  parsePrFixClaim,
  prFixClaimDecision,
  prFixClaimDedupeKey,
  prFixClaimKey,
  normalizedSignal,
  releaseClaimEvent,
  redflagFindingsFingerprint,
  runIsFinished,
  validateRedflagClaimSnapshot,
} from '../scripts/ci/pr-fixer-claim.mjs';
import {
  parseReviewsJson,
} from '../scripts/ci/lib/pr-review-admission.mjs';
import {
  reviewInputMarker,
  reviewInputRevisionFromBody,
} from '../scripts/ci/lib/review-input-revision.mjs';

const HEAD = 'a'.repeat(40);
const NEXT_HEAD = 'b'.repeat(40);
const REVIEW_REVISION = `body:${'c'.repeat(64)}`;

function claim(overrides: Record<string, unknown> = {}) {
  const context = {
    workflow: 'redflag',
    prNumber: '8362',
    headSha: HEAD,
    reviewRevision: REVIEW_REVISION,
    eventKey: 'review:42',
    verdictKey: 'findings:' + 'c'.repeat(64),
  };
  const key = prFixClaimKey(context);
  const dedupeKey = prFixClaimDedupeKey(context);
  return {
    version: 1,
    token: 'claim-token',
    ...context,
    key,
    dedupeKey,
    state: 'active',
    issuedAt: 100,
    expiresAt: 3_700,
    runId: '77',
    ...overrides,
  };
}

function comment(event: Record<string, unknown>, id = 1) {
  return {
    id,
    created_at: '1970-01-01T00:02:00Z',
    user: { login: 'github-actions[bot]' },
    body: `<!-- PR_FIX_CLAIM: ${JSON.stringify(event)} -->`,
  };
}

describe('persisted PR fixer claims (#8362, #8363)', () => {
  it('keys the exact PR + HEAD + event/verdict, while deduping retries of one verdict', () => {
    const base = {
      workflow: 'redflag',
      prNumber: '8362',
      headSha: HEAD,
      reviewRevision: REVIEW_REVISION,
      verdictKey: 'findings:' + 'c'.repeat(64),
    };
    const first = prFixClaimKey({ ...base, eventKey: 'review:42' });
    const retry = prFixClaimKey({ ...base, eventKey: 'review:43' });
    const otherHead = prFixClaimKey({ ...base, headSha: NEXT_HEAD, eventKey: 'review:42' });

    expect(first).not.toBe('');
    expect(retry).not.toBe(first);
    expect(prFixClaimDedupeKey({ ...base, eventKey: 'review:42' }))
      .toBe(prFixClaimDedupeKey({ ...base, eventKey: 'review:43' }));
    expect(otherHead).not.toBe(first);
    expect(prFixClaimKey({ ...base, verdictKey: '' })).toBe('');
  });

  it('keeps failed-check names with commas distinct from a check list', () => {
    const singleCheck = prFixClaimDedupeKey({
      workflow: 'redcheck',
      prNumber: '8363',
      headSha: HEAD,
      eventKey: 'tests-run:1',
      verdictKey: 'failed-checks:lint, type',
    });
    const twoChecks = prFixClaimDedupeKey({
      workflow: 'redcheck',
      prNumber: '8363',
      headSha: HEAD,
      eventKey: 'tests-run:1',
      verdictKey: 'failed-checks:lint,type',
    });
    const jsonChecks = normalizedSignal('failed-checks:["type","lint"]');

    expect(singleCheck).not.toBe(twoChecks);
    expect(jsonChecks).toBe('failed-checks:["lint","type"]');
  });

  it('keeps the redflag fingerprint stable when review newlines were serialized literally', () => {
    const body = '## Findings (Important: 1, Nit: 0)\n\n🔴 Important: stale parser.';
    expect(redflagFindingsFingerprint(body.replace(/\n/gu, '\\n')))
      .toBe(redflagFindingsFingerprint(body));
  });

  it('rejects a forged or malformed persisted marker', () => {
    expect(parsePrFixClaim('<!-- PR_FIX_CLAIM: {"version":1} -->')).toBeNull();
    expect(parsePrFixClaim('ordinary PR comment')).toBeNull();
    expect(parsePrFixClaim(`<!-- PR_FIX_CLAIM: ${JSON.stringify(claim())} -->`))
      .toMatchObject({ workflow: 'redflag', prNumber: '8362', headSha: HEAD });
  });

  it('parses legacy redflag markers as history without allowing reuse under the new body key', () => {
    const legacy = { ...claim() } as Record<string, unknown>;
    delete legacy.reviewRevision;
    legacy.key = prFixClaimKey({
      workflow: 'redflag', prNumber: '8362', headSha: HEAD,
      eventKey: 'review:42', verdictKey: String(legacy.verdictKey),
    }) || 'legacy-key';
    legacy.dedupeKey = 'legacy-dedupe';
    const parsed = parsePrFixClaim(`<!-- PR_FIX_CLAIM: ${JSON.stringify(legacy)} -->`);
    expect(parsed).toMatchObject({ legacyRedflag: true, reviewRevision: '' });
    expect(prFixClaimDecision({
      key: String(claim().key),
      dedupeKey: String(claim().dedupeKey),
      claims: parsed ? [parsed] : [],
    })).toMatchObject({ allowed: true });
  });

  it('binds the final redflag admission to PR body revision, HEAD and review id', () => {
    const prBody = 'body before the fixer';
    const revision = reviewInputRevisionFromBody(prBody);
    const reviewBody = `${reviewInputMarker(revision)}\n## Findings (Important: 1, Nit: 0)\n\n🔴 Important: stale parser.`;
    const context = {
      workflow: 'redflag',
      prNumber: '8362',
      headSha: HEAD,
      reviewRevision: revision,
      eventKey: 'review:42',
      verdictKey: `findings:${redflagFindingsFingerprint(reviewBody)}`,
    };
    const current = {
      version: 1,
      token: 'verify-token',
      ...context,
      key: prFixClaimKey(context),
      dedupeKey: prFixClaimDedupeKey(context),
      state: 'active',
      issuedAt: 100,
      expiresAt: 3_700,
    };
    const snapshot = {
      pr: { state: 'open', body: prBody, head: { sha: HEAD } },
      reviews: [[{
        id: 42,
        user: { type: 'Bot', login: 'frontaliere-automation[bot]' },
        state: 'COMMENTED',
        commit_id: HEAD,
        body: reviewBody,
      }]],
      claim: current,
    };
    expect(validateRedflagClaimSnapshot(snapshot)).toMatchObject({ valid: true });
    expect(validateRedflagClaimSnapshot({
      ...snapshot,
      pr: { ...snapshot.pr, body: 'body changed before the model' },
    })).toMatchObject({ valid: false, reason: expect.stringMatching(/body revision/i) });
    expect(validateRedflagClaimSnapshot({
      ...snapshot,
      reviews: [[{ ...snapshot.reviews[0][0], id: 43 }]],
    })).toMatchObject({ valid: false, reason: expect.stringMatching(/review del claim/i) });
  });

  it('validates raw paginated review API pages before claim consumption', () => {
    const rawApi = JSON.stringify([[
      {
        id: 42,
        user: { type: 'Bot', login: 'frontaliere-automation[bot]' },
        state: 'COMMENTED',
        commit_id: HEAD,
        body: 'review body',
      },
    ]]);
    expect(parseReviewsJson(rawApi)).toEqual(JSON.parse(rawApi));
    expect(parseReviewsJson(JSON.stringify([[{ id: 42, user: { login: 'bot' } }]]))).toBeNull();
    expect(parseReviewsJson(JSON.stringify([[{ id: 42, user: { type: 'Bot', login: 'bot' }, state: 'UNKNOWN', commit_id: HEAD, body: '' }]]))).toBeNull();
  });

  it('requires a body revision for redflag keys while leaving redcheck keys independent', () => {
    const base = {
      workflow: 'redflag',
      prNumber: '8362',
      headSha: HEAD,
      eventKey: 'review:42',
      verdictKey: 'findings:' + 'c'.repeat(64),
    };
    expect(prFixClaimKey(base)).toBe('');
    expect(prFixClaimDedupeKey(base)).toBe('');
    expect(prFixClaimKey({ ...base, workflow: 'redcheck' })).not.toBe('');
  });

  it('blocks active duplicates, skips terminal duplicates, and re-arms only transient retries', () => {
    const active = claim();
    const key = String(active.key);
    const dedupeKey = String(active.dedupeKey);

    expect(prFixClaimDecision({
      key,
      dedupeKey,
      claims: [active],
      nowSec: 200,
      activeRunStates: { '77': { status: 'in_progress', conclusion: null } },
    })).toMatchObject({ allowed: false, reason: 'same-pr-head-claim-active' });

    expect(prFixClaimDecision({
      key,
      dedupeKey,
      claims: [claim({ state: 'completed' })],
      nowSec: 200,
    })).toMatchObject({ allowed: false, reason: 'same-pr-head-terminal-claim' });

    expect(prFixClaimDecision({
      key,
      dedupeKey,
      claims: [claim({ state: 'failed-transient' })],
      nowSec: 200,
    })).toMatchObject({ allowed: true, reason: 'same-pr-head-claim-retryable' });

    expect(prFixClaimDecision({
      key,
      dedupeKey,
      claims: [active],
      nowSec: 200,
      activeRunStates: { '77': { status: 'completed', conclusion: 'cancelled' } },
    })).toMatchObject({ allowed: true, reason: 'same-pr-head-claim-retryable' });

    expect(prFixClaimDecision({
      key,
      dedupeKey,
      claims: [active],
      nowSec: 200,
      activeRunStates: { '77': { status: 'completed', conclusion: 'success' } },
    })).toMatchObject({ allowed: false, reason: 'same-pr-head-claim-active' });
  });

  it('lets a new claim arbitrate past a finished retryable runner', () => {
    const old = claim({ token: 'old', runId: 'old-run' });
    const newcomer = claim({ token: 'new', runId: 'new-run' });

    expect(activeClaimsForArbitration([old, newcomer], {
      nowSec: 200,
      activeRunStates: {
        'old-run': { status: 'completed', conclusion: 'failure' },
        'new-run': { status: 'in_progress', conclusion: null },
      },
    }).map((item) => item.token)).toEqual(['new']);
  });

  it('treats startup failure as a retryable runner conclusion', () => {
    expect(runIsFinished({ status: 'completed', conclusion: 'startup_failure' })).toBe(true);
  });

  it('releases a locally posted loser even when its active marker is not yet visible', () => {
    const local = claim({ token: 'locally-posted-loser' });

    expect(releaseClaimEvent({ localClaim: local, issuedAt: 500 })).toMatchObject({
      token: 'locally-posted-loser',
      state: 'released',
      issuedAt: 500,
    });
    expect(releaseClaimEvent({ ownClaim: null, localClaim: { ...local, state: 'completed' }, issuedAt: 500 }))
      .toBeNull();
  });

  it('keeps the latest state per token and does not mix a new HEAD or verdict', () => {
    const first = claim();
    const finalized = claim({ state: 'completed' });
    const newHead = claim({
      token: 'new-head-token',
      headSha: NEXT_HEAD,
      eventKey: 'review:44',
      verdictKey: 'findings:' + 'd'.repeat(64),
      key: prFixClaimKey({
        workflow: 'redflag', prNumber: '8362', headSha: NEXT_HEAD,
        reviewRevision: REVIEW_REVISION,
        eventKey: 'review:44', verdictKey: 'findings:' + 'd'.repeat(64),
      }),
      dedupeKey: prFixClaimDedupeKey({
        workflow: 'redflag', prNumber: '8362', headSha: NEXT_HEAD,
        reviewRevision: REVIEW_REVISION,
        eventKey: 'review:44', verdictKey: 'findings:' + 'd'.repeat(64),
      }),
    });
    const comments = [comment(first, 10), comment(finalized, 11), comment(newHead, 12)];
    const claims = latestPrFixClaims(comments);

    expect(claims).toHaveLength(2);
    expect(claims.find((item) => item.headSha === HEAD)?.state).toBe('completed');
    expect(claims.find((item) => item.headSha === NEXT_HEAD)?.state).toBe('active');
  });

  it('classifies a transient action failure without weakening the round cap', () => {
    expect(claimStatusFromOutcome({ proceed: false })).toBe('released');
    expect(claimStatusFromOutcome({ proceed: true, claudeOutcome: 'cancelled' }))
      .toBe('failed-transient');
    expect(claimStatusFromOutcome({ proceed: true, claudeOutcome: '' }))
      .toBe('failed-transient');
    expect(claimStatusFromOutcome({ proceed: true, claudeOutcome: 'skipped' }))
      .toBe('failed-transient');
    expect(claimStatusFromOutcome({
      proceed: true,
      claudeOutcome: 'failure',
      executionText: '{"is_error":true,"api_error_status":429}',
    })).toBe('failed-transient');
    expect(claimStatusFromOutcome({
      proceed: true,
      claudeOutcome: 'failure',
      executionText: '{"is_error":true,"status_code":500}',
    })).toBe('failed-transient');
    expect(claimStatusFromOutcome({ proceed: true, claudeOutcome: 'failure' }))
      .toBe('failed-terminal');
    expect(claimStatusFromOutcome({ proceed: true, claudeOutcome: 'success' }))
      .toBe('completed');
  });
});

describe('workflow wiring for the two site PR fixer consumers', () => {
  const redflag = readFileSync(new URL('../.github/workflows/pr-redflag-fixer.yml', import.meta.url), 'utf8');
  const redcheck = readFileSync(new URL('../.github/workflows/pr-redcheck-fixer.yml', import.meta.url), 'utf8');
  const claimSource = readFileSync(new URL('../scripts/ci/pr-fixer-claim.mjs', import.meta.url), 'utf8');

  it('persists a redflag claim before the bounded fixer and finalizes it', () => {
    expect(redflag).toContain('node "$TRUSTED_POLICY_ROOT/scripts/ci/pr-fixer-claim.mjs" --claim');
    expect(redflag).toContain('CLAIM_KIND: redflag');
    expect(redflag).toContain('EVENT_KEY: review:');
    expect(redflag).toContain('REVIEW_BODY:');
    expect(redflag).toContain('CLAIM_ACTION: verify');
    expect(redflag).toContain('claim_verify.outputs.claim_valid');
    expect(redflag).toContain('Revalidate redflag claim before model');
    expect(redflag).toContain('Revalidate redflag claim immediately before model');
    expect(redflag).toContain('claim_verify_final.outputs.claim_valid');
    expect(redflag).toContain('Refresh trusted fixer policy after model');
    expect(claimSource).toContain("parseReviewsJson(raw)");
    expect(claimSource).toContain('TRUSTED_GH_BIN');
    expect(claimSource).not.toContain("execFileSync('gh'");
    expect(redflag).toContain(
      'TRUSTED_POLICY_ROOT: ${{ steps.trusted_policy_final.outputs.root }}\n          TRUSTED_GH_BIN: ${{ steps.trusted_gh.outputs.path }}',
    );
    expect(redflag).toContain(
      'TRUSTED_POLICY_ROOT: ${{ steps.trusted_policy_claim_final.outputs.root }}\n          TRUSTED_GH_BIN: ${{ steps.trusted_gh.outputs.path }}',
    );
    expect(redflag).toContain(
      'TRUSTED_POLICY_ROOT: ${{ steps.trusted_policy_post_model.outputs.root }}\n          TRUSTED_GH_BIN: ${{ steps.trusted_gh.outputs.path }}',
    );
    expect(redflag).toContain('claim_error');
    // Cap del 🔴-fixer: 3 round per PR dal 2026-09-25 (il ❌-check fixer resta a 2).
    expect(redflag).toContain('MAX_ROUNDS=3');
    expect(redflag).toContain('CLAIM_ACTION: finalize');
  });

  it('persists a redcheck claim on the current failed check set', () => {
    expect(redcheck).toContain('head_sha: ${{ steps.pre.outputs.head_sha }}');
    expect(redcheck).toContain('failed_check_key: ${{ steps.pre.outputs.failed_check_key }}');
    expect(redcheck).toContain('node "$TRUSTED_POLICY_ROOT/scripts/ci/pr-fixer-claim.mjs" --claim');
    expect(redcheck).toContain('CLAIM_KIND: redcheck');
    expect(redcheck).toContain('CHECK_FAILURE_KEY:');
    expect(redcheck).toContain('claim_error');
    expect(redcheck).toContain('MAX_ROUNDS=2');
    expect(redcheck).toContain('CLAIM_ACTION: finalize');
    expect(redcheck).toContain('Bootstrap trusted redcheck policy (no PR code)');
    expect(redcheck).toContain('Refresh trusted redcheck policy before finalize');
    expect(redcheck).toContain('TRUSTED_POLICY_ROOT: ${{ steps.trusted_policy_final.outputs.root }}');
    expect(redcheck).toContain(
      'TRUSTED_POLICY_ROOT: ${{ steps.trusted_policy.outputs.root }}\n          TRUSTED_GH_BIN: ${{ steps.trusted_gh.outputs.path }}',
    );
    expect(redcheck).toContain(
      'TRUSTED_POLICY_ROOT: ${{ steps.trusted_policy_final.outputs.root }}\n          TRUSTED_GH_BIN: ${{ steps.trusted_gh.outputs.path }}',
    );
  });

  it('serializes the redcheck failure set without comma ambiguity', () => {
    expect(redcheck).toMatch(/\.check_runs\[\].*\.name\] \| sort \| @json/u);
  });

  it('verifies the persisted round marker against the same HEAD before spending Claude', () => {
    for (const [name, source, marker] of [
      ['redflag', redflag, 'REDFLAG_FIX_ROUND'],
      ['redcheck', redcheck, 'REDCHECK_FIX_ROUND'],
    ] as const) {
      // Il cap differisce fra i due fixer (redflag 3, redcheck 2): il blocco
      // parte dalla sua definizione, qualunque sia il valore.
      const guard = source.slice(source.search(/MAX_ROUNDS=\d/), source.indexOf('Configure git identity'));
      expect(guard, `${name}: marker must carry HEAD and body revision`).toContain(`${marker}: %s HEAD: %s BODY: %s`);
      expect(guard, `${name}: marker read-back must paginate`).toContain('--paginate --slurp');
      expect(guard, `${name}: marker read-back must compare the complete body`).toContain('.body == $expected');
      expect(guard, `${name}: read-back mismatch must not proceed`).toContain('claim retryable, nessun Claude');
      expect(guard, `${name}: marker POST must expose an id for refund`).toContain('--method POST --raw-field');
      expect(guard, `${name}: marker POST must expose the author for read-back identity`).toContain('marker_author');
      expect(guard, `${name}: marker read-back must bind id and author`).toContain('(.id | tostring) == $marker_id and .user.login == $marker_author');
      expect(guard, `${name}: round cap must pin the Actions REST actor`).toContain("trusted_actor='github-actions[bot]'");
      expect(guard, `${name}: installation token must not probe /user`).not.toContain('api user --jq');
      expect(guard, `${name}: forged/old markers must be filtered by actor and HEAD`).toContain('expected_head');
      expect(guard, `${name}: malformed marker POST must reconcile by exact body`).toContain('refund_marker');
      expect(guard, `${name}: marker mismatch must refund the identified comment`).toContain('--method DELETE');
      expect(guard, `${name}: marker read-back must be bounded`).toContain('for marker_attempt in 1 2 3');
      expect(source, `${name}: final snapshot digest must preserve body newlines`).toContain("jq -j '.body // \"\"'");
      const snapshotStart = source.indexOf('Revalidate ');
      const snapshotStep = source.slice(snapshotStart, source.indexOf('Run Codex Luna Max', snapshotStart));
      expect(snapshotStep, `${name}: final snapshot read must retry transient API races`).toContain('for snapshot_attempt in 1 2 3');
      expect(snapshotStep, `${name}: snapshot retries must be bounded`).toContain('snapshot_attempt/3');
      expect(snapshotStep, `${name}: snapshot retries must yield between attempts`).toContain('sleep 2');
      expect(guard, `${name}: round must be range-checked before arithmetic`).toContain('fuori intervallo 0..$MAX_ROUNDS');
      expect(guard, `${name}: parser errors must not default to round zero`).not.toMatch(/ROUND=.*\|\| true/u);
    }
  });

  it('revalidates redcheck PR HEAD/body immediately before Codex and releases on a race', () => {
    expect(redcheck).toContain('Revalidate redcheck PR snapshot immediately before model');
    expect(redcheck).toContain('snapshot_final.outputs.snapshot_valid');
    expect(redcheck).toContain('EXPECTED_REVIEW_REVISION: ${{ needs.preflight.outputs.review_revision }}');
    expect(redcheck).toContain("echo 'CLAIM_STATUS=released' >> \"$GITHUB_ENV\"");
    expect(redcheck).toContain('Marker REDCHECK_FIX_ROUND $MARKER_ID cancellato: round rimborsato.');
  });

  it('revalidates redflag PR HEAD/body immediately before Codex and releases on a race', () => {
    expect(redflag).toContain('Revalidate redflag PR snapshot immediately before model');
    expect(redflag).toContain('snapshot_final.outputs.snapshot_valid');
    expect(redflag).toContain('EXPECTED_REVIEW_REVISION: ${{ steps.admission.outputs.review_revision }}');
    expect(redflag).toContain("echo 'CLAIM_STATUS=released' >> \"$GITHUB_ENV\"");
    expect(redflag).toContain('Marker REDFLAG_FIX_ROUND $MARKER_ID cancellato: round rimborsato.');
  });

  it('hashes the PR body in the review-input serialization at every fixer checkpoint', () => {
    // The redflag admission emits `review-input-revision.mjs hash-pr-json`
    // (sha256(body + "\n")); the final snapshot must hash an unchanged body to
    // the same value, or every run stops with «PR snapshot cambiato» before
    // Codex (runs 35889371876, 35894361109, 36013930419). The redcheck preflight
    // feeds the same digest to gh-pr-body-check, which recomputes it with the
    // library, so it must use the library serialization too.
    const digestOf = (line: string, name: string, body: string | null) => execFileSync(
      'bash',
      ['-c', `set -euo pipefail\n${line}\nprintf '%s' "$${name}"`],
      {
        env: { ...process.env, snapshot: JSON.stringify({ state: 'open', draft: false, head: { sha: HEAD }, body }), pr: JSON.stringify({ body }) },
        encoding: 'utf8',
      },
    );
    const assignment = (source: string, prefix: string) => source
      .split('\n').map((l) => l.trim()).find((l) => l.startsWith(prefix));
    const checkpoints = [
      ['redflag snapshot', assignment(redflag, 'snapshot_revision=$('), 'snapshot_revision'],
      ['redcheck snapshot', assignment(redcheck, 'snapshot_revision=$('), 'snapshot_revision'],
      ['redcheck preflight', assignment(redcheck, 'review_revision=$(printf'), 'review_revision'],
    ] as const;
    for (const [label, line, name] of checkpoints) {
      expect(line, `${label}: assignment`).toBeTruthy();
      for (const body of ['## Implementato\n\n- x\n', 'no trailing newline', '', null]) {
        expect(digestOf(line!, name, body), `${label} ${JSON.stringify(body)}`)
          .toBe(reviewInputRevisionFromBody(body ?? ''));
      }
    }
  });

  it('releases a run superseded by an external branch push before failure classification', () => {
    for (const [name, source] of [['redflag', redflag], ['redcheck', redcheck] as const]) {
      const alignStart = source.indexOf('Align review workflows (merge origin/main, anti-401 drift)');
      const align = source.slice(alignStart, source.indexOf('Setup Node.js', alignStart));
      expect(align, `${name}: align step must expose its original branch baseline`).toContain('id: align');
      expect(align, `${name}: align step must capture HEAD before the local merge`).toContain('echo "start_sha=$(git rev-parse HEAD)" >> "$GITHUB_OUTPUT"');
      const classify = source.slice(source.indexOf('Classify outcome (work-done, not CLI exit)'));
      expect(classify, `${name}: classify step`).toContain('CLAIM_STATUS=released');
      expect(classify, `${name}: classify must compare remote against the pre-merge baseline`).toContain('START_SHA: ${{ steps.align.outputs.start_sha }}');
      expect(classify, `${name}: remote must differ from the pre-merge baseline`).toContain('[ "$REMOTE_SHA" != "$START_SHA" ]');
      expect(classify, `${name}: local merge must not look like an external writer`).not.toContain('[ "$REMOTE_SHA" != "$BASE_SHA" ]');
      expect(classify, `${name}: remote must not be this runner's local head`).toContain('[ "$REMOTE_SHA" != "$HEAD_NOW" ]');
      const supersededAt = classify.indexOf('run SUPERSEDED');
      const failureAt = classify.indexOf('ACTION_OUTCOME" = "failure');
      expect(supersededAt, `${name}: superseded branch missing`).toBeGreaterThan(-1);
      expect(failureAt, `${name}: failure branch missing`).toBeGreaterThan(-1);
      expect(supersededAt, `${name}: stale race must be classified before failure`).toBeLessThan(failureAt);
    }
  });
});

// #9730 (gemello di corpus #1771): la head remota letta da `Classify outcome`
// deve essere verificata. Con un fetch fallito il ref remote-tracking resta
// alla fotografia dello step align; con una head che si muove fra fetch e
// lettura la fotografia e' intermedia. In entrambi i casi SUCCESS e
// SUPERSEDED (claim released) non devono essere decisi: errore esplicito,
// CLAIM_STATUS=failed-transient per il finalize, claim retryable.
describe('Classify outcome: head remota verificata fail-closed (#9730)', () => {
  const CLASSIFY_NAME = 'Classify outcome (work-done, not CLI exit)';
  const WORKFLOWS = {
    redcheck: '../.github/workflows/pr-redcheck-fixer.yml',
    redflag: '../.github/workflows/pr-redflag-fixer.yml',
  } as const;
  type WorkflowName = keyof typeof WORKFLOWS;

  function classifyRun(name: WorkflowName): string {
    const doc = YAML.parse(readFileSync(new URL(WORKFLOWS[name], import.meta.url), 'utf8'));
    for (const job of Object.values<any>(doc.jobs || {})) {
      const step = (job.steps || []).find((item: any) => item?.name === CLASSIFY_NAME);
      if (step) return String(step.run);
    }
    throw new Error(`${name}: step «${CLASSIFY_NAME}» non trovato`);
  }

  function fake(bin: string, name: string, body: string) {
    const file = path.join(bin, name);
    writeFileSync(file, `#!/usr/bin/env bash\n${body}\n`);
    chmodSync(file, 0o755);
  }

  interface Scenario {
    head?: string;
    base?: string;
    start?: string;
    remote?: string;
    actionOutcome?: string;
    fetchStatuses?: string;
    fetchedSequence?: string;
    rereadSequence?: string;
    lsRemoteStatuses?: string;
  }

  function runClassify(name: WorkflowName, scenario: Scenario = {}) {
    const temp = mkdtempSync(path.join(os.tmpdir(), 'classify-remote-head-'));
    try {
      const bin = path.join(temp, 'bin');
      const state = path.join(temp, 'state');
      mkdirSync(bin);
      mkdirSync(state);
      const logs = {
        githubEnv: path.join(temp, 'github.env'),
        gh: path.join(temp, 'gh.log'),
        sleep: path.join(temp, 'sleep.log'),
        timeout: path.join(temp, 'timeout.log'),
        fetch: path.join(temp, 'fetch.log'),
      };
      for (const file of Object.values(logs)) writeFileSync(file, '');
      // Fake git a sequenze: ogni tentativo consuma il valore successivo di
      // FAKE_FETCH_STATUSES / FAKE_FETCHED / FAKE_REREAD / FAKE_LSREMOTE_STATUSES
      // (vuoto = exit 0 / FAKE_REMOTE). `rev-parse origin/<ref>` resta la
      // fotografia stantia che il classificatore NON deve piu' usare.
      fake(bin, 'git', String.raw`
next_value() {
  n=$(cat "$FAKE_GIT_STATE/$1" 2>/dev/null || echo 0)
  n=$((n + 1))
  echo "$n" > "$FAKE_GIT_STATE/$1"
  printf '%s\n' $2 | sed -n "$n p"
}
case "$1 $2" in
  "rev-parse HEAD") printf '%s\n' "$FAKE_HEAD" ;;
  "rev-parse origin/"*) printf '%s\n' "$FAKE_REMOTE" ;;
  "rev-parse --verify")
    v=$(next_value fetched "$FAKE_FETCHED")
    [ -n "$v" ] || v="$FAKE_REMOTE"
    printf '%s\n' "$v" ;;
  "ls-remote "*)
    v=$(next_value reread "$FAKE_REREAD")
    [ -n "$v" ] || v="$FAKE_REMOTE"
    printf '%s\trefs/heads/%s\n' "$v" "$HEAD_REF"
    st=$(next_value ls-remote "$FAKE_LSREMOTE_STATUSES")
    [ -n "$st" ] || st=0
    exit "$st" ;;
  fetch*)
    echo fetch >> "$FETCH_LOG"
    st=$(next_value fetch "$FAKE_FETCH_STATUSES")
    [ -n "$st" ] || st=0
    exit "$st" ;;
  log*) exit 0 ;;
  *) exit 64 ;;
esac`);
      fake(bin, 'sleep', 'echo "$1" >> "$SLEEP_LOG"');
      fake(bin, 'timeout', 'echo "$1 $2 $3" >> "$TIMEOUT_LOG"\nshift\nexec "$@"');
      fake(bin, 'trusted-gh', 'echo "$*" >> "$GH_LOG"\necho 0');
      const result = spawnSync('bash', ['-c', classifyRun(name)], {
        encoding: 'utf8',
        env: {
          PATH: `${bin}:${process.env.PATH}`,
          GITHUB_ENV: logs.githubEnv,
          TRUSTED_GH_BIN: path.join(bin, 'trusted-gh'),
          GH_LOG: logs.gh,
          SLEEP_LOG: logs.sleep,
          TIMEOUT_LOG: logs.timeout,
          FETCH_LOG: logs.fetch,
          FAKE_GIT_STATE: state,
          FAKE_HEAD: scenario.head ?? 'merged-sha',
          FAKE_REMOTE: scenario.remote ?? 'external-sha',
          FAKE_FETCH_STATUSES: scenario.fetchStatuses ?? '',
          FAKE_FETCHED: scenario.fetchedSequence ?? '',
          FAKE_REREAD: scenario.rereadSequence ?? '',
          FAKE_LSREMOTE_STATUSES: scenario.lsRemoteStatuses ?? '',
          REPO: 'owner/repo',
          PR_NUMBER: '7',
          HEAD_REF: 'feature/x',
          START_SHA: scenario.start ?? 'pr-sha',
          BASE_SHA: scenario.base ?? 'merged-sha',
          BASE_COMMENTS: '0',
          BASE_BODY_DIGEST: 'unknown',
          BODY_ONLY: 'false',
          ACTION_OUTCOME: scenario.actionOutcome ?? 'failure',
        },
      });
      const lines = (file: string) => readFileSync(file, 'utf8').split('\n').filter(Boolean);
      return {
        status: result.status,
        stdout: result.stdout,
        stderr: result.stderr,
        githubEnv: readFileSync(logs.githubEnv, 'utf8'),
        ghLog: readFileSync(logs.gh, 'utf8'),
        sleeps: lines(logs.sleep),
        timeouts: lines(logs.timeout),
        fetchCount: lines(logs.fetch).length,
      };
    } finally {
      rmSync(temp, { recursive: true, force: true });
    }
  }

  function expectFailClosed(label: string, result: ReturnType<typeof runClassify>) {
    const detail = `${label}\nstdout=${result.stdout}\nstderr=${result.stderr}`;
    expect(result.status, detail).toBe(1);
    expect(result.stdout, detail).toContain('::error::REMOTE_HEAD_UNVERIFIED');
    expect(result.stdout, detail).not.toContain('run SUPERSEDED');
    expect(result.stdout, detail).not.toContain('round SUCCESS');
    expect(result.githubEnv, `${label}: unico stato esportato = failed-transient (mai released)`)
      .toBe('CLAIM_STATUS=failed-transient\n');
    expect(result.ghLog, `${label}: nessuna chiamata GitHub prima del verdetto`).toBe('');
    expect(result.fetchCount, `${label}: retry bounded a 3 tentativi`).toBe(3);
    expect(result.sleeps, `${label}: backoff crescente`).toEqual(['5', '10']);
  }

  for (const name of Object.keys(WORKFLOWS) as WorkflowName[]) {
    it(`${name}: fetch fallito non classifica sulla ref remote-tracking stantia`, () => {
      // La ref stantia (external-sha) direbbe SUPERSEDED.
      expectFailClosed(`${name} superseded`, runClassify(name, { fetchStatuses: '128 128 128' }));
      // La ref stantia uguale a HEAD_NOW direbbe SUCCESS senza provare il push.
      expectFailClosed(`${name} success`, runClassify(name, {
        head: 'fix-sha',
        remote: 'fix-sha',
        fetchStatuses: '1 1 1',
      }));
    });

    it(`${name}: head cambiata fra fetch e rilettura non produce SUPERSEDED`, () => {
      expectFailClosed(name, runClassify(name, {
        fetchedSequence: 'external-1 external-2 external-3',
        rereadSequence: 'external-2 external-3 external-4',
      }));
    });

    it(`${name}: ls-remote con riga valida ma exit non-zero e' una lettura fallita`, () => {
      expectFailClosed(name, runClassify(name, { lsRemoteStatuses: '2 2 2' }));
    });

    it(`${name}: head verificata classifica come prima, con timeout per comando`, () => {
      const superseded = runClassify(name);
      expect(superseded.status, superseded.stdout + superseded.stderr).toBe(0);
      expect(superseded.stdout).toContain('run SUPERSEDED');
      expect(superseded.githubEnv).toBe('CLAIM_STATUS=released\n');
      expect(superseded.timeouts).toEqual(['60 git fetch', '30 git ls-remote']);
      expect(superseded.sleeps).toEqual([]);

      const success = runClassify(name, { head: 'fix-sha', remote: 'fix-sha' });
      expect(success.status, success.stdout + success.stderr).toBe(0);
      expect(success.stdout).toContain('round SUCCESS');
      expect(success.githubEnv).toBe('');
    });

    it(`${name}: un errore transitorio recupera su una head verificata`, () => {
      const recovered = runClassify(name, { fetchStatuses: '128 0' });
      expect(recovered.status, recovered.stdout + recovered.stderr).toBe(0);
      expect(recovered.stdout).toContain('run SUPERSEDED');
      expect(recovered.fetchCount).toBe(2);
      expect(recovered.sleeps).toEqual(['5']);

      const moved = runClassify(name, {
        fetchedSequence: 'external-1 external-2',
        rereadSequence: 'external-2 external-2',
      });
      expect(moved.status, moved.stdout + moved.stderr).toBe(0);
      expect(moved.stdout).toContain('remote=external-2 ');
      expect(moved.stdout).not.toContain('remote=external-1 ');
      expect(moved.stdout).toContain('run SUPERSEDED');
    });
  }

  it('i due gemelli condividono la stessa lettura verificata, prima di ogni verdetto', () => {
    const block = (run: string) => {
      const start = run.indexOf('# Head remota verificata prima di classificare');
      const end = run.indexOf('REMOTE_HEAD_UNVERIFIED');
      expect(start).toBeGreaterThanOrEqual(0);
      expect(end).toBeGreaterThan(start);
      return run.slice(start, end);
    };
    const redcheck = classifyRun('redcheck');
    const redflag = classifyRun('redflag');
    expect(block(redflag)).toBe(block(redcheck));
    for (const run of [redcheck, redflag]) {
      expect(run, 'il fetch della head non deve essere best-effort').not.toMatch(/git fetch[^\n]*\|\| true/u);
      expect(run, 'la rilettura non-zero non deve avere un fallback').not.toMatch(/ls-remote[^\n]*\|\| echo/u);
      expect(run, 'niente lettura diretta della ref remote-tracking stantia').not.toContain('git rev-parse "origin/$HEAD_REF"');
      const guardAt = run.indexOf('REMOTE_HEAD_UNVERIFIED');
      for (const verdict of ['round SUCCESS', 'CLAIM_STATUS=released', 'run SUPERSEDED']) {
        expect(run.indexOf(verdict), `il guard deve precedere «${verdict}»`).toBeGreaterThan(guardAt);
      }
    }
  });

  it('il finalize eredita failed-transient anche con azione success e il claim resta retryable', () => {
    const context = {
      workflow: 'redcheck',
      prNumber: '7',
      headSha: HEAD,
      eventKey: 'tests-run:99',
      verdictKey: 'failed-checks:["vitest"]',
    };
    const active = {
      version: 1,
      token: 'tok-1',
      ...context,
      key: prFixClaimKey(context),
      dedupeKey: prFixClaimDedupeKey(context),
      state: 'active',
      issuedAt: 100,
      expiresAt: 4_000_000_000,
      runId: '77',
    };
    expect(active.key).not.toBe('');
    const temp = mkdtempSync(path.join(os.tmpdir(), 'claim-finalize-'));
    try {
      const pages = path.join(temp, 'pages.json');
      writeFileSync(pages, JSON.stringify([[comment(active)]]));
      const ghBin = path.join(temp, 'gh');
      writeFileSync(ghBin, `#!/usr/bin/env bash\ncat "${pages}"\n`);
      chmodSync(ghBin, 0o755);
      const result = spawnSync(process.execPath, [
        new URL('../scripts/ci/pr-fixer-claim.mjs', import.meta.url).pathname, '--claim',
      ], {
        encoding: 'utf8',
        env: {
          PATH: process.env.PATH,
          GH_REPO: 'owner/repo',
          CLAIM_ACTION: 'finalize',
          CLAIM_KIND: 'redcheck',
          PR_NUMBER: context.prNumber,
          HEAD_SHA: context.headSha,
          EVENT_KEY: context.eventKey,
          VERDICT_KEY: context.verdictKey,
          CLAIM_TOKEN: 'tok-1',
          PROCEED: 'true',
          // L'azione e' riuscita: senza lo stato ereditato il finalize
          // ricostruirebbe `completed` (terminale).
          ACTION_OUTCOME: 'success',
          CLAIM_STATUS: 'failed-transient',
          DRY_RUN: '1',
          TRUSTED_GH_BIN: ghBin,
        },
      });
      expect(result.status, result.stdout + result.stderr).toBe(0);
      expect(result.stdout).toContain('claim_state=failed-transient');
      expect(result.stdout).toContain('claim_error=false');
    } finally {
      rmSync(temp, { recursive: true, force: true });
    }
    expect(prFixClaimDecision({
      key: active.key,
      dedupeKey: active.dedupeKey,
      claims: [{ ...active, state: 'failed-transient' }],
      nowSec: 200,
    })).toMatchObject({ allowed: true, reason: 'same-pr-head-claim-retryable' });
  });
});
