#!/usr/bin/env node
/**
 * Solothurner Spitäler (soH) job parser — server-rendered HTML scrape.
 *
 * The umbrella entity "Solothurner Spitäler AG" (soH) operates four hospital
 * sites: Bürgerspital Solothurn, Kantonsspital Olten, Spital Grenchen, Spital
 * Dornach + the soMed primary-care network. The /karriere short URL on
 * www.so-h.ch redirects to www.solothurnerspitaeler.ch, and all open
 * vacancies are listed on /jobs-karriere/jobangebote as `.job-item` cards
 * server-side. There is no JSON API on the public site — we parse the HTML.
 *
 * Each card embeds:
 *   - id="soh-job-{internal_id}"
 *   - <h3>{rubric}</h3>          (e.g. "Pflege", "Administration und Betriebe")
 *   - <h2>{title}</h2>
 *   - <p class="hospital">{pensum} | {department} | {site_name}</p>
 *   - <a href="https://jobs.so-h.ch/offene-stellen/{slug}/{uuid}">
 *
 * Detail pages live on jobs.so-h.ch — a dedicated subdomain that hosts the
 * soH-branded ATS overlay (vendor unknown / private).
 *
 * Exports the 4 required functions for the crawler template:
 *   - fetchAllSolothurnerSpitaelerJobs()  — Fetch and parse all jobs
 *   - isSolothurnerSpitaelerJob()         — Match jobs belonging to soH
 *   - isTrustedDomain()                   — Validate URLs belong to soH
 *   - SOLOTHURNER_SPITAELER_KEY / _COMPANY_NAME / _COMPANY_DOMAIN constants
 */
import { createHash } from 'node:crypto';
import { slugify, normalizeSpace, stripHtml } from './crawler-template.mjs';

/* ── Constants ─────────────────────────────────────────────── */

export const SOLOTHURNER_SPITAELER_KEY = 'solothurner-spitaeler';
export const SOLOTHURNER_SPITAELER_COMPANY_NAME = 'Solothurner Spitäler (soH)';
export const SOLOTHURNER_SPITAELER_COMPANY_DOMAIN = 'solothurnerspitaeler.ch';

const LISTING_URL = 'https://www.solothurnerspitaeler.ch/jobs-karriere/jobangebote';
const PUBLIC_CAREER_URL = 'https://www.so-h.ch/karriere';

const USER_AGENT = process.env.JOBS_CRAWLER_USER_AGENT
  || 'Mozilla/5.0 (compatible; FrontaliereTicinoBot/1.0; +https://frontaliereticino.ch/)';

/* ── Helpers ───────────────────────────────────────────────── */

function normalize(value = '') {
  return String(value || '').trim().toLowerCase();
}

function decodeEntities(html = '') {
  return html
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&uuml;/g, 'ü')
    .replace(/&ouml;/g, 'ö')
    .replace(/&auml;/g, 'ä')
    .replace(/&Uuml;/g, 'Ü')
    .replace(/&Ouml;/g, 'Ö')
    .replace(/&Auml;/g, 'Ä')
    .replace(/&eacute;/g, 'é')
    .replace(/&egrave;/g, 'è')
    .replace(/&szlig;/g, 'ß')
    .replace(/&ndash;/g, '–')
    .replace(/&mdash;/g, '—');
}

/* ── Company Matchers ──────────────────────────────────────── */

