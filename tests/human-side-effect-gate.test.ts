import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import YAML from 'yaml';

// @ts-expect-error — the policy helper is a dependency-free ESM CI script.
import {
  consumeApprovalNonce,
  deriveApprovalNonce,
  evaluateHumanApproval,
  main,
} from '../scripts/ci/human-side-effect-gate.mjs';
// @ts-expect-error — the provenance verifier is a dependency-free ESM CI script.
import {
  evaluatePublisherDispatchAttestation,
  PUBLISHER_SOURCE_REPOSITORY,
  PUBLISHER_SOURCE_WORKFLOW,
  PUBLISHER_SOURCE_WORKFLOW_PATH,
  main as verifyPublisherMain,
} from '../scripts/ci/verify-publisher-dispatch.mjs';

const APPROVED_INPUT = {
  event: 'workflow_dispatch',
  actor: 'owner',
  triggeringActor: 'owner',
  actorType: 'User',
  repository: 'valerielinc-ops/frontaliere-si-o-no',
  workflow: 'Send Newsletter',
  runId: '123456789',
  runAttempt: '1',
  consent: 'true',
  dryRun: 'false',
  scope: 'newsletter-send',
};

const APPROVED_SCHEDULE_INPUT = {
  ...APPROVED_INPUT,
  event: 'schedule',
  actor: 'github-actions[bot]',
  triggeringActor: 'github-actions[bot]',
  actorType: 'Bot',
  consent: '',
  dryRun: '',
  approvalTrustedSchedule: 'true',
};

const SOURCE_SHA = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';

const VALID_PUBLISHER_EVENT = {
  action: 'articles-published',
  client_payload: {
    schema_version: 1,
    source_repository: PUBLISHER_SOURCE_REPOSITORY,
    source_workflow: PUBLISHER_SOURCE_WORKFLOW,
    source_workflow_path: PUBLISHER_SOURCE_WORKFLOW_PATH,
    source_run_id: '123456789',
    source_run_attempt: '1',
    source_sha: SOURCE_SHA,
    source_branch: 'main',
    source_event: 'push',
  },
};

// Fixed clock, so the freshness window is exercised by fixtures rather than by
// the wall clock. `NOW` is arbitrary; only the distance to run_started_at ever
// matters.
const NOW = Date.parse('2026-09-18T15:28:16.000Z');
const SOURCE_RUN_UPDATED_AT = '2026-09-18T15:25:08.000Z';

const VALID_SOURCE_RUN = {
  id: 123456789,
  workflow_id: 323736126,
  head_branch: 'main',
  head_sha: SOURCE_SHA,
  event: 'push',
  // completed/success is the only admitted pair: the publisher dispatches from
  // its second-to-last step, so the run is durable by then.
  status: 'completed',
  conclusion: 'success',
  run_attempt: 1,
  updated_at: SOURCE_RUN_UPDATED_AT,
  repository: { full_name: PUBLISHER_SOURCE_REPOSITORY },
};

const VALID_SOURCE_WORKFLOW = {
  id: 323736126,
  name: PUBLISHER_SOURCE_WORKFLOW,
  path: PUBLISHER_SOURCE_WORKFLOW_PATH,
};

function publisherEvent(clientPayload = {}) {
  return {
    ...VALID_PUBLISHER_EVENT,
    client_payload: { ...VALID_PUBLISHER_EVENT.client_payload, ...clientPayload },
  };
}

function sourceRun(overrides = {}) {
  return { ...VALID_SOURCE_RUN, ...overrides };
}

function verifyPublisher({ clientPayload, runMetadata, workflowMetadata, now = NOW } = {}) {
  return evaluatePublisherDispatchAttestation({
    eventPayload: publisherEvent(clientPayload),
    runMetadata: runMetadata === undefined ? sourceRun() : runMetadata,
    workflowMetadata: workflowMetadata === undefined ? VALID_SOURCE_WORKFLOW : workflowMetadata,
    now,
  });
}

const TRUSTED_PUBLISHER_DISPATCH = {
  event: 'repository_dispatch',
  actor: 'valerielinc-ops',
  triggeringActor: 'valerielinc-ops',
  dispatchActor: 'valerielinc-ops',
  dispatchAction: 'articles-published',
  dispatchPayloadPresent: 'true',
  publisherSourceVerified: 'true',
  dispatchSourceSchemaVersion: '1',
  dispatchSourceRepository: PUBLISHER_SOURCE_REPOSITORY,
  dispatchSourceWorkflow: PUBLISHER_SOURCE_WORKFLOW,
  dispatchSourceWorkflowPath: PUBLISHER_SOURCE_WORKFLOW_PATH,
  dispatchSourceRunId: '123456789',
  dispatchSourceRunAttempt: '1',
  dispatchSourceSha: SOURCE_SHA,
  dispatchSourceBranch: 'main',
  dispatchSourceEvent: 'push',
  actorType: 'User',
  repository: 'valerielinc-ops/frontaliere-si-o-no',
  workflow: 'Sync article sitemaps, feeds and ticker from the articles API',
  runId: '987654321',
  runAttempt: '1',
  consent: '',
  dryRun: '',
  scope: 'article-sitemap-publication',
  expectedDispatchActor: 'valerielinc-ops',
  expectedDispatchRepository: 'valerielinc-ops/frontaliere-si-o-no',
  expectedDispatchScope: 'article-sitemap-publication',
  expectedDispatchWorkflow: 'Sync article sitemaps, feeds and ticker from the articles API',
};

/** Workflows whose scheduled/manual paths can send, post, publish, or alter recipient state. */
const SIDE_EFFECT_WORKFLOWS = [
  // Writer/publication/content scope from the audit.
  'fast-publish-article.yml',
  'publisher-jobs-sync.yml',
  'publish-journalist-articles.yml',
  'mirror-articles-corpus.yml',
  'sync-articles-sitemaps.yml',
  'crawl-events.yml',
  'recover-prev-slugs.yml',
  'refresh-keyword-config.yml',
  'sync-gsc-orphans.yml',
  'update-fuel-prices.yml',
  'backfill-expired-from-history.yml',
  'discover-404s.yml',
  'discover-404s-via-cloudflare.yml',
  'generate-border-wait-ranking-weekly.yml',
  'update-health-premiums.yml',
  'refresh-plate-auctions.yml',
  'reconcile-expired-route-duplicates.yml',
  'migrate-prospected-slugs.yml',
  'seo-health-loop.yml',
  // Communication, outreach, newsletter, alert, recipient, and social scope.
  'cold-email-outreach.yml',
  'send-company-alerts.yml',
  'send-job-alerts.yml',
  'send-newsletter.yml',
  'newsletter-confirmation-followups.yml',
  'newsletter-dormant-winback.yml',
  'newsletter-sunset.yml',
  'send-onboarding-drip.yml',
  'send-saved-jobs-digest.yml',
  'send-daily-brief.yml',
  'publisher-blast.yml',
  'probe-mailgun-scheduled.yml',
  'cleanup-mailjet-contacts.yml',
  'mailtrap-suppression-retry.yml',
  'suppression-hygiene.yml',
  'job-alert-sunset.yml',
  'notify-journalist-article-live.yml',
  'fb-articles-daily-schedule.yml',
  'fb-events-daily-schedule.yml',
  'fb-jobs-daily-schedule.yml',
  'instagram-daily-broadcast.yml',
  'linkedin-member-daily.yml',
  'reddit-jobs-daily-schedule.yml',
  'telegram-channel-broadcast.yml',
  'tiktok-daily-broadcast.yml',
];

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const workflow = (name: string) => fs.readFileSync(path.join(ROOT, '.github', 'workflows', name), 'utf8');
const APPROVED_GATE_IF = "steps.side_effect_gate.outputs.allow_side_effect == 'true' && steps.side_effect_gate.outputs.effective_dry_run != 'true'";

