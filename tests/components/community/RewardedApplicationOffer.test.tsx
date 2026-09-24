// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

const rewardedMock = vi.hoisted(() => ({
  props: null as Record<string, unknown> | null,
}));

vi.mock('@/components/shared/GptRewardedAd', () => ({
  default: (props: Record<string, unknown>) => {
    rewardedMock.props = props;
    return (
      <div>
        <button
          type="button"
          data-testid="mock-google-no-fill"
          onClick={() => (props.onUnavailable as ((reason?: string) => void) | undefined)?.('no_fill')}
        >
          No fill
        </button>
        <button
          type="button"
          data-testid="mock-google-consent-required"
          onClick={() => (props.onUnavailable as ((reason?: string) => void) | undefined)?.('consent_required')}
        >
          Consent required
        </button>
        <button
          type="button"
          data-testid="mock-google-completed"
          onClick={() => {
            (props.onGranted as (() => void))();
            (props.onVideoCompleted as (() => void) | undefined)?.();
          }}
        >
          Google video completed
        </button>
      </div>
    );
  },
}));
vi.mock('@/services/rewardedApplicationAccess', () => ({
  grantRewardedApplicationAccess: () => Date.now() + 43_200_000,
}));
vi.mock('@/services/assistedApplicationExperiment', () => ({
  trackAssistedApplicationEvent: vi.fn(),
}));

import RewardedApplicationOffer from '@/components/community/RewardedApplicationOffer';

afterEach(() => {
  cleanup();
  document.body.style.overflow = '';
});

const defaultProps = {
  jobId: 'job-1',
  companyId: 'company-1',
  companyName: 'EOC',
  jobTitle: 'Fisioterapista diplomato',
  onContinue: vi.fn(),
  onUnavailable: vi.fn(),
};

describe('RewardedApplicationOffer', () => {
  it('portals the dialog above the application shell and locks page scrolling', () => {
    render(<RewardedApplicationOffer {...defaultProps} />);

    const dialog = screen.getByRole('dialog');
    expect(dialog.parentElement?.parentElement).toBe(document.body);
    expect(dialog.parentElement).toHaveClass('z-[1000]');
    expect(document.body.style.overflow).toBe('hidden');
  });

  it('can be dismissed with the close control or Escape', () => {
    const onDismiss = vi.fn();
    render(<RewardedApplicationOffer {...defaultProps} onDismiss={onDismiss} />);

    fireEvent.click(screen.getByTestId('rewarded-application-offer-close'));
    fireEvent.keyDown(document, { key: 'Escape' });

    expect(onDismiss).toHaveBeenCalledTimes(2);
  });

  it('starts the Google ad from the candidate click without a second ad CTA', () => {
    render(<RewardedApplicationOffer {...defaultProps} />);

    expect(rewardedMock.props?.autoStart).toBe(true);
  });

  it('redirects the visitor without retrying when Google has no paid fill', () => {
    const onUnavailable = vi.fn();
    render(<RewardedApplicationOffer {...defaultProps} onUnavailable={onUnavailable} />);

    fireEvent.click(screen.getByTestId('mock-google-no-fill'));

    expect(onUnavailable).toHaveBeenCalledWith('no_fill');
    expect(screen.queryByRole('button', { name: 'Riprova con il video' })).not.toBeInTheDocument();
  });

  it('reports consent ineligibility without retrying the empty request', () => {
    const onUnavailable = vi.fn();
    render(<RewardedApplicationOffer {...defaultProps} onUnavailable={onUnavailable} />);

    fireEvent.click(screen.getByTestId('mock-google-consent-required'));

    expect(onUnavailable).toHaveBeenCalledWith('consent_required');
    expect(screen.queryByRole('button', { name: 'Riprova con il video' })).not.toBeInTheDocument();
  });

  it('unlocks only after the authoritative Google reward signal and waits for an explicit continue', () => {
    const onContinue = vi.fn();
    render(<RewardedApplicationOffer {...defaultProps} onContinue={onContinue} />);

    act(() => {
      (rewardedMock.props?.onGranted as (() => void) | undefined)?.();
    });
    expect(screen.getByRole('button', { name: 'Apri la candidatura sul sito dell’azienda' })).toBeInTheDocument();
    expect(onContinue).not.toHaveBeenCalled();

    act(() => {
      (rewardedMock.props?.onVideoCompleted as (() => void) | undefined)?.();
    });

    expect(onContinue).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Apri la candidatura sul sito dell’azienda' }));
    expect(onContinue).toHaveBeenCalledTimes(1);
  });
});
