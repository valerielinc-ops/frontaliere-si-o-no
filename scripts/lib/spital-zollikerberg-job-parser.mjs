#!/usr/bin/env node
/**
 * Spital Zollikerberg job parser.
 *
 * Public career site:
 *   https://gesundheitswelt-zollikerberg.ch/de/jobs-karriere/offene-stellen
 *
 * Next.js SSR page that renders one card per job. Each card is an anchor that
 * points to the external pi-asp.de (P&I) ATS:
 *
 *   <a target="_blank" href="https://stiftdia.pi-asp.de/bewerber-web?company=1-FIRMA-ID&tenant=&lang=DS#position,id={UUID},jobportalid=7d51b858-e466-400d-8696-5e01d3b26140">
 *     ... > Spital Zollikerberg {TITLE} {CATEGORY} ...
 *   </a>
 *
 * The card text inside the anchor (after stripping HTML and normalising
 * whitespace) follows the convention:
 *
 *   "> Spital Zollikerberg {TITLE} {CATEGORY}"
 *
 * Spital Zollikerberg is a 1'100-employee acute hospital + maternity in
 * Zollikerberg (ZH) — part of the Gesundheitswelt Zollikerberg group.
 *
 * Polite delay: 250 ms between detail-page fetches (pi-asp.de detail pages
 * are SPA-only, but the listing card already carries enough text for the
 * intro paragraph + category, so we use the listing text as description
 * source and skip the per-job fetch).
 */
import { createHash } from 'node:crypto';
import { detectLang } from './dedicated-crawler-common.mjs';
import { slugify } from './crawler-template.mjs';
import {
  fetchHtml,
  decodeEntities,
  normalizeSpace,
  htmlToText,
  detectHealthcareCategory,
  detectHealthcareExperienceLevel,
  detectHealthcareEmploymentType,
} from './hospital-custom-html-helpers.mjs';

export const SPITAL_ZOLLIKERBERG_KEY = 'spital-zollikerberg';
export const SPITAL_ZOLLIKERBERG_COMPANY_NAME = 'Spital Zollikerberg';
export const SPITAL_ZOLLIKERBERG_COMPANY_DOMAIN = 'spitalzollikerberg.ch';

const PUBLIC_CAREER_URL = 'https://gesundheitswelt-zollikerberg.ch/de/jobs-karriere/offene-stellen';
const JOB_PORTAL_ID = '7d51b858-e466-400d-8696-5e01d3b26140';
const COMPANY_PREFIX = 'Spital Zollikerberg';

export function isSpitalZollikerbergJob(job) {
  const url = String(job?.url || '').toLowerCase();
  if (job?.companyKey === SPITAL_ZOLLIKERBERG_KEY) return true;
  if (url.includes('spitalzollikerberg.ch') || url.includes('gesundheitswelt-zollikerberg.ch')) return true;
  if (url.includes('stiftdia.pi-asp.de') && url.includes(JOB_PORTAL_ID)) return true;
  return false;
}

export function isTrustedDomain(rawUrl = '') {
  try {
    const host = new URL(rawUrl).hostname.toLowerCase();
    if (host === 'spitalzollikerberg.ch' || host.endsWith('.spitalzollikerberg.ch')) return true;
    if (host === 'gesundheitswelt-zollikerberg.ch' || host.endsWith('.gesundheitswelt-zollikerberg.ch')) return true;
    if (host === 'stiftdia.pi-asp.de') return true;
    return false;
  } catch {
    return false;
  }
}

/**
 * Extract one row per `<a href="...stiftdia.pi-asp.de/bewerber-web?...,
 * jobportalid={JOB_PORTAL_ID}">` link.
 *
 * The anchor body (after HTML strip) starts with `> Spital Zollikerberg` and
 * ends with the category label (e.g. "Pflegeberufe"). We isolate title and
 * category.
 */
