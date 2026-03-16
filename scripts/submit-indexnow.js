#!/usr/bin/env node
/**
 * IndexNow Submission Script
 * Reads sub-sitemaps (sitemap-pages.xml, sitemap-blog.xml, sitemap-glossario.xml)
 * protocol for instant indexing.
 *
 * Additionally, it can submit a SMALL subset to the Bing Webmaster URL
 * Submission API to avoid daily quota issues (default: only the newly
 * generated article + hreflang alternates).
 *
 * Run after deployment: node scripts/submit-indexnow.js
 *
 * Features:
 * - Pre-verifies the key file is accessible before submitting
 * - Retries failed submissions with exponential backoff
 * - Falls back to GET method for single-URL submission if POST fails
 * - Batches large URL lists (max 10 000 per request)
 *
 * No hardcoded URL list — the sitemap is the single source of truth.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const INDEXNOW_KEY = '39093e02a74b4a2dbf867c74bc53a7d8';
const HOST = 'www.frontaliereticino.ch';
const KEY_LOCATION = `https://${HOST}/${INDEXNOW_KEY}.txt`;
const MAX_RETRIES = 2;
const BATCH_SIZE = 500; // conservative batch size
// Both channels are always active — they only run during deploy (GitHub Actions).

const ARTICLE_URL = (process.env.ARTICLE_URL || '').trim();
const BING_RECENT_NEWS_FALLBACK = Math.max(1, Math.min(5, Number(process.env.BING_RECENT_NEWS_FALLBACK || 5)));

// ── Helpers ─────────────────────────────────────────────────
function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// ── Parse sitemaps to extract all unique URLs ──────────────
function getUrlsFromSitemaps() {
  const __dirname = dirname(fileURLToPath(import.meta.url));
  const urls = new Set();

  // sitemap.xml is now a sitemap index — read all sub-sitemaps
  const subSitemaps = ['sitemap-pages.xml', 'sitemap-blog.xml', 'sitemap-glossario.xml', 'sitemap-jobs.xml'];
  for (const file of subSitemaps) {
    try {
      const xml = readFileSync(resolve(__dirname, '..', 'public', file), 'utf-8');
      for (const m of xml.matchAll(/<loc>([^<]+)<\/loc>/g)) urls.add(m[1].trim());
      for (const m of xml.matchAll(/hreflang="[^"]*"\s+href="([^"]+)"/g)) urls.add(m[1].trim());
    } catch { /* sub-sitemap may not exist */ }
  }

  // News sitemap: <loc> URLs for articles
  try {
    const newsXml = readFileSync(resolve(__dirname, '..', 'public', 'sitemap-news.xml'), 'utf-8');
    for (const m of newsXml.matchAll(/<loc>([^<]+)<\/loc>/g)) urls.add(m[1].trim());
  } catch { /* sitemap-news.xml may not exist */ }

  return [...urls].sort();
}

function readXml(relativePath) {
  const __dirname = dirname(fileURLToPath(import.meta.url));
  const absolute = resolve(__dirname, '..', ...relativePath);
  return readFileSync(absolute, 'utf-8');
}

function extractUrlBlockByAnyMatch(sitemapXml, targets) {
  const targetSet = new Set(targets.filter(Boolean));
  if (targetSet.size === 0) return null;

  for (const match of sitemapXml.matchAll(/<url>[\s\S]*?<\/url>/g)) {
    const block = match[0];
    for (const t of targetSet) {
      if (block.includes(`<loc>${t}</loc>`) || block.includes(`href="${t}"`)) {
        return block;
      }
    }
  }
  return null;
}

function extractUrlsFromUrlBlock(urlBlock) {
  const urls = new Set();
  for (const m of urlBlock.matchAll(/<loc>([^<]+)<\/loc>/g)) urls.add(m[1].trim());
  for (const m of urlBlock.matchAll(/hreflang="[^"]*"\s+href="([^"]+)"/g)) urls.add(m[1].trim());
  return [...urls];
}

function getRecentNewsUrls(newsXml, count) {
  const locs = [...newsXml.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1].trim());
  // sitemap-news.xml is chronological; take last N
  return locs.slice(-count);
}

