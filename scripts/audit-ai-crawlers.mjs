#!/usr/bin/env node
/**
 * audit-ai-crawlers.mjs — profile who is driving the ~200GB/day uncached
 * Cloudflare bandwidth spike (issue #4305).
 *
 * The zone's plan caps httpRequestsAdaptiveGroups at a 1-day range per query
 * and does NOT expose `botScore` (Bot Management is an Enterprise add-on we
 * don't have). It DOES expose `verifiedBotCategory` (includes an "AI Crawler"
 * bucket for Cloudflare's own bot detection) — confirmed empirically
 * 2026-07-17.
 *
 * IMPORTANT (found 2026-07-17): a first version of this script tried to
 * derive "who is inside the AI Crawler category" by taking a GLOBAL
 * top-1000-rows-by-bytes query (grouped by host+userAgent+category+cacheStatus,
 * no category filter) and bucketing afterwards. That undercounted AI Crawler
 * bytes by ~35x (1.29 GB vs a real 47.5 GB) because the AI Crawler rows were
 * crowded out of the global top-1000 cutoff by higher-cardinality non-AI
 * traffic (Googlebot/GoogleOther variants, Search Engine Crawler, etc — CF
 * fragments each UA across cacheStatus buckets). Fix: query the AI-relevant
 * categories DIRECTLY via `verifiedBotCategory_in`, so the result set is
 * small and complete instead of a lossy slice of a huge global set.
 *
 * That direct query surfaced the real story: the large majority of "AI
 * Crawler"-tagged bytes come from a UA string that does NOT self-identify as
 * any known crawler — it presents as a generic mobile browser
 * ("Mozilla/5.0 (Linux; Android 6.0.1; Nexus 5X Build/MMB29P) ...
 * Chrome/150...") and is only recognizable as a bot via Cloudflare's own
 * behavioral heuristics, not via UA string. Regex-based classification alone
 * (matching GPTBot/ClaudeBot/PerplexityBot/etc by name) would never catch
 * this — hence the dedicated "maskedAiTraffic" section below.
 *
 * Per day: three query shapes (windowed 1 day at a time over the requested
 * lookback — default 7 days = 21 GraphQL calls):
 *   1. group by (host, verifiedBotCategory)                    — category totals, all traffic
 *   2. group by (host, userAgent, verifiedBotCategory), limit 100,
 *      filter verifiedBotCategory_in:["AI Crawler","AI Search","AI Assistant"]
 *      — authoritative, complete breakdown of AI-relevant category bytes
 *   3. group by (host, userAgent), limit 1000, orderBy bytes DESC — top
 *      bandwidth UAs across ALL traffic, regex-classified; catches named
 *      non-AI-but-interesting crawlers (Bytespider, AhrefsBot, etc) that
 *      either lack a verifiedBotCategory or sit outside the AI buckets.
 *
 * All filtered to requestSource:'eyeball' (real client requests only — see
 * scripts/lib/cf-analytics.mjs header for why Worker-internal rows poison
 * this kind of read).
 *
 * Usage:
 *   node scripts/audit-ai-crawlers.mjs                 # 7-day audit, writes data/ai-crawler-audit-<date>.json
 *   node scripts/audit-ai-crawlers.mjs --days 3
 *   node scripts/audit-ai-crawlers.mjs --dry-run        # print only, no file write
 *
 * Auth: CF_API_TOKEN (+ optional CF_ZONE_ID) in env — load via
 *   eval "$(GOOGLE_APPLICATION_CREDENTIALS=<sa.json> node scripts/load-rc-env.mjs)"
 */

import { writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { cfGraphQL, resolveZoneId, DEFAULT_ZONE_NAME, MAX_HOURS } from './lib/cf-analytics.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');

const args = process.argv.slice(2);
const DRY_RUN = args.includes('--dry-run');
const daysArgIdx = args.indexOf('--days');
const DAYS = daysArgIdx !== -1 ? Math.max(1, Number(args[daysArgIdx + 1]) || 7) : 7;

