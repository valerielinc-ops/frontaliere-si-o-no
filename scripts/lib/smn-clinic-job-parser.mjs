#!/usr/bin/env node
/**
 * Swiss Medical Network (SMN) — per-clinic job parser factory.
 *
 * SMN runs ~30 clinics across Switzerland on a single SmartRecruiters
 * tenant (`SwissMedicalNetwork1`). This factory builds one dedicated
 * parser per non-Ticino clinic (the master `swiss-medical-network`
 * crawler owns the Ticino postings).
 *
 * SOURCE (July 2026): the public SmartRecruiters postings API —
 *
 *   https://api.smartrecruiters.com/v1/companies/SwissMedicalNetwork1/postings
 *
 * Each posting carries a `department` whose label is the clinic name
 * (e.g. "Privatklinik Siloah", "Hôpital de Moutier"), which is what we
 * filter on. The same label is mirrored in the "Department" custom field.
 *
 * HISTORY: this factory used to scrape the swissmedical.net listing page
 * with a per-clinic `?clinic=XXX` query (e.g. `?clinic=PKS`) and extract
 * `jobs.smartrecruiters.com/SwissMedicalNetwork1/...` detail links from
 * the server-rendered HTML. In July 2026 SMN re-mapped those clinic codes
 * to ATS "Brands" (e.g. `MZB` no longer means Hôpital de Moutier — it now
 * selects "Medizinisches Zentrum Biel", whose postings are branded
 * "Réseau de l'Arc" and therefore render zero tiles). Several clinics
 * silently returned 0 jobs (issues #3857, #3859). The postings API is the
 * source of truth feeding that page, so we consume it directly — same
 * approach as the master SMN crawler and via the shared
 * `ats-clients/smartrecruiters-client.mjs`.
 *
 * The legacy `clinicCode` is kept in the config for the public listing
 * URL (`?clinic=XXX`) and the `source` string only — it is NOT used for
 * filtering anymore.
 *
 * Clinic attribution:
 *   - a posting matches when its department label equals one of
 *     `departmentLabels` (default: `[companyName]`), compared
 *     case/diacritic/punctuation-insensitively;
 *   - additionally, network-wide departments listed in
 *     `cityScopedDepartmentLabels` (e.g. "Réseau de l'Arc" for Hôpital
 *     de Moutier) match only when the posting's city is the clinic's
 *     own `defaultCity`, so shared-brand postings at the clinic's site
 *     are attributed to it without swallowing the whole network.
 */
import { createHash } from 'node:crypto';
import { detectLang } from './dedicated-crawler-common.mjs';
import {
  SMN_SR_COMPANY_ID,
  extractSmnApiDescription,
  normalizeSpace,
  slugify,
} from './swiss-medical-network-job-parser.mjs';
import { fetchSmartRecruitersJobs } from './ats-clients/smartrecruiters-client.mjs';

const SMN_HOST = 'https://www.swissmedical.net';
const SR_PUBLIC_JOBS_BASE = 'https://jobs.smartrecruiters.com';

function normalize(value = '') {
  return String(value || '').trim().toLowerCase();
}

/**
 * Normalise a clinic/department label for comparison: lowercase, strip
 * diacritics, collapse punctuation/whitespace runs to single spaces.
 * "Clinique Générale-Beaulieu" → "clinique generale beaulieu".
 */
