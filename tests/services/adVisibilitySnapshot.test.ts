// @vitest-environment jsdom
/**
 * collectAdVisibility / watchReturnToTab: the rewarded offer's snapshots of
 * the page's ads (at the click, after the Offerwall, back from the employer's
 * tab), reported to GA4 as ads_total / ads_visible / anchor_visible.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  collectAdVisibility,
  RETURN_TO_TAB_MAX_WAIT_MS,
  RETURN_TO_TAB_SETTLE_MS,
  watchReturnToTab,
} from '@/services/adVisibilitySnapshot';
import { OFFER_ADS_SNAPSHOT_GA4_CUSTOM_METRICS } from '../../scripts/lib/ga4-offer-ads-snapshot-definitions.mjs';

const setVisibility = (state: DocumentVisibilityState) => {
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => state });
  document.dispatchEvent(new Event('visibilitychange'));
};

beforeEach(() => {
  // jsdom lays nothing out: every element is 300×250 unless marked zero-sized.
  vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (this: Element) {
    const zero = (this as HTMLElement).dataset?.zero === '1';
    const w = zero ? 0 : 300;
    const h = zero ? 0 : 250;
    return { x: 0, y: 0, top: 0, left: 0, right: w, bottom: h, width: w, height: h, toJSON: () => ({}) } as DOMRect;
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
  document.body.innerHTML = '';
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'visible' });
});

describe('collectAdVisibility', () => {
  it('counts every ad with a creative, and how many are still rendered', () => {
    document.body.innerHTML = [
      // Manual slots: filled and visible, filled but hidden by an ancestor,
      // filled but zero-sized, unfilled (not an ad yet).
      '<div><ins class="adsbygoogle" data-ad-slot="1" data-ad-status="filled"></ins></div>',
      '<div style="display:none"><ins class="adsbygoogle" data-ad-slot="2" data-ad-status="filled"></ins></div>',
      '<div><ins class="adsbygoogle" data-ad-slot="3" data-ad-status="filled" data-zero="1"></ins></div>',
      '<div><ins class="adsbygoogle" data-ad-slot="4" data-ad-status="unfilled"></ins></div>',
      // Auto ads: one with a creative, one still empty.
      '<div class="google-auto-placed"><ins class="adsbygoogle" data-ad-status="filled"><iframe id="aswift_5"></iframe></ins></div>',
      '<div class="google-auto-placed"></div>',
      // Anchor displayed, GAM rail, the rewarded slot (excluded), the vignette (excluded).
      '<ins class="adsbygoogle" data-anchor-status="displayed" data-ad-status="filled" style="position:fixed"></ins>',
      '<div><iframe id="google_ads_iframe_/23355151813/rail_0"></iframe></div>',
      '<div><iframe id="google_ads_iframe_/23355151813/rewarded-application-video_0"></iframe></div>',
      '<ins class="adsbygoogle" data-vignette-loaded="true" data-ad-status="filled"></ins>',
    ].join('');

    expect(collectAdVisibility(document)).toEqual({ ads_total: 6, ads_visible: 4, anchor_visible: 1 });
  });

  it('reports the anchor as not visible once something hides it', () => {
    document.body.innerHTML = '<ins class="adsbygoogle" data-anchor-status="displayed" style="position:fixed;display:none"></ins>';
    expect(collectAdVisibility(document)).toEqual({ ads_total: 1, ads_visible: 0, anchor_visible: 0 });
  });

  it('treats invisible and transparent ads as hidden', () => {
    document.body.innerHTML = [
      '<ins class="adsbygoogle" data-ad-slot="1" data-ad-status="filled" style="visibility:hidden"></ins>',
      '<div style="opacity:0"><ins class="adsbygoogle" data-ad-slot="2" data-ad-status="filled"></ins></div>',
    ].join('');
    expect(collectAdVisibility(document)).toEqual({ ads_total: 2, ads_visible: 0, anchor_visible: 0 });
  });

  it('sends exactly the metrics registered in GA4', () => {
    expect(Object.keys(collectAdVisibility(document)).sort()).toEqual(
      OFFER_ADS_SNAPSHOT_GA4_CUSTOM_METRICS.map((m: { parameterName: string }) => m.parameterName).sort(),
    );
  });
});

describe('watchReturnToTab', () => {
  it('fires once, after the settle delay, when the page comes back after a hide', () => {
    vi.useFakeTimers();
    const onReturn = vi.fn();
    watchReturnToTab(onReturn);
    setVisibility('hidden');
    setVisibility('visible');
    vi.advanceTimersByTime(RETURN_TO_TAB_SETTLE_MS - 1);
    expect(onReturn).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(onReturn).toHaveBeenCalledTimes(1);
    setVisibility('hidden');
    setVisibility('visible');
    vi.advanceTimersByTime(RETURN_TO_TAB_SETTLE_MS);
    expect(onReturn).toHaveBeenCalledTimes(1);
  });

  it('ignores a visible event that did not follow a hide', () => {
    vi.useFakeTimers();
    const onReturn = vi.fn();
    watchReturnToTab(onReturn);
    setVisibility('visible');
    vi.advanceTimersByTime(RETURN_TO_TAB_SETTLE_MS);
    expect(onReturn).not.toHaveBeenCalled();
  });

  it('keeps one watch at a time and gives up after the maximum wait', () => {
    vi.useFakeTimers();
    const first = vi.fn();
    const second = vi.fn();
    watchReturnToTab(first);
    watchReturnToTab(second);
    vi.advanceTimersByTime(RETURN_TO_TAB_MAX_WAIT_MS);
    setVisibility('hidden');
    setVisibility('visible');
    vi.advanceTimersByTime(RETURN_TO_TAB_SETTLE_MS);
    expect(first).not.toHaveBeenCalled();
    expect(second).not.toHaveBeenCalled();
  });
});
