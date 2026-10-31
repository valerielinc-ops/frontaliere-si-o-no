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

describe('article share row tap targets', () => {
  it('keeps every icon button at 44 px', () => {
    const source = readFileSync(resolve(import.meta.dirname, '../components/community/BlogArticles.tsx'), 'utf8');
    const shareRow = source.slice(source.indexOf("aria-label={t('blog.copyLink')}") - 300, source.indexOf('<Share2 size={14} />') + 400);
    expect(shareRow).toContain('min-h-[44px]');
    expect(shareRow).toContain('w-11 h-11');
    expect(shareRow).not.toContain('w-9 h-9');
  });
});
