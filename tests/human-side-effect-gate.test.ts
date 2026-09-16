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

/** Named writer/provider paths added by the Pasteur F5/F6/F9 inventory. */
const GATED_SIDE_EFFECT_STEPS: Record<string, RegExp[]> = {
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
  it('denies schedule/push/repository events and forces dry-run', () => {
    const decision = evaluateHumanApproval({ ...APPROVED_INPUT, event: 'schedule' });
    expect(decision.allow).toBe(false);
    expect(decision.effectiveDryRun).toBe(true);
    expect(decision.reason).toBe('event-not-workflow-dispatch');
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

  it('writes deny outputs for a scheduled run without contacting any external system', () => {
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

describe('workflow wiring for the bounded F3/F4 side-effect surface', () => {
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
          expect(condition, `${name}:${String(step.name)} must consume allow_side_effect`).toContain(
            'steps.side_effect_gate.outputs.allow_side_effect',
          );
          expect(condition, `${name}:${String(step.name)} must consume effective_dry_run`).toContain(
            'steps.side_effect_gate.outputs.effective_dry_run',
          );
        }
      }
    });
  }
});
