import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

const jobBoardSource = readFileSync(
  resolve(__dirname, '..', 'components', 'community', 'JobBoard.tsx'),
  'utf8',
);
const jobDetailPresentationSource = readFileSync(
  resolve(__dirname, '..', 'components', 'community', 'JobDetailPresentation.tsx'),
  'utf8',
);
const jobExpiredViewSource = readFileSync(
  resolve(__dirname, '..', 'components', 'community', 'JobExpiredView.tsx'),
  'utf8',
);
const jobOrphanViewSource = readFileSync(
  resolve(__dirname, '..', 'components', 'community', 'JobOrphanView.tsx'),
  'utf8',
);

describe('job detail header Auto Ads containment', () => {
  it('keeps injected Auto Ads out of all shared job-detail headers', () => {
    expect(jobBoardSource).toMatch(/<JobDetailHeaderCard data-no-auto-ads="inside">/);
    expect(jobExpiredViewSource).toMatch(/<JobDetailHeaderCard data-no-auto-ads="inside">/);
    expect(jobOrphanViewSource).toMatch(/<JobDetailHeaderCard data-no-auto-ads="inside"/);
    expect(jobDetailPresentationSource).toContain(
      "rounded-3xl border border-edge bg-gradient-to-br from-info-subtle via-surface to-success-subtle p-4 sm:p-6",
    );
    expect(jobDetailPresentationSource).toContain('data-job-detail-header');
  });

  it('does not opt the whole job-detail page out of Auto Ads', () => {
    expect(jobBoardSource).not.toMatch(/<main[^>]*data-no-auto-ads/);
  });
});
