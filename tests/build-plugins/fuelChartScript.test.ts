// @vitest-environment jsdom

import { beforeEach, describe, expect, it } from 'vitest';
import { FUEL_CHART_SCRIPT_CONTENT } from '../../build-plugins/constants';

const ranges = ['1M', '3M', '6M', '1Y', '5Y'];

function mountFuelChart(): void {
  document.body.innerHTML = `<div data-fuel-history-chart>
    <div role="tablist">
      ${ranges
        .map(
          (range) =>
            `<button type="button" role="tab" data-range-btn="${range}" aria-selected="${range === '6M' ? 'true' : 'false'}">${range}</button>`,
        )
        .join('')}
    </div>
    ${ranges
      .map(
        (range) =>
          `<div data-range-content="${range}" class="s-rcont${range === '6M' ? ' s-on' : ''}" tabindex="0"></div>`,
      )
      .join('')}
    ${ranges
      .map(
        (range) =>
          `<div data-range-stats="${range}" class="s-rstat${range === '6M' ? ' s-on' : ''}"></div>`,
      )
      .join('')}
  </div>`;
  (window as typeof window & { __fuelChartWired?: number }).__fuelChartWired = undefined;
  new Function(FUEL_CHART_SCRIPT_CONTENT)();
}

function tabs(): HTMLButtonElement[] {
  return Array.from(document.querySelectorAll<HTMLButtonElement>('[data-range-btn]'));
}

describe('fuel history chart range selector', () => {
  beforeEach(mountFuelChart);

  it('keeps selected, focus and panel visibility states in sync on click', () => {
    const buttons = tabs();
    buttons[0].click();

    expect(buttons[0].getAttribute('aria-selected')).toBe('true');
    expect(buttons[2].getAttribute('aria-selected')).toBe('false');
    expect(buttons[0].getAttribute('tabindex')).toBe('0');
    expect(buttons[2].getAttribute('tabindex')).toBe('-1');
    expect(buttons[0].hasAttribute('aria-pressed')).toBe(false);
    expect(document.querySelector('[data-range-content="1M"]')?.classList.contains('s-on')).toBe(true);
    expect(document.querySelector('[data-range-content="1M"]')?.getAttribute('aria-hidden')).toBe('false');
    expect(document.querySelector('[data-range-content="6M"]')?.getAttribute('aria-hidden')).toBe('true');
  });

  it('moves through tabs with arrows and Home/End', () => {
    const buttons = tabs();
    buttons[2].focus();

    buttons[2].dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
    expect(document.activeElement).toBe(buttons[3]);
    expect(buttons[3].getAttribute('aria-selected')).toBe('true');

    buttons[3].dispatchEvent(new KeyboardEvent('keydown', { key: 'End', bubbles: true }));
    expect(document.activeElement).toBe(buttons[4]);
    expect(buttons[4].getAttribute('aria-selected')).toBe('true');

    buttons[4].dispatchEvent(new KeyboardEvent('keydown', { key: 'Home', bubbles: true }));
    expect(document.activeElement).toBe(buttons[0]);
    expect(buttons[0].getAttribute('aria-selected')).toBe('true');
  });
});
