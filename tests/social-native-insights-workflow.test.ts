import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

describe('social native insights workflow contract', () => {
  it('refreshes the validated Codex pack weekly after Monday insights collection', () => {
    const workflow = readFileSync(resolve(ROOT, '.github/workflows/social-copy-pack.yml'), 'utf8');
    expect(workflow).toContain("- cron: '40 4 * * 1'");
    expect(workflow).not.toContain("- cron: '40 4 1 * *'");
  });

  it('persists Firebase credentials between workflow steps before loading Remote Config', () => {
    const workflow = readFileSync(resolve(ROOT, '.github/workflows/social-native-insights.yml'), 'utf8');
    const prepareStart = workflow.indexOf('      - name: Prepare Firebase credentials');
    const collectStart = workflow.indexOf('      - name: Collect private social post and audience metrics');
    const prepareEnd = workflow.indexOf('\n      - name:', prepareStart + 1);
    const prepare = workflow.slice(prepareStart, prepareEnd < 0 ? undefined : prepareEnd);
    const collectEnd = workflow.indexOf('\n      - name:', collectStart + 1);
    const collect = workflow.slice(collectStart, collectEnd < 0 ? undefined : collectEnd);
    const prepareRun = prepare.match(/        run: \|\n((?:          .*\n?)*)/u)?.[1] || '';
    const collectRun = collect.match(/        run: \|\n((?:          .*\n?)*)/u)?.[1] || '';
    const credentialsFile = prepareRun.indexOf("printf '%s' \"$FIREBASE_SERVICE_ACCOUNT_JSON\" > \"$RUNNER_TEMP/firebase-sa.json\"");
    const persistedCredential = prepareRun.indexOf('echo "GOOGLE_APPLICATION_CREDENTIALS=$RUNNER_TEMP/firebase-sa.json" >> "$GITHUB_ENV"');
    const loader = collectRun.indexOf('node scripts/load-rc-env.mjs');

    expect(prepareStart).toBeGreaterThanOrEqual(0);
    expect(collectStart).toBeGreaterThan(prepareStart);
    expect(prepareRun).not.toBe('');
    expect(collectRun).not.toBe('');
    expect(credentialsFile).toBeGreaterThanOrEqual(0);
    expect(persistedCredential).toBeGreaterThan(credentialsFile);
    expect(loader).toBeGreaterThanOrEqual(0);
  });

  it('reconciles copy experiment registrations only after the private collector succeeds', () => {
    const workflow = readFileSync(resolve(ROOT, '.github/workflows/social-native-insights.yml'), 'utf8');
    const collector = workflow.indexOf('      - name: Collect private social post and audience metrics');
    const reconciler = workflow.indexOf('      - name: Reconcile frozen social-copy registrations and winners');
    const stepEnd = workflow.indexOf('\n      - name:', reconciler + 1);
    const step = workflow.slice(reconciler, stepEnd < 0 ? undefined : stepEnd);

    expect(collector).toBeGreaterThanOrEqual(0);
    expect(reconciler).toBeGreaterThan(collector);
    expect(step).toContain('if: ${{ steps.collect.outcome == \'success\' }}');
    expect(step).toContain('node scripts/social-copy/experiment-protocol.mjs');
  });

  it('passes the explicit TikTok Display API eligibility variable to the fail-closed collector', () => {
    const workflow = readFileSync(resolve(ROOT, '.github/workflows/social-native-insights.yml'), 'utf8');

    expect(workflow).toContain('TIKTOK_DISPLAY_ANALYTICS_APPROVED: ${{ vars.TIKTOK_DISPLAY_ANALYTICS_APPROVED }}');
  });

  it('passes explicit LinkedIn post-metric retention approval to collection and reconciliation', () => {
    const workflow = readFileSync(resolve(ROOT, '.github/workflows/social-native-insights.yml'), 'utf8');
    const configWorkflow = readFileSync(resolve(ROOT, '.github/workflows/social-copy-experiment-config.yml'), 'utf8');

    expect(workflow.match(/LINKEDIN_MEMBER_POST_ANALYTICS_STORAGE_APPROVED: \$\{\{ vars\.LINKEDIN_MEMBER_POST_ANALYTICS_STORAGE_APPROVED \}\}/gu))
      .toHaveLength(2);
    expect(configWorkflow).toContain('LINKEDIN_MEMBER_POST_ANALYTICS_STORAGE_APPROVED: ${{ vars.LINKEDIN_MEMBER_POST_ANALYTICS_STORAGE_APPROVED }}');
  });

  it('passes the TikTok eligibility setting into the Codex performance brief build', () => {
    const workflow = readFileSync(resolve(ROOT, '.github/workflows/social-copy-pack.yml'), 'utf8');
    const stepStart = workflow.indexOf('      - name: Build minimized native social brief and growth scorecard');
    const stepEnd = workflow.indexOf('\n      - name:', stepStart + 1);
    const step = workflow.slice(stepStart, stepEnd < 0 ? undefined : stepEnd);

    expect(stepStart).toBeGreaterThanOrEqual(0);
    expect(step).toContain('TIKTOK_DISPLAY_ANALYTICS_APPROVED: ${{ vars.TIKTOK_DISPLAY_ANALYTICS_APPROVED }}');
    expect(workflow).toContain('including stored snapshots, are included only when');
    expect(workflow).toContain('TIKTOK_DISPLAY_ANALYTICS_APPROVED is exactly true');
  });

  it('reports aggregate stale publish reservations without post identifiers on every insights run', () => {
    const workflow = readFileSync(resolve(ROOT, '.github/workflows/social-native-insights.yml'), 'utf8');
    const reportStart = workflow.indexOf('      - name: Report aggregate stale social publish reservations');
    const reportEnd = workflow.indexOf('\n      - name:', reportStart + 1);
    const step = workflow.slice(reportStart, reportEnd < 0 ? undefined : reportEnd);

    expect(reportStart).toBeGreaterThanOrEqual(0);
    expect(step).toContain('always()');
    expect(step).toContain('node scripts/social-publish-reservations.mjs --summary-all >> "$GITHUB_STEP_SUMMARY"');
    expect(step).not.toContain('native-post-id');
    expect(step).not.toContain('key-hash');
  });
});
