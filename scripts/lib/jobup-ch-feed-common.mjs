#!/usr/bin/env node
/**
 * Shared helpers for Swiss employers that publish jobs via a jobup.ch feed
 * (the "company mask" pattern used by the Jalios JCMS PluginJobUp and several
 * other Romandie HR integrations).
 *
 * Feed URL convention:
 *   https://www.jobup.ch/masks/{KEY}/list_{KEY}.asp?cmd=json
 *
 * Response shape (JSON):
 *   {
 *     "jobcount": "7",
 *     "jobs": [
 *       {
 *         "titre":       "Apprenti agent d'exploitation CFC",
 *         "puddate":     "11/05/2026"           (DD/MM/YYYY),
 *         "lieu":        "1660 Château d'Oex"  (postal + city),
 *         "ref":         "Bâtiment / Construction" (category),
 *         "link":        "https://www.jobup.ch/fr/emplois/detail/{uuid}/",
 *         "canton":      "Riviera - Chablais"   (region label, not ISO),
 *         "contrat":     "PERMANENT" | ""       (employment contract),
 *         "occupationmin": "80",                 (numeric percent or empty),
 *         "occupationmax": "100%"                (numeric percent with optional %)
 *       }
 *     ]
 *   }
 *
 * Confirmed users (May 2026):
 *   - Pôle Santé Pays-d'Enhaut, Château-d'Oex (key `hpe`)
 *   - Étab. Hospitaliers Nord Vaudois, Yverdon (key `ehnv`)
 */
import { createHash } from 'node:crypto';
import { detectLang } from './dedicated-crawler-common.mjs';
import { slugify } from './crawler-template.mjs';
import { inferSwissTargetCanton } from './target-swiss-locations.mjs';

const USER_AGENT = process.env.JOBS_CRAWLER_USER_AGENT
  || 'Mozilla/5.0 (compatible; FrontaliereTicinoBot/1.0; +https://frontaliereticino.ch/)';

const NAMED_ENTITIES = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ',
  agrave: 'à', acirc: 'â', auml: 'ä', aring: 'å', atilde: 'ã', aacute: 'á',
  Agrave: 'À', Acirc: 'Â',
  eacute: 'é', egrave: 'è', ecirc: 'ê', euml: 'ë',
  Eacute: 'É', Egrave: 'È', Ecirc: 'Ê', Euml: 'Ë',
  iacute: 'í', igrave: 'ì', icirc: 'î', iuml: 'ï',
  oacute: 'ó', ograve: 'ò', ocirc: 'ô', ouml: 'ö',
  uacute: 'ú', ugrave: 'ù', ucirc: 'û', uuml: 'ü',
  ccedil: 'ç', Ccedil: 'Ç', oelig: 'œ', OElig: 'Œ',
  rsquo: '’', lsquo: '‘', rdquo: '”', ldquo: '“',
  hellip: '…', ndash: '–', mdash: '—', middot: '·',
};

function decodeEntitiesOnce(s) {
  return s
    .replace(/&([a-zA-Z]+);/g, (m, name) => Object.prototype.hasOwnProperty.call(NAMED_ENTITIES, name) ? NAMED_ENTITIES[name] : m)
    .replace(/&#(\d+);/g, (_, dec) => String.fromCodePoint(Number(dec)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex) => String.fromCodePoint(parseInt(hex, 16)));
}

/**
 * Decode HTML entities — repeats up to 3 times because jobup.ch's feed
 * sometimes double-encodes (returns `&amp;nbsp;` for what should be ` `).
 */
function decodeEntities(s = '') {
  let cur = String(s || '');
  for (let i = 0; i < 3; i++) {
    const next = decodeEntitiesOnce(cur);
    if (next === cur) return next;
    cur = next;
  }
  return cur;
}

function normalize(value = '') {
  return String(value || '').trim().toLowerCase();
}

function normalizeSpace(s = '') {
  return String(s || '').replace(/\s+/g, ' ').trim();
}

async function fetchFeed(url) {
  const timeoutMs = Number(process.env.JOBS_CRAWLER_TIMEOUT_MS) || 20000;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      headers: { Accept: 'application/json,text/javascript,*/*', 'User-Agent': USER_AGENT },
      signal: controller.signal,
    });
    clearTimeout(timer);
    if (!res.ok) throw new Error(`HTTP ${res.status} from ${url}`);
    const text = await res.text();
    // Some jobup masks wrap in a JSONP callback like `xCallback({...})`. Strip it.
    const trimmed = text.trim();
    const jsonpMatch = trimmed.match(/^[a-zA-Z_$][\w$]*\s*\(\s*([\s\S]+)\s*\)\s*;?\s*$/);
    const jsonText = jsonpMatch ? jsonpMatch[1] : trimmed;
    return JSON.parse(jsonText);
  } catch (err) {
    clearTimeout(timer);
    throw err;
  }
}

