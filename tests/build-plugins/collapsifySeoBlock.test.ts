/**
 * Unit test for collapsifySeoBlock — the runtime transform that turns the
 * inline-styled prerendered SEO blocks (homepage / calculator / job-board)
 * into compact, dark-mode-aware collapsible <details>/<summary> panels.
 */

import { describe, it, expect } from 'vitest';
import { collapsifySeoBlock } from '../../build-plugins/staticPagesPlugin';

const SAMPLE_BLOCK = `<aside id="hp-seo-block" style="max-width:1100px;margin:32px auto 56px;padding:0 20px;font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;color:#334155;line-height:1.65" aria-labelledby="hpSeoTitle"><h2 id="hpSeoTitle" style="font-size:24px;font-weight:700;color:#0f172a;margin:0 0 14px">Titolo principale</h2><p style="margin:0 0 14px">Paragrafo intro con prosa specifica del frontaliere.</p><h2 style="font-size:20px;font-weight:700;color:#0f172a;margin:24px 0 12px">Sezione uno</h2><p style="margin:0 0 14px">Contenuto sezione uno.</p><h2 style="font-size:20px;font-weight:700;color:#0f172a;margin:24px 0 12px">Sezione due</h2><div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:14px;margin:0 0 22px"><div style="background:#f1f5f9;border-radius:12px;padding:16px"><h3 style="font-size:15px;font-weight:700;margin:0 0 6px;color:#1e293b">Card uno</h3><p style="margin:0;font-size:14px">Descrizione card uno.</p></div></div><h2 style="font-size:20px;font-weight:700;color:#0f172a;margin:24px 0 12px">Sezione FAQ</h2><dl style="margin:0 0 22px"><dt style="font-weight:600;color:#0f172a;margin-bottom:4px">Domanda?</dt><dd style="margin:0 0 14px">Risposta.</dd></dl><p style="margin:0;font-size:14px;color:#64748b">Disclaimer finale.</p></aside>`;

describe('collapsifySeoBlock', () => {
  const out = collapsifySeoBlock(SAMPLE_BLOCK);

  it('replaces inline-styled <aside> wrapper with the seo-footer-block class', () => {
    expect(out).toContain('<aside id="hp-seo-block" class="seo-footer-block" aria-labelledby="hpSeoTitle">');
    expect(out).not.toMatch(/<aside id="hp-seo-block" style=/);
  });

  it('tags the title H2 (id="*SeoTitle") with the .seo-fb-title class', () => {
    expect(out).toContain('<h2 id="hpSeoTitle" class="seo-fb-title">Titolo principale</h2>');
  });

  it('wraps the intro paragraph with the .seo-fb-intro class', () => {
    expect(out).toContain('<p class="seo-fb-intro">Paragrafo intro con prosa specifica del frontaliere.</p>');
  });

  it('produces one <details> per section-level H2 with summary and body', () => {
    const detailsCount = (out.match(/<details>/g) || []).length;
    expect(detailsCount).toBe(3);
    expect(out).toContain('<details><summary>Sezione uno</summary><div class="seo-fb-section-body">');
    expect(out).toContain('<details><summary>Sezione due</summary><div class="seo-fb-section-body">');
    expect(out).toContain('<details><summary>Sezione FAQ</summary><div class="seo-fb-section-body">');
  });

  it('replaces the cards grid container and each card with classes', () => {
    expect(out).toContain('<div class="seo-fb-cards">');
    expect(out).toContain('<div class="seo-fb-card">');
  });

  it('tags the closing disclaimer paragraph with .seo-fb-disclaimer', () => {
    expect(out).toContain('<p class="seo-fb-disclaimer">Disclaimer finale.</p>');
  });

  it('strips every #rrggbb hex color from the resulting markup', () => {
    expect(out).not.toMatch(/#[0-9a-fA-F]{6}/);
  });

  it('removes inline style attributes from h3/p/dl/dt/dd', () => {
    expect(out).not.toMatch(/<h3 style=/);
    expect(out).not.toMatch(/<dt style=/);
    expect(out).not.toMatch(/<dd style=/);
    expect(out).not.toMatch(/<dl style=/);
  });

  it('preserves the prose content of every section', () => {
    expect(out).toContain('Contenuto sezione uno.');
    expect(out).toContain('Card uno');
    expect(out).toContain('Descrizione card uno.');
    expect(out).toContain('Domanda?');
    expect(out).toContain('Risposta.');
  });

  it('emits valid HTML structure with closing tags balanced', () => {
    const opens = (out.match(/<details>/g) || []).length;
    const closes = (out.match(/<\/details>/g) || []).length;
    expect(opens).toBe(closes);

    const summaryOpens = (out.match(/<summary>/g) || []).length;
    const summaryCloses = (out.match(/<\/summary>/g) || []).length;
    expect(summaryOpens).toBe(summaryCloses);
    expect(summaryOpens).toBe(3);
  });
});