export function normalizeClinicLabel(value = '') {
  return String(value || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/**
 * Collect the department labels a posting is tagged with: the structured
 * `department.label` plus the "Department" custom-field value (SMN
 * mirrors the same label there). Returned normalised via
 * `normalizeClinicLabel`.
 *
 * @param {Object} posting  Raw SmartRecruiters posting (list or detail).
 * @returns {string[]}
 */
export function extractPostingDepartmentLabels(posting = {}) {
  const labels = [];
  const structured = posting?.department?.label;
  if (structured) labels.push(structured);
  const customFields = Array.isArray(posting?.customField) ? posting.customField : [];
  for (const field of customFields) {
    if (normalizeClinicLabel(field?.fieldLabel) === 'department' && field?.valueLabel) {
      labels.push(field.valueLabel);
    }
  }
  return [...new Set(labels.map(normalizeClinicLabel).filter(Boolean))];
}

/**
 * Synthesise a structured fallback description (in source locale) so
 * postings without a usable SmartRecruiters detail payload still pass the
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
 * Employment type from the structured API field, falling back to the
 * title heuristic when the field is absent or unrecognised.
 */
function detectEmploymentTypeFromPosting(posting, title = '') {
  const label = `${posting?.typeOfEmployment?.id || ''} ${posting?.typeOfEmployment?.label || ''}`.toLowerCase();
  if (/part[\s-]?time|teilzeit|temps\s*partiel|tempo\s*parziale/.test(label)) return 'PART_TIME';
  if (/full[\s-]?time|vollzeit|plein\s*temps|tempo\s*pieno/.test(label)) return 'FULL_TIME';
  return detectEmploymentType(title);
}

/**
 * Build a parser bundle for one SMN clinic.
 *
 * @param {Object} config
 * @param {string} config.companyKey
 * @param {string} config.companyName              Public-facing clinic name
 * @param {string} config.clinicCode               Legacy SMN listing filter (e.g. 'PKV');
 *                                                 used for the public `?clinic=` URL and
 *                                                 the `source` label only
 * @param {string} config.companyDomain            usually 'swissmedical.net'
 * @param {string} config.defaultCanton            ISO canton code
 * @param {string} config.defaultCity
 * @param {string} config.defaultPostalCode
 * @param {string} [config.streetAddress]          Public street address (formatted)
 * @param {string} [config.publicCareerUrl]
 * @param {string} [config.defaultSourceLang='de']
 * @param {string} [config.lang='de']              SMN listing locale segment
 * @param {string[]} [config.departmentLabels]     ATS department labels owned by this
 *                                                 clinic (default: `[companyName]`)
 * @param {string[]} [config.cityScopedDepartmentLabels]
 *                                                 Network-wide department labels (e.g.
 *                                                 "Réseau de l'Arc") attributed to this
 *                                                 clinic ONLY when the posting's city is
 *                                                 `defaultCity`
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
    departmentLabels = [],
    cityScopedDepartmentLabels = [],
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

  const departmentTargets = new Set(
    (departmentLabels.length > 0 ? departmentLabels : [companyName])
      .map(normalizeClinicLabel)
      .filter(Boolean),
  );
  const cityScopedTargets = new Set(
    cityScopedDepartmentLabels.map(normalizeClinicLabel).filter(Boolean),
  );
  const homeCity = normalizeClinicLabel(defaultCity);

  /**
   * True when an API posting belongs to this clinic (see module header
   * for the attribution rules).
   */
  function matchesClinicPosting(posting) {
    const labels = extractPostingDepartmentLabels(posting);
    if (labels.some((label) => departmentTargets.has(label))) return true;
    if (cityScopedTargets.size > 0 && homeCity) {
      const postingCity = normalizeClinicLabel(posting?.location?.city);
      if (postingCity === homeCity && labels.some((label) => cityScopedTargets.has(label))) {
        return true;
      }
    }
    return false;
  }

  function isCompanyJob(job) {
    const key = normalize(job?.companyKey || '');
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
    console.log(`🏥 Fetching ${companyName} jobs (SmartRecruiters department filter)`);
    console.log(`   Source: SR postings API tenant=${SMN_SR_COMPANY_ID} departments=[${[...departmentTargets].join(', ')}]`);
    if (cityScopedTargets.size > 0) {
      console.log(`   City-scoped departments (${defaultCity} only): [${[...cityScopedTargets].join(', ')}]`);
    }
    if (publicCareerUrl) console.log(`   Public: ${publicCareerUrl}`);
    console.log();

    const todayIso = new Date().toISOString().slice(0, 10);
    const jobs = [];
    let detailHits = 0;

    const postings = fetchSmartRecruitersJobs(SMN_SR_COMPANY_ID, {
      company: companyName,
      locationCountryCodes: ['ch'],
      filter: matchesClinicPosting,
      fetchDetail: true,
    });

    for await (const normalized of postings) {
      const posting = normalized.rawPosting || {};
      const title = normalizeSpace(posting.name || normalized.title || '');
      if (!title || title.length < 3) continue;

      const loc = posting.location || {};
      const city = normalizeSpace(loc.city || '') || defaultCity;
      const postalCode = normalizeSpace(loc.postalCode || '') || defaultPostalCode;

      let descriptionFromDetail = extractSmnApiDescription(posting);
      if (descriptionFromDetail && descriptionFromDetail.split(/\s+/).length >= 30) {
        detailHits += 1;
      } else {
        descriptionFromDetail = '';
      }

      const sourceLang = detectLang(descriptionFromDetail || title, defaultSourceLang);
      const description = descriptionFromDetail
        || buildFallbackDescription({ title, clinicName: companyName, city, canton: defaultCanton, sourceLang });

      // Same URL format the old listing tiles exposed ({id}-{title-slug}),
      // so job ids (sha1 of URL) stay stable across the source migration.
      const url = normalizeSpace(posting.postingUrl || '')
        || `${SR_PUBLIC_JOBS_BASE}/${SMN_SR_COMPANY_ID}/${posting.id}-${slugify(title)}`;

      const postedIso = (normalized.postedAt || '').slice(0, 10) || todayIso;
      const jobSlug = slugify(`${title}-${companyKey}`);
      const urlHash = createHash('sha1').update(url).digest('hex').slice(0, 12);

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
        url,
        applyUrl: url,
        source: `${companyName} Dedicated Parser (SMN clinic=${clinicCode})`,
        sourceLang,
        crawledAt: new Date().toISOString(),

        addressLocality: city,
        addressRegion: defaultCanton,
        addressCountry: 'CH',
        country: 'CH',
        postalCode,
        streetAddress,
        category: detectCategory(title),
        employmentType: detectEmploymentTypeFromPosting(posting, title),
        experienceLevel: detectExperienceLevel(title),
        sector: 'Sanità / Ospedali',
        currency: 'CHF',
        featured: false,
        postedDate: postedIso,
        datePosted: postedIso,
        requirements: [],
        requirementsByLocale: { [sourceLang]: [] },
      });
    }

    console.log(`\n📋 Total ${companyName} jobs discovered: ${jobs.length} (${detailHits}/${jobs.length} with rich detail content)`);
    return jobs;
  }

  return { fetchAllJobs, isCompanyJob, isTrustedDomain, LISTING_URL, matchesClinicPosting };
}
