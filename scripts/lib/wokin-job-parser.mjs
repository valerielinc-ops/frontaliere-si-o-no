#!/usr/bin/env node
/**
 * WOKIN GmbH — official self-hosted Stellen page in Frauenfeld (TG).
 *
 * Vacancy facts come from https://wokin.ch/stellen/. The page publishes only
 * a short role card, so the description also includes the restaurant context
 * copied from the employer's official homepage. Nothing is synthesised: if
 * either source fragment disappears, or their combined text does not clear the
 * shared source-body floor, the vacancy is not emitted.
 */
import { JSDOM } from 'jsdom';
import { fetchHtml, slugify } from './crawler-template.mjs';
import { meetsSourceBodyFloor } from './source-body-floor.mjs';
import { sourcePostingDateFields } from './source-posting-date.mjs';

export const WOKIN_KEY = 'wokin';
export const WOKIN_COMPANY_NAME = 'WOKIN GmbH';
export const WOKIN_COMPANY_DOMAIN = 'wokin.ch';
export const WOKIN_STELLEN_URL = 'https://wokin.ch/stellen/';
export const WOKIN_HOMEPAGE_URL = 'https://wokin.ch/';

const SOURCE_LANG = 'de';
// Match the German forms used by the aggregate matcher: a published workload
// range or an explicit restaurant/service qualifier. Bare `Servicemitarbeiter`
// also describes customer-service roles and must not become a waiter job.
const SERVICE_TITLE_RE = /\b(?:servicemitarbeiter(?:\/in)?\s+\d{1,3}\s*[–-]\s*\d{1,3}\s*%|servicehilfskraft\s+(?:rastaurant|restaurant)|restaurantangestellt|kellner)/i;
const RESTAURANT_CONTEXT_PREFIX = 'Unser Restaurant bietet mehr als nur chinesisches Essen.';

function normalizeSpace(value = '') {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

export function isTrustedDomain(rawUrl = '') {
  try {
    const url = new URL(rawUrl);
    return url.protocol === 'https:'
      && (url.hostname === WOKIN_COMPANY_DOMAIN || url.hostname.endsWith(`.${WOKIN_COMPANY_DOMAIN}`));
  } catch {
    return false;
  }
}

export function isWokinJob(job) {
  return String(job?.companyKey || '').toLowerCase() === WOKIN_KEY
    || normalizeSpace(job?.company).toLowerCase() === WOKIN_COMPANY_NAME.toLowerCase()
    || isTrustedDomain(job?.url || '');
}

export function isWokinServiceTitle(title = '') {
  return SERVICE_TITLE_RE.test(normalizeSpace(title));
}

/**
 * Parse only service/restaurant vacancies. The same official page also lists
 * kitchen roles; those are deliberately outside the cameriere:TG slice.
 */
export function parseWokinStellenPage(html = '') {
  if (!html) return { vacancies: [], applicationText: '' };
  const { document } = new JSDOM(html).window;
  const main = document.querySelector('main#tm-main, main');
  if (!main) return { vacancies: [], applicationText: '' };

  const applicationText = [...main.querySelectorAll('p')]
    .map((node) => normalizeSpace(node.textContent))
    .find((text) => /^Haben wir dein Interesse geweckt\?/i.test(text)) || '';

  const vacancies = [];
  for (const heading of main.querySelectorAll('h3.el-title, h3')) {
    const title = normalizeSpace(heading.textContent);
    if (!isWokinServiceTitle(title)) continue;
    const card = heading.closest('.uk-panel') || heading.parentElement;
    const locationLabel = normalizeSpace(card?.querySelector('.el-meta')?.textContent || '');
    const locationMatch = /^Arbeitsort:\s*(.+)$/i.exec(locationLabel);
    const availability = normalizeSpace(card?.querySelector('.el-content')?.textContent || '');
    if (!locationMatch || !availability) continue;
    vacancies.push({
      title,
      location: normalizeSpace(locationMatch[1]),
      locationLabel,
      availability,
      url: WOKIN_STELLEN_URL,
    });
  }

  return { vacancies, applicationText };
}

/** Employer-authored context used verbatim; unrelated menu/footer text is ignored. */
export function parseWokinEmployerContext(html = '') {
  if (!html) return '';
  const { document } = new JSDOM(html).window;
  return [...document.querySelectorAll('main p')]
    .map((node) => normalizeSpace(node.textContent))
    .find((text) => text.startsWith(RESTAURANT_CONTEXT_PREFIX)) || '';
}

export function buildWokinJob(vacancy, employerContext, applicationText, now = new Date()) {
  const title = normalizeSpace(vacancy?.title);
  const location = normalizeSpace(vacancy?.location);
  const sourceParts = [
    title,
    normalizeSpace(vacancy?.locationLabel),
    normalizeSpace(vacancy?.availability),
    normalizeSpace(employerContext),
    normalizeSpace(applicationText),
  ].filter(Boolean);
  const description = sourceParts.join('\n\n');

  if (!isWokinServiceTitle(title) || location !== 'Frauenfeld') return null;
  if (vacancy?.url !== WOKIN_STELLEN_URL || !isTrustedDomain(vacancy.url)) return null;
  if (!meetsSourceBodyFloor(description)) return null;

  const slug = slugify(`${title} WOKIN Frauenfeld`);
  return {
    id: `${WOKIN_KEY}-service-frauenfeld`,
    slug,
    slugByLocale: { [SOURCE_LANG]: slug },
    company: WOKIN_COMPANY_NAME,
    companyKey: WOKIN_KEY,
    companyDomain: WOKIN_COMPANY_DOMAIN,
    title,
    titleByLocale: { [SOURCE_LANG]: title },
    description,
    descriptionByLocale: { [SOURCE_LANG]: description },
    needsRetranslation: true,
    location,
    canton: 'TG',
    addressLocality: location,
    addressRegion: 'TG',
    addressCountry: 'CH',
    country: 'CH',
    postalCode: '',
    streetAddress: '',
    url: WOKIN_STELLEN_URL,
    applyUrl: WOKIN_STELLEN_URL,
    source: 'WOKIN Dedicated Parser (official Stellen and employer context)',
    sourceLang: SOURCE_LANG,
    crawledAt: now.toISOString(),
    ...sourcePostingDateFields('', now),
    hiringOrganizationName: WOKIN_COMPANY_NAME,
    category: 'Cameriere',
    sector: 'Ristorazione / Ospitalita',
    contract: 'other',
    employmentType: 'OTHER',
    experienceLevel: 'mid',
    currency: 'CHF',
    featured: false,
    requirements: [],
    requirementsByLocale: { [SOURCE_LANG]: [] },
  };
}

export async function fetchAllWokinJobs() {
  const timeoutMs = Number(process.env.JOBS_CRAWLER_TIMEOUT_MS) || 20000;
  const [stellenHtml, homepageHtml] = await Promise.all([
    fetchHtml(WOKIN_STELLEN_URL, { timeoutMs }),
    fetchHtml(WOKIN_HOMEPAGE_URL, { timeoutMs }),
  ]);
  const { vacancies, applicationText } = parseWokinStellenPage(stellenHtml);
  const employerContext = parseWokinEmployerContext(homepageHtml);

  if (vacancies.length > 1) {
    throw new Error('WOKIN exposes multiple service vacancies under one non-anchored URL; refusing duplicate URL identities');
  }

  const now = new Date();
  const jobs = vacancies
    .map((vacancy) => buildWokinJob(vacancy, employerContext, applicationText, now))
    .filter(Boolean);
  console.log(`WOKIN official service vacancies in Frauenfeld: ${jobs.length}`);
  return jobs;
}
