#!/usr/bin/env node
/**
 * AI enrichment pipeline for related-search cluster landing pages.
 *
 * Reads `data/related-search-candidates.json`, filters down to clusters that
 * pass the inclusion gate (`jobCount >= 5` AND `editorialCollision === null`),
 * and produces an 80-120 word intro + 3 FAQ Q&A per cluster, in its locale.
 *
 * Output is written to `data/related-search-enriched.json` and is incremental:
 * a per-candidate `cachedFor` hash skips entries that have not changed.
 *
 * Phase 2 of related-search cluster URL canonicalization. The intro/FAQ are
 * rendered inside a collapsed <details> below the job listings (~1,586 pages).
 *
 * Usage:
 *   node scripts/enrich-related-search-clusters.mjs              # incremental, all locales
 *   node scripts/enrich-related-search-clusters.mjs --dry-run    # show what would be enriched
 *   node scripts/enrich-related-search-clusters.mjs --limit=20   # top 20 by jobCount
 *   node scripts/enrich-related-search-clusters.mjs --locale=it  # one locale only
 *   node scripts/enrich-related-search-clusters.mjs --force      # ignore cache
 *   node scripts/enrich-related-search-clusters.mjs --verbose    # log each call
 */

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  callLLM,
  AI_MODELS,
  getStats as getAiStats,
  isAnyModelAvailable,
  printRunSummary,
} from './lib/ai-models.mjs';

// ── Paths ──────────────────────────────────────────────────────────────
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const ROOT = resolve(__dirname, '..');
const INPUT_PATH = resolve(ROOT, 'data', 'related-search-candidates.json');
const OUTPUT_PATH = resolve(ROOT, 'data', 'related-search-enriched.json');

// ── Constants ──────────────────────────────────────────────────────────
const SUPPORTED_LOCALES = ['it', 'en', 'de', 'fr'];
const CONCURRENCY = 5;
const MIN_WORDS = 80;
const MAX_WORDS = 130; // 120 target + small tolerance
const FAQ_COUNT = 3;
const FAQ_ANSWER_MAX_WORDS = 80;
const FAQ_QUESTION_MAX_CHARS = 80;

// Verbatim copy of the Swiss city detector list used by the editorial-landing
// build plugin (build-plugins/jobEditorialLanding.ts). Keep these in sync if
// the plugin's list grows.
const KNOWN_CITIES = [
  'Lugano', 'Bellinzona', 'Mendrisio', 'Locarno', 'Chiasso',
  'Chur', 'Davos', 'St. Moritz',
  'Sion', 'Brig', 'Visp', 'Martigny', 'Monthey', 'Sierre',
  'Zurich', 'Zürich', 'Basel', 'Bern', 'Geneva', 'Genève', 'Lausanne',
  // Common Swiss cities also seen in slugs
  'Winterthur', 'Lucerne', 'Luzern', 'Fribourg', 'Neuchâtel', 'Neuchatel',
  'Aarau', 'Zug', 'Schaffhausen', 'Thun', 'Biel', 'Bienne',
  'Lugano-Paradiso', 'Locarno-Muralto',
];

const LOCALE_NAMES = {
  it: 'Italian',
  en: 'English',
  de: 'German',
  fr: 'French',
};

// ── CLI parsing (no minimist) ──────────────────────────────────────────
function parseArgs(argv) {
  const args = { dryRun: false, limit: null, locale: null, force: false, verbose: false };
  for (const a of argv.slice(2)) {
    if (a === '--dry-run') args.dryRun = true;
    else if (a === '--force') args.force = true;
    else if (a === '--verbose') args.verbose = true;
    else if (a.startsWith('--limit=')) args.limit = Number.parseInt(a.slice('--limit='.length), 10);
    else if (a.startsWith('--locale=')) args.locale = a.slice('--locale='.length).toLowerCase();
    else if (a === '--help' || a === '-h') {
      console.log('Usage: enrich-related-search-clusters.mjs [--dry-run] [--limit=N] [--locale=it|en|de|fr] [--force] [--verbose]');
      process.exit(0);
    } else {
      console.error(`Unknown flag: ${a}`);
      process.exit(2);
    }
  }
  if (args.locale && !SUPPORTED_LOCALES.includes(args.locale)) {
    console.error(`Invalid --locale: ${args.locale} (expected one of ${SUPPORTED_LOCALES.join(',')})`);
    process.exit(2);
  }
  if (args.limit !== null && (!Number.isFinite(args.limit) || args.limit <= 0)) {
    console.error(`Invalid --limit: must be a positive integer`);
    process.exit(2);
  }
  return args;
}

