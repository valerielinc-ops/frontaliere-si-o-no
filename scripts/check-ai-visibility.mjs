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

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = join(__dirname, '..');
const REPORTS_DIR = join(PROJECT_ROOT, 'reports');

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

  try {
    const res = await fetch('https://api.perplexity.ai/chat/completions', {
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

    if (!res.ok) {
      const text = await res.text();
      console.warn(`  ⚠ Perplexity API ${res.status}: ${text.slice(0, 200)}`);
      return null;
    }

    const data = await res.json();
    const content = data.choices?.[0]?.message?.content || '';
    const citations = data.citations || [];

    return { content, citations, raw: data };
  } catch (err) {
    console.warn(`  ⚠ Perplexity error: ${err.message}`);
    return null;
  }
}

/**
 * Call Gemini API to check if it references our site.
 */
async function queryGemini(query) {
  const key = getGeminiKey();
  if (!key) return null;

  try {
    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${key}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{
            parts: [{
              text: `Answer the following question and cite specific websites with their URLs where relevant: ${query}`,
            }],
          }],
          generationConfig: { maxOutputTokens: 1024, temperature: 0.2 },
        }),
      },
    );

    if (!res.ok) {
      const text = await res.text();
      console.warn(`  ⚠ Gemini API ${res.status}: ${text.slice(0, 200)}`);
      return null;
    }

    const data = await res.json();
    const content = data.candidates?.[0]?.content?.parts?.[0]?.text || '';
    return { content, citations: [], raw: data };
  } catch (err) {
    console.warn(`  ⚠ Gemini error: ${err.message}`);
    return null;
  }
}

/**
 * Call GitHub Models (GPT-4o) via OpenAI-compatible API.
 */
async function queryGitHubModels(query) {
  const key = getGhModelsPat();
  if (!key) return null;

  try {
    const res = await fetch('https://models.inference.ai.azure.com/chat/completions', {
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

    if (!res.ok) {
      const text = await res.text();
      console.warn(`  ⚠ GitHub Models API ${res.status}: ${text.slice(0, 200)}`);
      return null;
    }

    const data = await res.json();
    const content = data.choices?.[0]?.message?.content || '';
    return { content, citations: [], raw: data };
  } catch (err) {
    console.warn(`  ⚠ GitHub Models error: ${err.message}`);
    return null;
  }
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
        const mention = findSiteMention(gem.content);
        const competitors = findCompetitorMentions(gem.content);
        result.platforms.gemini = {
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

    // Deduplicate
    result.citedUrls = [...new Set(result.citedUrls)];
    result.competitorsCited = [...new Set(result.competitorsCited)];

    results.push(result);
  }

  // ── Build report ────────────────────────────────────────────────────────

  const citedCount = results.filter(r => r.citedByAny).length;

  const report = {
    meta: {
      date: dateStr,
      timestamp,
      domain: SITE_DOMAIN,
      totalQueries: QUERIES.length,
      platformsChecked: availablePlatforms,
      score: citedCount,
      scoreMax: QUERIES.length,
      scorePercent: Math.round((citedCount / QUERIES.length) * 100),
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

  // ── Summary ─────────────────────────────────────────────────────────────

  console.log(`\n${'═'.repeat(60)}`);
  console.log(`  AI Visibility Score: ${citedCount}/${QUERIES.length} (${report.meta.scorePercent}%)`);
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

    const gained = [];
    const lost = [];
    // We'll compare after current results are computed externally
    // For now, just return basic trend data

    return {
      previousDate: prevDate,
      previousScore: prevScore,
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
    `**Score**: ${meta.score}/${meta.scoreMax} queries cite us (${meta.scorePercent}%)`,
    `**Platforms checked**: ${meta.platformsChecked.join(', ')}`,
  ];

  // Trend
  if (trend) {
    const delta = meta.score - trend.previousScore;
    const arrow = delta > 0 ? '📈' : delta < 0 ? '📉' : '➡️';
    lines.push(`**Trend**: ${arrow} ${delta > 0 ? '+' : ''}${delta} vs ${trend.previousDate}`);
  }

  lines.push('', '---', '', '## Per-Query Results', '');

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
  const uncited = results.filter(r => !r.citedByAny);
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

  lines.push('', '---', `*Generated by \`scripts/check-ai-visibility.mjs\` on ${meta.timestamp}*`, '');

  return lines.join('\n');
}

// ─── Entry point ────────────────────────────────────────────────────────────

runCheck().catch(err => {
  console.error('❌ AI visibility check failed:', err.message);
  process.exit(1);
});
