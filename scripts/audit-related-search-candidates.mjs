#!/usr/bin/env node
/**
 * Audit Phase-1 — Related-search slug candidates.
 *
 * Simulates what `buildRelatedSearches` (in `components/community/JobBoard.tsx`)
 * would emit as related-search anchors across every job × locale, then aggregates
 * into a per-slug candidate set with:
 *   - job-count (how many distinct jobs would emit this slug as a related-search)
 *   - editorial-collision flag (slug already exists as an editorial landing)
 *   - gsc-impression flag (slug present as a GSC orphan-query cluster key)
 *
 * Reads:  data/jobs.json, data/gsc-orphan-queries-clusters.json
 * Writes: data/related-search-candidates.json
 *
 * Prints a summary with frequency-cohort buckets so we can decide where to set
 * the gate threshold before emitting any actual landing pages.
 *
 * Logic ported from JobBoard.tsx (slugifyJobPart, sanitizeJobTitle,
 * RELATED_SEARCH_STOPWORDS, extractRelatedTopicTokens, isValidRelatedSearchTerm,
 * cleanCanonicalItems, buildSearchSlug, buildRelatedSearches) and from
 * jobEditorialLanding.ts (SUPPORTED_EDITORIAL_LOCATIONS, sector + type slugs,
 * resolveEditorialJobLandingDescriptor patterns).
 *
 * No code is emitted to dist/ — this is read-only audit.
 */

// NOTE: The helper functions and RELATED_SEARCH_STOPWORDS in this script
// are duplicated from services/relatedSearchClusters.ts because this file
// is .mjs and the source is .ts. Keep the two in sync — when you change
// one, mirror to the other.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const JOBS_PATH = path.join(ROOT, 'data', 'jobs.json');
const GSC_CLUSTERS_PATH = path.join(ROOT, 'data', 'gsc-orphan-queries-clusters.json');
const OUT_PATH = path.join(ROOT, 'data', 'related-search-candidates.json');

const LOCALES = ['it', 'en', 'de', 'fr'];

// ── Editorial-landing constants (mirror build-plugins/jobEditorialLanding.ts) ──

const SEARCH_PREFIX = { it: 'ricerca', en: 'search', de: 'suche', fr: 'recherche' };
const SECTION_SLUG = {
  it: 'cerca-lavoro-ticino',
  en: 'find-jobs-ticino',
  de: 'jobs-im-tessin',
  fr: 'trouver-emploi-tessin',
};

const EDITORIAL_LOCATIONS = [
  'Lugano', 'Bellinzona', 'Mendrisio', 'Locarno', 'Chiasso',
  'Chur', 'Davos', 'St. Moritz',
  'Sion', 'Brig', 'Visp', 'Martigny', 'Monthey', 'Sierre',
];

const CANTON_SLUGS = new Set([
  'ticino', 'tessin', 'grigioni', 'graubunden', 'grisons', 'vallese', 'valais', 'wallis',
]);

const SECTOR_SLUGS_BY_LOCALE = {
  it: ['sanita', 'finanza', 'tecnologia', 'ingegneria', 'amministrazione', 'ristorazione-hotel', 'vendite', 'informatica', 'vendita', 'ristorazione'],
  en: ['health', 'finance', 'tech', 'engineering', 'admin', 'hospitality', 'sales'],
  de: ['gesundheit', 'finanzen', 'technik', 'ingenieurwesen', 'verwaltung', 'gastgewerbe', 'vertrieb'],
  fr: ['sante', 'finance', 'tech', 'ingenierie', 'administration', 'hotellerie-restauration', 'vente'],
};

const TYPE_SLUGS_BY_LOCALE = {
  it: ['apprendistato', 'stage', 'part-time'],
  en: ['apprenticeship', 'internship', 'part-time'],
  de: ['lehrstelle', 'praktikum', 'teilzeit'],
  fr: ['apprentissage', 'stage', 'temps-partiel'],
};

