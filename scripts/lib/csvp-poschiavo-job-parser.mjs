#!/usr/bin/env node
/**
 * Centro Sanitario Valposchiavo (CSVP) — Ospedale San Sisto, Poschiavo (GR).
 *
 * Public career site: https://www.csvp.ch/it/lavora-con-noi/cerchiamo
 *
 * Joomla-based site with `<article>` blocks per offer. Title link in `<h1>`,
 * intro paragraph with employment %/start date + PDF download link.
 */
import { createHash } from 'node:crypto';
import { JSDOM } from 'jsdom';
import { detectLang } from './dedicated-crawler-common.mjs';
import { slugify } from './crawler-template.mjs';
import { markAuthoritativeEmptySnapshot } from './authoritative-empty-snapshot.mjs';
import { extractPdfJobContentFromUrl, buildPdfBackedDescription } from './pdf-job-content.mjs';
import {
  fetchHtml,
  decodeEntities,
  normalizeSpace,
  htmlToText,
  detectHealthcareCategory,
  detectHealthcareExperienceLevel,
  detectHealthcareEmploymentType,
} from './hospital-custom-html-helpers.mjs';

export const CSVP_POSCHIAVO_KEY = 'csvp-poschiavo';
export const CSVP_POSCHIAVO_COMPANY_NAME = 'Centro Sanitario Valposchiavo (CSVP)';
export const CSVP_POSCHIAVO_COMPANY_DOMAIN = 'csvp.ch';

const LISTING_URL = 'https://www.csvp.ch/it/lavora-con-noi/cerchiamo';
const BASE_URL = 'https://www.csvp.ch';

// Joomla renders this explicit message when the configured "Cerchiamo"
// category has no published articles. A bare parser zero is deliberately not
// enough: it could also mean that the page changed or a challenge was served.
export const CSVP_POSCHIAVO_EMPTY_CATEGORY_RE = /Non ci sono articoli in questa categoria\./i;

const CSVP_POSCHIAVO_CATEGORY_CONTAINER_SELECTOR =
  '.com-content-category-blog, .blog, [itemtype*="schema.org/Blog"]';
const CSVP_POSCHIAVO_CATEGORY_TITLE_RE = /^Cerchiamo$/i;
const CSVP_POSCHIAVO_EMPTY_STATE_SELECTOR = '.alert, [role="alert"], p';
const CSVP_POSCHIAVO_HIDDEN_CLASS_RE =
  /(?:^|\s)(?:d-none|hidden|invisible|visually-hidden|sr-only)(?:\s|$)/i;
const CSVP_POSCHIAVO_HIDDEN_STYLE_RE =
  /(?:^|;)\s*(?:display\s*:\s*none|visibility\s*:\s*hidden)\b/i;

export function isCsvpPoschiavoJob(job) {
  const url = String(job?.url || '').toLowerCase();
  return job?.companyKey === CSVP_POSCHIAVO_KEY || url.includes('csvp.ch');
}

export function isTrustedDomain(rawUrl = '') {
  try {
    const host = new URL(rawUrl).hostname.toLowerCase();
    return host === 'csvp.ch' || host.endsWith('.csvp.ch');
  } catch {
    return false;
  }
}

export function parseCsvpListing(html) {
  const out = [];
  const seen = new Set();
  const articleRx = /<article[^>]*>([\s\S]*?)<\/article>/g;
  let m;
  while ((m = articleRx.exec(html))) {
    const body = m[1];
    // Title: <h1>...<a href="/it/lavora-con-noi/cerchiamo/N-slug" title="TITLE">TITLE</a></h1>
    const titleMatch = body.match(/<h1[^>]*>[\s\S]*?<a\s+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/);
    if (!titleMatch) continue;
    const url = titleMatch[1].startsWith('http') ? titleMatch[1] : `${BASE_URL}${titleMatch[1]}`;
    const title = normalizeSpace(decodeEntities(titleMatch[2].replace(/<[^>]+>/g, '')));
    if (!title || title.length < 5) continue;
    if (seen.has(url)) continue;
    seen.add(url);

    // Intro paragraph (next <p>)
    const introMatch = body.match(/<p[^>]*>([\s\S]*?)<\/p>/);
    const intro = introMatch ? normalizeSpace(htmlToText(introMatch[1])) : '';

    // PDF link if present
    const pdfMatch = body.match(/href="([^"]+\.pdf)"/i);
    const pdfUrl = pdfMatch ? (pdfMatch[1].startsWith('http') ? pdfMatch[1] : `${BASE_URL}${pdfMatch[1]}`) : '';

    out.push({ url, title, intro, pdfUrl });
  }
  return out;
}

