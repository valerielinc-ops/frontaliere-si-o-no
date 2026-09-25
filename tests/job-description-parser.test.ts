import { describe, it, expect } from 'vitest';
import {
  parseJobDescription,
  parseInline,
  blocksToPlainText,
  type Block,
} from '@/build-plugins/shared/jobDescription/parser';
import {
  blocksToHtml,
  jobDescriptionTextToHtml,
} from '@/build-plugins/shared/jobDescription/toHtml';

const html = (raw: string): string => blocksToHtml(parseJobDescription(raw));

describe('parseJobDescription — markdown bold/em handling (S1)', () => {
  it('converts well-formed **bold** to <strong>', () => {
    expect(html('Hello **world**.')).toBe('<p>Hello <strong>world</strong>.</p>');
  });

  it('converts well-formed *em* to <em>', () => {
    expect(html('Hello *world*.')).toBe('<p>Hello <em>world</em>.</p>');
  });

  it('drops empty bolds like ** **, **  **, **:**', () => {
    expect(html('Foo ** ** bar **  ** baz ** : ** qux')).toBe('<p>Foo bar baz qux</p>');
  });

  it('strips all ** markers when count is odd (unbalanced)', () => {
    expect(html('Hello **world this is unbalanced')).toBe('<p>Hello world this is unbalanced</p>');
  });

  it('never leaks literal ** into the rendered HTML — casale "Lavora con noi" sample', () => {
    const raw =
      "**Se è così - **entrate a far parte di un'organizzazione dinamica che offre percorsi di carriera diversificati e opportunità di crescita eccezionali** **\n• Offriamo un'ampia gamma di opportunità per sviluppare le vostre competenze** e **migliorare le vostre capacità personali e professionali**. Fai parte di qualcosa di significativo. ______";
    const out = html(raw);
    expect(out).not.toMatch(/\*\*/);
    expect(out).not.toMatch(/_{3,}/);
  });
});

describe('parseJobDescription — block structure', () => {
  it('promotes recognized section labels to <h2> (S5)', () => {
    expect(html('Main duties and Responsibilities:')).toBe('<h2>Main duties and Responsibilities</h2>');
    expect(html('Profilo:')).toBe('<h2>Profilo</h2>');
    expect(html('Wir bieten')).toBe('<h2>Wir bieten</h2>');
    expect(html('We offer')).toBe('<h2>We offer</h2>');
  });

  it('parses bullet lists with -, •, *', () => {
    const out = html('- one\n- two\n• three\n* four');
    expect(out).toBe('<ul><li>one</li><li>two</li><li>three</li><li>four</li></ul>');
  });

  it('parses numbered lists', () => {
    const out = html('1. first\n2. second\n3) third');
    expect(out).toBe('<ol><li>first</li><li>second</li><li>third</li></ol>');
  });

  it('does NOT promote a long narrative paragraph (>120c) to a heading (S2)', () => {
    const raw =
      'This is a long narrative paragraph that goes on for more than one hundred and fifty characters explaining the company and its values and certainly is not a section heading at all because it has a regular flow of ideas.';
    expect(html(raw)).toMatch(/^<p>/);
    expect(html(raw)).not.toMatch(/<h[23]>/);
  });

  it('handles a real well-formed Casale "Expediter" sample', () => {
    const raw =
      'Casale SA is a leading firm.\n\n**Main duties and Responsibilities:**\n\n- Act as the main interface\n- Ensure material delivery\n\n**Education**\n\nDegree in Engineering';
    expect(html(raw)).toBe(
      '<p>Casale SA is a leading firm.</p>' +
        '<h2>Main duties and Responsibilities</h2>' +
        '<ul><li>Act as the main interface</li><li>Ensure material delivery</li></ul>' +
        '<h2>Education</h2>' +
        '<p>Degree in Engineering</p>',
    );
  });
});

describe('parseJobDescription — noise removal', () => {
  it('strips separator-only lines like ______, ===, ---', () => {
    expect(html('Para 1\n\n______\n\nPara 2\n\n----\n\nPara 3')).toBe(
      '<p>Para 1</p><p>Para 2</p><p>Para 3</p>',
    );
  });

  it('strips trailing inline separators on a line (S8)', () => {
    expect(html('Be part of something. ______')).toBe('<p>Be part of something.</p>');
    expect(html('Some text ----')).toBe('<p>Some text</p>');
  });

  it('strips mid-line separator runs (HFR-style ref + flattened paragraph break)', () => {
    // Real HFR (Hôpital Fribourgeois) pattern: ref number + 64 underscores +
    // body text, all on one line because AI translation flattened the source
    // <p>/<br> structure. Audit `no-literal-markdown` is 0-tolerance and
    // failed on 3 such pages on 2026-05-21.
    const raw =
      'Ref.: HFR-MTS-255203 ________________________________________________________________ Per completare il suo team.';
    expect(html(raw)).toBe(
      '<p>Ref.: HFR-MTS-255203</p><p>Per completare il suo team.</p>',
    );
    // Same pattern with `=` and `~` separators
    expect(html('Foo bar ==== Baz qux.')).toBe('<p>Foo bar</p><p>Baz qux.</p>');
    expect(html('Foo bar ~~~~ Baz qux.')).toBe('<p>Foo bar</p><p>Baz qux.</p>');
  });

  it('deduplicates consecutive identical paragraphs (S4: Panoramica == Descrizione)', () => {
    const raw = 'Same paragraph here.\n\nSame paragraph here.\n\nDifferent one.';
    expect(html(raw)).toBe('<p>Same paragraph here.</p><p>Different one.</p>');
  });

  it('dedup is whitespace/punctuation insensitive', () => {
    const raw = 'Hello world!\n\nhello,  WORLD.\n\nthird.';
    expect(html(raw)).toBe('<p>Hello world!</p><p>third.</p>');
  });

  it('decodes &nbsp; and named dashes but preserves &amp;/&lt; for escape pass', () => {
    expect(html('Hello&nbsp;world &mdash; foo & bar')).toBe('<p>Hello world — foo &amp; bar</p>');
  });
});

describe('parseJobDescription — HTML safety', () => {
  it('escapes HTML special chars in inline text', () => {
    expect(html('<script>alert(1)</script>')).toBe('<p>&lt;script&gt;alert(1)&lt;/script&gt;</p>');
  });

  it('escapes inside <strong> too', () => {
    expect(html('**<b>raw</b>**')).toBe('<p><strong>&lt;b&gt;raw&lt;/b&gt;</strong></p>');
  });

  it('passes through input that already contains structural HTML untouched', () => {
    const raw = '<p>Pre-rendered</p><ul><li>x</li></ul>';
    expect(jobDescriptionTextToHtml(raw)).toBe(raw);
  });
});

describe('parseInline — defensive', () => {
  it('returns [] on empty input', () => {
    expect(parseInline('')).toEqual([]);
  });
  it('returns single text token on plain string', () => {
    expect(parseInline('hello')).toEqual([{ kind: 'text', value: 'hello' }]);
  });
});

describe('parser — AST stability', () => {
  it('blocksToPlainText round-trips the structure', () => {
    const raw = '**Education**\n\n- A\n- B\n\nDegree in X';
    const blocks: Block[] = parseJobDescription(raw);
    const plain = blocksToPlainText(blocks);
    expect(plain).toContain('Education');
    expect(plain).toContain('• A');
    expect(plain).toContain('• B');
    expect(plain).toContain('Degree in X');
  });
});