const RECENCY_TODAY_SLUGS = new Set([
  'offerte-di-lavoro-ticino-oggi', 'ticino-jobs-today', 'jobs-tessin-heute', 'offres-emploi-tessin-aujourdhui',
  'offerte-di-lavoro-grigioni-oggi', 'graubunden-jobs-today', 'jobs-graubunden-heute', 'offres-emploi-grisons-aujourdhui',
  'offerte-di-lavoro-vallese-oggi', 'valais-jobs-today', 'jobs-wallis-heute', 'offres-emploi-valais-aujourdhui',
]);

const NURSES_HUB_SLUGS = new Set([
  'infermieri-in-ticino', 'nurses-in-ticino', 'pflege-jobs-im-tessin', 'infirmiers-au-tessin',
  'infermieri-in-grigioni', 'nurses-in-graubunden', 'pflege-jobs-in-graubunden', 'infirmiers-aux-grisons',
  'infermieri-in-vallese', 'nurses-in-valais', 'pflege-jobs-im-wallis', 'infirmiers-en-valais',
  'lavoro-infermieri-ticino', 'lavoro-infermieri',
]);

const PART_TIME_HUB_SLUGS = new Set([
  'lavoro-part-time', 'part-time-jobs', 'teilzeit-jobs', 'emploi-temps-partiel',
  'lavoro-part-time-ticino', 'part-time-jobs-ticino', 'teilzeit-jobs-tessin', 'emploi-temps-partiel-tessin',
  'lavoro-part-time-grigioni', 'part-time-jobs-graubunden', 'teilzeit-jobs-graubunden', 'emploi-temps-partiel-grisons',
  'lavoro-part-time-vallese', 'part-time-jobs-valais', 'teilzeit-jobs-wallis', 'emploi-temps-partiel-valais',
]);

const OFFICIAL_GAZETTE_SLUGS = new Set([
  'foglio-ufficiale-offerte-di-lavoro-ticino', 'official-gazette-ticino-jobs',
  'amtsblatt-stellen-tessin', 'feuille-officielle-emplois-tessin',
]);

// ── Ported helpers from JobBoard.tsx ──