const SCHEDULE_ARMED_WORKFLOWS = [
  'send-job-alerts.yml',
  'send-company-alerts.yml',
  'send-newsletter.yml',
  'send-saved-jobs-digest.yml',
  'send-onboarding-drip.yml',
  'send-daily-brief.yml',
  'newsletter-confirmation-followups.yml',
  'newsletter-dormant-winback.yml',
  'newsletter-sunset.yml',
  'job-alert-sunset.yml',
  'instagram-daily-broadcast.yml',
  'suppression-hygiene.yml',
  'telegram-channel-broadcast.yml',
  'tiktok-daily-broadcast.yml',
  // Both crons are producing principals, not merely preview paths: the cold
  // email schedule refreshes the GA4 target report before printing the batch
  // it would send, and the SEO health cron is the only writer of
  // data/seo-health/latest.json and of the protected 404 repair.  Unarmed they
  // do not stand down quietly — they fail on the first step that needs the
  // credentials the gate refused to hydrate.
  'cold-email-outreach.yml',
  'seo-health-loop.yml',
  // The 6-hourly refresh is the only writer of public/data/plate-auctions.json.
  // Unarmed, the gate denied every scheduled run: the producer was skipped, the
  // drift check still passed because it re-validates the committed file, and
  // the job reported success while the snapshot sat frozen at
  // 2026-09-15T06:58:44.350Z. Arming it makes the underlying failure visible
  // again — it does not repair it.
  'refresh-plate-auctions.yml',
  // Armed 2026-09-18, and the FOURTH workflow #8889's fail-closed switch
  // caught that no rearm pass inventoried: #9004 took 14, #9135 took two more,
  // #9164 took refresh-plate-auctions, and this one was in none of them. Its
  // 5:23/17:23 cron is the article chain's only backstop, and
  // verify-publisher-dispatch.mjs's header names the schedule "the safe
  // recovery path" for a lost dispatch race — so here the omission cost more
  // than elsewhere: #8918 closed the DISPATCH path the same day
  // (2026-09-16T19:25Z), leaving the chain no path at all, and
  // packages/articles/content stopped being written at 2026-09-16T12:00:46Z.
  //
  // Four instances of one omission is the argument for the closure assertion
  // this list still lacks: nothing asserts that every workflow with a
  // `side_effect_gate` and a `schedule:` appears in exactly one of the two
  // inventories. Enumerated 2026-09-18: 12 were in neither.
  'sync-articles-sitemaps.yml',
  // Recovery is an approved scheduled write: it remains non-destructive and
  // its backfill/commit steps keep their own dry-run guards in depth.
  'recover-prev-slugs.yml',
];

const SCHEDULE_UNARMED_WORKFLOWS = [
  'cleanup-mailjet-contacts.yml',
  'fb-articles-daily-schedule.yml',
  'fb-events-daily-schedule.yml',
  'fb-jobs-daily-schedule.yml',
  'linkedin-member-daily.yml',
  'mailtrap-suppression-retry.yml',
  'probe-mailgun-scheduled.yml',
  'publisher-blast.yml',
  'reddit-jobs-daily-schedule.yml',
];

const SCHEDULE_SIDE_EFFECT_WORKFLOWS = [
  ...SCHEDULE_ARMED_WORKFLOWS,
  ...SCHEDULE_UNARMED_WORKFLOWS,
];

const DEFENSE_IN_DEPTH_GUARDS = [
  ['instagram-daily-broadcast.yml', 'Post to Instagram', 'ARGS+=(--dry-run);'],
  ['job-alert-sunset.yml', 'Run sunset', 'MODE=dry-run'],
  ['linkedin-member-daily.yml', 'Post to LinkedIn (member)', 'ARGS+=(--dry-run);'],
  ['mailtrap-suppression-retry.yml', 'Run suppression retry', 'MODE=dry-run'],
  ['newsletter-dormant-winback.yml', 'Run dormant win-back', 'MODE=dry-run'],
  ['newsletter-sunset.yml', 'Run sunset', 'MODE=dry-run'],
  ['send-newsletter.yml', 'Run newsletter job', 'MODE=preview'],
  ['send-onboarding-drip.yml', 'Run onboarding drip', 'MODE=dry-run'],
  ['suppression-hygiene.yml', 'Decay proven-alive suppressions', 'MODE=dry-run'],
  ['suppression-hygiene.yml', 'Re-probe never-probed suppressions (ramped)', 'MODE=dry-run'],
  ['tiktok-daily-broadcast.yml', 'Post to TikTok', 'ARGS+=(--dry-run);'],
] as const;

const DEFENSE_IN_DEPTH_GUARD_CONDITION = 'if [ "$ALLOW_SIDE_EFFECT" != "true" ] || [ "$EFFECTIVE_DRY_RUN" = "true" ]; then';

const RECOVER_PREV_SLUG_GUARDS = [
  ['Reconcile duplicate stable-id job records', 'if [ "$DRY_RUN" = "true" ]; then APPLY_FLAG=""; fi'],
  ['Backfill recoverable slugs', 'if [ "$DRY_RUN" = "true" ]; then DRY_RUN_FLAG="--dry-run"; fi'],
] as const;

