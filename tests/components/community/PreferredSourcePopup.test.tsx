import React from 'react';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, act, cleanup } from '@testing-library/react';

import PreferredSourcePopup from '@/components/community/PreferredSourcePopup';
import { PREFERRED_SOURCE_URL } from '@/components/shared/PreferredSourceCTA';

const trackEvent = vi.fn();
const trackCtaClick = vi.fn();

vi.mock('@/services/analytics', () => ({
  Analytics: {
    trackEvent: (...args: unknown[]) => trackEvent(...args),
    trackCtaClick: (...args: unknown[]) => trackCtaClick(...args),
  },
}));

vi.mock('@/services/i18n', () => ({
  useTranslation: () => ({
    t: (key: string) => `[[${key}]]`,
  }),
}));

vi.mock('@/components/shared/BottomPromptShell', () => ({
  default: ({ children }: { children: React.ReactNode }) => <div data-testid="bottom-prompt">{children}</div>,
}));

const DISMISS_KEY = 'preferredSourcePopup:dismissedUntil';
const ACCEPTED_KEY = 'preferredSourcePopup:accepted';
const SEEN_KEY = 'preferredSourcePopup:seen';

beforeEach(() => {
  vi.useFakeTimers();
  localStorage.clear();
  sessionStorage.clear();
  trackEvent.mockClear();
  trackCtaClick.mockClear();
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe('PreferredSourcePopup', () => {
  it('mostra la CTA a destra e il dismiss a sinistra', () => {
    render(<PreferredSourcePopup articleId="article-1" />);
    act(() => { vi.advanceTimersByTime(1200); });

    const prompt = screen.getByTestId('bottom-prompt');
    const dismiss = screen.getByRole('button', { name: '[[preferredSource.popupDismiss]]' });
    const accept = screen.getByRole('link', { name: '[[preferredSource.popupAccept]]' });

    expect(prompt.compareDocumentPosition(dismiss) & Node.DOCUMENT_POSITION_CONTAINED_BY).toBeTruthy();
    expect(dismiss.compareDocumentPosition(accept) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(accept).toHaveAttribute('href', PREFERRED_SOURCE_URL);
    expect(accept).toHaveAttribute('target', '_blank');
    expect(accept.getAttribute('rel')).toContain('noopener');
    expect(accept.getAttribute('rel')).toContain('noreferrer');
  });

  it('sopprime il prompt per sette giorni dopo il dismiss', () => {
    render(<PreferredSourcePopup articleId="article-1" />);
    act(() => { vi.advanceTimersByTime(1200); });
    fireEvent.click(screen.getByRole('button', { name: '[[preferredSource.popupDismiss]]' }));

    expect(screen.queryByTestId('bottom-prompt')).toBeNull();
    expect(Number(localStorage.getItem(DISMISS_KEY))).toBeGreaterThan(Date.now());
    expect(trackEvent).toHaveBeenCalledWith('preferred_source_popup_dismissed', { article_id: 'article-1' });
  });

  it('registra il click e non ripropone il prompt dopo l apertura', () => {
    render(<PreferredSourcePopup articleId="article-1" />);
    act(() => { vi.advanceTimersByTime(1200); });
    fireEvent.click(screen.getByRole('link', { name: '[[preferredSource.popupAccept]]' }));

    expect(localStorage.getItem(ACCEPTED_KEY)).toBe('true');
    expect(trackCtaClick).toHaveBeenCalledWith(
      'article_preferred_source_popup_cta',
      expect.objectContaining({ targetUrl: PREFERRED_SOURCE_URL, utm_campaign: 'preferred_sources' }),
    );
    expect(screen.queryByTestId('bottom-prompt')).toBeNull();
  });

  it('non si mostra durante il cooldown esistente', () => {
    localStorage.setItem(DISMISS_KEY, String(Date.now() + 60_000));
    render(<PreferredSourcePopup articleId="article-1" />);
    act(() => { vi.advanceTimersByTime(1200); });

    expect(screen.queryByTestId('bottom-prompt')).toBeNull();
  });

  it('non si ripropone su un altro articolo nella stessa sessione dopo essere apparso', () => {
    sessionStorage.setItem(SEEN_KEY, 'true');
    render(<PreferredSourcePopup articleId="article-2" />);
    act(() => { vi.advanceTimersByTime(1200); });

    expect(screen.queryByTestId('bottom-prompt')).toBeNull();
  });
});
