/**
 * Shared below-floor bridge target for any SSG loop that gates emission on a
 * word-count/threshold floor and has NO family-specific always-live hub of
 * its own to redirect to (unlike fuel-daily's FUEL_STATS_HUB_PATH or
 * salary-stats' SALARY_STATS hub). Without this, a page that met the floor
 * on a prior build (page emitted, URL crawled/indexed) and drops below it on
 * a later build gets silently skipped — a hard GitHub Pages 404 for a
 * previously-live URL, since Google reads the static HTTP status before any
 * client-side JS runs (no SPA fallback is possible).
 *
 * `/guida-frontaliere/` (and its EN/DE/FR equivalents) is a SECTION_EDITORIAL
 * entry in editorialContent.ts, emitted unconditionally by staticPagesPlugin.ts
 * for every locale regardless of any dataset — a safe, permanently-live,
 * family-agnostic redirect target. Below-floor pages bridge here instead of
 * being silently skipped.
 *
 * Consumers: borderWaitPagesPlugin.ts, healthPremiumsLandingPlugin.ts.
 */
import { BASE_URL, buildCanonicalBridgePage } from '../constants';
import { GUIDE_HUB_HREF } from './pillarGuideHrefs';

export type GuideHubLocale = 'it' | 'en' | 'de' | 'fr';

export const GUIDE_HUB_LOCALES: readonly GuideHubLocale[] = ['it', 'en', 'de', 'fr'];

// Shared single source of truth (build-plugins/shared/pillarGuideHrefs.ts,
// derived from SLUG_TABLES[locale].guida). Seven copies of this table lived
// under build-plugins/; four held these values and three had drifted to a
// 404 EN and a noindex DE — see #5428.
export const GUIDE_HUB_PATH: Record<GuideHubLocale, string> = GUIDE_HUB_HREF;

const GUIDE_HUB_BRIDGE_COPY: Record<GuideHubLocale, { title: string; description: string; ctaLabel: string }> = {
  it: {
    title: 'Pagina in aggiornamento | Frontaliere Ticino',
    description:
      'Questa pagina non ha ancora dati sufficienti oggi. Consulta la guida frontalieri completa.',
    ctaLabel: 'Vai alla guida frontalieri',
  },
  en: {
    title: 'Page updating | Frontaliere Ticino',
    description:
      'This page does not have enough data yet today. See the full cross-border worker guide.',
    ctaLabel: 'Go to the cross-border guide',
  },
  de: {
    title: 'Seite wird aktualisiert | Frontaliere Ticino',
    description:
      'Für diese Seite liegen heute noch nicht genügend Daten vor. Zum vollständigen Grenzgänger-Leitfaden.',
    ctaLabel: 'Zum Grenzgänger-Leitfaden',
  },
  fr: {
    title: 'Page en mise à jour | Frontaliere Ticino',
    description:
      "Cette page n'a pas encore assez de données aujourd'hui. Consultez le guide frontalier complet.",
    ctaLabel: 'Voir le guide frontalier',
  },
};

export function localeOfGuideHubPath(path: string): GuideHubLocale {
  const seg = path.split('/').filter(Boolean)[0];
  if (seg === 'en' || seg === 'de' || seg === 'fr') return seg;
  return 'it';
}

export function guideHubBridgeTarget(locale: GuideHubLocale): { targetPath: string; targetUrl: string } {
  const targetPath = GUIDE_HUB_PATH[locale];
  return { targetPath, targetUrl: `${BASE_URL}${targetPath}` };
}

/** Render a noindex,follow bridge for a below-floor `path`, redirecting to
 * that path's locale's cross-border-guide hub (derived from `path`'s own
 * locale prefix — no need for callers to track locale separately). */
export function renderGuideHubBridge(path: string): string {
  const locale = localeOfGuideHubPath(path);
  const { targetPath, targetUrl } = guideHubBridgeTarget(locale);
  const hreflangEntries: Array<{ hreflang: string; href: string }> = GUIDE_HUB_LOCALES.map((loc) => ({
    hreflang: loc,
    href: guideHubBridgeTarget(loc).targetUrl,
  }));
  hreflangEntries.push({ hreflang: 'x-default', href: guideHubBridgeTarget('it').targetUrl });
  const copy = GUIDE_HUB_BRIDGE_COPY[locale];
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
