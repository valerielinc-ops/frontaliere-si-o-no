import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, within } from '@testing-library/react';
import JobBridgeView from '../components/community/JobBridgeView';
import JobExpiredView from '../components/community/JobExpiredView';

describe.each(['bridge', 'expired'] as const)('%s related publication', (surface) => {
  beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(new Date('2026-10-04T12:00:00Z')); });
  afterEach(() => { cleanup(); vi.useRealTimers(); });
  it.each([
    { postingDateSource: 'reported' as const, datePosted: '2026-10-02T12:00:00Z', expected: true },
    { postingDateSource: 'unknown' as const, postedDate: '2026-10-02', expected: false },
    { postedDate: '2026-10-02', expected: false },
    { postingDateSource: 'legacy-import', postedDate: '2026-10-02', expected: false },
    { postingDateSource: 'reported' as const, postedDate: '2026-02-30', expected: false },
    { postingDateSource: 'reported' as const, postedDate: '2026-10-05', expected: false },
  ])('respects provenance $postingDateSource $postedDate $datePosted', ({ expected, ...dates }) => {
    const relatedJobs = [{ slug: 'related', title: 'Related vacancy', company: 'Acme', crawledAt: '2026-10-04', ...dates }];
    const result = render(surface === 'bridge'
      ? <JobBridgeView targetSlug="current" hasAccess relatedJobs={relatedJobs} />
      : <JobExpiredView job={{ slug: 'expired', title: 'Expired', company: 'Acme' }} hasAccess relatedJobs={relatedJobs} />);
    const card = result.getByText('Related vacancy').closest('article');
    expect(card).not.toBeNull();
    const date = within(card!).queryByText(/2 giorni fa|2 days ago|Vor 2 Tagen|Il y a 2 jours/);
    expect(Boolean(date)).toBe(expected);
    expect(within(card!).queryByText(/^(Oggi|Today|Heute|Aujourd'hui)$/)).toBeNull();
  });
});
