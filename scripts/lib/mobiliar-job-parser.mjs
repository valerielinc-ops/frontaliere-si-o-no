#!/usr/bin/env node
/**
 * die Mobiliar job parser — Fetcher and job builder.
 *
 * Source: https://jobs.mobiliar.ch/
 *
 * Exports the 4 required functions for the crawler template:
 *   - fetchAllMobiliarJobs()  — Fetch and parse all jobs
 *   - isMobiliarJob()         — Match jobs belonging to this company
 *   - isTrustedDomain()           — Validate URLs belong to this company
 *   - slugify() / stripHtml()     — Re-exported from crawler-template.mjs
 */
import { createHash } from 'node:crypto';
import { detectLang } from './dedicated-crawler-common.mjs';
import { slugify, stripHtml } from './crawler-template.mjs';
import {  inferSwissTargetCanton, inferAnyCanton  } from './target-swiss-locations.mjs';

/* ── Constants ─────────────────────────────────────────────── */

export const MOBILIAR_KEY = 'mobiliar';
export const MOBILIAR_COMPANY_NAME = 'die Mobiliar';
export const MOBILIAR_COMPANY_DOMAIN = 'mobiliar.ch';

const CAREER_URL = 'https://jobs.mobiliar.ch/';

/* ── Helpers ───────────────────────────────────────────────── */

function normalize(value = '') {
  return String(value || '').trim().toLowerCase();
}

function normalizeSpace(s = '') {
  return String(s || '').replace(/\s+/g, ' ').trim();
}

/* ── Company Matchers ──────────────────────────────────────── */

/**
 * Check if a job belongs to die Mobiliar.
 * Used by the template to filter this company's jobs from the global dataset.
 */
export function isMobiliarJob(job) {
  const key = normalize(job?.companyKey || job?.company || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  const company = normalize(job?.company || '');
  const url = normalize(job?.url || '');

  return (
    key === MOBILIAR_KEY ||
    key.startsWith('mobiliar') ||
    company.includes('die mobiliar') ||
    url.includes('mobiliar.ch')
  );
}

/**
 * Validate that a URL belongs to die Mobiliar's domain.
 */
export function isTrustedDomain(rawUrl = '') {
  try {
    const host = new URL(rawUrl).hostname.toLowerCase();
    return host === 'mobiliar.ch' || host.endsWith('.mobiliar.ch');
  } catch {
    return false;
  }
}

/* ── Category Detection ────────────────────────────────────── */

function detectCategory(title = '') {
  const t = normalize(title);
  if (/\b(ingegner|engineer|entwickl)/.test(t)) return 'Ingegneria';
  if (/\b(techni|tecnic|mecanic|elektr|install)/.test(t)) return 'Tecnica';
  if (/\b(admin|segret|contab|buchhalt|account)/.test(t)) return 'Amministrazione';
  if (/\b(vendita|sales|verkauf|commerce)/.test(t)) return 'Commerciale';
  if (/\b(logist|magazz|lager|warehouse)/.test(t)) return 'Logistica';
  if (/\b(produz|operat|operator|manufactur)/.test(t)) return 'Produzione';
  if (/\b(qualit|qa|qc|quality)/.test(t)) return 'Qualità';
  if (/\b(it|software|develop|programm)/.test(t)) return 'IT';
  if (/\b(hr|human|risorse|personal)/.test(t)) return 'Risorse Umane';
  if (/\b(market|kommunik|comunicaz)/.test(t)) return 'Marketing';
  if (/\b(finanz|finance|financ)/.test(t)) return 'Finanza';
  if (/\b(legal|giurid|recht)/.test(t)) return 'Legale';
  return 'Altro';
}

function detectExperienceLevel(title = '') {
  const t = normalize(title);
  if (/\b(praktik|stage|stagiair|intern|apprendist|lehrling|lernend|apprenti)/.test(t)) return 'intern';
  if (/\b(junior|jr)/.test(t)) return 'junior';
  if (/\b(senior|sr|lead|head|director|dirett|chef|verantwort|responsab)/.test(t)) return 'senior';
  return 'mid';
}

function detectEmploymentType(text = '') {
  const t = normalize(text);
  if (/\b(part.?time|teilzeit|tempo parziale|temps partiel)/.test(t)) return 'PART_TIME';
  if (/\b(full.?time|vollzeit|tempo pieno|temps plein)/.test(t)) return 'FULL_TIME';
  return 'OTHER';
}

/* ── HTTP helpers ─────────────────────────────────────────── */

/*
 * Cathedral CH-wide expansion (2026-05-10):
 * The previous `VALAIS_KEYWORDS` list pre-filtered the Mobiliar sitemap to
 * Valais-only URLs. This blocked all non-VS jobs (BE/ZH/GE/etc.). The
 * canton-quorum-gate downstream now handles canton classification for the
 * full Swiss tenant, so we surface every job URL from the sitemap.
 */

const SITEMAP_URL = 'https://jobs.mobiliar.ch/sitemap.xml';
const JOB_BASE = 'https://jobs.mobiliar.ch';

/**
 * Fetch a URL and return the response text with timeout handling.
 */
async function fetchText(url) {
  const timeoutMs = Number(process.env.JOBS_CRAWLER_TIMEOUT_MS) || 20000;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetch(url, {
      method: 'GET',
      headers: {
        Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'User-Agent': process.env.JOBS_CRAWLER_USER_AGENT ||
          'Mozilla/5.0 (compatible; FrontaliereTicinoBot/1.0; +https://frontaliereticino.ch/)',
      },
      signal: controller.signal,
    });
    clearTimeout(timer);
    if (!res.ok) throw new Error(`HTTP ${res.status} from ${url}`);
    return await res.text();
  } catch (err) {
    clearTimeout(timer);
    throw err;
  }
}