// ── Hashing for cache ──────────────────────────────────────────────────
function cacheKey(c) {
  return createHash('sha256')
    .update(JSON.stringify({
      slug: c.slug,
      locale: c.locale,
      sampleTerms: c.sampleTerms,
      jobCount: c.jobCount,
    }))
    .digest('hex')
    .slice(0, 16);
}

// ── Keyword + city detection ───────────────────────────────────────────
/**
 * Take the first sample term and split off a trailing city. Returns
 * `{ keyword, city }` where `city` may be null.
 */
function extractKeywordAndCity(sampleTerms) {
  const raw = (sampleTerms && sampleTerms[0]) || '';
  const cleaned = String(raw).trim().replace(/\s+/g, ' ');
  if (!cleaned) return { keyword: '', city: null };

  // Try to match a known city as the trailing token (case-insensitive).
  // Cities are sorted longest-first so multi-word matches win.
  const cities = [...KNOWN_CITIES].sort((a, b) => b.length - a.length);
  const lower = cleaned.toLowerCase();
  for (const city of cities) {
    const cityLower = city.toLowerCase();
    if (lower === cityLower) {
      // The whole term IS a city — keyword is the city itself, no separate city.
      return { keyword: cleaned, city: cleaned };
    }
    // Trailing match: " Lugano" at the end, with optional separator
    const trailingRegex = new RegExp(`[\\s,/-]+${cityLower.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`);
    if (trailingRegex.test(lower)) {
      const keyword = cleaned.replace(/[\s,/-]+\S+$/, '').trim();
      return { keyword: keyword || cleaned, city };
    }
  }
  return { keyword: cleaned, city: null };
}

// ── Prompt builder ─────────────────────────────────────────────────────
function buildPrompt({ keyword, city, locale, jobCount }) {
  const localeName = LOCALE_NAMES[locale] || 'Italian';
  const cityClause = city
    ? `targeting "${keyword}" jobs in ${city} (Switzerland)`
    : `targeting "${keyword}" jobs in Ticino / Italian-speaking Switzerland`;

  const frontaliereContext = [
    'Audience: cross-border workers ("frontalieri") who live in northern Italy and commute to jobs in Italian-speaking Switzerland (Ticino, Graubünden, Valais).',
    'Tone: factual, journalistic, helpful. No sales-y language. No emojis. No HTML.',
    'Mention the frontaliere/cross-border angle ONLY if it is relevant to the keyword (e.g. salary, permits, commuting, taxation). For neutral keywords, focus on the role and the local labor market.',
  ].join(' ');

  return [
    {
      role: 'system',
      content: [
        'You write SEO landing-page content for a Swiss-Italian job board.',
        'Reply with VALID JSON ONLY — no markdown fences, no commentary.',
        `All copy MUST be in ${localeName} (locale "${locale}").`,
      ].join(' '),
    },
    {
      role: 'user',
      content: [
        `Generate landing-page content for a job-board cluster page ${cityClause}.`,
        `Currently ${jobCount} job listings are aggregated under this search.`,
        '',
        frontaliereContext,
        '',
        'Return JSON with this exact shape:',
        '{',
        '  "intro": "<80-120 word prose paragraph, single paragraph, no line breaks>",',
        `  "faqs": [`,
        `    {"q": "<question, max ${FAQ_QUESTION_MAX_CHARS} chars>", "a": "<answer, max ${FAQ_ANSWER_MAX_WORDS} words>"},`,
        `    {"q": "...", "a": "..."},`,
        `    {"q": "...", "a": "..."}`,
        '  ]',
        '}',
        '',
        'Hard rules:',
        `- intro: 80-120 words, plain prose, no HTML, no list markers, no headings.`,
        `- exactly ${FAQ_COUNT} FAQs.`,
        `- Each question is a real question a candidate might type.`,
        `- Answers should be concrete (numbers, permits, sectors, neighborhoods) when possible.`,
        `- Do NOT fabricate specific company names or salary figures you are not sure of.`,
        `- All output in ${localeName}.`,
      ].join('\n'),
    },
  ];
}

