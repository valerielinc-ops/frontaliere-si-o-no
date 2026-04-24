import { describe, it, expect } from 'vitest';
import {
  renderFastestCrossingCard,
  renderTrafficFluidBanner,
} from '@/build-plugins/borderWaitPagesPlugin';

describe('border-wait hero contrast markup', () => {
  it('hero card wait-time span uses strong foreground token, not default', () => {
    const html = renderFastestCrossingCard(
      [{ slug: 'a', labelIt: 'A', waitTimeMinutes: 10 }],
      'it',
    );
    // Wait-time span must declare an explicit foreground colour that
    // clears WCAG AA (4.5:1) against --color-success-subtle.
    expect(html).toMatch(/color:\s*var\(--color-success-strong\)/);
  });

  it('hero card has a 4px left rail for visual anchoring', () => {
    const html = renderFastestCrossingCard(
      [{ slug: 'a', labelIt: 'A', waitTimeMinutes: 10 }],
      'it',
    );
    expect(html).toMatch(/border-left:\s*4px solid var\(--color-success-strong\)/);
  });

  it('fluid banner body text does not rely on muted colour', () => {
    const html = renderTrafficFluidBanner(true, 'it');
    expect(html).not.toMatch(/color:\s*var\(--color-text-muted\)/);
    expect(html).toMatch(/color:\s*var\(--color-text\)/);
  });

  it('fluid banner has a 4px left rail for visual anchoring', () => {
    const html = renderTrafficFluidBanner(true, 'it');
    expect(html).toMatch(/border-left:\s*4px solid var\(--color-success-strong\)/);
  });
});
