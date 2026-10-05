#!/usr/bin/env node
/**
 * Vitrea Gesundheit (formerly VAMED Schweiz) job parser.
 *
 * Public career site: https://www.vitrea-gesundheit.ch/karriere
 *                   → https://vamed-ag-ch.onlyfy.jobs/ (softgarden onlyfy.jobs)
 *
 * Vitrea Gesundheit operates several Swiss rehab/care facilities including
 * Rehaklinik Seewis (covered separately via Rehaklinik Seewis parser?).
 * The onlyfy.jobs portal serves listings server-side with the redesigned
 * card markup (shared with Spitex Zürich), parsed by `parseOnlyfyListing`:
 *   <a data-testid="job-card" aria-label="{Title}" href="/{lang}/job/{hash}">
 *     <h3 data-testid="job-title">{Title}</h3>
 *     <div data-testid="job-more-info">{Location} | {Type} | {Date}</div>
 *
 * Detail pages live at `https://vamed-ag-ch.onlyfy.jobs/{lang}/job/{hash}` and
 * carry rich description sections (Aufgaben/Profil/Wir bieten).
 */
import { sourcePostingDateFields } from './source-posting-date.mjs';
import { createHash } from 'node:crypto';
import { detectLang } from './dedicated-crawler-common.mjs';
import { slugify } from './crawler-template.mjs';
import {
  fetchHtml,
  detectHealthcareCategory,
  detectHealthcareExperienceLevel,
  detectHealthcareEmploymentType,
} from './hospital-custom-html-helpers.mjs';
import { parseOnlyfyListing, onlyfyFullAdUrl, extractOnlyfyJobAdText, isOnlyfyJobAdText } from './onlyfy-listing-common.mjs';
import { inferAnyCanton } from './target-swiss-locations.mjs';

export const VITREA_GESUNDHEIT_KEY = 'vitrea-gesundheit';
export const VITREA_GESUNDHEIT_COMPANY_NAME = 'Vitrea Gesundheit';
export const VITREA_GESUNDHEIT_COMPANY_DOMAIN = 'vitrea-gesundheit.ch';

const PORTAL_BASE = 'https://vamed-ag-ch.onlyfy.jobs';
const LISTING_URL = `${PORTAL_BASE}/`;
const POLITE_DELAY_MS = 250;

export function isVitreaGesundheitJob(job) {
  const url = String(job?.url || '').toLowerCase();
  return job?.companyKey === VITREA_GESUNDHEIT_KEY
    || url.includes('vitrea-gesundheit.ch')
    || url.includes('vamed-ag-ch.onlyfy.jobs');
}

export function isTrustedDomain(rawUrl = '') {
  try {
    const host = new URL(rawUrl).hostname.toLowerCase();
    return host === 'vitrea-gesundheit.ch'
      || host.endsWith('.vitrea-gesundheit.ch')
      || host === 'vamed-ag-ch.onlyfy.jobs';
  } catch {
    return false;
  }
}

export function parseVitreaListing(html) {
  // onlyfy.jobs redesigned card markup — shared parser keeps this tenant in
  // lockstep with Spitex Zürich (both broke identically on the old selector).
  return parseOnlyfyListing(html, { portalBase: PORTAL_BASE, defaultLocation: 'Schweiz' });
}

// The detail URL is a client-rendered shell; the ad itself is the onlyfy
// `/job/show/{handle}/full` document (see onlyfyFullAdUrl). The former
// `<p>/<li>` sweep of the shell (capped at 30 fragments) never reached the
// role text, so every vacancy fell back to a stub the parser wrote itself.
async function fetchDetailContent(url) {
  const adUrl = onlyfyFullAdUrl(url);
  if (!adUrl) return '';
  try {
    return extractOnlyfyJobAdText(await fetchHtml(adUrl));
  } catch {
    return '';
  }
}

function inferCantonFromLocation(loc) {
  // "Seewis" (Vitrea HQ Rehaklinik) isn't a BFS-registered municipality alias
  // inferAnyCanton recognizes, so it's kept as an explicit signal ahead of
  // the shared BFS-backed resolver (all 26 cantons, fuzzy-tolerant) — see
  // AGENTS.md #6 sibling class shared with pallas-kliniken/sodexo/mcdonalds.
  const l = String(loc).toLowerCase();
  if (/seewis/.test(l)) return 'GR';
  return inferAnyCanton(l) || 'GR'; // Vitrea HQ Rehaklinik Seewis is GR
}

