#!/usr/bin/env node
/**
 * Download logos for all LAMal health insurers.
 * Priority: SVG favicon → apple-touch-icon PNG → Google favicon (sz=256)
 * Output:   public/images/insurers/{slug}.svg  or  {slug}.png
 * Usage:    node scripts/crawl-insurer-logos.mjs [--force] [--dry-run]
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const OUT_DIR = join(ROOT, 'public/images/insurers');
const HEALTH_DATA = join(ROOT, 'data/health-premiums.json');

const FORCE = process.argv.includes('--force');
const DRY = process.argv.includes('--dry-run');
const CONCURRENCY = 3;
const TIMEOUT_MS = 12000;

function slugify(name) {
  return name
    .toLowerCase()
    .replace(/[àáâãäå]/g, 'a').replace(/[èéêë]/g, 'e')
    .replace(/[ìíîï]/g, 'i').replace(/[òóôõö]/g, 'o')
    .replace(/[ùúûü]/g, 'u').replace(/[ñ]/g, 'n')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}

function domainFromUrl(url) {
  try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return null; }
}

async function fetchBuf(url, maxBytes = 2_000_000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, { signal: ctrl.signal, headers: { 'User-Agent': 'Mozilla/5.0 (compatible; FrontaliereTicino/1.0)' } });
    if (!res.ok) return null;
    const buf = Buffer.from(await res.arrayBuffer());
    return buf.length > 0 && buf.length < maxBytes ? buf : null;
  } catch { return null; } finally { clearTimeout(timer); }
}

async function fetchText(url) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, { signal: ctrl.signal, headers: { 'User-Agent': 'Mozilla/5.0 (compatible; FrontaliereTicino/1.0)' } });
    if (!res.ok) return null;
    return await res.text();
  } catch { return null; } finally { clearTimeout(timer); }
}

function extractIconUrls(html, baseUrl) {
  const results = { svg: [], apple: [], png: [] };
  const base = new URL(baseUrl);

  const resolve = (href) => {
    try {
      return new URL(href, base).href;
    } catch { return null; }
  };

  // Match all <link> tags with icon-related rels
  const linkRe = /<link[^>]+>/gi;
  let m;
  while ((m = linkRe.exec(html)) !== null) {
    const tag = m[0];
    const relM = /rel=["']([^"']+)["']/i.exec(tag);
    const hrefM = /href=["']([^"']+)["']/i.exec(tag);
    if (!relM || !hrefM) continue;

    const rel = relM[1].toLowerCase();
    const href = hrefM[1];
    const url = resolve(href);
    if (!url) continue;

    if (href.endsWith('.svg') || href.includes('.svg?')) {
      results.svg.push(url);
    } else if (rel.includes('apple-touch')) {
      results.apple.push(url);
    } else if (href.match(/\.(png|webp)/) && rel.includes('icon')) {
      results.png.push(url);
    }
  }
  return results;
}

async function downloadOne({ name, website, slug }) {
  const domain = domainFromUrl(website);
  if (!domain) return { slug, status: 'skip', reason: 'no domain' };

  const svgPath = join(OUT_DIR, `${slug}.svg`);
  const pngPath = join(OUT_DIR, `${slug}.png`);

  if (!FORCE && (existsSync(svgPath) || existsSync(pngPath))) {
    const ext = existsSync(svgPath) ? 'svg' : 'png';
    console.log(`  EXISTS  ${name} → ${slug}.${ext}`);
    return { slug, domain, status: 'exists', ext };
  }

  // Step 1: fetch homepage and parse icon links
  const siteUrl = `https://www.${domain}`;
  console.log(`  SCAN    ${name} (${domain}) …`);
  const html = DRY ? null : await fetchText(siteUrl);

  if (html) {
    const icons = extractIconUrls(html, siteUrl);

    // Try SVG first (highest quality)
    for (const url of icons.svg) {
      const buf = await fetchBuf(url);
      if (buf && (buf.toString('utf8', 0, 100).includes('<svg') || buf.toString('utf8', 0, 10).includes('<?xml'))) {
        writeFileSync(svgPath, buf);
        console.log(`  SVG     ${name} → ${slug}.svg (${buf.length} bytes)`);
        return { slug, domain, status: 'ok', ext: 'svg', localPath: `/images/insurers/${slug}.svg` };
      }
    }

    // Try apple-touch-icon (180x180 PNG)
    for (const url of icons.apple) {
      const buf = await fetchBuf(url);
      if (buf && buf.length > 500) {
        writeFileSync(pngPath, buf);
        console.log(`  APPLE   ${name} → ${slug}.png (${buf.length} bytes)`);
        return { slug, domain, status: 'ok', ext: 'png', localPath: `/images/insurers/${slug}.png` };
      }
    }

    // Try large PNG icon
    for (const url of icons.png) {
      const buf = await fetchBuf(url);
      if (buf && buf.length > 500) {
        writeFileSync(pngPath, buf);
        console.log(`  PNG     ${name} → ${slug}.png (${buf.length} bytes)`);
        return { slug, domain, status: 'ok', ext: 'png', localPath: `/images/insurers/${slug}.png` };
      }
    }
  }

  // Step 2: Google favicon API at max size
  const googleUrl = `https://www.google.com/s2/favicons?domain=${domain}&sz=256`;
  const gBuf = DRY ? null : await fetchBuf(googleUrl);
  if (gBuf && gBuf.length > 500) {
    writeFileSync(pngPath, gBuf);
    console.log(`  GOOGLE  ${name} → ${slug}.png (${gBuf.length} bytes)`);
    return { slug, domain, status: 'ok', ext: 'png', localPath: `/images/insurers/${slug}.png` };
  }

  console.log(`  FAIL    ${name} — no logo found`);
  return { slug, domain, status: 'fail' };
}

async function main() {
  const raw = JSON.parse(readFileSync(HEALTH_DATA, 'utf8'));
  const insurers = Object.values(raw.insurers || raw).filter(i => i.website);

  console.log(`Found ${insurers.length} insurers with websites`);
  if (!DRY) mkdirSync(OUT_DIR, { recursive: true });

  const list = insurers.map(i => ({ name: i.name, website: i.website, slug: slugify(i.name) }));
  const results = [];

  for (let i = 0; i < list.length; i += CONCURRENCY) {
    const batch = list.slice(i, i + CONCURRENCY);
    const r = await Promise.all(batch.map(downloadOne));
    results.push(...r);
  }

  const ok = results.filter(r => r.status === 'ok');
  const fail = results.filter(r => r.status === 'fail');
  const exists = results.filter(r => r.status === 'exists');

  console.log(`\nDone: ${ok.length} downloaded, ${exists.length} already existed, ${fail.length} failed`);

  if (ok.length > 0) {
    console.log('\nSuccessful downloads:');
    ok.forEach(r => console.log(`  ${r.slug}.${r.ext} (${r.domain})`));
  }
  if (fail.length > 0) {
    console.log('\nFailed (will show Clearbit/placeholder at runtime):');
    fail.forEach(r => console.log(`  ${r.slug} (${r.domain})`));
  }
}

main().catch(err => { console.error(err); process.exit(1); });
