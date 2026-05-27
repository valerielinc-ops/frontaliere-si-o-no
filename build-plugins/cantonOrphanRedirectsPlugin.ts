/**
 * cantonOrphanRedirectsPlugin
 * ─────────────────────────────────────────────────────────────────────────
 * Emits HTTP-200 canonical-bridge HTML at every known orphan combination
 * of `cerca-lavoro-{canton}/{foreign-editorial-slug}/` (and the per-locale
 * equivalents) so Google can drop those URLs from the index instead of
 * leaving them as 404s.
 *
 * Why this exists.
 *   The SPA router (services/router.ts) already redirects these URLs to
 *   their per-canton canonical via `window.location.replace`, but that fix
 *   only runs after JS hydration. GitHub Pages still serves `404.html`
 *   with HTTP 404 for any path missing a static file, and Google crawls
 *   the status code first. With a real static file at the orphan path,
 *   the response becomes HTTP 200 and the `<link rel="canonical">` +
 *   `noindex` + meta refresh tells the crawler to fold the URL into the
 *   real one.
 *
 * Scope.
 *   For every canton in `ALL_CANTON_CODES`, for every editorial slot
 *   (today / nurses-hub / part-time + 4 care-cluster slots), for every
 *   locale (it/en/de/fr): collect the per-canton canonical slug for that
 *   (slot, locale) AND every OTHER canton's canonical slug for the same
 *   (slot, locale). For each alternate slug ≠ canonical, emit a bridge
 *   HTML at the orphan path pointing back to this canton's canonical URL.
 *
 *   Skips files when a higher-priority plugin already emitted there.
 *
 * Plugin contract.
 *   apply:  'build'
 *   enforce:'post' (runs after canonical pages are written so we never
 *                   overwrite a real page)
 *   emit:   closeBundle (mirrors jobsSeoPagesPlugin / staticPagesPlugin)
 */
import fs from 'fs';
import path from 'path';
import type { Plugin } from 'vite';

import {
 ALL_CANTON_CODES,
 AGGREGATE_KEY,
 resolveCantonSection,
 type CantonLocale,
} from './shared/cantonSection';
import {
 careClusterSlug,
 getJobNursesHubSlug,
 getJobPartTimeLandingSlug,
 getJobTodayLandingSlug,
 LEGACY_SHORT_FORM_SLUGS_BY_SLOT,
 type JobCareClusterKey,
} from './jobEditorialLanding';
import { BASE_URL, buildCanonicalBridgePage } from './constants';

type Locale = CantonLocale;
const LOCALES: readonly Locale[] = ['it', 'en', 'de', 'fr'];
const LOCALE_PREFIX: Record<Locale, string> = { it: '', en: '/en', de: '/de', fr: '/fr' };

type SlotKey = 'today' | 'nurses' | 'partTime' | 'clinics' | 'careHomes' | 'oss' | 'educators';
const SLOT_KEYS: readonly SlotKey[] = ['today', 'nurses', 'partTime', 'clinics', 'careHomes', 'oss', 'educators'];

const CARE_CLUSTER_KEYS: Record<Exclude<SlotKey, 'today' | 'nurses' | 'partTime'>, JobCareClusterKey> = {
 clinics: 'clinics',
 careHomes: 'careHomes',
 oss: 'oss',
 educators: 'educators',
};

function slugForSlot(slot: SlotKey, locale: Locale, canton: string): string {
 if (slot === 'today') return getJobTodayLandingSlug(locale, canton);
 if (slot === 'nurses') return getJobNursesHubSlug(locale, canton);
 if (slot === 'partTime') return getJobPartTimeLandingSlug(locale, canton);
 return careClusterSlug(CARE_CLUSTER_KEYS[slot], canton, locale);
}

export interface OrphanRedirect {
 /** Absolute path to emit, e.g. `/cerca-lavoro-basilea/offerte-di-lavoro-ticino-oggi/` */
 from: string;
 /** Absolute canonical path, e.g. `/cerca-lavoro-basilea/offerte-di-lavoro-basilea-oggi/` */
 to: string;
 locale: Locale;
 canton: string;
 slot: SlotKey;
 orphanSlug: string;
 canonicalSlug: string;
}

/**
 * Enumerate every orphan combination. Pure function — extracted so unit
 * tests can verify expected output without running the full emit pipeline.
 */
