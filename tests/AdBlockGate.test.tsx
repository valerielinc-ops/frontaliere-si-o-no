/** Coverage for the native application offer shown after ad-block detection. */

import React from 'react';
import { render, screen, act, fireEvent } from '@testing-library/react';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

import AdBlockGate from '@/components/community/AdBlockGate';
import { Analytics } from '@/services/analytics';
import { emitAdDiagnostic } from '@/services/adDiagnostics';
import { isLikelyBot, isLikelySearchCrawler } from '@/services/botPatterns';
import { detectAdBlockDetailed } from '@/services/adBlockDetection';

vi.mock('@/services/i18n', () => ({
  useTranslation: () => ({ t: (key: string) => key, locale: 'it' as const }),
}));

vi.mock('@/services/analytics', () => ({
  Analytics: { trackUIInteraction: vi.fn() },
}));

vi.mock('@/services/adDiagnostics', () => ({ emitAdDiagnostic: vi.fn() }));

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
const emitAdDiagnosticMock = vi.mocked(emitAdDiagnostic);

function setSlotSize(slot: HTMLElement, width: number, height: number): void {
  slot.getBoundingClientRect = () => ({
    x: 0, y: 0, width, height, top: 0, right: width, bottom: height, left: 0, toJSON: () => ({}),
  }) as DOMRect;
}

describe('AdBlockGate native application offer', () => {
  beforeEach(() => {
    isLikelyBotMock.mockReturnValue(false);
    isLikelySearchCrawlerMock.mockReturnValue(false);
    detectAdBlockMock.mockResolvedValue(CLEAN);
    trackUIInteractionMock.mockClear();
    emitAdDiagnosticMock.mockClear();
    delete (window as Window & { __ftNativeApplicationOfferShown?: boolean }).__ftNativeApplicationOfferShown;
    localStorage.clear();
    sessionStorage.clear();
  });

  afterEach(() => {
    delete (window as Window & { __ftNativeApplicationOfferShown?: boolean }).__ftNativeApplicationOfferShown;
    localStorage.clear();
    sessionStorage.clear();
    document.body.querySelectorAll('[data-house]').forEach((slot) => slot.remove());
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
    expect(screen.getByRole('heading', { name: /lavoro in svizzera\? lo cerchiamo noi per te/i })).toBeInTheDocument();
    expect(screen.getByText('39,99 €')).toBeInTheDocument();
    expect(screen.getByText(/pagamento unico · senza rinnovo/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Chiudi promozione' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Continua a leggere' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Vuoi continuare a leggere con gli annunci?' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Ho consentito gli annunci — ricarica' })).toBeInTheDocument();
    expect(screen.getByText(/Solo tu puoi consentire il sito nelle impostazioni/)).toBeInTheDocument();
    expect(trackUIInteractionMock).toHaveBeenCalledWith(
      'application_concierge',
      'adblock_native_offer',
      'modal',
      'impression',
      'adblock_detected',
      'application_concierge.adblock_native_offer.impression',
    );
  });

  it('lets a usable inline ad slot own the fallback instead of opening the global promotion', async () => {
    detectAdBlockMock.mockResolvedValue(BLOCKED);
    const slot = document.createElement('div');
    slot.dataset.house = 'article-inline';
    slot.innerHTML = '<div data-ft-house-google></div>';
    setSlotSize(slot, 320, 90);
    document.body.append(slot);

    render(<AdBlockGate />);
    await act(async () => {});

    expect(screen.queryByRole('dialog')).toBeNull();
    expect(trackUIInteractionMock).not.toHaveBeenCalled();
  });

  it('keeps the global promotion when a blocker-only slot has width but zero rendered height', async () => {
    detectAdBlockMock.mockResolvedValue(BLOCKED);
    const slot = document.createElement('div');
    slot.dataset.house = 'article-atf';
    slot.dataset.ftHouseBlockerOnly = 'true';
    slot.innerHTML = '<div data-ft-house-google></div>';
    setSlotSize(slot, 320, 0);
    document.body.append(slot);

    render(<AdBlockGate />);

    expect(await screen.findByRole('dialog')).toBeInTheDocument();
  });

  it('keeps the global promotion when every inline slot is hidden or too narrow', async () => {
    detectAdBlockMock.mockResolvedValue(BLOCKED);
    const narrow = document.createElement('div');
    narrow.dataset.house = 'mobile-banner';
    narrow.innerHTML = '<div data-ft-house-google></div>';
    setSlotSize(narrow, 120, 50);
    const hidden = document.createElement('div');
    hidden.dataset.house = 'desktop-rail';
    hidden.style.display = 'none';
    hidden.innerHTML = '<div data-ft-house-google></div>';
    setSlotSize(hidden, 320, 250);
    document.body.append(narrow, hidden);

    render(<AdBlockGate />);

    expect(await screen.findByRole('dialog')).toBeInTheDocument();
  });

  it('opens the localized allowlist steps and reports the action through ad diagnostics', async () => {
    detectAdBlockMock.mockResolvedValue(BLOCKED);
    render(<AdBlockGate />);
    await screen.findByRole('dialog');

    const instructions = screen.getByText('Come consentire gli annunci').closest('details');
    expect(instructions).not.toBeNull();
    instructions!.open = true;
    fireEvent(instructions!, new Event('toggle'));

    expect(screen.getByText(/Apri l’icona del blocco pubblicità/)).toBeInTheDocument();
    expect(screen.getByText(/Metti in pausa su questo sito/)).toBeInTheDocument();
    expect(emitAdDiagnosticMock).toHaveBeenCalledWith('ad_recovery_action', {
      action: 'allowlist_help_open',
      reason: 'adblock_detected',
    });
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

  it('coordinates with the static recovery surface so the native offer appears only once per session', async () => {
    sessionStorage.setItem('ft_native_application_offer_seen_v1', '1');
    detectAdBlockMock.mockResolvedValue(BLOCKED);
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
