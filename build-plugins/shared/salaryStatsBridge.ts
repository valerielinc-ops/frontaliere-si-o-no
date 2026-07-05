/**
 * Shared below-floor bridge target for any per-canton page family that gates
 * emission on a job-count/threshold floor. Without this, a canton that met
 * the floor on a prior build (page emitted, URL crawled/indexed) and drops
 * below it on a later build gets zero pages emitted — a hard GitHub Pages
 * 404 for a previously-live URL, since Google reads the static HTTP status
 * before any client-side JS runs (no SPA fallback is possible).
 *
 * The salary-stats hub (`salaryStatsChCantonPages.ts`) is emitted
 * unconditionally for every (locale, canton) combo regardless of job counts,
 * making it a safe, permanently-live redirect target. Below-floor cantons
 * bridge here instead of being silently skipped.
 *
 * Consumers: professionCantonLandings.ts, weeklyEmployersChCantonPages.ts,
 * jobMarketSnapshotChCantonPages.ts.
 */
import { BASE_URL, buildCanonicalBridgePage } from '../constants';
import {
  SALARY_STATS_CANTON_SLUGS,
  SALARY_STATS_LOCALES,
  buildSalaryStatsPath,
  type SalaryStatsLocale,
} from '../salaryStatsData';

export interface SalaryStatsBridgeCopy {
  title: string;
  description: string;
  ctaLabel: string;
}

export function salaryStatsBridgeTarget(
  locale: SalaryStatsLocale,
  cantonKey: string,
): { targetPath: string; targetUrl: string } {
  const cantonSlug = SALARY_STATS_CANTON_SLUGS[cantonKey][locale];
  const targetPath = buildSalaryStatsPath(locale, cantonSlug);
  return { targetPath, targetUrl: `${BASE_URL}${targetPath}` };
}

export function renderSalaryStatsBridge(
  locale: SalaryStatsLocale,
  cantonKey: string,
  copy: SalaryStatsBridgeCopy,
): string {
  const { targetPath, targetUrl } = salaryStatsBridgeTarget(locale, cantonKey);
  // Every hreflang alternate points at the salary-stats hub's OWN localized
  // URL for this canton (not the below-floor page's URL) — that hub is the
  // only guaranteed-live target across all 4 locales. x-default mirrors IT
  // byte-for-byte, matching the shared-helper invariant enforced elsewhere.
  const hreflangEntries: Array<{ hreflang: string; href: string }> = SALARY_STATS_LOCALES.map((loc) => ({
    hreflang: loc,
    href: salaryStatsBridgeTarget(loc, cantonKey).targetUrl,
  }));
  hreflangEntries.push({ hreflang: 'x-default', href: salaryStatsBridgeTarget('it', cantonKey).targetUrl });
  const html = buildCanonicalBridgePage({
    canonicalUrl: targetUrl,
    pathLabel: targetPath,
    title: copy.title,
    description: copy.description,
    body: copy.description,
    ctaLabel: copy.ctaLabel,
    lang: locale,
    noindex: true,
    hreflangEntries,
  });
  return html.replace(
    '</head>',
    `    <meta http-equiv="refresh" content="0; url=${targetUrl}">\n  </head>`,
  );
}
