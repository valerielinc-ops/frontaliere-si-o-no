// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import RewardedHouseVideo from '@/components/shared/RewardedHouseVideo';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('RewardedHouseVideo', () => {
  it('starts only after an explicit user action', async () => {
    const onStarted = vi.fn();
    const play = vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue(undefined);

    render(
      <RewardedHouseVideo
        onStarted={onStarted}
        onCompleted={vi.fn()}
        onUnavailable={vi.fn()}
      />,
    );

    expect(play).not.toHaveBeenCalled();
    fireEvent.click(screen.getByTestId('rewarded-house-video-start'));

    expect(play).toHaveBeenCalledTimes(1);
    expect(onStarted).toHaveBeenCalledTimes(1);
  });

  it('grants the fallback flow only when the video ends', () => {
    const onCompleted = vi.fn();
    render(
      <RewardedHouseVideo
        onCompleted={onCompleted}
        onUnavailable={vi.fn()}
      />,
    );

    const video = screen.getByTestId('rewarded-house-video').querySelector('video');
    expect(video).not.toBeNull();
    fireEvent.ended(video as HTMLVideoElement);

    expect(onCompleted).toHaveBeenCalledTimes(1);
  });

  it('reports a media error as unavailable', () => {
    const onUnavailable = vi.fn();
    render(
      <RewardedHouseVideo
        onCompleted={vi.fn()}
        onUnavailable={onUnavailable}
      />,
    );

    const video = screen.getByTestId('rewarded-house-video').querySelector('video');
    fireEvent.error(video as HTMLVideoElement);

    expect(onUnavailable).toHaveBeenCalledTimes(1);
  });
});
