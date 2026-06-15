import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const source = fs.readFileSync(
  path.resolve(process.cwd(), 'components/community/JobBoard.tsx'),
  'utf-8',
);

// The rendered (live) job-detail path begins at the unique 12-col grid; the
// dead `if (hybridLayoutEnabled)` block sits before it. Asserting against this
// slice prevents a false-green where a required element exists ONLY in the dead
// hybrid block (the regression that broke sponsored in-house apply: #candidatura
// + PublisherApplyForm were trapped in the disabled hybrid layout).
const livePath = source.slice(source.indexOf('grid grid-cols-1 lg:grid-cols-12'));

describe('job detail header apply links', () => {
  it('keeps both the header logo and title as apply CTAs', () => {
    expect(source).toContain('job_board_apply_header_logo');
    expect(source).toContain('job_board_apply_header_title');
    expect(source).toContain("aria-label={`${t('jobBoard.apply')} ${selectedJob.company}`}");
  });

  it('routes in-house/forward-email apply to the on-page form, external jobs to applyUrl', () => {
    // Header logo + title: scroll to the on-page form for in-house ads,
    // open the external applyUrl otherwise.
    expect(source).toContain("href={isInHouseApply ? '#candidatura' : applyUrl}");
    expect(source).toContain("applyMode === 'in_house'");
    expect(source).toContain("applyMode === 'forward_email'");
  });

  it('mounts the in-house apply form (#candidatura) in the LIVE detail path, not only the dead hybrid block', () => {
    expect(livePath).toContain('id="candidatura"');
    expect(livePath).toContain('<PublisherApplyForm');
    expect(livePath).toContain('{isInHouseApply && (');
  });
});
