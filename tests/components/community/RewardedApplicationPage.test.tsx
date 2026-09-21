// @vitest-environment jsdom

import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createRewardedApplicationHandoff,
} from '@/services/rewardedApplicationHandoff';

vi.mock('@/components/shared/GptRewardedAd', () => ({
  default: (props: {
    onClosed?: (rewarded: boolean) => void;
    onUnavailable?: () => void;
  }) => (
    <div>
      <button type="button" onClick={() => props.onClosed?.(false)}>Chiudi video</button>
      <button type="button" onClick={() => props.onUnavailable?.()}>Nessun video</button>
    </div>
  ),
}));

vi.mock('@/services/assistedApplicationExperiment', () => ({
  trackAssistedApplicationEvent: vi.fn(),
}));

vi.mock('@/services/rewardedApplicationAccess', () => ({
  grantRewardedApplicationAccess: vi.fn(() => Date.now() + 12 * 60 * 60 * 1000),
}));

import RewardedApplicationPage from '@/components/community/RewardedApplicationPage';

describe('RewardedApplicationPage', () => {
  beforeEach(() => {
    window.localStorage.clear();
    window.history.replaceState({}, '', '/rewarded-application/');
  });

  function renderPage() {
    const token = createRewardedApplicationHandoff({
      destination: 'https://employer.example/jobs/42',
      jobId: 'job-42',
      companyId: 'acme',
      companyName: 'Acme',
      jobTitle: 'Responsabile operativo',
    });
    window.history.replaceState({}, '', `/rewarded-application/?handoff=${token}`);
    render(<RewardedApplicationPage />);
  }

  it('does not offer a direct bypass when the visitor closes the video', () => {
    renderPage();

    fireEvent.click(screen.getByRole('button', { name: 'Chiudi video' }));

    expect(screen.queryByRole('link', { name: /Candidati direttamente/i })).toBeNull();
    expect(screen.getByRole('button', { name: 'Riprova il video' })).toBeTruthy();
  });

  it('shows the direct fallback only when no rewarded ad is available', () => {
    renderPage();

    fireEvent.click(screen.getByRole('button', { name: 'Nessun video' }));

    expect(screen.getByRole('link', { name: /Candidati direttamente/i })).toBeTruthy();
  });
});