/**
 * Parse the postal code + city from the jobup `lieu` field.
 * Examples:
 *   "1660 Château d'Oex" → { postal: "1660", city: "Château d'Oex" }
 *   "1400 Yverdon-les-Bains" → { postal: "1400", city: "Yverdon-les-Bains" }
 *   "Lausanne" → { postal: "", city: "Lausanne" }
 */
export function parseJobupLieu(raw = '') {
  const decoded = decodeEntities(String(raw || ''));
  const m = decoded.match(/^\s*(\d{4})\s+(.+?)\s*$/);
  if (m) return { postal: m[1], city: normalizeSpace(m[2]) };
  return { postal: '', city: normalizeSpace(decoded) };
}

/**
 * Convert the jobup occupation range to an `employmentType` constant.
 *   "80" + "100%"  → PART_TIME (max < 90) ? no, max=100 → FULL_TIME
 *   "100" + "100%" → FULL_TIME
 *   "50" + "70%"   → PART_TIME
 */
export function detectEmploymentTypeFromOccupation(min = '', max = '') {
  const maxNum = parseInt(String(max).replace(/[^\d]/g, ''), 10);
  if (!Number.isFinite(maxNum)) return 'OTHER';
  if (maxNum >= 90) return 'FULL_TIME';
  if (maxNum > 0) return 'PART_TIME';
  return 'OTHER';
}

/**
 * Convert jobup DD/MM/YYYY to ISO YYYY-MM-DD.
 */
export function parseJobupDate(raw = '') {
  const m = String(raw || '').match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (!m) return '';
  const [, d, mo, y] = m;
  return `${y}-${mo.padStart(2, '0')}-${d.padStart(2, '0')}`;
}

function detectCategoryFromRef(ref = '', title = '') {
  const r = normalize(decodeEntities(ref).replace(/\s+/g, ' '));
  const t = normalize(title);
  if (/sant[éè]|m[ée]decine|soin|infirm|aide.soignant|asa|asse/.test(`${r} ${t}`)) return 'Sanità / Ospedali';
  if (/b[âa]timent|construct|travaux|technique|maintenan/.test(r)) return 'Tecnica';
  if (/informatique|it\b|software|d[ée]vel|programm/.test(r)) return 'IT';
  if (/administrat|secret|gestion|finance|compt/.test(r)) return 'Amministrazione';
  if (/rh\b|ressources humaines|human resources|personnel/.test(r)) return 'Risorse Umane';
  if (/cuisine|restauration|h[ôo]tel|gastronom/.test(r)) return 'Ospitalità';
  if (/logistique|achat|transport|magasin/.test(r)) return 'Logistica';
  if (/marketing|communication/.test(r)) return 'Marketing';
  if (/apprenti|stage|stagiair|formation/.test(r)) return 'Formazione';
  return 'Sanità / Ospedali'; // default for healthcare employers
}

