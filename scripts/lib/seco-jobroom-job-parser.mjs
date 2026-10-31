#!/usr/bin/env node
/**
 * Ads of job-room.ch, the public employment service (SECO/RAV), published on
 * the site. Unlike every other parser this one is multi-employer: `companyKey`
 * is the crawler and `company` is whoever the ad names.
 *
 * Owner decision, 2026-10-31: these ads are read from the job-room API whatever
 * robots.txt says. The file asks crawlers to stay out of `/job-search/`; the API
 * path is not listed and this crawler never requests that page.
 *
 * @outsourced-ats-confirmed: job-room.ch is the public employment service's own register, the channel the Stellenmeldepflicht mandates; `url` links the ad there, `applyUrl` goes to the employer's channel unless that is a job board, and an ad a dedicated crawler already holds stays out (seco-jobroom-corpus-index.mjs).
 *
 * WHAT STAYS OUT, each with its own counter:
 *   - anything not plainly public, and the RAV exclusivity window: while
 *     `reportingObligation` holds and `reportingObligationEndDate` has not
 *     passed, the ad is reserved to registered job seekers. The public search
 *     did not return one in 4,567 ads (2026-10-31); the rule stands because
 *     publishing one would break the law's five-day head start, and the search
 *     parameter is not ours to trust alone;
 *   - ads with no identifiable employer: `companyAnonymous`, a placeholder such
 *     as "Recruteur anonyme", or a job board named as the company ("Jobup"
 *     heads 131 of the 4,567). `hiringOrganization.name` must name who is
 *     hiring, and a RAV office or a job board is not that;
 *   - bodies under the 50-word floor, measured after the contact data is gone.
 *
 * AGENCIES. `company.surrogate` marks a staffing agency advertising for a client
 * it does not name. The ad is attributed to the agency, the party that actually
 * published it, and `employerDisclosed: false` records that the employer is
 * unknown. A real `employer` in the payload wins over the agency; the public API
 * sent none in this sample, so `company` is what is shown today.
 *
 * CONTACT DATA, by choice. Neither `publicContact` nor the e-mail and phone of
 * `applyChannel` is copied, and addresses, phone numbers and the named contact
 * are taken out of the ad text (1,453 and 1,536 of 4,567 bodies carried them).
 * The visitor reaches the channel through `applyUrl`, or through the job-room
 * page that shows it, so a private person's name adds nothing to our copy.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  normalizeDescriptionSpace,
  normalizeSpace,
  slugify,
  stripHtml,
} from './crawler-template.mjs';
import { normalizeJobUrl } from './crawler-source-hosts.mjs';
import { detectLang } from './dedicated-crawler-common.mjs';
import { PART_TIME_MAX_WORKLOAD } from './employment-workload.mjs';
import { assertExtractionComplete } from './extraction-completeness.mjs';
import { identicalAdvertisementKey } from './identical-posting-dedupe.mjs';
import { absoluteJobUrl } from './job-url-host.mjs';
import { isKnownAggregatorDomain } from './known-aggregator-domains.mjs';
import { normalizeCompanyName } from './prospector/coverage.mjs';
import { fetchSecoAdSnapshot } from './prospector/sources/seco-jobroom.mjs';
import { buildCorpusIndex, comparableTitle, matchCorpus } from './seco-jobroom-corpus-index.mjs';
import { meetsSourceBodyFloor } from './source-body-floor.mjs';
import { sourcePostingDateCandidatesFields } from './source-posting-date.mjs';

export const SECO_JOBROOM_KEY = 'seco-jobroom';
export const SECO_JOBROOM_COMPANY_NAME = 'SECO Job-Room';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const JOB_ROOM_ORIGIN = 'https://www.job-room.ch';

/**
 * Canton scope. The 26 cantons held 75,683 ads on 2026-10-31, 2.5 times the
 * whole corpus: their slice would weigh more than every other crawler together
 * and outrun translate-pending, which already rations the four agency crawlers.
 * The crawl starts on the three cantons bordering Italy (4,567 ads) and is
 * widened through `SECO_JOBROOM_CANTONS` once translation has absorbed them.
 */
export const DEFAULT_CANTONS = Object.freeze(['TI', 'GR', 'VS']);

const ONLINE_SINCE_DAYS = 30;
const SNAPSHOT_ATTEMPTS = 2;
const LANGUAGES = ['it', 'de', 'fr', 'en'];

