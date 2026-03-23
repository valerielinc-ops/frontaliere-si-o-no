/**
 * Newsletter content — v2 (AI-powered personalization)
 *
 * Smart job matching based on subscriber location/sector interests.
 * AI prompt builders for personalized briefing and subject lines.
 * No more 3-variant system — every subscriber gets unique content.
 */

const BASE_URL = 'https://frontaliereticino.ch';

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
 * Match jobs to a subscriber based on their location and sector interests.
 * Falls back to most recent jobs if no match.
 *
 * @param {object} subscriber — { locationInterest, sectorInterest, preferences }
 * @param {Array} jobs — Full jobs array from data/jobs.json
 * @param {number} limit — Max jobs to return (default 3)
 * @returns {Array<{ title, url, company, location }>}
 */
/**
 * Match jobs for a subscriber, ensuring only jobs with valid IT slugs are returned.
 * @param {object} subscriber — { locationInterest, sectorInterest, preferences }
 * @param {object[]} jobs — Full jobs array from data/jobs.json
 * @param {number} limit — Max jobs to return (default 3)
 * @returns {object[]} — Matched jobs with title, url, company, location, contract
 */
export function matchJobsForSubscriber(subscriber, jobs, limit = 3) {
  if (!jobs || jobs.length === 0) return [];

  const sorted = [...jobs]
    .filter((j) => j?.title && j?.slug && j?.company)
    .sort((a, b) => toDateValue(b) - toDateValue(a));

  const location = String(subscriber?.locationInterest || '').toLowerCase().trim();
  const sector = String(subscriber?.sectorInterest || '').toLowerCase().trim();

  let matched = sorted;

  // When no location filter, ensure canton diversity (mix TI + GR + VS)
  if (!location && sorted.length > limit) {
    const byCanton = {};
    for (const j of sorted) {
      const c = String(j.canton || j.addressRegion || '').toUpperCase() || 'OTHER';
      if (!byCanton[c]) byCanton[c] = [];
      byCanton[c].push(j);
    }
    const cantons = Object.keys(byCanton).sort((a, b) => byCanton[b].length - byCanton[a].length);
    if (cantons.length > 1) {
      const diverse = [];
      let round = 0;
      while (diverse.length < limit * 2 && round < 10) {
        for (const c of cantons) {
          if (byCanton[c][round]) diverse.push(byCanton[c][round]);
        }
        round++;
      }
      matched = diverse;
    }
  }

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

  return dedupeBy(matched, (j) => `${j.company}::${j.slug}`)
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
 * Validate matched job URLs against the set of known valid IT slugs.
 * Removes jobs whose slug doesn't exist in jobs.json (stale/deleted jobs).
 * @param {object[]} matchedJobs — Output of matchJobsForSubscriber
 * @param {object[]} allJobs — Full jobs array from data/jobs.json
 * @returns {object[]} — Only jobs with valid, resolvable URLs
 */
export function validateJobUrls(matchedJobs, allJobs) {
  // Build set of all known slugs (base + all locales)
  const validSlugs = new Set();
  for (const j of allJobs) {
    if (j.slug) validSlugs.add(j.slug);
    if (j.slugByLocale) {
      for (const s of Object.values(j.slugByLocale)) {
        if (s) validSlugs.add(s);
      }
    }
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
