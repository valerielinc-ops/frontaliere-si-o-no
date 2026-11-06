// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { emitAdDiagnostic } from '../services/adDiagnostics';

afterEach(() => { vi.unstubAllGlobals(); });

describe('queryable ad diagnostics', () => {
  it.each([
    ['ad_script_state', { library: 'adsense', state: 'retry_wait', reason: 'load_error' }, { component: 'adsense', action: 'retry_wait' }],
    ['ad_cmp_state', { state: 'unavailable', decision: 'none' }, { action: 'unavailable' }],
    ['ad_block_probe', { result: 'unknown' }, { action: 'unknown' }],
    ['ad_recovery_outcome', { outcome: 'ads_restored', evidence: 'filled_dom' }, { action: 'ads_restored' }],
    ['ad_recovery_outcome', { outcome: 'not_restored', reason: 'script_failed' }, { action: 'not_restored' }],
    ['ad_recovery_action', { action: 'reload', state: 'failed' }, { action: 'reload' }],
    ['ad_fallback_click', { surface: 'banner', reason: 'no_fill' }, { cta_surface: 'banner' }],
  ] as const)('exposes %s through already registered dimensions', (event, properties, expected) => {
    const gtag = vi.fn(); vi.stubGlobal('gtag', gtag);
    emitAdDiagnostic(event, properties);
    expect(gtag).toHaveBeenCalledWith('event', event, expect.objectContaining({ ...properties, ...expected }));
    expect(gtag.mock.calls[0][2].page_location).toBe(window.location.origin + window.location.pathname);
  });

  it('preserves the same queryable fields when gtag has not initialized yet', () => {
    vi.stubGlobal('gtag', undefined); vi.stubGlobal('dataLayer', []);
    emitAdDiagnostic('ad_script_state', { library: 'gpt', state: 'loaded' });
    const queued = (window as Window & { dataLayer: IArguments[] }).dataLayer[0];
    expect(Array.from(queued)).toEqual(['event', 'ad_script_state', expect.objectContaining({ component: 'gpt', action: 'loaded' })]);
  });
});