// ── JSON extraction (tolerant of stray prose / fences) ─────────────────
function extractJson(raw) {
  if (!raw) return null;
  let s = String(raw).trim();
  // Strip markdown fences if any slipped through.
  s = s.replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/i, '').trim();
  // Find the outermost {...}.
  const first = s.indexOf('{');
  const last = s.lastIndexOf('}');
  if (first === -1 || last === -1 || last <= first) return null;
  const sliced = s.slice(first, last + 1);
  try {
    return JSON.parse(sliced);
  } catch {
    return null;
  }
}

// ── Validation of AI output ────────────────────────────────────────────
function wordCount(s) {
  return String(s || '').trim().split(/\s+/).filter(Boolean).length;
}

function validateEnrichment(parsed) {
  if (!parsed || typeof parsed !== 'object') return { ok: false, reason: 'not an object' };
  const intro = typeof parsed.intro === 'string' ? parsed.intro.trim() : '';
  const faqs = Array.isArray(parsed.faqs) ? parsed.faqs : [];
  if (!intro) return { ok: false, reason: 'missing intro' };
  if (faqs.length !== FAQ_COUNT) return { ok: false, reason: `expected ${FAQ_COUNT} faqs, got ${faqs.length}` };
  for (const f of faqs) {
    if (!f || typeof f.q !== 'string' || typeof f.a !== 'string') {
      return { ok: false, reason: 'malformed faq entry' };
    }
    if (!f.q.trim() || !f.a.trim()) return { ok: false, reason: 'empty faq field' };
  }
  return { ok: true, intro, faqs };
}

// ── Single-candidate enrichment with one retry ─────────────────────────
async function enrichOne(candidate, { verbose }) {
  const { keyword, city } = extractKeywordAndCity(candidate.sampleTerms);
  const messages = buildPrompt({
    keyword,
    city,
    locale: candidate.locale,
    jobCount: candidate.jobCount,
  });

  const callOpts = {
    model: AI_MODELS.GPT4O_MINI,
    temperature: 0.6,
    maxTokens: 900,
    jsonMode: true,
  };

  for (let attempt = 1; attempt <= 2; attempt++) {
    let raw;
    try {
      raw = await callLLM(messages, callOpts);
    } catch (err) {
      if (verbose) console.warn(`  ⚠️  ${candidate.locale}::${candidate.slug} attempt ${attempt} call failed: ${err.message}`);
      if (attempt === 2) return { ok: false, reason: `call failed: ${err.message}` };
      continue;
    }
    const parsed = extractJson(raw);
    const validation = validateEnrichment(parsed);
    if (validation.ok) {
      const intro = validation.intro;
      const wc = wordCount(intro);
      if (wc < MIN_WORDS || wc > MAX_WORDS) {
        // Log warning but accept (orchestrator QA stage catches this).
        console.warn(`  ⚠️  ${candidate.locale}::${candidate.slug} intro word count ${wc} outside [${MIN_WORDS}, ${MAX_WORDS}] — accepting`);
      }
      return {
        ok: true,
        keyword,
        city,
        intro,
        faqs: validation.faqs.map((f) => ({ q: f.q.trim(), a: f.a.trim() })),
      };
    }
    if (verbose) console.warn(`  ⚠️  ${candidate.locale}::${candidate.slug} attempt ${attempt} validation: ${validation.reason}`);
  }
  return { ok: false, reason: 'malformed JSON after retry' };
}

