#!/usr/bin/env node
/**
 * detect-ats.mjs
 *
 * Detect the Applicant Tracking System (ATS) used by a company's career site.
 *
 * Public API (library):
 *   detectAtsForUrl(careerSiteUrl, options) -> Promise<{
 *     ats: 'workday' | 'greenhouse' | 'lever' | 'successfactors' |
 *          'smartrecruiters' | 'custom' | 'unknown',
 *     confidence: number,    // 0-1
 *     evidence: string[]     // signals that matched
 *   }>
 *
 * CLI:
 *   node scripts/detect-ats.mjs --url=https://career.example.com
 *   node scripts/detect-ats.mjs --marquee   # batch top-17 marquee companies
 *
 * Conventions: ESM, native fetch, polite UA, 5s timeout, 1 retry.
 *
 * NB: Idempotent against data/marquee-companies-list.json — does not overwrite
 * an `ats_hint` already populated when detection fails.
 */

import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const USER_AGENT = 'FrontaliereTicino-Bot/1.0';
const DEFAULT_TIMEOUT_MS = 5000;
const DEFAULT_RETRIES = 1;
const POLITE_DELAY_MS = 4000; // 4s between requests in batch mode

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '..');
const MARQUEE_PATH = path.join(REPO_ROOT, 'data', 'marquee-companies-list.json');

// -----------------------------------------------------------------------------
// HTTP fetch with timeout + retry
// -----------------------------------------------------------------------------

async function fetchWithTimeout(url, { timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method: 'GET',
      redirect: 'follow',
      signal: controller.signal,
      headers: {
        'User-Agent': USER_AGENT,
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en;q=0.8,it;q=0.7,de;q=0.6',
      },
    });
    return res;
  } finally {
    clearTimeout(timer);
  }
}

async function fetchHtml(url, { timeoutMs = DEFAULT_TIMEOUT_MS, retries = DEFAULT_RETRIES } = {}) {
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      const res = await fetchWithTimeout(url, { timeoutMs });
      const finalUrl = res.url || url;
      const status = res.status;
      const html = await res.text();
      return { html, finalUrl, status };
    } catch (err) {
      lastErr = err;
    }
  }
  throw lastErr;
}

// -----------------------------------------------------------------------------
// Detection rules (signal -> ats + evidence)
// -----------------------------------------------------------------------------

