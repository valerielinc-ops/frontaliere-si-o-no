import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import YAML from 'yaml';
import {
  evaluateNativeAutoMerge,
  inJobRequiredVitestDecision,
  requiredVitestDecision,
} from '../scripts/ci/native-automerge-gate.mjs';
import {
  NATIVE_AUTOMERGE_HELPER_FILES,
  NATIVE_AUTOMERGE_IN_JOB_SOURCE_FILES,
  NATIVE_AUTOMERGE_SOURCE_FILES,
} from '../scripts/ci/native-automerge-source.mjs';
import {
  reviewInputMarker,
  reviewInputRevisionFromBody,
} from '../scripts/ci/lib/review-input-revision.mjs';

const REPO = 'valerielinc-ops/frontaliere-si-o-no';
const HEAD = 'a'.repeat(40);
const RUN_ID = 900_100;
const JOB_ID = 900_200;
const VITEST = 'vitest (unit + integration)';
const REVIEW_GATE_STEP = 'Require approving Codex review';
const CLEAN_BODY = '## Findings (Important: 0, Nit: 0)\n\n## LGTM';
const REVIEW_MARKER = reviewInputMarker(reviewInputRevisionFromBody(''));

const testsWorkflow = readFileSync(new URL('../.github/workflows/tests.yml', import.meta.url), 'utf8');
const enableWorkflow = readFileSync(
  new URL('../.github/workflows/enable-native-automerge.yml', import.meta.url),
  'utf8',
);
const bodyEditRecoveryWorkflow = readFileSync(
  new URL('../.github/workflows/retry-code-check-after-body-edit.yml', import.meta.url),
  'utf8',
);

/** The required check as GitHub reports it WHILE the job that owns it is running. */
function inFlightCheck(overrides: Record<string, unknown> = {}) {
  return {
    id: 5150,
    name: VITEST,
    head_sha: HEAD,
    status: 'in_progress',
    conclusion: null,
    completed_at: null,
    details_url: `https://github.com/${REPO}/actions/runs/${RUN_ID}/job/${JOB_ID}`,
    ...overrides,
  };
}

function callerRun(overrides: Record<string, unknown> = {}) {
  return {
    id: RUN_ID,
    path: '.github/workflows/tests.yml',
    event: 'pull_request',
    status: 'in_progress',
    conclusion: null,
    head_sha: HEAD,
    ...overrides,
  };
}

function callerJob(overrides: Record<string, unknown> = {}) {
  return {
    id: JOB_ID,
    run_id: RUN_ID,
    name: VITEST,
    status: 'in_progress',
    conclusion: null,
    head_sha: HEAD,
    steps: [
      { name: 'Run Codex Luna Max review', status: 'completed', conclusion: 'failure' },
      { name: REVIEW_GATE_STEP, status: 'completed', conclusion: 'success' },
    ],
    ...overrides,
  };
}

function inJobRun(overrides: Record<string, unknown> = {}) {
  return { runId: RUN_ID, workflow: callerRun(), job: callerJob(), ...overrides };
}

function decide(overrides: Record<string, unknown> = {}) {
  return inJobRequiredVitestDecision({
    checkRuns: [inFlightCheck()],
    head: HEAD,
    repo: REPO,
    ...inJobRun(),
    ...overrides,
  });
}

