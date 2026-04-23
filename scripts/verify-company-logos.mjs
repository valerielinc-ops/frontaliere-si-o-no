#!/usr/bin/env node
/**
 * verify-company-logos.mjs
 *
 * Purpose:
 *   Semrush audit reports ~1172 broken external images. Nearly all of them are
 *   company-logo URLs resolved through CRAWLED_COMPANY_LOGOS / Clearbit / Google
 *   favicon API. This script probes every unique `companyLogo` URL we reference
 *   in our job data and writes the broken ones to `data/company-logos-broken.json`
 *   so downstream cleanup can replace them with the local placeholder SVG.
 *
 *   The script never mutates `data/jobs.json` — it only produces a read-only
 *   diagnostic file. A weekly cron workflow keeps it fresh.
 *
 * Inputs:
 *   - data/jobs.json                (aggregated, gitignored at repo root)
 *   - data/jobs/by-crawler/*.json   (per-crawler snapshots, committed)
 *
 * Output:
 *   - data/company-logos-broken.json   { generatedAt, checked, ok, broken, urls: [{ url, status, error }] }
 */
import { readFile, writeFile, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(process.cwd());
const JOBS_JSON = path.join(ROOT, 'data', 'jobs.json');
const CRAWLERS_DIR = path.join(ROOT, 'data', 'jobs', 'by-crawler');
const OUTPUT = path.join(ROOT, 'data', 'company-logos-broken.json');

const FETCH_TIMEOUT_MS = 8000;
const CONCURRENCY = 20;

/** Read a JSON file safely; return [] on missing. */
async function readJsonSafe(file) {
  try {
    if (!existsSync(file)) return null;
    const raw = await readFile(file, 'utf8');
    return JSON.parse(raw);
  } catch (err) {
    console.warn(`[verify-company-logos] Could not read ${file}: ${err.message}`);
    return null;
  }
}

/** Extract companyLogo (and any logo fields) from an arbitrary job-like record. */
function extractLogoUrls(job) {
  const urls = [];
  if (job?.companyLogo && typeof job.companyLogo === 'string') urls.push(job.companyLogo);
  if (job?.logoUrl && typeof job.logoUrl === 'string') urls.push(job.logoUrl);
  if (job?.logo && typeof job.logo === 'string') urls.push(job.logo);
  return urls.filter((u) => /^https?:\/\//.test(u));
}

async function collectUrls() {
  const set = new Set();

  const jobsMain = await readJsonSafe(JOBS_JSON);
  if (Array.isArray(jobsMain)) {
    for (const j of jobsMain) extractLogoUrls(j).forEach((u) => set.add(u));
  }

  if (existsSync(CRAWLERS_DIR)) {
    const files = (await readdir(CRAWLERS_DIR)).filter((f) => f.endsWith('.json'));
    for (const f of files) {
      const data = await readJsonSafe(path.join(CRAWLERS_DIR, f));
      if (Array.isArray(data)) {
        for (const j of data) extractLogoUrls(j).forEach((u) => set.add(u));
      } else if (data && Array.isArray(data.jobs)) {
        for (const j of data.jobs) extractLogoUrls(j).forEach((u) => set.add(u));
      }
    }
  }

  return Array.from(set);
}

async function headCheck(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      method: 'HEAD',
      signal: controller.signal,
      redirect: 'follow',
    });
    return { url, ok: res.status === 200, status: res.status };
  } catch (err) {
    return { url, ok: false, status: 0, error: err?.name === 'AbortError' ? 'timeout' : String(err?.message || err) };
  } finally {
    clearTimeout(timer);
  }
}

async function runConcurrent(urls, worker, concurrency) {
  const results = [];
  let cursor = 0;
  const workers = Array.from({ length: concurrency }, async () => {
    while (cursor < urls.length) {
      const i = cursor++;
      results[i] = await worker(urls[i]);
    }
  });
  await Promise.all(workers);
  return results;
}

async function main() {
  const urls = await collectUrls();
  console.log(`[verify-company-logos] Collected ${urls.length} unique logo URLs.`);
  if (urls.length === 0) {
    const payload = { generatedAt: new Date().toISOString(), checked: 0, ok: 0, broken: 0, urls: [] };
    await writeFile(OUTPUT, JSON.stringify(payload, null, 2));
    return;
  }

  const results = await runConcurrent(urls, headCheck, CONCURRENCY);
  const broken = results.filter((r) => !r.ok);
  const okCount = results.length - broken.length;

  const payload = {
    generatedAt: new Date().toISOString(),
    checked: results.length,
    ok: okCount,
    broken: broken.length,
    urls: broken
      .map(({ url, status, error }) => ({ url, status, error }))
      .sort((a, b) => a.url.localeCompare(b.url)),
  };

  await writeFile(OUTPUT, JSON.stringify(payload, null, 2));
  console.log(
    `[verify-company-logos] Checked ${results.length} — ok: ${okCount}, broken: ${broken.length}. Wrote ${OUTPUT}`,
  );
}

main().catch((err) => {
  console.error('[verify-company-logos] Fatal:', err);
  process.exit(1);
});
