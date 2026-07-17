import { describe, it, expect } from 'vitest';
import { buildDormantWinbackStage1Email } from '../services/dormantWinbackStage1Email.mjs';

const ARTICLES = [
  { title: 'Permesso G: guida 2026', excerpt: 'Tutto sul permesso frontaliero.', url: '/articoli-frontaliere/permesso-g/' },
  { title: 'Mutuo casa in Italia', url: '/articoli-frontaliere/mutuo-casa/' },
];

describe('buildDormantWinbackStage1Email', () => {
  it('builds a localized email with subject, html, text and an unsubscribe URL', () => {
    const out = buildDormantWinbackStage1Email({ email: 'user@example.com', locale: 'it', articles: ARTICLES });
    expect(out.subject.length).toBeGreaterThan(0);
    expect(out.html).toContain('<!DOCTYPE html');
    expect(out.text.length).toBeGreaterThan(40);
    expect(out.unsubscribeUrl).toContain('action=unsubscribe');
    expect(out.unsubscribeUrl).toContain('user%40example.com');
  });

  it('renders each article as a clickable, absolute, trailing-slash-terminated link', () => {
    const out = buildDormantWinbackStage1Email({ email: 'a@b.ch', locale: 'it', articles: ARTICLES });
    for (const a of ARTICLES) {
      expect(out.html).toContain(`https://frontaliereticino.ch${a.url}`);
      expect(out.html).toContain(a.title);
      expect(out.text).toContain(`https://frontaliereticino.ch${a.url}`);
    }
    // excerpt renders when present, is skipped when absent
    expect(out.html).toContain(ARTICLES[0].excerpt);
  });

  it('caps rendered articles at 3 and drops entries missing a title or url', () => {
    const many = [
      ...ARTICLES,
      { title: 'Third', url: '/articoli-frontaliere/third/' },
      { title: 'Fourth (should be dropped, over cap)', url: '/articoli-frontaliere/fourth/' },
      { title: 'No url', excerpt: 'x' },
      { url: '/no-title/' },
    ];
    const out = buildDormantWinbackStage1Email({ email: 'a@b.ch', locale: 'it', articles: many });
    expect(out.html).not.toContain('Fourth (should be dropped, over cap)');
    expect(out.html).not.toContain('No url');
  });

  it('renders gracefully with zero articles (no crash, still a complete email)', () => {
    const out = buildDormantWinbackStage1Email({ email: 'a@b.ch', locale: 'it', articles: [] });
    expect(out.html).toContain('<!DOCTYPE html');
    expect(out.unsubscribeUrl).toContain('action=unsubscribe');
  });

  it('renders all four site locales with a localized, distinct subject', () => {
    const subjects = ['it', 'en', 'de', 'fr'].map(
      (l) => buildDormantWinbackStage1Email({ email: 'a@b.ch', locale: l, articles: ARTICLES }).subject,
    );
    expect(new Set(subjects).size).toBe(4);
    expect(subjects.every((s) => s.length > 0)).toBe(true);
  });

  it('falls back to Italian for an unknown locale', () => {
    const it = buildDormantWinbackStage1Email({ email: 'a@b.ch', locale: 'it', articles: ARTICLES });
    const xx = buildDormantWinbackStage1Email({ email: 'a@b.ch', locale: 'xx', articles: ARTICLES });
    expect(xx.subject).toBe(it.subject);
  });

  it('sets the html lang attribute to the locale', () => {
    const out = buildDormantWinbackStage1Email({ email: 'a@b.ch', locale: 'de', articles: ARTICLES });
    expect(out.html).toContain('<html lang="de"');
  });

  it('escapes HTML in article titles/excerpts (no raw markup injection)', () => {
    const out = buildDormantWinbackStage1Email({
      email: 'a@b.ch',
      locale: 'it',
      articles: [{ title: '<script>alert(1)</script>', excerpt: '<b>bold</b>', url: '/x/' }],
    });
    expect(out.html).not.toContain('<script>alert(1)</script>');
    expect(out.html).toContain('&lt;script&gt;');
  });
});