function detectFromSignals({ html, finalUrl, requestedUrl }) {
  const evidence = [];
  let ats = 'unknown';
  let confidence = 0;

  let hostname = '';
  try {
    hostname = new URL(finalUrl || requestedUrl).hostname.toLowerCase();
  } catch {
    hostname = '';
  }

  const lowerHtml = (html || '').toLowerCase();

  // --- Workday -----------------------------------------------------------
  const wdHostMatch = /(^|\.)myworkdayjobs\.com$/.test(hostname) ||
                      /(^|\.)wd\d*\.myworkdayjobs\.com$/.test(hostname);
  const wdHtmlMatch = lowerHtml.includes('wday/cxs') ||
                      lowerHtml.includes('myworkdayjobs.com') ||
                      lowerHtml.includes('workday.com');
  if (wdHostMatch) {
    evidence.push('hostname matches *.myworkdayjobs.com');
    ats = 'workday';
    confidence = 1.0;
  } else if (wdHtmlMatch) {
    evidence.push('html contains workday/wday-cxs/myworkdayjobs reference');
    if (ats === 'unknown') {
      ats = 'workday';
      confidence = 0.85;
    }
  }

  // --- Greenhouse --------------------------------------------------------
  const ghMatch = lowerHtml.includes('boards.greenhouse.io') ||
                  lowerHtml.includes('boards-api.greenhouse.io');
  if (ghMatch) {
    evidence.push('html contains boards.greenhouse.io');
    if (ats === 'unknown') {
      ats = 'greenhouse';
      confidence = 0.95;
    }
  }

  // --- Lever -------------------------------------------------------------
  const leverHostMatch = /(^|\.)jobs\.lever\.co$/.test(hostname);
  const leverHtmlMatch = lowerHtml.includes('jobs.lever.co/') ||
                         lowerHtml.includes('lever.co/jobs/');
  if (leverHostMatch) {
    evidence.push('hostname matches jobs.lever.co');
    ats = 'lever';
    confidence = 1.0;
  } else if (leverHtmlMatch && ats === 'unknown') {
    evidence.push('html contains lever.co reference');
    ats = 'lever';
    confidence = 0.85;
  }

  // --- SAP SuccessFactors ------------------------------------------------
  const sfHostMatch = /(^|\.)successfactors\.eu$/.test(hostname) ||
                      /(^|\.)successfactors\.com$/.test(hostname) ||
                      /^career\d*\.successfactors\.eu$/.test(hostname);
  const sfHtmlMatch = lowerHtml.includes('/career?company=') ||
                      lowerHtml.includes('successfactors.eu') ||
                      lowerHtml.includes('successfactors.com');
  if (sfHostMatch) {
    evidence.push('hostname matches *.successfactors.{eu,com}');
    if (ats === 'unknown') {
      ats = 'successfactors';
      confidence = 1.0;
    }
  } else if (sfHtmlMatch && ats === 'unknown') {
    evidence.push('html contains successfactors / /career?company= reference');
    ats = 'successfactors';
    confidence = 0.85;
  }

  // --- SmartRecruiters ---------------------------------------------------
  const srHtmlMatch = lowerHtml.includes('smartrecruiters.com') ||
                      lowerHtml.includes('careers.smartrecruiters.com');
  if (srHtmlMatch && ats === 'unknown') {
    evidence.push('html contains smartrecruiters.com');
    ats = 'smartrecruiters';
    confidence = 0.9;
  }

  // --- Custom (fallback when nothing matched but page has job structure) -
  if (ats === 'unknown') {
    const looksLikeJobBoard =
      lowerHtml.includes('job-listing') ||
      lowerHtml.includes('career-listing') ||
      lowerHtml.includes('vacancies') ||
      lowerHtml.includes('open positions') ||
      lowerHtml.includes('current openings') ||
      lowerHtml.includes('offerte di lavoro') ||
      lowerHtml.includes('stellenangebote') ||
      lowerHtml.includes('postes ouverts') ||
      /<a[^>]+href=[^>]+\/jobs?\//i.test(html || '') ||
      /<a[^>]+href=[^>]+\/careers?\//i.test(html || '');
    if (looksLikeJobBoard) {
      evidence.push('page has detectable job-listing structure (custom ATS)');
      ats = 'custom';
      confidence = 0.5;
    }
  }

  return { ats, confidence, evidence };
}

// -----------------------------------------------------------------------------
// Public API
// -----------------------------------------------------------------------------

export async function detectAtsForUrl(careerSiteUrl, options = {}) {
  if (!careerSiteUrl || typeof careerSiteUrl !== 'string') {
    return { ats: 'unknown', confidence: 0, evidence: ['invalid url'] };
  }
  try {
    const { html, finalUrl } = await fetchHtml(careerSiteUrl, options);
    const result = detectFromSignals({
      html,
      finalUrl,
      requestedUrl: careerSiteUrl,
    });
    return { ...result, finalUrl };
  } catch (err) {
    return {
      ats: 'unknown',
      confidence: 0,
      evidence: [`fetch failed: ${err && err.message ? err.message : String(err)}`],
    };
  }
}

// -----------------------------------------------------------------------------
// Marquee batch run — top-17 from the curated list
// -----------------------------------------------------------------------------

/**
 * Best-effort career-site URLs for the top-17 marquee companies.
 *
 * Sourced from public-knowledge career portals as of 2026-05-10. The script
 * follows redirects, so canonical homepage variations resolve cleanly.
 *
 * Two of the originally-listed targets (Swisscom, Syngenta) are not present
 * in `data/marquee-companies-list.json` and are skipped per the curated set.
 */
