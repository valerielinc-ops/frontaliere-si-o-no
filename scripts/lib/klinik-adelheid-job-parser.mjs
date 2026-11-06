#!/usr/bin/env node
import {
  sourcePostingDateCandidatesFields,
  sourcePostingDateFields,
} from './source-posting-date.mjs';
import {
  extractJobPostingLd,
  jobPostingAddress,
  jobPostingDescriptionText,
} from './jsonld-jobposting.mjs';
/**
 * Klinik Adelheid (ZG) job parser — Ostendis JobPublisher.
 *
 * Public career site: https://www.klinik-adelheid.ch/jobs-karriere/offene-jobs/
 *   → Ostendis JSON feed → individual publications at link.ostendis.com
 *
 * The career page embeds the publication-place token. The crawler resolves
 * Ostendis' current feed version instead of pinning a transient vNN endpoint,
 * then reads each publication's JobPosting JSON-LD.
 *
 * Klinik Adelheid AG is a 140-bed musculoskeletal/neurological/oncological/
 * geriatric rehabilitation clinic above Lake Ägeri (Unterägeri, 6314, canton
 * ZG). Part of the Gemeinnützige Gesellschaft Zug. ~18 open positions at
 * parser creation, all German-language.
 */
import { createHash } from 'node:crypto';
import { detectLang } from './dedicated-crawler-common.mjs';
import { fetchJson, slugify } from './crawler-template.mjs';
import {
  fetchHtml,
  decodeEntities,
  normalizeSpace,
  detectHealthcareCategory,
  detectHealthcareExperienceLevel,
  detectHealthcareEmploymentType,
} from './hospital-custom-html-helpers.mjs';
import { meetsSourceBodyFloor } from './source-body-floor.mjs';

export const KLINIK_ADELHEID_KEY = 'klinik-adelheid';
export const KLINIK_ADELHEID_COMPANY_NAME = 'Klinik Adelheid';

// Complete lines only: the old fallback wrote the title/company line, the
// listing's "Bereich" line and this exact clinic paragraph.
export const KLINIK_ADELHEID_FABRICATED_DESCRIPTION_RE = /^(?:[^\r\n]+ — Klinik Adelheid, Unterägeri \(ZG\)\.|Bereich: [^\r\n]+\.|Die Klinik Adelheid ist eine 140-Betten Rehabilitationsklinik der Zentralschweiz mit Spezialisierung in muskuloskelettaler, neurologischer, internistisch-onkologischer und geriatrischer Rehabilitation\.)[ \t]*\r?$/m;
const KLINIK_ADELHEID_FABRICATED_LINE_RE = /^(?:[^\r\n]+ — Klinik Adelheid, Unterägeri \(ZG\)\.|Bereich: [^\r\n]+\.|Die Klinik Adelheid ist eine 140-Betten Rehabilitationsklinik der Zentralschweiz mit Spezialisierung in muskuloskelettaler, neurologischer, internistisch-onkologischer und geriatrischer Rehabilitation\.)[ \t]*\r?\n?/gm;

