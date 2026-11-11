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
const verifySource = readFileSync(
  new URL('../scripts/assisted-application/lib/portal/verify.mjs', import.meta.url),
  'utf8',
);
const ownerExtensionSource = readFileSync(
  new URL('../scripts/assisted-application/extension/background.js', import.meta.url),
  'utf8',
);
const ownerExtensionGuide = readFileSync(
  new URL('../scripts/assisted-application/extension/README.md', import.meta.url),
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

    const installRun = steps[chromiumInstall]?.run || '';
    expect(installRun).toContain('Acquire::ForceIPv4 "true"');
    expect(installRun).toContain('npx playwright install chromium || npx playwright install --with-deps chromium');
  });

  it('hands every CAPTCHA to Valerie without stealth or challenge automation', () => {
    const runScript = steps.find(step => step.name === 'Run agent')?.run || '';
    expect(workflowSource).not.toContain('NOPECHA_EXTENSION_PATH');
    expect(steps.some(step => /NopeCHA|install-nopecha/iu.test(`${step.name || ''} ${step.run || ''}`))).toBe(false);
    expect(workflowSource).not.toContain('STEALTH_BROWSER_ASSISTED');
    expect(workflowSource).not.toContain('CLOAKBROWSER_LICENSE_KEY_ASSISTED');
    expect(runScript).toMatch(/xvfb-run/u);
    expect(runScript).toContain('export ASSISTED_APPLICATION_HEADED=1');
    expect(portalSource).not.toContain('NOPECHA_EXTENSION_PATH');
    expect(portalSource).not.toContain('launchNopechaContext');
    expect(portalSource).not.toContain('awaitCaptcha');
    expect(portalSource).not.toContain('launchStealthOrChromium');
    expect(portalSource).not.toContain('passPortalChallenge');
    expect(portalSource).not.toContain('chromeUserAgent');
    expect(verifySource).not.toContain('realisticUserAgent');
    expect(verifySource).not.toContain('userAgent:');
    expect(portalSource).toContain("if (snapshot.captcha) return await handoff('captcha');");
    expect(portalSource).toContain("if (after.captcha) return await handoff('captcha');");
    expect(portalSource).toContain("if (outcome === 'captcha') return await handoff('captcha');");
  });

  it('uses Valerie’s separate Chrome extension session after the CI runner hands off', () => {
    expect(ownerExtensionSource).toContain("case 'fill-order':");
    expect(ownerExtensionSource).toContain("chrome.tabs.create({ url: 'about:blank', active: true })");
    expect(ownerExtensionGuide).toContain('Valerie invia la candidatura dal proprio browser');
    expect(ownerExtensionGuide).toMatch(/Se il portale mostra un\s+CAPTCHA visibile, risolvilo tu\./u);
  });
});
