import { describe, expect, it } from 'vitest';
import {
  buildJobCopyAttribution,
  shouldAttributeCopy,
  COPY_ATTRIBUTION_MIN_CHARS,
} from '../services/jobCopyAttribution';

const LEAD = 'Annuncio completo e candidatura su Frontaliere Ticino:';
const URL = 'https://frontaliereticino.ch/cerca-lavoro-ticino/radiologo-ospedale-x/';

describe('shouldAttributeCopy', () => {
  it('skips selections shorter than the minimum', () => {
    expect(shouldAttributeCopy('short')).toBe(false);
    expect(shouldAttributeCopy('   ')).toBe(false);
    expect(shouldAttributeCopy('a'.repeat(COPY_ATTRIBUTION_MIN_CHARS - 1))).toBe(false);
  });

  it('attributes selections at or above the minimum length', () => {
    expect(shouldAttributeCopy('a'.repeat(COPY_ATTRIBUTION_MIN_CHARS))).toBe(true);
    expect(
      shouldAttributeCopy('Cerchiamo un radiologo per il nostro ospedale a Lugano'),
    ).toBe(true);
  });

  it('trims before measuring', () => {
    expect(shouldAttributeCopy(`   ${'x'.repeat(COPY_ATTRIBUTION_MIN_CHARS)}   `)).toBe(true);
  });

  it('attributes a short selection that IS the job title', () => {
    // "Cuoco" is below the floor but is exactly what users paste into search.
    expect(shouldAttributeCopy('Cuoco')).toBe(false);
    expect(shouldAttributeCopy('Cuoco', 'Cuoco')).toBe(true);
  });

  it('matches the title case- and whitespace-insensitively', () => {
    expect(shouldAttributeCopy('  cUoCo   80-100%  ', 'Cuoco 80-100%')).toBe(true);
  });

  it('does not attribute a short non-title selection even with a title given', () => {
    expect(shouldAttributeCopy('CHF 90k', 'Radiologo/a')).toBe(false);
  });
});

describe('buildJobCopyAttribution', () => {
  it('appends lead, title line and canonical URL to plain text', () => {
    const { text } = buildJobCopyAttribution({
      selectionText: 'Cerchiamo un radiologo esperto.',
      jobTitle: 'Radiologo/a',
      company: 'Ospedale X',
      url: URL,
      lead: LEAD,
    });
    expect(text).toBe(
      `Cerchiamo un radiologo esperto.\n\n${LEAD}\nRadiologo/a – Ospedale X\n${URL}`,
    );
  });

  it('omits the company separator when no company is given', () => {
    const { text, html } = buildJobCopyAttribution({
      selectionText: 'x'.repeat(30),
      jobTitle: 'Radiologo/a',
      url: URL,
      lead: LEAD,
    });
    expect(text).toContain('\nRadiologo/a\n');
    expect(text).not.toContain('–');
    expect(html).toContain('>Radiologo/a</a>');
  });

  it('emits a real backlink anchor in the HTML payload', () => {
    const { html } = buildJobCopyAttribution({
      selectionText: 'Cerchiamo un radiologo esperto.',
      jobTitle: 'Radiologo/a',
      company: 'Ospedale X',
      url: URL,
      lead: LEAD,
    });
    expect(html).toContain(`<a href="${URL}">Radiologo/a – Ospedale X</a>`);
    expect(html).toContain(LEAD);
  });

  it('prefers the rich selection HTML over the plain text when present', () => {
    const { html } = buildJobCopyAttribution({
      selectionText: 'plain fallback text here',
      selectionHtml: '<p>rich <strong>selection</strong></p>',
      jobTitle: 'Radiologo/a',
      url: URL,
      lead: LEAD,
    });
    expect(html.startsWith('<p>rich <strong>selection</strong></p>')).toBe(true);
    expect(html).not.toContain('plain fallback text here');
  });

  it('escapes HTML-significant characters in injected fields', () => {
    const { html } = buildJobCopyAttribution({
      selectionText: 'safe selection text long enough',
      jobTitle: 'Dev & "Ops" <lead>',
      company: 'A&B',
      url: 'https://frontaliereticino.ch/q/?a=1&b=2',
      lead: LEAD,
    });
    expect(html).toContain('Dev &amp; &quot;Ops&quot; &lt;lead&gt; – A&amp;B');
    expect(html).toContain('href="https://frontaliereticino.ch/q/?a=1&amp;b=2"');
    expect(html).not.toContain('<lead>');
  });

  it('falls back to escaped plain text when no selection HTML is provided', () => {
    const { html } = buildJobCopyAttribution({
      selectionText: 'a <b> & c selection long enough',
      jobTitle: 'Radiologo/a',
      url: URL,
      lead: LEAD,
    });
    expect(html.startsWith('a &lt;b&gt; &amp; c selection long enough<br><br>')).toBe(true);
  });
});