// AI-relevant verifiedBotCategory buckets on this Cloudflare plan (confirmed
// empirically 2026-07-17 — these are the categories that matter for "AI/LLM
// visibility", as opposed to e.g. plain "Search Engine Crawler").
const AI_RELEVANT_CATEGORIES = ['AI Crawler', 'AI Search', 'AI Assistant'];

// ── Known AI/LLM crawler name patterns (checked against raw userAgent) ─────
// Ordered — first match wins. Kept intentionally explicit (not a giant
// generic /bot/i catch-all) so classification stays legible in the report.
const AI_BOT_PATTERNS = [
  ['GPTBot', /GPTBot/i],
  ['ChatGPT-User', /ChatGPT-User/i],
  ['OAI-SearchBot', /OAI-SearchBot/i],
  ['ClaudeBot', /ClaudeBot/i],
  ['Claude-Web', /Claude-Web/i],
  ['anthropic-ai', /anthropic-ai/i],
  ['PerplexityBot', /PerplexityBot/i],
  ['Perplexity-User', /Perplexity-User/i],
  ['Amzn-SearchBot', /Amzn-SearchBot/i],
  ['Bytespider', /Bytespider/i],
  ['CCBot', /CCBot/i], // Common Crawl — feeds many LLM training sets
  ['Google-Extended', /Google-Extended/i],
  ['Applebot-Extended', /Applebot-Extended/i],
  ['cohere-ai', /cohere-ai|cohere-training-data-crawler/i],
  ['Diffbot', /Diffbot/i],
  ['YouBot', /YouBot/i],
  ['Meta-ExternalAgent', /Meta-ExternalAgent|meta-externalfetcher/i],
  ['TimpiBot', /TimpiBot/i],
  ['omgili', /omgili/i],
  ['ImagesiftBot', /ImagesiftBot/i],
  ['Amazonbot', /Amazonbot/i],
  ['Googlebot', /Googlebot(?!-)/i],
  ['GoogleOther', /GoogleOther/i],
  ['bingbot', /bingbot/i],
  ['YandexBot', /YandexBot/i],
  ['DuckDuckBot', /DuckDuckBot/i],
  ['facebookexternalhit', /facebookexternalhit/i],
  ['AhrefsBot', /AhrefsBot/i],
  ['SemrushBot', /SemrushBot/i],
  ['MJ12bot', /MJ12bot/i],
  ['DotBot', /DotBot/i],
  ['PetalBot', /PetalBot/i],
  ['DataForSeoBot', /DataForSeoBot/i],
];

function classifyUA(ua) {
  if (!ua) return null;
  for (const [name, rx] of AI_BOT_PATTERNS) {
    if (rx.test(ua)) return name;
  }
  return null;
}

const AI_LLM_NAMES = new Set([
  'GPTBot', 'ChatGPT-User', 'OAI-SearchBot', 'ClaudeBot', 'Claude-Web',
  'anthropic-ai', 'PerplexityBot', 'Perplexity-User', 'Amzn-SearchBot', 'Bytespider', 'CCBot',
  'Google-Extended', 'Applebot-Extended', 'cohere-ai', 'Diffbot', 'YouBot',
  'Meta-ExternalAgent', 'TimpiBot', 'omgili', 'ImagesiftBot',
]);

const CATEGORY_QUERY = `
query($zone:String!,$since:Time!,$until:Time!,$limit:Int!){
  viewer{ zones(filter:{zoneTag:$zone}){
    httpRequestsAdaptiveGroups(
      limit:$limit,
      filter:{datetime_geq:$since, datetime_leq:$until, requestSource:"eyeball"},
      orderBy:[sum_edgeResponseBytes_DESC]
    ){
      count
      sum { edgeResponseBytes }
      dimensions { clientRequestHTTPHost verifiedBotCategory cacheStatus }
    }
  }}
}`;