/**
 * Parse sitemap.xml and extract ALL Swiss Mobiliar job URLs.
 * URL pattern: /job/{Location}-{Title}/{ID}/
 *
 * Cathedral CH-wide (2026-05-10): no location pre-filter — the
 * canton-quorum-gate handles per-canton classification downstream.
 */
async function fetchAllSwissJobUrls() {
  console.log(`  📄 Fetching sitemap: ${SITEMAP_URL}`);
  const xml = await fetchText(SITEMAP_URL);

  // Extract all <loc> URLs that point at job detail pages.
  const allUrls = [...xml.matchAll(/<loc>([^<]+)<\/loc>/gi)]
    .map((m) => m[1].trim())
    .filter((url) => url.includes('/job/'));

  console.log(`  📦 Total Swiss job URLs in sitemap: ${allUrls.length}`);
  return allUrls;
}

/**
 * Extract the job ID from a Mobiliar job URL.
 * Pattern: /job/{slug}/{ID}/
 */
function extractJobId(url = '') {
  const match = url.match(/\/job\/[^/]+\/(\d+)\/?$/);
  return match ? match[1] : '';
}

/**
 * Extract location from the job URL path.
 * Pattern: /job/{Location}-{rest-of-title}/{ID}/
 */
function extractLocationFromUrl(url = '') {
  const match = url.match(/\/job\/([^/]+)\//);
  if (!match) return '';
  const slug = decodeURIComponent(match[1]);
  // First segment before a dash is usually the location
  const parts = slug.split('-');
  return parts[0] || '';
}

/**
 * Parse a Mobiliar job detail page HTML to extract structured content.
 */
function parseDetailPage(html = '') {
  if (!html) return null;

  // Title from <h1>
  const h1Match = html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i);
  const title = h1Match ? normalizeSpace(stripHtml(h1Match[1])) : '';
  if (!title || title.length < 3) return null;

  // Extract all <h2> sections and their content
  const sections = [];
  const h2Pattern = /<h2[^>]*>([\s\S]*?)<\/h2>/gi;
  const h2Positions = [];
  let h2Match;
  while ((h2Match = h2Pattern.exec(html)) !== null) {
    h2Positions.push({
      heading: normalizeSpace(stripHtml(h2Match[1])),
      index: h2Match.index,
      endIndex: h2Match.index + h2Match[0].length,
    });
  }

  // Extract content between h2 sections
  for (let i = 0; i < h2Positions.length; i++) {
    const start = h2Positions[i].endIndex;
    const end = i + 1 < h2Positions.length ? h2Positions[i + 1].index : html.length;
    const content = stripHtml(html.slice(start, Math.min(end, start + 5000)));
    if (content.length > 5) {
      sections.push({ heading: h2Positions[i].heading, content });
    }
  }

  // Build description from sections
  const descParts = sections
    .filter((s) => !['Mehr erfahren', 'Neugierig?'].includes(s.heading))
    .map((s) => `${s.heading}:\n${s.content}`);
  const description = descParts.join('\n\n').trim();

  // Extract requirements from "Das bringst du mit" section
  const reqSection = sections.find((s) =>
    /bringst du mit|profil|anforderungen|requirements/i.test(s.heading)
  );
  const requirements = reqSection
    ? reqSection.content
        .split('\n')
        .map((line) => line.replace(/^[-•]\s*/, '').trim())
        .filter((line) => line.length > 3)
    : [];

  // Extract contact location
  const addressMatch = html.match(/(\d{4})\s+([\w\u00C0-\u024F\s]+?)(?:<|,|\n)/);
  const postalCode = addressMatch ? addressMatch[1] : '';
  const contactCity = addressMatch ? normalizeSpace(addressMatch[2]) : '';

  // Extract employment percentage
  const pctMatch = html.match(/(\d{1,3})\s*(?:[-–]\s*(\d{1,3}))?\s*%/);
  const pensum = pctMatch
    ? pctMatch[2]
      ? `${pctMatch[1]}-${pctMatch[2]}%`
      : `${pctMatch[1]}%`
    : '';

  return {
    title,
    description,
    requirements,
    contactCity,
    postalCode,
    pensum,
  };
}

