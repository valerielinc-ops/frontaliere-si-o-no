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
  'mirror-articles-corpus.yml',
  'sync-articles-sitemaps.yml',
  'crawl-events.yml',
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
});