export function isCsvpPoschiavoAuthoritativeEmptyPage(html = '') {
  const dom = new JSDOM(String(html || ''));
  try {
    const { document } = dom.window;
    // Joomla/YOOtheme renders the category component inside a layout wrapper
    // rather than a semantic <main> on the live CSVP page. Keep the scope at
    // the category component itself and exclude navigation/footer modules so
    // an identical phrase outside the listing cannot prove an empty source.
    const categoryContainers = [...document.querySelectorAll(CSVP_POSCHIAVO_CATEGORY_CONTAINER_SELECTOR)]
      .filter((node) => !node.closest('footer, nav, aside'));

    for (const category of categoryContainers) {
      if (!isVisibleCsvpNode(category)) continue;

      const titles = [...category.querySelectorAll('h1, h2, h3, [itemprop="name"]')]
        .filter(isVisibleCsvpNode)
        .map((node) => normalizeSpace(node.textContent || ''))
        .filter(Boolean);
      // Joomla can hide the category heading in this layout, but when it is
      // rendered it must identify the requested "Cerchiamo" category.
      if (titles.length && !titles.some((title) => CSVP_POSCHIAVO_CATEGORY_TITLE_RE.test(title))) {
        continue;
      }

      const emptyState = [...category.querySelectorAll(CSVP_POSCHIAVO_EMPTY_STATE_SELECTOR)]
        .find((node) => {
          const parent = node.parentElement;
          const isDirectCategoryState = parent === category
            || parent?.matches('.alert, [role="alert"]');
          return isDirectCategoryState
            && isVisibleCsvpNode(node)
            && CSVP_POSCHIAVO_EMPTY_CATEGORY_RE.test(normalizeSpace(node.textContent || ''));
        });
      if (!emptyState) continue;

      // The empty message is authoritative only while no visible article is
      // live in the response. This also rejects pages where the phrase came
      // from a footer/error fragment while the category still has an offer.
      const hasLiveArticle = [...document.querySelectorAll('article')]
        .some((article) => isLiveCsvpArticle(article, emptyState));
      if (hasLiveArticle) continue;

      return true;
    }
    return false;
  } finally {
    dom.window.close();
  }
}

function isVisibleCsvpNode(node) {
  for (let current = node; current; current = current.parentElement) {
    if (
      current.hasAttribute('hidden')
      || current.getAttribute('aria-hidden') === 'true'
      || CSVP_POSCHIAVO_HIDDEN_CLASS_RE.test(String(current.getAttribute('class') || ''))
      || CSVP_POSCHIAVO_HIDDEN_STYLE_RE.test(String(current.getAttribute('style') || ''))
    ) {
      return false;
    }
  }
  return true;
}

function isLiveCsvpArticle(article, emptyState) {
  if (!isVisibleCsvpNode(article)) return false;

  if (article === emptyState || article.contains(emptyState)) {
    const residualText = normalizeSpace(
      String(article.textContent || '')
        .replace(CSVP_POSCHIAVO_EMPTY_CATEGORY_RE, '')
        .replace(/Se si visualizzano le sottocategorie, dovrebbero contenere degli articoli\./i, '')
        .replace(CSVP_POSCHIAVO_CATEGORY_TITLE_RE, ''),
    );
    return Boolean(residualText);
  }

  return Boolean(normalizeSpace(article.textContent || ''));
}

/** Fragments only the crawler's former footer wrote. */
export const CSVP_POSCHIAVO_FABRICATED_DESCRIPTION_RE =
  /(?:^|\n)Dettagli \(PDF\): https?:|Centro Sanitario Valposchiavo — Ospedale San Sisto, Poschiavo \(GR\)\./;