/** Why an ad stays out. Every read ad ends in exactly one bucket or is published. */
export const EXCLUSION_REASONS = Object.freeze([
  'not-public',
  'rav-exclusive',
  'publication-ended',
  'no-swiss-location',
  'anonymous-employer',
  'job-board-as-employer',
  'missing-title',
  'thin-description',
]);
export const DEDUPE_REASONS = Object.freeze(['feed', 'url', 'host', 'reference', 'title']);

const PLACEHOLDER_EMPLOYER_RE = /\b(?:anonym\w*|confidential\w*|confidentiel\w*|vertraulich\w*|riservat\w*|chiffre)\b/iu;
const EMAIL_RE = /[\p{L}\p{N}._%+-]+(?:@|\s?\(at\)\s?|\s?\[at\]\s?)[\p{L}\p{N}.-]+\.[\p{L}]{2,}/giu;
// Swiss numbers, with or without the international prefix: +41 91 123 45 67,
// 0041 (0)91 123 45 67, 091 123 45 67, 091/123.45.67.
const PHONE_RE = /(?:(?:\+|00)\s?41[\s().\/-]*(?:\(0\)[\s.\/-]*)?|\b0)\d{2}[\s.\/-]*\d{3}[\s.\/-]*\d{2}[\s.\/-]*\d{2}\b/g;
// A line that introduces a contact: here the surname alone is a person.
const CONTACT_LINE_RE = /\b(?:kontakt\w*|ansprechp\w*|auskunft|auskünfte|contact\w*|contatto|contatti|referente|renseignements?|informazioni)\b/iu;
const SALUTATIONS = 'Frau|Herr|Hr\\.|Fr\\.|Madame|Monsieur|Mme|M\\.|Signora|Signor|Sig\\.ra|Sig\\.|Mrs\\.?|Mr\\.?|Ms\\.?|Dr\\.';
/** A line losing contact data keeps its place only if a sentence survives. */
const MIN_WORDS_IN_SCRUBBED_LINE = 5;

function escapeRegExp(text) {
  return String(text).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** @param {Date} now */
function zurichDay(now) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Zurich' }).format(now);
}

function isoDay(value) {
  const match = /^(\d{4}-\d{2}-\d{2})/.exec(String(value || ''));
  return match ? match[1] : '';
}

/**
 * Remove addresses, numbers and the ad's named contact from its text.
 *
 * Outside a line that introduces a contact the surname alone is not matched:
 * "Koch" and "Weber" are also trades. There it takes the first name or a
 * salutation next to it to prove the words are a person.
 *
 * @param {string} text
 * @param {{ firstName?: string, lastName?: string }|null} [contact]
 * @returns {string}
 */
export function scrubContactData(text, contact = null) {
  const first = normalizeSpace(contact?.firstName || '');
  const last = normalizeSpace(contact?.lastName || '');
  const namePatterns = [];
  if (last) {
    const surname = escapeRegExp(last).replace(/ /g, '\\s+');
    namePatterns.push(`(?:${SALUTATIONS})\\s+(?:${first ? `${escapeRegExp(first).replace(/ /g, '\\s+')}\\s+` : ''})?${surname}`);
    if (first) {
      const given = escapeRegExp(first).replace(/ /g, '\\s+');
      namePatterns.push(`${given}\\s+${surname}`, `${surname}\\s+${given}`);
    }
  }
  const boundedName = (pattern) => new RegExp(`(?<![\\p{L}\\p{N}])(?:${pattern})(?![\\p{L}\\p{N}])`, 'giu');
  const nameRe = namePatterns.length ? boundedName(namePatterns.join('|')) : null;
  const surnameRe = last ? boundedName(escapeRegExp(last).replace(/ /g, '\\s+')) : null;

  const lines = [];
  for (const line of String(text || '').split('\n')) {
    let cleaned = line.replace(EMAIL_RE, ' ').replace(PHONE_RE, ' ');
    if (nameRe) cleaned = cleaned.replace(nameRe, ' ');
    if (surnameRe && CONTACT_LINE_RE.test(line)) cleaned = cleaned.replace(surnameRe, ' ');
    if (cleaned === line) { lines.push(line); continue; }
    cleaned = cleaned.replace(/\s+([,;:.])/g, '$1').replace(/([,;:])(?:\s*[,;:])+/g, '$1').replace(/\s{2,}/g, ' ').trim();
    if (cleaned.split(/\s+/).filter((word) => /[\p{L}]{2,}/u.test(word)).length >= MIN_WORDS_IN_SCRUBBED_LINE) {
      lines.push(cleaned.replace(/[,;:]$/, '.'));
    }
  }
  return lines.join('\n');
}

