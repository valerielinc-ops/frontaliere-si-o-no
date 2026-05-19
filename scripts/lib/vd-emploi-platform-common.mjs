#!/usr/bin/env node
/**
 * Shared helpers for the VD/GE "emploi.*" Next.js career platform.
 *
 * Used by hospitals that publish jobs via a custom Next.js careers app with
 * a public `/api/offers` JSON endpoint. Confirmed on:
 *   - emploi.ehc-vd.ch          → EHC Ensemble hospitalier de la Côte (VD)
 *   - emploi.hopitalrivierachablais.ch → HRC (VD)
 *   - emploi.hopital-broye.ch   → HIB (VD/FR)
 *   - recrutement.latour.ch     → Hôpital de La Tour (GE)
 *
 * Two response shapes observed:
 *   1. Array of offers directly: `[{ id, title, slug, content, ... }, ...]`
 *   2. Wrapped object:            `{ offers: [...], nbOfOffersPerPage: N }`
 *
 * Each offer carries:
 *   - id (number), requisitionId (number)
 *   - title (string)
 *   - slug (string)          → detail URL = `${baseUrl}/nos-offres/${slug}`
 *   - dateFrom (ISO date)
 *   - content (HTML)
 *   - job: { id, title }     → category
 *   - information: [ { id, label, value, filterValue, location }, ... ]
 *
 * The `information` array exposes structured facets that change per hospital
 * (e.g. `type-contrat`, `lieu-de-travail`, `taux-d-activite`).  We normalise
 * the most useful ones (workplace, contract, occupation rate) when present.
 */
import { createHash } from 'node:crypto';
import { detectLang } from './dedicated-crawler-common.mjs';
import { slugify, stripHtml } from './crawler-template.mjs';
import { inferSwissTargetCanton } from './target-swiss-locations.mjs';

const USER_AGENT = process.env.JOBS_CRAWLER_USER_AGENT
  || 'Mozilla/5.0 (compatible; FrontaliereTicinoBot/1.0; +https://frontaliereticino.ch/)';

function normalize(value = '') {
  return String(value || '').trim().toLowerCase();
}

function normalizeSpace(s = '') {
  return String(s || '').replace(/\s+/g, ' ').trim();
}

/**
 * Decode HTML named entities that `stripHtml` from crawler-template.mjs
 * doesn't cover (accented French letters, typographic punctuation, etc.).
 * Applied AFTER stripHtml so it operates on plain text.
 */
const NAMED_ENTITIES = {
  rsquo: '’', lsquo: '‘', rdquo: '”', ldquo: '“',
  hellip: '…', ndash: '–', mdash: '—', middot: '·',
  laquo: '«', raquo: '»',
  agrave: 'à', acirc: 'â', auml: 'ä', aring: 'å', atilde: 'ã', aacute: 'á',
  Agrave: 'À', Acirc: 'Â', Auml: 'Ä', Aring: 'Å',
  eacute: 'é', egrave: 'è', ecirc: 'ê', euml: 'ë',
  Eacute: 'É', Egrave: 'È', Ecirc: 'Ê', Euml: 'Ë',
  iacute: 'í', igrave: 'ì', icirc: 'î', iuml: 'ï',
  Iacute: 'Í', Icirc: 'Î', Iuml: 'Ï',
  oacute: 'ó', ograve: 'ò', ocirc: 'ô', ouml: 'ö', otilde: 'õ',
  Oacute: 'Ó', Ocirc: 'Ô', Ouml: 'Ö',
  uacute: 'ú', ugrave: 'ù', ucirc: 'û', uuml: 'ü',
  Uacute: 'Ú', Ucirc: 'Û', Uuml: 'Ü',
  ccedil: 'ç', Ccedil: 'Ç',
  ntilde: 'ñ', Ntilde: 'Ñ',
  szlig: 'ß', euro: '€', pound: '£', yen: '¥',
  oelig: 'œ', OElig: 'Œ', aelig: 'æ', AElig: 'Æ',
  copy: '©', reg: '®', trade: '™', deg: '°',
  iexcl: '¡', iquest: '¿',
};

