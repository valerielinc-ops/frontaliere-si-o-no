#!/usr/bin/env node
import { readFileSync, existsSync, readdirSync, statSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const ROOT = process.cwd();
const DIST = path.resolve(ROOT, 'dist');
const PUBLIC = path.resolve(ROOT, 'public');
const REPORTS_DIR = path.resolve(ROOT, 'reports');
const BASE_URL = 'https://frontaliereticino.ch';

const args = process.argv.slice(2);
const flags = {
  sample: 140,
  save: false,
  strict: false,
};

for (let i = 0; i < args.length; i += 1) {
  const a = args[i];
  if (a === '--save') flags.save = true;
  else if (a === '--strict') flags.strict = true;
  else if (a === '--sample') flags.sample = Math.max(20, Math.min(600, Number(args[i + 1] || 140)));
}

const RE = {
  loc: /<loc>(.*?)<\/loc>/gi,
  stripScript: /<script[\s\S]*?<\/script>/gi,
  stripStyle: /<style[\s\S]*?<\/style>/gi,
  stripNoScript: /<noscript[\s\S]*?<\/noscript>/gi,
  stripSvg: /<svg[\s\S]*?<\/svg>/gi,
  stripTags: /<[^>]+>/g,
  ws: /\s+/g,
  adInsSlot: /<ins[^>]*\badsbygoogle\b[^>]*>/gi,
  adClientTag: /data-ad-client=/gi,
  adSenseMeta: /google-adsense-account/gi,
  adSenseScript: /pagead2\.googlesyndication\.com/gi,
  heading: /<h[1-3][^>]*>/gi,
  paragraph: /<(p|li)[^>]*>/gi,
  mainLike: /<(main|article)[^>]*>/gi,
};

const THIN_TEXT_CHARS = 900;
const THIN_WORDS = 140;
const LOW_RICHNESS_BLOCKS = 3;
const MIN_CHARS_PER_AD_SLOT = 500;

function fmtDate(d = new Date()) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  return `${y}${m}${day}-${hh}${mm}`;
}

function countRegex(re, s) {
  const m = String(s || '').match(re);
  return m ? m.length : 0;
}

function extractUrlsFromSitemapFile(filePath) {
  if (!existsSync(filePath)) return [];
  const xml = readFileSync(filePath, 'utf8');
  const out = [];
  let m;
  while ((m = RE.loc.exec(xml)) !== null) {
    const url = String(m[1] || '').trim();
    if (url.startsWith(BASE_URL)) out.push(url);
  }
  return out;
}

function mapUrlToDistPath(url) {
  try {
    const u = new URL(url);
    const pathname = decodeURIComponent(u.pathname || '/');
    if (pathname === '/') return path.resolve(DIST, 'index.html');
    const clean = pathname.replace(/^\/+/, '').replace(/\/+$/, '');
    const candidateA = path.resolve(DIST, clean, 'index.html');
    const candidateB = path.resolve(DIST, `${clean}.html`);
    if (existsSync(candidateA)) return candidateA;
    if (existsSync(candidateB)) return candidateB;
    return candidateA;
  } catch {
    return '';
  }
}

function walkHtmlFiles(dir, out = []) {
  if (!existsSync(dir)) return out;
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) walkHtmlFiles(full, out);
    else if (st.isFile() && full.endsWith('.html')) out.push(full);
  }
  return out;
}

