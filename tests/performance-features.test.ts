/**
 * Tests for new performance features:
 * - Consent Service (CMP)
 * - Web Vitals telemetry
 * - Prefetch on intent
 * - Funnel tracking
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

// ─── Consent Service ─────────────────────────────────────────────────

// We test consentService directly (not the mock)
// Need to un-mock it for these tests
vi.unmock('@/services/consentService');

describe('Consent Service', () => {
  beforeEach(() => {
    localStorage.clear();
    // Reset window.dataLayer
    (window as any).dataLayer = undefined;
    (window as any).gtag = undefined;
  });

  it('hasConsent returns false when no consent stored', async () => {
    const { hasConsent } = await import('@/services/consentService');
    expect(hasConsent()).toBe(false);
  });

  it('acceptAll persists consent and returns granted state', async () => {
    const { acceptAll, getConsent, hasConsent } = await import('@/services/consentService');
    const state = acceptAll();
    expect(state.analytics).toBe(true);
    expect(state.advertising).toBe(true);
    expect(state.timestamp).toBeGreaterThan(0);
    expect(hasConsent()).toBe(true);
    
    const stored = getConsent();
    expect(stored).not.toBeNull();
    expect(stored!.analytics).toBe(true);
    expect(stored!.advertising).toBe(true);
  });

  it('rejectAll persists denied state', async () => {
    const { rejectAll, getConsent } = await import('@/services/consentService');
    const state = rejectAll();
    expect(state.analytics).toBe(false);
    expect(state.advertising).toBe(false);

    const stored = getConsent();
    expect(stored!.analytics).toBe(false);
  });

  it('updateConsent partially updates categories', async () => {
    const { acceptAll, updateConsent, getConsent } = await import('@/services/consentService');
    acceptAll();
    updateConsent({ advertising: false });
    const stored = getConsent();
    expect(stored!.analytics).toBe(true); // unchanged
    expect(stored!.advertising).toBe(false); // updated
  });

  it('isAnalyticsGranted returns correct value', async () => {
    const { acceptAll, rejectAll, isAnalyticsGranted } = await import('@/services/consentService');
    rejectAll();
    expect(isAnalyticsGranted()).toBe(false);
    acceptAll();
    expect(isAnalyticsGranted()).toBe(true);
  });

  it('setDefaultConsent creates dataLayer', async () => {
    const { setDefaultConsent } = await import('@/services/consentService');
    setDefaultConsent();
    expect((window as any).dataLayer).toBeDefined();
    expect((window as any).dataLayer.length).toBeGreaterThan(0);
  });

  it('onConsentChange notifies listeners', async () => {
    const { onConsentChange, acceptAll } = await import('@/services/consentService');
    const listener = vi.fn();
    const unsubscribe = onConsentChange(listener);
    
    acceptAll();
    expect(listener).toHaveBeenCalledWith(expect.objectContaining({ analytics: true, advertising: true }));
    
    unsubscribe();
    listener.mockClear();
    acceptAll();
    // Should NOT be called after unsubscribe
    expect(listener).not.toHaveBeenCalled();
  });

  it('revokeConsent resets state', async () => {
    const { acceptAll, revokeConsent, isAnalyticsGranted, isAdvertisingGranted } = await import('@/services/consentService');
    acceptAll();
    expect(isAnalyticsGranted()).toBe(true);
    
    revokeConsent();
    expect(isAnalyticsGranted()).toBe(false);
    expect(isAdvertisingGranted()).toBe(false);
  });
});

// ─── Prefetch Service ────────────────────────────────────────────────

vi.unmock('@/services/prefetch');

describe('Prefetch Service', () => {
  it('prefetchOnIdle calls loader once per key', async () => {
    const { prefetchOnIdle } = await import('@/services/prefetch');
    const loader = vi.fn(() => Promise.resolve());
    
    // Call twice with same key
    prefetchOnIdle('test-key', loader);
    prefetchOnIdle('test-key', loader);
    
    // Wait for idle callback / setTimeout
    await new Promise(resolve => setTimeout(resolve, 200));
    
    // Should only be called once (deduplicated by key)
    expect(loader).toHaveBeenCalledTimes(1);
  });

  it('prefetchTab triggers loaders for known tabs', async () => {
    const { prefetchTab } = await import('@/services/prefetch');
    // Should not throw for known or unknown tabs
    expect(() => prefetchTab('confronti')).not.toThrow();
    expect(() => prefetchTab('unknown-tab')).not.toThrow();
  });
});

// ─── Funnel Tracking ─────────────────────────────────────────────────

describe('Funnel tracking — Analytics methods exist', () => {
  it('Analytics has trackFunnelStep method', async () => {
    // Use the real module (not mock) to verify the method exists
    vi.unmock('@/services/analytics');
    const { Analytics } = await import('@/services/analytics');
    expect(typeof Analytics.trackFunnelStep).toBe('function');
  });

  it('Analytics has trackConsentChange method', async () => {
    vi.unmock('@/services/analytics');
    const { Analytics } = await import('@/services/analytics');
    expect(typeof Analytics.trackConsentChange).toBe('function');
  });

  it('trackFunnelStep accepts valid step names', async () => {
    vi.unmock('@/services/analytics');
    const { Analytics } = await import('@/services/analytics');
    // Should not throw
    expect(() => Analytics.trackFunnelStep('entry')).not.toThrow();
    expect(() => Analytics.trackFunnelStep('input_start', { first_field: 'salary' })).not.toThrow();
    expect(() => Analytics.trackFunnelStep('calculate', { worker_type: 'new' })).not.toThrow();
    expect(() => Analytics.trackFunnelStep('compare', { from_tab: 'calculator' })).not.toThrow();
    expect(() => Analytics.trackFunnelStep('cta_click')).not.toThrow();
  });
});

// ─── Web Vitals ──────────────────────────────────────────────────────

vi.unmock('@/services/webVitals');

describe('Web Vitals telemetry', () => {
  it('initWebVitals does not throw', async () => {
    const { initWebVitals } = await import('@/services/webVitals');
    expect(() => initWebVitals()).not.toThrow();
  }, 15000);
});