// Mirror of components/community/JobBoard.tsx RELATED_SEARCH_STOPWORDS.
// Keep in sync — both lists must match for the audit to reflect what the
// production widget actually emits.
const RELATED_SEARCH_STOPWORDS = new Set([
  // IT
  'della', 'delle', 'dello', 'degli', 'dell', 'alla', 'alle', 'allo', 'agli', 'con', 'per', 'nel', 'nella', 'nelle',
  'sul', 'sulla', 'sulle', 'dei', 'del', 'di', 'da', 'tra', 'fra', 'che', 'chi', 'con', 'su', 'il', 'lo', 'la', 'i', 'gli', 'le',
  'anche', 'ancora', 'sempre', 'ogni', 'tutto', 'tutta', 'tutti', 'tutte', 'dopo', 'prima', 'sotto', 'sopra',
  'dentro', 'fuori', 'senza', 'molto', 'poco', 'tanto', 'questo', 'questa', 'questi', 'queste', 'quello', 'quella',
  'quelli', 'quelle', 'come', 'quando', 'dove', 'mentre', 'perche', 'hanno', 'sono', 'siamo', 'siete', 'sara',
  'saranno', 'noi', 'voi', 'loro', 'nostro', 'nostra', 'nostri', 'nostre', 'vostro', 'vostra', 'vostri', 'vostre',
  // EN
  'the', 'and', 'for', 'with', 'from', 'this', 'that', 'these', 'those', 'have', 'will', 'would', 'could', 'should',
  'only', 'even', 'also', 'some', 'more', 'most', 'much', 'many', 'well', 'your', 'ours', 'them', 'they', 'their',
  'into', 'after', 'before', 'about', 'where', 'while', 'when', 'than', 'what', 'which', 'been', 'were', 'being',
  // DE
  'der', 'die', 'das', 'und', 'sein', 'sind', 'ihre', 'ihren', 'deren', 'ihnen', 'haben', 'hatte', 'wird', 'werden',
  'wurde', 'worden', 'nicht', 'kein', 'keine', 'keinen', 'alle', 'alles', 'allen', 'aber', 'oder', 'doch', 'schon',
  'sehr', 'mehr', 'immer', 'noch', 'beim', 'dies', 'diese', 'dieser', 'dieses', 'diesen', 'ohne', 'gegen', 'durch',
  'sich', 'nach', 'wenn', 'dann', 'unter', 'ueber',
  'eine', 'einer', 'eines', 'einen', 'einem', 'deine', 'deiner', 'deinen', 'deinem', 'mein', 'meine', 'meiner', 'meinen',
  // FR
  'pour', 'avec', 'des', 'les', 'vous', 'votre', 'vos', 'nous', 'notre', 'nos', 'leur', 'leurs', 'dans', 'sans',
  'sous', 'vers', 'chez', 'mais', 'aussi', 'ainsi', 'encore', 'plus', 'sont', 'sera', 'seront', 'etre', 'avoir',
  'faire', 'autre', 'autres', 'meme', 'memes', 'cette', 'celle', 'celui', 'ceux', 'entre', 'avant', 'apres',
  'depuis', 'durant', 'lorsque', 'quand', 'comme', 'parce', 'alors', 'donc', 'ensuite', 'puis', 'toujours',
  'jamais', 'tres', 'bien', 'mieux', 'tout', 'tous', 'toute', 'toutes', 'aucun', 'chaque', 'plusieurs', 'certains',
  // Domain noise
  'lavoro', 'offerta', 'annuncio', 'job', 'jobs', 'stelle', 'emploi', 'emplois', 'posto', 'ruolo', 'position', 'ticino', 'svizzera',
  'team', 'teams', 'candidato', 'candidata', 'candidat', 'candidate', 'candidates', 'kandidat', 'kandidatin',
  'azienda', 'aziende', 'unternehmen', 'entreprise', 'company', 'companies', 'societa', 'societe',
  'experience', 'esperienza', 'erfahrung', 'erfahrungen',
  'client', 'clients', 'clienti', 'cliente', 'kunde', 'kunden', 'customer', 'customers',
]);

const DEFAULT_CANTON_DISPLAY = 'Ticino';

function slugifyJobPart(value) {
  return String(value || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 200);
}

function getSearchSlugPrefix(locale) {
  return SEARCH_PREFIX[locale] || 'ricerca';
}

function buildSearchSlug(term, locale) {
  const prefix = getSearchSlugPrefix(locale);
  const core = slugifyJobPart(term);
  return `${prefix}-${core || 'lavoro'}`;
}

