#!/usr/bin/env node

/**
 * Bing-facing live contract for the site repository.
 *
 * This is deliberately dependency-free and does not scrape the Bing UI. Bing
 * recommendations are the observation that motivated the policy; the
 * repeatable gate is the HTTP contract we control: status, canonical, title
 * length, visible homepage H1 and the six URLs that IndexNow reported as
 * missing.
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  BING_HOMEPAGE_URL,
  BING_INDEXNOW_REMEDIATION_URLS,
  BING_SEO_BASE_URL,
  BING_TITLE_AUDIT_URLS,
  BING_TITLE_MAX_CHARS,
} from './bing-seo-policy.mjs';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const LIVE_USER_AGENT = 'frontaliere-bing-seo-loop/1.0 (+https://frontaliereticino.ch/)';

function decodeHtmlEntities(value) {
  return String(value || '')
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>');
}

function stripTags(value) {
  return decodeHtmlEntities(String(value || '').replace(/<[^>]*>/g, ' '))
    .replace(/\s+/g, ' ')
    .trim();
}

export function normalizeUrl(value) {
  try {
    const url = new URL(value);
    url.hash = '';
    url.pathname = url.pathname.replace(/\/+/g, '/') || '/';
    if (url.pathname !== '/' && !url.pathname.endsWith('/')) url.pathname += '/';
    return url.toString();
  } catch {
    return String(value || '').trim();
  }
}

function extractAttribute(attributes, name) {
  const match = String(attributes || '').match(
    new RegExp('\\b' + name + '\\s*=\\s*(["' + "'" + '])(.*?)\\1', 'i'),
  );
  return match?.[2] || '';
}

function isHiddenHeading(attributes) {
  const raw = String(attributes || '').toLowerCase();
  return /display\s*:\s*none|visibility\s*:\s*hidden|left\s*:\s*-?9999|clip(?:-path)?\s*:|width\s*:\s*1px|height\s*:\s*1px|\bsr-only\b|\bvisually-hidden\b/.test(raw);
}

export function parseHtmlContract(html) {
  const source = String(html || '');
  const titleMatch = source.match(/<title\b[^>]*>([\s\S]*?)<\/title>/i);
  const canonicalMatches = [...source.matchAll(/<link\b([^>]*?)>/gi)]
    .map((match) => {
      const rel = extractAttribute(match[1], 'rel').toLowerCase();
      return rel.split(/\s+/).includes('canonical')
        ? extractAttribute(match[1], 'href')
        : '';
    })
    .filter(Boolean);
  const h1s = [...source.matchAll(/<h1\b([^>]*)>([\s\S]*?)<\/h1>/gi)]
    .map((match) => ({
      text: stripTags(match[2]),
      hidden: isHiddenHeading(match[1]),
    }));

  return {
    title: stripTags(titleMatch?.[1] || ''),
    canonical: canonicalMatches[0] || '',
    h1s,
  };
}

function finding(code, url, detail) {
  return { code, url, detail };
}

export function auditHtml(
  url,
  html,
  { homepage = false, checkCanonical = true, canonicalUrl = url } = {},
) {
  const parsed = parseHtmlContract(html);
  const findings = [];

  if (!parsed.title) {
    findings.push(finding('title-missing', url, 'La risposta HTML non contiene un title.'));
  } else if (parsed.title.length > BING_TITLE_MAX_CHARS) {
    findings.push(finding(
      'title-too-long',
      url,
      '<title> misura ' + parsed.title.length + ' caratteri; limite ' + BING_TITLE_MAX_CHARS + '.',
    ));
  }

  if (checkCanonical && !parsed.canonical) {
    findings.push(finding('canonical-missing', url, 'Manca il link canonical.'));
  } else if (checkCanonical && normalizeUrl(parsed.canonical) !== normalizeUrl(canonicalUrl)) {
    findings.push(finding(
      'canonical-drift',
      url,
      'Canonical ' + parsed.canonical + ' != URL finale ' + canonicalUrl + '.',
    ));
  }

  if (homepage) {
    if (parsed.h1s.length === 0) {
      findings.push(finding('homepage-h1-missing', url, 'La homepage non contiene un H1.'));
    } else if (parsed.h1s.length !== 1) {
      findings.push(finding(
        'homepage-h1-count',
        url,
        'La homepage contiene ' + parsed.h1s.length + ' H1; il contratto richiede esattamente uno.',
      ));
    } else if (!parsed.h1s[0].text) {
      findings.push(finding('homepage-h1-missing', url, 'L’unico H1 della homepage è vuoto.'));
    } else if (parsed.h1s[0].hidden) {
      findings.push(finding(
        'homepage-h1-hidden',
        url,
        'L’unico H1 della homepage è nascosto da stile/classe offscreen.',
      ));
    }
  }

  return { ...parsed, findings };
}

async function fetchDocument(url, { fetchImpl = globalThis.fetch, timeoutMs = 30_000 } = {}) {
  const response = await fetchImpl(url, {
    headers: { 'user-agent': LIVE_USER_AGENT, accept: 'text/html,application/xhtml+xml' },
    redirect: 'follow',
    signal: AbortSignal.timeout(timeoutMs),
  });
  const html = await response.text();
  return { response, html };
}

export async function auditLive({
  fetchImpl = globalThis.fetch,
  titleUrls = BING_TITLE_AUDIT_URLS,
  indexNowUrls = BING_INDEXNOW_REMEDIATION_URLS,
  homepageUrl = BING_HOMEPAGE_URL,
} = {}) {
  const urls = [...new Set([homepageUrl, ...titleUrls, ...indexNowUrls])];
  const titleUrlSet = new Set(titleUrls);
  const indexNowUrlSet = new Set(indexNowUrls);
  const pages = [];
  const findings = [];
  const warnings = [];

  for (const url of urls) {
    try {
      const { response, html } = await fetchDocument(url, { fetchImpl });
      const isHomepage = normalizeUrl(url) === normalizeUrl(homepageUrl);
      const finalUrl = response.url || url;
      const isTitlePage = titleUrlSet.has(url);
      const contract = auditHtml(url, html, {
        homepage: isHomepage,
        checkCanonical: isHomepage || isTitlePage,
        canonicalUrl: finalUrl,
      });
      pages.push({
        url,
        status: response.status,
        finalUrl,
        title: contract.title,
        titleLength: contract.title.length,
        canonical: contract.canonical,
        h1Count: contract.h1s.length,
      });
      if (response.status !== 200) {
        if (indexNowUrlSet.has(url) && response.status === 404) {
          warnings.push(finding(
            'indexnow-stale-url',
            url,
            'Bing ha segnalato un URL IndexNow che oggi non esiste più; il preflight lo esclude dall’invio.',
          ));
        } else {
          findings.push(finding('http-status', url, 'HTTP ' + response.status + '.'));
        }
      }
      findings.push(...contract.findings);
    } catch (error) {
      pages.push({ url, status: 0, error: error?.message || String(error) });
      findings.push(finding('fetch-error', url, error?.message || String(error)));
    }
  }

  return {
    checkedAt: new Date().toISOString(),
    baseUrl: BING_SEO_BASE_URL,
    pages,
    findings,
    warnings,
    summary: {
      checked: pages.length,
      findings: findings.length,
      warnings: warnings.length,
      titlePages: titleUrls.length,
      indexNowPages: indexNowUrls.length,
    },
  };
}

function sourceFinding(code, file, detail) {
  return { code, file, detail };
}

export function checkSource({ repoRoot = REPO_ROOT } = {}) {
  const findings = [];
  const read = (relativePath) => {
    try {
      return readFileSync(resolve(repoRoot, relativePath), 'utf8');
    } catch (error) {
      findings.push(sourceFinding(
        'source-missing',
        relativePath,
        error?.message || String(error),
      ));
      return '';
    }
  };

  const index = read('index.html');
  const staticPages = read('build-plugins/staticPagesPlugin.ts');
  const redirects = read('build-plugins/legacyRedirectsPlugin.ts');
  const loopWorkflow = read('.github/workflows/bing-seo-loop.yml');
  if (!/<h1\s+id="homepage-static-h1">[^<]+<\/h1>/i.test(index)) {
    findings.push(sourceFinding(
      'homepage-h1-source',
      'index.html',
      'index.html deve contenere l’H1 statico visibile con marker homepage-static-h1.',
    ));
  }
  const homepageH1 = index.match(/<h1\b[^>]*>[\s\S]*?<\/h1>/i)?.[0] || '';
  if (/position\s*:\s*absolute\s*;\s*left\s*:\s*-9999|width\s*:\s*1px|height\s*:\s*1px/i.test(homepageH1)) {
    findings.push(sourceFinding(
      'homepage-h1-hidden-source',
      'index.html',
      'La sorgente homepage non deve usare l’hidden/offscreen H1 precedente.',
    ));
  }
  if (!staticPages.includes('localizeHomepageStaticH1') || !staticPages.includes('out = localizeHomepageStaticH1(out, locale);')) {
    findings.push(sourceFinding(
      'homepage-h1-locale-source',
      'build-plugins/staticPagesPlugin.ts',
      'I root localizzati devono riscrivere il marker H1 con il testo della locale.',
    ));
  }
  if (!redirects.includes("'/fr/articles-frontalier/frais-de-transit-suisse/': '/fr/articles-frontalier/frais-de-transit-suisse-2026/'")) {
    findings.push(sourceFinding(
      'title-redirect-source',
      'build-plugins/legacyRedirectsPlugin.ts',
      'L’URL Bing francese storico deve raggiungere l’articolo canonico 2026.',
    ));
  }
  if (loopWorkflow.includes('token="${GITHUB_PAT:-$GH_TOKEN}"')
    || !loopWorkflow.includes('token="${GITHUB_PAT:-}"')) {
    findings.push(sourceFinding(
      'owner-token-required',
      '.github/workflows/bing-seo-loop.yml',
      'La PR automatica H1 deve fallire senza GITHUB_PAT e non usare GITHUB_TOKEN come fallback.',
    ));
  }
  if (!loopWorkflow.includes("INPUT_SUBMIT: ${{ github.event_name == 'schedule' && 'true' || inputs.submit_indexnow }}")) {
    findings.push(sourceFinding(
      'indexnow-dispatch-input',
      '.github/workflows/bing-seo-loop.yml',
      'Il dispatch manuale deve conservare false per submit_indexnow; true è il default solo dello schedule.',
    ));
  }

  for (const relativePath of [
    'scripts/submit-indexnow.js',
    'scripts/submit-indexnow-batch.mjs',
    '.github/workflows/submit-indexnow-batch.yml',
  ]) {
    const content = read(relativePath);
    if (/SubmitUrlbatch/i.test(content)) {
      findings.push(sourceFinding(
        'legacy-bing-url-api',
        relativePath,
        'Il loop non deve chiamare l’endpoint Bing SOAP/POX SubmitUrlbatch.',
      ));
    }
  }

  const remediation = read('scripts/submit-indexnow-remediation.mjs');
  if (!remediation.includes('BING_INDEXNOW_REMEDIATION_URLS')
    || !remediation.includes('submitIndexNowUrlsStreaming')) {
    findings.push(sourceFinding(
      'indexnow-remediation-source',
      'scripts/submit-indexnow-remediation.mjs',
      'La remediation deve usare la policy dei sei URL e il submitter streaming.',
    ));
  }

  const batchWorkflow = read('.github/workflows/submit-indexnow-batch.yml');
  if (/^\s{2}schedule:/m.test(batchWorkflow)) {
    findings.push(sourceFinding(
      'indexnow-weekly-batch',
      '.github/workflows/submit-indexnow-batch.yml',
      'Il full-sitemap batch deve restare solo manuale; la cadenza settimanale è stata rimossa.',
    ));
  }
  if (new Set(BING_TITLE_AUDIT_URLS).size !== BING_TITLE_AUDIT_URLS.length) {
    findings.push(sourceFinding(
      'policy-duplicate-url',
      'scripts/seo/bing-seo-policy.mjs',
      'Gli URL di audit devono essere univoci.',
    ));
  }

  return { ok: findings.length === 0, findings };
}

export function applyStaticFixes({ repoRoot = REPO_ROOT } = {}) {
  const relativePath = 'index.html';
  const absolutePath = resolve(repoRoot, relativePath);
  const source = readFileSync(absolutePath, 'utf8');
  const replacement = '<h1 id="homepage-static-h1">Frontaliere Ticino 2026 — Calcolatore Stipendio Netto Svizzera-Italia</h1>';
  const next = source.replace(
    /<h1\b([^>]*)style="[^"]*(?:left\s*:\s*-9999|width\s*:\s*1px|height\s*:\s*1px)[^"]*"[^>]*>Frontaliere Ticino 2026 — Calcolatore Stipendio Netto Svizzera-Italia<\/h1>/i,
    replacement,
  );
  if (next !== source) writeFileSync(absolutePath, next);
  return { changed: next !== source, files: next === source ? [] : [relativePath] };
}

function parseArg(name, args) {
  const prefix = '--' + name + '=';
  const inline = args.find((arg) => arg.startsWith(prefix));
  if (inline) return inline.slice(prefix.length);
  const index = args.indexOf('--' + name);
  return index >= 0 ? args[index + 1] : '';
}

async function main() {
  const args = process.argv.slice(2);
  const reportPath = parseArg('report', args);
  const results = [];

  if (args.includes('--apply-fixes')) {
    results.push({ mode: 'apply-fixes', ...applyStaticFixes() });
    const sourceCheck = checkSource();
    results.push({ mode: 'check-source', ...sourceCheck });
    if (!sourceCheck.ok) process.exitCode = 1;
  }

  if (args.includes('--check-source') && !args.includes('--apply-fixes')) {
    const sourceCheck = checkSource();
    results.push({ mode: 'check-source', ...sourceCheck });
    if (!sourceCheck.ok) process.exitCode = 1;
  }

  if (args.includes('--audit-live')) {
    const live = await auditLive();
    results.push({ mode: 'audit-live', ...live });
    if (reportPath) {
      mkdirSync(dirname(resolve(reportPath)), { recursive: true });
      writeFileSync(resolve(reportPath), JSON.stringify(live, null, 2) + '\n');
    }
    if (live.findings.length > 0) process.exitCode = 1;
  }

  if (results.length === 0) {
    console.error('Uso: node scripts/seo/bing-seo-live-loop.mjs --check-source | --audit-live [--report file] | --apply-fixes');
    process.exitCode = 2;
  } else {
    console.log(JSON.stringify(results, null, 2));
  }
}

const invokedDirectly = process.argv[1]
  && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));
if (invokedDirectly) await main();
