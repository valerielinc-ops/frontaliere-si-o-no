#!/usr/bin/env node
/**
 * build-legacy-aliases.mjs
 *
 * Snapshot ingester for `data/legacy-aliases.json` — the canonical source of
 * all "miscellaneous" 404 → bridge mappings (Cohort 5 of the GSC
 * `Indicizzata Non trovata` repair effort).
 *
 * Reads two inputs:
 *   - download/frontaliereticino.ch-Coverage-{date}/Tabella.csv
 *   - services/routerBlogData.ts (for article-id → locale-slug lookup)
 *
 * Classifies each unresolved-cohort URL into one of:
 *
 *   blogLocaleMismatch (17): /(en|de|fr)/{blog-section}/{IT-slug-or-article-id}
 *     Try to resolve `article-id` → locale-canonical slug via routerBlogData.
 *     - matched   → canonical: the locale-canonical blog URL (full content
 *                   bridge via replaceState)
 *     - unmatched → canonical: locale blog hub (article id missing)
 *
 *   blogITMissing (1): /articoli-frontaliere/{slug-not-in-routerBlogData}
 *     - canonical: IT blog hub
 *
 *   fuelStation (8): /{locale-prefix}/{fuel-section}/{city}/{stations-slug}/{station}
 *     - canonical: city-level fuel page (matched) or section root
 *
 *   fuelLocaleAlias (1): /de/dieselpreise/heute/
 *     - canonical: IT fuel root (the DE locale slug never existed)
 *
 *   jobLegacySection (2): /cerca-lavoro/{slug} (no -ticino, no slash)
 *     - canonical: current /cerca-lavoro-ticino/{slug}/
 *
 *   legacySectionAlt (2): /ricerca/posti-di-lavoro-ticino/, /fr/recherche-emploi-tessin/
 *     - canonical: locale section landing
 *
 *   subSlugOnly (1): /confronta-casse-malati/ (sub without section)
 *     - canonical: /compara-servizi/confronta-casse-malati/
 *
 *   localePrefixed (2): /en/consulting/, /de/api-status/ (IT-only utility
 *     pages mistakenly linked under locale)
 *     - canonical: IT canonical path
 *
 *   weeklyEmployersDeep (1): /aziende-che-assumono/{city}/{company}/settimana-corrente/
 *     - canonical: F5 city landing
 *
 * Output schema (consumed by `build-plugins/legacyAliasPlugin.ts`):
 *
 *   {
 *     "generatedAt": ISO-8601,
 *     "counts": { ... },
 *     "aliases": [
 *       {
 *         "orphanPath": "/de/grenzgaenger-artikel/tessin-lombardei-fertigung/",
 *         "locale": "de",
 *         "kind": "matched" | "unmatched",
 *         "canonicalPath": "/de/grenzgaenger-artikel/the-translated-slug/",
 *         "cohort": "blogLocaleMismatch",
 *         "displayName": "Article title hint (optional)"
 *       },
 *       ...
 *     ]
 *   }
 *
 * GSC exports are capped samples: routes absent from a new export are retained
 * and re-classified from current source data. Remove a route only after an
 * explicit recovery review, never from sample absence alone.
 *
 * Run after dropping a new GSC CSV into download/ to re-classify and refresh.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { withSingleFlightLock } from './lib/single-flight-lock.mjs';
import {
  assertGscLegacyAliasSnapshot,
  gscOrphanPathKey,
  gscOrphanRouteKey,
  mergeGscOrphanRecords,
} from './lib/gsc-orphan-snapshot.mjs';
import { isFuelSectionPath } from './lib/fuelSections.mjs';

const __filename = fileURLToPath(import.meta.url);
const ROOT = path.resolve(__filename, '..', '..');
const DOWNLOADS_DIR = path.join(ROOT, 'download');
const ROUTER_BLOG_PATH = path.join(ROOT, 'services', 'routerBlogData.ts');
const OUT_PATH = path.join(ROOT, 'data', 'legacy-aliases.json');

const DRY_RUN = process.argv.includes('--dry-run');

// ── routerBlogData parsing ──────────────────────────────────────────────

function loadBlogIdToSlug() {
  if (!fs.existsSync(ROUTER_BLOG_PATH)) return new Map();
  const src = fs.readFileSync(ROUTER_BLOG_PATH, 'utf-8');
  const map = new Map();
  const re = /["']([a-z0-9-]+)["']:\s*\{\s*it:\s*["']([^"']+)["'],\s*en:\s*["']([^"']+)["'],\s*de:\s*["']([^"']+)["'],\s*fr:\s*["']([^"']+)["']\s*\}/g;
  let m;
  while ((m = re.exec(src)) !== null) {
    map.set(m[1], { it: m[2], en: m[3], de: m[4], fr: m[5] });
  }
  return map;
}

const BLOG_HUB_PATH = {
  it: '/articoli-frontaliere',
  en: '/en/cross-border-articles',
  de: '/de/grenzgaenger-artikel',
  fr: '/fr/articles-frontalier',
};

// ── CSV ingest ──────────────────────────────────────────────────────────

function findCsvFiles() {
  if (!fs.existsSync(DOWNLOADS_DIR)) return [];
  const out = [];
  for (const e of fs.readdirSync(DOWNLOADS_DIR).sort()) {
    if (!e.startsWith('frontaliereticino.ch-Coverage-')) continue;
    const csv = path.join(DOWNLOADS_DIR, e, 'Tabella.csv');
    if (fs.existsSync(csv)) out.push(csv);
  }
  return out;
}

function parseCsvUrls(file) {
  return fs.readFileSync(file, 'utf-8').split(/\r?\n/).slice(1).filter(Boolean)
    .map((l) => l.split(',')[0]).filter(Boolean);
}

function normalizePath(rawUrl) {
  try {
    return gscOrphanRouteKey({ url: rawUrl });
  } catch {
    // A GSC property may include subdomains or malformed rows outside the
    // canonical site hosts. Ignore those rows as the previous parser did;
    // historical snapshot validation remains fail-closed below.
    return null;
  }
}

// ── Cohort detection ────────────────────────────────────────────────────

const COHORT_PATTERNS = [
  // Cohorts already handled in earlier PRs — exclude
  { cohort: 'covered-related-search', re: /^\/(cerca-lavoro-ticino|en\/find-jobs-ticino|de\/jobs-im-tessin|fr\/trouver-emploi-tessin)\/(ricerca|search|suche|recherche)-/ },
  { cohort: 'covered-calculator', re: /^\/(en|de|fr)\/calcola-stipendio\// },
  { cohort: 'covered-job-detail', re: /^\/(cerca-lavoro-ticino|en\/find-jobs-ticino|de\/jobs-im-tessin|fr\/trouver-emploi-tessin)\/(?!(?:ricerca|search|suche|recherche|azienda|company|unternehmen|firma|entreprise|societe|localita|location|standort|ort|stadt|localite|ville|lieu)-)[^/]+\/$/ },
  { cohort: 'covered-location-hub', re: /^\/(cerca-lavoro-ticino|en\/find-jobs-ticino|de\/jobs-im-tessin|fr\/trouver-emploi-tessin)\/(localita|location|standort|ort|stadt|localite|ville|lieu)-/ },
  { cohort: 'covered-company-hub', re: /^\/(cerca-lavoro-ticino|en\/find-jobs-ticino|de\/jobs-im-tessin|fr\/trouver-emploi-tessin)\/(azienda|company|unternehmen|firma|entreprise|societe)-/ },
  // This PR's cohorts
  { cohort: 'blogLocaleMismatch', re: /^\/(en|de|fr)\/(cross-border-articles|grenzgaenger-artikel|articles-frontalier)\// },
  { cohort: 'blogITMissing', re: /^\/articoli-frontaliere\// },
  // Cohort DETECTION delegates the "is this under a fuel section" check to
  // the shared isFuelSectionPath() (scripts/lib/fuelSections.mjs) instead of
  // an inline slug alternation — same drift class as #2853. resolveFuelStation()
  // below intentionally keeps its OWN narrower capture regex: it needs the
  // literal matched segment to reconstruct the canonical section path, and
  // widening it to the full canonical+legacy-alias list would let a legacy
  // alias segment (e.g. `prezzi-benzina-svizzera`) leak into a reconstructed
  // "canonical" path that isn't actually live. Any path this cohort check
  // newly matches but resolveFuelStation() can't parse is skipped in main()
  // exactly as before (behavior-neutral — see comparison script).
  { cohort: 'fuelStation', test: (p) => isFuelSectionPath(p) && /\/(stazioni|stations|tankstellen)\//.test(p) },
  { cohort: 'fuelLocaleAlias', re: /^\/de\/dieselpreise\// },
  { cohort: 'jobLegacySection', re: /^\/cerca-lavoro\/[^/]+\/?$/ },
  { cohort: 'legacySectionAltIT', re: /^\/ricerca\/posti-di-lavoro-ticino\/?$/ },
  { cohort: 'legacySectionAltFR', re: /^\/fr\/recherche-emploi-tessin\/?$/ },
  { cohort: 'subSlugOnly', re: /^\/confronta-casse-malati\/?$/ },
  { cohort: 'localePrefixedConsulting', re: /^\/en\/consulting\/?$/ },
  { cohort: 'localePrefixedApiStatus', re: /^\/de\/api-status\/?$/ },
  { cohort: 'weeklyEmployersDeep', re: /^\/aziende-che-assumono\/.+\/settimana-corrente\/?$/ },
];

function classifyCohort(p) {
  for (const { cohort, re, test } of COHORT_PATTERNS) {
    if (test ? test(p) : re.test(p)) return cohort;
  }
  return null;
}

// ── Per-cohort canonical resolvers ──────────────────────────────────────

function resolveBlogLocaleMismatch(orphanPath, blogIdToSlug) {
  const m = orphanPath.match(/^\/(en|de|fr)\/(cross-border-articles|grenzgaenger-artikel|articles-frontalier)\/([^/]+)\/?$/);
  if (!m) return null;
  const locale = m[1];
  const candidate = m[3];

  // Look up by article-id first
  if (blogIdToSlug.has(candidate)) {
    const slug = blogIdToSlug.get(candidate)[locale];
    return { kind: 'matched', canonicalPath: `${BLOG_HUB_PATH[locale]}/${slug}/` };
  }
  // Then by slug-in-any-locale
  for (const [, slugs] of blogIdToSlug) {
    for (const [, s] of Object.entries(slugs)) {
      if (s === candidate) {
        const slug = slugs[locale];
        return { kind: 'matched', canonicalPath: `${BLOG_HUB_PATH[locale]}/${slug}/` };
      }
    }
  }
  // Article gone — fallback to locale blog hub
  return { kind: 'unmatched', canonicalPath: `${BLOG_HUB_PATH[locale]}/` };
}

function resolveBlogITMissing(orphanPath, blogIdToSlug) {
  const m = orphanPath.match(/^\/articoli-frontaliere\/([^/]+)\/?$/);
  if (!m) return null;
  const candidate = m[1];
  if (blogIdToSlug.has(candidate)) {
    return { kind: 'matched', canonicalPath: `${BLOG_HUB_PATH.it}/${blogIdToSlug.get(candidate).it}/` };
  }
  for (const [, slugs] of blogIdToSlug) {
    if (slugs.it === candidate) {
      return { kind: 'matched', canonicalPath: `${BLOG_HUB_PATH.it}/${slugs.it}/` };
    }
  }
  return { kind: 'unmatched', canonicalPath: `${BLOG_HUB_PATH.it}/` };
}

const FUEL_SECTION_ROOT = {
  it: { benzina: '/prezzi-benzina', diesel: '/prezzi-diesel' },
  en: { benzina: '/en/gasoline-price-switzerland', diesel: '/en/diesel-price-switzerland' },
  de: { benzina: '/de/benzinpreis-schweiz', diesel: '/de/dieselpreis-schweiz' },
  fr: { benzina: '/fr/prix-essence-suisse', diesel: '/fr/prix-diesel-suisse' },
};

function resolveFuelStation(orphanPath) {
  const m = orphanPath.match(/^\/(prezzi-benzina|prezzi-diesel|en\/gasoline-price-switzerland|de\/benzinpreis-schweiz|fr\/prix-essence-suisse)\/([^/]+)\/(stazioni|stations|tankstellen)\/[^/]+\/?$/);
  if (!m) return null;
  const sectionPath = '/' + m[1];
  const city = m[2];
  // City page is the parent dir of /stazioni|stations|tankstellen
  return { kind: 'matched', canonicalPath: `${sectionPath}/${city}/` };
}

function resolveFuelLocaleAlias(orphanPath) {
  // /de/dieselpreise/heute/ → /prezzi-diesel/oggi/ (IT canonical) or section root
  return { kind: 'matched', canonicalPath: '/prezzi-diesel/' };
}

function resolveJobLegacySection(orphanPath) {
  // /cerca-lavoro/{slug} → /cerca-lavoro-ticino/{slug}/
  const m = orphanPath.match(/^\/cerca-lavoro\/([^/]+)\/?$/);
  if (!m) return null;
  return { kind: 'matched', canonicalPath: `/cerca-lavoro-ticino/${m[1]}/` };
}

function resolveLegacySectionAltIT() {
  return { kind: 'matched', canonicalPath: '/cerca-lavoro-ticino/' };
}

function resolveLegacySectionAltFR() {
  return { kind: 'matched', canonicalPath: '/fr/trouver-emploi-tessin/' };
}

function resolveSubSlugOnly() {
  return { kind: 'matched', canonicalPath: '/compara-servizi/confronta-casse-malati/' };
}

function resolveLocalePrefixedConsulting() {
  // /en/consulting/ — IT-only utility page. Canonical: IT /consulting/
  return { kind: 'matched', canonicalPath: '/consulting/' };
}

function resolveLocalePrefixedApiStatus() {
  return { kind: 'matched', canonicalPath: '/api-status/' };
}

function resolveWeeklyEmployersDeep(orphanPath) {
  // /aziende-che-assumono/{city}/{company}/settimana-corrente/
  // Canonical: /aziende-che-assumono/{city}/ (city-level F5 landing)
  const m = orphanPath.match(/^\/aziende-che-assumono\/([^/]+)\/[^/]+\/settimana-corrente\/?$/);
  if (!m) return null;
  return { kind: 'matched', canonicalPath: `/aziende-che-assumono/${m[1]}/` };
}

function pathLocale(orphanPath) {
  // Match case-insensitively (GSC may index a locale segment with drifted
  // casing, e.g. `/EN/find-jobs-ticino/...`) — mirrors inferLocale() in
  // build-plugins/searchConsoleCompat.ts.
  const lowerPath = orphanPath.toLowerCase();
  if (lowerPath.startsWith('/en/')) return 'en';
  if (lowerPath.startsWith('/de/')) return 'de';
  if (lowerPath.startsWith('/fr/')) return 'fr';
  return 'it';
}

function classifyLegacyAlias(orphanPath, blogIdToSlug) {
  const cohort = classifyCohort(orphanPath);
  if (!cohort || cohort.startsWith('covered-')) return null;

  let resolution = null;
  switch (cohort) {
    case 'blogLocaleMismatch':       resolution = resolveBlogLocaleMismatch(orphanPath, blogIdToSlug); break;
    case 'blogITMissing':            resolution = resolveBlogITMissing(orphanPath, blogIdToSlug); break;
    case 'fuelStation':              resolution = resolveFuelStation(orphanPath); break;
    case 'fuelLocaleAlias':          resolution = resolveFuelLocaleAlias(orphanPath); break;
    case 'jobLegacySection':         resolution = resolveJobLegacySection(orphanPath); break;
    case 'legacySectionAltIT':       resolution = resolveLegacySectionAltIT(); break;
    case 'legacySectionAltFR':       resolution = resolveLegacySectionAltFR(); break;
    case 'subSlugOnly':              resolution = resolveSubSlugOnly(); break;
    case 'localePrefixedConsulting': resolution = resolveLocalePrefixedConsulting(); break;
    case 'localePrefixedApiStatus':  resolution = resolveLocalePrefixedApiStatus(); break;
    case 'weeklyEmployersDeep':      resolution = resolveWeeklyEmployersDeep(orphanPath); break;
  }
  if (!resolution) return null;

  return {
    orphanPath,
    locale: pathLocale(orphanPath),
    kind: resolution.kind,
    canonicalPath: resolution.canonicalPath,
    cohort,
  };
}

// ── Main ────────────────────────────────────────────────────────────────

function main() {
  const csvFiles = findCsvFiles();
  if (csvFiles.length === 0) {
    console.error('No GSC CSVs under download/');
    process.exitCode = 1;
    return;
  }

  const blogIdToSlug = loadBlogIdToSlug();
  console.log(`Loaded ${blogIdToSlug.size} blog article-id translations.`);

  const importedByPath = new Map();

  for (const file of csvFiles) {
    for (const url of parseCsvUrls(file)) {
      const p = normalizePath(url);
      const alias = classifyLegacyAlias(p, blogIdToSlug);
      if (alias) importedByPath.set(gscOrphanPathKey(alias.orphanPath), alias);
    }
  }

  let existingFile = { aliases: [] };
  if (fs.existsSync(OUT_PATH)) {
    existingFile = JSON.parse(fs.readFileSync(OUT_PATH, 'utf-8'));
    assertGscLegacyAliasSnapshot(existingFile, {
      file: path.relative(ROOT, OUT_PATH),
      validateRoute: (entry) => {
        const refreshed = classifyLegacyAlias(entry.orphanPath, blogIdToSlug);
        return refreshed?.locale === entry.locale && refreshed?.cohort === entry.cohort;
      },
    });
  }
  const imported = [...importedByPath.values()];
  const refreshedExisting = existingFile.aliases.map((entry) => {
    const refreshed = classifyLegacyAlias(entry.orphanPath, blogIdToSlug);
    if (!refreshed) throw new Error(`Unable to refresh legacy alias ${entry.orphanPath}; refusing to overwrite.`);
    return refreshed;
  });
  const aliases = mergeGscOrphanRecords(
    refreshedExisting,
    imported,
    (entry) => gscOrphanPathKey(entry.orphanPath),
  );
  const cohortCounts = aliases.reduce((counts, alias) => {
    counts[alias.cohort] = (counts[alias.cohort] || 0) + 1;
    return counts;
  }, {});

  console.log(`\nImported legacy aliases: ${imported.length}`);
  console.log(`Retained from prior imports (not present in this sample): ${Math.max(0, aliases.length - imported.length)}`);
  console.log(`Total tracked legacy aliases: ${aliases.length}`);
  console.log('By cohort:', cohortCounts);

  if (DRY_RUN) {
    console.log('\n--dry-run sample:');
    aliases.slice(0, 8).forEach((a) => console.log(`  [${a.locale}/${a.kind}] ${a.orphanPath} → ${a.canonicalPath}`));
    return;
  }

  const out = {
    generatedAt: new Date().toISOString(),
    counts: cohortCounts,
    aliases,
  };
  const tempPath = `${OUT_PATH}.${process.pid}.tmp`;
  fs.writeFileSync(tempPath, JSON.stringify(out, null, 2) + '\n', 'utf-8');
  fs.renameSync(tempPath, OUT_PATH);
  console.log(`\nWrote ${aliases.length} legacy-alias entries to ${path.relative(ROOT, OUT_PATH)}`);
}

const lock = withSingleFlightLock(`${OUT_PATH}.lock`, main);
if (!lock.acquired) {
  console.error(`✗ ${path.relative(ROOT, OUT_PATH)} is already being updated; retry after it completes.`);
  process.exitCode = 1;
}