describe('native auto-merge opt-in from inside the required job', () => {
  it('is the only decision that can pass while the required check is in flight', () => {
    // This is the whole reason the `workflow_run` trigger existed: called from
    // inside `tests`, the post-hoc decision can never allow.
    expect(requiredVitestDecision([inFlightCheck()], HEAD)).toMatchObject({
      allow: false,
      reason: expect.stringContaining('pending'),
    });
    expect(decide()).toMatchObject({ allow: true });
  });

  it('confirms the caller run identity instead of trusting it', () => {
    // A run id the API contradicts must never unlock the opt-in. Each case
    // changes exactly one field of an otherwise passing context.
    expect(decide({ runId: RUN_ID + 1 })).toMatchObject({ allow: false });
    expect(decide({ workflow: callerRun({ id: RUN_ID + 1 }) })).toMatchObject({ allow: false });
    expect(decide({ workflow: callerRun({ path: '.github/workflows/other.yml' }) })).toMatchObject({ allow: false });
    expect(decide({ workflow: callerRun({ event: 'workflow_dispatch' }) })).toMatchObject({ allow: false });
    expect(decide({ workflow: callerRun({ head_sha: 'b'.repeat(40) }) })).toMatchObject({ allow: false });
    expect(decide({ workflow: null })).toMatchObject({ allow: false });
    expect(decide({ job: null })).toMatchObject({ allow: false });
    expect(decide({ job: callerJob({ id: JOB_ID + 1 }) })).toMatchObject({ allow: false });
    expect(decide({ job: callerJob({ run_id: RUN_ID + 7 }) })).toMatchObject({ allow: false });
    expect(decide({ job: callerJob({ name: 'some other job' }) })).toMatchObject({ allow: false });
    expect(decide({ job: callerJob({ head_sha: 'b'.repeat(40) }) })).toMatchObject({ allow: false });
    // A check-run owned by a different run is not the caller's evidence.
    expect(decide({
      checkRuns: [inFlightCheck({
        details_url: `https://github.com/${REPO}/actions/runs/${RUN_ID + 3}/job/${JOB_ID}`,
      })],
    })).toMatchObject({ allow: false });
    expect(decide({ checkRuns: [] })).toMatchObject({ allow: false });
    expect(decide({ repo: '' })).toMatchObject({ allow: false });
    expect(decide({ head: 'not-a-sha' })).toMatchObject({ allow: false });
    expect(decide({ runId: 0 })).toMatchObject({ allow: false });
  });

  it('requires the approving review-gate step of that same job, from the API', () => {
    expect(decide({
      job: callerJob({ steps: [{ name: REVIEW_GATE_STEP, status: 'completed', conclusion: 'failure' }] }),
    })).toMatchObject({ allow: false });
    expect(decide({
      job: callerJob({ steps: [{ name: REVIEW_GATE_STEP, status: 'in_progress', conclusion: null }] }),
    })).toMatchObject({ allow: false });
    expect(decide({ job: callerJob({ steps: [] }) })).toMatchObject({ allow: false });
    expect(decide({ job: callerJob({ steps: 'nope' }) })).toMatchObject({ allow: false });
    // Two steps with that name: ambiguous, therefore denied.
    expect(decide({
      job: callerJob({
        steps: [
          { name: REVIEW_GATE_STEP, status: 'completed', conclusion: 'success' },
          { name: REVIEW_GATE_STEP, status: 'completed', conclusion: 'failure' },
        ],
      }),
    })).toMatchObject({ allow: false });
  });

  it('refuses a second in-flight required run that would supersede this verdict', () => {
    expect(decide({
      checkRuns: [
        inFlightCheck(),
        inFlightCheck({
          id: 5151,
          details_url: `https://github.com/${REPO}/actions/runs/${RUN_ID + 9}/job/${JOB_ID + 9}`,
        }),
      ],
    })).toMatchObject({ allow: false });
    // A stale COMPLETED check on the same HEAD does not block: it is
    // superseded by the caller's own run, and native auto-merge re-reads the
    // required context before merging anyway.
    expect(decide({
      checkRuns: [
        inFlightCheck(),
        inFlightCheck({
          id: 5152,
          status: 'completed',
          conclusion: 'failure',
          completed_at: '2026-09-18T10:00:00Z',
          details_url: `https://github.com/${REPO}/actions/runs/${RUN_ID - 5}/job/${JOB_ID - 5}`,
        }),
      ],
    })).toMatchObject({ allow: true });
  });

  it('keeps the review and risk gates in front of the in-job path', () => {
    const pr = {
      number: 1,
      state: 'OPEN',
      isDraft: false,
      baseRefName: 'main',
      title: 'Safe change',
      body: '',
      labels: [],
      headRefOid: HEAD,
      autoMergeRequest: null,
    };
    const review = {
      id: 1,
      user: { type: 'Bot', login: 'claude[bot]' },
      state: 'COMMENTED',
      body: `${REVIEW_MARKER}\n${CLEAN_BODY}`,
      commit_id: HEAD,
      submitted_at: '2026-09-18T12:00:00Z',
    };
    const base = {
      pr,
      checkRuns: [inFlightCheck()],
      repository: REPO,
      changedFiles: ['README.md'],
      changedFilesComplete: true,
    };
    expect(evaluateNativeAutoMerge({ ...base, reviews: [review], inJobRun: inJobRun() }))
      .toMatchObject({ allow: true });
    // Without the confirmed caller context the in-flight check still denies:
    // the in-job path is opt-in, it does not relax the default.
    expect(evaluateNativeAutoMerge({ ...base, reviews: [review] }))
      .toMatchObject({ allow: false });
    // No LGTM on HEAD → denied even with a fully confirmed caller context.
    expect(evaluateNativeAutoMerge({
      ...base,
      reviews: [{ ...review, body: `${REVIEW_MARKER}\n## Findings (Important: 1)\n\n🔴 Important: no.` }],
      inJobRun: inJobRun(),
    })).toMatchObject({ allow: false });
    expect(evaluateNativeAutoMerge({ ...base, reviews: [], inJobRun: inJobRun() }))
      .toMatchObject({ allow: false });
  });
});