function sanitizeJobTitle(raw) {
  const decoded = String(raw || '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&raquo;/gi, '»')
    .replace(/&laquo;/gi, '«')
    .replace(/<[^>]+>/g, ' ')
    .replace(/^#+\s*/, '')
    .replace(/\s+/g, ' ')
    .trim();
  return decoded
    .replace(/\b([A-Za-zÀ-ÖØ-öø-ÿ]{3,})\/([A-Za-zÀ-ÖØ-öø-ÿ]{1,3})\b/g, '$1 $2')
    .replace(/\s+,/g, ',')
    .trim() || decoded;
}

function cleanCanonicalItems(value, max = 12) {
  if (!Array.isArray(value)) return [];
  const seen = new Set();
  const out = [];
  for (const item of value) {
    const clean = String(item || '').replace(/\s+/g, ' ').trim();
    if (!clean || clean.length < 3) continue;
    const key = clean.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(clean);
    if (out.length >= max) break;
  }
  return out;
}

function extractRelatedTopicTokens(value, max = 8) {
  const counts = new Map();
  const tokens = String(value || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .map((t) => t.trim())
    .filter((t) => t.length >= 4 && !RELATED_SEARCH_STOPWORDS.has(t) && !/^\d+$/.test(t));
  for (const token of tokens) counts.set(token, (counts.get(token) || 0) + 1);
  return Array.from(counts.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, max)
    .map(([token]) => token);
}

function isValidRelatedSearchTerm(value) {
  const clean = String(value || '').replace(/\s+/g, ' ').trim();
  if (!clean) return false;
  if (clean.length < 3 || clean.length > 70) return false;
  if (clean.split(' ').length > 8) return false;
  return true;
}

function buildRelatedSearches({ job, locale }) {
  const title = sanitizeJobTitle(job.titleByLocale?.[locale] ?? job.title ?? '').replace(/\s+/g, ' ').trim();
  const shortTitle = title.split(/[-–—|•·]/)[0]?.trim() || title;
  const location = String(job.location || '').trim();
  const company = String(job.company || '').trim();

  // Body source: the slim jobs.json has flat description + requirements.
  // The SPA passes `summary` (3 items) + `requirements` from canonicalContent,
  // which is a SUBSET of the description. Using the full description here gives
  // an upper-bound estimate — fine for an audit.
  const description = job.descriptionByLocale?.[locale] ?? job.description ?? '';
  const requirements = job.requirementsByLocale?.[locale] ?? job.requirements ?? '';
  const requirementsText = Array.isArray(requirements) ? requirements.join(' ') : String(requirements);
  // Strip body tokens that equal the location itself (avoids self-duplicating
  // slugs like /suche-gossau-gossau/). Mirrors filter in JobBoard.tsx.
  const locationToken = String(location || DEFAULT_CANTON_DISPLAY)
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '');
  const bodyTokens = extractRelatedTopicTokens(`${description} ${requirementsText}`, 6)
    .filter((token) => token !== locationToken);

  const generated = locale === 'it'
    ? bodyTokens.map((token) => `${token} ${location || DEFAULT_CANTON_DISPLAY.toLowerCase()}`.trim())
    : bodyTokens.map((token) => `${token} ${location}`.trim());

  // N2 decision (2026-05-06): drop `${company} ${location}` — that intent is
  // already covered by the `azienda-*` / `company-*` slug family
  // (parseCompanySlugFilter, JobBoard.tsx:2228). Keeping it would duplicate
  // company-hub pages at /search-{company}-{city}/ and /azienda-{company}/.
  // N3 decision: KEEP the template-string candidates (offerte lavoro / salary
  // switzerland / requirements) — they may capture long-tail Google queries.
  const candidates = cleanCanonicalItems([
    shortTitle,
    `${shortTitle} ${location}`.trim(),
    `${shortTitle} ${company}`.trim(),
    // `${company} ${location}` removed (N2 filter)
    ...(locale === 'it'
      ? [
        `offerte lavoro ${shortTitle}`.trim(),
        `stipendio ${shortTitle} svizzera`.trim(),
        `mansioni ${shortTitle}`.trim(),
      ]
      : [
        `${shortTitle} salary switzerland`.trim(),
        `${shortTitle} requirements`.trim(),
      ]),
    ...generated,
  ], 24);

  return candidates.filter(isValidRelatedSearchTerm).slice(0, 10);
}

// ── Editorial-landing collision detection ──

/**
 * Returns a label like "location-only", "location-sector", "sector-region", etc.
 * if the bare slug (without "search-"/"ricerca-" prefix) collides with an
 * editorial landing pattern. Returns null otherwise.
 */
function detectEditorialCollision(bareSlug, locale) {
  if (!bareSlug) return null;
  if (RECENCY_TODAY_SLUGS.has(bareSlug)) return 'today';
  if (NURSES_HUB_SLUGS.has(bareSlug)) return 'nurses-hub';
  if (PART_TIME_HUB_SLUGS.has(bareSlug)) return 'part-time';
  if (OFFICIAL_GAZETTE_SLUGS.has(bareSlug)) return 'official-gazette';
  // last-3-days / since-yesterday recency
  if (/^(last-3-days|negli-ultimi-3-giorni|letzte-3-tage|derniers-3-jours|since-yesterday|da-ieri|seit-gestern|depuis-hier)/.test(bareSlug)) return 'recency';

  const parts = bareSlug.split('-');
  if (parts.length < 1) return null;

  const sectorSlugs = SECTOR_SLUGS_BY_LOCALE[locale] || [];
  const typeSlugs = TYPE_SLUGS_BY_LOCALE[locale] || [];
  const locationSlugs = new Set(EDITORIAL_LOCATIONS.map((loc) => slugifyJobPart(loc)));

  // location-only: e.g. "bellinzona"
  if (parts.length === 1 && locationSlugs.has(parts[0])) return 'location-only';

  // location-{sector|type}: "bellinzona-tech" / "bellinzona-part-time"
  if (parts.length >= 2 && locationSlugs.has(parts[0])) {
    const tail = parts.slice(1).join('-');
    if (sectorSlugs.includes(tail)) return 'location-sector';
    if (typeSlugs.includes(tail)) return 'location-type';
  }

  // sector-region: "tech-ticino" / "sanita-grigioni"
  if (parts.length >= 2 && CANTON_SLUGS.has(parts[parts.length - 1])) {
    const head = parts.slice(0, -1).join('-');
    if (sectorSlugs.includes(head)) return 'sector-region';
  }

  // sector-only: "sanita" / "tech"
  if (parts.length === 1 && sectorSlugs.includes(parts[0])) return 'sector-region';

  return null;
}

// ── Main ──

function main() {
  if (!fs.existsSync(JOBS_PATH)) {
    console.error(`✗ ${JOBS_PATH} not found. Run: node scripts/assemble-jobs-dataset.mjs`);
    process.exit(1);
  }
  const jobs = JSON.parse(fs.readFileSync(JOBS_PATH, 'utf8'));
  const gscClustersRaw = fs.existsSync(GSC_CLUSTERS_PATH)
    ? JSON.parse(fs.readFileSync(GSC_CLUSTERS_PATH, 'utf8'))
    : { clusters: [] };
  const gscSlugSet = new Set(
    (gscClustersRaw.clusters || []).map((c) => `${c.locale}::${c.canonicalSlug}`)
  );

  console.log(`Loaded ${jobs.length} jobs, ${gscSlugSet.size} GSC clusters.`);

  /** Map<key, {slug, locale, jobCount, sampleJobIds:[], sampleTerms:Set}>  key = `${locale}::${slug}` */
  const candidates = new Map();
  let totalEmissions = 0;

  for (const job of jobs) {
    for (const locale of LOCALES) {
      const terms = buildRelatedSearches({ job, locale });
      for (const term of terms) {
        const slug = buildSearchSlug(term, locale);
        const key = `${locale}::${slug}`;
        let entry = candidates.get(key);
        if (!entry) {
          entry = { slug, locale, jobCount: 0, sampleJobIds: [], sampleTerms: new Set() };
          candidates.set(key, entry);
        }
        entry.jobCount += 1;
        if (entry.sampleJobIds.length < 3) entry.sampleJobIds.push(job.id || job.slug);
        if (entry.sampleTerms.size < 3) entry.sampleTerms.add(term);
        totalEmissions += 1;
      }
    }
  }

  // Append-only merge with previous audit's candidates.
  //
  // Why: jobs expire as crawlers refresh, which means slugs that were valid
  // at past audit times (and that Google has since indexed) drop out of the
  // current jobCount-from-fresh-jobs.json calculation. If we hard-reset the
  // candidates JSON on every audit, those URLs go orphan in production →
  // 404 in GSC even though the cluster plugin's OR-fill matching could
  // still serve them with relevant content from current jobs.
  //
  // Merge strategy: load any existing candidates, merge with the new map
  // keyed by `${locale}::${slug}`, and dedup so each (locale, slug) pair
  // appears once. For duplicates we keep the MAX jobCount (so highest
  // frequency ever observed wins), the union of sampleTerms (capped at 5),
  // and the most recent sampleJobIds. Synthetic entries with gscMatch=true
  // (from ingest-gsc-orphans-into-candidates.mjs) are preserved as-is when
  // the audit doesn't see them this run.
  let mergedHistorical = 0;
  let mergedReinforced = 0;
  if (fs.existsSync(OUT_PATH)) {
    let prev;
    try {
      prev = JSON.parse(fs.readFileSync(OUT_PATH, 'utf-8'));
    } catch {
      prev = null;
    }
    if (prev && Array.isArray(prev.candidates)) {
      for (const old of prev.candidates) {
        if (!old || !old.slug || !old.locale) continue;
        const key = `${old.locale}::${old.slug}`;
        const cur = candidates.get(key);
        if (!cur) {
          // Historical-only: not produced by current jobs but kept alive.
          // Copy as-is, ensure sampleTerms is a plain array (not a Set).
          candidates.set(key, {
            slug: old.slug,
            locale: old.locale,
            jobCount: Math.max(1, Number(old.jobCount) || 0),
            sampleJobIds: Array.isArray(old.sampleJobIds) ? old.sampleJobIds.slice(0, 3) : [],
            sampleTerms: new Set(Array.isArray(old.sampleTerms) ? old.sampleTerms : []),
            historical: true,
            ...(old.gscMatch ? { gscMatch: true } : {}),
            ...(old.gscOrigin ? { gscOrigin: old.gscOrigin } : {}),
          });
          mergedHistorical++;
        } else {
          // Both sides have it: keep max jobCount + union of sampleTerms.
          cur.jobCount = Math.max(cur.jobCount, Number(old.jobCount) || 0);
          if (Array.isArray(old.sampleTerms)) {
            for (const t of old.sampleTerms) {
              if (cur.sampleTerms.size >= 5) break;
              cur.sampleTerms.add(t);
            }
          }
          mergedReinforced++;
        }
      }
    }
  }
  console.log(`Append-only merge: ${mergedHistorical} historical-only entries kept, ${mergedReinforced} reinforced.`);

  // Enrich with editorial-collision and GSC flags
  for (const entry of candidates.values()) {
    const bareSlug = entry.slug.replace(/^(ricerca|search|suche|recherche)-/, '');
    entry.editorialCollision = detectEditorialCollision(bareSlug, entry.locale);
    // gscMatch from the orphan-queries dataset is independent of any
    // gscMatch flag preserved during the historical merge above. OR them
    // so a merged-historical entry still shows in the GSC-impressions gates.
    entry.gscMatch = entry.gscMatch === true || gscSlugSet.has(`${entry.locale}::${bareSlug}`);
    entry.sampleTerms = Array.from(entry.sampleTerms);
  }

  // Frequency cohorts
  const cohorts = {
    '1 (singleton)': 0,
    '2': 0,
    '3-4': 0,
    '5-9': 0,
    '10-19': 0,
    '20-49': 0,
    '50-99': 0,
    '100+': 0,
  };
  let editorialCollisions = 0;
  let gscMatches = 0;
  const byLocale = { it: 0, en: 0, de: 0, fr: 0 };

  for (const entry of candidates.values()) {
    const c = entry.jobCount;
    if (c === 1) cohorts['1 (singleton)']++;
    else if (c === 2) cohorts['2']++;
    else if (c <= 4) cohorts['3-4']++;
    else if (c <= 9) cohorts['5-9']++;
    else if (c <= 19) cohorts['10-19']++;
    else if (c <= 49) cohorts['20-49']++;
    else if (c <= 99) cohorts['50-99']++;
    else cohorts['100+']++;
    if (entry.editorialCollision) editorialCollisions++;
    if (entry.gscMatch) gscMatches++;
    byLocale[entry.locale]++;
  }

  // Top-50 candidates by frequency, excluding editorial collisions
  const ranked = Array.from(candidates.values())
    .filter((e) => !e.editorialCollision)
    .sort((a, b) => b.jobCount - a.jobCount);

  // Gate-projection scenarios
  const projections = [
    { label: 'Gate A — frequency ≥ 3 (no GSC required)', min: 3, gscRequired: false },
    { label: 'Gate A — frequency ≥ 5', min: 5, gscRequired: false },
    { label: 'Gate A — frequency ≥ 10', min: 10, gscRequired: false },
    { label: 'Gate B — frequency ≥ 3 AND GSC impressions', min: 3, gscRequired: true },
    { label: 'Gate B — frequency ≥ 1 AND GSC impressions', min: 1, gscRequired: true },
  ];
  const projectionResults = projections.map(({ label, min, gscRequired }) => {
    const passing = ranked.filter((e) => e.jobCount >= min && (!gscRequired || e.gscMatch));
    return { label, count: passing.length, byLocale: tally(passing, 'locale') };
  });

  // Output
  const output = {
    generatedAt: new Date().toISOString(),
    sources: {
      jobsPath: 'data/jobs.json',
      gscClustersPath: 'data/gsc-orphan-queries-clusters.json',
    },
    inputs: {
      totalJobs: jobs.length,
      totalLocales: LOCALES.length,
      totalGscClusters: gscSlugSet.size,
    },
    summary: {
      totalUniqueSlugs: candidates.size,
      totalEmissions,
      editorialCollisions,
      gscMatches,
      byLocale,
      cohorts,
      projections: projectionResults,
    },
    topNonEditorialCandidates: ranked.slice(0, 50),
    candidates: ranked,
  };
  fs.writeFileSync(OUT_PATH, JSON.stringify(output, null, 2));

  // Stdout summary
  console.log('');
  console.log('═══════════════════════════════════════════════════════');
  console.log(`AUDIT — Related-search slug candidates`);
  console.log('═══════════════════════════════════════════════════════');
  console.log(`Unique slugs:        ${candidates.size.toLocaleString()}`);
  console.log(`Total emissions:     ${totalEmissions.toLocaleString()}  (job × locale × term)`);
  console.log(`Editorial collisions:${editorialCollisions.toLocaleString()}  (would conflict with existing landing)`);
  console.log(`GSC matches:         ${gscMatches.toLocaleString()}  (slug exists as GSC orphan-query cluster)`);
  console.log('');
  console.log('By locale:');
  for (const [k, v] of Object.entries(byLocale)) console.log(`  ${k}: ${v.toLocaleString()}`);
  console.log('');
  console.log('Frequency cohorts (how many distinct jobs emit each slug):');
  for (const [bucket, count] of Object.entries(cohorts)) {
    console.log(`  ${bucket.padEnd(15)} ${count.toLocaleString()}`);
  }
  console.log('');
  console.log('Gate projections (slugs that would be promoted, after stripping editorial collisions):');
  for (const p of projectionResults) {
    console.log(`  ${p.label.padEnd(56)} → ${p.count.toLocaleString()}  ${JSON.stringify(p.byLocale)}`);
  }
  console.log('');
  console.log('Top 15 non-editorial candidates by frequency:');
  for (const e of ranked.slice(0, 15)) {
    const flag = e.gscMatch ? ' [GSC ✓]' : '';
    console.log(`  ${String(e.jobCount).padStart(4)}× ${e.locale}  /${e.slug}/${flag}  «${e.sampleTerms[0]}»`);
  }
  console.log('');
  console.log(`✓ Wrote ${OUT_PATH}`);
}

function tally(arr, key) {
  const out = {};
  for (const item of arr) {
    const k = item[key];
    out[k] = (out[k] || 0) + 1;
  }
  return out;
}

main();
