/**
 * Dove sta il report JSON di `audit-orphan-pages-in-sitemaps.mjs`.
 *
 * Una sola risoluzione per scrittore (lo script d'audit) e lettore (il gate
 * `orphan-sitemap-pages` in `cathedral-seo-gates-check.mjs`). Prima ciascuno
 * risolveva `ORPHAN_PAGES_AUDIT_REPORT` a modo suo: lo scrittore rispetto alla
 * root del repo, il lettore rispetto alla directory corrente. Con un valore
 * relativo, lanciando il gate da un'altra directory, il report finiva in un
 * posto e veniva cercato in un altro.
 *
 * Un valore relativo si risolve SEMPRE rispetto alla root del repo, come
 * `--out` dello scrittore; senza variabile vale il report tracciato.
 *
 * @param {string} repoRoot radice del repository
 * @param {Record<string, string | undefined>} [env]
 * @returns {string} path assoluto
 */
import path from 'node:path';

export const DEFAULT_ORPHAN_PAGES_AUDIT_REPORT = path.join('data', 'orphan-pages-audit.json');

export function orphanPagesAuditReportPath(repoRoot, env = process.env) {
  const value = env.ORPHAN_PAGES_AUDIT_REPORT;
  return path.resolve(repoRoot, value || DEFAULT_ORPHAN_PAGES_AUDIT_REPORT);
}
