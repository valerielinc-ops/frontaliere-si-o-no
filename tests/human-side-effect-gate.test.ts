import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import YAML from 'yaml';

// @ts-expect-error — the provenance verifier is a dependency-free ESM CI script.
import {
  evaluatePublisherDispatchAttestation,
  PUBLISHER_SOURCE_REPOSITORY,
  PUBLISHER_SOURCE_WORKFLOW,
  PUBLISHER_SOURCE_WORKFLOW_PATH,
  main as verifyPublisherMain,
} from '../scripts/ci/verify-publisher-dispatch.mjs';

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
const workflowDir = path.join(ROOT, '.github', 'workflows');
const workflow = (name: string) => fs.readFileSync(path.join(ROOT, '.github', 'workflows', name), 'utf8');
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
    /Trigger deploy after validated backfill/u,
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

describe('workflow wiring without the human approval gate', () => {
  it('removes the shared gate and approval input from every inventoried workflow', () => {
    for (const name of SIDE_EFFECT_WORKFLOWS) {
      const source = workflow(name)
      expect(source).not.toContain('scripts/ci/human-side-effect-gate.mjs')
      expect(source).not.toContain('human_approval:')
      expect(source).not.toContain('id: side_effect_gate')
      expect(source).not.toContain('steps.side_effect_gate')
      expect(source).toContain("inputs.dry_run != true && inputs.dry_run != 'true'")
    }

    const residual = fs
      .readdirSync(workflowDir)
      .filter((name) => name.endsWith('.yml'))
      .filter((name) => {
        const source = fs.readFileSync(path.join(workflowDir, name), 'utf8')
        return (
          source.includes('scripts/ci/human-side-effect-gate.mjs') ||
          source.includes('human_approval:') ||
          source.includes('id: side_effect_gate') ||
          source.includes('steps.side_effect_gate')
        )
      })

    expect(residual).toEqual([])

    const coldMail = YAML.parse(workflow('cold-email-outreach.yml'))
    expect(String(coldMail.jobs.outreach.if)).toContain('COLD_EMAIL_OUTREACH_ENABLED')
  })

  it('keeps cold mail as the explicit owner-disabled exception', () => {
    const source = workflow('cold-email-outreach.yml')
    expect(source).toContain('OWNER DECISION: this workflow is intentionally blocked')
    expect(source).not.toContain('human_approval:')
    expect(source).not.toContain('scripts/ci/human-side-effect-gate.mjs')
  })

  it('preserves publisher provenance validation without human approval', () => {
    const source = workflow('sync-articles-sitemaps.yml')
    expect(source).toContain('Verify publisher provenance via read-only metadata API')
    expect(source).toContain('node scripts/ci/verify-publisher-dispatch.mjs')
    expect(source).toContain('gh api --method GET')
    expect(source).toContain('Reject publisher dispatch without attestation')
    expect(source).not.toContain('APPROVAL_')
    expect(source).not.toContain('human-side-effect-gate.mjs')

    const gate = step(source, 'Decide whether this run may commit')
    expect(gate).toContain("ALLOW_SIDE_EFFECT: 'true'")
    expect(gate).toContain(
      'EFFECTIVE_DRY_RUN: ' + '$' + "{{ inputs.dry_run == true || inputs.dry_run == 'true' }}",
    )
    expect(gate).toContain("reason='dry-run requested'")

    const commit = step(source, 'Commit if changed')
    expect(commit).toContain("steps.gate.outputs.skipped != 'true'")
    expect(commit).toContain("inputs.dry_run != true && inputs.dry_run != 'true'")
  })

  it('preserves the newsletter workflow_run handoff check', () => {
    const source = workflow('send-newsletter.yml')
    expect(source).toContain('allow_workflow_run')
    expect(source).toContain("github.event_name != 'workflow_run'")
    expect(source).not.toContain('APPROVAL_TRUSTED_WORKFLOW_RUN')
    expect(source).not.toContain('human-side-effect-gate.mjs')
  })

  it('allows only successful upstream workflow_run events for GSC orphan sync', () => {
    const source = workflow('sync-gsc-orphans.yml')
    expect(source).toContain("github.event.workflow_run.conclusion == 'success'")
    expect(source).not.toContain('human-side-effect-gate.mjs')
  })

  it('retains defense-in-depth guards in the side-effect scripts', () => {
    for (const [name, script, guard] of DEFENSE_IN_DEPTH_GUARDS) {
      const source = workflow(name)
      const guardedStep = step(source, script)
      expect(guardedStep, name + ' / ' + script).toContain(guard)
    }

    const recover = workflow('recover-prev-slugs.yml')
    expect(recover).toContain(
      "DRY_RUN: " + '$' + "{{ inputs.dry_run == true || inputs.dry_run == 'true' }}",
    )
  })

  it('keeps dry-run guards on the former gated side-effect steps', () => {
    for (const [name, patterns] of Object.entries(GATED_SIDE_EFFECT_STEPS)) {
      const source = workflow(name)
      const document = YAML.parse(source) as {
        jobs?: Record<string, { steps?: Array<Record<string, unknown>> }>
      }
      const steps = Object.values(document.jobs ?? {}).flatMap((job) => job.steps ?? [])
      for (const pattern of patterns) {
        const matches = steps.filter((candidate) => pattern.test(String(candidate.name ?? '')))
        expect(matches, name + ': missing inventoried side-effect step ' + pattern).not.toHaveLength(0)
        for (const candidate of matches) {
          expect(String(candidate.if ?? ''), name + ' / ' + String(candidate.name)).toContain(
            "inputs.dry_run != true && inputs.dry_run != 'true'",
          )
        }
      }
    }
  })

  it('still fails a scheduled plate-auction refresh when its producer did not run', () => {
    const source = workflow('refresh-plate-auctions.yml')
    const producer = step(source, 'Refresh every active public catalogue')
    const liveness = step(source, 'Fail a scheduled run whose refresh never executed')

    expect(producer).toContain("inputs.dry_run != true && inputs.dry_run != 'true'")
    expect(liveness).toContain("github.event_name == 'schedule'")
    expect(liveness).toContain("steps.refresh.outcome == 'skipped'")
    expect(liveness).toContain('exit 1')
  })
})