function channelUrls(jobContent) {
  const urls = [];
  for (const raw of [jobContent?.externalUrl, jobContent?.applyChannel?.formUrl]) {
    const url = absoluteJobUrl(raw);
    if (!url) continue;
    try {
      const { protocol, hostname } = new URL(url);
      if ((protocol === 'https:' || protocol === 'http:') && hostname && !urls.includes(url)) urls.push(url);
    } catch { /* a malformed channel is no channel */ }
  }
  return urls;
}

/** The label a board trades under: `jobup.ch` -> `jobup`, `job-too.ch` -> `job too`. */
function boardLabel(url) {
  try {
    const labels = new URL(url).hostname.replace(/^www\./, '').split('.');
    return normalizeCompanyName(labels[labels.length - 2] || '');
  } catch {
    return '';
  }
}

/**
 * A board names itself as the company of what it re-publishes, on its own
 * domain. Both halves are needed: "Talent AG" is an employer, and an agency
 * posting through jobup.ch keeps its own name.
 */
export function isJobBoardNamedAsEmployer(company, urls) {
  const name = normalizeCompanyName(company);
  return Boolean(name) && urls.some((url) => isKnownAggregatorDomain(url) && boardLabel(url) === name);
}

function resolveEmployer(advertisement) {
  const jobContent = advertisement.jobContent;
  if (advertisement.publication?.companyAnonymous === true) return null;
  const employer = normalizeSpace(jobContent.employer?.name || '');
  const company = normalizeSpace(jobContent.company?.name || '');
  const name = employer || company;
  if (!name || PLACEHOLDER_EMPLOYER_RE.test(name)) return null;
  return {
    name,
    // True only for an agency that does not name its client.
    undisclosed: !employer && jobContent.company?.surrogate === true,
    address: !employer && jobContent.company?.surrogate !== true ? jobContent.company : null,
  };
}

/**
 * The street of the workplace. The company's address counts only where the ad
 * places the job at that same postal code: a head office elsewhere is not where
 * this vacancy is, and the JobPosting builder has a locality-safe default.
 */
function workplaceStreet(address, postalCode) {
  if (!address?.street || String(address.postalCode || '').trim() !== postalCode) return '';
  return normalizeSpace(`${address.street} ${address.houseNumber || ''}`);
}

function employmentFields(employment = {}) {
  const max = Number(employment.workloadPercentageMax);
  const partTime = Number.isFinite(max) && max <= PART_TIME_MAX_WORKLOAD;
  return {
    employmentType: employment.shortEmployment === true ? 'TEMPORARY' : (partTime ? 'PART_TIME' : 'FULL_TIME'),
    contract: partTime ? 'part-time' : 'full-time',
  };
}

function detectCategory(title = '') {
  const t = title.toLowerCase();
  if (/\b(pfleg|infermier|soins|arzt|ärzt|medic|médec|physio|spitex|fage|fa ?ge)/.test(t)) return 'Sanità';
  if (/\b(ingegner|engineer|ingenieur|ingénieur|entwickl)/.test(t)) return 'Ingegneria';
  if (/\b(techni|tecnic|mechanik|mécanic|elektr|électr|install|monteur|sanitär|heizung)/.test(t)) return 'Tecnica';
  if (/\b(admin|segret|sekret|contab|buchhalt|account|kaufm|employé.? de commerce)/.test(t)) return 'Amministrazione';
  if (/\b(vendita|sales|verkauf|vendeu)/.test(t)) return 'Commerciale';
  if (/\b(logist|magazz|lager|warehouse|chauffeur|autista)/.test(t)) return 'Logistica';
  if (/\b(koch|köch|cuisin|cuoco|service|kellner|camerier|hotel|réception|rezeption|gastro)/.test(t)) return 'Ristorazione';
  if (/\b(bau|maurer|maçon|murator|maler|peintre|zimmer|schreiner|polier)/.test(t)) return 'Edilizia';
  if (/\b(software|developer|informati)/.test(t)) return 'IT';
  return 'Altro';
}

