import { slugify } from './query-tokenizer.mjs';
import { buildOrphanLandingPath, ORPHAN_LANDING_LOCALES } from './orphan-landing-path.mjs';
import { NURSING_ORPHAN_QUERY_TARGETS, buildNursingLandingPath, resolveNursingOrphanQueryTarget } from './nursing-landing-path.mjs';

/** Only exact query variants assigned to one current cluster may redirect. */
export function buildOrphanQueryAliases(clusters) {
  const canonical = new Set(clusters.map((cluster) => buildOrphanLandingPath(cluster.locale, cluster.canonicalSlug)));
  const candidates = new Map();
  const add = (from, to) => {
    if (from === to) return;
    if (!candidates.has(from)) candidates.set(from, new Set());
    candidates.get(from).add(to);
  };
  for (const cluster of clusters) {
    const nursing = resolveNursingOrphanQueryTarget(cluster.canonicalQuery, cluster.canonicalSlug);
    const target = nursing ? buildNursingLandingPath(cluster.locale, nursing.id) : buildOrphanLandingPath(cluster.locale, cluster.canonicalSlug);
    for (const { query } of cluster.queries || []) {
      const slug = slugify(query);
      if (!slug) continue;
      const from = buildOrphanLandingPath(cluster.locale, slug);
      if (!canonical.has(from)) add(from, target);
    }
  }
  // Explicit nursing aliases identify the same evergreen resource even under
  // an old foreign-language query slug; the destination keeps the URL locale.
  for (const locale of ORPHAN_LANDING_LOCALES) {
    for (const [slug, target] of Object.entries(NURSING_ORPHAN_QUERY_TARGETS)) {
      const from = buildOrphanLandingPath(locale, slug);
      if (!canonical.has(from)) add(from, buildNursingLandingPath(locale, target.id));
    }
  }
  return Object.fromEntries([...candidates].filter(([, targets]) => targets.size === 1)
    .map(([from, targets]) => [from, [...targets][0]]).sort(([a], [b]) => a.localeCompare(b)));
}