function detectExperienceLevel(title = '', contrat = '') {
  const t = normalize(title);
  if (/\b(apprenti|stage|stagiair|intern)\b/.test(t)) return 'intern';
  if (/contrat d'apprentissage/i.test(contrat)) return 'intern';
  if (/\b(junior|assistant)\b/.test(t)) return 'junior';
  if (/\b(senior|chef|responsable|directeur|directrice|cadre|encadrant)\b/.test(t)) return 'senior';
  return 'mid';
}

/**
 * Fetch a jobup.ch detail page and extract the JobPosting description from
 * the embedded JSON-LD structured data block. jobup.ch publishes complete
 * `JobPosting` schema with `description` (HTML) — far richer than the feed's
 * `ref` category text.
 */
export async function fetchJobupDetailDescription(detailUrl) {
  const timeoutMs = Number(process.env.JOBS_CRAWLER_TIMEOUT_MS) || 20000;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(detailUrl, {
      headers: { Accept: 'text/html', 'User-Agent': USER_AGENT },
      signal: controller.signal,
      redirect: 'follow',
    });
    clearTimeout(timer);
    if (!res.ok) return '';
    const html = await res.text();
    // Extract every <script type="application/ld+json"> block and look for JobPosting
    const blocks = html.match(/<script[^>]+type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/g) || [];
    for (const block of blocks) {
      const payload = block.replace(/^<script[^>]+>/, '').replace(/<\/script>$/, '').trim();
      try {
        const data = JSON.parse(payload);
        const items = Array.isArray(data) ? data : [data];
        for (const item of items) {
          if (item?.['@type'] === 'JobPosting' && item?.description) {
            // description is HTML; strip tags and decode entities
            const text = String(item.description)
              .replace(/<br\s*\/?>/gi, '\n')
              .replace(/<li[^>]*>/gi, '\n• ')
              .replace(/<\/(p|div|li|h[1-6])>/gi, '\n')
              .replace(/<[^>]+>/g, ' ');
            return decodeEntities(text).replace(/\n{3,}/g, '\n\n').replace(/ {2,}/g, ' ').trim();
          }
        }
      } catch {
        // skip malformed JSON-LD blocks
      }
    }
    return '';
  } catch {
    clearTimeout(timer);
    return '';
  }
}

/**
 * Create a jobup.ch feed parser for one employer.
 *
 * @param {Object} config
 * @param {string} config.companyKey         Internal slug, e.g. 'pole-sante-pays-enhaut'
 * @param {string} config.companyName        Display name
 * @param {string} config.companyDomain      Corporate domain (e.g. 'pspe.ch')
 * @param {string} config.jobupKey           jobup.ch mask key (e.g. 'hpe')
 * @param {string} config.defaultCanton      ISO canton code (e.g. 'VD')
 * @param {string} config.defaultCity        Fallback city
 * @param {string} config.defaultPostalCode  Fallback postal code
 * @param {string} [config.publicCareerUrl]  Corporate career page URL
 * @param {string} [config.defaultSourceLang='fr']
 */