function detectExperienceLevel(title = '') {
  const t = title.toLowerCase();
  if (/\b(praktik|stagiair|stage|lehrling|apprenti)/.test(t)) return 'intern';
  if (/\b(junior|jr)\b/.test(t)) return 'junior';
  if (/\b(senior|sr|lead|head|leiter|leitung|direct|dirett|chef|responsab)/.test(t)) return 'senior';
  return 'mid';
}

/**
 * The ad's text in the language it was written in; on a multi-language ad the
 * site's primary locale first.
 */
function pickDescription(jobContent) {
  const descriptions = Array.isArray(jobContent?.jobDescriptions) ? jobContent.jobDescriptions : [];
  return LANGUAGES.map((language) => descriptions.find((entry) => entry?.languageIsoCode === language)).find(Boolean)
    || descriptions[0]
    || null;
}

/**
 * Judge one row. Pure: `now` is the only outside input.
 *
 * @param {any} row  one result of the job-room search
 * @param {Date} now
 * @returns {{ reason: string } | { candidate: { job: object, advertisement: object, urls: string[] } }}
 */
export function classifyAdvertisement(row, now) {
  const advertisement = row?.jobAdvertisement;
  const jobContent = advertisement?.jobContent;
  if (!advertisement?.id || !jobContent) return { reason: 'not-public' };

  const { publication = {} } = advertisement;
  if (advertisement.status !== 'PUBLISHED_PUBLIC' || publication.publicDisplay !== true) {
    return { reason: 'not-public' };
  }
  const today = zurichDay(now);
  if (advertisement.reportingObligation === true) {
    const end = isoDay(advertisement.reportingObligationEndDate);
    // No date means the window cannot be shown to be over.
    if (!end || end >= today) return { reason: 'rav-exclusive' };
  }
  const validThrough = isoDay(publication.endDate);
  if (validThrough && validThrough < today) return { reason: 'publication-ended' };

  const { location = {} } = jobContent;
  const city = normalizeSpace(location.city || '');
  const canton = normalizeSpace(location.cantonCode || '').toUpperCase();
  if (location.countryIsoCode !== 'CH' || !city || !canton) return { reason: 'no-swiss-location' };

  const employer = resolveEmployer(advertisement);
  if (!employer) return { reason: 'anonymous-employer' };
  const urls = channelUrls(jobContent);
  if (isJobBoardNamedAsEmployer(employer.name, urls)) return { reason: 'job-board-as-employer' };

  const picked = pickDescription(jobContent);
  const title = normalizeSpace(stripHtml(picked?.title || ''));
  if (title.length < 3) return { reason: 'missing-title' };
  const description = scrubContactData(
    normalizeDescriptionSpace(stripHtml(picked?.description || '')),
    jobContent.publicContact,
  );
  if (!meetsSourceBodyFloor(description)) return { reason: 'thin-description' };

  const language = LANGUAGES.includes(picked?.languageIsoCode)
    ? picked.languageIsoCode
    : detectLang(description || title, 'de');
  const id = String(advertisement.id);
  const postalCode = normalizeSpace(location.postalCode || '');
  const url = `${JOB_ROOM_ORIGIN}/job-search/${id}`;
  const slugDisambiguator = id.replace(/[^a-z0-9]/gi, '').slice(0, 8).toLowerCase();
  const slug = `${slugify(`${title} ${employer.name} ${city}`, 80)}-${slugDisambiguator}`;
  const street = workplaceStreet(employer.address, postalCode);
  const validThroughField = validThrough ? { validThrough } : {};

  return {
    candidate: {
      advertisement,
      urls,
      job: {
        id: `${SECO_JOBROOM_KEY}-${id}`,
        slug,
        slugByLocale: { [language]: slug },
        slugDisambiguator,
        company: employer.name,
        companyKey: SECO_JOBROOM_KEY,
        employerDisclosed: !employer.undisclosed,
        title,
        titleByLocale: { [language]: title },
        description,
        descriptionByLocale: { [language]: description },
        location: city,
        canton,
        url,
        // A job board's page is not the employer's channel: the visitor stays
        // on the public register, which shows every channel of the ad.
        applyUrl: urls.find((candidate) => !isKnownAggregatorDomain(candidate)) || url,
        source: SECO_JOBROOM_COMPANY_NAME,
        sourceLang: language,
        crawledAt: now.toISOString(),
        addressLocality: city,
        addressRegion: canton,
        addressCountry: 'CH',
        country: 'CH',
        ...(postalCode ? { postalCode } : {}),
        ...(street ? { streetAddress: street } : {}),
        category: detectCategory(title),
        ...employmentFields(jobContent.employment),
        experienceLevel: detectExperienceLevel(title),
        sector: 'Altro',
        currency: 'CHF',
        featured: false,
        ...sourcePostingDateCandidatesFields([publication.startDate], now),
        ...validThroughField,
        requirements: [],
        requirementsByLocale: { [language]: [] },
      },
    },
  };
}