describe('tests.yml wiring of the post-review opt-in', () => {
  const parsed = YAML.parse(testsWorkflow) as {
    jobs?: Record<string, { steps?: Array<Record<string, any>>; needs?: unknown; if?: string;
      outputs?: Record<string, string>; name?: string; 'continue-on-error'?: boolean }>;
  };
  const vitestSteps = parsed.jobs?.vitest?.steps ?? [];
  const vitestNames = vitestSteps.map((step) => String(step.name ?? step.uses ?? ''));
  const postReview = parsed.jobs?.['post-review'];
  const steps = postReview?.steps ?? [];
  const names = steps.map((step) => String(step.name ?? step.uses ?? ''));
  const optIn = steps.find((step) => step.name === 'Enable native auto-merge after the required job');
  const trustedCheckout = steps.find(
    (step) => step.name === 'Checkout trusted native auto-merge source',
  );
  const validation = steps.find(
    (step) => step.name === 'Validate trusted native auto-merge source',
  );
  const decision = vitestSteps.find((step) => step.id === 'post_review');

  it('runs the gate from a validated main checkout, never from the PR tree', () => {
    expect(trustedCheckout?.uses).toBe('actions/checkout@v5');
    expect(trustedCheckout?.with).toMatchObject({
      repository: '${{ github.repository }}',
      ref: 'main',
      path: 'native-automerge-main',
      'fetch-depth': 1,
      filter: 'blob:none',
      'sparse-checkout-cone-mode': false,
      'persist-credentials': false,
    });
    const cone = String(trustedCheckout?.with?.['sparse-checkout'] ?? '')
      .trim()
      .split(/\r?\n/u)
      .map((line) => line.trim())
      .filter(Boolean);
    expect(cone).toEqual(NATIVE_AUTOMERGE_IN_JOB_SOURCE_FILES.map((file) => `/${file}`));
    for (const file of NATIVE_AUTOMERGE_IN_JOB_SOURCE_FILES) {
      expect(NATIVE_AUTOMERGE_SOURCE_FILES).toContain(file);
    }
    for (const helper of NATIVE_AUTOMERGE_HELPER_FILES) {
      expect(NATIVE_AUTOMERGE_IN_JOB_SOURCE_FILES).toContain(helper);
    }
    expect(validation?.run).toContain('native-automerge-source.mjs');
    expect(validation?.env?.NATIVE_AUTOMERGE_SOURCE_PROFILE).toBe('in-job');
    expect(optIn?.run).toContain('cd "$NATIVE_AUTOMERGE_SOURCE_ROOT"');
    expect(optIn?.run).toContain('$NATIVE_AUTOMERGE_HELPER_DIR/native-automerge-gate.mjs');
    expect(names.indexOf('Checkout trusted native auto-merge source'))
      .toBeLessThan(names.indexOf('Enable native auto-merge after the required job'));
    expect(names.indexOf('Validate trusted native auto-merge source'))
      .toBeLessThan(names.indexOf('Enable native auto-merge after the required job'));
    // Token and sweeper come from main, not from the PR tree.
    const rootCheckout = steps.find((step) => step.uses === 'actions/checkout@v5' && !step.with?.path);
    expect(rootCheckout?.with?.ref).toBe('main');
  });

  it('uses the ordinary completed-check path, with no "tests passed" flag', () => {
    // After `needs: vitest` the required check is completed: the gate verifies
    // it via API like retry-native-automerge.yml. The in-job run id would now
    // deny forever (the caller check is no longer in flight).
    expect(optIn?.env?.NATIVE_AUTOMERGE_IN_JOB_RUN_ID).toBeUndefined();
    expect(testsWorkflow).not.toMatch(/NATIVE_AUTOMERGE_(?:SKIP|BYPASS|FORCE|ASSUME)/u);
    expect(optIn?.run).not.toContain('--skip-vitest-check');
  });

  it('runs only after the required job, on its published decision', () => {
    expect(postReview?.needs).toBe('vitest');
    expect(postReview?.name).not.toBe(VITEST);
    expect(postReview?.if).toContain('always()');
    expect(postReview?.if).toContain("needs.vitest.outputs.automerge == 'true'");
    expect(String(optIn?.if ?? '')).toContain("needs.vitest.outputs.automerge == 'true'");
    expect(parsed.jobs?.vitest?.outputs?.automerge).toBe('${{ steps.post_review.outputs.automerge }}');
    const automerge = String(decision?.env?.AUTOMERGE ?? '');
    expect(automerge).toContain("job.status == 'success'");
    expect(automerge).toContain("steps.review_gate.outputs.approved == 'true'");
    expect(String(decision?.if ?? '')).toContain('always()');
  });

  it('cannot paint the run red, and never falls back to GITHUB_TOKEN', () => {
    expect(postReview?.['continue-on-error']).toBe(true);
    expect(optIn?.['continue-on-error']).toBe(true);
    expect(trustedCheckout?.['continue-on-error']).toBe(true);
    expect(validation?.['continue-on-error']).toBe(true);
    expect(String(optIn?.run ?? '')).toContain('GH_TOKEN="$APP_TOKEN"');
    expect(String(optIn?.run ?? '')).not.toMatch(/GH_TOKEN=(?!"\$APP_TOKEN")/u);
    expect(String(optIn?.run ?? '')).not.toContain('secrets.GITHUB_TOKEN');
    expect(optIn?.env?.GH_TOKEN).toBeUndefined();
    expect(String(optIn?.run ?? '')).toMatch(/APP_TOKEN[\s\S]*exit 0/u);
    expect(testsWorkflow).not.toContain('load-rc-env.mjs');
  });

  it('leaves the verdict-summary step last in the required job, with the decision before it', () => {
    expect(vitestNames.at(-1)).toBe('Explain the job verdict in the run summary');
    expect(vitestNames.indexOf('Decide post-review follow-up'))
      .toBeGreaterThan(vitestNames.indexOf('Require approving Codex review'));
    expect(vitestNames.indexOf('Decide post-review follow-up'))
      .toBeGreaterThan(vitestNames.indexOf('Fail when required review gate is skipped'));
    expect(vitestNames).not.toContain('Enable native auto-merge from the required job');
    expect(vitestNames).not.toContain('Rebase near-merge PRs after review or stale rescue');
  });
});

