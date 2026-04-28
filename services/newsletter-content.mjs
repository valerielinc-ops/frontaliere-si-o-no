/**
 * Newsletter content — v2 (AI-powered personalization)
 *
 * Smart job matching based on subscriber location/sector interests.
 * AI prompt builders for personalized briefing and subject lines.
 * No more 3-variant system — every subscriber gets unique content.
 */

import fs from 'node:fs';
import path from 'node:path';

const BASE_URL = 'https://frontaliereticino.ch';

/** Mirror the build plugin's canonicalCompanySlug logic (slugify company name, not companyKey) */
function slugifyCompanyName(name) {
  return String(name || '').toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').trim();
}

let __dirname = '';
try {
  __dirname = path.dirname(new URL(import.meta.url).pathname);
} catch {
  // Browser environment — Node path module not available
}

// ─── Job matching ───────────────────────────────────────────

function toDateValue(job) {
  const raw = job?.postedDate || job?.crawledAt || '';
  const ts = raw ? new Date(raw).getTime() : 0;
  return Number.isFinite(ts) ? ts : 0;
}

function normalizeLocation(location) {
  const raw = String(location || '').trim();
  if (!raw) return 'Ticino';
  const zipMatch = raw.match(/\b\d{4}\b/);
  if (zipMatch) return raw.replace(zipMatch[0], '').replace(/\bWorking Area\b/gi, '').replace(/\s+/g, ' ').trim() || raw;
  return raw;
}

const CONTRACT_LABELS = {
  it: { part: 'Part-time', intern: 'Stage', appr: 'Apprendistato', temp: 'Tempo determinato', full: 'Tempo pieno', default: 'Annuncio attivo' },
  en: { part: 'Part-time', intern: 'Internship', appr: 'Apprenticeship', temp: 'Fixed-term', full: 'Full-time', default: 'Active listing' },
  de: { part: 'Teilzeit', intern: 'Praktikum', appr: 'Lehrstelle', temp: 'Befristet', full: 'Vollzeit', default: 'Aktive Stelle' },
  fr: { part: 'Temps partiel', intern: 'Stage', appr: 'Apprentissage', temp: 'Durée déterminée', full: 'Temps plein', default: 'Annonce active' },
};

function normalizeContract(contract, locale = 'it') {
  const labels = CONTRACT_LABELS[locale] || CONTRACT_LABELS.it;
  const value = String(contract || '').toLowerCase();
  if (value.includes('part')) return labels.part;
  if (value.includes('intern')) return labels.intern;
  if (value.includes('appr')) return labels.appr;
  if (value.includes('temp')) return labels.temp;
  if (value.includes('full')) return labels.full;
  return labels.default;
}

