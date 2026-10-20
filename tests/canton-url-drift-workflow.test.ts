import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

const WORKFLOW = parse(readFileSync(
  new URL('../.github/workflows/canton-url-drift-monitor.yml', import.meta.url),
  'utf8',
));
const STEPS = WORKFLOW.jobs.measure.steps;

describe('Canton URL Drift Monitor history checkout', () => {
  it('keeps checkout shallow and fetches only the observed branch history lazily', () => {
    const checkout = STEPS.find((step: any) => step.name === 'Checkout');
    const history = STEPS.find((step: any) => step.name === 'Fetch blobless history for the drift window');
    const setupNodeIndex = STEPS.findIndex((step: any) => step.name === 'Setup Node.js');

    expect(checkout?.with?.['fetch-depth']).toBe(1);
    expect(checkout?.with?.filter).toBeUndefined();
    expect(checkout?.['timeout-minutes']).toBe(12);
    expect(history).toBeTruthy();
    expect(STEPS.indexOf(checkout)).toBeLessThan(STEPS.indexOf(history));
    expect(STEPS.indexOf(history)).toBeLessThan(setupNodeIndex);
    expect(history?.['timeout-minutes']).toBe(12);

    const script = String(history?.run || '');
    expect(script).toContain('git config remote.origin.promisor true');
    expect(script).toContain('git config remote.origin.partialclonefilter blob:none');
    expect(script).toContain('git fetch --no-tags --filter=blob:none --unshallow origin');
    expect(script).toContain('"+refs/heads/${BRANCH}:refs/remotes/origin/${BRANCH}"');
    expect(script).not.toMatch(/\+refs\/(?:heads|tags)\/\*/u);
  });
});