function getBingUrlsSubset() {
  // Read all sub-sitemaps for URL block lookup
  const sitemapXml = ['sitemap-pages.xml', 'sitemap-blog.xml', 'sitemap-glossario.xml']
    .map(f => { try { return readXml(['public', f]); } catch { return ''; } }).join('\n');

  // Preferred: the newly generated article URL (from CI workflow output)
  if (ARTICLE_URL) {
    const block = extractUrlBlockByAnyMatch(sitemapXml, [ARTICLE_URL]);
    if (block) {
      const urls = extractUrlsFromUrlBlock(block);
      return { urls, reason: 'new-article' };
    }
    console.warn(`⚠️  ARTICLE_URL non trovato nelle sub-sitemaps, fallback a news sitemap: ${ARTICLE_URL}`);
  }

  // Fallback: last 1–5 items from news sitemap (resolve alternates if present)
  let newsXml = '';
  try {
    newsXml = readXml(['public', 'sitemap-news.xml']);
  } catch {
    return { urls: [], reason: 'no-news-sitemap' };
  }
  const recent = getRecentNewsUrls(newsXml, BING_RECENT_NEWS_FALLBACK);
  const subset = new Set();
  for (const url of recent) {
    const block = extractUrlBlockByAnyMatch(sitemapXml, [url]);
    if (block) {
      for (const u of extractUrlsFromUrlBlock(block)) subset.add(u);
    } else {
      subset.add(url);
    }
  }
  return { urls: [...subset], reason: 'recent-news-fallback' };
}

// ── Sitemap diff: fetch deployed sitemaps and find NEW URLs ──
async function getDeployedUrls() {
  const sitemapFiles = ['sitemap-pages.xml', 'sitemap-blog.xml', 'sitemap-glossario.xml', 'sitemap-jobs.xml', 'sitemap-news.xml'];
  const urls = new Set();

  for (const file of sitemapFiles) {
    try {
      const res = await fetch(`https://${HOST}/${file}`, {
        headers: { 'Accept': 'application/xml, text/xml' },
      });
      if (!res.ok) continue;
      const xml = await res.text();
      for (const m of xml.matchAll(/<loc>([^<]+)<\/loc>/g)) urls.add(m[1].trim());
      for (const m of xml.matchAll(/hreflang="[^"]*"\s+href="([^"]+)"/g)) urls.add(m[1].trim());
    } catch { /* sitemap may not exist on deployed site */ }
  }

  return urls;
}

function getNewUrls(localUrls, deployedUrls) {
  return localUrls.filter(url => !deployedUrls.has(url));
}

// ── Pre-verify the key file is reachable ────────────────────
async function verifyKeyFile() {
  try {
    const res = await fetch(KEY_LOCATION, {
      headers: { 'Accept': 'text/plain' },
    });
    if (!res.ok) {
      console.error(`❌ Key file non raggiungibile: ${res.status} ${res.statusText}`);
      console.error(`   URL: ${KEY_LOCATION}`);
      return false;
    }
    const body = (await res.text()).trim();
    if (body !== INDEXNOW_KEY) {
      console.error(`❌ Key file contenuto non corrispondente!`);
      console.error(`   Atteso: ${INDEXNOW_KEY}`);
      console.error(`   Trovato: ${body.slice(0, 60)}`);
      return false;
    }
    console.log(`✅ Key file verificato: ${KEY_LOCATION}\n`);
    return true;
  } catch (err) {
    console.error(`❌ Errore fetch key file: ${err.message}`);
    return false;
  }
}

// ── Submit a batch of URLs to a single endpoint ─────────────
async function submitBatch(endpoint, urlBatch, attempt = 1) {
  const engineName = new URL(endpoint).hostname;
  const payload = {
    host: HOST,
    key: INDEXNOW_KEY,
    keyLocation: KEY_LOCATION,
    urlList: urlBatch,
  };

  try {
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json; charset=utf-8' },
      body: JSON.stringify(payload),
    });

    if (response.ok || response.status === 202) {
      return { ok: true, status: response.status };
    }

    const text = await response.text().catch(() => '');

    // Retry on 429 (rate limit) or 5xx with backoff
    if ((response.status === 429 || response.status >= 500) && attempt <= MAX_RETRIES) {
      const delay = 2000 * attempt;
      console.log(`   ⏳ ${engineName}: ${response.status} — retry ${attempt}/${MAX_RETRIES} tra ${delay / 1000}s`);
      await sleep(delay);
      return submitBatch(endpoint, urlBatch, attempt + 1);
    }

    return { ok: false, status: response.status, body: text };
  } catch (error) {
    if (attempt <= MAX_RETRIES) {
      const delay = 2000 * attempt;
      console.log(`   ⏳ ${engineName}: errore di rete — retry ${attempt}/${MAX_RETRIES} tra ${delay / 1000}s`);
      await sleep(delay);
      return submitBatch(endpoint, urlBatch, attempt + 1);
    }
    return { ok: false, status: 0, body: error.message };
  }
}