// Direct, filtered query — small+complete result set for the categories we
// actually care about, instead of a lossy slice of a global top-N.
const AI_CATEGORY_UA_QUERY = `
query($zone:String!,$since:Time!,$until:Time!,$limit:Int!,$categories:[String!]){
  viewer{ zones(filter:{zoneTag:$zone}){
    httpRequestsAdaptiveGroups(
      limit:$limit,
      filter:{datetime_geq:$since, datetime_leq:$until, requestSource:"eyeball", verifiedBotCategory_in:$categories},
      orderBy:[sum_edgeResponseBytes_DESC]
    ){
      count
      sum { edgeResponseBytes }
      dimensions { clientRequestHTTPHost userAgent verifiedBotCategory }
    }
  }}
}`;

const UA_QUERY = `
query($zone:String!,$since:Time!,$until:Time!,$limit:Int!){
  viewer{ zones(filter:{zoneTag:$zone}){
    httpRequestsAdaptiveGroups(
      limit:$limit,
      filter:{datetime_geq:$since, datetime_leq:$until, requestSource:"eyeball"},
      orderBy:[sum_edgeResponseBytes_DESC]
    ){
      count
      sum { edgeResponseBytes }
      dimensions { clientRequestHTTPHost userAgent verifiedBotCategory cacheStatus }
    }
  }}
}`;

async function fetchDay(token, zoneId, untilDate) {
  const until = untilDate.toISOString();
  const since = new Date(untilDate.getTime() - MAX_HOURS * 3600 * 1000).toISOString();

  const [catData, aiUaData, uaData] = await Promise.all([
    cfGraphQL(token, CATEGORY_QUERY, { zone: zoneId, since, until, limit: 50 }),
    cfGraphQL(token, AI_CATEGORY_UA_QUERY, { zone: zoneId, since, until, limit: 100, categories: AI_RELEVANT_CATEGORIES }),
    cfGraphQL(token, UA_QUERY, { zone: zoneId, since, until, limit: 1000 }),
  ]);

  return {
    since,
    until,
    categoryRows: catData.viewer.zones[0]?.httpRequestsAdaptiveGroups || [],
    aiUaRows: aiUaData.viewer.zones[0]?.httpRequestsAdaptiveGroups || [],
    uaRows: uaData.viewer.zones[0]?.httpRequestsAdaptiveGroups || [],
  };
}