function decodeEntities(text = '') {
  return String(text || '')
    .replace(/&([a-zA-Z]+);/g, (m, name) => Object.prototype.hasOwnProperty.call(NAMED_ENTITIES, name) ? NAMED_ENTITIES[name] : m)
    .replace(/&#(\d+);/g, (_, dec) => {
      const n = Number(dec);
      return Number.isFinite(n) && n > 0 && n < 0x10ffff ? String.fromCodePoint(n) : '';
    })
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex) => {
      const n = parseInt(hex, 16);
      return Number.isFinite(n) && n > 0 && n < 0x10ffff ? String.fromCodePoint(n) : '';
    });
}

async function fetchOffersJson(apiUrl) {
  const timeoutMs = Number(process.env.JOBS_CRAWLER_TIMEOUT_MS) || 20000;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(apiUrl, {
      headers: { Accept: 'application/json', 'User-Agent': USER_AGENT },
      signal: controller.signal,
    });
    clearTimeout(timer);
    if (!res.ok) throw new Error(`HTTP ${res.status} from ${apiUrl}`);
    const payload = await res.json();
    if (Array.isArray(payload)) return payload;
    if (Array.isArray(payload?.offers)) return payload.offers;
    return [];
  } catch (err) {
    clearTimeout(timer);
    throw err;
  }
}

function pickInformationValue(offer, infoId) {
  const list = Array.isArray(offer?.information) ? offer.information : [];
  const entry = list.find((it) => normalize(it?.id) === normalize(infoId));
  return entry ? normalizeSpace(entry.value || '') : '';
}

function detectCategory(title = '', jobCat = '') {
  const t = normalize(`${title} ${jobCat}`);
  if (/\b(pflege|pflegefach|stationsleitung|fage|spitex|nachtwache|geburts|hebamme|infirmi|soin|aide.soignant|asa|asse)/.test(t)) return 'Sanità / Ospedali';
  if (/\b(arzt|ärztin|oberarzt|chefarzt|leitend|médecin|medecin|cadre|chirurg|anesth|onco|cardio|neuro|gynéc|gyneco|psychi|pédiatr|pediatr)/.test(t)) return 'Sanità / Ospedali';
  if (/\b(labor|laborant|biomedizin|analyse|radiolog|röntgen|mtra|tra|physiother|physio|ergo|logopéd|logoped|rehabilit|apothek|pharmac)/.test(t)) return 'Sanità / Ospedali';
  if (/\b(techni|haustechni|facility|wartung|maintenance|maintenan)/.test(t)) return 'Tecnica';
  if (/\b(it|software|develop|programm|system|informatik|informati)/.test(t)) return 'IT';
  if (/\b(admin|secret|segret|buchhalt|sachbearbeiter|finanz|controll|account|compt|comptab)/.test(t)) return 'Amministrazione';
  if (/\b(hr|human|personal|talent|recruit|rh)/.test(t)) return 'Risorse Umane';
  if (/\b(küche|koch|gastro|hauswirt|reinigung|hotellerie|cuisine|restaur|hôtel|hotel)/.test(t)) return 'Ospitalità';
  if (/\b(logist|magazz|lager|einkauf|transport|achat)/.test(t)) return 'Logistica';
  if (/\b(market|kommunik|communic)/.test(t)) return 'Marketing';
  if (/\b(lernend|praktik|ausbildung|apprenti|stage|stagiaire)/.test(t)) return 'Formazione';
  return 'Sanità / Ospedali';
}

function detectExperienceLevel(title = '') {
  const t = normalize(title);
  if (/\b(praktik|stage|stagiaire|intern|lehrling|lernend|apprenti)/.test(t)) return 'intern';
  if (/\b(junior|jr|assistent|assistant)/.test(t)) return 'junior';
  if (/\b(senior|sr|lead|head|director|chef|verantwort|leiter|leitend|stationsleitung|oberarzt|chefarzt|responsable|cadre)/.test(t)) return 'senior';
  return 'mid';
}