// ── Fallback: submit single URL via GET ─────────────────────
async function submitSingleGet(endpoint, url) {
  const params = new URLSearchParams({
    url,
    key: INDEXNOW_KEY,
    keyLocation: KEY_LOCATION,
  });
  try {
    const res = await fetch(`${endpoint}?${params}`);
    return { ok: res.ok || res.status === 202, status: res.status };
  } catch {
    return { ok: false, status: 0 };
  }
}

// ── Bing Webmaster URL Submission API ────────────────────────
async function submitToBingApi(urlList) {
  const apiKey = process.env.BING_API_KEY;
  if (!apiKey) {
    console.log('ℹ️  BING_API_KEY non configurata — skip Bing Webmaster API');
    return;
  }

  // IMPORTANT: keep Bing Webmaster API submissions small to avoid daily quota issues.
  const { urls: bingUrls, reason } = getBingUrlsSubset();
  if (bingUrls.length === 0) {
    console.log('ℹ️  Bing Webmaster API: nessun URL da inviare (subset vuoto)');
    return;
  }

  const endpoint = `https://ssl.bing.com/webmaster/api.svc/json/SubmitUrlbatch?apikey=${apiKey}`;
  const BING_BATCH = 500; // Bing API limit: 500 URLs per request

  let totalSubmitted = 0;
  const batches = [];
  for (let i = 0; i < bingUrls.length; i += BING_BATCH) {
    batches.push(bingUrls.slice(i, i + BING_BATCH));
  }

  console.log(`📨 Bing Webmaster API: invio subset (${reason}) — ${bingUrls.length} URL`);

  for (let b = 0; b < batches.length; b++) {
    const batch = batches[b];
    try {
      const res = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json; charset=utf-8' },
        body: JSON.stringify({
          siteUrl: `https://${HOST}`,
          urlList: batch,
        }),
      });
      if (res.ok || res.status === 200) {
        totalSubmitted += batch.length;
      } else {
        const text = await res.text().catch(() => '');
        console.warn(`⚠️  Bing API: ${res.status} — ${text.slice(0, 200)}`);
        break;
      }
    } catch (err) {
      console.warn(`⚠️  Bing API errore: ${err.message}`);
      break;
    }
    if (b < batches.length - 1) await sleep(500);
  }

  if (totalSubmitted > 0) console.log(`✅ Bing Webmaster API: ${totalSubmitted} URLs submitted`);
}

