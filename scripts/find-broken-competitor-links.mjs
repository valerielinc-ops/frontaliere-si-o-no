#!/usr/bin/env node
/**
 * Sprint 5.6 — Broken-link scout for the link-building pipeline.
 *
 * Reads a hardcoded list of competitor / citation pages that are known to
 * link to third-party resources about frontalieri, fiscal frontiera, LAMal
 * premiums, border wait and cross-border jobs. For each page it:
 *
 *   1. Fetches the HTML (HTTP GET, text only, fails-soft on timeout)
 *   2. Extracts every outbound <a href="..."> link that is:
 *       - external (different origin from the source page)
 *       - http(s) (skips mailto:/tel:/anchors)
 *   3. Runs a HEAD (then GET fallback) against each outbound link with a
 *      short timeout to detect 4xx/5xx responses.
 *   4. For each dead link, picks a suggested replacement from our site
 *      using a keyword-matching heuristic against the anchor text.
 *
 * Output: data/seo/broken-competitor-links.json — a machine-readable list
 * of triples { sourcePage, deadUrl, anchor, suggestedReplacement } that
 * the outreach pipeline (manual today, potentially automated later) uses
 * to craft "hey, your link X is broken, we have Y" pitches.
 *
 * Usage:
 *   node scripts/find-broken-competitor-links.mjs
 *   node scripts/find-broken-competitor-links.mjs --limit 20 --verbose
 *
 * Design notes:
 *   - Pure Node built-ins (fetch) — no new dependencies.
 *   - Idempotent: re-running simply overwrites the JSON output.
 *   - Polite: uses a realistic User-Agent, 1 concurrent HEAD per origin,
 *     and a 2 s inter-request delay. Honours robots.txt is OUT OF SCOPE
 *     for this scout — the operator must still review each entry before
 *     pitching, and pitching itself is a human task.
 */

import { writeFileSync, mkdirSync, existsSync } from 'node:fs';
import path from 'node:path';

// ── Config ────────────────────────────────────────────────────────

const OUT_DIR = path.resolve('data/seo');
const OUT_FILE = path.join(OUT_DIR, 'broken-competitor-links.json');

const DEFAULT_UA =
  'Mozilla/5.0 (compatible; FrontaliereTicinoLinkScout/1.0; +https://frontaliereticino.ch)';
const FETCH_TIMEOUT_MS = 10_000;
const MAX_OUTBOUND_PER_PAGE = 200;

/**
 * Seed list of competitor / citation pages. Draws from the Sprint 5 plan's
 * Tier-A outreach targets and common editorial frontaliere hubs. Add more
 * as outreach discovers new resource pages.
 */
const COMPETITOR_PAGES = [
  'https://www.ocst.ch/',
  'https://www.sit-syndicat.ch/',
  'https://www.beecare.ch/',
  'https://www.laregione.ch/cantone/ticino',
  'https://www.cdt.ch/',
  'https://www.tio.ch/ticino',
  'https://www.rsi.ch/info',
  'https://www.varesenews.it/',
  'https://www.laprovinciadicomo.it/',
  'https://www.ilgiorno.it/como',
  'https://it.wikipedia.org/wiki/Lavoratore_frontaliero',
  'https://de.wikipedia.org/wiki/Grenzg%C3%A4nger',
  'https://www.agenziaentrate.gov.it/portale/web/guest/schede/agevolazioni/frontalieri-agevolazioni',
];

/**
 * Keyword → replacement rules. When a broken anchor text contains any of the
 * keywords, we suggest the corresponding URL from our own site as a swap.
 * Ordering matters — earlier rules win ties. Keep rules short and specific.
 */
const REPLACEMENT_RULES = [
  { keywords: ['stipendio', 'salari', 'salary', 'lohn'], url: 'https://frontaliereticino.ch/report/frontalieri-2026/' },
  { keywords: ['cambio', 'chf', 'eur', 'exchange'], url: 'https://frontaliereticino.ch/comparatori/cambio-valuta/' },
  { keywords: ['lamal', 'premi', 'assicurazione', 'malattia', 'krankenversicherung'], url: 'https://frontaliereticino.ch/lamal-premi-frontalieri/' },
  { keywords: ['carburante', 'benzina', 'fuel', 'diesel'], url: 'https://frontaliereticino.ch/comparatori/prezzi-carburanti/' },
  { keywords: ['coda', 'dogana', 'wait', 'border', 'valico', 'grenze'], url: 'https://frontaliereticino.ch/dogana-tempi-attesa/' },
  { keywords: ['nuova legge', '2026', 'accordo', 'steuerabkommen'], url: 'https://frontaliereticino.ch/guida/frontalieri-nuova-legge-2026/' },
  { keywords: ['lavoro', 'offerte', 'jobs', 'annunci'], url: 'https://frontaliereticino.ch/cerca-lavoro-ticino/' },
];

