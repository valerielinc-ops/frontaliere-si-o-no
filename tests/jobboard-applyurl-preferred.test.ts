import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const root = resolve(__dirname, '..');

describe('JobBoard apply URL preference', () => {
  it('prefers applyUrl over the generic job url for the candidati CTA', () => {
    const source = readFileSync(resolve(root, 'components/community/JobBoard.tsx'), 'utf8');
    expect(source).toContain("const applyUrl = buildReferralUrl(selectedJob.applyUrl || selectedJob.url || '', selectedJob);");
  });
});
