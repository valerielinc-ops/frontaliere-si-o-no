#!/usr/bin/env node
/**
 * Réseau Santé Balcon du Jura Vaudois (RSBJ) job parser.
 *
 * Public career site: https://www.rsbj.ch/jcms/rsbj_8733/fr/nos-offres-d-emplois
 *
 * Healthcare network of the Jura region (Ste-Croix, L'Auberson). Built on
 * Jalios JCMS but with server-rendered "vignette" cards (NOT the jobup.ch
 * mask integration used by sister networks like PSPE).
 *
 * Vignette structure:
 *   <a href="jcms/rsbj_{ID}/fr/{slug}" class="vignette-a" data-jalios-id="rsbj_{ID}">
 *     <div class="vignette">...</div>
 *     <div class="vignette-title" style="background-color:{HEX}">
 *       <div class="title">{TITLE}<br>{CONTRACT} {RATE}</div>
 *     </div>
 *   </a>
 */
import { createHash } from 'node:crypto';
import { detectLang } from './dedicated-crawler-common.mjs';
import { slugify } from './crawler-template.mjs';

export const RSBJ_KEY = 'rsbj';
export const RSBJ_COMPANY_NAME = 'Réseau Santé Balcon du Jura Vaudois (RSBJ)';
export const RSBJ_COMPANY_DOMAIN = 'rsbj.ch';

const LISTING_URL = 'https://www.rsbj.ch/jcms/rsbj_8733/fr/nos-offres-d-emplois';
const BASE_URL = 'https://www.rsbj.ch';

const USER_AGENT = process.env.JOBS_CRAWLER_USER_AGENT
  || 'Mozilla/5.0 (compatible; FrontaliereTicinoBot/1.0; +https://frontaliereticino.ch/)';

const NAMED_ENTITIES = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ',
  agrave: 'à', acirc: 'â', auml: 'ä', eacute: 'é', egrave: 'è', ecirc: 'ê',
  iacute: 'í', igrave: 'ì', icirc: 'î', iuml: 'ï',
  oacute: 'ó', ograve: 'ò', ocirc: 'ô', ouml: 'ö',
  uacute: 'ú', ugrave: 'ù', ucirc: 'û', uuml: 'ü',
  ccedil: 'ç', oelig: 'œ', rsquo: '’', ndash: '–', mdash: '—',
};

function decodeEntities(s = '') {
  return String(s || '')
    .replace(/&([a-zA-Z]+);/g, (m, n) => Object.prototype.hasOwnProperty.call(NAMED_ENTITIES, n) ? NAMED_ENTITIES[n] : m)
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCodePoint(parseInt(h, 16)));
}

function normalize(s = '') {
  return String(s || '').trim().toLowerCase();
}

function normalizeSpace(s = '') {
  return String(s || '').replace(/\s+/g, ' ').trim();
}

export function isRsbjJob(job) {
  const key = normalize(job?.companyKey || '');
  const url = normalize(job?.url || '');
  if (key === RSBJ_KEY) return true;
  if (url.includes('rsbj.ch')) return true;
  return false;
}

export function isTrustedDomain(rawUrl = '') {
  try {
    const host = new URL(rawUrl).hostname.toLowerCase();
    return host === 'rsbj.ch' || host.endsWith('.rsbj.ch');
  } catch {
    return false;
  }
}

async function fetchHtml(url) {
  const timeoutMs = Number(process.env.JOBS_CRAWLER_TIMEOUT_MS) || 20000;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      headers: { Accept: 'text/html,application/xhtml+xml', 'User-Agent': USER_AGENT },
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

export function parseRsbjListing(html) {
  const out = [];
  const seen = new Set();
  const rx = /<a\s+href="(jcms\/rsbj_(\d+)\/[^"]+)"\s+class="\s*vignette-a"\s+data-jalios-id='rsbj_\d+'>([\s\S]*?)<\/a>/g;
  let m;
  while ((m = rx.exec(html))) {
    const relUrl = m[1];
    const id = m[2];
    if (seen.has(id)) continue;
    const innerHtml = m[3];
    const titleMatch = innerHtml.match(/<div class="title"[^>]*>([\s\S]*?)<\/div>/);
    if (!titleMatch) continue;
    // Title may include <br> for second line (CDI 100%, etc.)
    const rawTitleHtml = titleMatch[1];
    const lines = rawTitleHtml
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<[^>]+>/g, ' ')
      .split('\n')
      .map((l) => normalizeSpace(decodeEntities(l)))
      .filter(Boolean);
    if (lines.length === 0) continue;
    const title = lines[0];
    if (!title || title.length < 5) continue;
    const meta = lines.slice(1).join(' · ');

    seen.add(id);
    out.push({ id, url: `${BASE_URL}/${relUrl}`, title, meta });
  }
  return out;
}