// ── Concurrency limiter (stdlib only) ──────────────────────────────────
async function runWithConcurrency(items, limit, worker) {
  const results = new Array(items.length);
  let next = 0;
  async function pump() {
    while (true) {
      const i = next++;
      if (i >= items.length) return;
      results[i] = await worker(items[i], i);
    }
  }
  const pumps = Array.from({ length: Math.min(limit, items.length) }, () => pump());
  await Promise.all(pumps);
  return results;
}

// ── I/O helpers ────────────────────────────────────────────────────────
function loadCandidates() {
  if (!existsSync(INPUT_PATH)) {
    console.error(`❌ Missing input file: ${INPUT_PATH}`);
    process.exit(1);
  }
  let raw;
  try {
    raw = readFileSync(INPUT_PATH, 'utf8');
  } catch (err) {
    console.error(`❌ Cannot read ${INPUT_PATH}: ${err.message}`);
    process.exit(1);
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    console.error(`❌ Malformed JSON in ${INPUT_PATH}: ${err.message}`);
    process.exit(1);
  }
  if (!parsed || !Array.isArray(parsed.candidates)) {
    console.error(`❌ Unexpected shape in ${INPUT_PATH}: missing candidates[] array`);
    process.exit(1);
  }
  return parsed.candidates;
}

function loadEnriched() {
  if (!existsSync(OUTPUT_PATH)) {
    return { generatedAt: null, modelStats: {}, totalEnriched: 0, byLocale: {}, entries: {} };
  }
  try {
    const parsed = JSON.parse(readFileSync(OUTPUT_PATH, 'utf8'));
    if (!parsed || typeof parsed !== 'object' || !parsed.entries) {
      console.warn('⚠️  Existing enriched file has unexpected shape — starting fresh.');
      return { generatedAt: null, modelStats: {}, totalEnriched: 0, byLocale: {}, entries: {} };
    }
    return parsed;
  } catch (err) {
    console.warn(`⚠️  Cannot parse existing enriched file (${err.message}) — starting fresh.`);
    return { generatedAt: null, modelStats: {}, totalEnriched: 0, byLocale: {}, entries: {} };
  }
}

function saveEnriched(state) {
  const byLocale = {};
  for (const e of Object.values(state.entries)) {
    byLocale[e.locale] = (byLocale[e.locale] || 0) + 1;
  }
  const out = {
    generatedAt: new Date().toISOString(),
    modelStats: getAiStats(),
    totalEnriched: Object.keys(state.entries).length,
    byLocale,
    entries: state.entries,
  };
  writeFileSync(OUTPUT_PATH, JSON.stringify(out, null, 2) + '\n', 'utf8');
}

