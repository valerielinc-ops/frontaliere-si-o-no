// @vitest-environment jsdom
/**
 * The static card → island contract: what `renderJobCardHtml` emits is what
 * `JobSaveMount` reads, end to end, on a page JobBoard is not mounted on.
 */
import React from 'react';
import { act, cleanup, render, screen, fireEvent } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

const { requestJobSave } = vi.hoisted(() => ({ requestJobSave: vi.fn() }));

vi.mock('@/services/jobSaveGate', () => ({
  requestJobSave,
  dismissSavePrompt: vi.fn(),
  isSavePromptOpen: () => false,
  subscribeSavePrompt: () => () => undefined,
}));
vi.mock('@/services/savedJobsService', () => ({
  isJobSaved: () => false,
  SAVED_JOBS_CHANGED_EVENT: 'saved-jobs-changed',
}));
vi.mock('@/services/i18n', () => ({
  getLocale: () => 'de',
  useTranslation: () => ({ t: (key: string) => key }),
}));

import JobSaveMount, { readJobSaveProps } from '@/components/community/JobSaveMount';
import { renderJobCardHtml } from '../build-plugins/shared/jobCardHtml';

function staticCard(extra: Record<string, unknown> = {}): HTMLElement {
  const host = document.createElement('main');
  host.innerHTML = renderJobCardHtml(
    { id: 'pfister-1', slug: 'verkaeufer', category: 'retail', title: 'Verkäufer', company: 'Möbel Pfister AG', canton: 'ZH', ...extra },
    { href: '/de/stellen/verkaeufer/', locale: 'de' },
  );
  document.body.appendChild(host);
  return host;
}

describe('JobSaveMount', () => {
  afterEach(() => {
    cleanup();
    document.body.innerHTML = '';
    vi.clearAllMocks();
  });

  it('reads the job off the card, title without its badges', () => {
    const host = staticCard({ postedDate: new Date().toISOString(), postingDateSource: 'reported', featured: true });
    expect(host.querySelector('.jc-newbadge')).not.toBeNull();
    expect(readJobSaveProps(host.querySelector<HTMLElement>('[data-job-save]')!)).toEqual({
      id: 'pfister-1',
      slug: 'verkaeufer',
      title: 'Verkäufer',
      company: 'Möbel Pfister AG',
      canton: 'ZH',
      category: 'retail',
    });
  });

  it('puts a working bookmark on a static card, outside the link', async () => {
    const host = staticCard();
    await act(async () => {
      render(<JobSaveMount />);
    });
    const button = screen.getByRole('button', { name: 'jobBoard.save.add' });
    expect(host.contains(button)).toBe(true);
    expect(button.closest('a')).toBeNull();
    fireEvent.click(button);
    expect(requestJobSave).toHaveBeenCalledWith(expect.objectContaining({ id: 'pfister-1' }), 'card_static');
  });

  it('hydrates cards that arrive after boot (SPA swap of the static body)', async () => {
    await act(async () => {
      render(<JobSaveMount />);
    });
    await act(async () => {
      staticCard();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(screen.getByRole('button', { name: 'jobBoard.save.add' })).toBeTruthy();
  });

  it('skips a page still in circulation without the placeholder data', async () => {
    const host = staticCard({ id: undefined });
    await act(async () => {
      render(<JobSaveMount />);
    });
    expect(host.querySelector('[data-job-save]')).toBeNull();
    expect(screen.queryByRole('button')).toBeNull();
  });
});
