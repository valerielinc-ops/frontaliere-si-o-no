#!/usr/bin/env node
/**
 * Modellstation SOMOSA (Winterthur, ZH) job parser.
 *
 * Public career page: https://www.somosa.ch/offene-stellen
 * Detail pages:       https://www.somosa.ch/offene-stellen-detail/{slug}
 *
 * SOMOSA is a child-and-adolescent psychiatric clinic + residential home
 * combining inpatient psychiatry, social pedagogy and ambulatory care for
 * adolescents 6–18 years. The site is built on Contao CMS; listings expose
 * <article>-style rows with a "Weiterlesen" anchor → /offene-stellen-detail/{slug}.
 *
 * No ATS — direct HTML scraping. Each detail page renders the canonical
 * job title in an <h1> + Aufgaben / Profil / Wir bieten sections in
 * `<div class="ce_text">` blocks.
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

export const MODELLSTATION_SOMOSA_KEY = 'modellstation-somosa';
export const MODELLSTATION_SOMOSA_COMPANY_NAME = 'Modellstation SOMOSA';
export const MODELLSTATION_SOMOSA_COMPANY_DOMAIN = 'somosa.ch';
export const MODELLSTATION_SOMOSA_CAREERS_URL =
  'https://www.somosa.ch/offene-stellen';

const DETAIL_BASE = 'https://www.somosa.ch';
const DETAIL_DELAY_MS = 250;

// Modellstation SOMOSA is based in Winterthur (canton Zürich).
const HQ_CITY = 'Winterthur';
const HQ_POSTAL = '8400';
const HQ_CANTON = 'ZH';

export function isModellstationSomosaJob(job) {
  const url = String(job?.url || '').toLowerCase();
  return (
    job?.companyKey === MODELLSTATION_SOMOSA_KEY ||
    url.includes('somosa.ch')
  );
}

export function isTrustedDomain(rawUrl = '') {
  try {
    const host = new URL(rawUrl).hostname.toLowerCase();
    return (
      host === MODELLSTATION_SOMOSA_COMPANY_DOMAIN ||
      host.endsWith(`.${MODELLSTATION_SOMOSA_COMPANY_DOMAIN}`)
    );
  } catch {
    return false;
  }
}

function blockToText(htmlFragment = '') {
  return decodeEntities(
    String(htmlFragment || '')
      .replace(/<li[^>]*>/gi, '\n• ')
      .replace(/<\/li>/gi, '')
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<\/(p|div|h\d|tr|table|ul|ol)>/gi, '\n')
      .replace(/<[^>]+>/g, ' ')
      .replace(/&nbsp;/gi, ' ')
      .replace(/[ \t]+/g, ' ')
      .replace(/\n[ \t]+/g, '\n')
      .replace(/[ \t]+\n/g, '\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim(),
  );
}

/**
 * Parse the SOMOSA listing page. Each job exposes a "Weiterlesen" link
 * (`href="offene-stellen-detail/{slug}" title="Den Artikel lesen: {TITLE}"`).
 */
