import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import ResumeJobSearch from '@/components/community/ResumeJobSearch';
import { buildJobBoardSearchResume } from '@/services/jobBoardSearchResume';

vi.mock('@/services/i18n', () => ({
  useTranslation: () => ({
    t: (key: string, values?: Record<string, unknown>) => {
      const templates: Record<string, string> = {
        'jobBoard.resumeSearch.title': 'Your latest search',
        'jobBoard.resumeSearch.keywordSummary': '“{query}” · {canton}',
        'jobBoard.resumeSearch.filterSummary': 'Filtered search · {canton}',
        'jobBoard.resumeSearch.resume': 'Resume',
        'jobBoard.resumeSearch.clear': 'Clear saved search',
      };
      return (templates[key] || key).replace(/\{([^}]+)\}/g, (_match, name: string) => String(values?.[name] ?? ''));
    },
  }),
}));

const search = buildJobBoardSearchResume({
  keyword: 'nurse',
  canton: 'ZH',
  category: 'all',
  contract: 'all',
  company: 'all',
  dateRange: 'all',
  location: 'all',
  sector: 'all',
}, Date.parse('2026-10-20T10:00:00.000Z'))!;

describe('ResumeJobSearch', () => {
  afterEach(() => cleanup());

  it('waits for the visitor to choose before restoring and can clear the saved search', () => {
    const onResume = vi.fn();
    const onClear = vi.fn();
    render(<ResumeJobSearch search={search} cantonLabel="Zurich" onResume={onResume} onClear={onClear} />);

    expect(screen.getByText('“nurse” · Zurich')).toBeTruthy();
    expect(onResume).not.toHaveBeenCalled();
    expect(onClear).not.toHaveBeenCalled();

    fireEvent.click(screen.getByTestId('resume-job-search-action'));
    expect(onResume).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole('button', { name: 'Clear saved search' }));
    expect(onClear).toHaveBeenCalledTimes(1);
  });
});
