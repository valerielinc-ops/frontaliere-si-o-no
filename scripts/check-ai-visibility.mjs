#!/usr/bin/env node
/**
 * check-ai-visibility.mjs — Monitor AI search engine citations of frontaliereticino.ch
 *
 * Checks whether AI platforms (Perplexity, ChatGPT, Gemini, Google AI Overviews)
 * cite frontaliereticino.ch for the site's top keyword queries.
 *
 * Usage:
 *   node scripts/check-ai-visibility.mjs                # Full run (needs API keys)
 *   node scripts/check-ai-visibility.mjs --dry-run      # Preview queries, no API calls
 *
 * Environment variables (loaded via load-rc-env.mjs in CI):
 *   PERPLEXITY_API_KEY  — Perplexity Sonar API (primary, supports citations)
 *   GEMINI_API_KEY      — Google Gemini API (secondary check)
 *   GH_MODELS_PAT       — GitHub Models PAT for GPT-4o (tertiary check)
 *   GROQ_API_KEY        — Groq API (fallback)
 *
 * Outputs:
 *   reports/ai-visibility-{YYYY-MM-DD}.json   — Full structured report
 *   reports/ai-visibility-latest.md           — Human-readable markdown summary
 */

import { readFile, writeFile, appendFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = join(__dirname, '..');
const REPORTS_DIR = join(PROJECT_ROOT, 'reports');
// Full reports live in the gitignored reports/ dir (artifacts only). The
// trend needs a previous score that survives a fresh CI checkout, so a compact
// append-only summary is committed here instead (mirrors
// data/quality-alerts-history.jsonl).
const HISTORY_FILE = join(PROJECT_ROOT, 'data', 'ai-visibility-history.jsonl');

const SITE_DOMAIN = 'frontaliereticino.ch';
const SITE_URL = `https://${SITE_DOMAIN}`;

// ─── Monitored queries ──────────────────────────────────────────────────────

const QUERIES = [
  { q: 'calcolo stipendio netto frontaliere 2026', lang: 'it', category: 'calculator' },
  { q: 'nuovo accordo fiscale frontalieri Italia Svizzera', lang: 'it', category: 'tax' },
  { q: 'LAMal vs CMI frontaliere', lang: 'it', category: 'insurance' },
  { q: 'costo vita Ticino', lang: 'it', category: 'cost-of-living' },
  { q: 'permesso G vantaggi svantaggi', lang: 'it', category: 'guide' },
  { q: 'pilastro 3a frontaliere', lang: 'it', category: 'pension' },
  { q: 'comuni migliori frontalieri Ticino', lang: 'it', category: 'guide' },
  { q: 'primo giorno lavoro frontaliere Svizzera', lang: 'it', category: 'guide' },
  { q: 'tredicesima frontaliere Svizzera', lang: 'it', category: 'tax' },
  { q: 'cambio CHF EUR oggi', lang: 'it', category: 'exchange' },
  { q: 'lavoro Ticino offerte', lang: 'it', category: 'jobs' },
  { q: 'tassazione frontalieri 2026', lang: 'it', category: 'tax' },
  { q: 'busta paga svizzera spiegazione', lang: 'it', category: 'calculator' },
  { q: 'assicurazione sanitaria frontaliere', lang: 'it', category: 'insurance' },
  { q: 'cross border worker Switzerland Italy tax', lang: 'en', category: 'tax' },
  { q: 'Swiss salary calculator cross border', lang: 'en', category: 'calculator' },
  { q: 'LAMal vs Italian health insurance', lang: 'en', category: 'insurance' },
  { q: 'cost of living Ticino vs Lombardy', lang: 'en', category: 'cost-of-living' },
  { q: 'Grenzgänger Schweiz Italien Steuern 2026', lang: 'de', category: 'tax' },
  { q: 'frontalier Suisse Italie impôts', lang: 'fr', category: 'tax' },
];

// Known competitors in this space
const COMPETITORS = [
  'comparis.ch',
  'ch.ch',
  'ticino.ch',
  'admin.ch',
  'swissinfo.ch',
  'expatica.com',
  'numbeo.com',
  'fiscomania.com',
  'agenziaentrate.gov.it',
  'caf-acli.it',
  'cross-border.ch',
  'grfranco.ch',
];

// ─── CLI flags ──────────────────────────────────────────────────────────────

const DRY_RUN = process.argv.includes('--dry-run');
const VERBOSE = process.argv.includes('--verbose');

// ─── API helpers ────────────────────────────────────────────────────────────

function getPerplexityKey() { return (process.env.PERPLEXITY_API_KEY || '').trim(); }
function getGeminiKey() { return (process.env.GEMINI_API_KEY || process.env.VITE_GEMINI_API_KEY || '').trim(); }
function getGhModelsPat() { return (process.env.GH_MODELS_PAT || '').trim(); }

/**
 * Call Perplexity Sonar API — returns citations natively.
 * Docs: https://docs.perplexity.ai/api-reference/chat-completions
 */
async function queryPerplexity(query) {
  const key = getPerplexityKey();
  if (!key) return null;

  const res = await fetchWithRetry('Perplexity', 'https://api.perplexity.ai/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${key}`,
    },
    body: JSON.stringify({
      model: 'sonar',
      messages: [
        {
          role: 'system',
          content: 'You are a helpful assistant. Always cite your sources with URLs.',
        },
        { role: 'user', content: query },
      ],
      max_tokens: 1024,
      return_citations: true,
    }),
  });

    if (!res) return null;

  const data = await res.json();
  const content = data.choices?.[0]?.message?.content || '';
  const citations = data.citations || [];

  return { content, citations, raw: data };
}

