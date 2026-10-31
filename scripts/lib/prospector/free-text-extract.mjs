/**
 * Extract concrete job offers that an employer writes directly in a page's
 * prose.
 *
 * This is deliberately shared by SYNTHESIZE and the production spec runtime.
 * A free-text spec is only useful when the exact same evidence and rejection
 * rules are applied both when it is learned and when it is crawled again.
 */
import { createHash } from 'node:crypto';
import { bodyTextOf, isSufficientVacancyDescription, textOf } from './extract.mjs';
import { hasHomepageHiringSignal } from './careers-trail.mjs';
import {
  resolveSourceBackedSwissGeography,
  sourceBackedSwissJobAddressFields,
} from './location-evidence.mjs';
import { isGenericVacancyTitle } from './production-title.mjs';
import { isSpontaneousApplicationTitle } from '../spontaneous-application.mjs';
import { sourcePostingDateFields } from '../source-posting-date.mjs';
import { gradeJobLike } from '../job-like.mjs';

export const FREE_TEXT_MODE = 'free-text';
export const FREE_TEXT_CONTRACT_VERSION = 1;
export const FREE_TEXT_DESCRIPTION_MIN_WORDS = 50;

/**
 * The response has separate containers for real openings and standing
 * applications. Keeping the two arrays separate is an intentional contract:
 * a spontaneous application must never become a JobPosting by accident.
 */
export const FREE_TEXT_RESPONSE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    vacancies: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          title: { type: 'string' },
          description: { type: 'string' },
          sourceText: { type: 'string' },
          location: { type: 'string' },
          addressLocality: { type: 'string' },
          addressRegion: { type: 'string' },
          postalCode: { type: 'string' },
          streetAddress: { type: 'string' },
          employmentType: { type: 'string' },
          datePosted: { type: 'string' },
          applyUrl: { type: 'string' },
        },
        required: [
          'title', 'description', 'sourceText', 'location', 'addressLocality',
          'addressRegion', 'postalCode', 'streetAddress', 'employmentType',
          'datePosted', 'applyUrl',
        ],
      },
    },
    permanentApplications: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          label: { type: 'string' },
          description: { type: 'string' },
          sourceText: { type: 'string' },
          applyUrl: { type: 'string' },
        },
        required: ['label', 'description', 'sourceText', 'applyUrl'],
      },
    },
  },
  required: ['vacancies', 'permanentApplications'],
};

const MAX_SOURCE_CHARS = 16000;
const MIN_SOURCE_WORDS = 4;
const PERMANENT_APPLICATION_RE = /\b(?:candidatur[ae]\s+(?:permanent|spontan)|candidature\s+spontan(?:e|ée)|postulation\s+spontan(?:e|ée)|initiativbewerbung|blindbewerbung|spontaneous\s+application|unsolicited\s+application)\b/i;

