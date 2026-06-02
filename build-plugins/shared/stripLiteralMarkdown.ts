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
 * re-tripping the gate. Pure, zero-import, idempotent → safe to share from any
 * build plugin without circular-import risk.
 */
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