async function main() {
  const token = process.env.CF_API_TOKEN;
  if (!token) {
    console.error('CF_API_TOKEN not set. Run scripts/load-rc-env.mjs first (or export it).');
    process.exit(1);
  }

  const zoneId = await resolveZoneId(token, DEFAULT_ZONE_NAME, process.env.CF_ZONE_ID);
  console.log(`Zone: ${DEFAULT_ZONE_NAME} (${zoneId})`);
  console.log(`Sweeping ${DAYS} day(s), 3 queries/day (category totals + AI-category UA breakdown + global top UA)...\n`);

  const days = [];
  const byCategory = new Map(); // "host|category" -> {bytes, count}
  const byCategoryCacheStatus = new Map(); // "category|cacheStatus" -> {bytes, count}
  const byBotName = new Map(); // botName -> {bytes, count, hosts:Set}
  // Masked AI-category traffic: UA strings inside an AI-relevant category
  // that do NOT match any known crawler name regex (i.e. self-present as a
  // normal browser but are behaviorally flagged as AI Crawler/Search/Assistant
  // by Cloudflare's own bot detection).
  const byMaskedAiUA = new Map(); // "category|uaPrefix" -> {bytes, count, hosts:Set, sampleUA}
  let totalBytes = 0;
  let totalCount = 0;

  const now = new Date();
  for (let i = 0; i < DAYS; i++) {
    const until = new Date(now.getTime() - i * 24 * 3600 * 1000);
    let day;
    try {
      day = await fetchDay(token, zoneId, until);
    } catch (err) {
      console.error(`  Day -${i}: FAILED — ${err.message}`);
      continue;
    }
    let dayBytes = 0;
    let dayCount = 0;
    let dayAiCategoryBytes = 0; // authoritative, from the category totals query
    let dayAiUaAccountedBytes = 0; // sum of aiUaRows, should reconcile closely with dayAiCategoryBytes

    for (const row of day.categoryRows) {
      const host = row.dimensions.clientRequestHTTPHost || '(unknown host)';
      const category = row.dimensions.verifiedBotCategory || '(unverified/human)';
      const cacheStatus = row.dimensions.cacheStatus || '(unknown)';
      const bytes = Number(row.sum?.edgeResponseBytes || 0);
      const count = row.count || 0;
      const key = `${host}|${category}`;
      const prev = byCategory.get(key) || { bytes: 0, count: 0 };
      byCategory.set(key, { bytes: prev.bytes + bytes, count: prev.count + count });
      if (AI_RELEVANT_CATEGORIES.includes(category)) {
        const csKey = `${category}|${cacheStatus}`;
        const csPrev = byCategoryCacheStatus.get(csKey) || { bytes: 0, count: 0 };
        byCategoryCacheStatus.set(csKey, { bytes: csPrev.bytes + bytes, count: csPrev.count + count });
      }
      dayBytes += bytes;
      dayCount += count;
      if (AI_RELEVANT_CATEGORIES.includes(category)) dayAiCategoryBytes += bytes;
    }

    for (const row of day.aiUaRows) {
      const ua = row.dimensions.userAgent || '';
      const host = row.dimensions.clientRequestHTTPHost || '(unknown host)';
      const category = row.dimensions.verifiedBotCategory || '(unknown)';
      const bytes = Number(row.sum?.edgeResponseBytes || 0);
      const count = row.count || 0;
      dayAiUaAccountedBytes += bytes;

      const named = classifyUA(ua);
      if (named) {
        const prev = byBotName.get(named) || { bytes: 0, count: 0, hosts: new Set() };
        prev.bytes += bytes;
        prev.count += count;
        prev.hosts.add(host);
        byBotName.set(named, prev);
      } else {
        // Masked traffic: tagged AI-relevant by CF's own detection, but the
        // UA string itself doesn't self-identify — group by (category, UA
        // prefix) so near-identical browser-mimicking strings collapse.
        const uaKey = ua.slice(0, 60) || '(empty UA)';
        const key = `${category}|${uaKey}`;
        const prev = byMaskedAiUA.get(key) || { bytes: 0, count: 0, hosts: new Set(), category, sampleUA: ua };
        prev.bytes += bytes;
        prev.count += count;
        prev.hosts.add(host);
        byMaskedAiUA.set(key, prev);
      }
    }

    for (const row of day.uaRows) {
      const ua = row.dimensions.userAgent || '';
      const host = row.dimensions.clientRequestHTTPHost || '(unknown host)';
      const bytes = Number(row.sum?.edgeResponseBytes || 0);
      const count = row.count || 0;
      const category = row.dimensions.verifiedBotCategory || '';
      // Skip AI-relevant categories here — already fully captured above via
      // the direct, non-lossy AI_CATEGORY_UA_QUERY. This pass is only for
      // named bots outside those categories (AhrefsBot, SemrushBot, plain
      // Googlebot/bingbot, etc) so we don't double count.
      if (AI_RELEVANT_CATEGORIES.includes(category)) continue;
      const named = classifyUA(ua);
      if (!named) continue; // avoid a noisy long tail of unclassified real browsers
      const prev = byBotName.get(named) || { bytes: 0, count: 0, hosts: new Set() };
      prev.bytes += bytes;
      prev.count += count;
      prev.hosts.add(host);
      byBotName.set(named, prev);
    }

    totalBytes += dayBytes;
    totalCount += dayCount;
    days.push({
      since: day.since,
      until: day.until,
      totalBytesGB: +(dayBytes / 1e9).toFixed(2),
      totalRequests: dayCount,
      aiCategoryBytesGB: +(dayAiCategoryBytes / 1e9).toFixed(2),
      aiCategoryUaAccountedBytesGB: +(dayAiUaAccountedBytes / 1e9).toFixed(2),
    });
    console.log(
      `  Day -${i} (${day.since.slice(0, 10)}): ${(dayBytes / 1e9).toFixed(1)} GB, ${dayCount.toLocaleString()} req, AI-relevant categories=${(dayAiCategoryBytes / 1e9).toFixed(2)} GB (UA breakdown accounted ${(dayAiUaAccountedBytes / 1e9).toFixed(2)} GB)`,
    );
  }

  // ── Build sorted summaries ────────────────────────────────────────────
  const categorySummary = [...byCategory.entries()]
    .map(([key, v]) => {
      const [host, category] = key.split('|');
      return { host, category, bytesGB: +(v.bytes / 1e9).toFixed(3), requests: v.count };
    })
    .sort((a, b) => b.bytesGB - a.bytesGB)
    .slice(0, 40);

  const botSummary = [...byBotName.entries()]
    .map(([name, v]) => ({
      name,
      isAiLlm: AI_LLM_NAMES.has(name),
      bytesGB: +(v.bytes / 1e9).toFixed(3),
      requests: v.count,
      hosts: [...v.hosts],
    }))
    .sort((a, b) => b.bytesGB - a.bytesGB);

  const aiCategoryCacheStatusSummary = [...byCategoryCacheStatus.entries()]
    .map(([key, v]) => {
      const [category, cacheStatus] = key.split('|');
      return { category, cacheStatus, bytesGB: +(v.bytes / 1e9).toFixed(3), requests: v.count };
    })
    .sort((a, b) => b.bytesGB - a.bytesGB);

  const maskedAiSummary = [...byMaskedAiUA.values()]
    .map((v) => ({
      category: v.category,
      bytesGB: +(v.bytes / 1e9).toFixed(3),
      requests: v.count,
      hosts: [...v.hosts],
      sampleUserAgent: v.sampleUA,
    }))
    .sort((a, b) => b.bytesGB - a.bytesGB)
    .slice(0, 20);

  const namedAiTotal = botSummary
    .filter((b) => b.isAiLlm)
    .reduce((acc, b) => ({ bytesGB: acc.bytesGB + b.bytesGB, requests: acc.requests + b.requests }), { bytesGB: 0, requests: 0 });
  const maskedAiTotal = maskedAiSummary.reduce(
    (acc, b) => ({ bytesGB: acc.bytesGB + b.bytesGB, requests: acc.requests + b.requests }),
    { bytesGB: 0, requests: 0 },
  );

  const report = {
    generatedAt: now.toISOString(),
    zone: DEFAULT_ZONE_NAME,
    lookbackDays: DAYS,
    daysCollected: days.length,
    totals: {
      bytesGB: +(totalBytes / 1e9).toFixed(2),
      requests: totalCount,
      avgBytesPerDayGB: +(totalBytes / 1e9 / Math.max(days.length, 1)).toFixed(2),
    },
    aiRelevantCategories: AI_RELEVANT_CATEGORIES,
    namedAiLlmCrawlerTotal: { bytesGB: +namedAiTotal.bytesGB.toFixed(2), requests: namedAiTotal.requests },
    maskedAiTrafficTotal: { bytesGB: +maskedAiTotal.bytesGB.toFixed(2), requests: maskedAiTotal.requests },
    days,
    byHostAndCategory: categorySummary,
    aiCategoryByCacheStatus: aiCategoryCacheStatusSummary,
    byNamedBot: botSummary,
    maskedAiTraffic: maskedAiSummary,
    notes: [
      'botScore dimension is NOT available on this Cloudflare plan (Bot Management/Enterprise-only) — confirmed via GraphQL field-access error 2026-07-17.',
      'verifiedBotCategory IS available; AI-relevant buckets on this plan are "AI Crawler", "AI Search", "AI Assistant".',
      'AI-relevant category bytes are queried DIRECTLY via verifiedBotCategory_in (small, complete result set) rather than filtered out of a global top-N — an earlier version of this script tried the global-top-N approach and undercounted AI Crawler bytes by ~35x because high-cardinality non-AI traffic crowded the AI rows out of the top-1000-by-bytes cutoff.',
      'maskedAiTraffic is the key finding: most AI-relevant-category bytes come from UA strings that do NOT self-identify as any named crawler (e.g. a UA presenting as a generic Android/Chrome mobile browser) — only detectable as AI Crawler via Cloudflare behavioral bot detection, not via UA regex. This traffic would NOT be caught by any robots.txt rule keyed on a bot name/UA token.',
      'byNamedBot excludes rows already inside AI-relevant categories (avoids double count with maskedAiTraffic/namedAiLlmCrawlerTotal); it captures named bots regex-matched from the global top-1000-by-bytes UA query (Googlebot, bingbot, AhrefsBot, etc).',
      'aiCategoryByCacheStatus breaks AI-relevant-category bytes down by Cloudflare cacheStatus, to check whether this traffic is actually the "uncached" bytes the issue is concerned about (vs. traffic CF is already serving from edge cache at near-zero origin cost).',
      'Filtered to requestSource:eyeball (excludes Worker-internal synthetic rows per scripts/lib/cf-analytics.mjs).',
    ],
  };

  console.log('\n=== Named AI/LLM crawlers (self-identifying UA, regex-matched) ===');
  for (const b of botSummary.filter((b) => b.isAiLlm).slice(0, 20)) {
    console.log(`  ${b.name.padEnd(24)} ${b.bytesGB.toFixed(2).padStart(8)} GB  ${b.requests.toLocaleString().padStart(10)} req  hosts=${b.hosts.join(',')}`);
  }
  console.log('\n=== AI-relevant category bytes by cacheStatus (is this actually "uncached"?) ===');
  for (const c of aiCategoryCacheStatusSummary.slice(0, 15)) {
    console.log(`  ${c.category.padEnd(14)} cacheStatus=${c.cacheStatus.padEnd(10)} ${c.bytesGB.toFixed(2).padStart(8)} GB  ${c.requests.toLocaleString().padStart(10)} req`);
  }
  console.log('\n=== Masked AI-category traffic (behaviorally flagged, UA does not self-identify) ===');
  for (const m of maskedAiSummary.slice(0, 10)) {
    console.log(`  [${m.category}] ${m.bytesGB.toFixed(2).padStart(8)} GB  ${m.requests.toLocaleString().padStart(10)} req  UA="${m.sampleUserAgent.slice(0, 70)}..."`);
  }
  console.log('\n=== Other named bots (non-AI categories) ===');
  for (const b of botSummary.filter((b) => !b.isAiLlm).slice(0, 10)) {
    console.log(`  ${b.name.padEnd(24)} ${b.bytesGB.toFixed(2).padStart(8)} GB  ${b.requests.toLocaleString().padStart(10)} req  hosts=${b.hosts.join(',')}`);
  }
  console.log(`\nNamed AI/LLM crawler bytes over ${days.length}d: ${namedAiTotal.bytesGB.toFixed(2)} GB / ${namedAiTotal.requests.toLocaleString()} req`);
  console.log(`Masked AI-category bytes over ${days.length}d: ${maskedAiTotal.bytesGB.toFixed(2)} GB / ${maskedAiTotal.requests.toLocaleString()} req`);
  console.log(`Total zone bytes (eyeball) over ${days.length}d: ${report.totals.bytesGB} GB / ${report.totals.requests.toLocaleString()} req`);

  if (DRY_RUN) {
    console.log('\n--dry-run: not writing report file.');
    return;
  }

  const dateStr = now.toISOString().slice(0, 10);
  const outPath = resolve(ROOT, 'data', `ai-crawler-audit-${dateStr}.json`);
  writeFileSync(outPath, JSON.stringify(report, null, 2) + '\n');
  console.log(`\nReport written: ${outPath}`);
}

main().catch((err) => {
  console.error(`Fatal error: ${err.message}`);
  process.exit(1);
});
