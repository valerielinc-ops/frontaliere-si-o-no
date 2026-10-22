import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { useState } from 'react';
import NewJobsCounter from '@/components/community/NewJobsCounter';
import { filterJobsNewSinceVisit } from '@/services/jobBoardNewJobs';

vi.mock('@/services/i18n', () => ({
  useTranslation: () => ({
    t: (key: string, options?: { count?: number }) => key === 'jobBoard.returnVisit.message'
      ? `${options?.count ?? 0} new jobs since your last visit`
      : key,
  }),
}));

const LAST_VISIT = Date.parse('2026-10-19T10:00:00.000Z');
const NOW = Date.parse('2026-10-20T10:00:00.000Z');
const jobs = [
  { id: 'new-nurse-lugano-part-time', profession: 'infermiere', canton: 'TI', locality: 'Lugano', contract: 'part-time', firstSeenAt: '2026-10-20T09:00:00.000Z' },
  { id: 'old-nurse-lugano-part-time', profession: 'infermiere', canton: 'TI', locality: 'Lugano', contract: 'part-time', firstSeenAt: '2026-10-18T09:00:00.000Z' },
  { id: 'new-nurse-bellinzona-part-time', profession: 'infermiere', canton: 'TI', locality: 'Bellinzona', contract: 'part-time', firstSeenAt: '2026-10-20T09:00:00.000Z' },
  { id: 'new-nurse-lugano-full-time', profession: 'infermiere', canton: 'TI', locality: 'Lugano', contract: 'full-time', firstSeenAt: '2026-10-20T09:00:00.000Z' },
];

function ReturnVisitFilterHarness() {
  const [showNewOnly, setShowNewOnly] = useState(false);
  const currentContext = jobs.filter((job) =>
    job.profession === 'infermiere'
      && job.canton === 'TI'
      && job.locality === 'Lugano'
      && job.contract === 'part-time',
  );
  const newInContext = filterJobsNewSinceVisit(currentContext, LAST_VISIT, NOW);
  const visible = showNewOnly ? newInContext : currentContext;

  return (
    <section>
      <p data-testid="current-context">infermiere / TI / Lugano / part-time</p>
      <ul data-testid="results">
        {visible.map((job) => <li key={job.id}>{job.id}</li>)}
      </ul>
      <NewJobsCounter
        newJobsCount={newInContext.length}
        isActive={showNewOnly}
        onToggle={() => setShowNewOnly((active) => !active)}
        onDismiss={() => undefined}
      />
    </section>
  );
}

describe('NewJobsCounter', () => {
  afterEach(() => cleanup());

  it('shows and clears only new jobs while keeping profession, canton, locality and contract context', () => {
    render(<ReturnVisitFilterHarness />);
    const context = screen.getByTestId('current-context').textContent;
    expect(screen.getAllByRole('listitem').map((node) => node.textContent)).toEqual([
      'new-nurse-lugano-part-time',
      'old-nurse-lugano-part-time',
    ]);
    expect(screen.getByText('1 new jobs since your last visit')).toBeTruthy();

    fireEvent.click(screen.getByTestId('return-visit-toggle'));
    expect(screen.getByTestId('return-visit-toggle').getAttribute('aria-pressed')).toBe('true');
    expect(screen.getAllByRole('listitem').map((node) => node.textContent)).toEqual(['new-nurse-lugano-part-time']);
    expect(screen.getByTestId('current-context').textContent).toBe(context);

    fireEvent.click(screen.getByTestId('return-visit-toggle'));
    expect(screen.getByTestId('return-visit-toggle').getAttribute('aria-pressed')).toBe('false');
    expect(screen.getAllByRole('listitem').map((node) => node.textContent)).toEqual([
      'new-nurse-lugano-part-time',
      'old-nurse-lugano-part-time',
    ]);
    expect(screen.getByTestId('current-context').textContent).toBe(context);
  });
});
