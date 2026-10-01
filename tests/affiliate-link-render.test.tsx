import React from 'react';
import { act, cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Analytics } from '@/services/analytics';
import AffiliateLink from '@/components/shared/AffiliateLink';
import CurrencyExchange from '@/components/comparators/CurrencyExchange';
import BankComparison from '@/components/comparators/BankComparison';
import MobileOperators from '@/components/comparators/MobileOperators';

vi.mock('@/services/i18n', () => ({ useTranslation: () => ({ t: (key: string) => key, locale: 'it' }), getLocale: () => 'it' }));
vi.mock('@/services/exchangeRateService', () => ({ useExchangeRate: () => ({ rate: 1.05, loading: false, lastUpdate: null, refresh: vi.fn() }), fetchExchangeHistory: async () => [] }));
vi.mock('@/components/shared/DataFreshness', () => ({ default: () => null }));
vi.mock('@/components/shared/RelatedTools', () => ({ default: () => null }));
vi.mock('@/components/shared/LeadMagnetCTA', () => ({ default: () => null }));
vi.mock('@/components/shared/AdSenseBanner', () => ({ default: () => null }));
vi.mock('recharts', () => ({ ResponsiveContainer: () => null }));

const observed: { callback: IntersectionObserverCallback; element?: Element }[] = [];
beforeEach(() => {
 vi.clearAllMocks(); observed.length = 0;
 vi.stubGlobal('IntersectionObserver', class {
  entry: typeof observed[number];
  constructor(callback: IntersectionObserverCallback) { this.entry = { callback }; observed.push(this.entry); }
  observe(element: Element) { this.entry.element = element; }
  unobserve() {} disconnect() {}
 });
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
const attribution = { surface: 'web', position: 'exchange-result', campaign: 'g4-contextual', variant: 'control' };

function showLink(link: Element) {
 const observer = observed.find(entry => entry.element === link)!;
 act(() => observer.callback([{ target: link, isIntersecting: true, intersectionRatio: 0.5 } as IntersectionObserverEntry], {} as IntersectionObserver));
}

describe('paid CTA rendered contract', () => {
 it('records visible impressions once and keeps the network id on keyboard and middle clicks', async () => {
  const user = userEvent.setup();
  render(<AffiliateLink partnerId="wise" context="exchange" attribution={attribution} target="_blank">Check offer</AffiliateLink>);
  const link = screen.getByRole('link');
  expect(link.getAttribute('rel')).toBe('noopener noreferrer sponsored');
  expect(Analytics.trackAffiliateImpression).not.toHaveBeenCalled();
  showLink(link); showLink(link);
  const id = new URL(link.getAttribute('href')!).searchParams.get('pos');
  expect(Analytics.trackAffiliateImpression).toHaveBeenCalledExactlyOnceWith('wise', 'exchange', { ...attribution, attributionId: id });
  await user.tab(); await user.keyboard('{Enter}');
  await user.pointer({ target: link, keys: '[MouseMiddle]' });
  expect(Analytics.trackAffiliateClick).toHaveBeenCalledTimes(2);
  expect(Analytics.trackAffiliateClick).toHaveBeenLastCalledWith('wise', 'exchange', { ...attribution, attributionId: id });
 });

 it('keeps institutional and disabled links outside the paid funnel', async () => {
  const user = userEvent.setup();
  render(<><AffiliateLink partnerId="priminfo" attribution={attribution}>Official comparator</AffiliateLink><AffiliateLink partnerId="comparis" attribution={attribution} href="https://example.test/">Disabled</AffiliateLink></>);
  for (const link of screen.getAllByRole('link')) {
   expect(link.getAttribute('rel')).toBe('noopener noreferrer');
   await user.click(link);
  }
  expect(Analytics.trackAffiliateClick).not.toHaveBeenCalled();
  expect(observed).toHaveLength(0);
 });

 it('preserves sponsored attributes and placement ids after exchange amount rerenders', async () => {
  const user = userEvent.setup();
  const view = render(<CurrencyExchange />);
  const assertLinks = () => {
   const links = Array.from(view.container.querySelectorAll('a[href*="/go/"]'));
   expect(links.length).toBeGreaterThan(5);
   for (const link of links) {
    expect(link.getAttribute('rel')?.split(' ')).toEqual(expect.arrayContaining(['sponsored', 'noopener', 'noreferrer']));
    expect(link.getAttribute('data-affiliate-id')).toBe(new URL(link.getAttribute('href')!).searchParams.get('pos'));
   }
  };
  assertLinks();
  const input = view.container.querySelector('input[type="number"]')!;
  await user.clear(input); await user.type(input, '5000');
  assertLinks();
  const bestOffer = view.container.querySelector('a[aria-label^="currency.best_offer_cta"]')!;
  expect(bestOffer.textContent).toContain('currency.total_cost');
  expect(bestOffer.textContent).toContain('affiliate.conditions.exchange');
  expect(input.compareDocumentPosition(bestOffer) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
 });

 it('ranks bank fees without sponsoring Wise into the first row', () => {
  render(<BankComparison />);
  const headings = screen.getAllByRole('heading', { level: 3 });
  expect(headings[0].textContent).not.toBe('Wise');
  expect(screen.getByRole('heading', { name: 'Wise' }).closest('a')?.rel).toContain('sponsored');
 });

 it('routes Fastweb through its enabled partner and retains cost conditions', async () => {
  const user = userEvent.setup();
  render(<MobileOperators />);
  const link = screen.getByRole('heading', { name: 'Fastweb Mobile' }).closest('a')!;
  expect(new URL(link.href).pathname).toBe('/go/fastweb/');
  expect(link.rel).toContain('sponsored');
  expect(link.textContent).toContain('affiliate.conditions.mobile');
  expect(link.textContent).toContain('10.00');
  await user.click(link);
  expect(Analytics.trackAffiliateClick).toHaveBeenCalledWith('fastweb', 'mobile', expect.objectContaining({ attributionId: link.dataset.affiliateId }));
 });
});