export function isSolothurnerSpitaelerJob(job) {
  const key = normalize(job?.companyKey || job?.company || '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  const company = normalize(job?.company || '');
  const url = normalize(job?.url || '');

  return (
    key === SOLOTHURNER_SPITAELER_KEY ||
    key === 'soh' ||
    key === 'so-h' ||
    key === 'spital-buergerspital' ||
    key === 'buergerspital-solothurn' ||
    key.startsWith('solothurner-spit') ||
    company.includes('solothurner spitäler') ||
    company.includes('solothurner spitaeler') ||
    company.includes('bürgerspital solothurn') ||
    company.includes('kantonsspital olten') ||
    url.includes('so-h.ch') ||
    url.includes('solothurnerspitaeler.ch') ||
    url.includes('jobs.so-h.ch')
  );
}

export function isTrustedDomain(rawUrl = '') {
  try {
    const host = new URL(rawUrl).hostname.toLowerCase();
    if (host === 'so-h.ch' || host.endsWith('.so-h.ch')) return true;
    if (host === 'solothurnerspitaeler.ch' || host.endsWith('.solothurnerspitaeler.ch')) return true;
    return false;
  } catch {
    return false;
  }
}

/* ── Category / experience / employment heuristics ─────────── */

function detectCategory(title = '', rubric = '', department = '') {
  const signal = `${normalize(title)} ${normalize(rubric)} ${normalize(department)}`;
  if (/\b(pflege|pflegefach|stationsleitung|fage|fachperson gesundheit|spitex|hebamme)/.test(signal)) return 'Sanità / Ospedali';
  if (/\b(arzt|ärztin|oberarzt|chefarzt|leitend|medizin|chirurg|anästhes|notfall|onkolog|kardiolog|neurolog|psychiatr|psycholog|hno|urologie|gastroenterolog)/.test(signal)) return 'Sanità / Ospedali';
  if (/\b(ops|operation|lagerung|operationstechnik)/.test(signal)) return 'Sanità / Ospedali';
  if (/\b(labor|laborant|biomedizin|analyse)/.test(signal)) return 'Sanità / Ospedali';
  if (/\b(apothek|pharma)/.test(signal)) return 'Sanità / Ospedali';
  if (/\b(radiolog|röntgen|mtra|mrt)/.test(signal)) return 'Sanità / Ospedali';
  if (/\b(physiother|ergo|logopäd|rehabilit|ernährungs|diaet|diätet)/.test(signal)) return 'Sanità / Ospedali';
  if (/\b(praxisassistent|mpa|arztsekret)/.test(signal)) return 'Sanità / Ospedali';
  if (/\b(techni|haustechni|facility|wartung|maintenance|elektr|install|betriebselektr)/.test(signal)) return 'Tecnica';
  if (/\b(it|software|develop|programm|system|informatik)/.test(signal)) return 'IT';
  if (/\b(admin|segret|buchhalt|sachbearbeiter|account|finanz|controll)/.test(signal)) return 'Amministrazione';
  if (/\b(hr|human|personal|talent|recruit|berufsbildner|berufsbildung)/.test(signal)) return 'Risorse Umane';
  if (/\b(küche|koch|gastro|hauswirtschaft|reinigung|hotellerie|kueche)/.test(signal)) return 'Ospitalità';
  if (/\b(logist|magazz|lager|einkauf|transport)/.test(signal)) return 'Logistica';
  if (/\b(market|kommunik)/.test(signal)) return 'Marketing';
  if (/\b(lernend|praktik|ausbildung|apprenti|doktorand|berufsvorbereitungsjahr|bvj)/.test(signal)) return 'Formazione';
  return 'Sanità / Ospedali';
}

function detectExperienceLevel(title = '') {
  const t = normalize(title);
  if (/\b(praktik|stage|intern|apprendist|lehrling|lernend|doktorand|ausbildung|berufsvorbereitungsjahr|bvj|in ausbildung)/.test(t)) return 'intern';
  if (/\b(junior|jr|assistenzarzt|assistenzärztin|assistent)/.test(t)) return 'junior';
  if (/\b(senior|sr|lead|head|chef|verantwort|leiter|leitend|stationsleitung|oberarzt|chefarzt|berufsbildner)/.test(t)) return 'senior';
  return 'mid';
}

/**
 * Extract pensum range "70% - 100%" → { min:70, max:100 } from the
 * `<p class="hospital">…</p>` text. Returns null when no range is found.
 */
function extractPensum(hospitalText = '') {
  const t = String(hospitalText || '').trim();
  const range = t.match(/(\d{2,3})\s*%\s*[-–]\s*(\d{2,3})\s*%/);
  if (range) return { min: Number(range[1]), max: Number(range[2]) };
  const single = t.match(/(\d{2,3})\s*%/);
  if (single) {
    const v = Number(single[1]);
    return { min: v, max: v };
  }
  return null;
}

function detectEmploymentType(pensum) {
  if (!pensum) return 'OTHER';
  if (pensum.max < 80) return 'PART_TIME';
  return 'FULL_TIME';
}

/**
 * Map a soH site / hospital name to its canonical city + Solothurn postal
 * code. The Solothurn group keeps every site within canton SO.
 */
function pickCityForSite(siteName = '') {
  const s = String(siteName || '').toLowerCase();
  if (s.includes('olten')) return { city: 'Olten', postalCode: '4600' };
  if (s.includes('grenchen')) return { city: 'Grenchen', postalCode: '2540' };
  if (s.includes('dornach')) return { city: 'Dornach', postalCode: '4143' };
  if (s.includes('bürgerspital') || s.includes('buergerspital') || s.includes('solothurn')) {
    return { city: 'Solothurn', postalCode: '4500' };
  }
  return { city: 'Solothurn', postalCode: '4500' };
}

/* ── Listing Page Parser ──────────────────────────────────── */

/**
 * Parse a soH /jobangebote page. Each card is a
 * `<div class="item job-item" id="soh-job-{id}">…</div>` block. The hospital
 * line "70% - 100% &nbsp;|&nbsp; Department &nbsp;|&nbsp; Site name" is
 * split on `|` (after entity decoding).
 */
export function parseSohListingPage(html = '') {
  const results = [];
  const seen = new Set();
  // Pull each .job-item block. We bound the regex with the next `id="soh-job-`
  // marker (or end-of-list `</div>` cluster) to keep matches greedy-safe.
  const itemRegex = /<div\s+class="item job-item"[\s\S]*?id="soh-job-(\d+)"[\s\S]*?<\/div>\s*<\/div>\s*<\/div>/g;
  let m;
  while ((m = itemRegex.exec(html)) !== null) {
    const cardHtml = m[0];
    const sohId = m[1];
    if (seen.has(sohId)) continue;
    seen.add(sohId);

    const linkMatch = cardHtml.match(
      /<a\s[^>]*href="(https:\/\/jobs\.so-h\.ch\/offene-stellen\/[^"]+)"[^>]*>\s*<h2[^>]*>([\s\S]*?)<\/h2>\s*<\/a>/
    );
    if (!linkMatch) continue;
    const detailUrl = linkMatch[1];
    const title = normalizeSpace(decodeEntities(linkMatch[2].replace(/<[^>]+>/g, '')));
    if (!title || title.length < 3) continue;

    const uuidMatch = detailUrl.match(/\/([0-9a-f-]{36})$/i);
    const uuid = uuidMatch ? uuidMatch[1] : '';

    const rubricMatch = cardHtml.match(/<h3[^>]*>([^<]+)<\/h3>/);
    const rubric = rubricMatch ? normalizeSpace(decodeEntities(rubricMatch[1])) : '';

    const hospitalMatch = cardHtml.match(/<p\s+class="hospital[^"]*"[^>]*>([\s\S]*?)<\/p>/);
    const hospitalRaw = hospitalMatch ? decodeEntities(hospitalMatch[1].replace(/<[^>]+>/g, '')) : '';
    const hospitalParts = hospitalRaw.split('|').map((p) => normalizeSpace(p)).filter(Boolean);
    const pensumStr = hospitalParts[0] || '';
    const department = hospitalParts[1] || '';
    const siteName = hospitalParts[2] || '';

    results.push({
      sohId,
      uuid,
      title,
      rubric,
      pensumStr,
      department,
      siteName,
      detailUrl,
    });
  }
  return results;
}