// ── Main ───────────────────────────────────────────────────────────────
async function main() {
  const args = parseArgs(process.argv);
  const startedAt = Date.now();

  const candidates = loadCandidates();
  console.log(`📥 Loaded ${candidates.length} candidates from ${INPUT_PATH}`);

  // Filter: jobCount >= 5 && editorialCollision === null
  let pool = candidates.filter((c) => c.jobCount >= 5 && c.editorialCollision === null);
  console.log(`✅ ${pool.length} pass inclusion gate (jobCount >= 5 AND no editorial collision)`);

  if (args.locale) {
    pool = pool.filter((c) => c.locale === args.locale);
    console.log(`🔎 Filtered to locale=${args.locale}: ${pool.length}`);
  }

  // Sort highest-jobCount first so --limit picks the most valuable clusters.
  pool.sort((a, b) => (b.jobCount || 0) - (a.jobCount || 0));

  if (args.limit !== null) {
    pool = pool.slice(0, args.limit);
    console.log(`🔪 Limited to top ${pool.length} by jobCount`);
  }

  const state = loadEnriched();
  if (args.force) {
    console.log('♻️  --force: ignoring cache; existing entries will be re-enriched');
    state.entries = {};
  }

  // Decide work list
  const workList = [];
  let cachedHits = 0;
  for (const c of pool) {
    const key = `${c.locale}::${c.slug}`;
    const expected = cacheKey(c);
    const existing = state.entries[key];
    if (!args.force && existing && existing.cachedFor === expected) {
      cachedHits++;
      continue;
    }
    workList.push({ candidate: c, key, expected });
  }
  console.log(`🗃️  Cache: ${cachedHits} hits, ${workList.length} to enrich`);

  if (args.dryRun) {
    console.log('\n🧪 --dry-run: not calling AI. Sample of candidates that would be enriched:');
    for (const item of workList.slice(0, 10)) {
      const { keyword, city } = extractKeywordAndCity(item.candidate.sampleTerms);
      console.log(`  - ${item.candidate.locale}::${item.candidate.slug} (jobs=${item.candidate.jobCount}, keyword="${keyword}"${city ? `, city=${city}` : ''})`);
    }
    if (workList.length > 10) console.log(`  ... and ${workList.length - 10} more`);
    console.log(`\n📊 Would enrich: ${workList.length}`);
    return;
  }

  if (workList.length === 0) {
    console.log('✨ Nothing to do — everything is cached.');
    return;
  }

  if (!isAnyModelAvailable()) {
    console.error('❌ No AI model is available. Set GH_MODELS_PAT or GEMINI_API_KEY.');
    process.exit(1);
  }

  // Enrich with bounded concurrency.
  let enrichedCount = 0;
  let failureCount = 0;
  const failures = [];

  await runWithConcurrency(workList, CONCURRENCY, async (item, idx) => {
    if (args.verbose) {
      console.log(`  → [${idx + 1}/${workList.length}] ${item.candidate.locale}::${item.candidate.slug}`);
    } else if ((idx + 1) % 25 === 0) {
      console.log(`  ... ${idx + 1}/${workList.length} processed`);
    }
    const result = await enrichOne(item.candidate, { verbose: args.verbose });
    if (!result.ok) {
      failureCount++;
      failures.push({ key: item.key, reason: result.reason });
      console.warn(`  ❌ ${item.key}: ${result.reason}`);
      return;
    }
    state.entries[item.key] = {
      slug: item.candidate.slug,
      locale: item.candidate.locale,
      keyword: result.keyword,
      city: result.city,
      intro: result.intro,
      faqs: result.faqs,
      cachedFor: item.expected,
      enrichedAt: new Date().toISOString(),
    };
    enrichedCount++;
    // Periodic flush so a crash doesn't lose all progress.
    if (enrichedCount % 50 === 0) {
      try { saveEnriched(state); } catch (err) { console.warn(`  ⚠️  partial save failed: ${err.message}`); }
    }
  });

  // Final save.
  saveEnriched(state);

  // ── Summary ──────────────────────────────────────────────────────────
  const elapsedSec = ((Date.now() - startedAt) / 1000).toFixed(1);
  const stats = getAiStats();
  console.log('\n📊 Enrichment summary');
  console.log(`   Total candidates considered: ${pool.length}`);
  console.log(`   Cache hits (skipped): ${cachedHits}`);
  console.log(`   Newly enriched: ${enrichedCount}`);
  console.log(`   Failures: ${failureCount}`);
  if (failures.length > 0 && args.verbose) {
    for (const f of failures.slice(0, 20)) console.log(`     - ${f.key}: ${f.reason}`);
    if (failures.length > 20) console.log(`     ... +${failures.length - 20} more`);
  }
  console.log(`   AI calls: ${stats.calls || 0}, successes: ${stats.successes || 0}, retries: ${stats.retries || 0}, fallbacks: ${stats.fallbacks || 0}`);
  console.log(`   Elapsed: ${elapsedSec}s`);
  console.log(`   Output: ${OUTPUT_PATH}`);
  printRunSummary();
}

main().catch((err) => {
  console.error('❌ Fatal:', err);
  process.exit(1);
});
