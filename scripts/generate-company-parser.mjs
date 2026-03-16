#!/usr/bin/env node
/**
 * Generate (AI-assisted) crawler/parser config proposal for a single company.
 *
 * Inputs (env):
 * - PARSER_COMPANY_NAME (required)
 * - PARSER_COMPANY_WEBSITE (required)
 * - PARSER_COMPANY_KEY (optional)
 * - PARSER_APPLY_CONFIG ('1' to merge into jobs-crawler-config.json)
 *
 * Secrets (handled by centralized scripts/lib/ai-models.mjs):
 * - GH_MODELS_PAT, GEMINI_API_KEY, GROQ_API_KEY, OPENROUTER_API_KEY
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { callLLM, flushScores } from './lib/ai-models.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const CONFIG_PATH = path.resolve(ROOT, 'data', 'jobs-crawler-config.json');
const PROPOSALS_PATH = path.resolve(ROOT, 'data', 'jobs-crawler-parser-proposals.json');

const PARSER_COMPANY_NAME = normalizeSpace(process.env.PARSER_COMPANY_NAME || '');
const PARSER_COMPANY_WEBSITE = normalizeSpace(process.env.PARSER_COMPANY_WEBSITE || '');
const PARSER_COMPANY_KEY = normalizeSpace(process.env.PARSER_COMPANY_KEY || '');
const PARSER_APPLY_CONFIG = String(process.env.PARSER_APPLY_CONFIG || '0') === '1';

// Model constants removed — AI calls go through centralized scripts/lib/ai-models.mjs
const REQUEST_TIMEOUT_MS = 15000;
const MAX_URLS_FOR_PROMPT = 24;

const CAREER_HINTS = [
  '/careers',
  '/career',
  '/jobs',
  '/job',
  '/vacancies',
  '/open-positions',
  '/join-us',
  '/work-with-us',
  '/karriere',
  '/stellen',
  '/offene-stellen',
  '/lavora-con-noi',
  '/carriere',
  '/emplois',
  '/carrieres',
];

const ATS_HOST_HINTS = [
  'myworkdayjobs.com',
  'greenhouse.io',
  'lever.co',
  'smartrecruiters.com',
  'teamtailor.com',
  'personio.',
  'successfactors.com',
];

function normalizeSpace(s) {
  return String(s || '').replace(/\u00a0/g, ' ').replace(/\s+/g, ' ').trim();
}

function slugify(s) {
  return String(s || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function readJson(filePath, fallback = null) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
  } catch {
    return fallback;
  }
}

function writeJson(filePath, value) {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf-8');
}

function normalizeHost(input) {
  return String(input || '').toLowerCase().trim().replace(/^www\d?\./, '');
}

function hostOf(url) {
  try {
    return normalizeHost(new URL(url).hostname);
  } catch {
    return '';
  }
}

function sameRegistrableDomain(hostA, hostB) {
  const a = normalizeHost(hostA);
  const b = normalizeHost(hostB);
  if (!a || !b) return false;
  const reg = (h) => {
    const parts = h.split('.').filter(Boolean);
    if (parts.length <= 2) return h;
    return parts.slice(-2).join('.');
  };
  return reg(a) === reg(b);
}

function tryUrl(raw, base = null) {
  try {
    return base ? new URL(raw, base).toString() : new URL(raw).toString();
  } catch {
    return null;
  }
}

async function fetchText(url) {
  const res = await fetch(url, { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return await res.text();
}

function extractCandidateLinks(html, baseUrl, companyHost) {
  const links = new Set();
  const re = /<a[^>]+href\s*=\s*["']([^"']+)["'][^>]*>/gi;
  let m;
  while ((m = re.exec(html))) {
    const abs = tryUrl(m[1], baseUrl);
    if (!abs) continue;
    const u = new URL(abs);
    const host = normalizeHost(u.hostname);
    const absLow = abs.toLowerCase();
    const hasCareerToken = CAREER_HINTS.some((h) => absLow.includes(h));
    const isAts = ATS_HOST_HINTS.some((h) => host.includes(h));
    const inCompanyDomain = sameRegistrableDomain(host, companyHost);
    if ((hasCareerToken && inCompanyDomain) || isAts) {
      links.add(abs);
    }
  }
  return [...links];
}

function buildHeuristicSeeds(companyWebsite, companyHost) {
  const out = new Set();
  out.add(companyWebsite);
  for (const hint of CAREER_HINTS) {
    const candidate = tryUrl(hint, companyWebsite);
    if (!candidate) continue;
    if (sameRegistrableDomain(hostOf(candidate), companyHost)) out.add(candidate);
  }
  return [...out];
}

// AI functions (isModelBusyOrRateLimited, callGitHubModels, callGemini, callLlm)
// moved to centralized scripts/lib/ai-models.mjs — using imported callLLM

function parseJsonSafe(raw) {
  const clean = String(raw || '')
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/i, '')
    .trim();
  return JSON.parse(clean);
}

function clampModes(input) {
  const allowed = new Set(['workday', 'teaser_api', 'generic_ats', 'html', 'jsonld']);
  const values = Array.isArray(input) ? input : [input];
  const out = [];
  for (const v of values) {
    const m = normalizeSpace(v).toLowerCase();
    if (allowed.has(m) && !out.includes(m)) out.push(m);
  }
  return out.length > 0 ? out : ['generic_ats', 'html', 'jsonld'];
}

async function main() {
  if (!PARSER_COMPANY_NAME || !PARSER_COMPANY_WEBSITE) {
    throw new Error('Missing required env: PARSER_COMPANY_NAME and PARSER_COMPANY_WEBSITE');
  }

  const companyWebsite = tryUrl(PARSER_COMPANY_WEBSITE);
  if (!companyWebsite) throw new Error(`Invalid company website URL: ${PARSER_COMPANY_WEBSITE}`);

  const companyName = PARSER_COMPANY_NAME;
  const companyKey = PARSER_COMPANY_KEY || slugify(companyName);
  const companyHost = hostOf(companyWebsite);

  const heuristicSeeds = buildHeuristicSeeds(companyWebsite, companyHost);
  const discovered = new Set(heuristicSeeds);
  let homepageHtml = '';

  try {
    homepageHtml = await fetchText(companyWebsite);
    for (const link of extractCandidateLinks(homepageHtml, companyWebsite, companyHost)) discovered.add(link);
  } catch (err) {
    console.warn(`⚠️ Homepage fetch failed: ${err instanceof Error ? err.message : String(err)}`);
  }

  const candidateUrls = [...discovered].slice(0, MAX_URLS_FOR_PROMPT);

  let proposal = null;
  let aiError = null;
  try {
    const messages = [
      {
        role: 'system',
        content:
          'You are an expert ATS/career crawler architect. Return strict JSON only. No markdown.',
      },
      {
        role: 'user',
        content: [
          `Company name: ${companyName}`,
          `Company key: ${companyKey}`,
          `Company website: ${companyWebsite}`,
          `Company host: ${companyHost}`,
          `Candidate career URLs (already discovered/heuristic):`,
          ...candidateUrls.map((u) => `- ${u}`),
          '',
          'Return JSON with keys:',
          '{',
          '  "companyKey": "slug",',
          '  "crawlerMode": ["workday"|"teaser_api"|"generic_ats"|"html"|"jsonld"],',
          '  "sourceSeedsByDomain": ["https://..."],',
          '  "sourceSeedsByName": ["https://..."],',
          '  "notes": "short rationale",',
          '  "confidence": 0-1',
          '}',
          '',
          'Rules:',
          '- Prefer URLs that directly list jobs (not generic corporate pages).',
          '- Keep max 8 URLs per list.',
          '- If Workday URLs are present, include mode "workday".',
          '- If ATS list page API/teaser is evident, include "teaser_api".',
          '- Always include fallback modes for reliability.',
        ].join('\n'),
      },
    ];

    const raw = await callLLM(messages, { jsonMode: true, maxTokens: 2500, temperature: 0.2 });
    proposal = parseJsonSafe(raw);
  } catch (err) {
    aiError = err instanceof Error ? err.message : String(err);
  }

  const byDomain = Array.isArray(proposal?.sourceSeedsByDomain)
    ? proposal.sourceSeedsByDomain.map((u) => tryUrl(u)).filter(Boolean)
    : [];
  const byName = Array.isArray(proposal?.sourceSeedsByName)
    ? proposal.sourceSeedsByName.map((u) => tryUrl(u)).filter(Boolean)
    : [];

  const fallbackSeeds = candidateUrls.filter((u) => {
    const h = hostOf(u);
    return sameRegistrableDomain(h, companyHost) || ATS_HOST_HINTS.some((hint) => h.includes(hint));
  });

  const finalDomainSeeds = [...new Set((byDomain.length ? byDomain : fallbackSeeds).slice(0, 8))];
  const finalNameSeeds = [...new Set((byName.length ? byName : fallbackSeeds).slice(0, 8))];

  const heuristicMode = finalDomainSeeds.some((u) => hostOf(u).includes('myworkdayjobs.com'))
    ? ['workday']
    : ['generic_ats', 'html', 'jsonld'];
  const finalModes = clampModes(proposal?.crawlerMode || heuristicMode);

  const proposalRecord = {
    companyKey,
    companyName,
    companyWebsite,
    companyHost,
    generatedAt: new Date().toISOString(),
    sourceSeedsByDomain: finalDomainSeeds,
    sourceSeedsByName: finalNameSeeds,
    crawlerMode: finalModes,
    confidence: Number.isFinite(Number(proposal?.confidence)) ? Number(proposal.confidence) : null,
    notes: normalizeSpace(proposal?.notes || ''),
    aiError,
    applied: PARSER_APPLY_CONFIG,
    appliedAt: PARSER_APPLY_CONFIG ? new Date().toISOString() : null,
  };

  const existingProposals = readJson(PROPOSALS_PATH, { proposals: [] });
  const normalized = Array.isArray(existingProposals?.proposals) ? existingProposals.proposals : [];
  const withoutCurrent = normalized.filter((p) => String(p?.companyKey || '') !== companyKey);
  withoutCurrent.unshift(proposalRecord);
  writeJson(PROPOSALS_PATH, { generatedAt: new Date().toISOString(), proposals: withoutCurrent.slice(0, 500) });

  if (PARSER_APPLY_CONFIG) {
    const cfg = readJson(CONFIG_PATH, {});
    cfg.sourceSeeds = cfg.sourceSeeds && typeof cfg.sourceSeeds === 'object' ? cfg.sourceSeeds : {};
    cfg.sourceSeeds.byDomain = cfg.sourceSeeds.byDomain && typeof cfg.sourceSeeds.byDomain === 'object'
      ? cfg.sourceSeeds.byDomain
      : {};
    cfg.sourceSeeds.byName = cfg.sourceSeeds.byName && typeof cfg.sourceSeeds.byName === 'object'
      ? cfg.sourceSeeds.byName
      : {};
    cfg.companyCrawlerMode = cfg.companyCrawlerMode && typeof cfg.companyCrawlerMode === 'object'
      ? cfg.companyCrawlerMode
      : {};

    const currentDomainSeeds = Array.isArray(cfg.sourceSeeds.byDomain[companyHost]) ? cfg.sourceSeeds.byDomain[companyHost] : [];
    cfg.sourceSeeds.byDomain[companyHost] = [...new Set([...currentDomainSeeds, ...finalDomainSeeds])];

    const companyNameKey = companyName.toLowerCase();
    const currentNameSeeds = Array.isArray(cfg.sourceSeeds.byName[companyNameKey]) ? cfg.sourceSeeds.byName[companyNameKey] : [];
    cfg.sourceSeeds.byName[companyNameKey] = [...new Set([...currentNameSeeds, ...finalNameSeeds])];

    cfg.companyCrawlerMode[companyKey] = finalModes;
    writeJson(CONFIG_PATH, cfg);
  }

  console.log(`✅ Parser proposal generated for ${companyName} (${companyKey})`);
  console.log(`   applyConfig=${PARSER_APPLY_CONFIG ? 'yes' : 'no'}`);
  console.log(`   modes=${finalModes.join(', ')}`);
  console.log(`   seeds(domain)=${finalDomainSeeds.length} | seeds(name)=${finalNameSeeds.length}`);
  if (aiError) console.log(`   aiFallbackReason=${aiError}`);

  // Flush persistent scores to Firestore before exit
  await flushScores();
}

main().catch((err) => {
  console.error(`❌ generate-company-parser failed: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
