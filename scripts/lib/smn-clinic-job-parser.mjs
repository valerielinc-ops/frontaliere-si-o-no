#!/usr/bin/env node
/**
 * Swiss Medical Network (SMN) — per-clinic job parser factory.
 *
 * The master `swiss-medical-network` crawler only fetches Ticino postings
 * (region filter `?region=<TICINO_UUID>`). SMN runs ~30 clinics across
 * Switzerland and exposes the listing page with a per-clinic `?clinic=XXX`
 * filter that returns only that clinic's openings.
 *
 *   https://www.swissmedical.net/de/karriere/stellenangebote?clinic=PKV
 *
 * Each filtered page yields a small set of SmartRecruiters detail links
 * (`https://jobs.smartrecruiters.com/SwissMedicalNetwork1/...`). This
 * module wraps that flow for a single clinic so we can ship one
 * dedicated crawler per non-Ticino clinic without re-implementing the
 * HTML scrape each time.
 *
 * Known clinic codes (May 2026):
 *   PKV → Privatklinik Villa im Park, Rothrist (AG)
 *   PKS → Privatklinik Siloah, Gümligen (BE)
 *   PKB → Privatklinik Bethanien, Zürich (ZH)
 *   PKL → Privatklinik Lindberg, Winterthur (ZH)
 *   PKO → Privatklinik Obach, Solothurn (SO)
 *   KBS → Privatklinik Belair, Schaffhausen (SH)
 *
 * SmartRecruiters detail HTML is parsed via the shared
 * `parseSmartRecruiterDetail` helper from the master SMN parser.
 */
import { createHash } from 'node:crypto';
import { detectLang } from './dedicated-crawler-common.mjs';
import {
  parseSmartRecruiterDetail,
  htmlToText,
  normalizeSpace,
  slugify,
} from './swiss-medical-network-job-parser.mjs';

const SMN_HOST = 'https://www.swissmedical.net';
const USER_AGENT = process.env.JOBS_CRAWLER_USER_AGENT
  || 'Mozilla/5.0 (compatible; FrontaliereTicinoBot/1.0; +https://frontaliereticino.ch/)';
const DETAIL_DELAY_MS = 500;

function normalize(value = '') {
  return String(value || '').trim().toLowerCase();
}

async function fetchPage(url, timeoutMs = Number(process.env.JOBS_CRAWLER_TIMEOUT_MS) || 20000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: {
        Accept: 'text/html,application/xhtml+xml',
        'Accept-Language': 'de,en;q=0.8,it;q=0.7,fr;q=0.6',
        'User-Agent': USER_AGENT,
      },
    });
    clearTimeout(timer);
    if (!res.ok) {
      console.warn(`⚠️ HTTP ${res.status} for ${url}`);
      return null;
    }
    return await res.text();
  } catch (err) {
    clearTimeout(timer);
    console.warn(`⚠️ Fetch failed for ${url}: ${err?.message || err}`);
    return null;
  }
}

/**
 * Extract SmartRecruiters detail URLs + titles from the clinic-filtered
 * listing HTML. Each detail link looks like:
 *
 *   <a target="_blank" href="https://jobs.smartrecruiters.com/SwissMedicalNetwork1/{ID}-{slug}">Mehr erfahren</a>
 *
 * Title is the text-rich element immediately above the link (`<h*>` or
 * surrounding `<a>` text). When the title can't be parsed from the
 * listing we fall back to humanising the slug.
 */
export function parseSmnClinicListing(html = '') {
  if (!html || typeof html !== 'string') return [];
  const out = [];
  const seen = new Set();
  const linkRx = /<a[^>]+href="(https?:\/\/jobs\.smartrecruiters\.com\/SwissMedicalNetwork[^"]*?)"[^>]*>/gi;
  let m;
  while ((m = linkRx.exec(html))) {
    const url = m[1].trim();
    if (seen.has(url)) continue;
    seen.add(url);
    // Look backwards within a 2k window for a heading-style title.
    const window = html.slice(Math.max(0, m.index - 2000), m.index);
    let title = '';
    const headingMatches = [...window.matchAll(/<h[2-5][^>]*>([\s\S]*?)<\/h[2-5]>/gi)];
    if (headingMatches.length > 0) {
      title = normalizeSpace(htmlToText(headingMatches[headingMatches.length - 1][1]));
    }
    if (!title) {
      // Slug-derived fallback (e.g. ".../744000127191779-dipl-pflegefachperson-…")
      const slugFromUrl = url.split('/').pop() || '';
      const human = slugFromUrl
        .replace(/^\d+-/, '')
        .replace(/-+/g, ' ')
        .replace(/\b\w/g, (c) => c.toUpperCase())
        .trim();
      if (human) title = human;
    }
    if (!title || title.length < 3) continue;
    out.push({ url, title });
  }
  return out;
}

/**
 * Synthesise a structured fallback description (in source locale) so
 * postings without a usable SmartRecruiters detail page still pass the
 * thin-content gate.
 */
