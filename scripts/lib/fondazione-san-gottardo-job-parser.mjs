#!/usr/bin/env node
/**
 * Fondazione San Gottardo job parser.
 *
 * Source: https://www.fsangottardo.ch/lavoro
 *
 * The source page is a Joomla article. Its "Posizioni disponibili" block is
 * deliberately parsed as a bounded section: the same page also contains a
 * spontaneous-application form, HR documents and news links, none of which
 * are vacancies. The separately labelled pre-SUPSI stage is emitted as an
 * internship opportunity, while an explicit vacancy-empty sentence is still
 * carried to the standard crawler as a source-proven zero when no opportunity
 * is present. An unfamiliar page shape remains a selector miss and therefore
 * cannot retire an existing slice.
 */
import { createHash } from 'node:crypto';
import { JSDOM } from 'jsdom';
import { detectLang } from './dedicated-crawler-common.mjs';
import {
  fetchHtml,
  normalizeSpace,
  slugify,
  stripHtml,
} from './crawler-template.mjs';
import { inferSwissTargetCanton } from './target-swiss-locations.mjs';
import { getCompanyDefaults } from './crawler-location-config.mjs';
import { meetsSourceBodyFloor } from './source-body-floor.mjs';
import { mergeSourcePostingDates } from './source-posting-date.mjs';
import { markAuthoritativeEmptySnapshot } from './authoritative-empty-snapshot.mjs';
import { stripContactPII } from './strip-contact-pii.mjs';

/* ── Constants ─────────────────────────────────────────────── */

export const FONDAZIONE_SAN_GOTTARDO_KEY = 'fondazione-san-gottardo';
export const FONDAZIONE_SAN_GOTTARDO_COMPANY_NAME = 'Fondazione San Gottardo';
export const FONDAZIONE_SAN_GOTTARDO_COMPANY_DOMAIN = 'fsangottardo.ch';
export const FONDAZIONE_SAN_GOTTARDO_CAREER_URL = 'https://www.fsangottardo.ch/lavoro';
export const FONDAZIONE_SAN_GOTTARDO_INTERNSHIP_TITLE = 'Stage pre SUPSI (9 mesi)';

const HQ = getCompanyDefaults(FONDAZIONE_SAN_GOTTARDO_KEY) || {
  city: 'Lopagno',
  canton: 'TI',
  postalCode: '6956',
  addressRegion: 'TI',
};

const USER_AGENT = process.env.JOBS_CRAWLER_USER_AGENT
  || 'FrontaliereTicinoJobCrawler/1.0 (+https://frontaliereticino.ch/)';