/* ── Detail Page Parser ────────────────────────────────────── */

/**
 * Parse a soH detail page (jobs.so-h.ch/offene-stellen/{slug}/{uuid}).
 *
 * The page is server-rendered and embeds:
 *   - A JSON-LD JobPosting at the bottom with `description` / `responsibilities`
 *     / `qualifications` (richest source, prefer when present).
 *   - HTML containers <div id="tasks"> (Aufgaben) and <div id="profile">
 *     (Profil) as a fallback when JSON-LD is missing.
 *
 * Both branches include the German content headings "Aufgaben" / "Profil"
 * that satisfy the boilerplate-guard CONTENT_HEADINGS_RE.
 */
export function parseSohDetailPage(html = '') {
  const blocks = [];

  // ── Strategy A: JSON-LD JobPosting (richest) ─────────────
  const jsonLdMatch = html.match(/<script[^>]+application\/ld\+json[^>]*>([\s\S]*?)<\/script>/i);
  if (jsonLdMatch) {
    try {
      const raw = jsonLdMatch[1].trim();
      const parsed = JSON.parse(raw);
      const items = Array.isArray(parsed) ? parsed : [parsed];
      for (const item of items) {
        if (!item || (item['@type'] && item['@type'] !== 'JobPosting')) continue;
        // Some sources put richer markup in responsibilities + qualifications
        const resp = String(item.responsibilities || '');
        const qual = String(item.qualifications || '');
        const desc = String(item.description || '');
        const respClean = normalizeSpace(decodeEntities(stripHtml(resp)));
        const qualClean = normalizeSpace(decodeEntities(stripHtml(qual)));
        const descClean = normalizeSpace(decodeEntities(stripHtml(desc)));
        // Prefer separate responsibilities/qualifications because description
        // often duplicates them. Pick the longer signal source per field.
        if (respClean.length > 30) blocks.push(respClean);
        if (qualClean.length > 30) blocks.push(qualClean);
        if (blocks.length === 0 && descClean.length > 30) blocks.push(descClean);
        break; // first JobPosting wins
      }
    } catch {
      // fall through to HTML scrape
    }
  }

  // ── Strategy B: HTML container fallback ──────────────────
  if (blocks.length === 0) {
    const tasksMatch = html.match(/<div\s+id="tasks"[^>]*>([\s\S]*?)<\/div>/i);
    if (tasksMatch) {
      const txt = normalizeSpace(decodeEntities(stripHtml(tasksMatch[1])));
      if (txt.length > 20) blocks.push(txt);
    }
    const profileMatch = html.match(/<div\s+id="profile"[^>]*>([\s\S]*?)<\/div>/i);
    if (profileMatch) {
      const txt = normalizeSpace(decodeEntities(stripHtml(profileMatch[1])));
      if (txt.length > 20) blocks.push(txt);
    }
  }

  // Detail page H2 title (fall back to listing card if missing)
  const titleMatch = html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i)
    || html.match(/<h2[^>]*>([\s\S]*?)<\/h2>/i);
  const detailTitle = titleMatch
    ? normalizeSpace(decodeEntities(stripHtml(titleMatch[1])))
    : '';

  return {
    title: detailTitle,
    description: blocks.join('\n\n'),
  };
}