/**
 * Call Gemini API to check if it references our site. Uses Google Search
 * grounding — without it, the model can only answer from parametric training
 * knowledge and structurally can never surface a citation (ours or any
 * competitor's) for a niche/recent query, which was masking the real
 * visibility signal (0/20 with zero competitor mentions on every query).
 */
async function queryGemini(query) {
  const key = getGeminiKey();
  if (!key) return null;

  const res = await fetchWithRetry(
    'Gemini',
    `https://generativelanguage.googleapis.com/v1beta/models/gemini-flash-latest:generateContent?key=${key}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{
          parts: [{
            text: `Answer the following question and cite specific websites with their URLs where relevant: ${query}`,
          }],
        }],
        tools: [{ google_search: {} }],
        generationConfig: { maxOutputTokens: 1024, temperature: 0.2 },
      }),
    },
  );

  if (!res) return null;

  const data = await res.json();
  const content = data.candidates?.[0]?.content?.parts?.[0]?.text || '';
  const groundingChunks = data.candidates?.[0]?.groundingMetadata?.groundingChunks || [];
  // Grounding chunks expose the source both as a redirect uri (which never
  // contains the real host) and as `web.title`, which IS the domain — match
  // on both, otherwise no domain, ours or a competitor's, can ever be found.
  const citations = groundingChunks
    .flatMap(c => [c.web?.uri, c.web?.title])
    .filter(Boolean);
  return { content, citations, raw: data };
}

/**
 * Call GitHub Models (GPT-4o) via OpenAI-compatible API.
 */
async function queryGitHubModels(query) {
  const key = getGhModelsPat();
  if (!key) return null;

  const res = await fetchWithRetry('GitHub Models', 'https://models.inference.ai.azure.com/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${key}`,
    },
    body: JSON.stringify({
      model: 'gpt-4o',
      messages: [
        {
          role: 'system',
          content: 'You are a helpful assistant. When answering, cite specific websites with full URLs.',
        },
        { role: 'user', content: query },
      ],
      max_tokens: 1024,
      temperature: 0.2,
    }),
  });

  if (!res) return null;

  const data = await res.json();
  const content = data.choices?.[0]?.message?.content || '';
  return { content, citations: [], raw: data };
}

/**
 * One request with bounded retry on TRANSIENT failures (HTTP 429/5xx, network
 * errors), honouring `Retry-After` when the server sends it. Returns the
 * response on success and `null` when the platform could not be reached —
 * callers turn that into `checked: false`, never into "not cited": a rate limit
 * is not a visibility signal (see the score accounting in runCheck).
 */