function detectEmploymentType(rateText = '') {
  const t = normalize(rateText);
  if (!t) return 'OTHER';
  // Common patterns: "100%", "80-100%", "50%", "50% à 80%", "Temps plein", "Temps partiel"
  const pcts = (t.match(/(\d{1,3})\s*%/g) || []).map((m) => Number(m.replace(/[^\d]/g, '')));
  const max = pcts.length ? Math.max(...pcts) : 0;
  if (/temps plein|vollzeit|tempo pieno|full.time/.test(t) || max >= 90) return 'FULL_TIME';
  if (/temps partiel|teilzeit|tempo parziale|part.time/.test(t) || (max > 0 && max < 90)) return 'PART_TIME';
  return 'OTHER';
}

/**
 * Build a parser instance for one hospital using the shared platform.
 *
 * @param {Object} config
 * @param {string} config.companyKey         e.g. 'ehc-vd'
 * @param {string} config.companyName        e.g. 'Ensemble hospitalier de la Côte (EHC)'
 * @param {string} config.companyDomain      e.g. 'ehc-vd.ch'
 * @param {string} config.baseUrl            e.g. 'https://emploi.ehc-vd.ch'
 * @param {string} config.defaultCanton      ISO canton code (e.g. 'VD')
 * @param {string} config.defaultCity        Fallback city
 * @param {string} config.defaultPostalCode  Fallback postal code
 * @param {string} [config.defaultSourceLang='fr']
 * @param {string} [config.sourceLabel]      Source string for ParsedJob
 * @returns {{
 *   fetchAllJobs: () => Promise<ParsedJob[]>,
 *   isCompanyJob: (job: any) => boolean,
 *   isTrustedDomain: (url: string) => boolean,
 * }}
 */