/** Named writer/provider paths added by the Pasteur F5/F6/F9 inventory. */
const GATED_SIDE_EFFECT_STEPS: Record<string, RegExp[]> = {
  'sync-articles-sitemaps.yml': [
    /Commit if changed/u,
    /Publish the news sitemap to the edge/u,
    /Publish the RSS feeds to the edge/u,
    /Publish the news-ticker payload to the edge/u,
  ],
  'publish-journalist-articles.yml': [
    /Publish queued journalist articles/u,
    /Commit registered article files/u,
    /Trigger deploy workflow/u,
    /Trigger fast-publish workflow/u,
  ],
  'recover-prev-slugs.yml': [
    /Reconcile duplicate stable-id job records/u,
    /Backfill recoverable slugs/u,
    /Commit and push restored slices/u,
  ],
  'refresh-keyword-config.yml': [
    /Generate keyword pages config/u,
    /Re-cluster orphan queries/u,
    /Commit if changed/u,
    /Trigger deploy if config changed/u,
  ],
  'sync-gsc-orphans.yml': [
    /Sync GSC orphan slugs/u,
    /Assemble jobs dataset/u,
    /Reconcile orphan/u,
    /Mine all job slugs/u,
    /Canton-aware migration/u,
    /Prune non-resolving/u,
    /Commit and push$/u,
    /Trigger deploy if data changed/u,
  ],
  'update-fuel-prices.yml': [
    /Generate and upload fuel prices/u,
    /Persist daily snapshot/u,
    /Snapshot fuel history/u,
    /Commit repo cache/u,
    /Trigger deploy workflow/u,
  ],
  'backfill-expired-from-history.yml': [
    /Recover dropped jobs/u,
    /Reassemble dataset/u,
    /Commit and push$/u,
    /Trigger deploy if data changed/u,
  ],
  'discover-404s.yml': [
    /Run URL Inspection sweep/u,
    /Run Cloudflare edge 404 sweep/u,
    /Prune non-resolving/u,
    /Commit and push$/u,
    /Re-mint App token/u,
    /Trigger deploy if compat changed/u,
  ],
  'discover-404s-via-cloudflare.yml': [
    /Run Cloudflare 404 sweep/u,
    /Refresh CF-hot 404 list/u,
    /Prune non-resolving/u,
    /Commit and push$/u,
    /Trigger deploy if compat changed/u,
  ],
  'generate-border-wait-ranking-weekly.yml': [
    /Refresh ranking digest article body/u,
    /Commit \+ push/u,
    /Trigger deploy workflow/u,
  ],
  'update-health-premiums.yml': [
    /Fetch health premiums/u,
    /Validate generated health premiums/u,
    /Commit and push if changed/u,
    /Trigger deploy workflow/u,
  ],
  'refresh-plate-auctions.yml': [
    /Refresh every active public catalogue/u,
    /Commit and push static snapshot/u,
    /Trigger static deploy/u,
  ],
  'reconcile-expired-route-duplicates.yml': [
    /Sweep expired slices and reconcile ownership/u,
    /Reassemble dataset/u,
    /Commit and push changed slices/u,
    /Trigger deploy if data changed/u,
  ],
  'migrate-prospected-slugs.yml': [
    /Apply and validate migration/u,
    /Commit and push exact migration paths/u,
    /Trigger deploy after migration/u,
  ],
  'seo-health-loop.yml': [
    /Run five-phase SEO health loop/u,
    /Reconcile 404 compatibility store/u,
    /Save health state before compat push/u,
    /Commit and push corrected compat shards/u,
    /Restore and persist health state/u,
    /Trigger deploy for live compat correction/u,
  ],
};

/**
 * One step's RAW yaml slice. Raw, not YAML.parse'd, because the assertions
 * that matter here are about the `if:` expression and the `${{ }}` bindings
 * verbatim — parsing resolves them away.
 */
function step(source: string, name: string) {
  const start = source.indexOf(`- name: ${name}`);
  if (start < 0) throw new Error(`step not found: ${name}`);
  const end = source.indexOf('\n      - name:', start + 1);
  return source.slice(start, end < 0 ? undefined : end);
}

function credentialHydrationSteps(source: string) {
  const document = YAML.parse(source) as { jobs?: Record<string, { steps?: Array<Record<string, unknown>> }> };
  return Object.entries(document.jobs ?? {}).flatMap(([jobName, job]) => (job.steps ?? []).flatMap((step, index) => {
    const name = String(step.name ?? '');
    const uses = String(step.uses ?? '');
    const env = Object.entries((step.env ?? {}) as Record<string, unknown>)
      .map(([key, value]) => `${key}=${String(value)}`).join('\n');
    const run = String(step.run ?? '');
    const credentialText = `${name}\n${uses}\n${env}\n${run}`;
    const namedHydration = /(?:^|[\s-])(prepare|load|install|mint|setup)(?:[\s-]|$)/iu.test(name)
      && /secrets\.|FIREBASE_SERVICE_ACCOUNT_JSON|load-rc-env\.mjs|credential|token|api.?key|private.?key/iu.test(credentialText);
    const providerAction = /\.github\/actions\/setup-(?:omniroute|claude-haiku-fallback)/u.test(uses);
    return namedHydration || providerAction
      ? [{ jobName, index, name, if: String(step.if ?? '') }]
      : [];
  }));
}

