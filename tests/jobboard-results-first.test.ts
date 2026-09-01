import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const source = readFileSync(
  resolve(__dirname, '..', 'components/community/JobBoard.tsx'),
  'utf8',
);

describe('JobBoard category pages — results-first ordering', () => {
  it('mounts secondary discovery utilities once, after the first three available jobs', () => {
    expect(source).toContain('const postFirstResultsUtilities =');
    expect(source).toContain('const utilitiesAfterPosition = Math.min(3, displayJobs.length);');
    expect(source).toContain('!resultsResolving && pos === utilitiesAfterPosition && postFirstResultsUtilities');
    expect(source).toContain('displayJobs.length === 0 && !resultsResolving && postFirstResultsUtilities');

    expect(source.match(/<PopularSearchChips\b/g)).toHaveLength(1);
    expect(source.match(/<JobAlertForm\b/g)).toHaveLength(1);
  });

  it('keeps only the time-and-location quick row before the filter toggle', () => {
    const returnStart = source.indexOf('<JobBoardRailShell');
    const firstRow = source.indexOf('Time & Location', returnStart);
    const filterToggle = source.indexOf('Filter toggle bar', returnStart);
    const secondRowMount = source.indexOf('postFirstResultsUtilities', filterToggle);

    expect(firstRow).toBeGreaterThan(returnStart);
    expect(filterToggle).toBeGreaterThan(firstRow);
    expect(secondRowMount).toBeGreaterThan(filterToggle);
  });
});