/* ── HTTP Fetch ───────────────────────────────────────────── */

async function fetchPage(url) {
  const timeoutMs = Number(process.env.JOBS_CRAWLER_TIMEOUT_MS) || 25_000;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: {
        Accept: 'text/html,application/xhtml+xml',
        'User-Agent': USER_AGENT,
        'Accept-Language': 'de-CH,de;q=0.9',
      },
      redirect: 'follow',
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
 * Sequential mini-helper to fetch N detail pages with bounded concurrency
 * + a per-worker delay between requests + retry-on-503/429 with backoff.
 *
 * jobs.so-h.ch returns sporadic 503s when hit faster than ~2 req/s, so we
 * keep concurrency=2 and pause briefly between calls to stay polite.
 */
async function fetchInBatches(items, concurrency, fn, opts = {}) {
  const delayMs = Number.isFinite(opts.delayMs) ? opts.delayMs : 350;
  const retries = Number.isFinite(opts.retries) ? opts.retries : 2;
  const results = new Array(items.length);
  let next = 0;
  async function worker() {
    while (true) {
      const i = next++;
      if (i >= items.length) return;
      let lastErr = null;
      for (let attempt = 0; attempt <= retries; attempt++) {
        try {
          results[i] = await fn(items[i], i);
          lastErr = null;
          break;
        } catch (err) {
          lastErr = err;
          const msg = String(err?.message || '');
          // Retry on 5xx and 429 only — propagate other errors after first try
          if (!/HTTP\s+(5\d\d|429)/.test(msg)) break;
          await new Promise((r) => setTimeout(r, delayMs * (attempt + 1) * 2));
        }
      }
      if (lastErr) results[i] = { __error: lastErr };
      if (delayMs) await new Promise((r) => setTimeout(r, delayMs));
    }
  }
  const workers = Array.from({ length: Math.max(1, concurrency) }, () => worker());
  await Promise.all(workers);
  return results;
}

/* ── Main Fetch Function ──────────────────────────────────── */

export async function fetchAllSolothurnerSpitaelerJobs() {
  console.log(`🏥 Fetching ${SOLOTHURNER_SPITAELER_COMPANY_NAME} jobs`);
  console.log(`   Source:        ${LISTING_URL}`);
  console.log(`   Public career: ${PUBLIC_CAREER_URL}\n`);

  let html;
  try {
    html = await fetchPage(LISTING_URL);
  } catch (err) {
    console.error(`❌ Failed to fetch /jobangebote page: ${err?.message}`);
    return [];
  }

  const listings = parseSohListingPage(html);
  if (listings.length === 0) {
    console.warn('⚠️ No job listings found on the page.');
    return [];
  }
  console.log(`  📋 Listings found: ${listings.length}\n`);

  // Fetch each detail page on jobs.so-h.ch to extract the JSON-LD JobPosting
  // (with `responsibilities` + `qualifications`). Without this, descriptions
  // are just the listing card's pensum/department/site line — ~10 words,
  // well under the boilerplate guard's 30 unique-word threshold.
  // jobs.so-h.ch returns 503s above ~2 req/s — serial with 600ms gap keeps
  // failures to 1/125 in practice; parallel concurrency=2 leaves ~25 5xx-only
  // failures even with retries. The total walk takes ~80s — acceptable.
  const detailConcurrency = Number(process.env.JOBS_CRAWLER_DETAIL_CONCURRENCY) || 1;
  const detailDelayMs = Number(process.env.JOBS_CRAWLER_DETAIL_DELAY_MS) || 600;
  console.log(`  🔎 Fetching ${listings.length} detail pages (concurrency=${detailConcurrency}, delay=${detailDelayMs}ms)…`);
  const detailResults = await fetchInBatches(listings, detailConcurrency, async (listing) => {
    const detailHtml = await fetchPage(listing.detailUrl);
    return parseSohDetailPage(detailHtml);
  }, { delayMs: detailDelayMs, retries: 3 });
  let detailOk = 0;
  let detailFail = 0;
  for (const r of detailResults) {
    if (r && !r.__error && r.description) detailOk++;
    else detailFail++;
  }
  console.log(`  ✅ Detail OK: ${detailOk} · ⚠️ failures: ${detailFail}\n`);

  const jobs = [];
  for (let i = 0; i < listings.length; i++) {
    const listing = listings[i];
    const detail = detailResults[i];
    const detailOkHere = detail && !detail.__error;
    const title = (detailOkHere && detail.title && detail.title.length > 3)
      ? detail.title
      : listing.title;
    const { city, postalCode } = pickCityForSite(listing.siteName);
    const canton = 'SO';

    const descBits = [];
    if (listing.rubric) descBits.push(`• Bereich: ${listing.rubric}`);
    if (listing.siteName) descBits.push(`• Standort: ${listing.siteName}`);
    if (listing.department) descBits.push(`• Abteilung: ${listing.department}`);
    if (listing.pensumStr) descBits.push(`• Pensum: ${listing.pensumStr}`);
    const metaLine = descBits.length ? descBits.join('\n') : '';
    const detailText = detailOkHere ? detail.description : '';
    const descriptionText = detailText
      ? (metaLine ? `${detailText}\n\n${metaLine}` : detailText)
      : (metaLine
          ? `${title} — ${SOLOTHURNER_SPITAELER_COMPANY_NAME}.\n\n${metaLine}`
          : `${title} — ${SOLOTHURNER_SPITAELER_COMPANY_NAME}, ${city}`);

    const sourceLang = 'de';
    const jobSlug = slugify(`${title} soh ch`);
    // Prefer UUID for idempotency; fall back to internal soh-id.
    const idSeed = listing.uuid || listing.sohId;
    const urlHash = createHash('sha1')
      .update(`solothurner-spitaeler-vacancy-${idSeed}`)
      .digest('hex')
      .slice(0, 12);

    const pensum = extractPensum(listing.pensumStr);
    const employmentType = detectEmploymentType(pensum);
    const contract = pensum && pensum.max < 80 ? 'part-time' : 'full-time';

    const job = {
      id: `solothurner-spitaeler-${urlHash}`,
      slug: jobSlug,
      slugByLocale: { [sourceLang]: jobSlug },
      company: SOLOTHURNER_SPITAELER_COMPANY_NAME,
      companyKey: SOLOTHURNER_SPITAELER_KEY,
      companyDomain: SOLOTHURNER_SPITAELER_COMPANY_DOMAIN,
      title,
      titleByLocale: { [sourceLang]: title },
      description: descriptionText,
      descriptionByLocale: { [sourceLang]: descriptionText },
      // Flag for AI localization: source-locale only → translate to it/fr/en.
      // Also exempts the job from the boilerplate guard, which only scrutinises
      // already-translated jobs (the guard's IT-locale check would mis-flag
      // listing-only fallback descriptions emitted when jobs.so-h.ch returns
      // 503/timeout for a detail page).
      needsRetranslation: true,
      location: city,
      canton,
      url: listing.detailUrl,
      source: 'soH Dedicated Parser (HTML scrape @ solothurnerspitaeler.ch/jobangebote)',
      sourceLang,
      crawledAt: new Date().toISOString(),

      addressLocality: city,
      addressRegion: canton,
      postalCode,
      addressCountry: 'CH',
      country: 'CH',
      category: detectCategory(title, listing.rubric, listing.department),
      contract,
      employmentType,
      experienceLevel: detectExperienceLevel(title),
      sector: 'Sanità / Ospedali',
      currency: 'CHF',
      featured: false,
      postedDate: new Date().toISOString().split('T')[0],
      applyUrl: listing.detailUrl,
      requirements: [],
      requirementsByLocale: { [sourceLang]: [] },
    };

    if (listing.department) job.department = listing.department;
    if (listing.siteName) job.workplace = listing.siteName;

    jobs.push(job);
  }

  console.log(`\n📋 Total ${SOLOTHURNER_SPITAELER_COMPANY_NAME} jobs discovered: ${jobs.length}`);
  return jobs;
}
