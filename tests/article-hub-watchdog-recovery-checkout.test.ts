import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const WORKFLOW = fs.readFileSync(
  path.join(ROOT, '.github', 'workflows', 'article-hub-landing-watchdog.yml'),
  'utf8',
);

describe('article-hub watchdog recovery reporter', () => {
  it('checks out the standalone reporter before the recovery failure path uses it', () => {
    const recovery = WORKFLOW.slice(WORKFLOW.indexOf('\n  recovery:'));
    const checkout = recovery.indexOf('- name: Checkout failure reporter');
    const reporter = recovery.indexOf('node scripts/lib/github-issue-creator.mjs');

    expect(checkout).toBeGreaterThanOrEqual(0);
    expect(reporter).toBeGreaterThan(checkout);

    const checkoutBlock = recovery.slice(checkout, reporter);
    expect(checkoutBlock).toContain('uses: actions/checkout@v7');
    expect(checkoutBlock).toContain('/scripts/lib/github-issue-creator.mjs');
    expect(checkoutBlock).toContain('sparse-checkout-cone-mode: false');
  });
});
