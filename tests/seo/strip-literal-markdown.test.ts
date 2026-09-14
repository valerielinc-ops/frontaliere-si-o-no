import { describe, expect, it } from 'vitest';
import { sanitizeJobTitleForDisplay, stripLiteralMarkdown, stripWholeMarkdownBoldWrapper } from '../../build-plugins/shared/stripLiteralMarkdown';

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

describe('stripWholeMarkdownBoldWrapper', () => {
  it('removes only a wrapper around the complete value', () => {
    expect(stripWholeMarkdownBoldWrapper('**Assistant Store Manager (m/w/d)**')).toBe('Assistant Store Manager (m/w/d)');
    expect(stripWholeMarkdownBoldWrapper('** Breaking it down: - **')).toBe('Breaking it down: -');
  });

  it('preserves employer wording that starts with a triple-star brand marker', () => {
    expect(stripWholeMarkdownBoldWrapper('Verkaufsberater:in ***delicatessa 40-60% (w/m/d)')).toBe(
      'Verkaufsberater:in ***delicatessa 40-60% (w/m/d)',
    );
  });
});

describe('sanitizeJobTitleForDisplay', () => {
  it('extracts the translated title from an AI explanation', () => {
    const narrative = 'I need to see the current job data to understand the context and identify which job title needs translation to Italian. Let me check the job data files: Looking at the modified files, I can see several job crawler files have been updated. Let me examine one of them to find the job title that needs translation: The title you are asking about appears to be a German job title that needs to be translated to Italian. Based on the context of retail/shopping experience design, here is the complete Italian translation: **Specialista nel commercio al dettaglio EFZ "Progettazione di esperienze di acquisto"** However, if you would like me to locate and fix this in the actual job data file, and so on.';
    expect(sanitizeJobTitleForDisplay(narrative)).toBe('Specialista nel commercio al dettaglio EFZ "Progettazione di esperienze di acquisto"');
  });

  it('preserves triple-star employer wording while scrubbing other markdown', () => {
    expect(sanitizeJobTitleForDisplay('Verkaufsberater:in ***delicatessa 40-60% (w/m/d)')).toBe(
      'Verkaufsberater:in ***delicatessa 40-60% (w/m/d)',
    );
  });
});
