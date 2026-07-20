// Recursively sorts object keys so a semantically-identical value compares
// equal regardless of the key order it happens to be re-emitted in (e.g. an
// API-echoed object). Shared by scripts/cf-locale-failover-setup.mjs
// (Cloudflare rule drift comparison) and scripts/lib/job-identity.mjs (job
// change detection) — edit here, never by duplicating.
//
// scripts/lib/git-commit-data.sh embeds a CommonJS twin of this function
// (invoked via `node -` on stdin, which cannot `import` this ESM module):
// keep the two behaviorally identical if this changes.
export function stableStringify(value) {
  if (value === null || value === undefined) return JSON.stringify(value);
  if (typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableStringify(item)).join(',')}]`;
  }
  const keys = Object.keys(value).sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`;
}