// ── Bing Content Submission API (for Copilot) ────────────────
// Bing's experimental Content Submission API lets you push structured
// content (facts, FAQs) so Copilot can surface them in AI answers.
// Docs: https://learn.microsoft.com/en-us/bingwebmaster/content-submission-api
async function submitToBingContentApi() {
  const apiKey = process.env.BING_API_KEY;
  if (!apiKey) {
    console.log('ℹ️  BING_API_KEY non configurata — skip Bing Content Submission API');
    return;
  }

  const __dir = dirname(fileURLToPath(import.meta.url));
  let llmsContent;
  try {
    llmsContent = readFileSync(resolve(__dir, '..', 'public', 'llms-full.txt'), 'utf-8');
  } catch {
    console.warn('⚠️  llms-full.txt non trovato — skip Bing Content Submission');
    return;
  }

  const siteUrl = `https://${HOST}`;
  const endpoint = `https://ssl.bing.com/webmaster/api.svc/json/SubmitContent?apikey=${encodeURIComponent(apiKey)}`;

  // Submit structured content as a document
  const payload = {
    siteUrl,
    content: llmsContent.slice(0, 100_000), // API limit: 100 KB per submission
    contentType: 'text/plain',
    url: `${siteUrl}/llms-full.txt`,
    title: 'Frontaliere Ticino — Complete AI Reference Documentation',
    description: 'Comprehensive reference for Swiss-Italian cross-border workers: tax simulation, pension planning, health insurance comparison, currency exchange, and practical guides.',
    language: 'it',
    lastModified: new Date().toISOString(),
  };

  console.log(`📨 Bing Content Submission API: invio llms-full.txt (${(llmsContent.length / 1024).toFixed(1)} KB)`);

  try {
    const res = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json; charset=utf-8' },
      body: JSON.stringify(payload),
    });
    if (res.ok || res.status === 200 || res.status === 202) {
      console.log(`✅ Bing Content Submission API: contenuto inviato con successo`);
    } else {
      const text = await res.text().catch(() => '');
      console.warn(`⚠️  Bing Content API: ${res.status} — ${text.slice(0, 300)}`);
    }
  } catch (err) {
    console.warn(`⚠️  Bing Content API errore: ${err.message}`);
  }

  // Also submit the short llms.txt as a secondary document
  try {
    const llmsShort = readFileSync(resolve(__dir, '..', 'public', 'llms.txt'), 'utf-8');
    const shortPayload = {
      siteUrl,
      content: llmsShort,
      contentType: 'text/plain',
      url: `${siteUrl}/llms.txt`,
      title: 'Frontaliere Ticino — LLM Site Summary',
      description: 'LLM-readable site summary with key facts, tools, and FAQ for cross-border workers.',
      language: 'it',
      lastModified: new Date().toISOString(),
    };

    const res2 = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json; charset=utf-8' },
      body: JSON.stringify(shortPayload),
    });
    if (res2.ok || res2.status === 200 || res2.status === 202) {
      console.log(`✅ Bing Content Submission API: llms.txt inviato con successo`);
    } else {
      const text = await res2.text().catch(() => '');
      console.warn(`⚠️  Bing Content API (llms.txt): ${res2.status} — ${text.slice(0, 300)}`);
    }
  } catch (err) {
    console.warn(`⚠️  Bing Content API llms.txt: ${err.message}`);
  }
}

// ── You.com IndexNow Submission ──────────────────────────────
// You.com supports IndexNow protocol. We submit our key pages
// to their dedicated IndexNow endpoint for AI search inclusion.
// Docs: https://you.com/webmaster
async function submitToYouCom(urlList) {
  const youComEndpoint = 'https://yep.com/indexnow';

  // Submit a curated subset of high-value AI-relevant pages
  const priorityPaths = [
    '/', '/en/', '/de/', '/fr/',
    '/llms.txt', '/llms-full.txt',
    '/calcola-stipendio', '/comparatori/cambio-valuta',
    '/articoli-frontaliere', '/guida-frontaliere',
    '/sitemap.xml',
  ];
  const priorityUrls = priorityPaths.map(p => `https://${HOST}${p}`);

  // Also submit the full sitemap URLs (You.com crawls and indexes from these)
  const allUrls = [...new Set([...priorityUrls, ...urlList])];

  const batches = [];
  for (let i = 0; i < allUrls.length; i += BATCH_SIZE) {
    batches.push(allUrls.slice(i, i + BATCH_SIZE));
  }

  let totalSubmitted = 0;
  console.log(`📨 You.com (IndexNow via yep.com): invio ${allUrls.length} URLs`);

  for (let b = 0; b < batches.length; b++) {
    const batch = batches[b];
    const result = await submitBatch(youComEndpoint, batch);
    if (result.ok) {
      totalSubmitted += batch.length;
    } else {
      console.warn(`⚠️  You.com: ${result.status} — ${(result.body || '').slice(0, 200)}`);
      break;
    }
    if (b < batches.length - 1) await sleep(500);
  }

  if (totalSubmitted > 0) {
    console.log(`✅ You.com (yep.com): ${totalSubmitted} URLs submitted`);
  }
}

