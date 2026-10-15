/**
 * gate-issue-offenders.mjs — the "## Offender" section of a gate issue.
 *
 * Both issue openers of the post-deploy SEO gates write it from the audit's
 * own JSON report (`scripts/lib/auditReport.mjs`):
 *   - `scripts/ci/report-validate-dist-failure.mjs`
 *     (`Validation Failure (dist): <gate>`);
 *   - `scripts/cathedral-seo-gates-check.mjs`
 *     (`SEO gates regression: <gate> above baseline`).
 *
 * Why (owner, 2026-10-02): every error a gate finds must become an issue an
 * autofixer can resolve. Until then both bodies held counts and a reproduce
 * command but no offender: the fixer had to rerun a 40-minute dist walk, or
 * download an artifact that expires in 7 days, before knowing which pages to
 * look at. The section carries what the report already knows: verdict,
 * baseline delta, regressed features, the feature/sitemap breakdown and a
 * capped sample of offender paths.
 *
 * Pure: input is a parsed report, output is markdown lines. No path under
 * `.github/workflows/` can come out of here (the fixer's capability guard
 * stops on those); offender paths are dist-relative page paths.
 */

/** Offender rows printed per issue. The full list stays in the artifact. */
export const OFFENDER_SAMPLE = 20;

const MAX_CELL = 220;

function clip(value) {
  const s = String(value ?? '').replace(/\s+/g, ' ').trim();
  return s.length > MAX_CELL ? `${s.slice(0, MAX_CELL - 1)}…` : s;
}

function inlineCode(value) {
  return `\`${clip(value).replace(/`/g, "'")}\``;
}

/**
 * Report file names to try for a gate key, in order. Reports are named after
 * the audit (`writeAuditReport({ audit })` → `<audit>.json`): the key's bare
 * name for `audit:<x>` and `audit:all/<x>`, `validate-<x>` for validators.
 * @param {string} gate
 * @returns {string[]}
 */
export function reportFileCandidates(gate) {
  const g = String(gate || '');
  const bare = g.slice(Math.max(g.lastIndexOf(':'), g.lastIndexOf('/')) + 1);
  if (!bare) return [];
  return [...new Set([`${bare}.json`, `validate-${bare}.json`, `audit-${bare}.json`])];
}

/**
 * @param {Record<string, unknown> | null | undefined} report parsed report JSON
 * @param {{ gate: string, source?: string, sample?: number }} opts
 *   `source` says where the full report lives (artifact name, path).
 * @returns {string[]} markdown lines, starting with the `## Offender` heading
 */
export function renderOffenderSection(report, { gate, source = '', sample = OFFENDER_SAMPLE }) {
  const lines = ['## Offender'];
  if (!report || typeof report !== 'object') {
    lines.push(
      `- Report JSON di ${inlineCode(gate)} non disponibile a questo reporter${source ? ` (${source})` : ''}: la riproduzione qui sotto lo rigenera.`,
    );
    return lines;
  }
  const r = /** @type {Record<string, any>} */ (report);
  const total = Number.isFinite(r.offendersTotal) ? r.offendersTotal : null;
  const sampled = Number.isFinite(r.sampleRate) && r.sampleRate < 1
    ? ` su un campione del ${Math.round(r.sampleRate * 100)}% (stima ${r.offendersTotalExtrapolated ?? '?'})`
    : '';
  lines.push(
    `- Verdetto: passed=${r.passed === true ? 'true' : 'false'}${total !== null ? `, offender=${total}${sampled}` : ''}${r.ranAt ? `, ranAt=${clip(r.ranAt)}` : ''}${source ? ` — report completo: ${source}` : ''}`,
  );
  if (r.threshold) lines.push(`- Soglia: ${inlineCode(JSON.stringify(r.threshold))}`);
  if (r.baselineDelta) lines.push(`- Delta sulla baseline: ${inlineCode(JSON.stringify(r.baselineDelta))}`);

  const regressed = Array.isArray(r.regressedFeatures) ? r.regressedFeatures : [];
  if (regressed.length > 0) {
    lines.push('- Feature regredite (è qui la causa, non nel campione):');
    for (const f of regressed.slice(0, 10)) lines.push(`  - ${inlineCode(typeof f === 'string' ? f : JSON.stringify(f))}`);
  }

  const byFeature = r.byFeature && typeof r.byFeature === 'object' ? Object.entries(r.byFeature) : [];
  const rate = r.rateByFeature && typeof r.rateByFeature === 'object' ? r.rateByFeature : {};
  const nonZero = byFeature.filter(([, n]) => Number(n) > 0).sort((a, b) => Number(b[1]) - Number(a[1]));
  if (nonZero.length > 0) {
    lines.push('- Offender per feature:');
    for (const [feature, n] of nonZero.slice(0, 10)) {
      const pct = Number.isFinite(rate[feature]) ? ` (${Number(rate[feature]).toFixed(2)}%)` : '';
      lines.push(`  - ${inlineCode(feature)}: ${n}${pct}`);
    }
  }

  // Link-graph audits (max-bfs-depth, orphan-sitemap-pages) report per sitemap.
  const perSitemap = r.perSitemapSummary && typeof r.perSitemapSummary === 'object'
    ? Object.entries(r.perSitemapSummary)
    : [];
  const buried = perSitemap
    .map(([name, row]) => [name, Number(row?.atDepthGtMax ?? row?.orphans ?? row?.offenders ?? 0), row])
    .filter(([, n]) => n > 0)
    .sort((a, b) => b[1] - a[1]);
  // Printed only when the feature breakdown did not already list them
  // (the BFS report keys `byFeature` by sitemap too).
  if (buried.length > 0 && nonZero.length === 0) {
    lines.push('- Offender per sitemap:');
    for (const [name, n, row] of buried.slice(0, 10)) {
      lines.push(`  - ${inlineCode(name)}: ${n}${Number.isFinite(row?.total) ? ` su ${row.total}` : ''}`);
    }
  }

  const top = Array.isArray(r.topOffenders) ? r.topOffenders : [];
  if (top.length > 0) {
    lines.push(`- Campione di offender (${Math.min(top.length, sample)} di ${total ?? top.length}):`);
    for (const o of top.slice(0, sample)) {
      const where = o?.path ?? o?.file ?? o?.url ?? JSON.stringify(o);
      const extra = [
        o?.feature ? `feature=${o.feature}` : '',
        o?.sitemap ? `sitemap=${o.sitemap}` : '',
        o?.metric !== undefined && o?.metric !== null ? `metric=${o.metric}` : '',
        o?.depth !== undefined ? `depth=${o.depth}` : '',
        o?.title ? `title=${o.title}` : '',
        o?.reason ? `reason=${o.reason}` : '',
      ].filter(Boolean).join(', ');
      lines.push(`  - ${inlineCode(where)}${extra ? ` — ${clip(extra)}` : ''}`);
    }
  } else if (total !== null && total > 0) {
    lines.push('- Il report non porta un campione di offender: la riproduzione qui sotto li elenca.');
  }
  return lines;
}
