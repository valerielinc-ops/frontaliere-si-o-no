#!/usr/bin/env node
/**
 * Employer slug coverage audit.
 *
 * Pulls the list of live weeklyEmployers pages, extracts their rendered
 * employer names + link hrefs, and cross-checks against the known
 * company-page slug registry. Flags cases where the canonical slug EXISTS
 * but the page is using a `?q=Name` fallback.
 *
 * Output: .orchestration/audit/employer-slug-coverage.json +
 *         .orchestration/audit/employer-slug-coverage.md
 */
import { writeFileSync, readFileSync, mkdirSync } from 'node:fs';

const BASE = 'https://frontaliereticino.ch';
const OUT_DIR = '.orchestration/audit';
mkdirSync(OUT_DIR, { recursive: true });

const REGISTRY_FILE = 'data/all-known-job-slugs.json';

// Cities featured on weekly-employers hub
const CITIES = ['ticino', 'lugano', 'mendrisio', 'bellinzona', 'chiasso', 'locarno', 'stabio'];

async function fetchText(url) {
  const res = await fetch(url, { redirect: 'follow' });
  return { status: res.status, text: await res.text() };
}

function loadRegistrySlugs() {
  const raw = JSON.parse(readFileSync(REGISTRY_FILE, 'utf8'));
  const all = Array.isArray(raw) ? raw : Object.keys(raw);
  const set = new Set();
  for (const k of all) {
    if (typeof k === 'string' && k.startsWith('azienda-')) set.add(k.slice('azienda-'.length));
  }
  return set;
}

async function loadLiveCompanySlugs() {
  // Source of truth: live sitemap-jobs.xml
  const res = await fetchText(`${BASE}/sitemap-jobs.xml`);
  if (res.status !== 200) throw new Error('sitemap-jobs.xml fetch failed');
  const matches = res.text.match(/\/cerca-lavoro-ticino\/azienda-[a-z0-9-]+\//g) || [];
  const set = new Set();
  for (const m of matches) {
    const slug = m.replace(/\/cerca-lavoro-ticino\/azienda-|\/$/g, '');
    set.add(slug);
  }
  return set;
}

function slugifyEmployer(name) {
  return name.toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

// Given a full employer name, try N variations in order.
// Returns list of {variant, slug} for each try.
function slugVariants(name) {
  const base = slugifyEmployer(name);
  const variants = [{ variant: 'full', slug: base }];

  // First word only (strip "Genossenschaft", "AG", "S.A.", "SA", "Sagl", etc.)
  const firstToken = name.split(/[\s\-]+/)[0];
  if (firstToken && firstToken !== name) {
    variants.push({ variant: 'first-word', slug: slugifyEmployer(firstToken) });
  }

  // Strip common Swiss corporate suffixes
  const stripped = name
    .replace(/\b(Genossenschaft|AG|SA|S\.A\.|Sagl|Sarl|GmbH|Holding|Gruppo|Group|International|Schweiz|Svizzera|Switzerland)\b/gi, '')
    .trim();
  if (stripped && stripped !== name) {
    variants.push({ variant: 'stripped-suffix', slug: slugifyEmployer(stripped) });
  }

  // Brand before parenthesis: "Acme Inc (subsidiary)"
  const beforeParen = name.split('(')[0].trim();
  if (beforeParen && beforeParen !== name) {
    variants.push({ variant: 'before-paren', slug: slugifyEmployer(beforeParen) });
  }

  // Dedupe
  const seen = new Set();
  return variants.filter(v => !seen.has(v.slug) && seen.add(v.slug));
}

async function run() {
  const registryFile = loadRegistrySlugs();
  const registry = await loadLiveCompanySlugs();
  console.log(`Registry (file): ${registryFile.size}  |  Live sitemap: ${registry.size}  — using LIVE as source of truth`);

  const findings = [];

  for (const city of CITIES) {
    const url = `${BASE}/aziende-che-assumono/${city}/settimana-corrente/`;
    const res = await fetchText(url);
    if (res.status !== 200) {
      console.log(`[${city}] SKIP: status ${res.status}`);
      continue;
    }

    // Extract top companies — match the rendered <a> pattern around employer names.
    // Pattern: the plugin emits either
    //   <a href="/cerca-lavoro-ticino/azienda-SLUG/" ...>...<b>NAME</b>... (canonical)
    // or:
    //   <a href="/cerca-lavoro-ticino/?q=NAME" ...>...NAME... (fallback)
    const linkPattern = /<a href="\/cerca-lavoro-ticino\/((?:azienda-[a-z0-9-]+)|(?:\?q=[^"]+))"[^>]*>[^<]*<div[^>]*>(?:\d+\.\s*)?([^<]+?)</g;
    // Simpler approach: extract each <li> block then look inside.
    const liPattern = /<li[^>]*>([\s\S]*?)<\/li>/g;
    const liBlocks = res.text.match(liPattern) || [];

    for (const li of liBlocks) {
      // Match the <a> and the visible name
      const am = li.match(/<a href="\/cerca-lavoro-ticino\/((?:azienda-[a-z0-9-]+\/)|(?:\?q=[^"]+))"[^>]*>/);
      if (!am) continue;
      const href = am[1];
      // Extract the visible name: look for <div style="font-weight:700;font-size:16px;..."
      const nameMatch = li.match(/<div style="font-weight:700;font-size:16px;color:var\(--color-heading\)">(?:\d+\.\s*)?([^<]+)</);
      if (!nameMatch) continue;
      const name = nameMatch[1].trim();

      const isFallback = href.startsWith('?q=');
      if (!isFallback) {
        // Already canonical, no problem
        continue;
      }

      // Check if ANY slug variant matches the registry
      const variants = slugVariants(name);
      const matched = variants.find(v => registry.has(v.slug));
      if (matched) {
        findings.push({
          city,
          employer: name,
          currentHref: `/cerca-lavoro-ticino/${href}`,
          canonicalAvailable: `/cerca-lavoro-ticino/azienda-${matched.slug}/`,
          matchedVia: matched.variant,
          severity: 'high',
        });
      }
    }

    console.log(`[${city}] scanned`);
  }

  // Dedupe by employer (same name may appear in multiple cities)
  const unique = {};
  for (const f of findings) {
    if (!unique[f.employer]) unique[f.employer] = f;
  }
  const uniqueList = Object.values(unique);

  writeFileSync(`${OUT_DIR}/employer-slug-coverage.json`, JSON.stringify({ findings, unique: uniqueList }, null, 2));

  const md = [];
  md.push(`# Employer slug coverage audit — ${new Date().toISOString()}\n`);
  md.push(`Registry size: **${registry.size}** azienda-* slugs`);
  md.push(`Total \`?q=\` fallbacks with canonical page available: **${uniqueList.length}** unique employers\n`);
  md.push('## Unique employers needing slug-matching upgrade\n');
  md.push('| Employer | Canonical available | Matched via | Cities affected |');
  md.push('|----------|---------------------|-------------|-----------------|');
  for (const f of uniqueList) {
    const cities = findings.filter(x => x.employer === f.employer).map(x => x.city).join(', ');
    md.push(`| ${f.employer} | ${f.canonicalAvailable} | ${f.matchedVia} | ${cities} |`);
  }
  writeFileSync(`${OUT_DIR}/employer-slug-coverage.md`, md.join('\n') + '\n');

  console.log(`\nDone. ${uniqueList.length} unique employers need fix.`);
}

run().catch(e => { console.error(e); process.exit(1); });
