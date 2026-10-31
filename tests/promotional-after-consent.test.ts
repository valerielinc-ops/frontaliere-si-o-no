import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ADS_CONSENT_CHANGE_EVENT } from '@/services/adsConsent';

describe('a consent choice spends the promotional cap', () => {
  beforeEach(() => {
    vi.useFakeTimers({ now: new Date('2026-10-31T10:00:00Z') });
    vi.stubGlobal('window', new EventTarget());
    vi.resetModules();
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('holds every promotion for 60 s after the CMP closes', async () => {
    const { canShowPromotionalPrompt } = await import('@/services/popupQueue');
    expect(canShowPromotionalPrompt()).toBe(true);
    window.dispatchEvent(new Event(ADS_CONSENT_CHANGE_EVENT));
    expect(canShowPromotionalPrompt()).toBe(false);
    vi.advanceTimersByTime(59_000);
    expect(canShowPromotionalPrompt()).toBe(false);
    vi.advanceTimersByTime(1_000);
    expect(canShowPromotionalPrompt()).toBe(true);
  });
});

describe('a consent decision taken before the queue module loads', () => {
  function storage(): Pick<Storage, 'getItem' | 'setItem'> {
    const values = new Map<string, string>();
    return {
      getItem: (key) => values.get(key) ?? null,
      setItem: (key, value) => { values.set(key, value); },
    };
  }

  beforeEach(() => {
    vi.useFakeTimers({ now: new Date('2026-10-31T10:00:00Z') });
    vi.resetModules();
    const target = new EventTarget() as EventTarget & Record<string, unknown>;
    target.localStorage = storage();
    target.sessionStorage = storage();
    vi.stubGlobal('window', target);
    vi.stubGlobal('sessionStorage', target.sessionStorage);
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('holds the newsletter for 60 s when the real CMP bridge answered first', async () => {
    const { FC_CONSENT_BRIDGE_JS } = await import('@/build-plugins/constants');
    new Function(FC_CONSENT_BRIDGE_JS)();
    const bridge = window as unknown as {
      googlefc: { callbackQueue: Array<{ CONSENT_DATA_READY: () => void }> };
      __tcfapi?: unknown;
    };
    bridge.__tcfapi = (_command: string, _version: number, callback: (data: unknown, ok: boolean) => void) => {
      callback({ eventStatus: 'useractioncomplete', gdprApplies: true, purpose: { consents: { 1: true } } }, true);
    };
    bridge.googlefc.callbackQueue[0].CONSENT_DATA_READY();

    const { canShowPromotionalPrompt, requestSlot, POPUP_PRIORITY } = await import('@/services/popupQueue');
    expect(requestSlot('newsletter-popup', POPUP_PRIORITY.NEWSLETTER)).toBe(false);
    expect(canShowPromotionalPrompt()).toBe(false);
    vi.advanceTimersByTime(60_000);
    expect(canShowPromotionalPrompt()).toBe(true);
  });
});

describe('article share row tap targets', () => {
  it('keeps every icon button at 44 px', () => {
    const source = readFileSync(resolve(import.meta.dirname, '../components/community/BlogArticles.tsx'), 'utf8');
    const shareRow = source.slice(source.indexOf("aria-label={t('blog.copyLink')}") - 300, source.indexOf('<Share2 size={14} />') + 400);
    expect(shareRow).toContain('min-h-[44px]');
    expect(shareRow).toContain('w-11 h-11');
    expect(shareRow).not.toContain('w-9 h-9');
  });
});
