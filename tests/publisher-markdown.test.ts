import { describe, it, expect } from 'vitest';
import { renderPublisherMarkdown, stripPublisherMarkdown } from '../services/publisherMarkdown';

describe('renderPublisherMarkdown', () => {
  it('renders headings, bullets, bold and paragraphs', () => {
    const html = renderPublisherMarkdown(
      '## Requisiti\n- Esperienza **LLM**\n- Inglese tecnico\n\nTesto introduttivo.\n### Nota\nAltro testo.',
    );
    expect(html).toContain('<h2');
    expect(html).toContain('Requisiti</h2>');
    expect(html).toContain('<ul');
    expect(html).toMatch(/<li[^>]*>Esperienza <strong>LLM<\/strong><\/li>/);
    expect(html).toContain('<h3');
    expect(html).toContain('Nota</h3>');
    expect(html).toMatch(/<p[^>]*>Testo introduttivo\.<\/p>/);
  });

  it('escapes HTML before transforming (injection-safe by construction)', () => {
    const html = renderPublisherMarkdown('## <script>alert(1)</script>\n- <img src=x onerror=alert(1)>\n**<b>x</b>**');
    expect(html).not.toContain('<script');
    expect(html).not.toContain('<img');
    expect(html).not.toContain('<b>');
    expect(html).toContain('&lt;script&gt;');
  });

  it('returns empty string for empty input', () => {
    expect(renderPublisherMarkdown('')).toBe('');
    expect(renderPublisherMarkdown('   \n\n  ')).toBe('');
  });

  it('keeps single newlines inside a paragraph as <br>', () => {
    const html = renderPublisherMarkdown('riga uno\nriga due');
    expect(html).toMatch(/riga uno<br>riga due/);
  });

  it('treats * and • bullets like -', () => {
    const html = renderPublisherMarkdown('* uno\n• due');
    expect(html).toMatch(/<li[^>]*>uno<\/li><li[^>]*>due<\/li>/);
  });
});

describe('stripPublisherMarkdown', () => {
  it('removes markdown syntax but keeps the text', () => {
    const plain = stripPublisherMarkdown('## Requisiti\n- Esperienza **LLM**\n\nTesto.');
    expect(plain).toBe('Requisiti\n- Esperienza LLM\n\nTesto.');
  });

  it('is a no-op on plain text', () => {
    const text = 'Cerchiamo una persona motivata.\n\nSeconda riga.';
    expect(stripPublisherMarkdown(text)).toBe(text);
  });
});