export async function fetchAllVitreaGesundheitJobs() {
  console.log(`🏥 Fetching ${VITREA_GESUNDHEIT_COMPANY_NAME} jobs`);
  console.log(`   Portal: ${LISTING_URL}\n`);
  const html = await fetchHtml(LISTING_URL);
  const items = parseVitreaListing(html);
  console.log(`  ✓ ${items.length} jobs from softgarden onlyfy listing`);
  if (!items.length) return [];
  console.log(`  📄 Fetching detail pages for rich descriptions...`);

  const jobs = [];
  let detailHits = 0;
  for (const it of items) {
    const rawDetail = await fetchDetailContent(it.url);
    // The text comes from this vacancy's own ad document (addressed by its
    // handle, scoped to the ad template), not from a page that could be
    // listing chrome, so the shell-era title-overlap heuristic does not apply:
    // on the sibling Spitex Zürich tenant it rejected "Ausbildungsplatz Dipl.
    // Pflegefachfrau/-mann HF 2026/2027" because the ad says "Pflegefachperson".
    // Only the ad itself: a consent, cookie or error page, or a body under the
    // 50-word floor, is not the vacancy's text (isOnlyfyJobAdText).
    const detailContent = isOnlyfyJobAdText(rawDetail) ? String(rawDetail).trim() : '';
    if (detailContent) detailHits++;
    await new Promise((r) => setTimeout(r, POLITE_DELAY_MS));
    // The ad as published, plus the listing's workload.
    // Without the ad the parser used to write a stub of its own ("<Titel> bei
    // Vitrea Gesundheit, <Ort>, Schweiz." with Standort/Bereich/Bewerbung bullets,
    // VITREA_GESUNDHEIT_FABRICATED_DESCRIPTION_RE); a vacancy without text now gets no
    // description and takes the pipeline's thin-source path.
    const description = detailContent
      ? [
        detailContent,
        it.employmentTypeStr ? `• Arbeitszeit: ${it.employmentTypeStr}` : '',
      ].filter(Boolean).join('\n\n')
      : '';

    const canton = inferCantonFromLocation(it.location);
    const sourceLang = detectLang(description || it.title, 'de');
    const jobSlug = slugify(`${it.title} ${VITREA_GESUNDHEIT_KEY} ${it.location}`);
    const urlHash = createHash('sha1').update(it.url).digest('hex').slice(0, 12);

    jobs.push({
      id: `${VITREA_GESUNDHEIT_KEY}-${urlHash}`,
      slug: jobSlug,
      slugByLocale: { [sourceLang]: jobSlug },
      company: VITREA_GESUNDHEIT_COMPANY_NAME,
      companyKey: VITREA_GESUNDHEIT_KEY,
      companyDomain: VITREA_GESUNDHEIT_COMPANY_DOMAIN,
      title: it.title,
      titleByLocale: { [sourceLang]: it.title },
      description,
      descriptionByLocale: { [sourceLang]: description },
      // Newly-discovered jobs ship with source-locale-only fields. The shared
      // AI-localization step clears this flag when it fills the remaining 3
      // locales; if it can't, `translate-pending.yml` picks the job up.
      needsRetranslation: true,
      location: it.location,
      canton,
      url: it.url,
      source: 'Vitrea Gesundheit Dedicated Parser (softgarden onlyfy.jobs)',
      sourceLang,
      crawledAt: new Date().toISOString(),
      addressLocality: it.location,
      addressRegion: canton,
      addressCountry: 'CH',
      country: 'CH',
      postalCode: '',
      category: detectHealthcareCategory(it.title),
      contract: 'full-time',
      employmentType: detectHealthcareEmploymentType(it.employmentTypeStr + ' ' + it.title),
      experienceLevel: detectHealthcareExperienceLevel(it.title),
      sector: 'Sanità / Ospedali',
      currency: 'CHF',
      featured: false,
      ...sourcePostingDateFields(''),
      applyUrl: it.url,
      requirements: [],
      requirementsByLocale: { [sourceLang]: [] },
    });
  }
  console.log(`📋 Total ${VITREA_GESUNDHEIT_COMPANY_NAME} jobs discovered: ${jobs.length} (${detailHits}/${items.length} with rich detail content)`);
  return jobs;
}

/**
 * The whole stub the parser used to write without the ad: "<Titel> bei Vitrea
 * Gesundheit (ehemals VAMED Schweiz), <Ort>, Schweiz." and its
 * Arbeitszeit/Standort/Bereich/Bewerbung bullets, and nothing else. Anchored
 * at both ends, so an ad that quotes one of these lines is never taken for it.
 */
export const VITREA_GESUNDHEIT_FABRICATED_DESCRIPTION_RE =
  /^[^\n]{3,300} bei Vitrea Gesundheit \(ehemals VAMED Schweiz\), [^\n]{0,120}, Schweiz\.\n\n(?:• Arbeitszeit: [^\n]{1,120}\n)?• Standort: [^\n]{0,120}\n• Bereich: Rehabilitations- und Pflegedienstleistungen\n• Bewerbung über das softgarden onlyfy\.jobs-Karriereportal von Vitrea Gesundheit\s*$/;