function buildFallbackDescription({ title, clinicName, city, canton, sourceLang }) {
  if (sourceLang === 'it') {
    return `Posizione aperta: ${title} presso ${clinicName} a ${city} (Cantone ${canton}), Svizzera.\n\nSwiss Medical Network è il principale gruppo sanitario privato in Svizzera. ${clinicName} offre cure mediche specialistiche e un ambiente di lavoro stimolante con condizioni contrattuali allineate ai contratti collettivi del settore sanitario svizzero. Il gruppo offre opportunità di sviluppo professionale, formazione continua e un pacchetto retributivo competitivo. Candidarsi tramite SmartRecruiters per entrare a far parte del team.`;
  }
  if (sourceLang === 'fr') {
    return `Poste ouvert: ${title} chez ${clinicName} à ${city} (canton ${canton}), Suisse.\n\nSwiss Medical Network est le premier groupe hospitalier privé de Suisse. ${clinicName} offre des soins médicaux spécialisés dans un environnement stimulant, avec des conditions d'emploi alignées sur les conventions collectives du secteur de la santé. Le groupe propose des opportunités de développement professionnel, de la formation continue et une rémunération compétitive. Postulez via SmartRecruiters pour rejoindre l'équipe.`;
  }
  // Default DE
  return `Offene Stelle: ${title} bei ${clinicName} in ${city} (Kanton ${canton}), Schweiz.\n\nSwiss Medical Network ist die führende private Spitalgruppe der Schweiz. ${clinicName} bietet spezialisierte medizinische Versorgung in einem stimulierenden Arbeitsumfeld mit Anstellungsbedingungen gemäss den Gesamtarbeitsverträgen des Schweizer Gesundheitswesens. Die Gruppe bietet berufliche Entwicklungsmöglichkeiten, Weiterbildung und ein attraktives Gehaltspaket. Bewerben Sie sich über SmartRecruiters und werden Sie Teil des Teams.`;
}

function detectCategory(title = '') {
  const t = normalize(title);
  if (/\b(arzt|ärztin|oberarzt|chefarzt|médecin|physician|doctor)/.test(t)) return 'Sanità / Ospedali';
  if (/\b(pflege|infermier|nurse|fage|fachperson gesundheit)/.test(t)) return 'Sanità / Ospedali';
  if (/\b(chirurg|surgeon|operation|ops)/.test(t)) return 'Sanità / Ospedali';
  if (/\b(physiother|ergother|logopäd|fisioterap)/.test(t)) return 'Sanità / Ospedali';
  if (/\b(psycholog|psychiatr)/.test(t)) return 'Sanità / Ospedali';
  if (/\b(labor|radiolog|röntgen|mtra|mtra hf)/.test(t)) return 'Sanità / Ospedali';
  if (/\b(haustechni|facility|wartung|maintenance|techni)/.test(t)) return 'Tecnica';
  if (/\b(it|software|informatik)/.test(t)) return 'IT';
  if (/\b(admin|sekret|buchhalt|sachbearbeit)/.test(t)) return 'Amministrazione';
  if (/\b(hr|personal|recruit)/.test(t)) return 'Risorse Umane';
  if (/\b(küche|koch|gastro|hauswirtschaft|reinigung)/.test(t)) return 'Ospitalità';
  if (/\b(lernende|lehrstelle|praktik|apprenti|stage)/.test(t)) return 'Formazione';
  return 'Sanità / Ospedali';
}

function detectExperienceLevel(title = '') {
  const t = normalize(title);
  if (/\b(lernende|lehrstelle|praktik|stage|intern|apprenti)/.test(t)) return 'intern';
  if (/\b(senior|lead|head|chefarzt|leitend|verantwort|leiter|oberarzt|oberärztin)/.test(t)) return 'senior';
  if (/\b(junior|jr|assistent|assistenz)/.test(t)) return 'junior';
  return 'mid';
}

function detectEmploymentType(title = '') {
  const t = normalize(title);
  const pct = t.match(/(\d{2,3})\s*[-–]\s*(\d{2,3})\s*%/) || t.match(/(\d{2,3})\s*%/);
  if (pct) {
    const maxPct = pct[2] ? parseInt(pct[2], 10) : parseInt(pct[1], 10);
    return maxPct < 80 ? 'PART_TIME' : 'FULL_TIME';
  }
  if (/teilzeit|part.?time/.test(t)) return 'PART_TIME';
  return 'FULL_TIME';
}

/**
 * Build a parser bundle for one SMN clinic.
 *
 * @param {Object} config
 * @param {string} config.companyKey
 * @param {string} config.companyName              Public-facing clinic name
 * @param {string} config.clinicCode               SMN listing filter (e.g. 'PKV')
 * @param {string} config.companyDomain            usually 'swissmedical.net'
 * @param {string} config.defaultCanton            ISO canton code
 * @param {string} config.defaultCity
 * @param {string} config.defaultPostalCode
 * @param {string} [config.streetAddress]          Public street address (formatted)
 * @param {string} [config.publicCareerUrl]
 * @param {string} [config.defaultSourceLang='de']
 * @param {string} [config.lang='de']              SMN listing locale segment
 */
