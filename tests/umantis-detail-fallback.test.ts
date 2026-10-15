import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  extractUmantisDetailContent,
  isDetailContentValid,
  isDetailPageForTitle,
  isUmantisChromeFragment,
} from '../scripts/lib/umantis-listing-common.mjs';

const fixture = (name: string) => readFileSync(resolve(__dirname, 'fixtures', 'umantis-fallback', name), 'utf8');

// Issue 5253. The p/li fallback of `extractUmantisDetailContent` serves 7 of
// the factory's tenants (custom templates without customdatablock <li>/<p>).
// It had no word boundary after `<(p|li)`, so `<link>` in <head> opened a
// "li" that swallowed the page title and skip links, and `.slice(0, 8)` cut
// 14 of 21 sampled ads short. Real pages, minimised, contacts anonymised.
describe('Umantis detail fallback (custom templates)', () => {
  const html = fixture('buergenstock-2850-1559.html');
  const text = extractUmantisDetailContent(html);

  it('starts with the ad, not with the <head> title or skip links', () => {
    expect(text.startsWith('Eine Ikone der Schweizer Hotellerie')).toBe(true);
    expect(text).not.toMatch(/-->|Bürgenstock Resort\s*$/m);
  });

  it('keeps every section past the old 8-fragment cap, lists as bullets', () => {
    expect(text).toContain('Das erwartet dich\n• Vielfältige Aufgaben und Entwicklungsmöglichkeiten im Bereich ICT');
    expect(text).toContain('• Mitarbeitende schulen und unterstützen bei der Einführung von ICT-Tools und Anwendungen');
    expect(text).toContain('Das zeichnet dich aus');
    expect((text.match(/^• /gm) || []).length).toBeGreaterThan(8);
  });

  it('drops contact cards and page furniture', () => {
    expect(text).not.toMatch(/kontakt@example\.org|\+41 00 000 00 00/);
    expect(isUmantisChromeFragment('Mit dem Job-Abo erhalten Sie neue Jobs direkt per Email')).toBe(true);
    expect(isUmantisChromeFragment('Unsere Personalabteilung hilft Ihnen gerne weiter: +41 61 645 46 06')).toBe(true);
    expect(isUmantisChromeFragment('Selbstständiges Führen einer ambulanten Sprechstunde')).toBe(false);
  });
});

describe('Umantis customdatablocks rendered as <div> (Sanatorium Kilchberg)', () => {
  const html = fixture('kilchberg-3010-667.html');
  const text = extractUmantisDetailContent(html);

  it('reads the div blocks in order: intro, labelled lists, employer paragraph', () => {
    expect(text).toContain('Wir suchen per 1. Oktober 2026 oder nach Vereinbarung für unser Zentrum für Psychosomatik Zürich (ZPZ)');
    expect(text).toMatch(/Ihre Aufgaben:\s*\n• /);
    expect(text).toMatch(/Ihr Profil:\s*\n• /);
    expect(text).toContain('Das Sanatorium Kilchberg ist eine der traditionsreichsten psychiatrischen Privatkliniken');
  });

  it('accepts the ad when only the page heading names the role', () => {
    // The blocks never repeat «Psychologe / Psychologin»; the <title> does.
    expect(isDetailContentValid(text, 'Psychologe / Psychologin')).toBe(false);
    expect(isDetailPageForTitle(html, text, 'Psychologe / Psychologin')).toBe(true);
    // A page that does not name the role is still rejected.
    expect(isDetailPageForTitle('<html><head><title>Stellenmarkt</title></head></html>', text, 'Psychologe / Psychologin')).toBe(false);
  });
});
