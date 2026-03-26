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
const __dirname = path.dirname(new URL(import.meta.url).pathname);

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

function normalizeContract(contract) {
  const value = String(contract || '').toLowerCase();
  if (value.includes('part')) return 'Part-time';
  if (value.includes('intern')) return 'Stage';
  if (value.includes('appr')) return 'Apprendistato';
  if (value.includes('temp')) return 'Tempo determinato';
  if (value.includes('full')) return 'Tempo pieno';
  return 'Annuncio attivo';
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
 * Load real-time dashboard metrics for the newsletter.
 * Reads from existing data files (cached per process):
 *   - public/data/switzerland-unemployment-rate.json → unemployment rate
 *   - data/health-premiums.json → Lugano LAMal premium (standard, adult 26+, franchise 2500)
 *
 * Franchise 2500 adjustment: -33% from base (franchise 300) premium.
 */
let _metricsCache = null;
export function loadDashboardMetrics() {
  if (_metricsCache) return _metricsCache;

  const metrics = {
    unemploymentRate: '2.8%',
    unemploymentLabel: 'Disoccupazione CH',
    lamalPremium: 'CHF 467',
    lamalLabel: 'Premio LAMal Lugano',
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
    const lamalPath = path.resolve(__dirname, '..', 'data', 'health-premiums.json');
    const lamalData = JSON.parse(fs.readFileSync(lamalPath, 'utf-8'));
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

/**
 * Match jobs for a subscriber — popularity-first with company diversity and quality filters.
 *
 * Algorithm:
 * 1. Quality filter (title, slug, company, description >= 120 chars)
 * 2. Sort by popularity (Firestore view count), fallback to recency
 * 3. Company diversity: max 1 job per company
 * 4. Top `limit` jobs
 *
 * @param {object} subscriber — { locationInterest, sectorInterest, preferences }
 * @param {object[]} jobs — Full jobs array from data/jobs.json
 * @param {number} limit — Max jobs to return (default 3)
 * @returns {object[]} — Matched jobs with title, url, company, location, contract
 */
export function matchJobsForSubscriber(subscriber, jobs, limit = 3) {
  if (!jobs || jobs.length === 0) return [];

  const popularity = loadPopularity();
  const hasPopularity = popularity.size > 0;

  // Quality filter for popularity ranking; fallback pool keeps all valid jobs
  const qualityPool = jobs.filter(passesQualityGate);
  const basicPool = jobs.filter((j) => j?.title && j?.slug && j?.company);
  // Use quality pool when we have popularity data; otherwise basic pool (recency mode)
  const pool = hasPopularity && qualityPool.length >= limit ? qualityPool : basicPool;

  // Sort: popularity first (if available), then recency as tiebreaker
  const sorted = [...pool].sort((a, b) => {
    if (hasPopularity) {
      const aViews = popularity.get(a.slug) || popularity.get(a.slugByLocale?.it) || 0;
      const bViews = popularity.get(b.slug) || popularity.get(b.slugByLocale?.it) || 0;
      if (bViews !== aViews) return bViews - aViews;
    }
    return toDateValue(b) - toDateValue(a);
  });

  const location = String(subscriber?.locationInterest || '').toLowerCase().trim();
  const sector = String(subscriber?.sectorInterest || '').toLowerCase().trim();

  let matched = sorted;

  // Filter by location if specified
  if (location) {
    const locationFiltered = sorted.filter((j) =>
      String(j.location || '').toLowerCase().includes(location) ||
      String(j.addressRegion || '').toLowerCase().includes(location) ||
      String(j.canton || '').toLowerCase().includes(location) ||
      String(j.company || '').toLowerCase().includes(location)
    );
    if (locationFiltered.length >= limit) matched = locationFiltered;
  }

  // Further filter by sector if specified
  if (sector) {
    const sectorFiltered = matched.filter((j) =>
      String(j.title || '').toLowerCase().includes(sector) ||
      String(j.category || '').toLowerCase().includes(sector) ||
      String(j.company || '').toLowerCase().includes(sector)
    );
    if (sectorFiltered.length >= 1) matched = sectorFiltered;
  }

  // Company diversity: max 1 job per company (by companyKey or normalized company name)
  const companyDiverse = dedupeBy(matched, (j) => (j.companyKey || j.company || '').toLowerCase());

  return companyDiverse
    .slice(0, limit)
    .map((job) => {
      const itSlug = job.slugByLocale?.it || job.slug;
      return {
        title: job.titleByLocale?.it || job.title,
        url: `/cerca-lavoro-ticino/${itSlug}/`,
        company: job.company,
        location: normalizeLocation(job.location),
        contract: normalizeContract(job.contract),
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
    const slug = job.url.replace(/^\/cerca-lavoro-ticino\//, '').replace(/\/$/, '');
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

  const rateTrend = ctx.exchangeRate
    ? `CHF/EUR rate as of ${todayStr}: ${ctx.exchangeRate.rate.toFixed(4)} (previous: ${ctx.exchangeRate.previousRate.toFixed(4)})`
    : 'Exchange rate data unavailable';

  const insightLine = ctx.exchangeInsight
    ? `Market insight: ${ctx.exchangeInsight.headline}. ${ctx.exchangeInsight.summary}`
    : '';

  const jobLines = (ctx.matchedJobs || []).slice(0, 3)
    .map((j) => {
      const url = j.url ? `${BASE_URL}${j.url.startsWith('/') ? j.url : '/' + j.url}` : '';
      const postedInfo = j.postedDate || j.crawledAt || j.createdAt
        ? ` (posted: ${new Date(j.postedDate || j.crawledAt || j.createdAt).toLocaleDateString('it-CH')})`
        : '';
      return url
        ? `- ${j.title} at ${j.company} (${j.location})${postedInfo} → URL: ${url}`
        : `- ${j.title} at ${j.company} (${j.location})${postedInfo}`;
    })
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

  const system = [
    `You write the opening section of a weekly email newsletter for "Frontaliere Ticino", a platform for cross-border workers (frontalieri) between Italy and Switzerland.`,
    `Write in ${langName}. Be warm, conversational, and practical. Like a knowledgeable friend sharing useful updates.`,
    `Output 2-3 short paragraphs. Use simple HTML: <p> tags for paragraphs, <strong> for emphasis, <a href="URL" style="color:#2563eb;text-decoration:underline;"> for links. No greetings, no sign-offs, no subject line.`,
    `When you mention a job position that has a URL, hyperlink ONLY the job title — keep company and location as plain text. Example: "un ruolo di <a href="https://frontaliereticino.ch/cerca-lavoro-ticino/software-engineer/" style="color:#2563eb;text-decoration:underline;">Software Engineer</a> presso Board International a Chiasso". For site tools with a URL, hyperlink only the tool name the same way.`,
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

  const system = [
    `Generate a single email subject line for the weekly "Frontaliere Ticino" newsletter.`,
    `Write in ${langName}. Max 55 characters. Be specific and personal — mention a concrete number, place, or fact.`,
    `Do NOT use generic phrases like "Weekly update" or "Newsletter". Make it feel like news, not marketing.`,
    `Output ONLY the subject line, nothing else. No quotes, no explanation.`,
  ].join(' ');

  const hints = [];
  if (ctx.exchangeRate) hints.push(`CHF/EUR: ${ctx.exchangeRate.rate.toFixed(4)}`);
  if (ctx.matchedJobs?.[0]) hints.push(`Top job: ${ctx.matchedJobs[0].title}`);
  if (ctx.subscriber?.locationInterest) hints.push(`Location: ${ctx.subscriber.locationInterest}`);
  if (ctx.briefingSummary) hints.push(`Briefing starts with: ${ctx.briefingSummary.slice(0, 100)}`);

  return { system, user: hints.join(' | ') || 'Generate a compelling subject for cross-border workers' };
}

/**
 * Fallback content when AI is unavailable.
 */
export const FALLBACK_SUBJECT = {
  it: '\u26a1 Il tuo luned\u00ec da frontaliere: cambio, lavoro e zero fuffa',
  en: '\u26a1 Your Monday briefing: rates, jobs, zero fluff',
  de: '\u26a1 Dein Montags-Briefing: Kurs, Stellen, kein Bl\u00f6dsinn',
  fr: '\u26a1 Ton lundi de frontalier : taux, emplois, z\u00e9ro blabla',
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
