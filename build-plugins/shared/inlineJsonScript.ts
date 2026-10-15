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

import { normalizeOrganizationIdentities } from '../../services/seo/organizationLd';

export interface InlineScriptJsonOptions {
  /** Keep name-only Organization nodes anonymous when the source is unverified. */
  readonly allowNameOnlyOrganizationIds?: boolean;
}

/** Neutralise `<` in an ALREADY-serialized JSON/JSON-LD string so it is safe
 * inside an inline `<script>` (incl. `<script type="application/ld+json">`).
 * `<` → `<` is valid JSON and parses identically (Google accepts it). */
export function escapeInlineScript(json: string): string {
  return json.replace(/</g, '\\u003c');
}

/** JSON-encode `value` and neutralise `<` so it is safe inside an inline <script>. */
export function inlineScriptJson(value: unknown, options: InlineScriptJsonOptions = {}): string {
  // Article-engine emitters use this host-provided serializer through the
  // SiteShellContract. Normalize only payloads that actually contain an
  // Organization node so arbitrary window data keeps its original shape.
  const normalized = containsOrganizationNode(value)
    ? normalizeOrganizationIdentities(value, {
        allowNameOnlyFallback: options.allowNameOnlyOrganizationIds !== false,
      })
    : value;
  return escapeInlineScript(JSON.stringify(normalized));
}

function containsOrganizationNode(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(containsOrganizationNode);
  if (!value || typeof value !== 'object') return false;
  const record = value as Record<string, unknown>;
  const type = record['@type'];
  if (type === 'Organization' || (Array.isArray(type) && type.includes('Organization'))) return true;
  return Object.values(record).some(containsOrganizationNode);
}