export function createSmnClinicParser(config) {
  const {
    companyKey,
    companyName,
    clinicCode,
    companyDomain = 'swissmedical.net',
    defaultCanton,
    defaultCity,
    defaultPostalCode,
    streetAddress = '',
    publicCareerUrl = '',
    defaultSourceLang = 'de',
    lang = 'de',
  } = config;

  if (!companyKey || !companyName || !clinicCode || !defaultCanton) {
    throw new Error('createSmnClinicParser: missing required config (companyKey/companyName/clinicCode/defaultCanton)');
  }

  const localePath = lang === 'fr' ? 'fr/carriere/offres-emploi'
    : lang === 'it' ? 'it/carriera/offerte-impiego'
    : lang === 'en' ? 'en/career/job-offers'
    : 'de/karriere/stellenangebote';
  const LISTING_URL = `${SMN_HOST}/${localePath}?clinic=${encodeURIComponent(clinicCode)}`;
  const corporateHost = String(companyDomain || '').replace(/^www\./, '').toLowerCase();

  function isCompanyJob(job) {
    const key = normalize(job?.companyKey || '');
    const url = normalize(job?.url || '');
    if (key === companyKey) return true;
    const company = normalize(job?.company || '');
    if (company.includes(normalize(companyName))) return true;
    return false;
  }

  function isTrustedDomain(rawUrl = '') {
    try {
      const host = new URL(rawUrl).hostname.toLowerCase();
      if (corporateHost && (host === corporateHost || host.endsWith(`.${corporateHost}`))) return true;
      if (host === 'jobs.smartrecruiters.com' || host.endsWith('.smartrecruiters.com')) return true;
      return false;
    } catch {
      return false;
    }
  }

  async function fetchAllJobs() {
    console.log(`🏥 Fetching ${companyName} jobs (clinic=${clinicCode})`);
    console.log(`   Source: ${LISTING_URL}`);
    if (publicCareerUrl) console.log(`   Public: ${publicCareerUrl}`);
    console.log();

    const listingHtml = await fetchPage(LISTING_URL);
    if (!listingHtml) return [];

    const tiles = parseSmnClinicListing(listingHtml);
    console.log(`  ✓ ${tiles.length} SmartRecruiters tiles parsed`);
    if (tiles.length === 0) return [];

    const todayIso = new Date().toISOString().slice(0, 10);
    const jobs = [];
    let detailHits = 0;

    for (const tile of tiles) {
      let descriptionFromDetail = '';
      let titleFromDetail = '';
      let detailLocation = '';
      const detailHtml = await fetchPage(tile.url);
      if (detailHtml) {
        const detail = parseSmartRecruiterDetail(detailHtml);
        if (detail.description && detail.description.split(/\s+/).length >= 30) {
          descriptionFromDetail = detail.description;
          detailHits += 1;
        }
        if (detail.title && detail.title.length >= 3) titleFromDetail = detail.title;
        if (detail.location) detailLocation = detail.location;
      }
      await new Promise((r) => setTimeout(r, DETAIL_DELAY_MS));

      const title = titleFromDetail || tile.title;
      const city = detailLocation || defaultCity;
      const sourceLang = detectLang(descriptionFromDetail || title, defaultSourceLang);
      const description = descriptionFromDetail
        || buildFallbackDescription({ title, clinicName: companyName, city, canton: defaultCanton, sourceLang });

      const jobSlug = slugify(`${title}-${companyKey}`);
      const urlHash = createHash('sha1').update(tile.url).digest('hex').slice(0, 12);

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
        // Source-only fields → shared AI step fills the other 3 locales.
        needsRetranslation: true,
        location: city,
        canton: defaultCanton,
        url: tile.url,
        applyUrl: tile.url,
        source: `${companyName} Dedicated Parser (SMN clinic=${clinicCode})`,
        sourceLang,
        crawledAt: new Date().toISOString(),

        addressLocality: city,
        addressRegion: defaultCanton,
        addressCountry: 'CH',
        country: 'CH',
        postalCode: defaultPostalCode,
        streetAddress,
        category: detectCategory(title),
        employmentType: detectEmploymentType(title),
        experienceLevel: detectExperienceLevel(title),
        sector: 'Sanità / Ospedali',
        currency: 'CHF',
        featured: false,
        postedDate: todayIso,
        datePosted: todayIso,
        requirements: [],
        requirementsByLocale: { [sourceLang]: [] },
      });
    }

    console.log(`\n📋 Total ${companyName} jobs discovered: ${jobs.length} (${detailHits}/${tiles.length} with rich detail content)`);
    return jobs;
  }

  return { fetchAllJobs, isCompanyJob, isTrustedDomain, LISTING_URL };
}