export async function fetchAllCsvpPoschiavoJobs() {
  console.log(`🏥 Fetching ${CSVP_POSCHIAVO_COMPANY_NAME} jobs`);
  console.log(`   Source: ${LISTING_URL}\n`);
  const html = await fetchHtml(LISTING_URL);
  const items = parseCsvpListing(html);
  console.log(`  ✓ ${items.length} offerte trovate`);
  if (!items.length) {
    if (isCsvpPoschiavoAuthoritativeEmptyPage(html)) {
      const evidence = `${LISTING_URL} rendered Joomla's explicit empty-category message`;
      console.log(`  🧩 Source-proven zero: ${evidence}`);
      return markAuthoritativeEmptySnapshot([], evidence);
    }
    // Keep selector drift and an unrecognised/error page fail-closed. The
    // standard pipeline preserves the previous slice and crawler-health stays
    // unhealthy until the parser is repaired.
    return [];
  }

  const todayIso = new Date().toISOString().slice(0, 10);
  const jobs = [];
  for (const it of items) {
    const title = it.title;
    // The listing's inline intro is just "80-100% (m/f) — start date": the real
    // job content (Compiti / Profilo / Requisiti) lives in the linked PDF. Fetch
    // and extract it so the description is real content, not boilerplate — older
    // postings happened to carry a richer inline intro, but IT/admin roles put
    // everything in the PDF and would otherwise trip the boilerplate guard
    // (#1393-class: 1/1 jobs boilerplate-only). Falls back to the thin intro if
    // the PDF is unreachable/image-only. Only the source's own text is
    // published: the crawler no longer adds "Dettagli (PDF): …" or a line on
    // the hospital (`CSVP_POSCHIAVO_FABRICATED_DESCRIPTION_RE`).
    let pdfText = '';
    if (it.pdfUrl) {
      try {
        const extracted = await extractPdfJobContentFromUrl(it.pdfUrl);
        pdfText = extracted?.text || '';
      } catch (err) {
        console.warn(`   ⚠️ PDF extraction failed for ${it.pdfUrl}: ${err?.message || err}`);
      }
    }
    const description = buildPdfBackedDescription({ pdfText, fallbackText: it.intro });
    // The description is keyed by its own language (a German PDF goes to `de`);
    // without any text, by the language of the Italian listing fields.
    const sourceLang = detectLang(description || `${title} ${it.intro || ''}`.trim(), 'it');
    const jobSlug = slugify(`${title} ${CSVP_POSCHIAVO_KEY} poschiavo`);
    const urlHash = createHash('sha1').update(it.url).digest('hex').slice(0, 12);
    jobs.push({
      id: `${CSVP_POSCHIAVO_KEY}-${urlHash}`,
      slug: jobSlug,
      slugByLocale: { [sourceLang]: jobSlug },
      company: CSVP_POSCHIAVO_COMPANY_NAME,
      companyKey: CSVP_POSCHIAVO_KEY,
      companyDomain: CSVP_POSCHIAVO_COMPANY_DOMAIN,
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
      location: 'Poschiavo',
      canton: 'GR',
      url: it.url,
      source: 'CSVP Dedicated Parser (Joomla HTML)',
      sourceLang,
      crawledAt: new Date().toISOString(),
      addressLocality: 'Poschiavo',
      addressRegion: 'GR',
      addressCountry: 'CH',
      country: 'CH',
      postalCode: '7742',
      category: detectHealthcareCategory(title + ' ' + it.intro),
      contract: 'full-time',
      employmentType: detectHealthcareEmploymentType(title + ' ' + it.intro),
      experienceLevel: detectHealthcareExperienceLevel(title),
      sector: 'Sanità / Ospedali',
      currency: 'CHF',
      featured: false,
      postedDate: todayIso,
      applyUrl: it.url,
      requirements: [],
      requirementsByLocale: { [sourceLang]: [] },
    });
  }
  console.log(`📋 Total ${CSVP_POSCHIAVO_COMPANY_NAME} jobs discovered: ${jobs.length}`);
  return jobs;
}