const EMPTY_POSITION_RE = /(?:attualmente\s+)?non\s+(?:abbiamo|ci\s+sono)\s+posizion(?:e|i)\b/i;
const POSITION_HEADING_RE = /^posizioni\s+disponibili\s*:?$/i;
const INTERNSHIP_HEADING_RE = /^accettiamo\s+candidature\s+per\s*:?$/i;
const INTERNSHIP_TITLE_RE = /\bstage\s+pre\s+SUPSI\s*\(\s*9\s+mesi\s*\)/i;
const SECTION_STOP_RE = /^(?:accettiamo\s+candidature\s+per|candidature\s+spontanee|documenti\s+utili|formulario\s+per\s+l['’]inoltro)/i;
const GENERIC_LINK_RE = /^(?:clicca\s+qui|qui|leggi(?:\s+il)?|scopri(?:\s+di\s+pi[uù])?|dettagli?|vai|visualizza|apri|maggiori\s+informazioni|concorso|bando)$/i;
const GENERIC_TITLE_RE = /^(?:concorso(?:\s+assunzione\s+personale)?|bando|lavora\s+con\s+noi|candidature?|posizioni?\s+disponibili)$/i;
const DETAIL_PATH_RE = /\/(?:concorsi?|offerte?|lavoro|jobs?|careers?|posizioni?|vacan[cz]e?)\//i;
const LOCATION_RE = /\b(?:Lopagno|Barbengo|Bedano|Bellinzona|Biasca|Canobbio|Caslano|Giubiasco|Lugano|Melano|Massagno|Mendrisio|Pregassona|Tesserete|Torricella|Treggia|Ticino)\b/i;

/* ── Helpers ───────────────────────────────────────────────── */

function normalize(value = '') {
  return String(value || '').trim().toLowerCase();
}

function textOf(node) {
  return normalizeSpace(node?.textContent || '');
}

function canonicalUrl(rawUrl = '', baseUrl = FONDAZIONE_SAN_GOTTARDO_CAREER_URL) {
  try {
    const url = new URL(rawUrl, baseUrl);
    url.hash = '';
    return url.href;
  } catch {
    return '';
  }
}

function isSamePage(rawUrl = '', pageUrl = FONDAZIONE_SAN_GOTTARDO_CAREER_URL) {
  try {
    const a = new URL(rawUrl, pageUrl);
    const b = new URL(pageUrl);
    return a.origin === b.origin
      && a.pathname.replace(/\/+$/, '') === b.pathname.replace(/\/+$/, '')
      && a.search === b.search;
  } catch {
    return false;
  }
}

function isSectionStop(node) {
  return SECTION_STOP_RE.test(textOf(node));
}

function isGenericTitle(title = '') {
  const value = normalizeSpace(title).replace(/[.:：]+$/, '');
  return !value || GENERIC_TITLE_RE.test(value);
}

function toPlainText(value = '') {
  return normalizeSpace(stripHtml(String(value || '')));
}

function firstNonEmpty(...values) {
  return values.map((value) => normalizeSpace(value)).find(Boolean) || '';
}

function sourceExtractionError(message, discoveredCount = 0) {
  const error = new Error(message);
  error.specListingFailure = true;
  error.specDiscoveredCount = discoveredCount;
  return error;
}

function fetchOptions(language = 'it-CH') {
  return {
    timeoutMs: Number(process.env.JOBS_CRAWLER_TIMEOUT_MS) || 20_000,
    headers: {
      Accept: 'text/html,application/xhtml+xml',
      'Accept-Language': `${language},it;q=0.8,en;q=0.4`,
      'User-Agent': USER_AGENT,
    },
  };
}

/* ── Company Matchers ──────────────────────────────────────── */

export function isFondazioneSanGottardoJob(job) {
  const key = normalize(job?.companyKey || job?.company || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  const company = normalize(job?.company || '');
  const url = normalize(job?.url || '');

  return key === FONDAZIONE_SAN_GOTTARDO_KEY
    || key.startsWith(`${FONDAZIONE_SAN_GOTTARDO_KEY}-`)
    || company.includes('fondazione san gottardo')
    || url.includes('fsangottardo.ch');
}

export function isTrustedDomain(rawUrl = '') {
  try {
    const host = new URL(rawUrl).hostname.toLowerCase();
    return host === FONDAZIONE_SAN_GOTTARDO_COMPANY_DOMAIN
      || host.endsWith(`.${FONDAZIONE_SAN_GOTTARDO_COMPANY_DOMAIN}`);
  } catch {
    return false;
  }
}

/* ── Source-page boundary and listing discovery ────────────── */

function findCareersPanel(document) {
  const heading = [...document.querySelectorAll('h1, h2, h3')]
    .find((node) => /candidature|lavora\s+con\s+noi/i.test(textOf(node)));
  if (!heading) return null;

  return heading.closest('.uk-panel, article, [role="main"], main') || heading.parentElement;
}

function findPositionHeading(panel) {
  if (!panel) return null;
  const candidates = [...panel.querySelectorAll('p, h2, h3, h4, strong')];
  return candidates.find((node) => POSITION_HEADING_RE.test(textOf(node))) || null;
}

function siblingSectionBoundary(marker) {
  if (!marker) return null;
  // In the live Joomla layout the marker is a <strong> inside a <p>. Use the
  // smallest semantic block so the following HR and vacancy list remain in
  // the same bounded sibling sequence.
  const start = marker.closest('p, h2, h3, h4') || marker;
  const parent = start.parentElement;
  if (!parent) return null;

  const children = [...parent.children];
  const startIndex = children.indexOf(start);
  if (startIndex < 0) return null;

  const nodes = [];
  for (const node of children.slice(startIndex + 1)) {
    if (isSectionStop(node)) break;
    nodes.push(node);
  }

  return { marker, start, parent, nodes };
}

function positionBoundary(panel) {
  return siblingSectionBoundary(findPositionHeading(panel));
}

function findInternshipHeading(panel) {
  if (!panel) return null;
  const candidates = [...panel.querySelectorAll('p, h2, h3, h4, strong')];
  return candidates.find((node) => INTERNSHIP_HEADING_RE.test(textOf(node))) || null;
}

function internshipBoundary(panel) {
  return siblingSectionBoundary(findInternshipHeading(panel));
}

function titleFromAnchor(anchor) {
  const direct = textOf(anchor);
  if (direct && !GENERIC_LINK_RE.test(direct)) return direct;

  const card = anchor.closest('li, .el-item, .uk-card, .job, [class*="job"], [class*="concor"]');
  if (!card) return direct;
  const heading = card.querySelector('h2, h3, h4, h5, strong');
  return firstNonEmpty(textOf(heading), direct);
}

function isVacancyLink(anchor, pageUrl) {
  const rawHref = anchor.getAttribute('href') || '';
  const href = canonicalUrl(rawHref, pageUrl);
  if (!href || !isTrustedDomain(href) || isSamePage(href, pageUrl)) return false;
  if (/^(?:mailto|javascript):/i.test(rawHref)) return false;
  if (/\.(?:pdf|docx?|xlsx?)($|[?#])/i.test(new URL(href).pathname)) return false;

  const title = titleFromAnchor(anchor);
  if (!title || isGenericTitle(title)) return false;

  // The anchor is already inside the bounded positions block. Prefer known
  // vacancy paths but allow a future Joomla route when its anchor has a real
  // role title; that keeps the parser tolerant to harmless URL migrations.
  const pathAndText = `${new URL(href).pathname} ${title}`;
  return DETAIL_PATH_RE.test(pathAndText) || title.length >= 8;
}

/**
 * Extract the vacancy inventory from the careers page only.
 *
 * @returns {{status: 'ok'|'empty'|'selector_miss', candidates: object[], opportunities: object[], evidence?: string, sectionText: string}}
 */
export function parseCareersPage(html = '', pageUrl = FONDAZIONE_SAN_GOTTARDO_CAREER_URL) {
  if (!String(html || '').trim()) {
    return { status: 'selector_miss', candidates: [], opportunities: [], sectionText: '' };
  }

  const dom = new JSDOM(html);
  try {
    const panel = findCareersPanel(dom.window.document);
    const boundary = positionBoundary(panel);
    if (!boundary) {
      return { status: 'selector_miss', candidates: [], opportunities: [], sectionText: '' };
    }

    const sectionText = normalizeSpace(boundary.nodes.map(textOf).filter(Boolean).join(' '));
    const internshipSection = internshipBoundary(panel);
    const internshipSectionText = internshipSection
      ? normalizeSpace(internshipSection.nodes.map(textOf).filter(Boolean).join(' '))
      : '';
    const stageOption = [...panel.querySelectorAll('select option')]
      .map(textOf)
      .find((value) => INTERNSHIP_TITLE_RE.test(value));
    const opportunities = INTERNSHIP_TITLE_RE.test(internshipSectionText)
      ? [{
        title: FONDAZIONE_SAN_GOTTARDO_INTERNSHIP_TITLE,
        sectionText: internshipSectionText,
        positionSectionText: sectionText,
        applicationLabel: stageOption ? FONDAZIONE_SAN_GOTTARDO_INTERNSHIP_TITLE : '',
        sourceUrl: canonicalUrl(pageUrl, FONDAZIONE_SAN_GOTTARDO_CAREER_URL),
      }]
      : [];
    const anchors = boundary.nodes.flatMap((node) => [...node.querySelectorAll('a[href]')]);
    const candidates = [];
    const seen = new Set();

    for (const anchor of anchors) {
      if (!isVacancyLink(anchor, pageUrl)) continue;
      const url = canonicalUrl(anchor.getAttribute('href') || '', pageUrl);
      if (seen.has(url)) continue;
      seen.add(url);
      const title = titleFromAnchor(anchor);
      const card = anchor.closest('li, .el-item, .uk-card, .job, [class*="job"], [class*="concor"]');
      candidates.push({
        title,
        url,
        snippet: card ? textOf(card) : textOf(anchor.parentElement),
      });
    }

    if (candidates.length > 0) {
      return { status: 'ok', candidates, opportunities, sectionText };
    }

    if (EMPTY_POSITION_RE.test(sectionText)) {
      return {
        status: 'empty',
        candidates: [],
        opportunities,
        sectionText,
        evidence: `Fondazione San Gottardo: la sezione "Posizioni disponibili" dichiara esplicitamente: ${sectionText}`,
      };
    }

    // A present section without a supported empty marker is not evidence of
    // zero jobs. It is a parser/source drift and must keep the prior slice.
    return { status: 'selector_miss', candidates: [], opportunities: [], sectionText };
  } finally {
    dom.window.close();
  }
}

/* ── Detail-page extraction ───────────────────────────────── */

function jsonLdValues(document) {
  const values = [];
  for (const script of document.querySelectorAll('script[type="application/ld+json"]')) {
    try {
      const parsed = JSON.parse(script.textContent || '');
      const visit = (value) => {
        if (Array.isArray(value)) {
          for (const item of value) visit(item);
        } else if (value && typeof value === 'object') {
          values.push(value);
          if (value['@graph']) visit(value['@graph']);
        }
      };
      visit(parsed);
    } catch {
      // The rest of the HTML remains a valid fallback if a site script is not
      // valid JSON-LD.
    }
  }
  return values;
}

function isJobPosting(value) {
  const type = value?.['@type'];
  return type === 'JobPosting' || (Array.isArray(type) && type.includes('JobPosting'));
}

function structuredJobPosting(document) {
  return jsonLdValues(document).find(isJobPosting) || null;
}

function tableFields(document) {
  const fields = new Map();
  for (const row of document.querySelectorAll('tr')) {
    const cells = [...row.querySelectorAll('th, td')].map(textOf).filter(Boolean);
    if (cells.length < 2) continue;
    const label = normalize(cells[0]);
    const value = normalizeSpace(cells.slice(1).join(' '));
    if (label && value) fields.set(label, value);
  }
  return fields;
}

function firstStructuredLocation(posting) {
  const raw = Array.isArray(posting?.jobLocation) ? posting.jobLocation[0] : posting?.jobLocation;
  const address = raw?.address || raw;
  return {
    locality: firstNonEmpty(address?.addressLocality, raw?.name),
    region: firstNonEmpty(address?.addressRegion),
    postalCode: firstNonEmpty(address?.postalCode),
    streetAddress: firstNonEmpty(address?.streetAddress),
  };
}

function roleFromFunctionField(value = '') {
  const text = normalizeSpace(value);
  if (!text) return '';
  const withoutLeadingLabel = text.replace(/^funzione\s*[:|-]?\s*/i, '');
  const role = withoutLeadingLabel.split(/\s+(?=(?:principalmente|presso|sede|luogo|struttura|ambito|a\s+|in\s+)?(?:casa|cà|centro|orto|progetti|via\b|l[’']?opagno\b|lugano\b|barbengo\b))/i)[0];
  return normalizeSpace(role || withoutLeadingLabel).replace(/[,:;|—–-]+\s*$/, '');
}

function findLocation(value = '') {
  const match = String(value || '').match(LOCATION_RE);
  return match ? match[0] : '';
}

function detailContainer(document) {
  const main = document.querySelector('#tm-main, main, [role="main"]') || document.body;
  const heading = [...main.querySelectorAll('h1, h2, h3')]
    .find((node) => textOf(node).length >= 3);
  return heading?.closest('.uk-panel, article, .item-page') || main;
}

function detailText(document) {
  const container = detailContainer(document).cloneNode(true);
  for (const node of container.querySelectorAll('script, style, noscript, form, nav, header, footer, aside, .tm-header, .tm-footer')) {
    node.remove();
  }
  return toPlainText(container.innerHTML);
}

function applicationUrl(document, pageUrl) {
  for (const anchor of detailContainer(document).querySelectorAll('a[href]')) {
    const text = textOf(anchor);
    const href = canonicalUrl(anchor.getAttribute('href') || '', pageUrl);
    if (href && /candidat|applic|postul|invia/i.test(`${text} ${href}`)) return href;
  }
  return pageUrl;
}

function employmentType(text = '') {
  const value = normalize(text);
  if (/part.?time|tempo\s+parziale|tempo\s+ridotto/.test(value)) return 'PART_TIME';
  if (/full.?time|tempo\s+pi[eè]no|100\s*%/.test(value)) return 'FULL_TIME';
  return 'OTHER';
}

function categoryFor(title = '') {
  const value = normalize(title);
  if (/educator|educatore|operatore|assistente|sociale|accompagn/.test(value)) return 'Sociale e sanità';
  if (/manut|tecnic|infrastruttur|cuoc|cucin/.test(value)) return 'Tecnica';
  if (/amministr|contab|risorse\s+umane|segretar/.test(value)) return 'Amministrazione';
  return 'Altro';
}

function internshipDescription(opportunity) {
  const positionContext = EMPTY_POSITION_RE.test(opportunity.positionSectionText || '')
    ? 'La stessa pagina specifica che attualmente non ci sono posizioni disponibili separate da questa candidatura di stage.'
    : 'La stessa pagina presenta questa candidatura in una sezione distinta dalle posizioni disponibili.';
  const applicationContext = opportunity.applicationLabel
    ? `Per candidarsi, la Fondazione chiede di selezionare la dicitura corretta "${opportunity.applicationLabel}" nel campo "tipo di candidatura" del formulario presente sulla stessa pagina.`
    : 'Per inoltrare la candidatura, occorre consultare le istruzioni e il formulario ufficiali riportati sulla pagina della Fondazione.';

  return toPlainText([
    `La ${FONDAZIONE_SAN_GOTTARDO_COMPANY_NAME} accetta candidature per lo ${opportunity.title}.`,
    positionContext,
    'La voce pubblicata dalla Fondazione identifica il percorso attraverso il riferimento alla SUPSI e la durata di nove mesi, senza associare una mansione specifica a questa candidatura.',
    applicationContext,
  ].join(' '));
}

/**
 * Turn the source's explicit pre-SUPSI stage entry into a publishable
 * internship record. It deliberately keeps the official careers page as both
 * source and application URL: the source does not expose a separate detail
 * page for this opportunity.
 */
function buildInternshipOpportunity(opportunity, pageUrl) {
  const url = canonicalUrl(opportunity?.sourceUrl || pageUrl, pageUrl);
  if (!url || !isTrustedDomain(url)) return null;

  const title = opportunity?.title || FONDAZIONE_SAN_GOTTARDO_INTERNSHIP_TITLE;
  const description = internshipDescription({
    ...opportunity,
    title,
  });
  if (!meetsSourceBodyFloor(description)) return null;

  const sourceLang = detectLang(description, 'it');
  const hash = createHash('sha1').update(`${url}#${title}`).digest('hex').slice(0, 12);
  const jobSlug = slugify(`${title} ${HQ.city} ${FONDAZIONE_SAN_GOTTARDO_KEY} ch`);

  return {
    id: `${FONDAZIONE_SAN_GOTTARDO_KEY}-stage-${hash}`,
    slug: jobSlug,
    slugByLocale: { [sourceLang]: jobSlug },
    company: FONDAZIONE_SAN_GOTTARDO_COMPANY_NAME,
    companyKey: FONDAZIONE_SAN_GOTTARDO_KEY,
    companyDomain: FONDAZIONE_SAN_GOTTARDO_COMPANY_DOMAIN,
    title,
    titleByLocale: { [sourceLang]: title },
    description,
    descriptionByLocale: { [sourceLang]: description },
    location: HQ.city,
    canton: HQ.canton,
    addressLocality: HQ.city,
    addressRegion: HQ.addressRegion || HQ.canton,
    addressCountry: 'CH',
    country: 'CH',
    postalCode: HQ.postalCode,
    url,
    source: 'Fondazione San Gottardo Dedicated Parser (Internship Opportunity)',
    sourceLang,
    crawledAt: new Date().toISOString(),
    category: categoryFor(title),
    contract: 'internship',
    employmentType: 'INTERN',
    experienceLevel: 'intern',
    sector: 'Servizi sociali',
    currency: 'CHF',
    featured: false,
    applyUrl: url,
    requirements: [],
    requirementsByLocale: { [sourceLang]: [] },
  };
}

/**
 * Parse one linked Fondazione San Gottardo vacancy detail page.
 * Returns null when the page cannot provide a real title and a source body;
 * the caller then fails closed instead of publishing a guessed vacancy.
 */
export function parseDetailPage(html = '', pageUrl = '', candidate = {}) {
  if (!String(html || '').trim()) return null;
  const dom = new JSDOM(html);
  try {
    const { document } = dom.window;
    const posting = structuredJobPosting(document);
    const fields = tableFields(document);
    const structureValue = firstNonEmpty(
      fields.get('funzione struttura o ambito di lavoro'),
      fields.get('struttura o ambito di lavoro'),
      fields.get('luogo di lavoro'),
      fields.get('sede di lavoro'),
    );
    const employmentValue = firstNonEmpty(
      fields.get('funzione percentuale di impiego'),
      fields.get('percentuale di impiego'),
      fields.get('tasso di occupazione'),
    );
    const requirementsValue = firstNonEmpty(
      fields.get('funzione requisiti richiesti'),
      fields.get('requisiti richiesti'),
      fields.get('requisiti'),
    );

    const structuredLocation = firstStructuredLocation(posting);
    const heading = firstNonEmpty(
      posting?.title,
      ...[...document.querySelectorAll('h1, h2, h3')].map(textOf),
    );
    const title = isGenericTitle(heading)
      ? firstNonEmpty(roleFromFunctionField(structureValue), candidate.title)
      : heading;
    if (!title || isGenericTitle(title)) return null;

    const body = firstNonEmpty(posting?.description, detailText(document));
    const description = toPlainText(stripContactPII(body));
    if (!meetsSourceBodyFloor(description)) return null;

    const location = firstNonEmpty(
      structuredLocation.locality,
      findLocation(structureValue),
      findLocation(description),
      HQ.city,
    );
    const canton = inferSwissTargetCanton(
      [location, structuredLocation.region, structureValue, description].filter(Boolean).join(' '),
    ) || HQ.canton;
    const sourceLang = detectLang(description || title, 'it');
    const url = canonicalUrl(pageUrl, FONDAZIONE_SAN_GOTTARDO_CAREER_URL);
    if (!url || !isTrustedDomain(url)) return null;
    const hash = createHash('sha1').update(url).digest('hex').slice(0, 12);
    const jobSlug = slugify(`${title} ${location} ${FONDAZIONE_SAN_GOTTARDO_KEY} ch`);
    const type = employmentType(`${title} ${employmentValue} ${description}`);
    const publication = mergeSourcePostingDates({}, {
      datePosted: posting?.datePosted || '',
      postedDate: posting?.datePosted || '',
    });

    return {
      id: `${FONDAZIONE_SAN_GOTTARDO_KEY}-${hash}`,
      slug: jobSlug,
      slugByLocale: { [sourceLang]: jobSlug },
      company: FONDAZIONE_SAN_GOTTARDO_COMPANY_NAME,
      companyKey: FONDAZIONE_SAN_GOTTARDO_KEY,
      companyDomain: FONDAZIONE_SAN_GOTTARDO_COMPANY_DOMAIN,
      title,
      titleByLocale: { [sourceLang]: title },
      description,
      descriptionByLocale: { [sourceLang]: description },
      location,
      canton,
      addressLocality: location,
      addressRegion: structuredLocation.region || canton,
      addressCountry: 'CH',
      country: 'CH',
      postalCode: structuredLocation.postalCode || HQ.postalCode,
      ...(structuredLocation.streetAddress ? { streetAddress: structuredLocation.streetAddress } : {}),
      url,
      source: 'Fondazione San Gottardo Dedicated Parser',
      sourceLang,
      crawledAt: new Date().toISOString(),
      category: categoryFor(title),
      contract: type === 'PART_TIME' ? 'part-time' : type === 'FULL_TIME' ? 'full-time' : 'other',
      employmentType: type,
      experienceLevel: /stage|tirocin|apprendist/i.test(title) ? 'intern' : 'mid',
      sector: 'Servizi sociali',
      currency: 'CHF',
      featured: false,
      applyUrl: applicationUrl(document, url),
      requirements: requirementsValue ? [requirementsValue] : [],
      requirementsByLocale: { [sourceLang]: requirementsValue ? [requirementsValue] : [] },
      ...publication,
    };
  } finally {
    dom.window.close();
  }
}

/* ── Fetching and job construction ─────────────────────────── */

async function fetchCareerPage() {
  return fetchHtml(FONDAZIONE_SAN_GOTTARDO_CAREER_URL, fetchOptions());
}

async function fetchDetailPage(url) {
  return fetchHtml(url, fetchOptions());
}

/**
 * Fetch all currently linked vacancies and explicitly listed internship
 * opportunities from the official careers page.
 * `fetchPage` and `fetchDetail` are injectable so the parser can be tested
 * without network access.
 */
export async function fetchAllFondazioneSanGottardoJobs({
  fetchPage = fetchCareerPage,
  fetchDetail = fetchDetailPage,
} = {}) {
  console.log(`🔍 Fetching Fondazione San Gottardo jobs`);
  console.log(`   Source: ${FONDAZIONE_SAN_GOTTARDO_CAREER_URL}\n`);

  const html = await fetchPage();
  const inventory = parseCareersPage(html, FONDAZIONE_SAN_GOTTARDO_CAREER_URL);

  const opportunityJobs = [];
  for (const opportunity of inventory.opportunities || []) {
    const job = buildInternshipOpportunity(opportunity, FONDAZIONE_SAN_GOTTARDO_CAREER_URL);
    if (!job) {
      throw sourceExtractionError(
        `Fondazione San Gottardo internship opportunity did not expose a publishable source body: ${opportunity.title}`,
        inventory.candidates.length + (inventory.opportunities || []).length,
      );
    }
    opportunityJobs.push(job);
  }

  if (inventory.status === 'empty') {
    if (opportunityJobs.length === 0) {
      console.log(`  ✅ ${inventory.evidence}`);
      return markAuthoritativeEmptySnapshot([], inventory.evidence);
    }
    console.log(`  ✅ ${inventory.evidence}`);
    console.log(`  🎓 Internship opportunities found: ${opportunityJobs.length}`);
    return {
      jobs: opportunityJobs,
      discoveredCount: opportunityJobs.length,
      fetchOutcome: 'ok',
    };
  }

  if (inventory.status !== 'ok') {
    console.warn('⚠️ Fondazione San Gottardo vacancy section was not positively understood.');
    return { jobs: [], discoveredCount: 0, fetchOutcome: 'selector_miss' };
  }

  console.log(`  📋 Vacancy links found: ${inventory.candidates.length}`);
  if (opportunityJobs.length > 0) {
    console.log(`  🎓 Internship opportunities found: ${opportunityJobs.length}`);
  }
  const jobs = [...opportunityJobs];
  for (const candidate of inventory.candidates) {
    let detailHtml;
    try {
      detailHtml = await fetchDetail(candidate.url);
    } catch (error) {
      throw sourceExtractionError(
        `Fondazione San Gottardo detail fetch failed for ${candidate.url}: ${error?.message || error}`,
        inventory.candidates.length,
      );
    }

    const job = parseDetailPage(detailHtml, candidate.url, candidate);
    if (!job) {
      throw sourceExtractionError(
        `Fondazione San Gottardo detail page did not expose a publishable title/body: ${candidate.url}`,
        inventory.candidates.length,
      );
    }
    jobs.push(job);
  }

  console.log(`\n📋 Total Fondazione San Gottardo jobs discovered: ${jobs.length}`);
  return {
    jobs,
    discoveredCount: inventory.candidates.length + opportunityJobs.length,
    fetchOutcome: 'ok',
  };
}

export { categoryFor as detectCategory, employmentType as detectEmploymentType };