describe('human-side-effect-gate policy', () => {
  it('denies an unarmed schedule, push, and untrusted repository_dispatch and forces dry-run', () => {
    for (const event of ['schedule', 'push', 'repository_dispatch']) {
      const decision = evaluateHumanApproval({
        ...APPROVED_INPUT,
        event,
        ...(event === 'schedule' ? { approvalTrustedSchedule: 'false' } : {}),
      });
      expect(decision.allow, event).toBe(false);
      expect(decision.effectiveDryRun, event).toBe(true);
    }
  });

  it('allows an explicitly trusted first-attempt schedule without human actor or input proofs', () => {
    const decision = evaluateHumanApproval(APPROVED_SCHEDULE_INPUT);
    expect(decision.allow).toBe(true);
    expect(decision.effectiveDryRun).toBe(false);
    expect(decision.reason).toBe('trusted-schedule-approved');
    expect(decision.nonce).toMatch(/^[a-f0-9]{64}$/);
    expect(decision.nonce).toBe(deriveApprovalNonce(APPROVED_SCHEDULE_INPUT));
  });

  it.each([
    ['missing opt-in', { approvalTrustedSchedule: '' }, 'event-not-workflow-dispatch'],
    ['rerun', { runAttempt: '2' }, 'run-is-a-rerun'],
  ])('denies a trusted schedule with %s', (_name, override, reason) => {
    const decision = evaluateHumanApproval({ ...APPROVED_SCHEDULE_INPUT, ...override });
    expect(decision.allow).toBe(false);
    expect(decision.effectiveDryRun).toBe(true);
    expect(decision.reasons).toContain(reason);
  });

  it('consumes a trusted schedule nonce only once, including through main()', () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'human-side-effect-gate-schedule-'));
    const firstOutput = path.join(tempRoot, 'github-output-first');
    const secondOutput = path.join(tempRoot, 'github-output-second');
    const env = {
      GITHUB_EVENT_NAME: 'schedule',
      GITHUB_ACTOR: 'github-actions[bot]',
      GITHUB_TRIGGERING_ACTOR: 'github-actions[bot]',
      GITHUB_REPOSITORY: APPROVED_SCHEDULE_INPUT.repository,
      GITHUB_WORKFLOW: APPROVED_SCHEDULE_INPUT.workflow,
      GITHUB_RUN_ID: APPROVED_SCHEDULE_INPUT.runId,
      GITHUB_RUN_ATTEMPT: APPROVED_SCHEDULE_INPUT.runAttempt,
      APPROVAL_ACTOR_TYPE: 'Bot',
      APPROVAL_CONSENT: '',
      APPROVAL_DRY_RUN: '',
      APPROVAL_TRUSTED_SCHEDULE: 'true',
      APPROVAL_SCOPE: APPROVED_SCHEDULE_INPUT.scope,
      RUNNER_TEMP: tempRoot,
    };

    const firstCode = main({
      env: { ...env, GITHUB_OUTPUT: firstOutput },
      logger: { log() {}, error() {} },
    });
    const secondCode = main({
      env: { ...env, GITHUB_OUTPUT: secondOutput },
      logger: { log() {}, error() {} },
    });

    expect(firstCode).toBe(0);
    expect(fs.readFileSync(firstOutput, 'utf8')).toContain('allow_side_effect=true');
    expect(fs.readFileSync(firstOutput, 'utf8')).toContain('effective_dry_run=false');
    expect(secondCode).toBe(0);
    expect(fs.readFileSync(secondOutput, 'utf8')).toContain('allow_side_effect=false');
    expect(fs.readFileSync(secondOutput, 'utf8')).toContain('effective_dry_run=true');
    expect(fs.readFileSync(secondOutput, 'utf8')).toContain('approval_reason=nonce-already-consumed');
  });

  it('requires an explicit human dispatch proof, not a text confirmation alone', () => {
    const decision = evaluateHumanApproval({
      ...APPROVED_INPUT,
      actorType: 'Bot',
      consent: 'true',
      dryRun: 'false',
    });
    expect(decision.allow).toBe(false);
    expect(decision.reasons).toEqual(expect.arrayContaining(['actor-is-not-a-github-user']));
  });

  it('allows exactly one first-attempt user dispatch with explicit consent and dry_run=false', () => {
    const decision = evaluateHumanApproval(APPROVED_INPUT);
    expect(decision.allow).toBe(true);
    expect(decision.effectiveDryRun).toBe(false);
    expect(decision.nonce).toMatch(/^[a-f0-9]{64}$/);
    expect(decision.nonce).toBe(deriveApprovalNonce(APPROVED_INPUT));
  });

  it('allows the current publisher repository_dispatch only with its pinned PAT principal and action', () => {
    const decision = evaluateHumanApproval(TRUSTED_PUBLISHER_DISPATCH);
    expect(decision.allow).toBe(true);
    expect(decision.effectiveDryRun).toBe(false);
    expect(decision.reason).toBe('trusted-publisher-dispatch-approved');
    expect(decision.nonce).toMatch(/^[a-f0-9]{64}$/);
  });

  it('denies an allowlisted sender when the source run was not verified', () => {
    const decision = evaluateHumanApproval({
      ...TRUSTED_PUBLISHER_DISPATCH,
      publisherSourceVerified: 'false',
    });
    expect(decision.allow).toBe(false);
    expect(decision.effectiveDryRun).toBe(true);
    expect(decision.reasons).toContain('publisher-source-run-unverified');
  });

  it('rejects spoofed or ambiguous publisher dispatches', () => {
    const cases = [
      {
        name: 'spoofed sender',
        override: { actor: 'attacker', triggeringActor: 'attacker', dispatchActor: 'attacker' },
        reason: 'publisher-dispatch-actor-mismatch',
      },
      {
        name: 'wrong action',
        override: { dispatchAction: 'articles-published-copy' },
        reason: 'publisher-dispatch-action-mismatch',
      },
      {
        name: 'payload missing',
        override: { dispatchPayloadPresent: 'false' },
        reason: 'publisher-dispatch-payload-missing-or-unknown',
      },
      {
        name: 'payload status unknown',
        override: { dispatchPayloadPresent: '' },
        reason: 'publisher-dispatch-payload-missing-or-unknown',
      },
    ];

    for (const testCase of cases) {
      const decision = evaluateHumanApproval({ ...TRUSTED_PUBLISHER_DISPATCH, ...testCase.override });
      expect(decision.allow, testCase.name).toBe(false);
      expect(decision.effectiveDryRun, testCase.name).toBe(true);
      expect(decision.reasons, testCase.name).toContain(testCase.reason);
    }
  });

  it('rejects bot and rerun publisher dispatches', () => {
    const bot = evaluateHumanApproval({
      ...TRUSTED_PUBLISHER_DISPATCH,
      actor: 'github-actions[bot]',
      triggeringActor: 'github-actions[bot]',
      dispatchActor: 'github-actions[bot]',
      actorType: 'Bot',
    });
    const rerun = evaluateHumanApproval({ ...TRUSTED_PUBLISHER_DISPATCH, runAttempt: '2' });
    const sourceRerun = evaluateHumanApproval({ ...TRUSTED_PUBLISHER_DISPATCH, dispatchSourceRunAttempt: '2' });

    expect(bot.allow).toBe(false);
    expect(bot.effectiveDryRun).toBe(true);
    expect(bot.reasons).toEqual(expect.arrayContaining(['actor-is-not-a-github-user', 'actor-invalid-or-bot']));
    expect(rerun.allow).toBe(false);
    expect(rerun.effectiveDryRun).toBe(true);
    expect(rerun.reasons).toContain('run-is-a-rerun');
    expect(sourceRerun.allow).toBe(false);
    expect(sourceRerun.effectiveDryRun).toBe(true);
    expect(sourceRerun.reasons).toContain('publisher-source-run-is-rerun');
  });

  it('rejects actor mismatch, bots, reruns, and implicit non-dry-run values', () => {
    for (const override of [
      { actor: 'other' },
      { actor: 'github-actions[bot]', triggeringActor: 'github-actions[bot]', actorType: 'Bot' },
      { runAttempt: '2' },
      { dryRun: '' },
      { consent: 'yes' },
    ]) {
      const decision = evaluateHumanApproval({ ...APPROVED_INPUT, ...override });
      expect(decision.allow, JSON.stringify(override)).toBe(false);
      expect(decision.effectiveDryRun, JSON.stringify(override)).toBe(true);
    }
  });

  it('consumes the run-bound nonce once and fails closed on a second use', () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'human-side-effect-gate-'));
    const { nonce } = evaluateHumanApproval(APPROVED_INPUT);
    const first = consumeApprovalNonce({ nonce, runnerTemp: tempRoot });
    const second = consumeApprovalNonce({ nonce, runnerTemp: tempRoot });
    expect(first).toEqual({ consumed: true, reason: 'nonce-consumed-once' });
    expect(second).toEqual({ consumed: false, reason: 'nonce-already-consumed' });
  });

  it('writes deny outputs for an unarmed scheduled run without contacting any external system', () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'human-side-effect-gate-cli-'));
    const outputPath = path.join(tempRoot, 'github-output');
    const code = main({
      env: {
        GITHUB_EVENT_NAME: 'schedule',
        GITHUB_ACTOR: 'github-actions[bot]',
        GITHUB_TRIGGERING_ACTOR: 'github-actions[bot]',
        GITHUB_REPOSITORY: APPROVED_INPUT.repository,
        GITHUB_WORKFLOW: APPROVED_INPUT.workflow,
        GITHUB_RUN_ID: APPROVED_INPUT.runId,
        GITHUB_RUN_ATTEMPT: APPROVED_INPUT.runAttempt,
        APPROVAL_ACTOR_TYPE: 'Bot',
        APPROVAL_CONSENT: 'false',
        APPROVAL_DRY_RUN: '',
        APPROVAL_SCOPE: APPROVED_INPUT.scope,
        RUNNER_TEMP: tempRoot,
        GITHUB_OUTPUT: outputPath,
      },
      logger: { log() {}, error() {} },
    });
    expect(code).toBe(0);
    expect(fs.readFileSync(outputPath, 'utf8')).toContain('allow_side_effect=false');
    expect(fs.readFileSync(outputPath, 'utf8')).toContain('effective_dry_run=true');
  });
});