// ── Helpers ───────────────────────────────────────────────────────

/** Parse CLI args into a flat { flag: value | true } object. */
function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) continue;
    const key = a.slice(2);
    const next = argv[i + 1];
    if (!next || next.startsWith('--')) {
      out[key] = true;
    } else {
      out[key] = next;
      i++;
    }
  }
  return out;
}

async function fetchWithTimeout(url, opts = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      ...opts,
      signal: controller.signal,
      redirect: 'follow',
      headers: { 'user-agent': DEFAULT_UA, ...(opts.headers ?? {}) },
    });
    return res;
  } finally {
    clearTimeout(timer);
  }
}

/** Extract outbound http(s) <a href="..."> links + anchor text from HTML. */
function extractOutbound(html, sourceUrl) {
  const out = [];
  const sourceOrigin = new URL(sourceUrl).origin;
  const regex = /<a\b[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
  let match;
  while ((match = regex.exec(html)) !== null) {
    const raw = match[1].trim();
    if (!raw || !/^https?:/i.test(raw)) continue;
    try {
      const u = new URL(raw);
      if (u.origin === sourceOrigin) continue;
      const anchor = match[2].replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim().slice(0, 160);
      out.push({ href: u.toString(), anchor });
      if (out.length >= MAX_OUTBOUND_PER_PAGE) break;
    } catch {
      // malformed href — skip
    }
  }
  // Deduplicate by href; keep first anchor text seen.
  const seen = new Map();
  for (const entry of out) if (!seen.has(entry.href)) seen.set(entry.href, entry);
  return [...seen.values()];
}

/** HEAD then GET fallback — return { ok, status } or { ok:false, error } on throw. */
async function checkUrl(url) {
  try {
    const head = await fetchWithTimeout(url, { method: 'HEAD' });
    if (head.status >= 200 && head.status < 400) return { ok: true, status: head.status };
    if (head.status === 405 || head.status === 403) {
      // Some servers disallow HEAD — re-check with GET.
      const get = await fetchWithTimeout(url, { method: 'GET' });
      return { ok: get.status >= 200 && get.status < 400, status: get.status };
    }
    return { ok: false, status: head.status };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/** Pick a replacement URL based on anchor-text keyword match; default to our home. */
function pickReplacement(anchor) {
  const lower = anchor.toLowerCase();
  for (const rule of REPLACEMENT_RULES) {
    if (rule.keywords.some((k) => lower.includes(k))) return rule.url;
  }
  return 'https://frontaliereticino.ch/';
}

// ── Main ──────────────────────────────────────────────────────────

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const verbose = Boolean(args.verbose);
  const limit = args.limit ? Number(args.limit) : Infinity;

  if (!existsSync(OUT_DIR)) mkdirSync(OUT_DIR, { recursive: true });

  const findings = [];
  const pages = COMPETITOR_PAGES.slice(0, limit);

  for (const page of pages) {
    if (verbose) console.log(`\n[scout] fetching ${page}`);
    let html = '';
    try {
      const res = await fetchWithTimeout(page);
      if (!res.ok) {
        console.warn(`[scout] ${page} → ${res.status} (source unavailable, skipping)`);
        continue;
      }
      html = await res.text();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`[scout] ${page} unreachable: ${msg}`);
      continue;
    }

    const outbound = extractOutbound(html, page);
    if (verbose) console.log(`[scout] ${page} → ${outbound.length} outbound links to probe`);

    for (const { href, anchor } of outbound) {
      const check = await checkUrl(href);
      if (check.ok) continue;

      const replacement = pickReplacement(anchor);
      findings.push({
        sourcePage: page,
        deadUrl: href,
        anchor,
        httpStatus: check.status ?? null,
        error: check.error ?? null,
        suggestedReplacement: replacement,
      });

      if (verbose) {
        console.log(
          `  DEAD ${check.status ?? 'ERR'} · ${href} · anchor="${anchor}" → suggest ${replacement}`,
        );
      }

      // Politeness: space out the probes.
      await new Promise((r) => setTimeout(r, 200));
    }

    // Politeness: wait between source pages.
    await new Promise((r) => setTimeout(r, 2000));
  }

  const output = {
    generatedAt: new Date().toISOString(),
    sourcesScanned: pages,
    totalFindings: findings.length,
    findings,
  };
  writeFileSync(OUT_FILE, JSON.stringify(output, null, 2) + '\n', 'utf-8');
  console.log(`[scout] wrote ${findings.length} finding(s) to ${OUT_FILE}`);
}

main().catch((err) => {
  console.error('[scout] fatal:', err);
  process.exit(1);
});
