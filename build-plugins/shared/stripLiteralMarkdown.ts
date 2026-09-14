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

export function stripLiteralMarkdown(value: string): string {
  if (!value) return value;
  let t = String(value);
  // 1. Unwrap balanced bold, keeping the inner text (`**Requisitos:**` → `Requisitos:`).
  t = t.replace(/\*\*([^*\n]+?)\*\*/g, '$1');
  // 2. Nuke any remaining run of 2+ asterisks anywhere. Harvested GSC / AI-
  //    translated terms carry orphaned `**` mid-string (e.g. `Requisitos:**
  //    svizzera`) that the paired unwrap above can't reach; two such tokens on
  //    one page pair up under the audit's global `\*\*…\*\*` scan and re-trip
  //    the gate, so they must be removed wherever they sit.
  t = t.replace(/\*{2,}/g, '');
  // 3. Separator runs (3+ of `_`, `=`, `~`) — drop.
  t = t.replace(/[_=~]{3,}/g, ' ');
  // 4. Orphan leading/trailing single `*` survivors.
  t = t.replace(/^\s*\*+\s*/, '').replace(/\s*\*+\s*$/, '');
  // 5. Collapse any double-spaces created by the strips.
  t = t.replace(/[ \t]{2,}/g, ' ');
  return t.trim();
}

/**
 * Remove a markdown bold wrapper only when it surrounds the whole value.
 *
 * This narrower variant is for job titles copied into list links. A broad
 * `**` scrub would damage legitimate employer wording such as
 * `***delicatessa`; a complete wrapper is the only shape that can be safely
 * classified as formatting without interpreting the title's vocabulary.
 */
export function stripWholeMarkdownBoldWrapper(value: string): string {
  if (!value) return value;
  const source = String(value);
  const trimmed = source.trim();
  if (trimmed.length < 5 || !trimmed.startsWith('**') || !trimmed.endsWith('**')) return source;
  const inner = trimmed.slice(2, -2).trim();
  if (!inner || inner.includes('*')) return source;
  return inner;
}

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

function stripJobTitleMarkdown(value: string): string {
  const protectedRuns: string[] = [];
  const protectedValue = String(value).replace(/\*{3,}/g, (run) => {
    const index = protectedRuns.push(run) - 1;
    return `\uE000${index}\uE001`;
  });
  return stripLiteralMarkdown(protectedValue).replace(
    /\uE000(\d+)\uE001/g,
    (_match, index: string) => protectedRuns[Number(index)] || '',
  );
}