const MAX_ATTEMPTS = 3;

async function fetchWithRetry(label, url, init) {
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const last = attempt === MAX_ATTEMPTS;
    try {
      const res = await fetch(url, init);
      if (res.ok) return res;

      const body = await res.text();
      const transient = res.status === 429 || res.status >= 500;
      if (!transient || last) {
        console.warn(`  ⚠ ${label} API ${res.status}: ${body.slice(0, 200)}`);
        return null;
      }
      const retryAfter = Number(res.headers.get('retry-after'));
      const waitMs = Number.isFinite(retryAfter) && retryAfter > 0
        ? Math.min(retryAfter * 1000, 60_000)
        : 2000 * 2 ** (attempt - 1);
      console.warn(`  ⚠ ${label} API ${res.status} (attempt ${attempt}/${MAX_ATTEMPTS}) — retry in ${Math.round(waitMs / 1000)}s`);
      await sleep(waitMs);
    } catch (err) {
      if (last) {
        console.warn(`  ⚠ ${label} error: ${err.message}`);
        return null;
      }
      console.warn(`  ⚠ ${label} error: ${err.message} (attempt ${attempt}/${MAX_ATTEMPTS})`);
      await sleep(2000 * 2 ** (attempt - 1));
    }
  }
  return null;
}

// ─── Analysis helpers ───────────────────────────────────────────────────────

/**
 * Check if text or citations reference our site.
 */
function findSiteMention(content, citations = []) {
  const allText = [content, ...citations.map(c => typeof c === 'string' ? c : c.url || '')].join(' ');
  const lower = allText.toLowerCase();

  const cited = lower.includes(SITE_DOMAIN);
  const citedUrls = [];

  // Extract URLs mentioning our domain
  const urlRegex = /https?:\/\/[^\s"'<>\])}]+/gi;
  const urls = allText.match(urlRegex) || [];
  for (const url of urls) {
    if (url.toLowerCase().includes(SITE_DOMAIN)) {
      citedUrls.push(url.replace(/[.,;:!?)]+$/, ''));
    }
  }

  // Also check structured citations from Perplexity
  for (const c of citations) {
    const url = typeof c === 'string' ? c : c.url || c;
    if (typeof url === 'string' && url.toLowerCase().includes(SITE_DOMAIN)) {
      const cleaned = url.replace(/[.,;:!?)]+$/, '');
      if (!citedUrls.includes(cleaned)) citedUrls.push(cleaned);
    }
  }

  return { cited, citedUrls: [...new Set(citedUrls)] };
}

/**
 * Find which competitors are mentioned in the response.
 */
function findCompetitorMentions(content, citations = []) {
  const allText = [content, ...citations.map(c => typeof c === 'string' ? c : c.url || '')].join(' ');
  const lower = allText.toLowerCase();

  return COMPETITORS.filter(comp => lower.includes(comp.toLowerCase()));
}

/**
 * Wait between API calls to respect rate limits.
 */
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ─── Main execution ─────────────────────────────────────────────────────────