export function parseListing(html) {
  const out = [];
  const seen = new Set();
  const anchorRe = /<a\b[^>]+href="(https:\/\/stiftdia\.pi-asp\.de\/bewerber-web[^"]*)"[\s\S]*?<\/a>/gi;
  let m;
  while ((m = anchorRe.exec(html))) {
    const rawUrl = m[1].replace(/&amp;/g, '&');
    if (!rawUrl.includes(`jobportalid=${JOB_PORTAL_ID}`)) continue;
    const text = normalizeSpace(htmlToText(m[0]));
    if (!text) continue;
    // Strip leading ">" and the company prefix.
    let body = text.replace(/^>\s*/, '').trim();
    if (body.startsWith(COMPANY_PREFIX)) body = body.slice(COMPANY_PREFIX.length).trim();
    if (!body) continue;
    // The category is always the last token block — common values:
    // "Pflegeberufe", "Ärztlicher Dienst", "Therapie", "Verwaltung",
    // "Reinigung", "Ausbildung". Heuristic: split on multiple whitespace and
    // pull the trailing 1–3 words if they look like a category.
    const tokens = body.split(' ');
    let category = '';
    for (const tail of [3, 2, 1]) {
      if (tokens.length <= tail) continue;
      const cand = tokens.slice(-tail).join(' ');
      if (/^(Pflegeberufe|Ärztlicher Dienst|Therapie|Verwaltung|Reinigung|Ausbildung|Hauswirtschaft|Hotellerie|Technik|IT|MTRA|Personal)$/i.test(cand)) {
        category = cand;
        body = tokens.slice(0, -tail).join(' ').trim();
        break;
      }
    }
    const title = body;
    if (!title || title.length < 5) continue;
    const idMatch = rawUrl.match(/[?&#]id=([0-9a-f-]{20,})/i);
    const jobId = idMatch ? idMatch[1] : createHash('sha1').update(rawUrl).digest('hex').slice(0, 16);
    if (seen.has(jobId)) continue;
    seen.add(jobId);
    out.push({ url: rawUrl, title, category, jobId });
  }
  return out;
}

export async function fetchAllSpitalZollikerbergJobs() {
  console.log(`🏥 Fetching ${SPITAL_ZOLLIKERBERG_COMPANY_NAME} jobs`);
  console.log(`   Source: ${PUBLIC_CAREER_URL}\n`);

  const html = await fetchHtml(PUBLIC_CAREER_URL);
  const rows = parseListing(html);
  console.log(`  ✓ ${rows.length} jobs from listing page`);
  if (!rows.length) return [];

  const todayIso = new Date().toISOString().slice(0, 10);
  const jobs = [];
  for (const r of rows) {
    const description = [
      `${r.title} — ${SPITAL_ZOLLIKERBERG_COMPANY_NAME}, Zollikerberg (ZH).`,
      r.category ? `Bereich: ${r.category}.` : '',
      'Das Spital Zollikerberg ist ein Akutspital mit ca. 1\'100 Mitarbeitenden im Zürcher Oberland (Standort Zollikerberg). Es gehört zur Gesundheitswelt Zollikerberg und betreibt eine ausgezeichnete Geburtenstation, Innere Medizin, Chirurgie sowie Spezialambulatorien.',
      'Vollständige Stellenbeschreibung und Bewerbung über die externe Bewerber-Plattform.',
    ].filter(Boolean).join('\n\n');
    const sourceLang = detectLang(description || r.title, 'de');
    const jobSlug = slugify(`${r.title} ${SPITAL_ZOLLIKERBERG_KEY} zollikerberg`);
    const urlHash = createHash('sha1').update(r.url).digest('hex').slice(0, 12);

    jobs.push({
      id: `${SPITAL_ZOLLIKERBERG_KEY}-${urlHash}`,
      slug: jobSlug,
      slugByLocale: { [sourceLang]: jobSlug },
      company: SPITAL_ZOLLIKERBERG_COMPANY_NAME,
      companyKey: SPITAL_ZOLLIKERBERG_KEY,
      companyDomain: SPITAL_ZOLLIKERBERG_COMPANY_DOMAIN,
      title: r.title,
      titleByLocale: { [sourceLang]: r.title },
      description,
      descriptionByLocale: { [sourceLang]: description },
      // Newly-discovered jobs ship with source-locale-only fields. The shared
      // AI-localization step clears this flag when it fills the remaining 3
      // locales; if it can't (cache miss + AI quota), the flag stays and
      // `translate-pending.yml` picks the job up out-of-band. Without this
      // flag the locale-completeness gate trips before translation can run.
      needsRetranslation: true,
      location: 'Zollikerberg',
      canton: 'ZH',
      url: r.url,
      source: `${SPITAL_ZOLLIKERBERG_COMPANY_NAME} Dedicated Parser (Next.js SSR)`,
      sourceLang,
      crawledAt: new Date().toISOString(),

      addressLocality: 'Zollikerberg',
      addressRegion: 'ZH',
      addressCountry: 'CH',
      country: 'CH',
      postalCode: '8125',
      category: detectHealthcareCategory(`${r.title} ${r.category}`),
      contract: 'full-time',
      employmentType: detectHealthcareEmploymentType(r.title),
      experienceLevel: detectHealthcareExperienceLevel(r.title),
      sector: 'Sanità / Ospedali',
      currency: 'CHF',
      featured: false,
      postedDate: todayIso,
      applyUrl: r.url,
      requirements: [],
      requirementsByLocale: { [sourceLang]: [] },
    });
  }

  console.log(`\n📋 Total ${SPITAL_ZOLLIKERBERG_COMPANY_NAME} jobs discovered: ${jobs.length}`);
  return jobs;
}

export { PUBLIC_CAREER_URL, JOB_PORTAL_ID };
