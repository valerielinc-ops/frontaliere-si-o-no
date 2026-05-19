#!/usr/bin/env node
/**
 * Pro Senectute Ticino e Moesano — yearly "concorsi generali".
 *
 * Public career site:
 *   https://ti.prosenectute.ch/it/collabora-con-noi/Offerte-di-lavoro.html
 *
 * Pro Senectute is the largest Swiss gerontology nonprofit, with operations
 * across Ticino and Moesano (italian-speaking GR). The career page publishes
 * a small set of evergreen "concorsi generali" each year, one per profession:
 *
 *   - Concorso generale 202x Infermieri
 *   - Concorso generale 202x Op. socio-assistenziali
 *   - Concorso generale 202x educatori
 *   - Concorso generale 202x Assistenti Sociali
 *
 * Each concorso is a downloadable PDF whose hyperlink anchor text is the
 * concorso title. The page is an AEM site (no RSS), so we scrape the
 * download-list anchors directly:
 *
 *   <a href="/dam/jcr:.../Concorso%20generale%202026_Infermieri.pdf"
 *      class="download-icon-before-link before-icon-download">
 *      Concorso generale 2026_Infermieri (PDF , 133 kN)
 *   </a>
 *
 * Audience match: Ticino + Moesano hits both the italian-TI and italian-GR
 * audiences that other parsers don't yet cover from a federation angle.
 * Healthcare titles (Infermieri, Op. socio-assistenziali, Educatori) are
 * exactly the high-demand profiles for frontaliere readers.
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

export const PROSENECTUTE_TI_KEY = 'prosenectute-ti';
export const PROSENECTUTE_TI_COMPANY_NAME = 'Pro Senectute Ticino e Moesano';
export const PROSENECTUTE_TI_COMPANY_DOMAIN = 'ti.prosenectute.ch';

const LISTING_URL = 'https://ti.prosenectute.ch/it/collabora-con-noi/Offerte-di-lavoro.html';
const BASE_URL = 'https://ti.prosenectute.ch';

export function isProSenectuteTiJob(job) {
  const url = String(job?.url || '').toLowerCase();
  return job?.companyKey === PROSENECTUTE_TI_KEY || /(^|\.)prosenectute\.ch/.test(url);
}

export function isTrustedDomain(rawUrl = '') {
  try {
    const host = new URL(rawUrl).hostname.toLowerCase();
    return (
      host === 'prosenectute.ch' ||
      host.endsWith('.prosenectute.ch')
    );
  } catch {
    return false;
  }
}

/**
 * Strip the "(PDF , 133 kN)" filesize suffix and tidy whitespace in the anchor
 * text so the public title matches the concorso name, not the asset metadata.
 *
 * Examples handled:
 *   "Concorso generale 2026_Infermieri (PDF , 133 kN)"  → "Concorso generale 2026 Infermieri"
 *   "Concorso generale 2026 educatori (PDF , 107 kN)"   → "Concorso generale 2026 educatori"
 */
function cleanConcorsoTitle(raw = '') {
  let t = decodeEntities(raw);
  // Drop trailing "(PDF , N kN)" filesize suffix.
  t = t.replace(/\(\s*PDF[^)]*\)\s*$/i, '');
  // Underscores in source filenames behave as separators; convert to spaces.
  t = t.replace(/_/g, ' ');
  return normalizeSpace(t);
}

/**
 * Extract concorso entries from the Pro Senectute Ticino careers page.
 *
 * Anchors of interest have:
 *   - class containing "download-icon-before-link"
 *   - href ending in ".pdf"
 *   - anchor text mentioning "concorso"
 *
 * Returns: [{ title, pdfUrl }]
 */
export function parseProSenectuteListing(html) {
  const out = [];
  const seen = new Set();
  const rx = /<a\s+href="([^"]+\.pdf)"\s+class="[^"]*download-icon-before-link[^"]*"[^>]*>([\s\S]*?)<\/a>/gi;
  let m;
  while ((m = rx.exec(html))) {
    const href = m[1];
    const rawText = m[2].replace(/<[^>]+>/g, '');
    const title = cleanConcorsoTitle(rawText);
    if (!title || !/concorso/i.test(title)) continue;
    const pdfUrl = href.startsWith('http') ? href : `${BASE_URL}${href}`;
    if (seen.has(pdfUrl)) continue;
    seen.add(pdfUrl);
    out.push({ title, pdfUrl });
  }
  return out;
}

