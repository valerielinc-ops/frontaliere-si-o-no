import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  L5_DECISION_SESSION_DIMENSION,
  L5_DECISION_SESSION_DIMENSION_API_NAME,
  L5_DECISION_SESSION_PARAMETER,
} from '../scripts/lib/ga4-l5-decision-dimension.mjs';

const read = (file: string) => fs.readFileSync(path.resolve(file), 'utf8');

describe('L5 GA4 decision-session dimension contract', () => {
  it('uses one definition for the exporter, weekly registrar and provisioning command', () => {
    const exporter = read('scripts/ci/export-loop-outcomes.mjs');
    const analyticsReport = read('scripts/analytics-report.mjs');
    const provisioner = read('scripts/ci/provision-l5-ga4-dimension.mjs');

    expect(L5_DECISION_SESSION_PARAMETER).toBe('decision_session_id');
    expect(L5_DECISION_SESSION_DIMENSION_API_NAME).toBe('customEvent:decision_session_id');
    expect(L5_DECISION_SESSION_DIMENSION).toMatchObject({
      parameterName: L5_DECISION_SESSION_PARAMETER,
      displayName: 'Decision Session ID',
    });
    expect(exporter).toContain('L5_DECISION_SESSION_DIMENSION_API_NAME');
    expect(analyticsReport).toContain('L5_DECISION_SESSION_DIMENSION');
    expect(provisioner).toContain('L5_DECISION_SESSION_DIMENSION');
    expect(provisioner).toContain('ensureGa4CustomDimensions');
  });

  it('provisions before live export and preserves a fail-closed reason on failure', () => {
    const workflow = read('.github/workflows/loop-l5-decision-moments.yml');
    const provisionIndex = workflow.indexOf('scripts/ci/provision-l5-ga4-dimension.mjs');
    const exportIndex = workflow.indexOf('- name: Export fresh L5 outcomes');

    expect(provisionIndex).toBeGreaterThanOrEqual(0);
    expect(exportIndex).toBeGreaterThan(provisionIndex);
    expect(workflow).toContain('LOOP_FLEET_L5_EXPORT_UNAVAILABLE=1');
    expect(workflow).toContain('LOOP_FLEET_L5_EXPORT_UNAVAILABLE_REASON=');
    expect(workflow).toContain('GA4 decision-session custom dimension provisioning failed');
  });
});
