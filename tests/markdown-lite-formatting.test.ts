import { describe, it, expect } from 'vitest';
import { autoLinkKeywords, extractFaqPairs } from '@/components/community/BlogArticles';

describe('autoLinkKeywords — cross-line asterisk pairing (regression)', () => {
  // Reproduces the gaggiolo-traffico.ts corruption: a `**bold**` marker followed,
  // several lines later, by unrelated `* ` list-bullet markers used to make the
  // fmtSpans regex pair a stray asterisk across lines into a multi-paragraph
  // "italic" span — which then swallowed an unrelated keyword-link match and
  // wrapped ~2800 chars (5 list items + several paragraphs) into a single link.
  const navigators = new Proxy({}, { get: () => () => {} }) as Record<string, () => void>;

  it('does not let a bold marker pair with a distant list-bullet asterisk', () => {
    const text =
      "## Fatti chiave\n* **Cosa**: Traffico al valico\n* Quando: 2024\n* Dove: Gaggiolo\n* Chi: Frontalieri che lavorano in Svizzera\n* Importo: N/A\n\n" +
      'Molti lavoratori sono stati costretti a tornare a lavorare in Svizzera a causa della crisi.';

    const out = autoLinkKeywords(text, navigators);

    // The list block must survive untouched — no stray "[" from an inflated link span.
    expect(out).toContain('* **Cosa**: Traffico al valico');
    expect(out).toContain('* Importo: N/A');
    expect(out).not.toMatch(/\[\s*Importo/);

    // The real keyword match further down is still allowed to become a short link.
    expect(out).toMatch(/\[lavorare in Svizzera\]\(nav:job-board\)/);
  });

  it('cleanly links a keyword that is itself bolded, without leaking asterisks', () => {
    const text = 'Consulta il **calcolatore stipendio** per stimare il netto.';
    const out = autoLinkKeywords(text, navigators);
    expect(out).toBe('Consulta il [calcolatore stipendio](nav:calculator) per stimare il netto.');
  });
});

describe('extractFaqPairs / stripMarkdown — cross-line asterisk pairing (regression)', () => {
  it('does not swallow list items into a stripped span when extracting FAQ answers', () => {
    const body =
      '## Quando conviene?\n' +
      '* **Primo** punto\n' +
      '* Secondo punto\n' +
      '* Terzo punto\n\n' +
      'Risposta finale con dettagli aggiuntivi.';

    const pairs = extractFaqPairs(body);
    const pair = pairs.find(p => p.question.toLowerCase().includes('quando conviene'));
    expect(pair).toBeDefined();
    // All three bullet items must remain present in the extracted answer text.
    expect(pair!.answer).toContain('Primo punto');
    expect(pair!.answer).toContain('Secondo punto');
    expect(pair!.answer).toContain('Terzo punto');
  });
});