export function createJobupChFeedParser(config) {
  const {
    companyKey,
    companyName,
    companyDomain,
    jobupKey,
    defaultCanton,
    defaultCity,
    defaultPostalCode,
    publicCareerUrl,
    defaultSourceLang = 'fr',
  } = config;

  if (!companyKey || !companyName || !jobupKey || !defaultCanton) {
    throw new Error('createJobupChFeedParser: missing required config');
  }

  const FEED_URL = `https://www.jobup.ch/masks/${jobupKey}/list_${jobupKey}.asp?cmd=json`;
  const corporateHost = String(companyDomain || '').replace(/^www\./, '').toLowerCase();

  function isCompanyJob(job) {
    const key = normalize(job?.companyKey || '');
    const company = normalize(job?.company || '');
    const url = normalize(job?.url || '');
    if (key === companyKey) return true;
    if (corporateHost && (company.includes(corporateHost.split('.')[0]) || url.includes(corporateHost))) return true;
    if (url.includes(`/masks/${jobupKey}/`)) return true;
    return false;
  }

  function isTrustedDomain(rawUrl = '') {
    try {
      const host = new URL(rawUrl).hostname.toLowerCase();
      if (host === 'www.jobup.ch' || host === 'jobup.ch') return true;
      if (corporateHost && (host === corporateHost || host.endsWith(`.${corporateHost}`))) return true;
      return false;
    } catch {
      return false;
    }
  }

  async function fetchAllJobs() {
    console.log(`🏥 Fetching ${companyName} jobs`);
    console.log(`   Feed: ${FEED_URL}`);
    if (publicCareerUrl) console.log(`   Public: ${publicCareerUrl}`);
    console.log();

    const payload = await fetchFeed(FEED_URL);
    const items = Array.isArray(payload?.jobs) ? payload.jobs : [];
    const totalReported = parseInt(String(payload?.jobcount || items.length), 10) || items.length;
    console.log(`  ✓ ${items.length} jobs (jobcount=${totalReported})`);
    if (items.length > 0) console.log(`  📄 Fetching jobup.ch detail pages for rich descriptions...`);

    if (!items.length) return [];

    const todayIso = new Date().toISOString().slice(0, 10);
    const jobs = [];
    const seenLinks = new Set();
    let detailHits = 0;

    for (const raw of items) {
      const link = normalizeSpace(raw?.link || '');
      if (!link) continue;
      if (seenLinks.has(link)) continue;
      seenLinks.add(link);

      const title = normalizeSpace(decodeEntities(raw?.titre || ''));
      if (!title || title.length < 3) continue;

      const lieu = parseJobupLieu(raw?.lieu || '');
      const location = lieu.city || defaultCity;
      const canton = inferSwissTargetCanton(location) || defaultCanton;
      const postalCode = lieu.postal || defaultPostalCode;

      // Fetch detail page for rich description (JSON-LD JobPosting)
      const detailDescription = await fetchJobupDetailDescription(link);
      if (detailDescription) detailHits++;
      await new Promise((r) => setTimeout(r, 250));

      const description = detailDescription || normalizeSpace(
        [
          decodeEntities(raw?.ref || ''),
          raw?.contrat ? `Contrat : ${decodeEntities(raw.contrat)}` : '',
          raw?.occupationmin && raw?.occupationmax
            ? `Taux : ${String(raw.occupationmin)}-${String(raw.occupationmax).replace(/[^\d]/g, '')}%`
            : '',
        ].filter(Boolean).join(' · '),
      ) || `${title} — ${companyName}`;

      const sourceLang = detectLang(description || title, defaultSourceLang);
      const jobSlug = slugify(`${title} ${companyKey} ${location}`);
      const urlHash = createHash('sha1').update(link).digest('hex').slice(0, 12);
      const postedDate = parseJobupDate(raw?.puddate || '') || todayIso;

      jobs.push({
        id: `${companyKey}-${urlHash}`,
        slug: jobSlug,
        slugByLocale: { [sourceLang]: jobSlug },
        company: companyName,
        companyKey,
        companyDomain,
        title,
        titleByLocale: { [sourceLang]: title },
        description,
        descriptionByLocale: { [sourceLang]: description },
        // Newly-discovered jobs ship with source-locale-only fields. The shared
        // AI-localization step clears this flag when it fills the remaining 3
        // locales; if it can't (cache miss + AI quota), the flag stays and
        // `translate-pending.yml` picks the job up out-of-band. Without this
        // flag the locale-completeness gate trips before translation can run.
        needsRetranslation: true,
        location,
        canton,
        url: link,
        source: `${companyName} Dedicated Parser (jobup.ch feed ${jobupKey})`,
        sourceLang,
        crawledAt: new Date().toISOString(),

        addressLocality: location,
        addressRegion: canton,
        addressCountry: 'CH',
        country: 'CH',
        postalCode,
        category: detectCategoryFromRef(raw?.ref || '', title),
        contract: /permanent/i.test(raw?.contrat || '') ? 'full-time'
          : /temporaire|cdd|fixed/i.test(raw?.contrat || '') ? 'temporary'
          : 'full-time',
        employmentType: detectEmploymentTypeFromOccupation(raw?.occupationmin, raw?.occupationmax),
        experienceLevel: detectExperienceLevel(title, raw?.contrat || ''),
        sector: 'Sanità / Ospedali',
        currency: 'CHF',
        featured: false,
        postedDate,
        applyUrl: link,
        requirements: [],
        requirementsByLocale: { [sourceLang]: [] },
      });
    }

    console.log(`\n📋 Total ${companyName} jobs discovered: ${jobs.length} (${detailHits}/${items.length} with rich detail content)`);
    return jobs;
  }

  return { fetchAllJobs, isCompanyJob, isTrustedDomain };
}

export { decodeEntities };