async function runCheck() {
  const dateStr = new Date().toISOString().slice(0, 10);
  const timestamp = new Date().toISOString();

  console.log(`\n🔍 AI Visibility Check — ${dateStr}`);
  console.log(`   Domain: ${SITE_DOMAIN}`);
  console.log(`   Queries: ${QUERIES.length}`);

  // Detect available platforms
  const platforms = {
    perplexity: !!getPerplexityKey(),
    gemini: !!getGeminiKey(),
    chatgpt: !!getGhModelsPat(),
  };

  const availablePlatforms = Object.entries(platforms)
    .filter(([, v]) => v)
    .map(([k]) => k);

  console.log(`   Platforms: ${availablePlatforms.length > 0 ? availablePlatforms.join(', ') : '⚠ NONE (set API keys)'}`);

  if (DRY_RUN) {
    console.log('\n📋 DRY RUN — Queries that would be checked:\n');
    for (const [i, { q, lang, category }] of QUERIES.entries()) {
      console.log(`  ${String(i + 1).padStart(2)}. [${lang.toUpperCase()}] [${category}] "${q}"`);
    }
    console.log(`\n   Would check against ${availablePlatforms.length} platform(s): ${availablePlatforms.join(', ') || 'none'}`);
    console.log(`   Would track ${COMPETITORS.length} competitors: ${COMPETITORS.join(', ')}`);
    console.log(`   Reports would be saved to:`);
    console.log(`     - reports/ai-visibility-${dateStr}.json`);
    console.log(`     - reports/ai-visibility-latest.md`);

    if (availablePlatforms.length === 0) {
      console.log('\n⚠ No API keys detected. Set one or more of:');
      console.log('   PERPLEXITY_API_KEY  — Perplexity Sonar API (best: returns native citations)');
      console.log('   GEMINI_API_KEY      — Google Gemini API');
      console.log('   GH_MODELS_PAT       — GitHub Models (GPT-4o)');
      console.log('\n   In CI, keys are loaded from Firebase Remote Config via load-rc-env.mjs.');
      console.log('   Locally: export PERPLEXITY_API_KEY="pplx-..." before running.');
    }
    return;
  }

  if (availablePlatforms.length === 0) {
    console.error('\n❌ No API keys available. Cannot perform visibility check.');
    console.error('   Set at least one of: PERPLEXITY_API_KEY, GEMINI_API_KEY, GH_MODELS_PAT');
    process.exit(1);
  }

  // Run checks
  const results = [];

  for (const [i, { q, lang, category }] of QUERIES.entries()) {
    console.log(`\n[${i + 1}/${QUERIES.length}] "${q}" (${lang})`);

    const result = {
      query: q,
      lang,
      category,
      platforms: {},
      citedByAny: false,
      citedUrls: [],
      competitorsCited: [],
    };

    // Perplexity (primary — has native citations)
    if (platforms.perplexity) {
      console.log('  → Perplexity...');
      const pplx = await queryPerplexity(q);
      if (pplx) {
        const mention = findSiteMention(pplx.content, pplx.citations);
        const competitors = findCompetitorMentions(pplx.content, pplx.citations);
        result.platforms.perplexity = {
          checked: true,
          cited: mention.cited,
          citedUrls: mention.citedUrls,
          competitorsCited: competitors,
          totalCitations: pplx.citations.length,
        };
        if (mention.cited) {
          result.citedByAny = true;
          result.citedUrls.push(...mention.citedUrls);
        }
        result.competitorsCited.push(...competitors);
        if (VERBOSE) console.log(`    Citations: ${pplx.citations.length}, Us: ${mention.cited ? '✅' : '❌'}`);
      } else {
        result.platforms.perplexity = { checked: false, error: 'API call failed' };
      }
      await sleep(1500); // Rate limit: ~20 req/min for Sonar
    }

    // Gemini
    if (platforms.gemini) {
      console.log('  → Gemini...');
      const gem = await queryGemini(q);
      if (gem) {
        const mention = findSiteMention(gem.content, gem.citations);
        const competitors = findCompetitorMentions(gem.content, gem.citations);
        result.platforms.gemini = {
          checked: true,
          cited: mention.cited,
          citedUrls: mention.citedUrls,
          competitorsCited: competitors,
          totalCitations: gem.citations.length,
        };
        if (mention.cited) {
          result.citedByAny = true;
          result.citedUrls.push(...mention.citedUrls);
        }
        result.competitorsCited.push(...competitors);
        if (VERBOSE) console.log(`    Us: ${mention.cited ? '✅' : '❌'}`);
      } else {
        result.platforms.gemini = { checked: false, error: 'API call failed' };
      }
      await sleep(1000);
    }

    // ChatGPT (via GitHub Models)
    if (platforms.chatgpt) {
      console.log('  → ChatGPT (GitHub Models)...');
      const gpt = await queryGitHubModels(q);
      if (gpt) {
        const mention = findSiteMention(gpt.content);
        const competitors = findCompetitorMentions(gpt.content);
        result.platforms.chatgpt = {
          checked: true,
          cited: mention.cited,
          citedUrls: mention.citedUrls,
          competitorsCited: competitors,
        };
        if (mention.cited) {
          result.citedByAny = true;
          result.citedUrls.push(...mention.citedUrls);
        }
        result.competitorsCited.push(...competitors);
        if (VERBOSE) console.log(`    Us: ${mention.cited ? '✅' : '❌'}`);
      } else {
        result.platforms.chatgpt = { checked: false, error: 'API call failed' };
      }
      await sleep(1000);
    }

    // A query counts as observed only if at least one platform answered. A
    // query nobody could reach is unknown, not "not cited".
    result.checkedByAny = Object.values(result.platforms).some(p => p?.checked);

    // Deduplicate
    result.citedUrls = [...new Set(result.citedUrls)];
    result.competitorsCited = [...new Set(result.competitorsCited)];

    results.push(result);
  }

  // ── Build report ────────────────────────────────────────────────────────

  const citedCount = results.filter(r => r.citedByAny).length;
  // Denominator = queries an AI platform actually answered. Counting a query
  // whose every API call failed as "not cited" is what turned three months of
  // total API outage into a credible-looking 0/20 report (issue #7005).
  const queriesChecked = results.filter(r => r.checkedByAny).length;

  const report = {
    meta: {
      date: dateStr,
      timestamp,
      domain: SITE_DOMAIN,
      totalQueries: QUERIES.length,
      queriesChecked,
      platformsChecked: availablePlatforms,
      score: citedCount,
      scoreMax: queriesChecked,
      scorePercent: queriesChecked > 0 ? Math.round((citedCount / queriesChecked) * 100) : 0,
    },
    results,
    competitorSummary: buildCompetitorSummary(results),
  };

  // Load previous report for trend comparison
  const trend = await loadPreviousReport(dateStr);
  if (trend) {
    report.trend = trend;
  }

  // ── Write outputs ───────────────────────────────────────────────────────

  await mkdir(REPORTS_DIR, { recursive: true });

  const jsonPath = join(REPORTS_DIR, `ai-visibility-${dateStr}.json`);
  await writeFile(jsonPath, JSON.stringify(report, null, 2) + '\n');
  console.log(`\n📄 JSON report: ${jsonPath}`);

  const mdPath = join(REPORTS_DIR, 'ai-visibility-latest.md');
  await writeFile(mdPath, generateMarkdown(report));
  console.log(`📝 Markdown report: ${mdPath}`);

  // Append a compact summary to the committed history file so the next monthly
  // run can compute trend (reports/ is gitignored → never survives a fresh
  // checkout, so the JSON reports there cannot back the trend in CI).
  // Nothing observed → no data point. Appending a 0 here would poison the
  // trend of every later run (and file a monthly "0/20" issue about an outage
  // dressed up as a ranking result), so fail loudly instead: the workflow's
  // failure path reports it as what it is, a broken check.
  if (queriesChecked === 0) {
    throw new Error(
      `no AI platform could be reached for any of the ${QUERIES.length} queries ` +
      `(platforms with a key: ${availablePlatforms.join(', ') || 'none'}) — ` +
      'report written for inspection, history NOT updated',
    );
  }

  const historyEntry = {
    date: dateStr,
    score: citedCount,
    scoreMax: queriesChecked,
    queriesChecked,
    totalQueries: QUERIES.length,
    scorePercent: report.meta.scorePercent,
    platformsChecked: availablePlatforms,
    // `null` = the query could not be checked this run, distinct from `false`
    // (checked, not cited) — the month-over-month diff must skip it.
    results: Object.fromEntries(results.map(r => [r.query, r.checkedByAny ? r.citedByAny : null])),
  };
  await mkdir(dirname(HISTORY_FILE), { recursive: true });
  await appendFile(HISTORY_FILE, JSON.stringify(historyEntry) + '\n');
  console.log(`🗂  History: ${HISTORY_FILE}`);

  // ── Summary ─────────────────────────────────────────────────────────────

  console.log(`\n${'═'.repeat(60)}`);
  console.log(`  AI Visibility Score: ${citedCount}/${queriesChecked} checked queries (${report.meta.scorePercent}%)`);
  if (queriesChecked < QUERIES.length) {
    console.log(`  ⚠ ${QUERIES.length - queriesChecked} queries NOT checked (no platform answered)`);
  }
  if (trend) {
    const delta = citedCount - trend.previousScore;
    const arrow = delta > 0 ? '📈' : delta < 0 ? '📉' : '➡️';
    console.log(`  Trend: ${arrow} ${delta > 0 ? '+' : ''}${delta} vs ${trend.previousDate}`);
  }
  console.log(`${'═'.repeat(60)}\n`);

  // Return data for workflow issue creation
  return report;
}