const TOP_MARQUEE_TARGETS = [
  // Workday tenants — verified by hostname probe (return body served by Workday).
  { matchName: 'Roche',                        careerUrl: 'https://roche.wd3.myworkdayjobs.com/roche-ext' },
  { matchName: 'Novartis',                     careerUrl: 'https://novartis.wd3.myworkdayjobs.com/Novartis_Careers' },
  { matchName: 'Zurich Insurance',             careerUrl: 'https://zurich.wd3.myworkdayjobs.com/Zurich_Careers' },
  { matchName: 'Nestlé',                       careerUrl: 'https://nestle.wd3.myworkdayjobs.com/Nestle_External_Careers' },
  // SmartRecruiters tenants — verified 200.
  { matchName: 'Migros',                       careerUrl: 'https://jobs.smartrecruiters.com/Migros' },
  { matchName: 'Schindler',                    careerUrl: 'https://jobs.smartrecruiters.com/Schindler' },
  // SuccessFactors tenants — verified.
  { matchName: 'SBB CFF FFS',                  careerUrl: 'https://career5.successfactors.eu/career?company=sbbcffP' },
  { matchName: 'Swiss Re',                     careerUrl: 'https://careers.swissre.com' },
  // Custom / corporate landing pages — heuristic detection only.
  { matchName: 'ETH Zürich',                   careerUrl: 'https://jobs.ethz.ch/' },
  { matchName: 'EPFL',                         careerUrl: 'https://www.epfl.ch/campus/services/human-resources/jobs/' },
  { matchName: 'CHUV',                         careerUrl: 'https://www.chuv.ch/fr/chuv-home/le-chuv/emplois' },
  { matchName: 'Inselspital Bern',             careerUrl: 'https://jobs.insel.ch' },
  { matchName: 'Pictet Group',                 careerUrl: 'https://www.group.pictet/careers' },
  { matchName: 'Credit Suisse (UBS Group AG)', careerUrl: 'https://www.ubs.com/global/en/careers.html' },
  // Targets requested but not in marquee list (skipped):
  //   - UBS Switzerland         → already crawled (alreadyCrawled: true)
  //   - Migros HQ Zürich        → mapped to "Migros" entry above
  //   - Swisscom (BE)           → not in marquee list
  //   - Mobiliar HQ Bern        → already crawled (alreadyCrawled: true)
  //   - HUG                     → already crawled (alreadyCrawled: true)
  //   - Syngenta                → not in marquee list
];

