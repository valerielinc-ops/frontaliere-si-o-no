// @vitest-environment jsdom
// @vitest-environment-options { "url": "https://frontaliereticino.ch/articoli-frontaliere/esempio/" }
import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const state = vi.hoisted(() => ({ active: false, callback: undefined as undefined | (() => void), houseRefresh: vi.fn(), recoveryRefresh: vi.fn(), allowed: undefined as undefined | (() => boolean), houseConfig: undefined as unknown, recoveryConfig: undefined as unknown, subscribe: vi.fn() }));
vi.mock('../services/readerEntitlement', () => ({
  hasActiveReaderNoAdsEntitlement: () => state.active,
  onReaderEntitlementChange: (callback: () => void) => { state.callback = callback; state.subscribe(); return () => {}; },
}));
vi.mock('../services/botPatterns', () => ({ isLikelyBot: () => false, isLikelySearchCrawler: () => false }));
vi.mock('../services/thirdPartyDocumentPrivacy.js', () => ({ isSensitiveThirdPartyDocument: () => false }));
vi.mock('../services/houseAdRuntime', () => ({ installHouseAds: (_render: unknown, _css: string, _emit: unknown, allowed: () => boolean, config: unknown) => { state.allowed = allowed; state.houseConfig = config; return { refresh: state.houseRefresh }; } }));
vi.mock('../services/adRecovery', () => ({ installAdRecovery: (_probe: unknown, _loader: unknown, _emit: unknown, _allowed: unknown, config: unknown) => { state.recoveryConfig = config; return { refresh: state.recoveryRefresh }; } }));

describe('house campaign bootstrap entitlement updates', () => {
  it('starts ad recovery from the SPA entrypoint after stale-chunk recovery is registered', () => {
    const entry = readFileSync(resolve(process.cwd(), 'index.tsx'), 'utf8');
    const retryHandler = entry.indexOf("window.addEventListener('vite:preloadError'");
    const recoveryImport = entry.indexOf("void import('./services/startAdRecovery')");
    const appAuthorityImport = entry.indexOf("const { captureStaticHead }");

    expect(retryHandler).toBeGreaterThanOrEqual(0);
    expect(recoveryImport).toBeGreaterThan(retryHandler);
    expect(recoveryImport).toBeLessThan(appAuthorityImport);
    expect(entry.slice(recoveryImport, appAuthorityImport)).toContain(
      '.then(({ startAdRecovery }) => startAdRecovery())',
    );
    expect(entry.slice(recoveryImport, appAuthorityImport)).toContain(
      "reportCaughtError(error, 'adRecovery.bootstrap')",
    );
  });

  it('refreshes the static/shared singleton on same-tab entitlement changes and subscribes only once', async () => {
    const { startAdRecovery } = await import('../services/startAdRecovery');
    startAdRecovery(); startAdRecovery();
    expect(state.subscribe).toHaveBeenCalledTimes(1);
    expect(state.allowed?.()).toBe(true);
    expect(state.houseConfig).toMatchObject({ readerSubscriptionPaths: { it: '/abbonamento/', en: '/en/subscribe/', de: '/de/abonnement/', fr: '/fr/abonnement/' } });
    expect(state.recoveryConfig).toMatchObject({ readerSubscriptionPaths: ['/abbonamento/', '/en/subscribe/', '/de/abonnement/', '/fr/abonnement/'] });
    state.active = true; state.callback?.();
    expect(state.allowed?.()).toBe(false);
    expect(state.houseRefresh).toHaveBeenCalledTimes(1);
    expect(state.recoveryRefresh).toHaveBeenCalledTimes(1);
  });
});