function dedupeBy(items, keyFn) {
  const seen = new Set();
  return items.filter((item) => {
    const key = keyFn(item);
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/**
 * Quality gate: returns true if a job has enough content for the newsletter.
 */
function passesQualityGate(job) {
  if (!job?.title || !job?.slug || !job?.company) return false;
  const desc = String(job.descriptionByLocale?.it || job.description || '');
  // No thin text — at least 120 chars of real content
  if (desc.length < 120) return false;
  // No broken HTML as first char
  if (desc.trim().startsWith('<')) return false;
  return true;
}

/**
 * Load job popularity data from data/job-popularity.json.
 * Returns a Map<slug, viewCount> or empty Map if unavailable.
 */
let _popularityCache = null;
function loadPopularity() {
  if (_popularityCache) return _popularityCache;
  try {
    const popPath = path.resolve(__dirname, '..', 'data', 'job-popularity.json');
    const data = JSON.parse(fs.readFileSync(popPath, 'utf-8'));
    _popularityCache = new Map(Object.entries(data).map(([k, v]) => [k, Number(v) || 0]));
    return _popularityCache;
  } catch {
    return new Map();
  }
}

/**
 * Sum job_views across every slug variant the job is known by:
 *   - canonical job.slug (usually = slugByLocale.it)
 *   - all locale variants in slugByLocale (en/de/fr versions diverge for ~98% of jobs)
 *   - all renames in previousSlugs and previousSlugsByLocale.{loc}
 *
 * Until trackJobView started writing under the canonical IT slug, the same job
 * could fragment into up to 4 separate Firestore docs (one per locale).
 * This helper reconciles the historical fragmentation at read time.
 */
export function getJobPopularityCount(job, popularity) {
  if (!popularity || popularity.size === 0 || !job) return 0;
  const seen = new Set();
  const add = (slug) => {
    if (slug && !seen.has(slug)) seen.add(slug);
  };
  add(job.slug);
  if (job.slugByLocale) {
    for (const loc of ['it', 'en', 'de', 'fr']) add(job.slugByLocale[loc]);
  }
  if (Array.isArray(job.previousSlugs)) {
    for (const s of job.previousSlugs) add(s);
  }
  if (job.previousSlugsByLocale) {
    for (const arr of Object.values(job.previousSlugsByLocale)) {
      if (Array.isArray(arr)) for (const s of arr) add(s);
    }
  }
  let total = 0;
  for (const slug of seen) total += popularity.get(slug) || 0;
  return total;
}

/**
 * Load real-time dashboard metrics for the newsletter.
 * Reads from existing data files (cached per process):
 *   - public/data/switzerland-unemployment-rate.json → unemployment rate
 *   - data/health-premiums/{year}.json (F2-A3 multi-year) with a fallback to
 *     the legacy flat `data/health-premiums.json` → Lugano LAMal premium
 *     (standard, adult 26+, franchise 2500).
 *
 * Franchise 2500 adjustment: -33% from base (franchise 300) premium.
 */
let _metricsCache = null;
export function loadDashboardMetrics() {
  if (_metricsCache) return _metricsCache;

  // Labels are intentionally NOT included here — the template renders them
  // via nlT(locale, 'metricUnemployment') / nlT(locale, 'metricLamal') so
  // they are localized per-recipient. Adding label fields would override
  // localization and bake Italian into every email.
  const metrics = {
    unemploymentRate: '2.8%',
    lamalPremium: 'CHF 467',
  };

  // ── Unemployment rate ──
  try {
    const unempPath = path.resolve(__dirname, '..', 'public', 'data', 'switzerland-unemployment-rate.json');
    const unempData = JSON.parse(fs.readFileSync(unempPath, 'utf-8'));
    if (unempData.rate && typeof unempData.rate === 'number') {
      metrics.unemploymentRate = `${unempData.rate}%`;
    }
  } catch {
    console.warn('⚠️  loadDashboardMetrics: unemployment data unavailable, using fallback');
  }

  // ── LAMal premium (Lugano, standard model, franchise 2500) ──
  try {
    // Prefer the F2-A3 year-scoped dataset, fall back to the legacy flat
    // path when the directory is not present (older deploys / tests).
    const currentYear = new Date().getUTCFullYear();
    const candidates = [
      path.resolve(__dirname, '..', 'data', 'health-premiums', `${currentYear}.json`),
      path.resolve(__dirname, '..', 'data', 'health-premiums.json'),
    ];
    let lamalData = null;
    for (const p of candidates) {
      try {
        if (fs.existsSync(p)) {
          lamalData = JSON.parse(fs.readFileSync(p, 'utf-8'));
          break;
        }
      } catch {
        // try next candidate
      }
    }
    if (!lamalData) throw new Error('no health-premiums dataset found');
    const lugano = lamalData.premiums['6823-Lugano'];
    if (lugano?.insurers) {
      let sum = 0;
      let count = 0;
      for (const models of Object.values(lugano.insurers)) {
        if (models.standard && typeof models.standard === 'number') {
          sum += models.standard;
          count++;
        }
      }
      if (count > 0) {
        // Base is franchise 300; apply -33% for franchise 2500
        const base = sum / count;
        const adjusted = Math.round(base * (1 - 0.33));
        metrics.lamalPremium = `CHF ${adjusted}`;
      }
    }
  } catch {
    console.warn('⚠️  loadDashboardMetrics: health premiums data unavailable, using fallback');
  }

  _metricsCache = metrics;
  return metrics;
}

// ─── Keyword extraction from job slugs / source strings ─────

const SLUG_STOP_WORDS = new Set([
  // IT connectives
  'il', 'lo', 'la', 'le', 'i', 'gli', 'un', 'uno', 'una', 'di', 'del', 'della',
  'dei', 'delle', 'dello', 'degli', 'da', 'dal', 'dalla', 'a', 'al', 'alla',
  'in', 'nel', 'nella', 'con', 'su', 'sul', 'sulla', 'per', 'tra', 'fra', 'e', 'o',
  // EN connectives
  'the', 'a', 'an', 'of', 'for', 'and', 'or', 'in', 'at', 'to', 'on', 'with', 'from',
  // DE connectives
  'der', 'die', 'das', 'ein', 'eine', 'und', 'oder', 'fur', 'von', 'mit', 'im', 'am',
  // FR connectives
  'le', 'la', 'les', 'un', 'une', 'de', 'du', 'des', 'et', 'ou', 'pour', 'dans', 'en',
  // Generic filler
  'sa', 'ag', 'gmbh', 'srl', 'spa', 'ltd', 'inc', 'se', 'che', 'non', 'trice',
  'm', 'f', 'd', 'mfd', 'w', 'h', 'hf',
]);

/**
 * Extract meaningful keywords from a slug or free-text source string.
 * Filters stop words and short tokens. Returns lowercase Set.
 */
function extractKeywords(text) {
  if (!text) return new Set();
  const tokens = String(text)
    .toLowerCase()
    .replace(/[^a-zà-ü0-9\s-]/g, '')
    .split(/[-\s]+/)
    .filter((t) => t.length >= 3 && !SLUG_STOP_WORDS.has(t));
  return new Set(tokens);
}

/**
 * Parse the legacy `source` field (e.g. "job_gate:CompanyName:Job Title Here")
 * into { company, title } for keyword extraction.
 */
function parseSourceField(source) {
  if (!source || typeof source !== 'string') return null;
  const parts = source.split(':');
  if (parts.length < 3) return null;
  return { company: parts[1]?.trim() || null, title: parts.slice(2).join(':').trim() || null };
}

/**
 * Score a job against a set of subscriber interest keywords.
 * Returns 0–10 relevance score.
 */
function keywordRelevanceScore(job, subscriberKeywords, subscriberCompany) {
  if (subscriberKeywords.size === 0 && !subscriberCompany) return 0;
  let score = 0;
  const jobTitle = String(job.titleByLocale?.it || job.title || '').toLowerCase();
  const jobCompanyKey = (job.companyKey || job.company || '').toLowerCase();

  // Company match: strong signal (same employer → highly relevant)
  if (subscriberCompany) {
    const subComp = subscriberCompany.toLowerCase();
    if (jobCompanyKey.includes(subComp) || subComp.includes(jobCompanyKey)) {
      score += 4;
    }
  }

  // Keyword overlap with job title
  if (subscriberKeywords.size > 0) {
    const jobTokens = extractKeywords(jobTitle);
    let overlap = 0;
    for (const kw of subscriberKeywords) {
      if (jobTokens.has(kw)) overlap++;
    }
    // Normalize: up to 6 points based on overlap ratio
    if (subscriberKeywords.size > 0 && overlap > 0) {
      score += Math.min(6, Math.round((overlap / subscriberKeywords.size) * 6));
    }
  }

  return score;
}

/**
 * Match jobs for a subscriber — relevance-first with popularity fallback.
 *
 * Algorithm:
 * 1. Quality filter (title, slug, company, description >= 120 chars)
 * 2. Extract interest keywords from subscriber's job_slug, source field, and company
 * 3. Score each job: keyword relevance (0–10) + popularity bonus
 * 4. Location filter (if locationInterest set)
 * 5. Company diversity: max 1 job per company
 * 6. Top `limit` jobs
 *
 * @param {object} subscriber — { locationInterest, sectorInterest, job_slug, job_company, source, preferences }
 * @param {object[]} jobs — Full jobs array from data/jobs.json
 * @param {number} limit — Max jobs to return (default 3)
 * @returns {object[]} — Matched jobs with title, url, company, location, contract
 */
/** Locale-specific job board URL path prefix */
const JOB_BOARD_PATH = {
  it: 'cerca-lavoro-ticino',
  en: 'en/find-jobs-ticino',
  de: 'de/jobs-im-tessin',
  fr: 'fr/trouver-emploi-tessin',
};

/** Build the locale-aware company page URL. Mirror build plugin canonicalCompanySlug. */
export function companyPageUrl(companySlug, locale = 'it') {
  if (!companySlug) return '';
  const boardPath = JOB_BOARD_PATH[locale] || JOB_BOARD_PATH.it;
  return `${BASE_URL}/${boardPath}/azienda-${companySlug}`;
}

export function matchJobsForSubscriber(subscriber, jobs, limit = 3, locale = 'it') {
  if (!jobs || jobs.length === 0) return [];

  const popularity = loadPopularity();
  const hasPopularity = popularity.size > 0;

  // Quality filter for popularity ranking; fallback pool keeps all valid jobs
  const qualityPool = jobs.filter(passesQualityGate);
  const basicPool = jobs.filter((j) => j?.title && j?.slug && j?.company);
  const pool = hasPopularity && qualityPool.length >= limit ? qualityPool : basicPool;

  // ── Build subscriber interest profile from available signals ──
  const jobSlug = subscriber?.job_slug || '';
  const jobCompany = subscriber?.job_company || '';
  const sourceField = subscriber?.source || '';

  // Collect keywords from multiple sources
  const slugKeywords = extractKeywords(jobSlug);
  const parsedSource = parseSourceField(sourceField);
  const sourceTitleKeywords = parsedSource?.title ? extractKeywords(parsedSource.title) : new Set();

  // Merge all keyword sources (slug is primary, source title is secondary)
  const subscriberKeywords = new Set([...slugKeywords, ...sourceTitleKeywords]);

  // Company from explicit field or parsed source
  const subscriberCompany = jobCompany || parsedSource?.company || '';

  const hasInterestProfile = subscriberKeywords.size > 0 || subscriberCompany;

  // ── Score and sort jobs ──
  const location = String(subscriber?.locationInterest || '').toLowerCase().trim();
  const sector = String(subscriber?.sectorInterest || '').toLowerCase().trim();
  const usableSector = sector && sector !== 'other';

  // Pre-filter by location if specified (applied before scoring for performance)
  let candidates = pool;
  if (location) {
    const locationFiltered = pool.filter((j) =>
      String(j.location || '').toLowerCase().includes(location) ||
      String(j.addressLocality || '').toLowerCase().includes(location) ||
      String(j.addressRegion || '').toLowerCase().includes(location) ||
      String(j.canton || '').toLowerCase().includes(location)
    );
    if (locationFiltered.length >= limit) candidates = locationFiltered;
  }

  // Further filter by sector only if it's not the generic "other"
  // Only apply if enough results remain to fill the requested limit
  if (usableSector) {
    const sectorFiltered = candidates.filter((j) =>
      String(j.title || '').toLowerCase().includes(sector) ||
      String(j.category || '').toLowerCase().includes(sector) ||
      String(j.sector || '').toLowerCase().includes(sector)
    );
    if (sectorFiltered.length >= limit) candidates = sectorFiltered;
  }

  // Sort: keyword relevance first, then popularity, then recency
  const scored = candidates.map((job) => {
    const relevance = hasInterestProfile ? keywordRelevanceScore(job, subscriberKeywords, subscriberCompany) : 0;
    const views = hasPopularity ? getJobPopularityCount(job, popularity) : 0;
    return { job, relevance, views, date: toDateValue(job) };
  });

  scored.sort((a, b) => {
    // Primary: relevance score (keyword + company match)
    if (b.relevance !== a.relevance) return b.relevance - a.relevance;
    // Secondary: popularity
    if (b.views !== a.views) return b.views - a.views;
    // Tertiary: recency
    return b.date - a.date;
  });

  // Company diversity: max 1 job per company (by companyKey or normalized company name)
  const companyKey = (j) => (j.companyKey || j.company || '').toLowerCase();
  const companyDiverse = dedupeBy(
    scored.map((s) => s.job),
    companyKey,
  );

  // Backfill: if location/sector filtering left too few diverse companies,
  // fill remaining slots from the full pool (excluding already-selected companies)
  let finalJobs = companyDiverse;
  if (companyDiverse.length < limit && candidates !== pool) {
    const usedCompanies = new Set(companyDiverse.map(companyKey));
    const backfillScored = pool
      .filter((j) => !usedCompanies.has(companyKey(j)))
      .map((job) => ({ job, views: hasPopularity ? getJobPopularityCount(job, popularity) : 0, date: toDateValue(job) }))
      .sort((a, b) => b.views - a.views || b.date - a.date);
    const backfill = dedupeBy(backfillScored.map((s) => s.job), companyKey);
    finalJobs = [...companyDiverse, ...backfill];
  }

  const boardPath = JOB_BOARD_PATH[locale] || JOB_BOARD_PATH.it;

  return finalJobs
    .slice(0, limit)
    .map((job) => {
      const slug = job.slugByLocale?.[locale] || job.slugByLocale?.it || job.slug;
      return {
        title: job.titleByLocale?.[locale] || job.titleByLocale?.it || job.title,
        url: `/${boardPath}/${slug}/`,
        company: job.company,
        companyKey: job.companyKey || '',
        location: normalizeLocation(job.location),
        contract: normalizeContract(job.contract, locale),
      };
    });
}

/**
 * Build a Set of known slugs from a jobs array.
 */
function buildSlugSet(jobs) {
  const slugs = new Set();
  for (const j of jobs) {
    if (j.slug) slugs.add(j.slug);
    if (j.slugByLocale) {
      for (const s of Object.values(j.slugByLocale)) {
        if (s) slugs.add(s);
      }
    }
  }
  return slugs;
}

/**
 * Validate matched job URLs against the set of known valid IT slugs.
 * Removes jobs whose slug doesn't exist in jobs.json (stale/deleted jobs).
 *
 * Resilience: if `allJobs` produces an empty slug set, falls back to reading
 * slugs directly from data/jobs.json. If still empty, skips validation entirely
 * so that matched jobs are never silently dropped.
 *
 * @param {object[]} matchedJobs — Output of matchJobsForSubscriber
 * @param {object[]} allJobs — Full jobs array from data/jobs.json
 * @returns {object[]} — Only jobs with valid, resolvable URLs
 */
export function validateJobUrls(matchedJobs, allJobs) {
  if (!matchedJobs || matchedJobs.length === 0) return [];

  let validSlugs = buildSlugSet(allJobs || []);

  // Resilience: if slug set is empty, skip validation — never silently drop all jobs
  if (validSlugs.size === 0) {
    console.warn('⚠️  validateJobUrls: no valid slugs available — skipping validation, returning all matched jobs');
    return matchedJobs;
  }

  const valid = [];
  const invalid = [];
  for (const job of matchedJobs) {
    const slug = job.url.replace(/^\/(cerca-lavoro-ticino|en\/find-jobs-ticino|de\/jobs-im-tessin|fr\/trouver-emploi-tessin)\//, '').replace(/\/$/, '');
    if (validSlugs.has(slug)) {
      valid.push(job);
    } else {
      invalid.push(job);
    }
  }

  if (invalid.length > 0) {
    console.warn(`⚠️  Newsletter URL validation: ${invalid.length} job(s) with unresolvable slugs removed:`);
    invalid.forEach((j) => console.warn(`   - ${j.title}: ${j.url}`));
  }

  return valid;
}

// ─── AI prompt builders ─────────────────────────────────────

const LOCALE_NAMES = { it: 'Italian', en: 'English', de: 'German', fr: 'French' };

/**
 * Build a prompt for AI to generate a personalized newsletter briefing.
 *
 * @param {object} ctx
 * @param {object} ctx.subscriber — { locale, preferences, locationInterest, sectorInterest, sourceChannel }
 * @param {object} ctx.exchangeRate — { rate, previousRate }
 * @param {object} ctx.exchangeInsight — { headline, summary, bestWeekday }
 * @param {Array}  ctx.matchedJobs — [{ title, company, location }]
 * @param {object} ctx.weeklyFact — { text, source }
 * @param {object} ctx.featuredTool — { title, description }
 * @returns {{ system: string, user: string }}
 */
export function buildBriefingPrompt(ctx) {
  const locale = ctx.subscriber?.locale || 'it';
  const langName = LOCALE_NAMES[locale] || 'Italian';
  const prefs = ctx.subscriber?.preferences || {};
  const interests = [];
  if (prefs.jobs) interests.push('job opportunities');
  if (prefs.taxUpdates || prefs.tax) interests.push('tax/fiscal updates');
  if (prefs.exchangeRate) interests.push('exchange rate');
  if (prefs.tips) interests.push('practical tips');
  if (prefs.traffic) interests.push('border traffic');

  // Provide the actual date so the AI never needs to invent one
  const todayStr = new Date().toLocaleDateString(locale === 'de' ? 'de-CH' : locale === 'fr' ? 'fr-CH' : locale === 'en' ? 'en-GB' : 'it-CH', {
    weekday: 'long', day: 'numeric', month: 'long', year: 'numeric',
  });

  // Compute weekly change using the SAME previousRate as the hero card
  // to avoid inconsistency between card percentage and AI briefing text
  const cardPct = ctx.exchangeRate && ctx.exchangeRate.previousRate > 0
    ? ((ctx.exchangeRate.rate - ctx.exchangeRate.previousRate) / ctx.exchangeRate.previousRate * 100)
    : 0;
  const cardPctStr = `${cardPct >= 0 ? '+' : ''}${cardPct.toFixed(1)}%`;

  const rateTrend = ctx.exchangeRate
    ? `CHF/EUR rate as of ${todayStr}: ${ctx.exchangeRate.rate.toFixed(4)} (previous week: ${ctx.exchangeRate.previousRate.toFixed(4)}, weekly change: ${cardPctStr})`
    : 'Exchange rate data unavailable';

  // Use card-consistent percentage in the insight line too
  const insightLine = ctx.exchangeInsight
    ? `Market insight: CHF/EUR ${cardPct > 0.2 ? 'strengthening' : cardPct < -0.2 ? 'weakening' : 'stable'} (${cardPctStr} weekly). ${ctx.exchangeInsight.summary}`
    : '';

  const jobLines = (ctx.matchedJobs || []).slice(0, 3)
    .map((j) => {
      const url = j.url ? `${BASE_URL}${j.url.startsWith('/') ? j.url : '/' + j.url}` : '';
      if (!url) return null; // Skip jobs without URLs — AI must not mention unlinkable jobs
      const postedInfo = j.postedDate || j.crawledAt || j.createdAt
        ? ` (posted: ${new Date(j.postedDate || j.crawledAt || j.createdAt).toLocaleDateString('it-CH')})`
        : '';
      const companySlug = j.company ? slugifyCompanyName(j.company) : '';
      const companyUrl = companyPageUrl(companySlug, locale);
      return `- ${j.title} at ${j.company} (${j.location})${postedInfo} → JOB_URL: ${url}${companyUrl ? ` | COMPANY_URL: ${companyUrl}` : ''}`;
    })
    .filter(Boolean)
    .join('\n');

  const factLine = ctx.weeklyFact
    ? `Weekly fact: "${ctx.weeklyFact.text}" (Source: ${ctx.weeklyFact.source || 'N/A'})`
    : '';

  const toolLine = ctx.featuredTool
    ? `Featured tool: ${ctx.featuredTool.title} — ${ctx.featuredTool.description}${ctx.featuredTool.toolUrl ? ` → URL: ${BASE_URL}${ctx.featuredTool.toolUrl}` : ''}`
    : '';

  const locationLine = ctx.subscriber?.locationInterest
    ? `Reader location interest: ${ctx.subscriber.locationInterest}`
    : '';

  const sectorLine = ctx.subscriber?.sectorInterest
    ? `Reader sector interest: ${ctx.subscriber.sectorInterest}`
    : '';

  // Locale-specific job-mention examples. Keeping the example phrasing in the
  // target language prevents the model from copying Italian phrasings like
  // "dai un'occhiata al ruolo di ... presso ... a Chiasso" verbatim into an
  // English/German/French email.
  const briefingExamplesByLocale = {
    it: `dai un'occhiata al ruolo di <a href="JOB_URL" style="color:#2563eb;text-decoration:underline;">Software Engineer</a> presso <a href="COMPANY_URL" style="color:#2563eb;text-decoration:underline;">Board International</a> a Chiasso`,
    en: `take a look at the <a href="JOB_URL" style="color:#2563eb;text-decoration:underline;">Software Engineer</a> role at <a href="COMPANY_URL" style="color:#2563eb;text-decoration:underline;">Board International</a> in Chiasso`,
    de: `schau dir die Stelle als <a href="JOB_URL" style="color:#2563eb;text-decoration:underline;">Software Engineer</a> bei <a href="COMPANY_URL" style="color:#2563eb;text-decoration:underline;">Board International</a> in Chiasso an`,
    fr: `jetez un œil au poste de <a href="JOB_URL" style="color:#2563eb;text-decoration:underline;">Software Engineer</a> chez <a href="COMPANY_URL" style="color:#2563eb;text-decoration:underline;">Board International</a> à Chiasso`,
  };
  const briefingExample = briefingExamplesByLocale[locale] || briefingExamplesByLocale.it;

  const system = [
    `You write the opening section of a weekly email newsletter for "Frontaliere Ticino", a platform for cross-border workers (frontalieri) between Italy and Switzerland.`,
    `Write in ${langName}. Be warm, conversational, and practical. Like a knowledgeable friend sharing useful updates.`,
    `ABSOLUTE LANGUAGE RULE: Every word in your output MUST be in ${langName}. ${locale === 'it' ? '' : `NEVER copy Italian phrasings from any reference material into your ${langName} output — use only natural ${langName} prepositions and verbs to introduce job mentions, company names, and city names. `}Tool names, brand names, and proper nouns are the only exceptions.`,
    `Output 2-3 short paragraphs. Use simple HTML ONLY: <p> tags for paragraphs, <strong> for emphasis, <a href="URL" style="color:#2563eb;text-decoration:underline;"> for links. No greetings, no sign-offs, no subject line.`,
    `CRITICAL: NEVER use Markdown syntax. Do NOT use **bold**, *italic*, [text](link), or any asterisks for emphasis. Always use the HTML tags above. Asterisks will render as literal characters in the email.`,
    `STRUCTURE RULE: First paragraph MUST mention 1-2 specific job opportunities with clickable hyperlinks. Second paragraph covers exchange rate context. Keep jobs EARLY — never push them to the end.`,
    `CRITICAL JOB LINKING RULE: Every job mention MUST have TWO hyperlinks: (1) the job title linked to JOB_URL, and (2) the company name linked to COMPANY_URL. Copy URLs exactly from the data. NEVER use <strong> for job titles or company names — ALWAYS use <a>. If a job has no URL, do NOT mention it. Example (in ${langName}): "${briefingExample}".`,
    `If a Featured tool name is provided, use it EXACTLY as written in the data — never translate, never substitute. The tool name comes pre-localized.`,
    `CRITICAL EXCHANGE RATE RULE: Use ONLY the weekly change percentage provided in the data below. Do NOT calculate or invent a different percentage.`,
    `Naturally weave in the exchange rate, any relevant job or fiscal context, and the weekly fact if interesting. Do NOT list everything — pick what matters most for this reader.`,
    `CRITICAL: Only mention dates that are explicitly provided in the data below. NEVER invent, guess, or assume dates for events, job postings, or facts. If no date is given for something, do not add one. Today's date is ${todayStr}.`,
    `Keep total length under 200 words. Be concise but engaging.`,
  ].join(' ');

  const userParts = [
    rateTrend,
    insightLine,
    jobLines ? `Matched jobs for this reader:\n${jobLines}` : 'No specific jobs matched',
    factLine,
    toolLine,
    locationLine,
    sectorLine,
    interests.length ? `Reader interests: ${interests.join(', ')}` : 'Reader interests: general',
  ].filter(Boolean);

  return { system, user: userParts.join('\n\n') };
}

/**
 * Build a prompt for AI to generate a personalized email subject line.
 *
 * @param {object} ctx
 * @param {object} ctx.subscriber — { locale, preferences, locationInterest }
 * @param {object} ctx.exchangeRate — { rate }
 * @param {Array}  ctx.matchedJobs — [{ title }]
 * @param {string} ctx.briefingSummary — First line of the AI briefing
 * @returns {{ system: string, user: string }}
 */
export function buildSubjectPrompt(ctx) {
  const locale = ctx.subscriber?.locale || 'it';
  const langName = LOCALE_NAMES[locale] || 'Italian';

  // Day of week for time-sensitive hooks
  const dayNames = { it: ['domenica','lunedì','martedì','mercoledì','giovedì','venerdì','sabato'], en: ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'], de: ['Sonntag','Montag','Dienstag','Mittwoch','Donnerstag','Freitag','Samstag'], fr: ['dimanche','lundi','mardi','mercredi','jeudi','vendredi','samedi'] };
  const today = (dayNames[locale] || dayNames.it)[new Date().getDay()];

  // Locale-specific subject examples. Keeping examples in the target language
  // prevents the model from drifting to Italian when locale != 'it'.
  const examplesByLocale = {
    it: [
      `- Curiosity gap: "⚡ Il tasso CHF scende: quanto perdi?"`,
      `- Number + location: "📊 3 aziende assumono a Lugano"`,
      `- Direct benefit: "💰 Simula il netto 2026 in 30 sec"`,
      `- Urgency/FOMO: "🔥 Scadenza fiscale: hai controllato?"`,
      `- Question hook: "🤔 Permesso G o B? Il calcolo che conta"`,
      `- News peg: "📰 ${today}: cosa cambia per i frontalieri"`,
    ],
    en: [
      `- Curiosity gap: "⚡ CHF rate is dropping: how much are you losing?"`,
      `- Number + location: "📊 3 companies hiring in Lugano"`,
      `- Direct benefit: "💰 Simulate your 2026 net pay in 30 sec"`,
      `- Urgency/FOMO: "🔥 Tax deadline: have you checked?"`,
      `- Question hook: "🤔 Permit G or B? The calc that matters"`,
      `- News peg: "📰 ${today}: what's changing for frontalieri"`,
    ],
    de: [
      `- Curiosity gap: "⚡ CHF-Kurs fällt: wie viel verlierst du?"`,
      `- Number + location: "📊 3 Firmen stellen in Lugano ein"`,
      `- Direct benefit: "💰 Nettolohn 2026 in 30 Sek berechnen"`,
      `- Urgency/FOMO: "🔥 Steuerfrist: schon geprüft?"`,
      `- Question hook: "🤔 Bewilligung G oder B? Die Rechnung zählt"`,
      `- News peg: "📰 ${today}: was sich für Grenzgänger ändert"`,
    ],
    fr: [
      `- Curiosity gap: "⚡ Le taux CHF baisse : combien tu perds ?"`,
      `- Number + location: "📊 3 entreprises recrutent à Lugano"`,
      `- Direct benefit: "💰 Simule ton net 2026 en 30 sec"`,
      `- Urgency/FOMO: "🔥 Échéance fiscale : t'as vérifié ?"`,
      `- Question hook: "🤔 Permis G ou B ? Le calcul qui compte"`,
      `- News peg: "📰 ${today} : ce qui change pour les frontaliers"`,
    ],
  };
  const examples = (examplesByLocale[locale] || examplesByLocale.it).join('\n');

  // Voice pronouns per locale to avoid "tu/you" instruction being misread
  const voiceByLocale = {
    it: `Use "tu" voice, never "noi"`,
    en: `Use "you" voice, never "we"`,
    de: `Use "du" voice, never "wir"`,
    fr: `Use "tu" voice, never "nous"`,
  };

  const system = [
    `You are a world-class email copywriter for "Frontaliere Ticino", a fintech app for Swiss-Italian cross-border workers.`,
    `Write ONE email subject line in ${langName}. STRICTLY 35-50 characters including emoji. Count carefully.`,
    `ABSOLUTE LANGUAGE RULE: The subject MUST be written in ${langName} — NOT Italian, NOT English, NOT any other language. If the target is ${langName} and you output Italian (or any other language), the output will be rejected. All example phrasings below are in ${langName} to make this unambiguous.`,
    ``,
    `PROVEN PATTERNS (pick one and adapt — stay in ${langName}):`,
    examples,
    ``,
    `RULES:`,
    `- Start with ONE emoji (⚡💰📊🔥🤔📰🏦💼)`,
    `- MUST be a complete phrase — NEVER end with "..." or a cut-off word`,
    `- ${voiceByLocale[locale] || voiceByLocale.it}`,
    `- NO exact numbers (exchange rates, percentages)`,
    `- NO generic words like "update", "newsletter", "weekly" or their ${langName} equivalents`,
    `- ONE hook only. Make the reader NEED to open the email.`,
    `- Output ONLY the subject line in ${langName}. No quotes, no translation, no explanation.`,
  ].join('\n');

  const hints = [];
  if (ctx.exchangeRate) {
    const pct = ctx.exchangeRate.previousRate
      ? ((ctx.exchangeRate.rate - ctx.exchangeRate.previousRate) / ctx.exchangeRate.previousRate * 100)
      : 0;
    const dir = pct > 0.1 ? 'strengthening' : pct < -0.1 ? 'weakening' : 'stable';
    hints.push(`CHF/EUR trend: ${dir} (${pct > 0 ? '+' : ''}${pct.toFixed(1)}%)`);
  }
  if (ctx.matchedJobs?.length) {
    const companies = [...new Set(ctx.matchedJobs.map(j => j.company))].slice(0, 3);
    hints.push(`Hot companies: ${companies.join(', ')}`);
    if (ctx.matchedJobs[0]?.location) hints.push(`Job location: ${ctx.matchedJobs[0].location}`);
  }
  if (ctx.subscriber?.locationInterest) hints.push(`Reader location: ${ctx.subscriber.locationInterest}`);
  if (ctx.briefingSummary) hints.push(`Theme: ${ctx.briefingSummary.slice(0, 80)}`);

  return { system, user: hints.join(' | ') || 'Generate a compelling subject for cross-border workers' };
}

/**
 * Fallback content when AI is unavailable.
 */
// Evergreen fallbacks — used when AI subject generation fails or returns degenerate
// output (empty, too short, emoji-only). Each MUST satisfy inlineQaCheck:
//   - 10 <= length <= 60
//   - no trailing "..." or "…"
//   - non-empty word content (catches all-emoji/all-punct edge cases)
// Validated by tests/newsletter-fallback-subjects.test.ts.
export const FALLBACK_SUBJECT = {
  it: '\u26a1 Frontaliere: cambio, lavoro, zero fuffa',
  en: '\u26a1 Frontaliere: rates, jobs, no fluff',
  de: '\u26a1 Frontaliere: Kurs, Jobs, kein Quatsch',
  fr: '\u26a1 Frontaliere: taux, emplois, z\u00e9ro blabla',
};

export function getFallbackBriefing(locale, exchangeRate) {
  const rate = exchangeRate?.rate?.toFixed(4) || '0.9420';
  const briefings = {
    it: `<p style="font-size:14px;color:#334155;line-height:1.65;margin:0 0 14px;">Ogni settimana ti dicono che "il mercato \u00e8 volatile" e che "bisogna stare attenti". Grazie, utilissimo. Come dire a uno che sta annegando che l\u2019acqua \u00e8 bagnata.</p><p style="font-size:14px;color:#334155;line-height:1.65;margin:0 0 14px;">Noi preferiamo i numeri. Quelli veri, quelli che trovi in busta paga. Questa settimana: il cambio \u00e8 a <strong>${rate}</strong>, e c\u2019\u00e8 una votazione che forse ti sei perso tra un cappuccino e la coda a Brogeda.</p>`,
    en: `<p style="font-size:14px;color:#334155;line-height:1.65;margin:0 0 14px;">Every week they tell you "the market is volatile". Thanks, very helpful. Like telling someone who's drowning that water is wet.</p><p style="font-size:14px;color:#334155;line-height:1.65;margin:0 0 14px;">We prefer numbers. Real ones, the kind you find on your payslip. This week: rate at <strong>${rate}</strong>.</p>`,
    de: `<p style="font-size:14px;color:#334155;line-height:1.65;margin:0 0 14px;">Jede Woche sagen sie dir, der Markt sei volatil. Danke, sehr hilfreich. Wie einem Ertrinkenden zu sagen, dass Wasser nass ist.</p><p style="font-size:14px;color:#334155;line-height:1.65;margin:0 0 14px;">Wir bevorzugen Zahlen. Echte Zahlen. Diese Woche: Kurs bei <strong>${rate}</strong>.</p>`,
    fr: `<p style="font-size:14px;color:#334155;line-height:1.65;margin:0 0 14px;">Chaque semaine on te dit que "le march\u00e9 est volatil". Merci, tr\u00e8s utile. Comme dire \u00e0 quelqu'un qui se noie que l'eau est mouill\u00e9e.</p><p style="font-size:14px;color:#334155;line-height:1.65;margin:0 0 14px;">Nous pr\u00e9f\u00e9rons les chiffres. Les vrais. Cette semaine : taux \u00e0 <strong>${rate}</strong>.</p>`,
  };
  return briefings[locale] || briefings.it;
}