/**
 * Channel URLs that name one vacancy. A careers landing page is linked by every
 * ad of that advertiser (`l-agence.ch/emplois` by 18, each a different role), so
 * sharing it proves nothing: only a URL one title uses identifies an ad.
 */
function vacancyUrlsOf(candidates) {
  const titlesByUrl = new Map();
  for (const { job, urls } of candidates) {
    for (const url of urls) {
      if (new URL(url).pathname.length <= 1) continue;
      const key = normalizeJobUrl(url);
      if (!titlesByUrl.has(key)) titlesByUrl.set(key, new Set());
      titlesByUrl.get(key).add(comparableTitle(job.title));
    }
  }
  return new Set([...titlesByUrl].filter(([, titles]) => titles.size === 1).map(([url]) => url));
}

function feedIdentityKeys({ job, advertisement, urls }, vacancyUrls) {
  const company = normalizeCompanyName(job.company);
  return [
    advertisement.fingerprint && `fingerprint|${advertisement.fingerprint}`,
    ...urls.map(normalizeJobUrl).filter((url) => vacancyUrls.has(url)).map((url) => `url|${url}`),
    advertisement.externalReference && `reference|${company}|${advertisement.externalReference}`,
    identicalAdvertisementKey(job, [company, job.postalCode, job.location]),
  ].filter(Boolean);
}

/**
 * The publication decision over a full snapshot.
 *
 * Rows are visited by id, not in feed order: which of two copies survives must
 * not flip with every new ad that shifts the date-descending pages.
 *
 * @param {any[]} rows
 * @param {{ corpusIndex: import('./seco-jobroom-corpus-index.mjs').CorpusIndex, now: Date }} opts
 * @returns {{ jobs: object[], stats: { read: number, published: number, deduplicated: Record<string, number>, excluded: Record<string, number> } }}
 */
export function selectPublishableJobs(rows, { corpusIndex, now }) {
  const excluded = Object.fromEntries(EXCLUSION_REASONS.map((reason) => [reason, 0]));
  const deduplicated = Object.fromEntries(DEDUPE_REASONS.map((reason) => [reason, 0]));
  const ordered = [...rows].sort((a, b) => String(a?.jobAdvertisement?.id).localeCompare(String(b?.jobAdvertisement?.id)));
  const candidates = [];
  for (const row of ordered) {
    const verdict = classifyAdvertisement(row, now);
    if (verdict.candidate) candidates.push(verdict.candidate);
    else excluded[verdict.reason] += 1;
  }

  const vacancyUrls = vacancyUrlsOf(candidates);
  const seen = new Set();
  const jobs = [];
  for (const candidate of candidates) {
    const { job, advertisement, urls } = candidate;
    const keys = feedIdentityKeys(candidate, vacancyUrls);
    if (keys.some((key) => seen.has(key))) { deduplicated.feed += 1; continue; }
    for (const key of keys) seen.add(key);
    const match = matchCorpus({
      company: job.company,
      title: job.title,
      postalCode: job.postalCode,
      city: job.location,
      channelUrls: urls,
      externalReference: advertisement.externalReference,
    }, corpusIndex);
    if (match) { deduplicated[match] += 1; continue; }
    jobs.push(job);
  }
  return {
    jobs,
    stats: { read: rows.length, published: jobs.length, deduplicated, excluded },
  };
}