function clean(value, max = 8000) {
  return String(value || '')
    .replace(/```(?:json|text)?/gi, '')
    .replace(/\*\*/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);
}

function plainSource(value) {
  return clean(value, 4000);
}

function evidenceText(value) {
  return clean(value, MAX_SOURCE_CHARS)
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function words(value) {
  return clean(value).split(/\s+/).filter(Boolean);
}

function tokenOverlap(needle, haystack) {
  const wanted = [...new Set(evidenceText(needle).split(' ').filter((token) => token.length > 2))];
  if (!wanted.length) return 0;
  const available = new Set(evidenceText(haystack).split(' '));
  return wanted.filter((token) => available.has(token)).length / wanted.length;
}

function exactSourceEvidence(sourceText, pageText) {
  const source = evidenceText(sourceText);
  const page = evidenceText(pageText);
  if (!source || words(source).length < MIN_SOURCE_WORDS) return false;
  // `sourceText` is the primary evidence supplied by the model. Whitespace,
  // case and punctuation are normalised above, but a bag-of-words fallback
  // would let a plausible paraphrase masquerade as a quote from the page.
  return page.includes(source);
}

function titleSourceEvidence(title, pageText) {
  const titleTokens = evidenceText(title).split(' ').filter(Boolean);
  const pageTokens = new Set(evidenceText(pageText).split(' ').filter(Boolean));
  return titleTokens.length > 0 && titleTokens.every((token) => pageTokens.has(token));
}

function dateEvidence(value, pageText) {
  const raw = clean(value, 80);
  if (!raw) return false;
  const normalizedPage = evidenceText(pageText);
  const normalizedDate = evidenceText(raw);
  if (normalizedPage.includes(normalizedDate)) return true;
  const iso = /^(\d{4})-(\d{2})-(\d{2})/.exec(raw);
  if (!iso) return false;
  return normalizedPage.includes(`${iso[3]} ${iso[2]} ${iso[1]}`)
    || normalizedPage.includes(`${iso[3]} ${iso[2]} ${iso[1].slice(2)}`);
}

function parseJsonResponse(value) {
  if (value && typeof value === 'object') return value;
  const raw = String(value || '').trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/i, '')
    .trim();
  if (!raw) return null;
  try { return JSON.parse(raw); } catch { /* try the first JSON object */ }
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try { return JSON.parse(raw.slice(start, end + 1)); } catch { return null; }
}

function parseAbsoluteUrl(value, baseUrl) {
  const raw = String(value || '').trim();
  if (!raw) return '';
  try {
    const url = new URL(raw, baseUrl);
    if (!/^https?:$/i.test(url.protocol)) return '';
    return url.toString();
  } catch {
    return '';
  }
}

function sameOriginUrl(value, pageUrl) {
  const parsed = parseAbsoluteUrl(value, pageUrl);
  if (!parsed) return '';
  try {
    return new URL(parsed).origin === new URL(pageUrl).origin ? parsed : '';
  } catch {
    return '';
  }
}

function sourceLocationContext(context = {}) {
  const source = context.sourceLocation || context.companyLocation || {};
  const location = typeof source === 'string'
    ? source
    : source.location || source.city || source.addressLocality || '';
  return {
    location: clean(location, 240),
    addressLocality: clean(typeof source === 'object' ? source.addressLocality || source.city : '', 160),
    addressRegion: clean(typeof source === 'object' ? source.addressRegion || source.canton : '', 80),
    addressCountry: clean(typeof source === 'object' ? source.addressCountry || source.country : '', 40),
    postalCode: clean(typeof source === 'object' ? source.postalCode || source.zip : '', 24),
    streetAddress: clean(typeof source === 'object' ? source.streetAddress : '', 160),
  };
}

function resolvedLocation(raw, context) {
  const hasRawLocation = Object.values(raw).some((value) => clean(value));
  const direct = resolveSourceBackedSwissGeography(raw);
  if (direct) return { resolved: direct, input: raw };
  if (hasRawLocation) return null;
  const fallback = sourceLocationContext(context);
  const resolved = resolveSourceBackedSwissGeography(fallback);
  return resolved ? { resolved, input: fallback } : null;
}

function stableOfferUrl(pageUrl, title, sourceText) {
  const digest = createHash('sha1')
    .update(`${pageUrl}\n${title}\n${sourceText}`)
    .digest('hex')
    .slice(0, 16);
  try {
    const url = new URL(pageUrl);
    url.hash = `free-text-${digest}`;
    return url.toString();
  } catch {
    return `${pageUrl}#free-text-${digest}`;
  }
}

function structuredDataContract({ title, description, company, address, datePosted, employmentType }) {
  return {
    version: FREE_TEXT_CONTRACT_VERSION,
    // Salary is intentionally not inferred from prose. The canonical schema
    // builder supplies its reviewed safe fallback and marks it accordingly.
    baseSalary: 'schema-safe-default',
    postalCode: address.postalCode,
    streetAddress: address.streetAddress,
    title,
    description,
    datePosted: datePosted || 'schema-date-fallback',
    hiringOrganizationName: company,
    jobLocation: {
      addressLocality: address.addressLocality,
      addressRegion: address.addressRegion,
      addressCountry: address.addressCountry || 'CH',
    },
    employmentType,
  };
}

/**
 * Validate one model-produced opening without asking another model to approve
 * it. All accepted evidence must be present in the source page or in an
 * independently source-backed candidate location.
 */
