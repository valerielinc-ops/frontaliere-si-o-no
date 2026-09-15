import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

const jobBoardSource = readFileSync(
  resolve(process.cwd(), 'components/community/JobBoard.tsx'),
  'utf8',
);

describe('assisted application JobBoard handoff', () => {
  it('routes treatment clicks from list/card surfaces through the detail render', () => {
    const start = jobBoardSource.indexOf('const handleApply =');
    const end = jobBoardSource.indexOf('const handleShare =', start);
    const handleApply = jobBoardSource.slice(start, end);

    expect(handleApply).toMatch(
      /if \(!isJobDetailView && !authResolved\) return;[\s\S]*setAssistedApplicationJob\(job\);[\s\S]*if \(!isJobDetailView\) openDetail\(job\);/,
    );
  });

  it('keeps the offer mounted in both supported detail render branches', () => {
    expect(jobBoardSource.match(/\{assistedApplicationOfferJsx\}/g)?.length).toBeGreaterThanOrEqual(2);
  });
});
