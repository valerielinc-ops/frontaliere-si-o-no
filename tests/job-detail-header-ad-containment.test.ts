import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

const jobBoardSource = readFileSync(
  resolve(__dirname, '..', 'components', 'community', 'JobBoard.tsx'),
  'utf8',
);

describe('job detail header Auto Ads containment', () => {
  it('keeps injected Auto Ads out of both mobile job-header layouts', () => {
    expect(jobBoardSource).toMatch(
      /<div className="rounded-stripe border border-edge bg-surface p-4 sm:p-5" data-no-auto-ads="inside">/,
    );
    expect(jobBoardSource).toMatch(
      /<header className="rounded-3xl border border-edge bg-gradient-to-br from-info-subtle via-surface to-success-subtle p-4 sm:p-6" data-no-auto-ads="inside">/,
    );
  });

  it('does not opt the whole job-detail page out of Auto Ads', () => {
    expect(jobBoardSource).not.toMatch(/<main[^>]*data-no-auto-ads/);
  });
});