/**
 * Fetch all die Mobiliar jobs across Switzerland (CH-wide, all 26 cantons).
 * Strategy:
 *   1. Fetch sitemap.xml and surface every job URL
 *   2. Fetch each detail page and parse HTML
 *   3. Build ParsedJob objects (canton-quorum-gate tags canton downstream)
 *
 * Returns an array of ParsedJob objects (source-locale only).
 *
 * IMPORTANT: Only set source-locale fields. Other locales are filled
 * by the AI localization step and translate-pending pipeline.
 */
export async function fetchAllMobiliarJobs() {
  console.log(`🔍 Fetching die Mobiliar jobs (CH-wide, all 26 cantons)`);
  console.log(`   Source: ${CAREER_URL}`);
  console.log(`   Strategy: Sitemap → all Swiss URLs → detail pages\n`);

  const jobUrls = await fetchAllSwissJobUrls();
  if (!jobUrls || jobUrls.length === 0) {
    console.warn('⚠️ No job URLs found in sitemap.');
    return [];
  }

  console.log(`\n  📋 Fetching ${jobUrls.length} detail pages...\n`);

  const jobs = [];
  for (const jobUrl of jobUrls) {
    const jobId = extractJobId(jobUrl);
    const urlLocation = extractLocationFromUrl(jobUrl);

    try {
      const html = await fetchText(jobUrl);
      const parsed = parseDetailPage(html);

      if (!parsed) {
        console.warn(`  ⚠️ Could not parse detail page: ${jobUrl}`);
        continue;
      }

      // Cathedral CH-wide (2026-05-10): default to Mobiliar HQ (Bern) when
      // no city is parseable; canton-quorum-gate downstream re-classifies.
      const location = parsed.contactCity || urlLocation || 'Bern';
      const canton = inferAnyCanton(location) || '';
      const descriptionText = parsed.description || `${parsed.title} — die Mobiliar`;

      const sourceLang = detectLang(descriptionText || parsed.title, 'de');
      const jobSlug = slugify(`${parsed.title} mobiliar ch`);
      const urlHash = createHash('sha1').update(jobUrl).digest('hex').slice(0, 12);

      const job = {
        // ── Required fields ──
        id: `mobiliar-${urlHash}`,
        slug: jobSlug,
        slugByLocale: { [sourceLang]: jobSlug },
        company: MOBILIAR_COMPANY_NAME,
        companyKey: MOBILIAR_KEY,
        companyDomain: MOBILIAR_COMPANY_DOMAIN,
        title: parsed.title,
        titleByLocale: { [sourceLang]: parsed.title },
        description: descriptionText,
        descriptionByLocale: { [sourceLang]: descriptionText },
        location,
        canton,
        url: jobUrl,
        source: 'die Mobiliar Dedicated Parser (SuccessFactors)',
        sourceLang,
        crawledAt: new Date().toISOString(),

        // ── Recommended fields ──
        addressLocality: location,
        addressCountry: 'CH',
        country: 'CH',
        ...(parsed.postalCode ? { postalCode: parsed.postalCode } : {}),
        category: detectCategory(parsed.title),
        contract: parsed.pensum === '100%' ? 'full-time' : 'full-time',
        employmentType: detectEmploymentType(parsed.pensum || parsed.title),
        experienceLevel: detectExperienceLevel(parsed.title),
        sector: 'Assicurazioni',
        currency: 'CHF',
        featured: false,
        postedDate: new Date().toISOString().split('T')[0],
        applyUrl: jobUrl,
        ...(parsed.pensum ? { pensum: parsed.pensum } : {}),
        requirements: parsed.requirements,
        requirementsByLocale: { [sourceLang]: parsed.requirements },
      };

      if (jobId) job.sfJobId = jobId;

      jobs.push(job);
      console.log(`  ✅ ${jobId || '—'} — ${parsed.title.substring(0, 60)}`);
    } catch (err) {
      console.warn(`  ⚠️ Skipping ${jobUrl} — fetch failed: ${err?.message || err}`);
    }

    await new Promise((r) => setTimeout(r, 500));
  }

  console.log(`\n📋 Total die Mobiliar Valais jobs discovered: ${jobs.length}`);
  return jobs;
}
