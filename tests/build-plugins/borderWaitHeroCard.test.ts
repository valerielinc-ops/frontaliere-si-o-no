import { describe, it, expect } from 'vitest';
import {
  hubHeroState,
  isMeasuredWait,
  renderFastestCrossingCard,
  renderTrafficFluidBanner,
  renderTrafficFluidMeasuredBanner,
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
    expect(html).toContain('Chiasso Centro');
    expect(html).toContain('0 min');
  });

  it('ignores negative readings when selecting the fastest crossing', () => {
    const html = renderFastestCrossingCard([
      { slug: 'zero-crossing', labelIt: 'Zero crossing', waitTimeMinutes: 0 },
      { slug: 'invalid-crossing', labelIt: 'Invalid crossing', waitTimeMinutes: -1 },
      { slug: 'slow-crossing', labelIt: 'Slow crossing', waitTimeMinutes: 5 },
    ], 'it');

    expect(html).toContain('Zero crossing');
    expect(html).toContain('0 min');
    expect(html).not.toContain('Invalid crossing');
    expect(html).not.toContain('-1 min');
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

describe('hubHeroState', () => {
  it('treats a negative wait as an unmeasured crossing, like the live hydration', () => {
    // Regression: a snapshot with only `totalCrossingMinutes: -1` counted as a
    // measured crossing and claimed «nessuna coda sui valichi misurati».
    expect(hubHeroState([-1])).toBe('unavailable');
    expect(hubHeroState([-1, null])).toBe('unavailable');
    expect(hubHeroState([-1, 0])).toBe('fluid-measured');
  });

  it('treats non-finite waits as unmeasured too', () => {
    expect(hubHeroState([Number.NaN])).toBe('unavailable');
    expect(hubHeroState([Number.POSITIVE_INFINITY])).toBe('unavailable');
    expect(hubHeroState([Number.NaN, 3])).toBe('fastest');
    expect(isMeasuredWait(Number.NaN)).toBe(false);
    expect(isMeasuredWait(Number.POSITIVE_INFINITY)).toBe(false);
    expect(isMeasuredWait(0)).toBe(true);
  });

  it('picks the four states from coverage and queues', () => {
    expect(hubHeroState([])).toBe('unavailable');
    expect(hubHeroState([null, undefined])).toBe('unavailable');
    expect(hubHeroState([0, 0])).toBe('fluid');
    expect(hubHeroState([0, null])).toBe('fluid-measured');
    expect(hubHeroState([0, 3, null])).toBe('fastest');
  });
});

describe('renderTrafficFluidMeasuredBanner', () => {
  it('scopes «fluido» to the measured crossings and fills the count slots', () => {
    const html = renderTrafficFluidMeasuredBanner(141, 143, 'it');
    expect(html).toContain('Traffico fluido sui valichi misurati');
    expect(html).toContain('<span data-bw-slot="measured">141</span>');
    expect(html).toContain('<span data-bw-slot="total">143</span>');
    expect(html).not.toContain('Traffico fluido su tutti i valichi');
  });
});
