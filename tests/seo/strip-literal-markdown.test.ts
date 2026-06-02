import { describe, expect, it } from 'vitest';
import { stripLiteralMarkdown } from '../../build-plugins/shared/stripLiteralMarkdown';

// Pins the funnel-critical contract of the single shared helper that scrubs
// literal markdown out of crawler-/AI-sourced strings before they reach indexed
// `<main>` (job & related-job titles, related-search cluster H1 / hub links /
// intro prose / JSON-LD). The 0-tolerance `audit-no-literal-markdown` gate
// scans those surfaces with a GLOBAL `\*\*[^*\n]{1,200}\*\*` regex, so any `**`
// survivor — including an orphan mid-string `**` that pairs up with a second
// occurrence on the same page — re-trips the gate.
const LITERAL_BOLD_RE = /\*\*[^*\n]{1,200}\*\*/g;

describe('stripLiteralMarkdown', () => {
  it('unwraps balanced bold, keeping the inner text', () => {
    expect(stripLiteralMarkdown('**Requisitos:**')).toBe('Requisitos:');
    expect(stripLiteralMarkdown('**A** e **B**')).toBe('A e B');
  });

  it('nukes orphan mid-string ** that the paired unwrap cannot reach', () => {
    // Real harvested GSC term shape: opening `**` lost during slug processing,
    // trailing `**` survives mid-string before a non-city qualifier.
    expect(stripLiteralMarkdown('Requisitos:** svizzera')).toBe('Requisitos: svizzera');
    expect(stripLiteralMarkdown('Requisitos:**')).toBe('Requisitos:');
  });

  it('leaves no ** survivor that re-pairs across repeated occurrences on a page', () => {
    const term = stripLiteralMarkdown('Requisitos:** svizzera');
    // The audit sees the same keyword multiple times per page (H1 + intro + links).
    const page = `<h1>${term}</h1><p>${term}</p><a>${term}</a>`;
    expect(page).not.toMatch(LITERAL_BOLD_RE);
    expect(page).not.toContain('**');
  });

  it('drops separator runs and is idempotent', () => {
    expect(stripLiteralMarkdown('Titolo ===== coda')).toBe('Titolo coda');
    const once = stripLiteralMarkdown('**X**:** y');
    expect(stripLiteralMarkdown(once)).toBe(once);
    expect(once).not.toContain('**');
  });

  it('passes through clean strings and empty input untouched', () => {
    expect(stripLiteralMarkdown('Offerte di Lavoro in Ticino')).toBe('Offerte di Lavoro in Ticino');
    expect(stripLiteralMarkdown('')).toBe('');
  });
});