export function stripKlinikAdelheidFabricatedDescription(text = '') {
  return String(text)
    .replace(KLINIK_ADELHEID_FABRICATED_LINE_RE, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
export const KLINIK_ADELHEID_COMPANY_DOMAIN = 'klinik-adelheid.ch';

const PUBLIC_CAREER_URL = 'https://www.klinik-adelheid.ch/jobs-karriere/offene-jobs/';
const OSTENDIS_BASE = 'https://odm.ostendis.com';
const OSTENDIS_LANG = 'DE';
const OSTENDIS_DOMAIN = 'www.klinik-adelheid.ch';

export function isKlinikAdelheidJob(job) {
  if (job?.companyKey === KLINIK_ADELHEID_KEY) return true;
  const url = String(job?.url || '').toLowerCase();
  return url.includes('klinik-adelheid.ch');
}

export function isTrustedDomain(rawUrl = '') {
  try {
    const host = new URL(rawUrl).hostname.toLowerCase();
    return host === 'klinik-adelheid.ch'
      || host.endsWith('.klinik-adelheid.ch')
      || host === 'link.ostendis.com';
  } catch {
    return false;
  }
}

/** Extract the Ostendis publication-place token from the career page. */
export function extractOstendisToken(html = '') {
  const embed = String(html).match(/OSTENDISJOBS\.embed\(\s*["']([a-z0-9]{16,})["']/i);
  if (embed) return embed[1];
  return String(html).match(/data-token=["']([a-z0-9]{16,})["']/i)?.[1] || null;
}

/** Parse the Ostendis `jobs[]` payload into the listing boundary we consume. */
export function parseAdelheidListing(payload = {}) {
  if (!Array.isArray(payload?.jobs)) {
    throw new Error('Klinik Adelheid Ostendis feed is missing jobs[]');
  }
  const out = [];
  const seen = new Set();
  for (const entry of payload.jobs) {
    const title = normalizeSpace(decodeEntities(entry?.title || ''));
    const detailUrl = normalizeSpace(entry?.detail || '');
    if (title.length < 3 || !isTrustedDomain(detailUrl) || seen.has(detailUrl)) continue;
    const rawApplyUrl = normalizeSpace(entry?.action || '');
    seen.add(detailUrl);
    out.push({
      id: entry?.id ?? null,
      title,
      bereich: normalizeSpace(decodeEntities(entry?.department || '')),
      detailUrl,
      applyUrl: isTrustedDomain(rawApplyUrl) ? rawApplyUrl : detailUrl,
      published: normalizeSpace(entry?.published || ''),
    });
  }
  return out;
}

export async function fetchAllKlinikAdelheidJobs() {
  console.log(`🏥 Fetching ${KLINIK_ADELHEID_COMPANY_NAME} jobs`);
  console.log(`   Source: ${PUBLIC_CAREER_URL}\n`);

  const careerHtml = await fetchHtml(PUBLIC_CAREER_URL);
  const token = extractOstendisToken(careerHtml);
  if (!token) throw new Error('Klinik Adelheid career page has no Ostendis token');

  const versionPayload = await fetchJson(`${OSTENDIS_BASE}/ojp/assets/version/${token}`);
  const version = normalizeSpace(versionPayload?.version || '');
  if (!/^v\d+$/.test(version)) {
    throw new Error(`Unexpected Klinik Adelheid Ostendis version: ${version || '(missing)'}`);
  }

  const feedUrl = `${OSTENDIS_BASE}/ojp/data/${version}/jobs/${token}/${OSTENDIS_LANG}?domain=${OSTENDIS_DOMAIN}`;
  const rows = parseAdelheidListing(await fetchJson(feedUrl));
  console.log(`  ✓ ${rows.length} jobs from listing`);
  if (!rows.length) return [];

  const jobs = [];
  let detailHits = 0;

  for (const row of rows) {
    let description = '';
    let publication = sourcePostingDateFields(row.published);
    let address = {};
    let detailEmploymentType = '';
    try {
      const detailHtml = await fetchHtml(row.detailUrl);
      const posting = extractJobPostingLd(detailHtml);
      description = jobPostingDescriptionText(posting?.description || '');
      publication = sourcePostingDateCandidatesFields([posting?.datePosted, row.published]);
      address = jobPostingAddress(posting);
      const employmentTypes = Array.isArray(posting?.employmentType)
        ? posting.employmentType
        : [posting?.employmentType].filter(Boolean);
      detailEmploymentType = employmentTypes.includes('FULL_TIME')
        ? 'FULL_TIME'
        : employmentTypes.includes('PART_TIME')
          ? 'PART_TIME'
          : '';
      if (description) detailHits++;
    } catch (err) {
      console.log(`     ⚠ detail fetch failed for ${row.detailUrl}: ${err.message}`);
    }
    await new Promise((r) => setTimeout(r, 200));

    // A listing without its own rich publication body is not publishable.
    // Returning no rows keeps the runner fail-closed instead of fabricating
    // copy or reporting a healthy crawl from listing metadata alone.
    if (!meetsSourceBodyFloor(description)) continue;

    const sourceLang = detectLang(description || row.title, 'de');
    const jobSlug = slugify(`${row.title} ${KLINIK_ADELHEID_KEY} unteraegeri`);
    const idSource = row.id == null ? row.detailUrl : String(row.id);
    const urlHash = createHash('sha1').update(idSource).digest('hex').slice(0, 12);
    const employmentType = detailEmploymentType || detectHealthcareEmploymentType(row.title);
    const location = address.addressLocality || 'Unterägeri';

    jobs.push({
      id: `${KLINIK_ADELHEID_KEY}-${urlHash}`,
      slug: jobSlug,
      slugByLocale: { [sourceLang]: jobSlug },
      company: KLINIK_ADELHEID_COMPANY_NAME,
      companyKey: KLINIK_ADELHEID_KEY,
      companyDomain: KLINIK_ADELHEID_COMPANY_DOMAIN,
      title: row.title,
      titleByLocale: { [sourceLang]: row.title },
      description,
      descriptionByLocale: { [sourceLang]: description },
      // Newly-discovered jobs ship with source-locale-only fields. The shared
      // AI-localization step clears this flag when it fills the remaining 3
      // locales; if it can't (cache miss + AI quota), the flag stays and
      // `translate-pending.yml` picks the job up out-of-band. Without this
      // flag the locale-completeness gate trips before translation can run.
      needsRetranslation: true,
      location,
      canton: 'ZG',
      url: row.detailUrl,
      source: `${KLINIK_ADELHEID_COMPANY_NAME} Dedicated Parser (Ostendis JobPublisher)`,
      sourceLang,
      crawledAt: new Date().toISOString(),

      addressLocality: location,
      addressRegion: 'ZG',
      addressCountry: 'CH',
      country: 'CH',
      postalCode: address.postalCode || '6314',
      streetAddress: address.streetAddress || 'Höhenweg 71',
      category: detectHealthcareCategory(`${row.title} ${row.bereich}`),
      contract: employmentType === 'PART_TIME' ? 'part-time' : 'full-time',
      employmentType,
      experienceLevel: detectHealthcareExperienceLevel(row.title),
      sector: 'Sanità / Ospedali',
      currency: 'CHF',
      featured: false,
      ...publication,
      applyUrl: row.applyUrl,
      requirements: [],
      requirementsByLocale: { [sourceLang]: [] },
    });
  }

  console.log(`\n📋 Total ${KLINIK_ADELHEID_COMPANY_NAME} jobs discovered: ${jobs.length} (${detailHits}/${rows.length} with rich detail content)`);
  return jobs;
}

export { PUBLIC_CAREER_URL };