/**
 * Pro Senectute publishes long-running yearly concorsi (the page itself says
 * "I presenti concorsi restano aperti anche in assenza di un effettivo
 * fabbisogno di personale"). Default location is Lugano (their HQ at Via
 * Vanoni 8/10), but each concorso may target the whole canton + Moesano.
 */
export async function fetchAllProSenectuteTiJobs() {
  console.log(`🤝 Fetching ${PROSENECTUTE_TI_COMPANY_NAME} jobs`);
  console.log(`   Source: ${LISTING_URL}\n`);
  const html = await fetchHtml(LISTING_URL);
  const items = parseProSenectuteListing(html);
  console.log(`  ✓ ${items.length} concorsi trovati`);
  if (!items.length) return [];

  const todayIso = new Date().toISOString().slice(0, 10);
  const jobs = [];
  for (const it of items) {
    const title = it.title;
    const description = [
      `${title}.`,
      'Pro Senectute Ticino e Moesano pubblica concorsi annuali aperti anche in assenza di un effettivo fabbisogno di personale: le candidature ricevute vengono valutate ed eventualmente richiamate nel corso dell’anno.',
      `Bando completo (PDF): ${it.pdfUrl}`,
      'Pro Senectute Ticino e Moesano — Sede di Lugano, attiva su tutto il Cantone Ticino e nella regione Moesano (GR).',
    ].filter(Boolean).join('\n\n');
    const sourceLang = detectLang(description || title, 'it');
    const jobSlug = slugify(`${title} ${PROSENECTUTE_TI_KEY}`);
    // The PDF URL is the stable key — the AEM `jcr:` UUID stays the same for
    // the lifetime of the published concorso, and the year-stamped filename
    // (e.g. "Concorso generale 2026_Infermieri.pdf") differentiates re-runs.
    const urlHash = createHash('sha1').update(it.pdfUrl).digest('hex').slice(0, 12);
    jobs.push({
      id: `${PROSENECTUTE_TI_KEY}-${urlHash}`,
      slug: jobSlug,
      slugByLocale: { [sourceLang]: jobSlug },
      company: PROSENECTUTE_TI_COMPANY_NAME,
      companyKey: PROSENECTUTE_TI_KEY,
      companyDomain: PROSENECTUTE_TI_COMPANY_DOMAIN,
      title,
      titleByLocale: { [sourceLang]: title },
      description,
      descriptionByLocale: { [sourceLang]: description },
      // Newly-discovered jobs ship with source-locale-only fields. The shared
      // AI-localization step clears this flag when it fills the remaining 3
      // locales; if it can't (cache miss + AI quota), the flag stays and
      // `translate-pending.yml` picks the job up out-of-band. Without this
      // flag the locale-completeness gate trips before translation can run.
      needsRetranslation: true,
      location: 'Lugano',
      canton: 'TI',
      // Use the per-PDF URL (not the shared listing page) as the canonical
      // job URL so the pipeline's URL-keyed merge (extractStableJobId) sees
      // each concorso as a distinct entity. With LISTING_URL all 4 jobs
      // collapsed to a single match key and the slug-dedup pass kept only
      // the first — silently dropping 3/4 of the records.
      url: it.pdfUrl,
      source: 'Pro Senectute Ticino Dedicated Parser (AEM HTML)',
      sourceLang,
      crawledAt: new Date().toISOString(),
      addressLocality: 'Lugano',
      addressRegion: 'TI',
      addressCountry: 'CH',
      country: 'CH',
      postalCode: '6900',
      category: detectHealthcareCategory(title),
      contract: 'full-time',
      employmentType: detectHealthcareEmploymentType(title),
      experienceLevel: detectHealthcareExperienceLevel(title),
      sector: 'Sanità / Assistenza / Sociale',
      currency: 'CHF',
      featured: false,
      postedDate: todayIso,
      applyUrl: it.pdfUrl,
      requirements: [],
      requirementsByLocale: { [sourceLang]: [] },
    });
  }
  console.log(`📋 Total ${PROSENECTUTE_TI_COMPANY_NAME} jobs discovered: ${jobs.length}`);
  return jobs;
}