function detectEmploymentType(text = '') {
  const t = normalize(text);
  const m = t.match(/(\d{2,3})\s*[-–]\s*(\d{2,3})\s*%/) || t.match(/(\d{2,3})\s*%/);
  if (m) {
    const maxPct = m[2] ? parseInt(m[2], 10) : parseInt(m[1], 10);
    return maxPct < 90 ? 'PART_TIME' : 'FULL_TIME';
  }
  return 'OTHER';
}

function detectContract(text = '') {
  const t = text.toLowerCase();
  if (/\bcdd\b|durée déterminée|temporaire|temporary|fixed/.test(t)) return 'temporary';
  if (/\bcdi\b|durée indéterminée|permanent/.test(t)) return 'full-time';
  return 'full-time';
}

function detectCategory(title = '') {
  const t = normalize(title);
  if (/médecin|medecin|infirm|soin|aide.soignant|hospital|sant[ée]/.test(t)) return 'Sanità / Ospedali';
  if (/technique|maintenan|b[âa]timent/.test(t)) return 'Tecnica';
  if (/admin|secret|gestion|finance|compt/.test(t)) return 'Amministrazione';
  if (/cuisine|restauration|h[ôo]tel/.test(t)) return 'Ospitalità';
  if (/apprenti|stage/.test(t)) return 'Formazione';
  return 'Sanità / Ospedali';
}

function detectExperienceLevel(title = '') {
  const t = normalize(title);
  if (/apprenti|stage|intern/.test(t)) return 'intern';
  if (/junior|assistant/.test(t)) return 'junior';
  if (/senior|chef|responsable|directeur|cadre|encadrant/.test(t)) return 'senior';
  return 'mid';
}

export async function fetchAllRsbjJobs() {
  console.log(`🏥 Fetching ${RSBJ_COMPANY_NAME} jobs`);
  console.log(`   Source: ${LISTING_URL}\n`);

  const html = await fetchHtml(LISTING_URL);
  const entries = parseRsbjListing(html);
  console.log(`  ✓ ${entries.length} vignettes found`);

  if (!entries.length) return [];

  const todayIso = new Date().toISOString().slice(0, 10);
  const jobs = [];
  for (const e of entries) {
    const title = e.title;
    const description = [
      e.meta,
      'Réseau Santé Balcon du Jura Vaudois — Sites Sainte-Croix, L\'Auberson, Bullet.',
    ].filter(Boolean).join('\n\n');
    const location = 'Sainte-Croix';
    const canton = 'VD';
    const sourceLang = detectLang(description || title, 'fr');
    const jobSlug = slugify(`${title} ${RSBJ_KEY} ${location}`);
    const urlHash = createHash('sha1').update(e.url).digest('hex').slice(0, 12);

    jobs.push({
      id: `${RSBJ_KEY}-${urlHash}`,
      slug: jobSlug,
      slugByLocale: { [sourceLang]: jobSlug },
      company: RSBJ_COMPANY_NAME,
      companyKey: RSBJ_KEY,
      companyDomain: RSBJ_COMPANY_DOMAIN,
      title,
      titleByLocale: { [sourceLang]: title },
      description,
      descriptionByLocale: { [sourceLang]: description },
      location,
      canton,
      url: e.url,
      source: 'RSBJ Dedicated Parser (Jalios JCMS vignettes)',
      sourceLang,
      crawledAt: new Date().toISOString(),

      addressLocality: location,
      addressRegion: canton,
      addressCountry: 'CH',
      country: 'CH',
      postalCode: '1450',
      category: detectCategory(title),
      contract: detectContract(e.meta || title),
      employmentType: detectEmploymentType(e.meta || title),
      experienceLevel: detectExperienceLevel(title),
      sector: 'Sanità / Ospedali',
      currency: 'CHF',
      featured: false,
      postedDate: todayIso,
      applyUrl: e.url,
      requirements: [],
      requirementsByLocale: { [sourceLang]: [] },
    });
  }

  console.log(`📋 Total ${RSBJ_COMPANY_NAME} jobs discovered: ${jobs.length}`);
  return jobs;
}
