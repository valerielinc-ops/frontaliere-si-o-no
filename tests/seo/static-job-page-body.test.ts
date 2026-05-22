/**
 * Regression test for the no-canonical body fallback in
 * `build-plugins/jobsSeoPagesPlugin.ts`.
 *
 * When a job has NOT yet been AI-structured (translate-pending-jobs.yml
 * hasn't filled `_canonical`), the static job-detail page must still:
 *   1. Render the FULL description (no 3-paragraph truncation that drops
 *      Requisiti / Sede / contract footer).
 *   2. NOT print the same paragraphs twice (Panoramica + timeline fallback).
 *   3. NOT leak markdown — `### Chi siamo?` must become `<h3>Chi siamo?</h3>`,
 *      `**bold**` must become `<strong>`, `•` bullets must become `<ul><li>`.
 *
 * Observed in production at
 * /cerca-lavoro-ticino/senior-system-ingegnere-relewant-chiasso/ where the
 * source `data/jobs/by-crawler/relewant.json` description is 2402 chars but
 * the emitted static body printed ~1100 chars TWICE with literal `### ` text.
 *
 * The plugin emitter is too coupled to import in isolation, so this test
 * exercises the seam where the bug lives: paragraph splitting + the
 * `summaryParagraphs.map(jobDescriptionTextToHtml).join('')` pipeline.
 * If the helpers are reorganized, update the test to follow them.
 */
import { describe, expect, it } from 'vitest';
import { jobDescriptionTextToHtml } from '../../build-plugins/shared/jobDescription/toHtml';

// Mirror of `splitIntoParagraphs` from jobsSeoPagesPlugin.ts (line ~1286).
// Kept inline here so the test stays self-contained and explicitly pins
// the contract: blank-line split with a 40-char floor and a sentence-split
// fallback for prose without paragraph breaks.
function splitIntoParagraphs(s: string): string[] {
  const normalized = String(s || '').replace(/[_=~]{6,}/g, '\n\n');
  const viaBreaks = normalized
    .replace(/\r/g, '\n')
    .split(/\n{2,}/)
    .map((p) => p.trim())
    .filter((p) => p.length > 40);
  if (viaBreaks.length >= 2) return viaBreaks;
  return normalized
    .replace(/\s+/g, ' ')
    .trim()
    .split(/(?<=[.!?])\s+/)
    .map((p) => p.trim())
    .filter((p) => p.length > 40);
}

// Real description from the Relewant senior-system-engineer-chiasso job,
// trimmed to a representative slice. Contains:
//   - ### Heading (must become <h3>)
//   - **bold** (must become <strong>)
//   - • bullets (must become <ul><li>)
//   - Multiple paragraphs (must NOT be truncated to 3 in the no-canonical path)
const RELEWANT_FIXTURE = `### Chi siamo?
Relewant è una società di consulenza specializzata in ambito informatico con sede a Chiasso, in Svizzera.
Con noi, potrai mettere a frutto il tuo potenziale in un team coeso e vincente.

### La nostra Mission
Il nostro successo nasce dalle qualità delle persone che fanno parte del gruppo.
Competenza, professionalità e voglia di stare al passo in un mercato tecnologico in continua evoluzione ci contraddistinguono.

### Chi stiamo cercando?
Siamo alla ricerca di un Senior System Engineer altamente qualificato per il team IT ed Infrastrutture.

#### Requisiti
• Esperienza consolidata in ambienti Microsoft Azure e Modern work.
• Esperienza con architetture hybrid cloud e con scenari di migrazione verso il cloud.
• Conoscenza operativa preferenziale dei sistemi di iperconvergenza come Nutanix.
• Confidenza con piattaforme VDI in ambienti enterprise.

**Esperienza richiesta:** 4-5 anni
**Settore:** Tecnologia
**Sede:** Chiasso, TI, Svizzera
**Tipo:** Tempo indeterminato`;

describe('static job page body — no-canonical fallback', () => {
  // Replicates the post-fix pipeline:
  //   const hasCanonical = canonicalSummary.length > 0;            // false here
  //   bodyParagraphs = descriptionParagraphs.slice(0, 10);         // no 3-cap
  //   summaryParagraphs = bodyParagraphs;
  //   summaryHtml = summaryParagraphs.map(jobDescriptionTextToHtml).join('')
  function renderBody(description: string): string {
    const descriptionParagraphs = splitIntoParagraphs(description).slice(0, 10);
    const bodyParagraphs = descriptionParagraphs
      .slice(0, 10)
      .filter((p) => p && p.length > 25)
      .slice(0, 10);
    const summaryParagraphs = bodyParagraphs;
    return summaryParagraphs.map((p) => jobDescriptionTextToHtml(p)).join('');
  }

  it('does NOT truncate the description to 3 paragraphs (Bug 1)', () => {
    const html = renderBody(RELEWANT_FIXTURE);
    // Nutanix and VDI live in the Requisiti block — paragraph 4 of 5.
    // The pre-fix `.slice(0, 3)` dropped them entirely.
    expect(html).toContain('Nutanix');
    expect(html).toContain('VDI');
    // Sede and contract type live in the trailing **bold** footer block.
    expect(html).toContain('Chiasso');
    expect(html).toContain('Tempo indeterminato');
  });

  it('renders markdown headings as <h3>, not literal "### text" (Bug 3)', () => {
    const html = renderBody(RELEWANT_FIXTURE);
    // Literal markdown must NOT appear in the body.
    expect(html).not.toContain('### Chi siamo');
    expect(html).not.toContain('### La nostra Mission');
    expect(html).not.toContain('### Chi stiamo cercando');
    // Headings should be promoted to real <h3>/<h4> tags.
    expect(html).toMatch(/<h[34]>\s*Chi siamo\??/);
    expect(html).toMatch(/<h[34]>\s*La nostra Mission/);
  });

  it('renders **bold** as <strong>, not literal asterisks (Bug 3)', () => {
    const html = renderBody(RELEWANT_FIXTURE);
    expect(html).not.toMatch(/\*\*Esperienza richiesta/);
    expect(html).not.toMatch(/\*\*Sede/);
    expect(html).toMatch(/<strong>[^<]*Esperienza richiesta[^<]*<\/strong>/);
    expect(html).toMatch(/<strong>[^<]*Sede[^<]*<\/strong>/);
  });

  it('renders • bullets as a <ul><li> list (Bug 3)', () => {
    const html = renderBody(RELEWANT_FIXTURE);
    expect(html).toContain('<ul>');
    expect(html).toContain('<li>');
    // The bullet character itself should NOT survive as visible text.
    expect(html).not.toMatch(/<li>\s*•/);
  });

  it('does not print the body content twice (Bug 2 sanity check)', () => {
    // The fix removes the timeline-step fallback when there is no canonical
    // data, so the body is rendered exactly once via summaryHtml.
    // This test asserts the post-fix summaryHtml itself does not duplicate
    // — the "Chi siamo?" heading appears exactly once.
    const html = renderBody(RELEWANT_FIXTURE);
    const matches = html.match(/Chi siamo/g) || [];
    expect(matches.length).toBe(1);
  });
});
