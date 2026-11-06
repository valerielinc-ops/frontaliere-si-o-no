// @vitest-environment jsdom
// @vitest-environment-options { "url": "https://frontaliereticino.ch/articoli-frontaliere/esempio/" }
import { describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({ active: false, callback: undefined as undefined | (() => void), houseRefresh: vi.fn(), recoveryRefresh: vi.fn(), allowed: undefined as undefined | (() => boolean), subscribe: vi.fn() }));
vi.mock('../services/readerEntitlement', () => ({
  hasActiveReaderNoAdsEntitlement: () => state.active,
  onReaderEntitlementChange: (callback: () => void) => { state.callback = callback; state.subscribe(); return () => {}; },
}));
vi.mock('../services/botPatterns', () => ({ isLikelyBot: () => false }));
vi.mock('../services/thirdPartyDocumentPrivacy.js', () => ({ isSensitiveThirdPartyDocument: () => false }));
vi.mock('../services/houseAdRuntime', () => ({ installHouseAds: (_render: unknown, _css: string, _emit: unknown, allowed: () => boolean) => { state.allowed = allowed; return { refresh: state.houseRefresh }; } }));
vi.mock('../services/adRecovery', () => ({ installAdRecovery: () => ({ refresh: state.recoveryRefresh }) }));

describe('house campaign bootstrap entitlement updates', () => {
  it('refreshes the static/shared singleton on same-tab entitlement changes and subscribes only once', async () => {
    const { startAdRecovery } = await import('../services/startAdRecovery');
    startAdRecovery(); startAdRecovery();
    expect(state.subscribe).toHaveBeenCalledTimes(1);
    expect(state.allowed?.()).toBe(true);
    state.active = true; state.callback?.();
    expect(state.allowed?.()).toBe(false);
    expect(state.houseRefresh).toHaveBeenCalledTimes(1);
    expect(state.recoveryRefresh).toHaveBeenCalledTimes(1);
  });
});
