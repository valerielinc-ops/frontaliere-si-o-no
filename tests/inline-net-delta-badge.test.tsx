import { act } from 'react';
import { describe, expect, it } from 'vitest';
import { fireEvent, render, waitFor } from '@testing-library/react';
import InlineNetDeltaBadge from '../components/calculator/InlineNetDeltaBadge';

describe('InlineNetDeltaBadge', () => {
  it('renders the delta badge before animation ends', () => {
    const { container } = render(<InlineNetDeltaBadge delta={120} />);
    expect(container.textContent).toContain('+CHF 120');
  });

  it('unmounts itself after the animation ends so it does not leave layout space', async () => {
    const { container } = render(<InlineNetDeltaBadge delta={120} />);
    const badge = container.querySelector('span');
    expect(badge).not.toBeNull();

    await act(async () => {
      fireEvent.animationEnd(badge!);
    });

    await waitFor(() => expect(container.querySelector('span')).toBeNull());
  });

  it('preserves the mobile negative formatting', () => {
    const { container } = render(<InlineNetDeltaBadge delta={-80} size="mobile" />);
    expect(container.textContent).toContain('-CHF 80');
  });
});
