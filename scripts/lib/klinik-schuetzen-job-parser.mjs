#!/usr/bin/env node
/**
 * Klinik Schützen Rheinfelden job parser.
 *
 * Public career page (jobs live on the "Arbeiten in der Klinik" sub-page):
 *   https://www.klinikschuetzen.ch/ueber-uns/arbeiten-in-der-klinik
 *
 * Klinik Schützen is a 108-bed private psychiatry / psychosomatics /
 * psychotherapy clinic in Rheinfelden (AG) with two ambulatoria
 * (Rheinfelden + Aarau), part of the Schützen Rheinfelden AG hotel/clinic
 * group.
 *
 * The career sub-page renders each job inline as a server-rendered anchor:
 *
 *   <a id="job-{ALPHANUM_ID}" ...>
 *     ... heading + intro + bullet list + apply CTA ...
 *   </a>
 *
 * Detail content is fully self-contained inside that block — no external
 * application platform involved. We extract title + full description from
 * the block and produce the in-page anchor URL (`#job-{ID}`) as deep link.
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

export const KLINIK_SCHUETZEN_KEY = 'klinik-schuetzen';
export const KLINIK_SCHUETZEN_COMPANY_NAME = 'Klinik Schützen Rheinfelden';
export const KLINIK_SCHUETZEN_COMPANY_DOMAIN = 'klinikschuetzen.ch';

const PUBLIC_CAREER_URL = 'https://www.klinikschuetzen.ch/ueber-uns/arbeiten-in-der-klinik';
const BASE_URL = 'https://www.klinikschuetzen.ch';

export function isKlinikSchuetzenJob(job) {
  const url = String(job?.url || '').toLowerCase();
  return job?.companyKey === KLINIK_SCHUETZEN_KEY || url.includes('klinikschuetzen.ch');
}

export function isTrustedDomain(rawUrl = '') {
  try {
    const host = new URL(rawUrl).hostname.toLowerCase();
    return host === 'klinikschuetzen.ch' || host.endsWith('.klinikschuetzen.ch');
  } catch {
    return false;
  }
}

/**
 * Extract job blocks from the career sub-page. Each block starts with a tag
 * carrying `id="job-{ID}"` — typically a `<section>` or `<div>` that contains
 * the heading, intro paragraphs and apply CTA.
 */
export function parseListing(html) {
  const out = [];
  const seen = new Set();
  // Find every job anchor first, then slice each block as the text between
  // one job-* anchor and the next one (or end of body).
  const anchors = [];
  const idRe = /<([a-z][a-z0-9]*)[^>]*\sid="job-([A-Z0-9]+)"/g;
  let am;
  while ((am = idRe.exec(html))) {
    anchors.push({ tag: am[1], id: am[2], start: am.index });
  }
  const endOfBody = (() => {
    const fm = html.match(/<footer\b/i);
    return fm ? html.indexOf(fm[0]) : html.length;
  })();
  for (let i = 0; i < anchors.length; i += 1) {
    const a = anchors[i];
    const next = anchors[i + 1] ? anchors[i + 1].start : endOfBody;
    const id = a.id;
    if (seen.has(id)) continue;
    seen.add(id);
    let block = html.slice(a.start, next)
      .replace(/<script[\s\S]*?<\/script>/gi, '')
      .replace(/<style[\s\S]*?<\/style>/gi, '');
    // The title lives either in the accordion label (<a class="accordion-label">)
    // or the first heading (h1–h4) — try both, prefer the accordion label.
    let title = '';
    const labelMatch = block.match(/<a[^>]*class="[^"]*accordion-label[^"]*"[^>]*>([\s\S]{3,400}?)<\/a>/i);
    if (labelMatch) {
      title = normalizeSpace(decodeEntities(labelMatch[1].replace(/<[^>]+>/g, '')));
    }
    if (!title) {
      const titleMatch = block.match(/<h[1-4][^>]*>([\s\S]{3,400}?)<\/h[1-4]>/i);
      title = titleMatch ? normalizeSpace(decodeEntities(titleMatch[1].replace(/<[^>]+>/g, ''))) : '';
    }
    if (!title || title.length < 5) continue;
    const text = normalizeSpace(htmlToText(block));
    if (!text || text.split(/\s+/).length < 30) continue;
    out.push({
      id,
      title,
      description: text.slice(0, 6000),
      url: `${PUBLIC_CAREER_URL}#job-${id}`,
    });
  }
  return out;
}

export async function fetchAllKlinikSchuetzenJobs() {
  console.log(`🏥 Fetching ${KLINIK_SCHUETZEN_COMPANY_NAME} jobs`);
  console.log(`   Source: ${PUBLIC_CAREER_URL}\n`);

  const html = await fetchHtml(PUBLIC_CAREER_URL);
  const rows = parseListing(html);
  console.log(`  ✓ ${rows.length} jobs from server-rendered career page`);
  if (!rows.length) return [];

  const todayIso = new Date().toISOString().slice(0, 10);
  const jobs = [];
  for (const r of rows) {
    const sourceLang = detectLang(r.description || r.title, 'de');
    const jobSlug = slugify(`${r.title} ${KLINIK_SCHUETZEN_KEY} rheinfelden`);
    const urlHash = createHash('sha1').update(r.url).digest('hex').slice(0, 12);

    jobs.push({
      id: `${KLINIK_SCHUETZEN_KEY}-${urlHash}`,
      slug: jobSlug,
      slugByLocale: { [sourceLang]: jobSlug },
      company: KLINIK_SCHUETZEN_COMPANY_NAME,
      companyKey: KLINIK_SCHUETZEN_KEY,
      companyDomain: KLINIK_SCHUETZEN_COMPANY_DOMAIN,
      title: r.title,
      titleByLocale: { [sourceLang]: r.title },
      description: r.description,
      descriptionByLocale: { [sourceLang]: r.description },
      // Newly-discovered jobs ship with source-locale-only fields. The shared
      // AI-localization step clears this flag when it fills the remaining 3
      // locales; if it can't (cache miss + AI quota), the flag stays and
      // `translate-pending.yml` picks the job up out-of-band. Without this
      // flag the locale-completeness gate trips before translation can run.
      needsRetranslation: true,
      location: 'Rheinfelden',
      canton: 'AG',
      url: r.url,
      source: `${KLINIK_SCHUETZEN_COMPANY_NAME} Dedicated Parser (HTML in-page anchors)`,
      sourceLang,
      crawledAt: new Date().toISOString(),

      addressLocality: 'Rheinfelden',
      addressRegion: 'AG',
      addressCountry: 'CH',
      country: 'CH',
      postalCode: '4310',
      category: detectHealthcareCategory(r.title + ' ' + r.description.slice(0, 200)),
      contract: 'full-time',
      employmentType: detectHealthcareEmploymentType(r.title + ' ' + r.description.slice(0, 400)),
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

  console.log(`\n📋 Total ${KLINIK_SCHUETZEN_COMPANY_NAME} jobs discovered: ${jobs.length}`);
  return jobs;
}

export { PUBLIC_CAREER_URL };
