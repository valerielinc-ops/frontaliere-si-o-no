import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ADS_CONSENT_CHANGE_EVENT } from '@/services/adsConsent';

describe('a consent choice spends the promotional cap', () => {
  beforeEach(() => {
    vi.useFakeTimers({ now: new Date('2026-10-31T10:00:00Z') });
    vi.stubGlobal('window', new EventTarget());
    vi.stubGlobal('sessionStorage', { getItem: () => null, setItem: () => {} });
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
  beforeEach(() => {
    vi.useFakeTimers({ now: new Date('2026-10-31T10:00:00Z') });
    vi.resetModules();
    vi.stubGlobal('window', new EventTarget());
    vi.stubGlobal('sessionStorage', { getItem: () => null, setItem: () => {} });
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  function cmpReplays(eventStatus: string) {
    (window as unknown as { __tcfapi: unknown }).__tcfapi = (
      _command: string,
      _version: number,
      callback: (data: unknown, ok: boolean) => void,
    ) => callback({ eventStatus }, true);
  }

  it('holds the newsletter for 60 s when the CMP already answered', async () => {
    cmpReplays('useractioncomplete');
    const { canShowPromotionalPrompt, requestSlot, POPUP_PRIORITY } = await import('@/services/popupQueue');
    expect(requestSlot('newsletter-popup', POPUP_PRIORITY.NEWSLETTER)).toBe(false);
    vi.advanceTimersByTime(60_000);
    expect(canShowPromotionalPrompt()).toBe(true);
  });

  it('does not penalise a returning visitor whose choice was only reloaded', async () => {
    cmpReplays('tcloaded');
    const { canShowPromotionalPrompt } = await import('@/services/popupQueue');
    expect(canShowPromotionalPrompt()).toBe(true);
  });

  it('survives a broken CMP', async () => {
    (window as unknown as { __tcfapi: unknown }).__tcfapi = () => { throw new Error('cmp'); };
    const { canShowPromotionalPrompt } = await import('@/services/popupQueue');
    expect(canShowPromotionalPrompt()).toBe(true);
  });
});

describe('a consent event dispatched after the entry but before the queue module', () => {
  beforeEach(() => {
    vi.useFakeTimers({ now: new Date('2026-10-31T10:00:00Z') });
    vi.resetModules();
    vi.stubGlobal('window', new EventTarget());
    const values = new Map<string, string>();
    vi.stubGlobal('sessionStorage', {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => { values.set(key, value); },
    });
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('keeps the newsletter out for 60 s', async () => {
    await import('@/services/consentDecisionMark');
    window.dispatchEvent(new Event(ADS_CONSENT_CHANGE_EVENT));

    const { canShowPromotionalPrompt, requestSlot, POPUP_PRIORITY } = await import('@/services/popupQueue');
    expect(requestSlot('newsletter-popup', POPUP_PRIORITY.NEWSLETTER)).toBe(false);
    vi.advanceTimersByTime(59_000);
    expect(canShowPromotionalPrompt()).toBe(false);
    vi.advanceTimersByTime(1_000);
    expect(canShowPromotionalPrompt()).toBe(true);
  });

  it('has the entry as its only importer: a shared module would land in the entry chunk', () => {
    expect(readFileSync(resolve(import.meta.dirname, '../index.tsx'), 'utf8')).toContain("import './services/consentDecisionMark';");
    const popupQueue = readFileSync(resolve(import.meta.dirname, '../services/popupQueue.ts'), 'utf8');
    expect(popupQueue).not.toContain('consentDecisionMark');
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
