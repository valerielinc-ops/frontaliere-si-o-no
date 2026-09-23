/**
 * stripLiteralMarkdown — single source of truth for scrubbing literal markdown
 * out of crawler-/AI-sourced strings before they reach indexed `<main>` surfaces
 * (job & related-job titles, related-search cluster H1 / hub links / intro prose
 * / JSON-LD). HTML-escaping (`esc`/`escHtml`) does NOT touch `**` or `_`/`=`/`~`
 * runs, so without this the literal tokens survive into the DOM and trip the
 * 0-tolerance `audit-no-literal-markdown` gate.
 *
 * This file exists because the same logic had drifted into three near-identical
 * copies (jobsSeoPagesPlugin.stripLiteralMarkdownFromTitle, jobCardHtml, and
 * relatedSearchClustersPlugin) — and a fix applied to one copy (the orphan-`**`
 * nuke) was missing from another that renders onto the SAME scanned pages,
 * re-tripping the gate. The narrative-title extractor is a pure helper shared
 * with the Node assembler; all display scrubbing remains idempotent and safe
 * to call from any build plugin.
 */
import { extractNarrativeJobTitle } from '../../scripts/lib/job-title-normalization.mjs';
import { stripJobTitleMarkdown, stripLiteralMarkdown, stripWholeMarkdownBoldWrapper } from './literalMarkdown';

export { stripLiteralMarkdown, stripWholeMarkdownBoldWrapper } from './literalMarkdown';

/**
 * Clean a job title for a visible HTML surface.
 *
 * The normal whole-value wrapper rule is retained, while a known AI response
 * such as `I need to ... **Translated title** ...` is reduced to its actual
 * title. Triple-star employer brands (for example `***delicatessa`) are
 * protected while the generic markdown scrub removes any other literal
 * markers.
 */
export function sanitizeJobTitleForDisplay(value: string): string {
  if (!value) return value;
  const source = String(value);
  const whole = stripWholeMarkdownBoldWrapper(source);
  const narrative = extractNarrativeJobTitle(source);
  const candidate = narrative || (whole !== source ? whole : source);
  return stripJobTitleMarkdown(candidate);
}
