import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

// @ts-expect-error — the inventory is a dependency-free ESM CI script.
import {
  buildInventory,
  inspectWorkflow,
  renderMarkdown,
  strictViolations,
} from '../scripts/ci/workflow-risk-inventory.mjs';

describe('workflow-risk-inventory', () => {
  it('classifies direct production, commercial and communication mutations conservatively', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'workflow-risk-inventory-'));
    const file = path.join(root, 'send-company-alerts.yml');
    const source = `name: Company alerts\n# owner: Retention\non:\n  schedule:\n    - cron: '0 * * * *'\n  workflow_dispatch:\npermissions:\n  contents: write\n  issues: write\njobs:\n  send:\n    steps:\n      - run: git push origin main\n      - run: stripe checkout --price 10\n      - run: send-email --consent-required\n      - run: curl --fail https://example.test/health\n      - run: if [ "$KILL_SWITCH" = true ]; then exit 0; fi\n`;
    fs.writeFileSync(file, source);
    const workflow = inspectWorkflow({ file });
    expect(workflow).toMatchObject({
      riskLevel: 'critical',
      owner: 'Retention',
      directMutation: true,
      triggers: ['schedule', 'workflow_dispatch'],
      safeguards: { killSwitch: { present: true }, manualGate: true },
    });
    expect(workflow.risks).toEqual(expect.arrayContaining(['repository-write', 'commercial', 'communication', 'personal-data-consent', 'external-system']));
  });

  it('keeps a read-only workflow low risk with least-privilege evidence', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'workflow-risk-inventory-readonly-'));
    const file = path.join(root, 'observe.yml');
    fs.writeFileSync(file, `name: Observe\non:\n  schedule:\n    - cron: '0 0 * * *'\npermissions:\n  contents: read\njobs:\n  observe:\n    steps:\n      - run: node scripts/check.mjs\n`);
    const workflow = inspectWorkflow({ file });
    expect(workflow).toMatchObject({ riskLevel: 'low', directMutation: false, safeguards: { leastPrivilege: true } });
  });

  it('surfaces the repository-wide risk and ownership gaps without executing workflows', () => {
    const report = buildInventory({ workflowDir: '.github/workflows' });
    expect(report.summary.filesScanned).toBeGreaterThan(100);
    expect(report.summary.riskyWorkflowCount).toBeGreaterThan(0);
    expect(report.summary.byRiskClass['repository-write']).toBeGreaterThan(0);
    expect(report.workflows.some((workflow: any) => workflow.file.endsWith('update-fuel-prices.yml'))).toBe(true);
    expect(report.workflows.some((workflow: any) => workflow.file.endsWith('send-company-alerts.yml'))).toBe(true);
  });

  it('makes strict gaps explicit and renders a read-only report', () => {
    const report = {
      workflows: [{ file: 'x.yml', riskLevel: 'critical', owner: null, safeguards: { killSwitch: { present: false } }, risks: ['commercial'], triggers: [], permissions: [], directMutation: true }],
      summary: { filesScanned: 1, byRiskLevel: { low: 0, medium: 0, high: 0, critical: 1 }, byRiskClass: {}, riskyWorkflowCount: 1, riskyMissingOwnerCount: 1, riskyMissingKillSwitchCount: 1, readOnlyWorkflowCount: 0 },
    };
    expect(strictViolations(report)).toEqual([{ file: 'x.yml', missing: ['owner', 'kill-switch'] }]);
    const markdown = renderMarkdown(report);
    expect(markdown).toContain('Gap da verificare in modalità strict');
    expect(markdown).toContain('Inventario read-only');
  });
});