async function runMarqueeBatch() {
  const raw = await readFile(MARQUEE_PATH, 'utf8');
  const data = JSON.parse(raw);

  const results = [];

  for (let i = 0; i < TOP_MARQUEE_TARGETS.length; i += 1) {
    const target = TOP_MARQUEE_TARGETS[i];
    const company = data.companies.find((c) =>
      c.name.toLowerCase().includes(target.matchName.toLowerCase()) ||
      target.matchName.toLowerCase().includes(c.name.toLowerCase())
    );
    if (!company) {
      console.error(`[skip] ${target.matchName}: not in marquee list`);
      results.push({ name: target.matchName, status: 'not-in-list' });
      continue;
    }
    if (company.alreadyCrawled) {
      console.error(`[skip] ${company.name}: already crawled`);
      results.push({ name: company.name, status: 'already-crawled' });
      continue;
    }

    console.error(`[fetch] ${company.name} -> ${target.careerUrl}`);
    let detection;
    try {
      detection = await detectAtsForUrl(target.careerUrl);
    } catch (err) {
      console.error(`[error] ${company.name}: ${err.message}`);
      detection = { ats: 'unknown', confidence: 0, evidence: [String(err.message || err)] };
    }

    console.error(`        -> ats=${detection.ats} conf=${detection.confidence.toFixed(2)} ev=${JSON.stringify(detection.evidence)}`);

    // Idempotent policy:
    //   - placeholder ("?" / "" / "unknown") → always update
    //   - curated value present + detection is HIGH-confidence (>=0.8) and not
    //     the generic "custom" bucket → overwrite (we have a real signal)
    //   - otherwise → preserve curated value, attach detection metadata only
    const existing = (company.ats_hint || '').trim();
    const existingIsPlaceholder = !existing || existing === '?' || existing.toLowerCase() === 'unknown';
    const detectionIsStrong =
      detection.ats !== 'unknown' &&
      detection.ats !== 'custom' &&
      detection.confidence >= 0.8;

    if (detectionIsStrong || (existingIsPlaceholder && detection.ats !== 'unknown')) {
      // Real signal — write/overwrite.
      company.ats_hint = detection.ats;
      company.ats_hint_confidence = Number(detection.confidence.toFixed(2));
      company.ats_hint_evidence = detection.evidence;
      company.ats_hint_career_url = target.careerUrl;
      company.ats_hint_detected_at = new Date().toISOString();
    } else if (detection.ats !== 'unknown') {
      // Weak detection (e.g. custom@0.5) but curated value exists — keep curated,
      // record what we observed for traceability.
      company.ats_hint_confidence = Number(detection.confidence.toFixed(2));
      company.ats_hint_evidence = detection.evidence;
      company.ats_hint_career_url = target.careerUrl;
      company.ats_hint_detected_at = new Date().toISOString();
    } else if (existingIsPlaceholder) {
      // Detection failed AND no prior real value — flag for manual review,
      // but don't blow away an existing curated value.
      company.ats_hint = 'unknown';
      company.ats_hint_confidence = 0;
      company.ats_hint_evidence = detection.evidence;
      company.ats_hint_career_url = target.careerUrl;
      company.ats_hint_detected_at = new Date().toISOString();
    }
    // Else: keep curated ats_hint (e.g. "Workday") untouched.

    results.push({
      name: company.name,
      careerUrl: target.careerUrl,
      detected: detection.ats,
      confidence: detection.confidence,
      evidence: detection.evidence,
      writtenHint: company.ats_hint,
    });

    // Polite delay between consecutive HTTP calls
    if (i < TOP_MARQUEE_TARGETS.length - 1) {
      await new Promise((r) => setTimeout(r, POLITE_DELAY_MS));
    }
  }

  await writeFile(MARQUEE_PATH, JSON.stringify(data, null, 2) + '\n', 'utf8');

  // Print final report table to stdout
  console.log('\n=== ATS Detection Report ===');
  console.log('name | careerUrl | detected | confidence | hint_written');
  console.log('---- | ---- | ---- | ---- | ----');
  for (const r of results) {
    if (r.status) {
      console.log(`${r.name} | (skipped: ${r.status}) | - | - | -`);
    } else {
      console.log(`${r.name} | ${r.careerUrl} | ${r.detected} | ${r.confidence.toFixed(2)} | ${r.writtenHint}`);
    }
  }

  const unknowns = results.filter((r) => r.detected === 'unknown');
  if (unknowns.length) {
    console.log('\n=== Manual research needed (ats_hint=unknown) ===');
    for (const r of unknowns) {
      console.log(`- ${r.name} (${r.careerUrl}) — evidence: ${JSON.stringify(r.evidence)}`);
    }
  }

  return results;
}

// -----------------------------------------------------------------------------
// CLI entrypoint
// -----------------------------------------------------------------------------

function parseArgs(argv) {
  const out = { url: null, marquee: false };
  for (const a of argv.slice(2)) {
    if (a.startsWith('--url=')) out.url = a.slice('--url='.length);
    else if (a === '--marquee') out.marquee = true;
    else if (a === '--help' || a === '-h') out.help = true;
  }
  return out;
}

async function main() {
  const args = parseArgs(process.argv);
  if (args.help) {
    console.log('Usage: node scripts/detect-ats.mjs --url=https://career.example.com');
    console.log('       node scripts/detect-ats.mjs --marquee');
    process.exit(0);
  }
  if (args.marquee) {
    await runMarqueeBatch();
    return;
  }
  if (!args.url) {
    console.error('Error: --url=... or --marquee required (see --help)');
    process.exit(2);
  }
  const result = await detectAtsForUrl(args.url);
  console.log(JSON.stringify(result, null, 2));
}

const isDirectRun = process.argv[1] && path.resolve(process.argv[1]) === __filename;
if (isDirectRun) {
  main().catch((err) => {
    console.error('Fatal:', err);
    process.exit(1);
  });
}