export function enumerateCantonOrphanRedirects(): OrphanRedirect[] {
 const out: OrphanRedirect[] = [];
 const cantons = ALL_CANTON_CODES.filter((c) => c !== AGGREGATE_KEY);
 for (const canton of cantons) {
 for (const locale of LOCALES) {
 const section = resolveCantonSection(locale, canton);
 const prefix = LOCALE_PREFIX[locale];
 for (const slot of SLOT_KEYS) {
 const canonicalSlug = slugForSlot(slot, locale, canton);
 // Targeted orphan set — only the slug forms that actually leaked into
 // production from historical code paths, NOT the full Cartesian
 // product of 24 cantons (that exploded to ~16k files for ~672 real
 // orphans). Sources covered:
 //   1. TI/GR/VS canonical slugs: the original slug helpers defaulted
 //      to `canton = 'TI'`, so internal navigators produced
 //      /cerca-lavoro-basilea/offerte-di-lavoro-ticino-oggi/ etc.
 //      GR/VS variants surfaced from the same default-arg bug for
 //      pages that explicitly passed those cantons.
 //   2. LEGACY_SHORT_FORM (`infermieri`, `oggi`, `cliniche`, …): the
 //      pre-2026-05-18 Phase-8d canonical for every non-TI/GR/VS
 //      canton. These are GSC-indexed and would 404 after the
 //      long-form revert.
 const alternates = new Set<string>();
 for (const sourceCanton of ['TI', 'GR', 'VS']) {
 alternates.add(slugForSlot(slot, locale, sourceCanton));
 }
 alternates.add(LEGACY_SHORT_FORM_SLUGS_BY_SLOT[slot][locale]);
 alternates.delete(canonicalSlug);
 for (const orphanSlug of alternates) {
 const from = `${prefix}/${section}/${orphanSlug}/`.replace(/\/+/g, '/');
 const to = `${prefix}/${section}/${canonicalSlug}/`.replace(/\/+/g, '/');
 out.push({ from, to, locale, canton, slot, orphanSlug, canonicalSlug });
 }
 }
 }
 }
 return out;
}

/** Wraps the canonical bridge HTML with a meta-refresh so real users
 *  auto-navigate to the canonical URL within ~0.5s. The canonical link
 *  and noindex are what tell Google to consolidate. */
function buildOrphanRedirectHtml(canonicalPath: string, canonicalLabel: string, locale: Locale): string {
 const canonicalUrl = `${BASE_URL}${canonicalPath}`;
 const titleByLocale: Record<Locale, string> = {
 it: 'Pagina spostata | Frontaliere Ticino',
 en: 'Page moved | Frontaliere Ticino',
 de: 'Seite verschoben | Frontaliere Ticino',
 fr: 'Page deplacee | Frontaliere Ticino',
 };
 const bodyByLocale: Record<Locale, string> = {
 it: 'Questa URL e stata consolidata nella versione corretta per il cantone. Ti reindirizziamo automaticamente alla pagina canonica.',
 en: 'This URL has been consolidated into the canton-correct version. You will be redirected automatically to the canonical page.',
 de: 'Diese URL wurde mit der kantonsspezifischen Version zusammengelegt. Sie werden automatisch zur kanonischen Seite weitergeleitet.',
 fr: 'Cette URL a ete consolidee dans la version correcte du canton. Vous serez redirige automatiquement vers la page canonique.',
 };
 const ctaByLocale: Record<Locale, string> = {
 it: 'Apri la pagina corretta',
 en: 'Open the correct page',
 de: 'Korrekte Seite offnen',
 fr: 'Ouvrir la page correcte',
 };
 const html = buildCanonicalBridgePage({
 canonicalUrl,
 pathLabel: canonicalPath,
 title: titleByLocale[locale],
 description: bodyByLocale[locale],
 body: bodyByLocale[locale],
 ctaLabel: ctaByLocale[locale],
 lang: locale,
 noindex: true,
 });
 // Inject a meta refresh so users land on the canonical URL without
 // needing to click. Google treats it as a 301-equivalent when combined
 // with the matching canonical link + noindex on this page.
 void canonicalLabel;
 return html.replace(
 '</head>',
 ` <meta http-equiv="refresh" content="0; url=${canonicalUrl}">\n </head>`,
 );
}

interface PluginOptions {
 /** When true, log per-emit details. Default false (only summary). */
 verbose?: boolean;
}

export function cantonOrphanRedirectsPlugin(options: PluginOptions = {}): Plugin {
 let distDir = 'dist';
 return {
 name: 'canton-orphan-redirects',
 apply: 'build',
 enforce: 'post',
 configResolved(config) {
 distDir = path.resolve(config.root, config.build?.outDir || 'dist');
 },
 closeBundle() {
 const redirects = enumerateCantonOrphanRedirects();
 let emitted = 0;
 let skipped = 0;
 for (const r of redirects) {
 const outDir = path.join(distDir, r.from.replace(/^\/+|\/+$/g, ''));
 const outFile = path.join(outDir, 'index.html');
 // Never overwrite a real page emitted by a higher-priority plugin
 // (e.g. the canonical landing itself, or a soft-landing for an
 // expired job that happens to share the slug).
 if (fs.existsSync(outFile)) {
 skipped++;
 continue;
 }
 fs.mkdirSync(outDir, { recursive: true });
 const html = buildOrphanRedirectHtml(r.to, r.canonicalSlug, r.locale);
 fs.writeFileSync(outFile, html, 'utf-8');
 if (options.verbose) {
 console.log(`[canton-orphan-redirects] ${r.from} → ${r.to}`);
 }
 emitted++;
 }
 console.log(
 `\x1b[36m[canton-orphan-redirects]\x1b[0m ${emitted} redirect pages emitted ` +
 `(${skipped} skipped — real page already present, ${redirects.length} total combinations)`,
 );
 },
 };
}
