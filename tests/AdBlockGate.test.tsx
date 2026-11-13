/** Coverage for the native application offer shown after ad-block detection. */

import React from 'react';
import { render, screen, act, fireEvent } from '@testing-library/react';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

import AdBlockGate from '@/components/community/AdBlockGate';
import { Analytics } from '@/services/analytics';
import { isLikelyBot, isLikelySearchCrawler } from '@/services/botPatterns';
import { detectAdBlockDetailed } from '@/services/adBlockDetection';

vi.mock('@/services/i18n', () => ({
  useTranslation: () => ({ t: (key: string) => key, locale: 'it' as const }),
}));

vi.mock('@/services/analytics', () => ({
  Analytics: { trackUIInteraction: vi.fn() },
}));

vi.mock('@/services/botPatterns', () => ({
  isLikelyBot: vi.fn(() => false),
  isLikelySearchCrawler: vi.fn(() => false),
}));

vi.mock('@/services/adBlockDetection', () => ({
  detectAdBlockDetailed: vi.fn(() => Promise.resolve({
    blocked: false,
    adsAllowed: false,
    source: 'funding_choices',
    status: null,
  })),
}));

vi.mock('@/services/router', () => ({
  getApplicationConciergePath: (locale: string) => locale === 'it'
    ? '/automatizza-ricerca-lavoro-svizzera/'
    : `/${locale}/automate-job-search-switzerland/`,
  isApplicationConciergePath: (pathname: string) => pathname.includes('automatizza-ricerca-lavoro-svizzera'),
}));

const CLEAN = { blocked: false, adsAllowed: false, source: 'funding_choices' as const, status: null };
const BLOCKED = { blocked: true, adsAllowed: false, source: 'funding_choices' as const, status: null };
const ALLOWLISTED = { blocked: true, adsAllowed: true, source: 'funding_choices' as const, status: null };

const isLikelyBotMock = vi.mocked(isLikelyBot);
const isLikelySearchCrawlerMock = vi.mocked(isLikelySearchCrawler);
const detectAdBlockMock = vi.mocked(detectAdBlockDetailed);
const trackUIInteractionMock = vi.mocked(Analytics.trackUIInteraction);

describe('AdBlockGate native application offer', () => {
  beforeEach(() => {
    isLikelyBotMock.mockReturnValue(false);
    isLikelySearchCrawlerMock.mockReturnValue(false);
    detectAdBlockMock.mockResolvedValue(CLEAN);
    trackUIInteractionMock.mockClear();
    localStorage.clear();
    sessionStorage.clear();
  });

  afterEach(() => {
    localStorage.clear();
    sessionStorage.clear();
  });

  it('does not detect blockers or show the offer to automation bots', async () => {
    isLikelyBotMock.mockReturnValue(true);
    render(<AdBlockGate />);
    await act(async () => {});
    expect(detectAdBlockMock).not.toHaveBeenCalled();
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('does not detect blockers or show the offer to search crawlers', async () => {
    isLikelySearchCrawlerMock.mockReturnValue(true);
    render(<AdBlockGate />);
    await act(async () => {});
    expect(detectAdBlockMock).not.toHaveBeenCalled();
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('shows the localized native promotion and €39.99 one-off price to a human with a blocker', async () => {
    detectAdBlockMock.mockResolvedValue(BLOCKED);
    render(<AdBlockGate />);

    const dialog = await screen.findByRole('dialog');
    expect(dialog).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: /candidature su misura/i })).toBeInTheDocument();
    expect(screen.getByText('39,99 €')).toBeInTheDocument();
    expect(screen.getByText(/pagamento unico · senza rinnovo/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Chiudi promozione' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Continua a leggere' })).toBeInTheDocument();
    expect(trackUIInteractionMock).toHaveBeenCalledWith(
      'application_concierge',
      'adblock_native_offer',
      'modal',
      'impression',
      'adblock_detected',
      'application_concierge.adblock_native_offer.impression',
    );
  });

  it('links to the localized service page with native-ad attribution', async () => {
    detectAdBlockMock.mockResolvedValue(BLOCKED);
    render(<AdBlockGate />);
    await screen.findByRole('dialog');

    const cta = screen.getByRole('link', { name: /scopri il servizio/i });
    const href = cta.getAttribute('href') || '';
    expect(href).toContain('/automatizza-ricerca-lavoro-svizzera/');
    expect(href).toContain('utm_medium=native_ad');
    expect(href).toContain('utm_campaign=application_concierge_adblock');
  });

  it('does not interrupt a human when no blocker is detected', async () => {
    detectAdBlockMock.mockResolvedValue(CLEAN);
    render(<AdBlockGate />);
    await act(async () => {});
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('does not show the offer when Funding Choices says ads are already allowed', async () => {
    detectAdBlockMock.mockResolvedValue(ALLOWLISTED);
    render(<AdBlockGate />);
    await act(async () => {});
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('does not interrupt newsletter subscribers or job-alert subscribers', async () => {
    localStorage.setItem('newsletter_subscribed', 'true');
    render(<AdBlockGate />);
    await act(async () => {});
    expect(detectAdBlockMock).not.toHaveBeenCalled();
    expect(screen.queryByRole('dialog')).toBeNull();

    localStorage.clear();
    localStorage.setItem('job_alert_subscribed', 'true');
    render(<AdBlockGate />);
    await act(async () => {});
    expect(detectAdBlockMock).not.toHaveBeenCalled();
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('closes on dismissal and stays dismissed for the rest of the session', async () => {
    detectAdBlockMock.mockResolvedValue(BLOCKED);
    const first = render(<AdBlockGate />);
    await screen.findByRole('dialog');

    fireEvent.click(screen.getByRole('button', { name: 'Continua a leggere' }));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(sessionStorage.getItem('ft_native_application_offer_dismissed_v1')).toBe('1');
    first.unmount();

    detectAdBlockMock.mockClear();
    render(<AdBlockGate />);
    await act(async () => {});
    expect(detectAdBlockMock).not.toHaveBeenCalled();
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('closes when Escape is pressed', async () => {
    detectAdBlockMock.mockResolvedValue(BLOCKED);
    render(<AdBlockGate />);
    await screen.findByRole('dialog');

    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByRole('dialog')).toBeNull();
  });
});
