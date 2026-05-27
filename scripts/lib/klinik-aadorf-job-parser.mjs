#!/usr/bin/env node
/**
 * Klinik Aadorf job parser — Dualoo ATS (portal 3ibnwlo9).
 *
 * Public career site: https://jobs.dualoo.com/portal/3ibnwlo9?lang=DE
 *
 * Klinik Aadorf AG is a private psychiatric and psychotherapeutic
 * specialist clinic (Privatklinik für Psychiatrie und Psychotherapie)
 * in Aadorf (canton Thurgau). Small Dualoo portal, ~4-5 vacancies,
 * mostly medical & residential staff (Assistenzarzt, Facharzt /
 * Oberarzt, Koch, Praktikant Psychologie).
 *
 * Modelled on `scripts/lib/klinik-arlesheim-job-parser.mjs` (same
 * Dualoo HTML shape).
 */
import { createHash } from 'node:crypto';
import { detectLang } from './dedicated-crawler-common.mjs';
import { slugify } from './crawler-template.mjs';
import {
  fetchHtml,
  decodeEntities,
  normalizeSpace,
  detectHealthcareCategory,
  detectHealthcareExperienceLevel,
  detectHealthcareEmploymentType,
} from './hospital-custom-html-helpers.mjs';

export const KLINIK_AADORF_KEY = 'klinik-aadorf';
export const KLINIK_AADORF_COMPANY_NAME = 'Klinik Aadorf';
export const KLINIK_AADORF_COMPANY_DOMAIN = 'klinik-aadorf.ch';

const DUALOO_PORTAL = '3ibnwlo9';
const PORTAL_URL = `https://jobs.dualoo.com/portal/${DUALOO_PORTAL}?lang=DE`;
const DETAIL_BASE = `https://jobs.dualoo.com/portal/${DUALOO_PORTAL}`;
const DETAIL_DELAY_MS = 250;

// Aadorf, Thurgau — single site.
const DEFAULT_CITY = 'Aadorf';
const DEFAULT_POSTAL_CODE = '8355';
const DEFAULT_CANTON = 'TG';

export function isKlinikAadorfJob(job) {
  const url = String(job?.url || '').toLowerCase();
  return (
    job?.companyKey === KLINIK_AADORF_KEY ||
    url.includes('klinik-aadorf.ch') ||
    url.includes(`/${DUALOO_PORTAL}/`)
  );
}

export function isTrustedDomain(rawUrl = '') {
  try {
    const host = new URL(rawUrl).hostname.toLowerCase();
    return (
      host === 'klinik-aadorf.ch' ||
      host.endsWith('.klinik-aadorf.ch') ||
      host === 'jobs.dualoo.com'
    );
  } catch {
    return false;
  }
}

export function parseDualooPortal(html) {
  const out = [];
  const seen = new Set();
  const blockRe = /<a[^>]*class="[^"]*\bjobElement\b[^"]*"[^>]*>[\s\S]*?<\/a>/g;
  let m;
  while ((m = blockRe.exec(html))) {
    const block = m[0];
    const hrefMatch = block.match(/\shref="([^"]+)"/);
    const evMatch = block.match(/\sdata-eventData="([^"]+)"/);
    const spanMatch = block.match(/<span[^>]*class="jobName"[^>]*>([\s\S]*?)<\/span>/i);
    const cityMatch = block.match(/<span[^>]*class="cityName"[^>]*>([\s\S]*?)<\/span>/i);
    const catMatch = block.match(/<span[^>]*class="badge[^"]*jobCategory"[^>]*>([\s\S]*?)<\/span>/i);
    if (!hrefMatch) continue;
    const rel = hrefMatch[1];
    let meta = {};
    if (evMatch) {
      const evRaw = evMatch[1].replace(/&quot;/g, '"').replace(/&amp;/g, '&');
      try {
        meta = JSON.parse(evRaw);
      } catch {
        meta = {};
      }
    }
    const spanTitle = spanMatch
      ? normalizeSpace(decodeEntities(spanMatch[1].replace(/<[^>]+>/g, ' ')))
      : '';
    const evTitle = normalizeSpace(decodeEntities(String(meta.jobName || '')));
    const title = spanTitle || evTitle;
    if (!title || title.length < 3) continue;
    const uuidMatch = rel.match(/([a-f0-9-]{36})\/detail/);
    const uuid = uuidMatch ? uuidMatch[1] : rel;
    if (seen.has(uuid)) continue;
    seen.add(uuid);
    const url = rel.startsWith('http')
      ? rel
      : `${DETAIL_BASE}/${rel.replace(new RegExp(`^${DUALOO_PORTAL}/`), '')}`;
    const cityName = cityMatch
      ? normalizeSpace(decodeEntities(cityMatch[1].replace(/<[^>]+>/g, ' ')))
      : '';
    const category = catMatch
      ? normalizeSpace(decodeEntities(catMatch[1].replace(/<[^>]+>/g, ' ')))
      : '';
    const langMatch = url.match(/[?&]lang=([A-Za-z]{2,3})/i);
    const linkLang = langMatch ? langMatch[1].toLowerCase() : '';
    out.push({
      uuid,
      url,
      title,
      cityName,
      category,
      location: normalizeSpace(decodeEntities(String(meta.location || ''))),
      startDate: normalizeSpace(decodeEntities(String(meta.startDate || ''))),
      linkLang,
    });
  }
  return out;
}

