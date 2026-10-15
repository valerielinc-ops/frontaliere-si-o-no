/**
 * Regression test for the Kispi SG (Ostschweizer Kinderspital) Pimcore listing
 * title extraction (issue #1850, follow-up of #1829).
 *
 * The original `parseListingPage` extracted the title with `/^([^<]{3,200})/`,
 * assuming the title text begins immediately after `data-id="N">`. When Pimcore
 * wraps the title in a nested element (e.g. `<span>…</span>`), the captured
 * block starts with `<`, the regex returns null → `title === ''` → the card is
 * silently dropped (`title.length < 3 → continue`), yielding fewer than the
 * declared jobs.
 *
 * Fix: take the whole title block up to the closing </p> and strip inner tags,
 * so `<span>`-wrapped (or otherwise nested) titles are still extracted.
 */
import { describe, it, expect } from 'vitest';
import { parseListingPage } from '../../scripts/lib/kispi-sg-job-parser.mjs';

const card = (id: string, titleHtml: string, teaser = 'Kurzer Teaser-Text zur Stelle.') =>
  `<p class="h1" data-id="${id}">${titleHtml}</p>
   <p>${teaser}</p>
   <a href="/de/stellen/test-job-${id}">zu den offenen Stellen</a>`;

describe('Kispi SG listing — title extraction hardening', () => {
  it('parses a plain (unwrapped) title (today’s markup)', () => {
    const out = parseListingPage(card('101', 'Pflegefachperson HF 80%'));
    expect(out).toHaveLength(1);
    expect(out[0].title).toBe('Pflegefachperson HF 80%');
    expect(out[0].slug).toBe('/de/stellen/test-job-101');
    expect(out[0].pimcoreId).toBe('101');
  });

  it('parses a <span>-wrapped title instead of silently dropping the card', () => {
    const out = parseListingPage(card('102', '<span class="title">Oberärztin Neonatologie</span>'));
    expect(out).toHaveLength(1);
    expect(out[0].title).toBe('Oberärztin Neonatologie');
  });

  it('parses a title split across nested elements', () => {
    const out = parseListingPage(card('103', '<span>Fachfrau</span> <strong>Gesundheit</strong> EFZ'));
    expect(out).toHaveLength(1);
    expect(out[0].title).toBe('Fachfrau Gesundheit EFZ');
  });

  it('keeps the teaser as the snippet, separate from a wrapped title', () => {
    const out = parseListingPage(card('104', '<span>Hebamme</span>', 'Wir suchen eine Hebamme für unser Team.'));
    expect(out).toHaveLength(1);
    expect(out[0].title).toBe('Hebamme');
    expect(out[0].snippet).toBe('Wir suchen eine Hebamme für unser Team.');
  });

  it('decodes HTML entities in a wrapped title', () => {
    const out = parseListingPage(card('105', '<span>Koch &amp; Köchin</span>'));
    expect(out).toHaveLength(1);
    expect(out[0].title).toBe('Koch & Köchin');
  });

  it('still skips initiative applications when wrapped', () => {
    const out = parseListingPage(card('106', '<span>Initiativbewerbung</span>'));
    expect(out).toHaveLength(0);
  });

  it('parses several cards, including a mix of plain and wrapped titles', () => {
    const html = card('201', 'Stationsleitung') + card('202', '<span>Logopädin</span>');
    const out = parseListingPage(html);
    expect(out.map((c) => c.title)).toEqual(['Stationsleitung', 'Logopädin']);
  });
});
