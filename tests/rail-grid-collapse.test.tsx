import { fireEvent, render, screen, cleanup } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { useRailGridCollapse } from '@/components/shared/useRailGridCollapse';

afterEach(cleanup);

function Probe({ collapseOnEmpty }: { collapseOnEmpty?: boolean }) {
  const { onLeftEmptyResolved, style } = useRailGridCollapse({ collapseOnEmpty });
  const leftWidth = (style as Record<string, string>)['--ft-rail-w-l'];

  return (
    <button type="button" data-testid="rail" data-width={leftWidth} onClick={() => onLeftEmptyResolved(true)}>
      rail
    </button>
  );
}

describe('useRailGridCollapse', () => {
  it('keeps listing gutters reserved when an empty verdict arrives after paint', () => {
    render(<Probe collapseOnEmpty={false} />);
    const rail = screen.getByTestId('rail');

    expect(rail).toHaveAttribute('data-width', '300px');
    fireEvent.click(rail);
    expect(rail).toHaveAttribute('data-width', '300px');
  });

  it('still collapses detail gutters when the default policy is enabled', () => {
    render(<Probe />);
    const rail = screen.getByTestId('rail');

    fireEvent.click(rail);
    expect(rail).toHaveAttribute('data-width', '0px');
  });
});