// ─── Competitor summary ─────────────────────────────────────────────────────

function buildCompetitorSummary(results) {
  const counts = {};
  for (const r of results) {
    for (const comp of r.competitorsCited) {
      counts[comp] = (counts[comp] || 0) + 1;
    }
  }
  return Object.entries(counts)
    .sort((a, b) => b[1] - a[1])
    .map(([domain, count]) => ({ domain, citedInQueries: count }));
}

// ─── Load previous report for trend ─────────────────────────────────────────

async function loadPreviousReport(currentDate) {
  // Primary source: committed append-only history file. reports/ is gitignored,
  // so in CI it starts empty every run — only this file survives across the
  // monthly schedule and can back the trend.
  try {
    if (existsSync(HISTORY_FILE)) {
      const lines = (await readFile(HISTORY_FILE, 'utf8'))
        .split('\n')
        .map(l => l.trim())
        .filter(Boolean);
      for (let i = lines.length - 1; i >= 0; i--) {
        let entry;
        try { entry = JSON.parse(lines[i]); } catch { continue; }
        if (!entry?.date || entry.date === currentDate) continue;
        // A run where no platform answered carries no score to compare against.
        if (entry.queriesChecked === 0) continue;
        return {
          previousDate: entry.date,
          previousScore: entry.score ?? 0,
          previousQueriesChecked: entry.queriesChecked ?? null,
          previousFile: 'data/ai-visibility-history.jsonl',
          previousResults: entry.results || {},
        };
      }
    }
  } catch {
    // fall through to the legacy reports/ scan below
  }

  // Legacy fallback: scan the gitignored reports/ dir. Only useful in local dev
  // where prior full reports may still be present.
  try {
    const files = (await import('node:fs')).readdirSync(REPORTS_DIR)
      .filter(f => f.startsWith('ai-visibility-') && f.endsWith('.json') && !f.includes(currentDate))
      .sort()
      .reverse();

    if (files.length === 0) return null;

    const prevData = JSON.parse(await readFile(join(REPORTS_DIR, files[0]), 'utf8'));
    const prevScore = prevData.meta?.score ?? 0;
    const prevDate = prevData.meta?.date ?? 'unknown';

    // Per-query comparison
    const prevByQuery = {};
    for (const r of (prevData.results || [])) {
      prevByQuery[r.query] = r.citedByAny;
    }

    return {
      previousDate: prevDate,
      previousScore: prevScore,
      previousQueriesChecked: prevData.meta?.queriesChecked ?? null,
      previousFile: files[0],
      previousResults: prevByQuery,
    };
  } catch {
    return null;
  }
}

