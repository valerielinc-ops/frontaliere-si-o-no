import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { useState } from 'react';
import NewJobsCounter from '@/components/community/NewJobsCounter';
import {
  createJobBoardNewJobsImpressionGate,
  filterJobsNewSinceVisit,
  JOB_BOARD_NEW_JOBS_IMPRESSION_VISIT_KEY,
} from '@/services/jobBoardNewJobs';

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

class FakeIO {
 static instances: FakeIO[] = [];
 callback: IntersectionObserverCallback;
 observed: Element[] = [];
 constructor(callback: IntersectionObserverCallback) {
  this.callback = callback;
  FakeIO.instances.push(this);
 }
 observe(element: Element) { this.observed.push(element); }
 disconnect() { /* no-op */ }
 enter() {
  this.callback(
   this.observed.map((target) => ({ isIntersecting: true, target })) as unknown as IntersectionObserverEntry[],
   this as unknown as IntersectionObserver,
  );
 }
}

function impressionStorage() {
 let visitKey: string | null = null;
 return {
  getItem: (key: string) => key === JOB_BOARD_NEW_JOBS_IMPRESSION_VISIT_KEY ? visitKey : null,
  setItem: (key: string, value: string) => { if (key === JOB_BOARD_NEW_JOBS_IMPRESSION_VISIT_KEY) visitKey = value; },
 };
}

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
  beforeEach(() => {
    FakeIO.instances = [];
    vi.stubGlobal('IntersectionObserver', FakeIO as unknown as typeof IntersectionObserver);
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

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

  it('records visibility only after intersection, while a click proves visibility', () => {
    const track = vi.fn();
    const gate = createJobBoardNewJobsImpressionGate();
    const storage = impressionStorage();
    const onImpression = () => {
      if (gate('visit-1', storage)) track();
    };

    render(
      <NewJobsCounter
        newJobsCount={2}
        isActive={false}
        onToggle={vi.fn()}
        onDismiss={vi.fn()}
        onImpression={onImpression}
      />,
    );
    expect(track).not.toHaveBeenCalled();

    FakeIO.instances[0].enter();
    expect(track).toHaveBeenCalledTimes(1);
    FakeIO.instances[0].enter();
    expect(track).toHaveBeenCalledTimes(1);

    cleanup();
    render(
      <NewJobsCounter
        newJobsCount={2}
        isActive={false}
        onToggle={vi.fn()}
        onDismiss={vi.fn()}
        onImpression={onImpression}
      />,
    );
    fireEvent.click(screen.getByTestId('return-visit-toggle'));
    FakeIO.instances[1].enter();
    expect(track).toHaveBeenCalledTimes(1);
  });

  it('counts a direct action as the first impression when visibility did not fire', () => {
    const track = vi.fn();
    const gate = createJobBoardNewJobsImpressionGate();
    const storage = impressionStorage();
    const onImpression = () => {
      if (gate('visit-click', storage)) track();
    };

    render(
      <NewJobsCounter
        newJobsCount={2}
        isActive={false}
        onToggle={vi.fn()}
        onDismiss={vi.fn()}
        onImpression={onImpression}
      />,
    );
    expect(track).not.toHaveBeenCalled();

    fireEvent.click(screen.getByTestId('return-visit-toggle'));
    expect(track).toHaveBeenCalledTimes(1);
    FakeIO.instances[0].enter();
    expect(track).toHaveBeenCalledTimes(1);
  });
});
