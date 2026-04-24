#!/usr/bin/env node
/**
 * SEO structural audit — scans ALL sitemap URLs and validates structure.
 *
 * Checks per URL:
 *   1. HTTP 200
 *   2. <main class="seo-static-content"> OUTSIDE <div id="root"></div>
 *   3. <link rel="canonical"> matches the URL
 *   4. <h1> exists, length >= 10
 *   5. No "Annuncio non trovato" / "non è stato trovato" / title placeholder
 *   6. All /cerca-lavoro-ticino/?q= links vs /azienda-SLUG canonical links
 *   7. og:url matches URL
 *
 * Output: .orchestration/audit/structural.json + structural-summary.md
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import { URL as NodeURL } from 'node:url';

const BASE = 'https://frontaliereticino.ch';
const OUT_DIR = '.orchestration/audit';
mkdirSync(OUT_DIR, { recursive: true });

const SITEMAPS = [
  'annual-report', 'border-wait-map', 'border-wait', 'career-landings',
  'comparisons', 'cost-of-living', 'faq-hub', 'fuel-daily',
  'fuel-italian-cities', 'fuel-stations', 'health-premiums', 'job-market',
  'jobs', 'market-report', 'nursing', 'orphan-landings', 'pages',
  'professions', 'recency', 'salary-hub', 'sector', 'weekly-employers',
  'guides',
];

// Sample size per sitemap to keep runtime reasonable
const SAMPLE_PER_SITEMAP = 20;

async function fetchText(url, attempt = 1) {
  try {
    const res = await fetch(url, { redirect: 'follow' });
    return { status: res.status, text: await res.text(), url: res.url };
  } catch (e) {
    if (attempt < 3) {
      await new Promise(r => setTimeout(r, 500));
      return fetchText(url, attempt + 1);
    }
    return { status: 0, text: '', url, error: String(e) };
  }
}

function extractUrlsFromSitemap(xml) {
  const matches = xml.match(/<loc>([^<]+)<\/loc>/g) || [];
  return matches.map(m => m.slice(5, -6).trim());
}

function sampleUrls(urls, n) {
  if (urls.length <= n) return urls;
  const picks = new Set();
  picks.add(urls[0]);
  picks.add(urls[urls.length - 1]);
  while (picks.size < n) {
    picks.add(urls[Math.floor(Math.random() * urls.length)]);
  }
  return [...picks];
}

function checkStructure(url, html) {
  const issues = [];

  // 1. Main outside root check
  // Pattern: <div id="root"></div>...<main
  const flat = html.replace(/\s+/g, ' ');
  const rootIdx = flat.indexOf('<div id="root">');
  const rootCloseIdx = flat.indexOf('</div>', rootIdx);
  const firstMainIdx = flat.indexOf('<main', rootIdx);
  if (rootIdx === -1) {
    issues.push({ code: 'NO_ROOT_DIV', severity: 'high' });
  } else if (firstMainIdx === -1) {
    issues.push({ code: 'NO_MAIN', severity: 'high' });
  } else if (firstMainIdx < rootCloseIdx) {
    issues.push({
      code: 'MAIN_INSIDE_ROOT',
      severity: 'high',
      detail: `<main> at index ${firstMainIdx} comes before </div> at ${rootCloseIdx}`,
    });
  }

  // 2. Canonical matches URL
  const canonMatch = html.match(/<link rel="canonical" href="([^"]+)"/);
  const canonical = canonMatch ? canonMatch[1] : null;
  if (!canonical) {
    issues.push({ code: 'NO_CANONICAL', severity: 'medium' });
  } else {
    // Normalize (trailing slash, etc.)
    const normUrl = url.replace(/\/$/, '');
    const normCanon = canonical.replace(/\/$/, '');
    if (normUrl !== normCanon) {
      issues.push({ code: 'CANONICAL_MISMATCH', severity: 'high', detail: `canonical=${canonical} vs url=${url}` });
    }
  }

  // 3. H1 exists
  const h1Match = html.match(/<h1[^>]*>([^<]{0,200})/);
  const h1 = h1Match ? h1Match[1].trim() : '';
  if (!h1) {
    issues.push({ code: 'NO_H1', severity: 'high' });
  } else if (h1.length < 10) {
    issues.push({ code: 'H1_TOO_SHORT', severity: 'medium', detail: `h1="${h1}"` });
  }

  // 4. No not-found banner / placeholders
  if (/Annuncio non trovato|non è più disponibile o non è stato trovato/.test(html)) {
    issues.push({ code: 'NOT_FOUND_BANNER', severity: 'high' });
  }
  const titleMatch = html.match(/<title>([^<]+)<\/title>/);
  const title = titleMatch ? titleMatch[1] : '';
  if (/\|\s*A\s*\||\|\s*simulazione\s*\|/.test(title)) {
    issues.push({ code: 'TITLE_PLACEHOLDER', severity: 'high', detail: `title="${title}"` });
  }

  // 5. Query-fallback vs canonical links inside main content
  const qFallbacks = (html.match(/href="\/cerca-lavoro-ticino\/\?q=/g) || []).length;
  const aziendaCanonicals = (html.match(/href="\/cerca-lavoro-ticino\/azienda-/g) || []).length;

  // 6. og:url
  const ogMatch = html.match(/<meta\s+property="og:url"\s+content="([^"]+)"/);
  const ogUrl = ogMatch ? ogMatch[1] : null;
  if (ogUrl && url) {
    const normUrl = url.replace(/\/$/, '');
    const normOg = ogUrl.replace(/\/$/, '');
    if (normUrl !== normOg) {
      issues.push({ code: 'OG_URL_MISMATCH', severity: 'medium', detail: `og:url=${ogUrl} vs url=${url}` });
    }
  }

  return { h1, title, canonical, qFallbacks, aziendaCanonicals, issues };
}

async function run() {
  const results = {};
  const allIssues = [];
  let totalChecked = 0;

  for (const sm of SITEMAPS) {
    const smUrl = `${BASE}/sitemap-${sm}.xml`;
    const smRes = await fetchText(smUrl);
    if (smRes.status !== 200) {
      console.error(`SKIP sitemap-${sm}: ${smRes.status}`);
      results[sm] = { totalUrls: 0, sampled: 0, fails: 0, status: `sitemap-status-${smRes.status}` };
      continue;
    }
    const urls = extractUrlsFromSitemap(smRes.text);
    const sampled = sampleUrls(urls, SAMPLE_PER_SITEMAP);
    const smResult = { totalUrls: urls.length, sampled: sampled.length, fails: 0, urls: [] };

    console.log(`[${sm}] ${urls.length} URLs, sampling ${sampled.length}`);

    // Parallel fetch with concurrency limit
    const chunks = [];
    const C = 5;
    for (let i = 0; i < sampled.length; i += C) chunks.push(sampled.slice(i, i + C));

    for (const chunk of chunks) {
      const batch = await Promise.all(
        chunk.map(async (url) => {
          const res = await fetchText(url);
          if (res.status !== 200) {
            return { url, status: res.status, issues: [{ code: 'HTTP_ERROR', severity: 'high', detail: `status=${res.status}` }] };
          }
          const check = checkStructure(url, res.text);
          return { url, status: 200, ...check };
        })
      );
      smResult.urls.push(...batch);
      totalChecked += batch.length;
    }

    smResult.fails = smResult.urls.filter((u) => (u.issues || []).some((i) => i.severity === 'high')).length;
    results[sm] = smResult;

    // Collect high-severity issues
    for (const u of smResult.urls) {
      for (const iss of u.issues || []) {
        if (iss.severity === 'high') {
          allIssues.push({ sitemap: sm, url: u.url, ...iss });
        }
      }
    }

    console.log(`  ${smResult.fails}/${smResult.sampled} pages with high-severity issues`);
  }

  writeFileSync(`${OUT_DIR}/structural.json`, JSON.stringify({ results, totalChecked, allIssues }, null, 2));

  // Markdown summary
  const md = [];
  md.push(`# Structural audit — ${new Date().toISOString()}\n`);
  md.push(`Total URLs checked: **${totalChecked}**`);
  md.push(`High-severity issues: **${allIssues.length}**\n`);
  md.push('## Per-sitemap summary\n');
  md.push('| Sitemap | Total URLs | Sampled | Failures |');
  md.push('|---------|-----------:|--------:|---------:|');
  for (const [sm, r] of Object.entries(results)) {
    md.push(`| ${sm} | ${r.totalUrls} | ${r.sampled} | ${r.fails} |`);
  }
  md.push('\n## Issues grouped by code\n');
  const byCode = {};
  for (const i of allIssues) (byCode[i.code] ||= []).push(i);
  for (const [code, list] of Object.entries(byCode).sort((a, b) => b[1].length - a[1].length)) {
    md.push(`\n### ${code} (${list.length} occurrences)\n`);
    for (const i of list.slice(0, 10)) {
      md.push(`- [${i.sitemap}] ${i.url}${i.detail ? ` — ${i.detail}` : ''}`);
    }
    if (list.length > 10) md.push(`  ...and ${list.length - 10} more`);
  }
  writeFileSync(`${OUT_DIR}/structural-summary.md`, md.join('\n') + '\n');

  console.log(`\nDone. ${totalChecked} checked, ${allIssues.length} high-severity issues.`);
  console.log(`See ${OUT_DIR}/structural.json and ${OUT_DIR}/structural-summary.md`);
}

run().catch((e) => {
  console.error(e);
  process.exit(1);
});
