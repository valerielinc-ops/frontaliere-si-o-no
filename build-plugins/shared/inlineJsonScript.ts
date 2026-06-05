// inlineJsonScript.ts
//
// Serialize a value for embedding inside an inline `<script>window.__X__=…`
// block. JSON alone is NOT safe there: a `<` (e.g. a "</script>" substring in
// arbitrary job prose / GSC queries / a title) closes the inline script early,
// breaking hydration and spilling spurious markup onto INDEXED pages.
//
// Escaping `<` → `<` is the canonical fix (the sequence is still valid
// JSON and parses identically). Centralised so every window.__*__ emit shares
// one definition instead of copy-pasting the regex (AGENTS.md §6 — a literal
// regex duplicated across ≥2 files becomes drift-prone).

/** JSON-encode `value` and neutralise `<` so it is safe inside an inline <script>. */
export function inlineScriptJson(value: unknown): string {
  return JSON.stringify(value).replace(/</g, '\\u003c');
}
