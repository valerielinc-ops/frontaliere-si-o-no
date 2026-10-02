import { describe, expect, it, vi } from 'vitest';
import { extractEventBookingPrice, fetchEventBookingPrice, sameVenue, supportedEventBookingUrl } from '../scripts/lib/event-booking-price.mjs';

const bookingUrl = 'https://infomaniak.events/fr-ch/concerts/example/events/123';
const event = { startDate: '2026-10-04', venue: 'Fondation Opale' };
const node = {
  '@type': 'MusicEvent', name: 'Concert', startDate: '2026-10-04T16:30:00+02:00',
  location: { name: 'Fondation Opale' },
  offers: { price: 0, priceCurrency: 'CHF', availability: 'https://schema.org/InStock', validFrom: '2026-09-11T15:28:20+02:00' },
};
const ld = value => `<script type="application/ld+json">${JSON.stringify(value)}</script>`;

describe('official event booking tariffs', () => {
  it('requires an exact or prefix venue match without merging sibling venues', () => {
    expect(sameVenue('Baden', 'Kurtheater Baden')).toBe(false);
    expect(sameVenue('Kurtheater Baden', 'Kurtheater Baden')).toBe(true);
    expect(sameVenue('New Hall', 'Old Hall')).toBe(false);
    expect(sameVenue('Hall', 'New Hall')).toBe(false);
  });

  it('preserves an explicit free Offer, date and venue from Infomaniak', () => {
    expect(extractEventBookingPrice(ld([node]), bookingUrl, event)).toEqual({
      amount: 0, currency: 'CHF', isFree: true, url: bookingUrl,
      availability: 'https://schema.org/InStock', validFrom: node.offers.validFrom,
    });
  });

  it.each([null, '', ' ', undefined])('never turns an absent price %s into zero', price => {
    expect(extractEventBookingPrice(ld({ ...node, offers: { price, priceCurrency: 'CHF' } }), bookingUrl, event)).toBeUndefined();
  });

  it('rejects a related event on a different date or at a different venue', () => {
    expect(extractEventBookingPrice(ld({ ...node, startDate: '2026-10-05' }), bookingUrl, event)).toBeUndefined();
    expect(extractEventBookingPrice(ld({ ...node, location: { name: 'Another venue' } }), bookingUrl, event)).toBeUndefined();
  });

  it('converts UTC to the local event date before matching', () => {
    expect(extractEventBookingPrice(ld({ ...node, startDate: '2026-10-03T23:30:00Z' }), bookingUrl, event)?.amount).toBe(0);
  });

  it.each(['https://www.ticketino.com/de/event/123', 'https://eventfrog.ch/example'])('uses published Event offers on %s', url => {
    const html = ld({ ...node, startDate: '2026-10-03T23:30:00+0000', offers: { price: '10.0000', priceCurrency: 'CHF' } });
    expect(extractEventBookingPrice(html, url, event)).toEqual({ amount: 10, currency: 'CHF', isFree: false, url });
    expect(extractEventBookingPrice(html, url, { ...event, venue: 'Other theatre' })).toBeUndefined();
  });

  it('recovers the published starting tariff from a PETZI event page', () => {
    const html = `<h1>20 Years Fractal</h1><h4>Price starting at CHF 29.90</h4>
      <h3>Saturday 7 November 2026</h3><h4>Chessu / Coupole – Biel</h4>`;
    expect(extractEventBookingPrice(html, 'https://www.petzi.ch/events/64715/', {
      startDate: '2026-11-07', venue: 'AJZ Chessu / la Coupole',
    })).toEqual({ amount: 29.9, currency: 'CHF', isFree: false, url: 'https://www.petzi.ch/events/64715/' });
  });

  it('accepts localized PETZI date and tariff labels', () => {
    const html = '<h3>Freitag, 7. November 2026</h3><h4>Ab CHF 29.90</h4><h4>Chessu / Coupole – Biel</h4>';
    expect(extractEventBookingPrice(html, 'https://www.petzi.ch/events/64715/', {
      startDate: '2026-11-07', venue: 'Chessu / Coupole',
    })).toEqual({ amount: 29.9, currency: 'CHF', isFree: false, url: 'https://www.petzi.ch/events/64715/' });
  });

  it('does not combine incomparable currencies or ambiguous matching events', () => {
    const priced = { ...node, offers: [{ price: 20, priceCurrency: 'CHF' }, { price: 10, priceCurrency: 'EUR' }] };
    expect(extractEventBookingPrice(ld(priced), bookingUrl, event)).toBeUndefined();
    expect(extractEventBookingPrice(ld([node, { ...node, name: 'Other concert' }]), bookingUrl, event)).toBeUndefined();
  });

  it('uses the Bellevue normal-ticket gross price rather than base price, quantities or vouchers', () => {
    const html = ld({ ...node, '@type': 'event', offers: { price: 20, priceCurrency: 'CHF' } }) + `<div id="shopitems"><table>
      <tr><td class="shopitem-title">5 Bons</td><td><div class="shop-cart-price"><div>CHF 1.–</div></div></td></tr>
      <tr><td class="shopitem-title">Normales Ticket</td><td><div class="shop-cart-price"><div>CHF 21.60</div><div class="shop-cart-price-without-fee">(CHF 20.–)*</div></div></td><td>0 1 2</td></tr>
    </table></div>`;
    expect(extractEventBookingPrice(html, 'https://tickets.club-bellevue.ch/events/example', event)?.amount).toBe(21.6);
    expect(extractEventBookingPrice(ld(node), 'https://tickets.club-bellevue.ch/events/example', event)).toBeUndefined();
  });

  const mapadoUrl = 'https://ticketing-nodabcvs.mapado.com/event/123-concert';
  const mapadoEvent = { startDate: '2026-11-24', venue: 'NODA BCVS - Salle de concerts et congrès' };
  const mapado = (tariff = 'Gratuit', label = 'Noda+') => `<main>
    <div class="mpd-card"><span>Mardi</span><span class="h2-like">24</span><span>Nov. 2026</span><span>18:00</span></div>
    <h1>Concert</h1><p>NODA BCVS - Grande Salle (Sion)</p>
    <div class="mpd-card"><div>${label}</div><div class="h2-like">${tariff}</div><span>0</span><button aria-label="Ajouter">+</button></div>
  </main>`;

  it('recovers Mapado tariff cards from server HTML without confusing the date or quantity with a price', () => {
    expect(extractEventBookingPrice(mapado(), mapadoUrl, mapadoEvent)).toEqual({ amount: 0, currency: 'CHF', isFree: true, url: mapadoUrl });
    expect(extractEventBookingPrice(mapado('CHF 30'), mapadoUrl, mapadoEvent)?.amount).toBe(30);
    expect(extractEventBookingPrice(mapado('Sur demande'), mapadoUrl, mapadoEvent)).toBeUndefined();
  });

  it('does not promote a free children tariff, wrong Mapado date, or wrong venue', () => {
    expect(extractEventBookingPrice(mapado('Gratuit', 'Enfants'), mapadoUrl, mapadoEvent)).toBeUndefined();
    expect(extractEventBookingPrice(mapado(), mapadoUrl, { ...mapadoEvent, startDate: '2026-11-25' })).toBeUndefined();
    expect(extractEventBookingPrice(mapado(), mapadoUrl, { ...mapadoEvent, venue: 'Other hall' })).toBeUndefined();
  });

  it('restricts booking requests to verified public HTTPS hosts', async () => {
    const fetchImpl = vi.fn();
    for (const url of ['https://127.0.0.1/event', 'http://infomaniak.events/event', 'https://infomaniak.events.evil.test/', 'https://user:pass@infomaniak.events/', 'https://infomaniak.events:8443/']) {
      expect(supportedEventBookingUrl(url)).toBeUndefined();
      expect(await fetchEventBookingPrice(event, url, { fetchImpl })).toBeUndefined();
    }
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('rejects off-origin redirects before making a second request', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response('', { status: 302, headers: { location: 'http://127.0.0.1/private' } }));
    expect(await fetchEventBookingPrice(event, bookingUrl, { fetchImpl })).toBeUndefined();
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(fetchImpl.mock.calls[0][1].redirect).toBe('manual');
  });

  it('bounds HTML reads and preserves unknown on network failures', async () => {
    expect(await fetchEventBookingPrice(event, bookingUrl, { fetchImpl: vi.fn().mockRejectedValue(new Error('offline')) })).toBeUndefined();
    expect(await fetchEventBookingPrice(event, bookingUrl, { fetchImpl: vi.fn().mockResolvedValue(new Response('x'.repeat(2 * 1024 * 1024 + 1))) })).toBeUndefined();
    expect((await fetchEventBookingPrice(event, bookingUrl, { fetchImpl: vi.fn().mockResolvedValue(new Response(ld(node))) }))?.amount).toBe(0);
  });
});