/** @param {ReturnType<typeof selectPublishableJobs>['stats']} stats */
export function formatRunCounters(stats) {
  const sum = (bucket) => Object.values(bucket).reduce((total, count) => total + count, 0);
  const detail = (bucket) => Object.entries(bucket).filter(([, count]) => count > 0)
    .map(([reason, count]) => `${reason}=${count}`).join(' ') || 'nessuno';
  return `[seco-jobroom] letti=${stats.read} pubblicabili=${stats.published} `
    + `deduplicati=${sum(stats.deduplicated)} (${detail(stats.deduplicated)}) `
    + `esclusi=${sum(stats.excluded)} (${detail(stats.excluded)})`;
}

/**
 * Hold a sweep to the source's own total. New ads land while the pages are read
 * and move the total under the sweep, so a gap that the movement itself explains
 * is not a short read; anything larger is.
 */
function verifySnapshot(snapshot) {
  const { firstDeclaredTotal: first, lastDeclaredTotal: last, rows, skippedRows } = snapshot;
  const skip = process.env.JOBS_SECO_JOBROOM_SKIP_COUNT_CHECK === '1';
  // A row with no id or no content counts toward the total but can never be
  // classified: its live ad would be retired as absent.
  const malformedRows = skippedRows + rows.filter((row) => !row?.jobAdvertisement?.jobContent).length;
  if (malformedRows > 0 && !skip) {
    throw new Error(`[${SECO_JOBROOM_KEY}] ${malformedRows} malformed row(s) in the feed: refusing a partial slice.`);
  }
  const extractedCount = rows.length;
  const explainedByDrift = first !== null && last !== null
    && Math.abs(extractedCount - last) <= Math.abs(last - first);
  return assertExtractionComplete({
    label: SECO_JOBROOM_KEY,
    extractedCount,
    declaredTotal: explainedByDrift ? extractedCount : last,
    escapeHatchEnvVar: 'JOBS_SECO_JOBROOM_SKIP_COUNT_CHECK',
    skip,
  });
}

function snapshotFailure(snapshot) {
  const error = new Error(`job-room feed: ${snapshot.outcome} (${snapshot.errorCode}) after ${snapshot.pagesRead} page(s)`);
  // The pipeline keeps the stored slice for a source that is down; a 4xx is the
  // API refusing or changing, which has to surface.
  error.feedEndpointUnavailable = /^(?:network_error|http_0|http_429|http_5\d\d)$/.test(String(snapshot.errorCode));
  return error;
}

async function readCompleteSnapshot(cantons, fetchOptions) {
  for (let attempt = 1; ; attempt += 1) {
    const snapshot = await fetchSecoAdSnapshot({ cantons, onlineSince: ONLINE_SINCE_DAYS, ...fetchOptions });
    if (snapshot.outcome !== 'complete') throw snapshotFailure(snapshot);
    try {
      verifySnapshot(snapshot);
      return snapshot;
    } catch (error) {
      if (attempt >= SNAPSHOT_ATTEMPTS) throw error;
      console.warn(`⚠️ ${error.message} — rereading the feed once.`);
    }
  }
}

export function cantonsFromEnv(env = process.env) {
  const configured = String(env.SECO_JOBROOM_CANTONS || '').split(',')
    .map((code) => code.trim().toUpperCase()).filter(Boolean);
  return configured.length ? [...new Set(configured)] : [...DEFAULT_CANTONS];
}

/**
 * @param {{ root?: string, cantons?: string[], now?: Date, corpusIndex?: object, fetchOptions?: object }} [opts]
 */
export async function fetchAllSecoJobroomJobs(opts = {}) {
  const now = opts.now || new Date();
  const cantons = opts.cantons || cantonsFromEnv();
  console.log(`🔍 Fetching job-room ads for ${cantons.join(', ')}`);
  const snapshot = await readCompleteSnapshot(cantons, opts.fetchOptions);
  const corpusIndex = opts.corpusIndex
    || buildCorpusIndex(opts.root || ROOT, { excludeKey: SECO_JOBROOM_KEY });
  const { jobs, stats } = selectPublishableJobs(snapshot.rows, { corpusIndex, now });
  console.log(formatRunCounters(stats));
  return { jobs, discoveredCount: stats.read, fetchOutcome: 'ok', stats };
}

export function isSecoJobroomJob(job) {
  return job?.companyKey === SECO_JOBROOM_KEY;
}

export function isTrustedDomain(rawUrl = '') {
  try {
    return new URL(rawUrl).hostname.toLowerCase() === 'www.job-room.ch';
  } catch {
    return false;
  }
}