export function validateFreeTextOffer(offer, {
  html = '',
  pageUrl = '',
  context = {},
} = {}) {
  const pageText = bodyTextOf(html);
  const title = clean(offer?.title, 240);
  const description = clean(offer?.description, 8000);
  const sourceText = plainSource(offer?.sourceText);
  if (!hasHomepageHiringSignal(html)) return { valid: false, reason: 'homepage_hiring_signal_missing' };
  if (!title || isGenericVacancyTitle(title)
    || isSpontaneousApplicationTitle(title)
    || PERMANENT_APPLICATION_RE.test(`${title} ${sourceText}`)) {
    return { valid: false, reason: 'generic_or_spontaneous_title' };
  }
  if (!titleSourceEvidence(title, pageText)) {
    return { valid: false, reason: 'title_source_evidence_missing' };
  }
  if (!exactSourceEvidence(sourceText, pageText)) return { valid: false, reason: 'source_evidence_missing' };
  if (words(description).length < FREE_TEXT_DESCRIPTION_MIN_WORDS
    || !isSufficientVacancyDescription(description)) {
    return { valid: false, reason: 'description_below_50_words' };
  }
  if (tokenOverlap(description, pageText) < 0.3) return { valid: false, reason: 'description_not_grounded' };
  const rawLocationText = [
    offer.location,
    offer.addressLocality,
    offer.addressRegion,
    offer.postalCode,
    offer.streetAddress,
  ].map((value) => clean(value, 240)).filter(Boolean).join(' ');
  if (rawLocationText && tokenOverlap(rawLocationText, pageText) < 0.5) {
    return { valid: false, reason: 'location_not_grounded' };
  }
  const jobLike = gradeJobLike(`${sourceText}\n${description}`);
  if (!jobLike.jobLike) return { valid: false, reason: 'not_job_like', jobLike };
  const location = resolvedLocation({
    location: offer.location,
    addressLocality: offer.addressLocality,
    addressRegion: offer.addressRegion,
    addressCountry: offer.addressCountry,
    postalCode: offer.postalCode,
    streetAddress: offer.streetAddress,
  }, context);
  if (!location) return { valid: false, reason: 'source_backed_location_missing', jobLike };
  const address = sourceBackedSwissJobAddressFields(location.input, location.resolved);
  if (!address?.postalCode || !address.streetAddress || !address.addressLocality || !address.addressRegion) {
    return { valid: false, reason: 'structured_address_incomplete', jobLike };
  }
  const company = clean(context.companyName || offer.company, 240);
  if (!company) return { valid: false, reason: 'employer_identity_missing', jobLike };
  const dateFields = dateEvidence(offer.datePosted, pageText)
    ? sourcePostingDateFields(clean(offer.datePosted, 80))
    : sourcePostingDateFields('');
  const proposedEmploymentType = clean(offer.employmentType, 80);
  const employmentType = proposedEmploymentType && tokenOverlap(proposedEmploymentType, pageText) >= 0.5
    ? proposedEmploymentType
    : 'FULL_TIME';
  const applyUrl = sameOriginUrl(offer.applyUrl, pageUrl);
  return {
    valid: true,
    title,
    description,
    sourceText,
    location: address,
    dateFields,
    employmentType,
    applyUrl,
    company,
    jobLike,
    structuredDataContract: structuredDataContract({
      title,
      description,
      company,
      address,
      datePosted: dateFields.datePosted,
      employmentType,
    }),
  };
}

function normalizePermanentApplication(application, pageText, pageUrl) {
  const label = clean(application?.label || application?.title, 240);
  const description = clean(application?.description, 2000);
  const sourceText = plainSource(application?.sourceText || label);
  if (!label || !sourceText || !exactSourceEvidence(sourceText, pageText)) return null;
  return {
    label,
    description,
    sourceText,
    applyUrl: sameOriginUrl(application?.applyUrl, pageUrl),
    via: FREE_TEXT_MODE,
  };
}

function promptFor(pageText, context) {
  const company = clean(context.companyName, 240) || 'datore di lavoro non specificato';
  return [
    'Sei un estrattore conservativo di offerte di lavoro da una pagina pubblica.',
    'Rispondi esclusivamente con JSON conforme allo schema fornito, senza markdown.',
    'Estrai una vacancy solo se la pagina annuncia esplicitamente un ruolo concreto e attuale.',
    'sourceText deve essere una frase o un blocco CONTIGUO copiato dalla pagina, con spazi normalizzati.',
    `description deve essere composta da almeno ${FREE_TEXT_DESCRIPTION_MIN_WORDS} parole, usare soltanto fatti presenti nella pagina e spiegare ruolo, attività, requisiti o candidatura senza inventare dati.`,
    'Non inventare stipendio, data, sede, tipo di contratto o URL: lascia il campo vuoto se la pagina non li fornisce.',
    'Una candidatura spontanea, candidatura permanente, candidatura non sollecitata o “cerchiamo soluzioni” va esclusivamente in permanentApplications e mai in vacancies.',
    `Non confondere il datore ${company} con prodotti, servizi, promozioni o richieste generiche.`,
    'Se non esiste una vacancy concreta, restituisci vacancies: [].',
    `Pagina sorgente:\n${pageText.slice(0, MAX_SOURCE_CHARS)}`,
  ].join('\n\n');
}

