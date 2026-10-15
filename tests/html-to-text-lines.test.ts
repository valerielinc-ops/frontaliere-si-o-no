import { describe, it, expect } from 'vitest';
import { htmlToTextLines } from '../scripts/lib/html-to-text-lines.mjs';

describe('htmlToTextLines', () => {
  it('keeps headings/paragraphs on their own lines and list items as consecutive bullets', () => {
    const html = `
      <h2>Ihre Aufgaben</h2>
      <ul>
        <li>Pflege und Betreuung</li>
        <li>Dokumentation</li>
      </ul>
      <p>Wir freuen uns auf Ihre Bewerbung.</p>`;
    expect(htmlToTextLines(html)).toBe(
      'Ihre Aufgaben\n• Pflege und Betreuung\n• Dokumentation\nWir freuen uns auf Ihre Bewerbung.',
    );
  });

  it('treats source line wrapping inside a paragraph as a space, not a line break', () => {
    expect(htmlToTextLines('<p>Zur Ergänzung unseres\n      Teams suchen wir</p>')).toBe('Zur Ergänzung unseres Teams suchen wir');
  });

  it('turns <br> into a line break and decodes entities', () => {
    expect(htmlToTextLines('<p>Frau A.<br/>Leitung Pflege &amp; Hotellerie</p>')).toBe('Frau A.\nLeitung Pflege & Hotellerie');
  });

  it('drops scripts and styles', () => {
    expect(htmlToTextLines('<p>Text</p><script>var a = 1;</script><style>.x{color:red}</style>')).toBe('Text');
  });

  it('returns an empty string for empty input', () => {
    expect(htmlToTextLines('')).toBe('');
    expect(htmlToTextLines(undefined)).toBe('');
  });
});
