// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  APPLICATION_OFFER_BACKDROP_GRACE_MS,
  useApplicationOfferBackdropDismiss,
} from '@/components/community/useApplicationOfferBackdropDismiss';

function Backdrop({ onDismiss }: { onDismiss: () => void }) {
  const handleClick = useApplicationOfferBackdropDismiss(onDismiss);
  return (
    <div data-testid="backdrop" onClick={handleClick}>
      <div data-testid="dialog">dialog</div>
    </div>
  );
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('useApplicationOfferBackdropDismiss', () => {
  it('ignores backdrop clicks inside the double-click window and dismisses after it', () => {
    let clock = 10_000;
    vi.spyOn(performance, 'now').mockImplementation(() => clock);
    const onDismiss = vi.fn();
    const { rerender } = render(<Backdrop onDismiss={onDismiss} />);

    clock += APPLICATION_OFFER_BACKDROP_GRACE_MS - 1;
    fireEvent.click(screen.getByTestId('backdrop'));
    expect(onDismiss).not.toHaveBeenCalled();

    // A re-render must not restart the window.
    rerender(<Backdrop onDismiss={onDismiss} />);
    clock += 1;
    fireEvent.click(screen.getByTestId('backdrop'));
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  it('never dismisses for clicks inside the dialog', () => {
    let clock = 10_000;
    vi.spyOn(performance, 'now').mockImplementation(() => clock);
    const onDismiss = vi.fn();
    render(<Backdrop onDismiss={onDismiss} />);

    clock += APPLICATION_OFFER_BACKDROP_GRACE_MS * 2;
    fireEvent.click(screen.getByTestId('dialog'));

    expect(onDismiss).not.toHaveBeenCalled();
  });
});
