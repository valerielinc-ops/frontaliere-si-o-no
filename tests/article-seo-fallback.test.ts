import { describe, expect, it } from 'vitest';

import { buildArticleSeoSections, cleanupArticleBodySections } from '@/build-plugins/articleSeoFallback';

const wordCount = (value: string) => value.split(/\s+/).filter(Boolean).length;

const keyed = (texts: Array<string | undefined>) =>
  texts.map((text, i) => ({ key: `body${i + 1}`, text }));

describe('article SEO fallback builder', () => {
  it('builds rich Italian fallback sections with enough semantic depth', () => {
    const sections = buildArticleSeoSections(
      'it',
      'Telelavoro frontalieri: cosa cambia nel 2026',
      'Accordo aggiornato tra Italia e Svizzera sul telelavoro dei frontalieri.',
      'telelavoro frontalieri, accordo italia svizzera, imposta alla fonte, lavoro ticino',
    );

    expect(sections).toHaveLength(5);
    expect(sections.every((section) => section.paragraphs.length >= 1)).toBe(true);

    const allText = sections.flatMap((section) => [section.heading, ...section.paragraphs]).join(' ');
    expect(wordCount(allText)).toBeGreaterThan(320);
    expect(allText).toContain('telelavoro');
    expect(allText).toContain('imposta');
  });

  // Issue #5560: STOP_WORDS used to hardcode the literal '2026' instead of a
  // year-shaped test, so any other four-digit year (past or future) could win
  // a topicTerms slot and displace a genuinely distinctive term. The year
  // tokens live only in `keywords` here (never echoed verbatim like title/desc
  // are), so a year surfacing in the output can only come from topicTerms —
  // this fails today for any year outside the hand-written '2026' literal.
  it('never lets a bare year win a topicTerms slot, for any year', () => {
    const sections = buildArticleSeoSections(
      'it',
      'Novita sul regime frontalieri',
      'Guida pratica aggiornata per chi lavora in Ticino.',
      'regime frontalieri, novita fiscali, 1998, 2031, scadenza importante, obbligo dichiarativo',
    );

    const allText = sections.flatMap((section) => [section.heading, ...section.paragraphs]).join(' ');
    expect(allText).not.toMatch(/\b1998\b/);
    expect(allText).not.toMatch(/\b2031\b/);
    expect(allText).toContain('novita');
    expect(allText).toContain('regime');
  });

  it('renders markdown-like article body sections into semantic HTML', () => {
    const sections = cleanupArticleBodySections(keyed([
      '## Titolo\n**Testo** con [link](https://example.com) e `code`',
      undefined,
      '- punto uno\n- punto due',
    ]));

    expect(sections.map((s) => s.html)).toEqual([
      '<h3>Titolo</h3><p><strong>Testo</strong> con <a href="https://example.com">link</a> e <code>code</code></p>',
      '<ul><li>punto uno</li><li>punto due</li></ul>',
    ]);
  });

  it('escapes HTML-special characters in body markdown before adding markup', () => {
    const sections = cleanupArticleBodySections(keyed(['Tom & Jerry <script>alert(1)</script>']));

    expect(sections.map((s) => s.html)).toEqual(['<p>Tom &amp; Jerry &lt;script&gt;alert(1)&lt;/script&gt;</p>']);
  });

  it('renders single-# headings (used by some articles) as h3, not literal text', () => {
    const sections = cleanupArticleBodySections(keyed(['# Titolo principale\nTesto del paragrafo.']));

    expect(sections.map((s) => s.html)).toEqual(['<h3>Titolo principale</h3><p>Testo del paragrafo.</p>']);
  });

  // Issue #5415: the daily brief ships two pipe tables per edition. Before this,
  // the engine had no table branch, so their rows landed in paragraphBuf and were
  // joined with spaces into one <p> of raw pipes — verified live on 2026-08-08
  // across all four locales (0 <table>, pipes visible).
  describe('pipe tables', () => {
    const table = [
      '| Valico | Attesa |',
      '|---|---|',
      '| Chiasso-Brogeda | 12 min |',
      '| Ponte Tresa | 0 min |',
    ].join('\n');

    it('renders a pipe table as a real table, not a paragraph of pipes', () => {
      const [section] = cleanupArticleBodySections(keyed([table]));

      expect(section.html).toBe(
        '<table><thead><tr><th>Valico</th><th>Attesa</th></tr></thead>'
        + '<tbody><tr><td>Chiasso-Brogeda</td><td>12 min</td></tr>'
        + '<tr><td>Ponte Tresa</td><td>0 min</td></tr></tbody></table>',
      );
      expect(section.html).not.toContain('|');
    });

    it('renders inline markup inside cells', () => {
      const [section] = cleanupArticleBodySections(keyed([
        '| Voce | Valore |\n|---|---|\n| **Cambio** | [1.07](/cambio-chf-eur/) |',
      ]));

      expect(section.html).toContain('<td><strong>Cambio</strong></td>');
      expect(section.html).toContain('<td><a href="/cambio-chf-eur/">1.07</a></td>');
    });

    it('keeps surrounding prose in its own blocks', () => {
      const [section] = cleanupArticleBodySections(keyed([`Prima.\n\n${table}\n\nDopo.`]));

      expect(section.html).toBe(`<p>Prima.</p>${cleanupArticleBodySections(keyed([table]))[0].html}<p>Dopo.</p>`);
    });

    // The engine renders 3.100+ articles that never meant to draw a table. A `|`
    // in ordinary prose must stay ordinary prose — the separator row is what
    // makes a table a table.
    it('leaves prose containing a pipe alone', () => {
      const [section] = cleanupArticleBodySections(keyed([
        'Il modulo va compilato | firmato | consegnato entro il 30 giugno.',
      ]));

      expect(section.html).toBe('<p>Il modulo va compilato | firmato | consegnato entro il 30 giugno.</p>');
    });

    it('leaves pipe-prefixed lines with no separator row alone', () => {
      const [section] = cleanupArticleBodySections(keyed(['| a | b |\n| c | d |']));

      expect(section.html).toBe('<p>| a | b | | c | d |</p>');
    });

    it('escapes cell content before adding markup', () => {
      const [section] = cleanupArticleBodySections(keyed(['| A |\n|---|\n| <script>x</script> & co |']));

      expect(section.html).toContain('<td>&lt;script&gt;x&lt;/script&gt; &amp; co</td>');
    });
  });

  it('preserves the source key when an intermediate body section is empty, so heading pairing never shifts (#3205)', () => {
    const sections = cleanupArticleBodySections(keyed([
      'Testo del primo blocco.',
      undefined, // body2 empty/dropped — must not shift body3's html onto body2's slot
      'Testo del terzo blocco.',
    ]));

    expect(sections).toHaveLength(2);
    expect(sections[0].key).toBe('body1');
    expect(sections[0].html).toContain('primo blocco');
    expect(sections[1].key).toBe('body3');
    expect(sections[1].html).toContain('terzo blocco');

    // Mirrors the caller-side pairing in staticPagesPlugin.ts / ogPagesPlugin.ts:
    // heading must be looked up by stable key, not by the post-filter array index
    // (which would wrongly pair body3's html with body2's heading).
    const headingByKey: Record<string, string> = {
      body1: 'Contesto',
      body2: 'Dettagli operativi',
      body3: 'Punti chiave',
    };
    const paired = sections.map((s) => ({ heading: headingByKey[s.key], html: s.html }));

    expect(paired[0].heading).toBe('Contesto');
    expect(paired[1].heading).toBe('Punti chiave');
  });
});