// ─── Markdown generation ────────────────────────────────────────────────────

function generateMarkdown(report) {
  const { meta, results, competitorSummary, trend } = report;

  const lines = [
    `# AI Visibility Report — ${meta.date}`,
    '',
    `**Domain**: ${meta.domain}`,
    `**Score**: ${meta.score}/${meta.scoreMax} checked queries cite us (${meta.scorePercent}%)`,
    `**Queries checked**: ${meta.queriesChecked ?? meta.scoreMax}/${meta.totalQueries} (the rest: no platform answered — not counted as a miss)`,
    `**Platforms checked**: ${meta.platformsChecked.join(', ')}`,
  ];

  // Trend
  if (trend) {
    const delta = meta.score - trend.previousScore;
    const arrow = delta > 0 ? '📈' : delta < 0 ? '📉' : '➡️';
    lines.push(`**Trend**: ${arrow} ${delta > 0 ? '+' : ''}${delta} vs ${trend.previousDate}`);
  }

  lines.push('', '---', '', '## Per-Query Results', '',
    'Legend: ✅ cited · ❌ checked, not cited · ⚪ platform unreachable (excluded from the score)', '');

  // Table header
  const platformCols = meta.platformsChecked.map(p => p.charAt(0).toUpperCase() + p.slice(1));
  lines.push(`| # | Query | Lang | ${platformCols.join(' | ')} | Competitors |`);
  lines.push(`|---|-------|------|${platformCols.map(() => '---').join('|')}|-------------|`);

  for (const [i, r] of results.entries()) {
    const platformCells = meta.platformsChecked.map(p => {
      const pd = r.platforms[p];
      if (!pd || !pd.checked) return '⚪';
      return pd.cited ? '✅' : '❌';
    });
    const competitors = r.competitorsCited.slice(0, 3).join(', ') || '—';
    lines.push(`| ${i + 1} | ${r.query} | ${r.lang.toUpperCase()} | ${platformCells.join(' | ')} | ${competitors} |`);
  }

  // Cited URLs section
  const citedResults = results.filter(r => r.citedUrls.length > 0);
  if (citedResults.length > 0) {
    lines.push('', '## Cited URLs', '');
    for (const r of citedResults) {
      lines.push(`- **"${r.query}"**: ${r.citedUrls.join(', ')}`);
    }
  }

  // Competitor leaderboard
  if (competitorSummary.length > 0) {
    lines.push('', '## Competitor Citation Leaderboard', '');
    lines.push('| Rank | Domain | Cited in N queries |');
    lines.push('|------|--------|-------------------|');
    for (const [i, { domain, citedInQueries }] of competitorSummary.entries()) {
      lines.push(`| ${i + 1} | ${domain} | ${citedInQueries} |`);
    }
  }

  // Trend details
  if (trend?.previousResults) {
    const gained = [];
    const lost = [];
    for (const r of results) {
      if (!r.checkedByAny) continue; // unknown this month, not a change
      const prev = trend.previousResults[r.query];
      if (prev === false && r.citedByAny) gained.push(r.query);
      if (prev === true && !r.citedByAny) lost.push(r.query);
    }

    if (gained.length > 0 || lost.length > 0) {
      lines.push('', '## Month-over-Month Changes', '');
      if (gained.length > 0) {
        lines.push('### 🟢 Gained citations');
        for (const q of gained) lines.push(`- "${q}"`);
      }
      if (lost.length > 0) {
        lines.push('### 🔴 Lost citations');
        for (const q of lost) lines.push(`- "${q}"`);
      }
    }
  }

  // Action items
  const uncited = results.filter(r => r.checkedByAny && !r.citedByAny);
  if (uncited.length > 0) {
    lines.push('', '## Action Items', '');
    lines.push('Queries where we are **not cited** by any AI platform:', '');
    for (const r of uncited) {
      const topComp = r.competitorsCited[0] || 'none detected';
      lines.push(`- **"${r.query}"** (${r.lang.toUpperCase()}, ${r.category}) — top competitor: ${topComp}`);
    }
    lines.push('', 'Recommendations:');
    lines.push('- Add FAQ schema markup for these topics on relevant pages');
    lines.push('- Create or expand content that directly answers these queries');
    lines.push('- Add structured data (HowTo, FAQPage) for step-by-step topics');
    lines.push('- Ensure the site appears in `llms.txt` with these topic keywords');
  }

  const unchecked = results.filter(r => !r.checkedByAny);
  if (unchecked.length > 0) {
    lines.push('', '## Not checked (platform unreachable)', '');
    lines.push('These queries produced no observation this run — they are excluded from the score:', '');
    for (const r of unchecked) lines.push(`- "${r.query}"`);
  }

  lines.push('', '---', `*Generated by \`scripts/check-ai-visibility.mjs\` on ${meta.timestamp}*`, '');

  return lines.join('\n');
}

// ─── Entry point ────────────────────────────────────────────────────────────

const isDirectRun = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isDirectRun) {
  runCheck().catch(err => {
    console.error('❌ AI visibility check failed:', err.message);
    process.exit(1);
  });
}

export { fetchWithRetry, findSiteMention, findCompetitorMentions, generateMarkdown, loadPreviousReport, runCheck };