async function defaultCallLLM(messages, options) {
  const { callLLM } = await import('../ai-models.mjs');
  return callLLM(messages, options);
}

/**
 * Extract and validate free-text offers. The homepage hiring signal is a hard
 * precondition and is checked before the AI module is even loaded.
 */
export async function extractFreeTextOffers(html, pageUrl, context = {}) {
  if (!hasHomepageHiringSignal(html)) {
    return {
      vacancies: [],
      permanentApplications: [],
      skipped: 'no-homepage-hiring-signal',
      contractVersion: FREE_TEXT_CONTRACT_VERSION,
    };
  }
  const pageText = bodyTextOf(html).slice(0, MAX_SOURCE_CHARS);
  const callLLM = context.callLLM || defaultCallLLM;
  let response;
  try {
    response = await callLLM([
      { role: 'system', content: 'Estrai offerte di lavoro da testo libero in modo source-grounded e conservativo.' },
      { role: 'user', content: promptFor(pageText, context) },
    ], {
      jsonMode: true,
      jsonSchema: { name: 'prospector_free_text_offers_v1', schema: FREE_TEXT_RESPONSE_SCHEMA },
      temperature: 0,
      maxTokens: 2200,
      timeout: context.timeout ?? 45000,
    });
  } catch (error) {
    return {
      vacancies: [],
      permanentApplications: [],
      contractVersion: FREE_TEXT_CONTRACT_VERSION,
      llmFailure: String(error?.message || error || 'llm_failed').slice(0, 300),
      reasonCode: 'free_text_llm_failure',
    };
  }
  const parsed = parseJsonResponse(response);
  if (!parsed || !Array.isArray(parsed.vacancies) || !Array.isArray(parsed.permanentApplications)) {
    return {
      vacancies: [],
      permanentApplications: [],
      contractVersion: FREE_TEXT_CONTRACT_VERSION,
      llmFailure: 'invalid_free_text_response_shape',
      reasonCode: 'free_text_llm_failure',
    };
  }
  const permanentApplications = parsed.permanentApplications
    .map((application) => normalizePermanentApplication(application, pageText, pageUrl))
    .filter(Boolean)
    .slice(0, 12);
  const vacancies = [];
  const rejected = [];
  for (const raw of parsed.vacancies.slice(0, 24)) {
    const checked = validateFreeTextOffer(raw, { html, pageUrl, context });
    if (!checked.valid) {
      rejected.push(checked.reason);
      continue;
    }
    const url = stableOfferUrl(pageUrl, checked.title, checked.sourceText);
    vacancies.push({
      title: checked.title,
      url,
      sourceUrl: pageUrl,
      sourceText: checked.sourceText,
      freeTextSourceText: checked.sourceText,
      freeTextSourceUrl: pageUrl,
      description: checked.description,
      company: checked.company,
      location: checked.location.location,
      addressLocality: checked.location.addressLocality,
      addressRegion: checked.location.addressRegion,
      addressCountry: checked.location.addressCountry || 'CH',
      postalCode: checked.location.postalCode,
      streetAddress: checked.location.streetAddress,
      locationCandidates: [checked.location],
      ...checked.dateFields,
      employmentType: checked.employmentType,
      applyUrl: checked.applyUrl,
      structuredDataContract: checked.structuredDataContract,
      freeTextContractVersion: FREE_TEXT_CONTRACT_VERSION,
      via: FREE_TEXT_MODE,
    });
  }
  return {
    vacancies,
    permanentApplications,
    contractVersion: FREE_TEXT_CONTRACT_VERSION,
    ...(rejected.length ? { rejectedReasons: rejected } : {}),
    ...(permanentApplications.length && !vacancies.length ? { reasonCode: 'permanent_application_only' } : {}),
  };
}

/** @param {Record<string, any>} spec */
export function isFreeTextSpec(spec) {
  return spec?.mode === FREE_TEXT_MODE
    && (spec?.freeTextContractVersion == null
      || Number(spec.freeTextContractVersion) === FREE_TEXT_CONTRACT_VERSION);
}
