import { describe, expect, it } from 'vitest';
import { renderPlainTextLinks } from '../build-plugins/shared/plainTextLinks';

describe('plain-text FAQ sources', () => {
  it('links a source including query parameters without swallowing sentence punctuation', () => {
    const text = 'Fonte: https://dst.bazg.admin.ch/dst/print?id=386&lang=4. Fine.';
    expect(renderPlainTextLinks(text)).toBe('Fonte: <a href="https://dst.bazg.admin.ch/dst/print?id=386&amp;lang=4" rel="noopener noreferrer">https://dst.bazg.admin.ch/dst/print?id=386&amp;lang=4</a>. Fine.');
  });
  it('keeps HTML and non-HTTP schemes inert', () => {
    const html = renderPlainTextLinks('<script>alert(1)</script> javascript:alert(1) https://example.org/" onclick="alert(1)');
    expect(html).not.toContain('<script>');
    expect(html).not.toContain('href="javascript:');
    expect(html).not.toContain('" onclick="');
    expect(html).toContain('&lt;script&gt;');
  });
  it('preserves text and punctuation around multiple links', () => {
    expect(renderPlainTextLinks('A https://a.example/, B https://b.example/.')).toContain('</a>, B <a');
    expect(renderPlainTextLinks('Plain text & <em>markup</em>')).toBe('Plain text &amp; &lt;em&gt;markup&lt;/em&gt;');
  });
  it('renders safe markdown source links without exposing the source syntax', () => {
    expect(renderPlainTextLinks('Fonte: [SECO](https://www.seco.admin.ch). Consulta anche [il job board](/cerca-lavoro-ticino).'))
      .toBe('Fonte: <a href="https://www.seco.admin.ch" rel="noopener noreferrer">SECO</a>. Consulta anche <a href="/cerca-lavoro-ticino" rel="noopener noreferrer">il job board</a>.');
  });
  it('keeps unsafe markdown destinations inert', () => {
    expect(renderPlainTextLinks('[Evil](javascript:alert)')).toBe('Evil');
  });
});
