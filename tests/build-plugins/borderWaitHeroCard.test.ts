import { describe, it, expect } from 'vitest';
import {
  renderFastestCrossingCard,
  renderTrafficFluidBanner,
} from '@/build-plugins/borderWaitPagesPlugin';

describe('renderFastestCrossingCard', () => {
  it('returns empty string when every crossing has 0 min wait', () => {
    const crossings = [
      { slug: 'chiasso-centro', labelIt: 'Chiasso Centro', waitTimeMinutes: 0 },
      { slug: 'gaggiolo', labelIt: 'Gaggiolo', waitTimeMinutes: 0 },
    ];
    const html = renderFastestCrossingCard(crossings, 'it');
    expect(html).toBe('');
  });

  it('renders the hero when at least one crossing has > 0 min wait', () => {
    const crossings = [
      { slug: 'chiasso-centro', labelIt: 'Chiasso Centro', waitTimeMinutes: 0 },
      { slug: 'gaggiolo', labelIt: 'Gaggiolo', waitTimeMinutes: 12 },
    ];
    const html = renderFastestCrossingCard(crossings, 'it');
    expect(html).toContain('Gaggiolo');
    expect(html).toContain('12 min');
  });
});

describe('renderTrafficFluidBanner', () => {
  it('returns a reassuring banner when all zeros', () => {
    const html = renderTrafficFluidBanner(true, 'it');
    expect(html).toContain('Traffico fluido');
  });

  it('returns empty when data not all zeros', () => {
    expect(renderTrafficFluidBanner(false, 'it')).toBe('');
  });
});