describe('enable-native-automerge.yml no longer fans out per PR event', () => {
  it('keeps only the manual escape hatch', () => {
    const parsed = YAML.parse(enableWorkflow) as { on?: Record<string, unknown> };
    expect(Object.keys(parsed.on ?? {})).toEqual(['workflow_dispatch']);
    expect(enableWorkflow).toContain('native-automerge-gate.mjs');
  });
});

describe('body edits revoke native auto-merge before a fresh review', () => {
  it('uses the trusted edited event, write permission, and verified disable mutation', () => {
    const parsed = YAML.parse(bodyEditRecoveryWorkflow) as {
      on?: Record<string, unknown>;
      permissions?: Record<string, string>;
      jobs?: Record<string, { if?: string; steps?: Array<Record<string, any>> }>;
    };
    expect(parsed.on?.pull_request_target).toEqual({ types: ['edited'] });
    expect(parsed.permissions?.['pull-requests']).toBe('write');
    expect(parsed.jobs?.recover?.if).toContain('changes.body');
    const script = parsed.jobs?.recover?.steps?.[0]?.with?.script as string;
    expect(script).toContain('disablePullRequestAutoMerge');
    expect(script).toContain('revokeNativeAutoMerge');
    expect(script).toContain('github.graphql');
    const revocation = script.indexOf('await revokeNativeAutoMerge(number)');
    const marker = script.indexOf('const existing = await pendingComment(number)');
    expect(revocation).toBeGreaterThan(-1);
    expect(marker).toBeGreaterThan(revocation);
  });
});
