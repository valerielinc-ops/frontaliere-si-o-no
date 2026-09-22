// @vitest-environment jsdom

import { fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import RewardedHouseVideo from '@/components/shared/RewardedHouseVideo';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('RewardedHouseVideo', () => {
  it('starts only after user opt-in and completes on video end', async () => {
    const play = vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue(undefined);
    const onStarted = vi.fn();
    const onCompleted = vi.fn();

    render(
      <RewardedHouseVideo
        onStarted={onStarted}
        onCompleted={onCompleted}
        onUnavailable={vi.fn()}
      />,
    );

    const video = screen.getByLabelText('Video di supporto Frontaliere Ticino');
    expect(video).toHaveAttribute('preload', 'auto');
    expect(onStarted).not.toHaveBeenCalled();

    fireEvent.click(screen.getByTestId('rewarded-house-video-start'));
    expect(play).toHaveBeenCalledTimes(1);
    expect(onStarted).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('status')).toHaveTextContent('Guarda il video fino alla fine');

    fireEvent.ended(video);
    expect(onCompleted).toHaveBeenCalledTimes(1);
  });

  it('reports an asset failure as unavailable', () => {
    const onUnavailable = vi.fn();

    render(
      <RewardedHouseVideo
        onCompleted={vi.fn()}
        onUnavailable={onUnavailable}
      />,
    );

    fireEvent.error(screen.getByLabelText('Video di supporto Frontaliere Ticino'));
    expect(onUnavailable).toHaveBeenCalledTimes(1);
  });
});
