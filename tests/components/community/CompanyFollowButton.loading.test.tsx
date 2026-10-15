import React from 'react';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { renderToString } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import CompanyFollowButton from '@/components/community/CompanyFollowButton';
import type { JobAlert } from '@/services/jobAlertService';

const modalLoaded = vi.hoisted(() => vi.fn());
vi.mock('@/components/community/SignupPromptModal', () => {
  modalLoaded();
  return { default: () => <div role="dialog">Registration</div> };
});

afterEach(cleanup);

describe('company follow first render', () => {
  it('renders the anonymous action before effects and loads registration only on click', async () => {
    const lookup = vi.fn();
    const button = <CompanyFollowButton company="Acme" locale="it" lookup={lookup} />;
    const html = renderToString(button);
    expect(html).toContain('Segui questa azienda');
    expect(html).not.toContain('company-follow-placeholder');
    render(button);
    expect(modalLoaded).not.toHaveBeenCalled();
    expect(lookup).not.toHaveBeenCalled();
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /Segui questa azienda/i }));
      await vi.dynamicImportSettled();
    });
    expect(screen.getByRole('dialog')).toBeTruthy();
    expect(modalLoaded).toHaveBeenCalledTimes(1);
  });

  it('waits for an authenticated lookup before offering follow or unfollow', async () => {
    let resolve!: (alert: JobAlert) => void;
    const lookup = vi.fn(() => new Promise<JobAlert>((done) => { resolve = done; }));
    const unfollow = vi.fn().mockResolvedValue(undefined);
    render(<CompanyFollowButton company="Acme" locale="it" userId="user-a" email="test@example.test" lookup={lookup} unfollow={unfollow} />);
    expect(screen.getByTestId('company-follow-placeholder')).toBeTruthy();
    expect(screen.queryByRole('button')).toBeNull();
    await act(async () => { resolve({ id: 'existing-follow' } as JobAlert); });
    const button = screen.getByRole('button', { name: /Stai seguendo questa azienda/i });
    expect(button.getAttribute('aria-pressed')).toBe('true');
    await act(async () => { fireEvent.click(button); });
    expect(unfollow).toHaveBeenCalledWith('test@example.test', 'existing-follow');
  });
});
