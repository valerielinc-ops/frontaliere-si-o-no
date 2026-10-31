import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

const JOB_BOARD = readFileSync(
  resolve(__dirname, '../components/community/JobBoard.tsx'),
  'utf8',
);
const JOB_ALERT_FORM = readFileSync(
  resolve(__dirname, '../components/community/JobAlertForm.tsx'),
  'utf8',
);

describe('job detail and alert touch targets', () => {
  it('gives location filters in the job alert form a 44px minimum height', () => {
    expect(JOB_ALERT_FORM).toContain('locationOptions.map((loc) => (');
    expect(JOB_ALERT_FORM).toContain('px-3 py-1 min-h-[44px] text-xs rounded-full border transition-colors');
    expect(JOB_ALERT_FORM).toContain('onClick={() => toggleLocation(loc.value)}');
  });

  it('enlarges job gate company and location links without changing their handlers', () => {
    expect(JOB_BOARD).toContain('className="inline-flex min-h-[44px] items-center gap-1 px-2 py-1 hover:text-accent hover:underline underline-offset-2 transition-colors"');
    expect(JOB_BOARD).toContain('onClickCapture={openGateCompanyFilter}');
    expect(JOB_BOARD).toContain('Analytics.trackSelectContent(\'job_board_location_filter_open\', jobLocation)');
  });

  it('keeps the unlocked job location link at the same 44px target size', () => {
    expect(JOB_BOARD).toContain('className="inline-flex min-h-[44px] items-center py-1 hover:text-accent hover:underline underline-offset-2 transition-colors"');
    expect(JOB_BOARD).toContain('Analytics.trackSelectContent(\'job_board_location_filter_open\', selectedJob.location)');
  });
});
