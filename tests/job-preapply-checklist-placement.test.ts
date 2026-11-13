import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const jobBoardSource = readFileSync(new URL('../components/community/JobBoard.tsx', import.meta.url), 'utf8');

describe('job ATS form section placement', () => {
  it('places the observed ATS form directly below the job application actions', () => {
    const applicationActionsEnd = jobBoardSource.lastIndexOf(
      '<JobDetailLinkedInPeopleButton companyName={selectedJob.company} />',
    );
    const applyButton = jobBoardSource.lastIndexOf('onClick={() => handleApply(selectedJob)}', applicationActionsEnd);
    const atsSection = jobBoardSource.indexOf('<JobPreApplyChecklist');

    expect(applicationActionsEnd).toBeGreaterThan(-1);
    expect(applyButton).toBeGreaterThan(-1);
    expect(applyButton).toBeLessThan(applicationActionsEnd);
    expect(atsSection).toBeGreaterThan(applicationActionsEnd);
  });
});
