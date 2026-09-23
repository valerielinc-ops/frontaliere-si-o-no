// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

const rewardedMock = vi.hoisted(() => ({
  props: null as Record<string, unknown> | null,
}));

vi.mock('@/components/shared/GptRewardedAd', () => ({
  default: (props: Record<string, unknown>) => {
    rewardedMock.props = props;
    return <button type="button">Guarda il video</button>;
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

  it('redirects immediately when Google has no rewarded video available', () => {
    render(<RewardedApplicationOffer {...defaultProps} />);

    act(() => {
      (rewardedMock.props?.onUnavailable as (() => void) | undefined)?.();
    });

    expect(defaultProps.onUnavailable).toHaveBeenCalledTimes(1);
  });

  it('completes only after both the reward and the video completion are received', () => {
    render(<RewardedApplicationOffer {...defaultProps} />);

    act(() => {
      (rewardedMock.props?.onGranted as (() => void) | undefined)?.();
    });
    expect(defaultProps.onCompleted).not.toHaveBeenCalled();

    act(() => {
      (rewardedMock.props?.onVideoCompleted as (() => void) | undefined)?.();
    });
    expect(defaultProps.onCompleted).toHaveBeenCalledTimes(1);
  });
});