function normalizeTextFromHtml(html) {
  return String(html || '')
    .replace(RE.stripScript, ' ')
    .replace(RE.stripStyle, ' ')
    .replace(RE.stripNoScript, ' ')
    .replace(RE.stripSvg, ' ')
    .replace(RE.stripTags, ' ')
    .replace(/&nbsp;|&#160;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(RE.ws, ' ')
    .trim();
}

function isLikelyUtilityOrErrorPage(url, html) {
  const p = (() => {
    try { return new URL(url).pathname.toLowerCase(); } catch { return ''; }
  })();
  if (p.includes('/404') || p.includes('/errore') || p.includes('/not-found')) return true;
  const t = normalizeTextFromHtml(html).toLowerCase();
  return (
    t.includes('pagina non trovata') ||
    t.includes('page not found') ||
    t.includes('site under construction') ||
    t.includes('coming soon') ||
    t.includes('in manutenzione')
  );
}

function auditPage(url, filePath, html) {
  const text = normalizeTextFromHtml(html);
  const wordCount = text ? text.split(' ').filter(Boolean).length : 0;
  const textChars = text.length;
  const headingCount = countRegex(RE.heading, html);
  const paragraphCount = countRegex(RE.paragraph, html);
  const mainCount = countRegex(RE.mainLike, html);
  const adInsSlots = countRegex(RE.adInsSlot, html);
  const adClientTags = countRegex(RE.adClientTag, html);
  const adSignals = adInsSlots + adClientTags + countRegex(RE.adSenseMeta, html) + countRegex(RE.adSenseScript, html);
  const contentBlocks = headingCount + paragraphCount + mainCount;
  const charsPerSlot = adInsSlots > 0 ? Math.round(textChars / Math.max(1, adInsSlots)) : null;

  const issues = [];
  const warnings = [];
  const utilityLike = isLikelyUtilityOrErrorPage(url, html);
  const thin = textChars < THIN_TEXT_CHARS || wordCount < THIN_WORDS || contentBlocks < LOW_RICHNESS_BLOCKS;

  if (utilityLike && adSignals > 0) {
    issues.push('ads_on_utility_or_error_page');
  }
  if (thin && (adInsSlots > 0 || adClientTags > 0)) {
    issues.push('ads_on_thin_content_page');
  }
  if (adInsSlots > 0 && charsPerSlot !== null && charsPerSlot < MIN_CHARS_PER_AD_SLOT) {
    issues.push(`low_content_to_ad_ratio:${charsPerSlot}`);
  }
  if (mainCount === 0) {
    warnings.push('missing_main_or_article_container');
  }
  if (wordCount < 250) {
    warnings.push(`low_word_count:${wordCount}`);
  }
  if (adInsSlots > 2) {
    warnings.push(`high_ad_slots:${adInsSlots}`);
  }

  return {
    url,
    filePath: path.relative(ROOT, filePath),
    metrics: {
      textChars,
      wordCount,
      headingCount,
      paragraphCount,
      mainCount,
      adInsSlots,
      adClientTags,
      adSignals,
      charsPerSlot,
      contentBlocks,
      thin,
      utilityLike,
    },
    status: issues.length > 0 ? 'fail' : warnings.length > 0 ? 'warn' : 'pass',
    issues,
    warnings,
  };
}

function pickUrlSamples() {
  const candidates = new Set();
  const sitemapFiles = [
    path.resolve(DIST, 'sitemap.xml'),
    path.resolve(DIST, 'sitemap-pages.xml'),
    path.resolve(DIST, 'sitemap-blog.xml'),
    path.resolve(DIST, 'sitemap-news.xml'),
    path.resolve(DIST, 'sitemap-jobs.xml'),
    path.resolve(PUBLIC, 'sitemap.xml'),
    path.resolve(PUBLIC, 'sitemap-pages.xml'),
    path.resolve(PUBLIC, 'sitemap-blog.xml'),
    path.resolve(PUBLIC, 'sitemap-news.xml'),
    path.resolve(PUBLIC, 'sitemap-jobs.xml'),
  ];
  for (const sf of sitemapFiles) {
    for (const url of extractUrlsFromSitemapFile(sf)) candidates.add(url);
  }

  if (candidates.size === 0 && existsSync(DIST)) {
    const files = walkHtmlFiles(DIST);
    for (const f of files) {
      const rel = path.relative(DIST, f).replace(/\\/g, '/');
      const url = rel === 'index.html'
        ? `${BASE_URL}/`
        : `${BASE_URL}/${rel.replace(/\/index\.html$/, '/').replace(/\.html$/, '')}`;
      candidates.add(url);
    }
  }

  const urls = [...candidates];
  const scoring = (u) => {
    const p = new URL(u).pathname;
    let s = 0;
    if (p === '/') s += 90;
    if (p.includes('/articoli-frontaliere/')) s += 60;
    if (p.includes('/cerca-lavoro-ticino/')) s += 55;
    if (p.includes('/compara-servizi/')) s += 45;
    if (p.includes('/calcola-stipendio/')) s += 40;
    if (p.includes('/statistiche/')) s += 35;
    if (p.includes('/privacy') || p.includes('/cookie') || p.includes('/404')) s -= 50;
    return s;
  };

  return urls.sort((a, b) => scoring(b) - scoring(a)).slice(0, flags.sample);
}

function writeReports(report) {
  mkdirSync(REPORTS_DIR, { recursive: true });
  const stamp = fmtDate(new Date());
  const jsonPath = path.resolve(REPORTS_DIR, `adsense-prereview-${stamp}.json`);
  const mdPath = path.resolve(REPORTS_DIR, `adsense-prereview-${stamp}.md`);
  writeFileSync(jsonPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');

  const topFail = report.pages.filter((p) => p.status === 'fail').slice(0, 25);
  const topWarn = report.pages.filter((p) => p.status === 'warn').slice(0, 25);
  const lines = [
    '# AdSense Pre-Review Checklist',
    '',
    `- Generated at: ${report.generatedAt}`,
    `- Sample size: ${report.sampleSize}`,
    `- PASS: ${report.summary.pass}`,
    `- WARN: ${report.summary.warn}`,
    `- FAIL: ${report.summary.fail}`,
    '',
    '## Top FAIL pages',
    '',
    ...(topFail.length > 0 ? topFail.map((p) => `- ${p.url} | issues: ${p.issues.join(', ')}`) : ['- none']),
    '',
    '## Top WARN pages',
    '',
    ...(topWarn.length > 0 ? topWarn.map((p) => `- ${p.url} | warnings: ${p.warnings.join(', ')}`) : ['- none']),
    '',
    '## Decision',
    '',
    report.summary.fail > 0
      ? '- NOT READY for AdSense re-review: resolve FAIL pages first.'
      : '- READY for AdSense re-review (only WARN/non-blocking findings).',
    '',
  ];
  writeFileSync(mdPath, `${lines.join('\n')}\n`, 'utf8');
  return { jsonPath, mdPath };
}

function main() {
  if (!existsSync(DIST)) {
    console.error('❌ dist/ not found. Run build first.');
    process.exit(1);
  }

  const urls = pickUrlSamples();
  const pages = [];
  for (const url of urls) {
    const filePath = mapUrlToDistPath(url);
    if (!filePath || !existsSync(filePath)) {
      pages.push({
        url,
        filePath: filePath ? path.relative(ROOT, filePath) : 'n/a',
        status: 'fail',
        issues: ['html_file_missing'],
        warnings: [],
        metrics: null,
      });
      continue;
    }
    const html = readFileSync(filePath, 'utf8');
    pages.push(auditPage(url, filePath, html));
  }

  const summary = {
    pass: pages.filter((p) => p.status === 'pass').length,
    warn: pages.filter((p) => p.status === 'warn').length,
    fail: pages.filter((p) => p.status === 'fail').length,
  };
  const report = {
    generatedAt: new Date().toISOString(),
    sampleSize: pages.length,
    thresholds: {
      thinTextChars: THIN_TEXT_CHARS,
      thinWords: THIN_WORDS,
      minContentBlocks: LOW_RICHNESS_BLOCKS,
      minCharsPerAdSlot: MIN_CHARS_PER_AD_SLOT,
    },
    summary,
    pages,
  };

  console.log('=== AdSense Pre-Review Checklist ===');
  console.log(`Sample pages: ${report.sampleSize}`);
  console.log(`PASS: ${summary.pass} | WARN: ${summary.warn} | FAIL: ${summary.fail}`);
  if (summary.fail > 0) {
    console.log('\nTop FAIL pages:');
    for (const p of pages.filter((x) => x.status === 'fail').slice(0, 20)) {
      console.log(`- ${p.url} -> ${p.issues.join(', ')}`);
    }
  }

  if (flags.save) {
    const out = writeReports(report);
    console.log(`\nSaved report: ${path.relative(ROOT, out.jsonPath)}`);
    console.log(`Saved summary: ${path.relative(ROOT, out.mdPath)}`);
  }

  if (flags.strict && summary.fail > 0) {
    process.exit(1);
  }
}

main();
