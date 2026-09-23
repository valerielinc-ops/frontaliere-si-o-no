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
          onClick={() => (props.onUnavailable as (() => void) | undefined)?.()}
        >
          No fill
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
  onCompleted: vi.fn(),
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

  it('uses the original candidature intent to start a ready Google rewarded ad', () => {
    render(<RewardedApplicationOffer {...defaultProps} />);

    expect(rewardedMock.props?.autoStart).toBe(true);
  });

  it('redirects immediately when Google has no paid fill and renders no house video', () => {
    const onUnavailable = vi.fn();
    render(<RewardedApplicationOffer {...defaultProps} onUnavailable={onUnavailable} />);

    fireEvent.click(screen.getByTestId('mock-google-no-fill'));

    expect(onUnavailable).toHaveBeenCalledTimes(1);
    expect(screen.queryByTestId('rewarded-house-video-start')).not.toBeInTheDocument();
  });

  it('completes the application flow only after Google grants and completes the video', () => {
    const onCompleted = vi.fn();
    render(<RewardedApplicationOffer {...defaultProps} onCompleted={onCompleted} />);

    act(() => {
      (rewardedMock.props?.onGranted as (() => void) | undefined)?.();
    });
    expect(onCompleted).not.toHaveBeenCalled();

    act(() => {
      (rewardedMock.props?.onVideoCompleted as (() => void) | undefined)?.();
    });

    expect(onCompleted).toHaveBeenCalledTimes(1);
  });
});
