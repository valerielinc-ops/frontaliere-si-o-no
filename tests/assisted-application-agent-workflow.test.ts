import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import YAML from 'yaml';

type Step = {
  name?: string;
  run?: string;
  if?: string;
  'working-directory'?: string;
  'timeout-minutes'?: number;
};

const workflowSource = readFileSync(
  new URL('../.github/workflows/assisted-application-agent.yml', import.meta.url),
  'utf8',
);
const portalSource = readFileSync(
  new URL('../scripts/assisted-application/lib/portal/portal.mjs', import.meta.url),
  'utf8',
);
const workflow = YAML.parse(workflowSource) as { jobs?: { agent?: { steps?: Step[]; 'timeout-minutes'?: number } } };
const agentJob = workflow.jobs?.agent;
const steps = agentJob?.steps ?? [];

describe('assisted application agent workflow dependencies', () => {
  it('installs the Functions dependency graph before starting the agent', () => {
    const functionsInstall = steps.findIndex((step) => (
      step['working-directory'] === 'functions' && /\bnpm ci\b/u.test(step.run || '')
    ));
    const agentRun = steps.findIndex((step) => step.name === 'Run agent');

    expect(functionsInstall).toBeGreaterThanOrEqual(0);
    expect(agentRun).toBeGreaterThan(functionsInstall);
  });

  it('bounds Chromium setup and leaves the failure reporter reachable', () => {
    const chromiumInstall = steps.findIndex((step) => step.name === 'Install Chromium for the portal runner');
    const reconcileFailure = steps.findIndex((step) => step.name === 'Reconcile failed executor with the application queue');

    expect(chromiumInstall).toBeGreaterThanOrEqual(0);
    expect(steps[chromiumInstall]?.['timeout-minutes']).toBe(15);
    expect(steps[chromiumInstall]?.['timeout-minutes']).toBeLessThan(agentJob?.['timeout-minutes'] ?? 0);
    expect(reconcileFailure).toBeGreaterThan(chromiumInstall);
    expect(steps[reconcileFailure]?.if).toMatch(/failure\(\)/u);
  });

  // Owner decision 2026-11-09: CloakBrowser gets past what a real browser
  // passes (Cloudflare interstitial, Turnstile) before a CAPTCHA stop; what is
  // left still goes to Valerie, and NopeCHA stays out of production.
  it('tries the stealth challenge pass before a CAPTCHA stop, never NopeCHA', () => {
    expect(workflowSource).not.toContain('NOPECHA_EXTENSION_PATH');
    expect(steps.some(step => /NopeCHA|install-nopecha/iu.test(`${step.name || ''} ${step.run || ''}`))).toBe(false);
    expect(portalSource).not.toContain('process.env.NOPECHA_EXTENSION_PATH');
    expect(portalSource).not.toContain('launchNopechaContext');
    expect(portalSource).not.toContain('awaitCaptcha');
    expect(portalSource).toContain("if (snapshot.captcha && await passPortalChallenge(browser, page, { log, evidence })) snapshot = await extractFields(page, NAVIGATION);\n      if (snapshot.captcha) return await handoff('captcha');");
    expect(portalSource).toContain("if (after.captcha && await passPortalChallenge(browser, page, { log, evidence })) after = await extractFields(page, NAVIGATION);\n      if (after.captcha) return await handoff('captcha');");
    expect(portalSource).toContain("if (outcome === 'captcha') return await handoff('captcha');");
  });
});
