#!/usr/bin/env node
/**
 * Nightly webcam URL health check.
 *
 * Walks every `webcams` entry in data/borderCrossings.ts and issues a HEAD
 * request (falls back to GET if HEAD is not supported). Reports URLs that
 * don't respond with HTTP 2xx + image/* content-type.
 *
 * Wired to `.github/workflows/validate-webcams-nightly.yml`; when any URL
 * fails, the workflow opens a maintenance issue so the registry can be
 * trimmed before the next deploy.
 *
 * Usage:
 *   node scripts/validate-webcam-urls.mjs
 *
 * Exit code: 0 if all active webcams respond OK, 1 if any URL is down.
 */

import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '..');

const UA = 'FrontaliereTicino-WebcamCheck/1.0';

async function probe(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8000);
  try {
    let res = await fetch(url, {
      method: 'HEAD',
      headers: { 'User-Agent': UA },
      signal: controller.signal,
      redirect: 'follow',
    });
    if (!res.ok || !(res.headers.get('content-type') || '').startsWith('image/')) {
      // HEAD not universally supported; retry with GET
      res = await fetch(url, {
        method: 'GET',
        headers: { 'User-Agent': UA },
        signal: controller.signal,
        redirect: 'follow',
      });
    }
    const ct = res.headers.get('content-type') || '';
    return {
      url,
      status: res.status,
      contentType: ct,
      ok: res.ok && ct.startsWith('image/'),
    };
  } catch (err) {
    return { url, status: null, contentType: null, ok: false, error: err.message };
  } finally {
    clearTimeout(timer);
  }
}

async function main() {
  // Dynamic import so the TS type stripping stays local to the registry.
  // The file exports a plain `borderCrossings` array.
  const registryPath = path.join(REPO_ROOT, 'data', 'borderCrossings.ts');
  // Use tsx-friendly dynamic import via node --import tsx or ts-node; fall
  // back to reading the file manually so the script still works from plain
  // Node (scans for imageUrl with a regex).
  let urls;
  try {
    const mod = await import(path.join(REPO_ROOT, 'data', 'borderCrossings.ts'));
    const crossings = mod.borderCrossings ?? [];
    urls = [];
    for (const c of crossings) {
      for (const w of c.webcams ?? []) {
        urls.push({ imageUrl: w.imageUrl, label: `${c.name} — ${w.label}` });
      }
    }
  } catch {
    const fs = await import('node:fs');
    const raw = fs.readFileSync(registryPath, 'utf-8');
    const matches = Array.from(raw.matchAll(/imageUrl:\s*'([^']+)'/g)).map((m) => m[1]);
    urls = Array.from(new Set(matches)).map((u) => ({ imageUrl: u, label: 'unknown' }));
  }

  if (urls.length === 0) {
    console.log('No webcam URLs to check.');
    process.exit(0);
  }

  console.log(`Checking ${urls.length} webcam URLs…\n`);
  const results = [];
  for (const { imageUrl, label } of urls) {
    const r = await probe(imageUrl);
    results.push({ ...r, label });
    const symbol = r.ok ? '✅' : '❌';
    const meta = r.error ? r.error : `${r.status} ${r.contentType || '(no content-type)'}`;
    console.log(`${symbol} ${imageUrl}  ${meta}`);
  }

  const failed = results.filter((r) => !r.ok);
  console.log(`\nSummary: ${results.length - failed.length}/${results.length} OK, ${failed.length} down.`);
  if (failed.length > 0) {
    console.log('\nDown webcams:');
    for (const f of failed) console.log(`  - ${f.label}: ${f.url} → ${f.error || f.status}`);
    process.exit(1);
  }
  process.exit(0);
}

main().catch((err) => {
  console.error('❌ validate-webcam-urls failed:', err);
  process.exit(1);
});
