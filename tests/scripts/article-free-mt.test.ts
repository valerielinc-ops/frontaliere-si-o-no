import { describe, expect, it } from 'vitest';
import { maskNavLinks, translateFieldFreeMt } from '../../scripts/lib/article-free-mt.mjs';

// Pins the quota-free article translation helpers (2026-06-22). Article
// translation moved off the generation LLM cascade onto the free MT cascade
// (freeTranslateWithRetry) to free LLM daily quota for generation. These
// helpers must (a) preserve internal [text](nav:action) CTA links across MT,
// and (b) fail SAFE (return '') so the downstream IT/LLM recovery never ships
// a body with a broken link.

describe('maskNavLinks', () => {
  it('masks every nav-link to a digit-delimited sentinel and restores verbatim', () => {
    const src = 'Vedi il [calcolatore](nav:calculator) e le [scadenze](nav:calendar) qui.';
    const { masked, expected, restore } = maskNavLinks(src);
    expect(expected).toBe(2);
    expect(masked).not.toContain('nav:');
    expect(masked).toContain('0NAVLINK0');
    expect(masked).toContain('0NAVLINK1');
    // MT returns the sentinels intact (typical case)
    const { text, ok } = restore(masked);
    expect(ok).toBe(true);
    expect(text).toBe(src);
  });

  it('reports ok:false when MT drops/mangles a sentinel', () => {
    const src = 'Apri il [calcolatore](nav:calculator).';
    const { masked, restore } = maskNavLinks(src);
    // Simulate MT stripping the sentinel
    const mangled = masked.replace('0NAVLINK0', '');
    expect(restore(mangled).ok).toBe(false);
  });

  it('is a no-op (expected 0) when there are no nav-links', () => {
    const { masked, expected, restore } = maskNavLinks('Testo senza link.');
    expect(expected).toBe(0);
    expect(masked).toBe('Testo senza link.');
    expect(restore('Texte sans lien.')).toEqual({ text: 'Texte sans lien.', ok: true });
  });
});

describe('translateFieldFreeMt', () => {
  const passthroughBalance = (s: string) => s;

  it('translates and restores nav-links around the translated prose', async () => {
    const src = 'Apri il [calcolatore](nav:calculator) ora.';
    const translate = async ({ text }: { text: string }) =>
      // stub MT: "translate" prose, keep the sentinel
      text.replace('Apri il', 'Open the').replace(' ora.', ' now.');
    const out = await translateFieldFreeMt({
      text: src, sourceLang: 'it', targetLang: 'en', fieldType: 'description', translate, balanceMarkdown: passthroughBalance,
    });
    expect(out).toBe('Open the [calcolatore](nav:calculator) now.');
  });

  it('returns "" (fail-safe) when MT mangles the nav-link sentinel', async () => {
    const src = 'Apri il [calcolatore](nav:calculator) ora.';
    const translate = async () => 'Open the now.'; // sentinel lost
    const out = await translateFieldFreeMt({
      text: src, sourceLang: 'it', targetLang: 'en', fieldType: 'description', translate,
    });
    expect(out).toBe('');
  });

  it('returns "" when MT throws or returns empty', async () => {
    const throwing = async () => { throw new Error('all instances down'); };
    expect(await translateFieldFreeMt({ text: 'Ciao', sourceLang: 'it', targetLang: 'en', fieldType: 'title', translate: throwing })).toBe('');
    const empty = async () => '';
    expect(await translateFieldFreeMt({ text: 'Ciao', sourceLang: 'it', targetLang: 'en', fieldType: 'title', translate: empty })).toBe('');
  });

  it('returns "" for blank input without calling MT', async () => {
    let called = false;
    const translate = async () => { called = true; return 'x'; };
    expect(await translateFieldFreeMt({ text: '   ', sourceLang: 'it', targetLang: 'en', fieldType: 'title', translate })).toBe('');
    expect(called).toBe(false);
  });
});