async function fetchDualooDetail(detailUrl) {
  try {
    const html = await fetchHtml(detailUrl);
    const sections = [];
    const grab = (cls, label) => {
      const rx = new RegExp(`class="${cls}"[^>]*>([\\s\\S]*?)</div>`, 'i');
      const mm = html.match(rx);
      if (!mm) return;
      const text = mm[1]
        .replace(/<li[^>]*>/gi, '\n• ')
        .replace(/<\/li>/gi, '')
        .replace(/<br\s*\/?>/gi, '\n')
        .replace(/<[^>]+>/g, ' ')
        .replace(/&nbsp;/gi, ' ')
        .replace(/\s+\n/g, '\n')
        .replace(/\s{2,}/g, ' ')
        .trim();
      if (text) sections.push(`${label}\n${text}`);
    };
    grab('advertisementResponsibilitiesText', 'Aufgaben:');
    grab('advertisementRequirementsText', 'Anforderungen:');
    grab('advertisementBenefitsText', 'Wir bieten:');
    return sections.join('\n\n');
  } catch {
    return '';
  }
}

export async function fetchAllKlinikAadorfJobs() {
  console.log(`🏥 Fetching ${KLINIK_AADORF_COMPANY_NAME} jobs`);
  console.log(`   Portal: ${PORTAL_URL}\n`);
  const html = await fetchHtml(PORTAL_URL);
  const items = parseDualooPortal(html);
  console.log(`  ✓ ${items.length} Dualoo job cards parsed`);
  if (!items.length) return [];
  console.log(`  📄 Fetching detail pages for rich descriptions...`);

  const todayIso = new Date().toISOString().slice(0, 10);
  const jobs = [];
  let detailHits = 0;
  for (let i = 0; i < items.length; i += 1) {
    const it = items[i];
    if (i > 0) await new Promise((r) => setTimeout(r, DETAIL_DELAY_MS));
    const detailContent = await fetchDualooDetail(it.url);
    if (detailContent) detailHits += 1;

    const description = [
      detailContent,
      it.cityName || it.location ? `Standort: ${it.cityName || it.location}` : '',
      it.category ? `Kategorie: ${it.category}` : '',
      it.startDate ? `Eintritt: ${it.startDate}` : '',
      `${KLINIK_AADORF_COMPANY_NAME} — Privatklinik für Psychiatrie und Psychotherapie, ${DEFAULT_CITY} (${DEFAULT_CANTON}), Schweiz.`,
    ]
      .filter(Boolean)
      .join('\n\n');

    const linkLangHint =
      it.linkLang === 'en'
        ? 'en'
        : it.linkLang === 'fr'
          ? 'fr'
          : it.linkLang === 'it'
            ? 'it'
            : 'de';
    const sourceLang = detectLang(description || it.title, linkLangHint);
    const jobSlug = slugify(`${it.title} ${KLINIK_AADORF_KEY} ${DEFAULT_CITY}`);
    const urlHash = createHash('sha1').update(it.url).digest('hex').slice(0, 12);

    jobs.push({
      id: `${KLINIK_AADORF_KEY}-${urlHash}`,
      slug: jobSlug,
      slugByLocale: { [sourceLang]: jobSlug },
      company: KLINIK_AADORF_COMPANY_NAME,
      companyKey: KLINIK_AADORF_KEY,
      companyDomain: KLINIK_AADORF_COMPANY_DOMAIN,
      title: it.title,
      titleByLocale: { [sourceLang]: it.title },
      description,
      descriptionByLocale: { [sourceLang]: description },
      needsRetranslation: true,
      location: DEFAULT_CITY,
      canton: DEFAULT_CANTON,
      url: it.url,
      source: `${KLINIK_AADORF_COMPANY_NAME} Dedicated Parser (Dualoo)`,
      sourceLang,
      crawledAt: new Date().toISOString(),
      addressLocality: DEFAULT_CITY,
      addressRegion: DEFAULT_CANTON,
      addressCountry: 'CH',
      country: 'CH',
      postalCode: DEFAULT_POSTAL_CODE,
      category: detectHealthcareCategory(`${it.title} ${it.category}`),
      contract: 'full-time',
      employmentType: detectHealthcareEmploymentType(it.title),
      experienceLevel: detectHealthcareExperienceLevel(it.title),
      sector: 'Sanità / Ospedali',
      currency: 'CHF',
      featured: false,
      postedDate: todayIso,
      applyUrl: it.url,
      requirements: [],
      requirementsByLocale: { [sourceLang]: [] },
    });
  }
  console.log(
    `📋 Total ${KLINIK_AADORF_COMPANY_NAME} jobs discovered: ${jobs.length} (${detailHits}/${items.length} with rich detail content)`,
  );
  return jobs;
}

export { PORTAL_URL, DUALOO_PORTAL };