describe('publisher dispatch provenance verifier', () => {
  it('accepts a realistic in-progress run response without a run-level workflow path', () => {
    const runMetadata = sourceRun();
    expect(runMetadata).not.toHaveProperty('path');
    const decision = verifyPublisher({ runMetadata });
    expect(decision).toMatchObject({ verified: true, reason: 'publisher-source-run-verified', reasons: [] });
  });

  it('rejects a payload that is not the exact attestation contract', () => {
    for (const [name, clientPayload, reason] of [
      ['wrong schema', { schema_version: '1' }, 'publisher-payload-schema-mismatch'],
      ['extra key', { unexpected: 'value' }, 'publisher-payload-shape-mismatch'],
      ['wrong source repository', { source_repository: 'other/repository' }, 'publisher-source-repository-mismatch'],
      ['wrong source workflow', { source_workflow: 'Other workflow' }, 'publisher-source-workflow-mismatch'],
    ] as const) {
      const decision = verifyPublisher({ clientPayload });
      expect(decision.verified, name).toBe(false);
      expect(decision.reasons, name).toContain(reason);
    }
  });

  it('rejects source run metadata that does not bind repo, workflow, run, or SHA', () => {
    for (const [name, runMetadata, clientPayload, reason] of [
      ['wrong API repository', sourceRun({ repository: { full_name: 'other/repository' } }), {}, 'publisher-source-run-repository-mismatch'],
      ['wrong run id', sourceRun({ id: 987654321 }), {}, 'publisher-source-run-id-mismatch'],
      ['wrong run attempt', sourceRun({ run_attempt: 2 }), {}, 'publisher-source-run-attempt-mismatch'],
      ['wrong SHA in payload', sourceRun(), { source_sha: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb' }, 'publisher-source-sha-mismatch'],
      ['wrong SHA in API', sourceRun({ head_sha: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb' }), {}, 'publisher-source-sha-mismatch'],
    ] as const) {
      const decision = verifyPublisher({ runMetadata, clientPayload });
      expect(decision.verified, name).toBe(false);
      expect(decision.reasons, name).toContain(reason);
    }
  });

  it('rejects workflow identity and branch/event mismatches', () => {
    for (const [name, runMetadata, workflowMetadata, clientPayload, reason] of [
      ['wrong workflow API name', sourceRun(), { ...VALID_SOURCE_WORKFLOW, name: 'Other workflow' }, {}, 'publisher-source-workflow-api-name-mismatch'],
      ['wrong workflow API path', sourceRun(), { ...VALID_SOURCE_WORKFLOW, path: '.github/workflows/other.yml' }, {}, 'publisher-source-workflow-api-path-mismatch'],
      ['wrong workflow API id', sourceRun(), { ...VALID_SOURCE_WORKFLOW, id: 999999999 }, {}, 'publisher-source-run-workflow-binding-mismatch'],
      ['wrong branch', sourceRun({ head_branch: 'develop' }), undefined, {}, 'publisher-source-branch-api-mismatch'],
      ['wrong event', sourceRun({ event: 'workflow_dispatch' }), undefined, {}, 'publisher-source-event-api-mismatch'],
      ['wrong branch claim', sourceRun(), undefined, { source_branch: 'develop' }, 'publisher-source-branch-mismatch'],
      ['wrong event claim', sourceRun(), undefined, { source_event: 'workflow_dispatch' }, 'publisher-source-event-mismatch'],
    ] as const) {
      const decision = verifyPublisher({ runMetadata, workflowMetadata, clientPayload });
      expect(decision.verified, name).toBe(false);
      expect(decision.reasons, name).toContain(reason);
    }
  });

  it('rejects API errors and failed/cancelled/unknown states', () => {
    for (const [name, runMetadata, reason] of [
      ['run API error', null, 'publisher-source-run-api-response-invalid'],
      ['workflow API error', sourceRun(), 'publisher-source-workflow-api-response-invalid'],
      // A conclusion, once present, must be exactly `success`. These three used
      // to report `publisher-source-run-status-not-allowed` because completed
      // was refused wholesale; now the refusal is specific to the conclusion.
      ['failed run', sourceRun({ status: 'completed', conclusion: 'failure' }), 'publisher-source-run-not-successful'],
      ['cancelled run', sourceRun({ status: 'completed', conclusion: 'cancelled' }), 'publisher-source-run-not-successful'],
      ['completed without conclusion', sourceRun({ status: 'completed', conclusion: null }), 'publisher-source-run-not-successful'],
      ['unknown status', sourceRun({ status: 'unknown', conclusion: null }), 'publisher-source-run-status-not-allowed'],
      // The hole reviewers caught in the first draft of this fix: an
      // in_progress run outlives the lookup retries and would otherwise
      // authorize a sync from a publication that can still fail afterwards.
      ['still in progress', sourceRun({ status: 'in_progress', conclusion: null }), 'publisher-source-run-status-not-allowed'],
      ['queued', sourceRun({ status: 'queued', conclusion: null }), 'publisher-source-run-status-not-allowed'],
    ] as const) {
      const decision = verifyPublisher({
        runMetadata,
        workflowMetadata: name === 'workflow API error' ? null : VALID_SOURCE_WORKFLOW,
      });
      expect(decision.verified, name).toBe(false);
      expect(decision.reasons, name).toContain(reason);
    }
  });

  // ── The regression this whole block exists for ───────────────────────────
  //
  // The predecessor of this test asserted the opposite: `['completed success
  // replay', …, 'publisher-source-run-status-not-allowed']`. That rule cannot
  // be satisfied by the workflow that enforces it. The provenance step runs
  // only after a 46'229-file checkout of this repo, and by then the publisher
  // run has finished — so from 8d953d627c8 (2026-09-16T19:25Z) every
  // `articles-published` dispatch denied, `Commit if changed` never ran, and
  // packages/articles/content sat at 49b38547dad for ~52h while the corpus
  // went on publishing. The visible symptom was two repos disagreeing about
  // how many svizzera articles exist: 2157 here against 2183 announced, which
  // tripped rerender-article-hubs' freshness guard (tolerance 25) on run
  // 35308833501 and stayed red for 9 runs.
  it('accepts a publisher run that has already completed successfully', () => {
    const decision = verifyPublisher({ runMetadata: sourceRun() });
    expect(decision).toMatchObject({ verified: true, reason: 'publisher-source-run-verified' });
  });

  it('bounds replay by freshness instead of by liveness', () => {
    // Anti-replay is the reason completed was refused in the first place, so
    // the property has to survive the change: an old payload names a run whose
    // last activity is long past, and updated_at comes from the API response
    // rather than from the attested client_payload.
    for (const [name, runMetadata, now, reason] of [
      ['replayed hours later', sourceRun(), NOW + 6 * 60 * 60 * 1000, 'publisher-source-run-stale'],
      ['updated in the future', sourceRun(), NOW - 6 * 60 * 60 * 1000, 'publisher-source-run-stale'],
      ['no timestamp at all', sourceRun({ updated_at: undefined }), NOW, 'publisher-source-run-updated-at-invalid'],
      ['unparseable timestamp', sourceRun({ updated_at: 'yesterday' }), NOW, 'publisher-source-run-updated-at-invalid'],
    ] as const) {
      const decision = verifyPublisher({ runMetadata, now });
      expect(decision.verified, name).toBe(false);
      expect(decision.reasons, name).toContain(reason);
    }

    // And the window is wide enough for the real latency it has to absorb —
    // the 2m36s job measured in run 35362400341, with headroom.
    const withinWindow = verifyPublisher({
      runMetadata: sourceRun(),
      now: Date.parse(SOURCE_RUN_UPDATED_AT) + 30 * 60 * 1000,
    });
    expect(withinWindow.verified).toBe(true);
  });

  // The regression the reviewers' first finding named: anchoring the window on
  // run_started_at makes it double as a cap on how long a publisher run may
  // LAST, so a legitimately slow run is rejected as stale and the corpus
  // freezes again. Publisher runs measured 2.5-3.5 min on 2026-09-18, but the
  // corpus grows, and this is the failure class the whole file is repairing.
  it('does not cap how long the publisher run may take', () => {
    const slowRun = sourceRun({
      // Started four hours before it finished; finished seconds ago.
      run_started_at: new Date(NOW - 4 * 60 * 60 * 1000).toISOString(),
      updated_at: new Date(NOW - 30 * 1000).toISOString(),
    });
    expect(verifyPublisher({ runMetadata: slowRun, now: NOW }).verified).toBe(true);
  });

  it('rejects source reruns even if all other metadata matches', () => {
    const decision = verifyPublisher({
      clientPayload: { source_run_attempt: '2' },
      runMetadata: sourceRun({ run_attempt: 2 }),
    });
    expect(decision.verified).toBe(false);
    expect(decision.reasons).toContain('publisher-source-run-is-rerun');
  });

  it('writes a deny output when the API response files are unavailable', () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'publisher-dispatch-verifier-'));
    const eventPath = path.join(tempRoot, 'event.json');
    const outputPath = path.join(tempRoot, 'github-output');
    fs.writeFileSync(eventPath, JSON.stringify(VALID_PUBLISHER_EVENT));
    const code = verifyPublisherMain({
      env: { GITHUB_EVENT_PATH: eventPath, GITHUB_OUTPUT: outputPath },
      argv: ['node', 'verify-publisher-dispatch.mjs', path.join(tempRoot, 'missing-run.json'), path.join(tempRoot, 'missing-workflow.json')],
      logger: { log() {}, error() {} },
    });
    expect(code).toBe(0);
    expect(fs.readFileSync(outputPath, 'utf8')).toContain('verified=false');
  });
});

describe('workflow wiring for the bounded F3/F4 side-effect surface', () => {
  it('verifies the publisher contract before the gate and pins every binding', () => {
    const source = workflow('sync-articles-sitemaps.yml');
    expect(source).toContain('Verify publisher provenance via read-only metadata API');
    expect(source).toContain('node scripts/ci/verify-publisher-dispatch.mjs');
    expect(source).toContain('gh api --method GET');
    expect(source).toContain('actions/runs/$PUBLISHER_SOURCE_RUN_ID');
    expect(source).toContain("actions/workflows/publish-api.yml");
    expect(source).toContain("PUBLISHER_SOURCE_RUN_ID: ${{ github.event.client_payload.source_run_id || '' }}");
    expect(source).toContain('APPROVAL_EVENT: ${{ github.event_name }}');
    expect(source).toContain('APPROVAL_ACTOR: ${{ github.actor }}');
    expect(source).toContain('APPROVAL_TRIGGERING_ACTOR: ${{ github.triggering_actor }}');
    expect(source).toContain("APPROVAL_DISPATCH_ACTOR: ${{ github.event.sender.login || '' }}");
    expect(source).toContain("APPROVAL_DISPATCH_ACTION: ${{ github.event.action || '' }}");
    expect(source).toContain('APPROVAL_DISPATCH_PAYLOAD_PRESENT: ${{ github.event.client_payload != null }}');
    expect(source).toContain("APPROVAL_PUBLISHER_SOURCE_VERIFIED: ${{ steps.publisher_provenance.outputs.verified || 'false' }}");
    expect(source).toContain("APPROVAL_DISPATCH_SOURCE_SCHEMA_VERSION: ${{ github.event.client_payload.schema_version || '' }}");
    expect(source).toContain("APPROVAL_DISPATCH_SOURCE_REPOSITORY: ${{ github.event.client_payload.source_repository || '' }}");
    expect(source).toContain("APPROVAL_DISPATCH_SOURCE_WORKFLOW: ${{ github.event.client_payload.source_workflow || '' }}");
    expect(source).toContain("APPROVAL_DISPATCH_SOURCE_WORKFLOW_PATH: ${{ github.event.client_payload.source_workflow_path || '' }}");
    expect(source).toContain("APPROVAL_DISPATCH_SOURCE_RUN_ID: ${{ github.event.client_payload.source_run_id || '' }}");
    expect(source).toContain("APPROVAL_DISPATCH_SOURCE_RUN_ATTEMPT: ${{ github.event.client_payload.source_run_attempt || '' }}");
    expect(source).toContain("APPROVAL_DISPATCH_SOURCE_SHA: ${{ github.event.client_payload.source_sha || '' }}");
    expect(source).toContain("APPROVAL_DISPATCH_SOURCE_BRANCH: ${{ github.event.client_payload.source_branch || '' }}");
    expect(source).toContain("APPROVAL_DISPATCH_SOURCE_EVENT: ${{ github.event.client_payload.source_event || '' }}");
    expect(source).toContain('APPROVAL_EXPECTED_DISPATCH_ACTOR: valerielinc-ops');
    expect(source).toContain('APPROVAL_EXPECTED_DISPATCH_REPOSITORY: valerielinc-ops/frontaliere-si-o-no');
    expect(source).toContain('APPROVAL_EXPECTED_DISPATCH_SCOPE: article-sitemap-publication');
    expect(source).toContain('APPROVAL_EXPECTED_DISPATCH_WORKFLOW: Sync article sitemaps, feeds and ticker from the articles API');
  });

  it('asks "may this run write?" in exactly one place', () => {
    // The `gate` step always claimed to be that one place, but it read only
    // the two pull outputs. `Commit if changed` carried a second, independent
    // copy of the side-effect condition, so a withheld write permission left
    // `skipped` false: the escalation never fired and `Clear the skip
    // escalation` CLOSED the standing issue on every denied run. That is the
    // mechanism that turned a dead pipeline into a wall of green.
    const source = workflow('sync-articles-sitemaps.yml');
    const gate = step(source, 'Decide whether this run may commit');
    expect(gate).toContain('ALLOW_SIDE_EFFECT: ${{ steps.side_effect_gate.outputs.allow_side_effect }}');
    expect(gate).toContain('EFFECTIVE_DRY_RUN: ${{ steps.side_effect_gate.outputs.effective_dry_run }}');

    // The commit keeps stating the side-effect condition verbatim — the
    // inventory test above requires that of every writer step, so permission
    // cannot be laundered through an intermediate output. What the fold buys
    // is that `skipped` is now true whenever nothing will be committed, for
    // ANY reason, which is what the escalation and the resolve hang off.
    const commit = step(source, 'Commit if changed');
    expect(commit).toContain("steps.gate.outputs.skipped != 'true'");
    expect(commit).toContain("steps.side_effect_gate.outputs.allow_side_effect == 'true'");

    const escalate = step(source, 'Escalate a sync that keeps being skipped');
    expect(escalate).toContain("steps.gate.outputs.skipped == 'true'");
    const resolve = step(source, 'Clear the skip escalation');
    expect(resolve).toContain("steps.gate.outputs.skipped != 'true'");
  });

  it('ritenta solo lookup transitori e run queued, mantenendo il deny sui terminali', () => {
    const source = workflow('sync-articles-sitemaps.yml');
    const start = source.indexOf('- name: Verify publisher provenance via read-only metadata API');
    const end = source.indexOf('\n      - name:', start + 1);
    const verifier = source.slice(start, end);

    expect(verifier).toContain('max_lookup_attempts=3');
    expect(verifier).toContain('while [ "$lookup_attempt" -le "$max_lookup_attempts" ]');
    expect(verifier).toContain("[ \"$run_status\" = 'queued' ]");
    expect(verifier).toContain("[ \"$run_status\" = 'in_progress' ]");
    expect(verifier).toContain('lookup_delay=$((lookup_attempt * 15))');
    expect(verifier).toContain('sleep "$lookup_delay"');
    expect(verifier).toContain('verifier remains fail-closed');
    expect(verifier).toContain("if [ \"$workflow_lookup_ok\" != 'true' ] || [ \"$workflow_shape_ok\" != 'true' ]; then");
    expect(verifier.indexOf("if [ \"$workflow_lookup_ok\" != 'true' ] || [ \"$workflow_shape_ok\" != 'true' ]; then")).toBeLessThan(
      verifier.indexOf('else\n                break'),
    );
    expect(verifier.indexOf('node scripts/ci/verify-publisher-dispatch.mjs')).toBeGreaterThan(
      verifier.indexOf('while [ "$lookup_attempt" -le "$max_lookup_attempts" ]'),
    );
  });

  for (const name of SIDE_EFFECT_WORKFLOWS) {
    it(`${name} puts every live side-effect path behind the shared gate`, () => {
      const source = workflow(name);
      expect(source).toContain('scripts/ci/human-side-effect-gate.mjs');
      const approvalBlock = source.match(/human_approval:[\s\S]{0,240}/u)?.[0] ?? '';
      expect(approvalBlock).toMatch(/type:\s*boolean/u);
      expect(approvalBlock).toMatch(/default:\s*false/u);
      const dryRunBlock = source.match(/dry_run:[\s\S]{0,240}/u)?.[0] ?? '';
      expect(dryRunBlock).toMatch(/default:\s*['"]?true/u);
      expect(source).toContain('APPROVAL_ACTOR_TYPE');
      expect(source).toContain('steps.side_effect_gate.outputs.allow_side_effect');
      expect(source).toContain('steps.side_effect_gate.outputs.effective_dry_run');
    });

    it(`${name} gates credential/provider hydration before any secret-bearing step`, () => {
      const source = workflow(name);
      const document = YAML.parse(source) as { jobs?: Record<string, { steps?: Array<Record<string, unknown>> }> };
      for (const [jobName, job] of Object.entries(document.jobs ?? {})) {
        const steps = job.steps ?? [];
        const gateIndex = steps.findIndex((step) => step.id === 'side_effect_gate');
        expect(gateIndex, `${name}:${jobName} missing side_effect_gate`).toBeGreaterThanOrEqual(0);
        for (const step of credentialHydrationSteps(source).filter((candidate) => candidate.jobName === jobName)) {
          expect(step.index, `${name}:${jobName}:${step.name} must follow the gate`).toBeGreaterThan(gateIndex);
          expect(step.if, `${name}:${jobName}:${step.name} must deny by default`).toContain(APPROVED_GATE_IF);
        }
      }
    });
  }

  for (const [name, stepPatterns] of Object.entries(GATED_SIDE_EFFECT_STEPS)) {
    it(`${name} gates every inventoried writer/provider path`, () => {
      const document = YAML.parse(workflow(name)) as { jobs?: Record<string, { steps?: Array<Record<string, unknown>> }> };
      const steps = Object.values(document.jobs ?? {}).flatMap((job) => job.steps ?? []);
      for (const pattern of stepPatterns) {
        const matches = steps.filter((step) => pattern.test(String(step.name ?? '')));
        expect(matches, `${name}: missing inventoried side-effect step ${pattern}`).not.toHaveLength(0);
        for (const step of matches) {
          const condition = String(step.if ?? '');
          const gateCondition = condition.match(
            /steps\.side_effect_gate\.outputs\.allow_side_effect == 'true'\s+(?:&&|\|\|)\s+steps\.side_effect_gate\.outputs\.effective_dry_run\s+(?:!=|==)\s+'true'/u,
          )?.[0] ?? '';
          expect(gateCondition, `${name}:${String(step.name)} must use the exact approved gate`).toBe(APPROVED_GATE_IF);
        }
      }
    });
  }

  it('uses the exact approved gate expression on every scheduled side-effect path', () => {
    for (const name of SCHEDULE_SIDE_EFFECT_WORKFLOWS) {
      const document = YAML.parse(workflow(name)) as { jobs?: Record<string, { steps?: Array<Record<string, unknown>> }> };
      const steps = Object.values(document.jobs ?? {}).flatMap((job) => job.steps ?? []);
      const gatedSteps = steps.filter((step) => String(step.if ?? '').includes('steps.side_effect_gate.outputs.allow_side_effect'));
      expect(gatedSteps, `${name}: no side-effect gate consumers found`).not.toHaveLength(0);
      for (const step of gatedSteps) {
        const condition = String(step.if ?? '');
        const gateCondition = condition.match(
          /steps\.side_effect_gate\.outputs\.allow_side_effect == 'true'\s+(?:&&|\|\|)\s+steps\.side_effect_gate\.outputs\.effective_dry_run\s+(?:!=|==)\s+'true'/u,
        )?.[0] ?? '';
        expect(gateCondition, `${name}:${String(step.name)} must use the exact approved gate`).toBe(APPROVED_GATE_IF);
      }
    }
  });

  it('retains the defense-in-depth dry-run downgrade in every guarded run step', () => {
    for (const [name, stepName, downgrade] of DEFENSE_IN_DEPTH_GUARDS) {
      const document = YAML.parse(workflow(name)) as { jobs?: Record<string, { steps?: Array<Record<string, unknown>> }> };
      const matches = Object.values(document.jobs ?? {}).flatMap((job) => job.steps ?? [])
        .filter((step) => String(step.name ?? '') === stepName);
      expect(matches, `${name}: missing guarded step ${stepName}`).toHaveLength(1);
      const run = String(matches[0].run ?? '');
      expect(run, `${name}:${stepName} missing side-effect downgrade`).toContain(DEFENSE_IN_DEPTH_GUARD_CONDITION);
      expect(run, `${name}:${stepName} missing ${downgrade}`).toContain(downgrade);
    }

    const recover = YAML.parse(workflow('recover-prev-slugs.yml')) as {
      jobs?: Record<string, { steps?: Array<Record<string, unknown>> }>;
    };
    const recoverSteps = Object.values(recover.jobs ?? {}).flatMap((job) => job.steps ?? []);
    for (const [stepName, downgrade] of RECOVER_PREV_SLUG_GUARDS) {
      const step = recoverSteps.find((candidate) => String(candidate.name ?? '') === stepName);
      expect(step, `recover-prev-slugs.yml: missing guarded step ${stepName}`).toBeDefined();
      expect(step?.env, `recover-prev-slugs.yml:${stepName} missing DRY_RUN env`).toMatchObject({
        DRY_RUN: '${{ steps.side_effect_gate.outputs.effective_dry_run }}',
      });
      expect(String(step?.run ?? ''), `recover-prev-slugs.yml:${stepName} missing ${downgrade}`).toContain(downgrade);
    }
  });

  it('fails a scheduled plate-auction refresh whose producer was skipped', () => {
    // Measured on run 35368321723 (2026-09-18 16:24Z), reported SUCCESS:
    // `Refresh every active public catalogue` skipped, yet `Fail closed on
    // source health or snapshot drift` passed because it re-validates the
    // COMMITTED snapshot instead of a fresh fetch. Run conclusions cannot
    // distinguish that from a real refresh; only a step-level assertion can.
    const document = YAML.parse(workflow('refresh-plate-auctions.yml')) as {
      jobs?: Record<string, { steps?: Array<Record<string, unknown>> }>;
    };
    const steps = Object.values(document.jobs ?? {}).flatMap((job) => job.steps ?? []);

    const producer = steps.find((step) => String(step.name ?? '') === 'Refresh every active public catalogue');
    expect(producer, 'producer step missing').toBeDefined();
    expect(producer?.id, 'producer needs an id so its outcome is addressable').toBe('refresh');

    const guard = steps.find((step) => String(step.name ?? '').startsWith('Fail a scheduled run whose refresh'));
    expect(guard, 'missing step-level liveness check').toBeDefined();
    const condition = String(guard?.if ?? '');
    expect(condition).toContain("steps.refresh.outcome == 'skipped'");
    expect(condition).toContain("github.event_name == 'schedule'");
    expect(condition).toContain('always()');

    // Documents WHY the liveness check has to exist: the drift check is
    // unconditional, so it cannot be the thing that catches a dead refresh.
    const drift = steps.find((step) => String(step.name ?? '') === 'Fail closed on source health or snapshot drift');
    expect(drift, 'drift check missing').toBeDefined();
    expect(drift?.if, 'drift check runs unconditionally; it validates the committed file').toBeUndefined();
  });

  it('arms trusted schedules only on workflows whose schedules apply side effects', () => {
    expect(SCHEDULE_ARMED_WORKFLOWS).toHaveLength(19);
    expect(SCHEDULE_UNARMED_WORKFLOWS).toHaveLength(9);
    expect(SCHEDULE_SIDE_EFFECT_WORKFLOWS).toHaveLength(28);

    for (const name of SCHEDULE_SIDE_EFFECT_WORKFLOWS) {
      const document = YAML.parse(workflow(name)) as { jobs?: Record<string, { steps?: Array<Record<string, unknown>> }> };
      const gateSteps = Object.values(document.jobs ?? {}).flatMap((job) => job.steps ?? [])
        .filter((step) => step.id === 'side_effect_gate');
      expect(gateSteps, `${name}: missing side_effect_gate`).toHaveLength(1);
      const trustedSchedule = (gateSteps[0].env as Record<string, unknown> | undefined)?.APPROVAL_TRUSTED_SCHEDULE;
      if (SCHEDULE_ARMED_WORKFLOWS.includes(name)) {
        expect(trustedSchedule, `${name}: schedule opt-in missing`).toBe('true');
      } else {
        expect(trustedSchedule, `${name}: schedule opt-in must stay absent`).toBeUndefined();
      }
    }

    const workflowDir = path.join(ROOT, '.github', 'workflows');
    const armedElsewhere = fs.readdirSync(workflowDir)
      .filter((name) => /\.ya?ml$/u.test(name) && !SCHEDULE_SIDE_EFFECT_WORKFLOWS.includes(name))
      .filter((name) => workflow(name).includes('APPROVAL_TRUSTED_SCHEDULE'));
    expect(armedElsewhere).toEqual([]);
  });
});