export function createVdEmploiPlatformParser(config) {
  const {
    companyKey,
    companyName,
    companyDomain,
    baseUrl,
    defaultCanton,
    defaultCity,
    defaultPostalCode,
    defaultSourceLang = 'fr',
    sourceLabel,
  } = config;

  if (!companyKey || !companyName || !baseUrl || !defaultCanton) {
    throw new Error('createVdEmploiPlatformParser: missing required config');
  }

  const apiUrl = `${baseUrl.replace(/\/+$/, '')}/api/offers`;
  const careerHost = new URL(baseUrl).hostname.toLowerCase();
  const corporateHost = String(companyDomain || '').replace(/^www\./, '').toLowerCase();

  function isCompanyJob(job) {
    const key = normalize(job?.companyKey || '');
    const company = normalize(job?.company || '');
    const url = normalize(job?.url || '');
    if (key === companyKey) return true;
    if (corporateHost && (company.includes(corporateHost.split('.')[0]) || url.includes(corporateHost))) return true;
    if (careerHost && url.includes(careerHost)) return true;
    return false;
  }

  function isTrustedDomain(rawUrl = '') {
    try {
      const host = new URL(rawUrl).hostname.toLowerCase();
      if (careerHost && (host === careerHost || host.endsWith(`.${careerHost}`))) return true;
      if (corporateHost && (host === corporateHost || host.endsWith(`.${corporateHost}`))) return true;
      return false;
    } catch {
      return false;
    }
  }

  async function fetchAllJobs() {
    console.log(`🏥 Fetching ${companyName} jobs`);
    console.log(`   Source: ${apiUrl}\n`);

    const offers = await fetchOffersJson(apiUrl);
    if (!offers.length) {
      console.warn(`⚠️ No job offers returned from ${apiUrl}.`);
      return [];
    }
    console.log(`  ✓ ${offers.length} offers from /api/offers`);

    const jobs = [];
    for (const offer of offers) {
      const title = normalizeSpace(offer?.title || '');
      if (!title || title.length < 3) continue;
      const slug = normalizeSpace(offer?.slug || '');
      if (!slug) continue;

      const publicUrl = `${baseUrl.replace(/\/+$/, '')}/nos-offres/${encodeURIComponent(slug)}`;
      const descriptionText = decodeEntities(stripHtml(offer?.content || ''));
      const decodedTitle = decodeEntities(title);
      const sourceLang = detectLang(descriptionText || decodedTitle, defaultSourceLang);

      // Pull structured facets from the `information` array if present.
      // Field IDs observed on EHC/HRC/HIB/La Tour:
      //   - `cust-lieu-city`   → Ville (city) — preferred for `location`
      //   - `lieu-travail`     → Site / Lieu de travail (often a site name like "Hôpital de Morges")
      //   - `type-contrat`     → Type de contrat
      //   - `taux-occupation`  → Taux (e.g. "100%", "80-100%")
      const cityRaw = pickInformationValue(offer, 'cust-lieu-city')
        || pickInformationValue(offer, 'ville')
        || pickInformationValue(offer, 'city');
      const workplaceRaw = pickInformationValue(offer, 'lieu-travail')
        || pickInformationValue(offer, 'lieu-de-travail')
        || pickInformationValue(offer, 'workplace')
        || pickInformationValue(offer, 'site');
      const contractRaw = pickInformationValue(offer, 'type-contrat')
        || pickInformationValue(offer, 'type-de-contrat')
        || pickInformationValue(offer, 'contract');
      const rateRaw = pickInformationValue(offer, 'taux-occupation')
        || pickInformationValue(offer, 'taux-d-activite')
        || pickInformationValue(offer, 'taux-activite')
        || pickInformationValue(offer, 'pensum');
      const jobCategoryRaw = normalizeSpace(offer?.job?.title || pickInformationValue(offer, 'job') || '');

      // Prefer explicit city facet; fall back to workplace only if it looks like
      // a real city name (not the hospital's own brand string like "Hôpital de La Tour").
      const workplaceLooksLikeCity = workplaceRaw
        && !/(h[oô]pital|spital|clinique|klinik|ospedale|clinic|ehpad|ems\b)/i.test(workplaceRaw);
      const location = decodeEntities(cityRaw || (workplaceLooksLikeCity ? workplaceRaw : '') || defaultCity);
      const canton = inferSwissTargetCanton(location) || defaultCanton;

      const postedDate = (() => {
        const raw = offer?.dateFrom || offer?.publishedDate || '';
        const d = new Date(String(raw || ''));
        if (!Number.isNaN(d.getTime())) return d.toISOString().slice(0, 10);
        return new Date().toISOString().slice(0, 10);
      })();

      const jobSlug = slugify(`${decodedTitle} ${companyKey} ${location}`);
      const urlHash = createHash('sha1').update(publicUrl).digest('hex').slice(0, 12);

      const job = {
        id: `${companyKey}-${urlHash}`,
        slug: jobSlug,
        slugByLocale: { [sourceLang]: jobSlug },
        company: companyName,
        companyKey,
        companyDomain,
        title: decodedTitle,
        titleByLocale: { [sourceLang]: decodedTitle },
        description: descriptionText || `${decodedTitle} — ${companyName}`,
        descriptionByLocale: { [sourceLang]: descriptionText || `${decodedTitle} — ${companyName}` },
        // Newly-discovered jobs ship with source-locale-only fields. The shared
        // AI-localization step clears this flag when it fills the remaining 3
        // locales; if it can't (cache miss + AI quota), the flag stays and
        // `translate-pending.yml` picks the job up out-of-band. Without this
        // flag the locale-completeness gate trips before translation can run.
        needsRetranslation: true,
        location,
        canton,
        url: publicUrl,
        source: sourceLabel || `${companyName} Dedicated Parser (VD emploi platform)`,
        sourceLang,
        crawledAt: new Date().toISOString(),

        addressLocality: location,
        addressRegion: canton,
        addressCountry: 'CH',
        country: 'CH',
        postalCode: defaultPostalCode,
        category: detectCategory(title, jobCategoryRaw),
        contract: contractRaw && /partiel|teil|parz|part/.test(contractRaw.toLowerCase()) ? 'part-time' : 'full-time',
        employmentType: detectEmploymentType(rateRaw),
        experienceLevel: detectExperienceLevel(title),
        sector: 'Sanità / Ospedali',
        currency: 'CHF',
        featured: false,
        postedDate,
        applyUrl: publicUrl,
        requirements: [],
        requirementsByLocale: { [sourceLang]: [] },
      };

      jobs.push(job);
    }

    console.log(`\n📋 Total ${companyName} jobs discovered: ${jobs.length}`);
    return jobs;
  }

  return { fetchAllJobs, isCompanyJob, isTrustedDomain };
}
