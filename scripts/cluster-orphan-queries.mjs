#!/usr/bin/env node
/**
 * cluster-orphan-queries.mjs
 *
 * Reads `data/gsc-orphan-queries.json` (a map { orphanSlug: [{query, clicks, impressions}] })
 * produced by `sync-gsc-orphans.mjs`, clusters queries by role + region tokens,
 * and writes `data/gsc-orphan-queries-clusters.json` consumed by
 * `build-plugins/orphanQueryLandingPlugin.ts`.
 *
 * Clustering rules:
 *   - Normalize + tokenize each query (lowercase, strip diacritics, remove
 *     stopwords, apply very-light multi-language stems).
 *   - Detect locale heuristically from diagnostic tokens (IT/DE/EN/FR).
 *   - Signature = `${locale}|<sorted role tokens>|<region tokens>`.
 *   - Merge queries sharing a signature into a cluster.
 *
 * Gates (applied here):
 *   - Cluster must reach ≥5 cumulative impressions (thin-content
 *     guardrails live downstream in the build plugin:
 *     `MIN_MATCHING_JOBS = 3` and `MIN_INDEXABLE_WORDS` decide
 *     indexability, so we can afford a lower impression floor here
 *     to surface more long-tail orphan queries as candidates).
 *   - Cluster canonical slug must NOT match a known job URL
 *     in `data/all-known-job-slugs.json` (skip to avoid doorway duplicates).
 *
 * Note: the "≥3 matching jobs" gate is data-dependent (jobs.json is large +
 * crawler slices live in data/jobs/by-crawler) and is enforced at BUILD TIME
 * by the plugin, not here. We only write the candidate clusters.
 *
 * Usage:
 *   node scripts/cluster-orphan-queries.mjs
 *   node scripts/cluster-orphan-queries.mjs --dry-run
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const DRY_RUN = process.argv.includes('--dry-run');

const MIN_CLUSTER_IMPRESSIONS = 5;

// ─── Stopword sets (IT/EN/DE/FR) ──────────────────────────────────
const STOPWORDS = new Set([
  // Italian
  'a','al','alla','allo','alle','ai','agli','di','da','del','dello','della','dei','degli','delle',
  'in','un','uno','una','con','per','il','lo','la','gli','le','e','ed','o','od','che','chi','ciò',
  'ciao','come','cosa','cui','ne','non','più','meno','essere','io','mi','tu','ti','si','ci','vi',
  'sono','loro','nostro','vostro','su','sul','sulla','sulle','sui','sugli','tra','fra','dopo',
  'prima','senza','questa','questo','questi','queste','quel','quella','quello',
  // English
  'the','of','in','for','to','and','or','a','an','with','at','by','from','on','off','up','down',
  'as','is','are','be','been','being','has','have','had','do','does','did','will','would','should',
  'can','could','may','might','must','shall','not','no',
  // German
  'der','die','das','den','dem','des','ein','eine','einen','einem','einer','eines','und','oder',
  'mit','bei','in','im','am','an','auf','zu','von','aus','für','durch','um','nach','vor','ohne',
  'gegen','zwischen','über','unter','hinter','neben','sein','ist','bin','bist','sind','seid',
  // French
  'le','la','les','l','un','une','des','du','de','d','et','ou','où','pour','par','avec','sans',
  'dans','en','sur','sous','vers','chez','aux','au','à','ce','ces','cette','ses','son','sa',
  // Generic job words — kept OUT of stopwords because they're part of role signal
]);

// Minimal multi-language stemming: remove common plural/gender endings.
const STEM_RULES = [
  /innen?$/,   // DE fem. plural → root  (Mitarbeiterinnen → Mitarbeiter)
  /euse$/,     // FR fem. suffix → eur   (chauffeuse → chauff)
  /teur$/, /teuse$/,
  /eurs?$/,    // FR → eur
  /ieres?$/,   // IT/FR fem.
  /iere$/,
  /ori$/, /ore$/, /ori$/, /ice$/, /ici$/, // IT
  /i$/, /e$/, /o$/, /a$/, // IT/generic final-vowel trim as very-last step
  /ing$/,      // EN gerund
  /s$/,        // EN plural
];

function stemToken(tok) {
  if (!tok) return tok;
  if (tok.length <= 3) return tok;
  // Apply the first rule that strips at least one char and leaves ≥3 chars remaining.
  for (const rule of STEM_RULES) {
    const next = tok.replace(rule, '');
    if (next.length >= 3 && next.length < tok.length) return next;
  }
  return tok;
}

// ─── Locale detection heuristics ──────────────────────────────────
const LOCALE_HINTS = {
  it: ['lavoro','lavori','offerta','offerte','assunzione','assume','assunzioni','aziende','stipendio','posti','posto','cerca','cerco','ticino','svizzera','italiani','lugano','mendrisio','chiasso','bellinzona','locarno','frontaliere','concorso','concorsi'],
  de: ['jobs','job','stellen','stelle','arbeit','arbeits','schweiz','tessin','stellenangebote','stellenangebot','mitarbeiter','mitarbeiterin','suche','offene','stellensuche','als','bei','für'],
  en: ['jobs','job','work','switzerland','swiss','ticino','employment','careers','career','vacancies','vacancy','hiring','engineer','developer','nurse','nurses'],
  fr: ['emploi','emplois','travail','suisse','tessin','offres','offre','recherche','poste','postes','carriere','postuler','chauffeur'],
};

function detectLocale(tokens) {
  const scores = { it: 0, de: 0, en: 0, fr: 0 };
  for (const t of tokens) {
    for (const [loc, hints] of Object.entries(LOCALE_HINTS)) {
      if (hints.includes(t)) scores[loc] += 1;
    }
  }
  let best = 'it';
  let bestScore = -1;
  for (const loc of ['it','de','en','fr']) {
    if (scores[loc] > bestScore) { best = loc; bestScore = scores[loc]; }
  }
  // If all zero, default to IT (primary locale of the site).
  return best;
}

// ─── Tokenization ─────────────────────────────────────────────────
function normalize(s) {
  return String(s || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9\s-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function tokenize(q) {
  const norm = normalize(q);
  if (!norm) return [];
  return norm
    .split(/[\s-]+/)
    .filter(t => t.length >= 2 && !STOPWORDS.has(t));
}

// ─── Region / role token separation ────────────────────────────────
// "Region" is any geographic term we recognize; everything else is a role token.
const REGION_TOKENS = new Set([
  // Ticino towns + cantons
  'ticino','tessin','lugano','mendrisio','chiasso','bellinzona','locarno','biasca',
  'stabio','balerna','giubiasco','massagno','manno','paradiso','melide',
  // Swiss cantons + top cities
  'svizzera','schweiz','swiss','suisse','switzerland',
  'zurigo','zurich','zürich','basilea','basel','ginevra','geneve','geneva',
  'berna','bern','lucerna','luzern','lucerne','losanna','lausanne','friburgo',
  'friborgo','fribourg','sangallo','gallen','vallese','valais','valle','grigioni',
  'graubunden','graubünden','neuchatel','neuenburg','wallis','jura','vaud',
  'solothurn','soletta','uri','zug','aargau','argovia',
  // Italian near-border (cross-border relevance)
  'como','varese','milano','lecco','sondrio',
  // Generic
  'ci','ch','italia','italy','italien',
]);

function splitRoleRegion(tokens) {
  const role = [];
  const region = [];
  for (const t of tokens) {
    if (REGION_TOKENS.has(t)) region.push(t);
    else role.push(t);
  }
  return { role, region };
}

function canonicalizeRegion(tokens) {
  // Collapse synonyms so clusters merge across locales.
  const canon = tokens.map(t => {
    if (['ticino','tessin'].includes(t)) return 'ticino';
    if (['svizzera','schweiz','swiss','suisse','switzerland'].includes(t)) return 'svizzera';
    if (['zurigo','zurich','zürich'].includes(t)) return 'zurigo';
    if (['basilea','basel'].includes(t)) return 'basilea';
    if (['ginevra','geneve','geneva'].includes(t)) return 'ginevra';
    if (['berna','bern'].includes(t)) return 'berna';
    if (['lucerna','luzern','lucerne'].includes(t)) return 'lucerna';
    if (['losanna','lausanne'].includes(t)) return 'losanna';
    if (['grigioni','graubunden','graubünden'].includes(t)) return 'grigioni';
    if (['vallese','valais','wallis'].includes(t)) return 'vallese';
    if (['friburgo','friborgo','fribourg'].includes(t)) return 'friburgo';
    return t;
  });
  // Dedup and sort for stable signature
  return [...new Set(canon)].sort();
}

function canonicalizeRole(tokens) {
  const stems = tokens.map(stemToken).filter(Boolean);
  return [...new Set(stems)].sort();
}

// ─── Slugify for cluster canonical slug ────────────────────────────
function slugify(s) {
  return String(s || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
}

// ─── Main ─────────────────────────────────────────────────────────
function readJsonSafe(p) {
  try {
    if (!fs.existsSync(p)) return null;
    return JSON.parse(fs.readFileSync(p, 'utf-8'));
  } catch {
    return null;
  }
}

function main() {
  const inputPath = path.join(ROOT, 'data', 'gsc-orphan-queries.json');
  const knownSlugsPath = path.join(ROOT, 'data', 'all-known-job-slugs.json');
  const outputPath = path.join(ROOT, 'data', 'gsc-orphan-queries-clusters.json');

  const input = readJsonSafe(inputPath);
  if (!input || typeof input !== 'object') {
    console.warn(`[cluster-orphan-queries] missing or invalid ${inputPath} — writing empty clusters file`);
    const empty = { generatedAt: new Date().toISOString(), clusters: [] };
    if (!DRY_RUN) {
      fs.mkdirSync(path.dirname(outputPath), { recursive: true });
      fs.writeFileSync(outputPath, JSON.stringify(empty, null, 2) + '\n');
    }
    console.log('[cluster-orphan-queries] wrote 0 clusters');
    return;
  }

  // Flatten queries and dedup by normalized query text
  const queryMap = new Map(); // norm → aggregated
  for (const [, entries] of Object.entries(input)) {
    if (!Array.isArray(entries)) continue;
    for (const e of entries) {
      const raw = String(e?.query || '').trim();
      if (!raw) continue;
      const norm = normalize(raw);
      if (!norm) continue;
      const existing = queryMap.get(norm);
      if (existing) {
        existing.clicks += Number(e.clicks) || 0;
        existing.impressions += Number(e.impressions) || 0;
      } else {
        queryMap.set(norm, {
          query: raw,
          normalized: norm,
          clicks: Number(e.clicks) || 0,
          impressions: Number(e.impressions) || 0,
        });
      }
    }
  }

  // Group by signature
  const sigToCluster = new Map();

  for (const q of queryMap.values()) {
    const tokens = tokenize(q.query);
    if (tokens.length === 0) continue;
    const locale = detectLocale(tokens);
    const { role, region } = splitRoleRegion(tokens);
    if (role.length === 0) continue; // need at least one role token
    const roleCanon = canonicalizeRole(role);
    const regionCanon = canonicalizeRegion(region);
    const sig = `${locale}|${roleCanon.join(',')}|${regionCanon.join(',')}`;

    if (!sigToCluster.has(sig)) {
      sigToCluster.set(sig, {
        signature: sig,
        locale,
        roleTokens: roleCanon,
        regionTokens: regionCanon,
        queries: [],
        totalImpressions: 0,
        totalClicks: 0,
      });
    }
    const c = sigToCluster.get(sig);
    c.queries.push({
      query: q.query,
      clicks: q.clicks,
      impressions: q.impressions,
    });
    c.totalImpressions += q.impressions;
    c.totalClicks += q.clicks;
  }

  // Build known slugs set (to avoid doorway duplicates against real job URLs)
  const knownSlugs = new Set();
  const known = readJsonSafe(knownSlugsPath) || {};
  if (known && typeof known === 'object') {
    for (const [k, entry] of Object.entries(known)) {
      if (typeof k === 'string') knownSlugs.add(k);
      if (entry && typeof entry === 'object') {
        for (const v of Object.values(entry)) {
          if (typeof v === 'string') {
            const parts = v.split('/').filter(Boolean);
            if (parts.length) knownSlugs.add(parts[parts.length - 1]);
          }
        }
      }
    }
  }

  // Pick canonical query (highest impressions) + derive slug
  const clusters = [];
  for (const c of sigToCluster.values()) {
    // Sort queries within cluster by impressions desc
    c.queries.sort((a, b) => b.impressions - a.impressions);
    if (c.queries.length === 0) continue;

    const canonicalQuery = c.queries[0].query;
    const canonicalSlug = slugify(canonicalQuery);

    // Gate 1: impressions
    if (c.totalImpressions < MIN_CLUSTER_IMPRESSIONS) continue;
    // Gate 2: avoid collision with an already-tracked job slug
    if (knownSlugs.has(canonicalSlug)) continue;

    clusters.push({
      clusterId: `${c.locale}-${canonicalSlug}`,
      locale: c.locale,
      canonicalQuery,
      canonicalSlug,
      roleTokens: c.roleTokens,
      regionTokens: c.regionTokens,
      totalImpressions: c.totalImpressions,
      totalClicks: c.totalClicks,
      queries: c.queries,
    });
  }

  // Sort by impressions desc for deterministic output
  clusters.sort((a, b) => b.totalImpressions - a.totalImpressions);

  const out = {
    generatedAt: new Date().toISOString(),
    sourceFile: 'data/gsc-orphan-queries.json',
    totalClusters: clusters.length,
    gates: { minClusterImpressions: MIN_CLUSTER_IMPRESSIONS },
    clusters,
  };

  if (DRY_RUN) {
    console.log('[cluster-orphan-queries] DRY RUN — would write', clusters.length, 'clusters');
  } else {
    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
    fs.writeFileSync(outputPath, JSON.stringify(out, null, 2) + '\n');
    console.log(`[cluster-orphan-queries] wrote ${clusters.length} clusters to ${path.relative(ROOT, outputPath)}`);
  }

  if (clusters.length > 0) {
    console.log('Top 10 clusters:');
    for (const c of clusters.slice(0, 10)) {
      console.log(`  ${String(c.totalImpressions).padStart(5)} imp  [${c.locale}]  "${c.canonicalQuery}"  → /${c.canonicalSlug}`);
    }
  }
}

main();