// ── Main ────────────────────────────────────────────────────
async function submitToIndexNow() {
  const urlList = getUrlsFromSitemaps();
  console.log(`📊 ${urlList.length} URLs trovati nelle sitemap (tutte le lingue)`);

  // Sitemap diff: fetch deployed sitemaps and find new URLs
  const deployedUrls = await getDeployedUrls();
  const newUrls = getNewUrls(urlList, deployedUrls);

  if (deployedUrls.size === 0) {
    console.log('ℹ️  Nessuna sitemap deployata trovata — invio tutti gli URLs');
  } else {
    console.log(`📊 ${deployedUrls.size} URLs nella sitemap deployata, ${newUrls.length} nuovi URLs rilevati`);
  }

  // Decide what to submit: only new URLs if available, otherwise all
  const urlsToSubmit = deployedUrls.size > 0 && newUrls.length > 0
    ? newUrls
    : deployedUrls.size > 0 && newUrls.length === 0
      ? [] // no new URLs — skip per-URL submission
      : urlList; // no deployed sitemaps — submit all

  // Pre-check: is the key file deployed and reachable?
  const keyOk = await verifyKeyFile();
  if (!keyOk) {
    console.error('\n🛑 Interruzione: il key file non è raggiungibile o non è valido.');
    console.error('   Assicurati che il deploy sia completato e il file sia accessibile.');
    process.exit(1);
  }

  if (urlsToSubmit.length === 0) {
    console.log('✅ Nessun nuovo URL da sottomettere — sitemap invariate');
  } else {
    if (deployedUrls.size > 0 && newUrls.length > 0) {
      console.log(`📨 Sottomissione solo dei ${newUrls.length} nuovi URLs:`);
      for (const u of newUrls.slice(0, 10)) console.log(`   → ${u}`);
      if (newUrls.length > 10) console.log(`   ... e altri ${newUrls.length - 10}`);
    }

    // Split into batches
    const batches = [];
    for (let i = 0; i < urlsToSubmit.length; i += BATCH_SIZE) {
      batches.push(urlsToSubmit.slice(i, i + BATCH_SIZE));
    }

    const endpoints = [
      'https://api.indexnow.org/indexnow',
      'https://www.bing.com/indexnow',
      'https://yandex.com/indexnow',
    ];

    for (const endpoint of endpoints) {
      const engineName = new URL(endpoint).hostname;
      let totalSubmitted = 0;
      let failed = false;

      for (let b = 0; b < batches.length; b++) {
        const batch = batches[b];
        const label = batches.length > 1 ? ` (batch ${b + 1}/${batches.length})` : '';
        const result = await submitBatch(endpoint, batch);

        if (result.ok) {
          totalSubmitted += batch.length;
        } else {
          // On 403, try single-URL GET as a diagnostic probe
          if (result.status === 403) {
            const probe = await submitSingleGet(endpoint, urlsToSubmit[0]);
            if (probe.ok) {
              console.log(`⚠️ ${engineName}${label}: POST 403 ma GET OK (${probe.status}) — possibile limite batch`);
              totalSubmitted += 1;
            } else {
              console.warn(`⚠️ ${engineName}${label}: ${result.status} — ${result.body}`);
              console.warn(`   → Il key file è raggiungibile ma l'engine rifiuta la submission.`);
              console.warn(`   → Prova a verificare il sito su Bing Webmaster Tools: https://www.bing.com/webmasters`);
            }
            failed = true;
            break; // skip remaining batches for this endpoint
          }
          console.warn(`⚠️ ${engineName}${label}: ${result.status} — ${result.body}`);
          failed = true;
          break;
        }

        // Small delay between batches to be polite
        if (b < batches.length - 1) await sleep(500);
      }

      if (!failed) {
        console.log(`✅ ${engineName}: ${totalSubmitted} URLs submitted`);
      }
    }
  }

  // Complementary: Bing Webmaster URL Submission API (uses its own subset logic)
  await submitToBingApi(urlList);

  // Bing Content Submission API (structured content for Copilot)
  await submitToBingContentApi();

  // You.com AI Search (IndexNow via yep.com) — uses new URLs if available
  await submitToYouCom(urlsToSubmit.length > 0 ? urlsToSubmit : urlList);
}

submitToIndexNow().catch(console.error);