export function parseSomosaListing(html = '') {
  const out = [];
  const seen = new Set();
  const rx =
    /href="(offene-stellen-detail\/[^"]+)"[^>]*\stitle="Den Artikel lesen:\s*([^"]+)"/g;
  let m;
  while ((m = rx.exec(html))) {
    const rel = m[1];
    const title = normalizeSpace(decodeEntities(m[2].replace(/&#40;|&#41;/g, (c) => (c === '&#40;' ? '(' : ')'))));
    if (!title || title.length < 3) continue;
    if (seen.has(rel)) continue;
    seen.add(rel);
    const url = `${DETAIL_BASE}/${rel}`;
    out.push({ url, title });
  }
  return out;
}

/**
 * Extract the main posting body from a detail page. SOMOSA uses Contao —
 * the meaningful content lives under <main> in a series of <div class="ce_text">
 * blocks, separated by section headers ("Ihr Aufgabengebiet", "Ihr Profil", …).
 */
function extractDetailContent(html = '') {
  const mainMatch = html.match(/<main[^>]*>([\s\S]*?)<\/main>/i);
  const region = mainMatch ? mainMatch[1] : html;

  const blocks = [];
  const blockRe =
    /<div[^>]*class="[^"]*\bce_(?:text|headline|rsce_[a-z_]+)\b[^"]*"[^>]*>([\s\S]*?)<\/div>(?=\s*<(?:div|\/div|section|footer|aside|main)|\s*$)/gi;
  let m;
  while ((m = blockRe.exec(region))) {
    const text = blockToText(m[1]);
    if (text && text.length > 8) blocks.push(text);
  }
  // Fallback: take all visible text under <main>
  if (blocks.length === 0) blocks.push(blockToText(region));

  // De-duplicate and drop UI scaffolding lines.
  const seen = new Set();
  const dedup = [];
  for (const b of blocks) {
    const key = b.toLowerCase();
    if (seen.has(key)) continue;
    if (/^(weiterlesen|drucken|teilen)$/i.test(b.trim())) continue;
    seen.add(key);
    dedup.push(b);
  }
  return dedup.join('\n\n').trim();
}

export async function fetchAllModellstationSomosaJobs() {
  console.log(`🏥 Fetching ${MODELLSTATION_SOMOSA_COMPANY_NAME} jobs`);
  console.log(`   Careers: ${MODELLSTATION_SOMOSA_CAREERS_URL}\n`);

  const listingHtml = await fetchHtml(MODELLSTATION_SOMOSA_CAREERS_URL);
  const items = parseSomosaListing(listingHtml);
  console.log(`  ✓ ${items.length} listing entries parsed`);
  if (!items.length) return [];

  const todayIso = new Date().toISOString().slice(0, 10);
  const jobs = [];
  let detailHits = 0;
  for (let i = 0; i < items.length; i += 1) {
    const it = items[i];
    if (i > 0) await new Promise((r) => setTimeout(r, DETAIL_DELAY_MS));
    let detailContent = '';
    try {
      const detailHtml = await fetchHtml(it.url);
      detailContent = extractDetailContent(detailHtml);
      if (detailContent) detailHits += 1;
    } catch (err) {
      console.warn(`  ⚠️ Detail fetch failed for ${it.url}: ${err?.message || err}`);
    }

    const description = [
      detailContent,
      `${MODELLSTATION_SOMOSA_COMPANY_NAME} — jugendpsychiatrische Klinik und Jugendheim für Adoleszente (6–18 Jahre), ${HQ_CITY} (${HQ_CANTON}), Schweiz.`,
    ]
      .filter(Boolean)
      .join('\n\n');

    const sourceLang = detectLang(detailContent || it.title, 'de');
    const jobSlug = slugify(`${it.title} ${MODELLSTATION_SOMOSA_KEY} ${HQ_CITY}`);
    const urlHash = createHash('sha1').update(it.url).digest('hex').slice(0, 12);

    jobs.push({
      id: `${MODELLSTATION_SOMOSA_KEY}-${urlHash}`,
      slug: jobSlug,
      slugByLocale: { [sourceLang]: jobSlug },
      company: MODELLSTATION_SOMOSA_COMPANY_NAME,
      companyKey: MODELLSTATION_SOMOSA_KEY,
      companyDomain: MODELLSTATION_SOMOSA_COMPANY_DOMAIN,
      title: it.title,
      titleByLocale: { [sourceLang]: it.title },
      description,
      descriptionByLocale: { [sourceLang]: description },
      needsRetranslation: true,
      location: HQ_CITY,
      canton: HQ_CANTON,
      url: it.url,
      source: `${MODELLSTATION_SOMOSA_COMPANY_NAME} Dedicated Parser (Contao)`,
      sourceLang,
      crawledAt: new Date().toISOString(),
      addressLocality: HQ_CITY,
      addressRegion: HQ_CANTON,
      addressCountry: 'CH',
      country: 'CH',
      postalCode: HQ_POSTAL,
      category: detectHealthcareCategory(it.title),
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
    `📋 Total ${MODELLSTATION_SOMOSA_COMPANY_NAME} jobs discovered: ${jobs.length} (${detailHits}/${items.length} with detail content)`,
  );
  return jobs;
}
