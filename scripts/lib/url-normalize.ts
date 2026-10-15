// Re-export shim so the Vitest `@/scripts/lib/url-normalize` alias resolves.
// Source of truth is the `.mjs` file (consumed by Node.js scripts).
export { normalizeInspectionUrl } from './url-normalize.mjs';
