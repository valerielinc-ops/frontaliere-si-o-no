import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

describe('job detail header apply links', () => {
  it('makes both the header logo and title link to applyUrl', () => {
    const source = fs.readFileSync(
      path.resolve(process.cwd(), 'components/community/JobBoard.tsx'),
      'utf-8',
    );

    expect(source).toContain("job_board_apply_header_logo");
    expect(source).toContain("job_board_apply_header_title");
    expect(source).toContain('href={applyUrl}');
    expect(source).toContain('aria-label={`${t(\'jobBoard.apply\')} ${selectedJob.company}`}');
  });
});
