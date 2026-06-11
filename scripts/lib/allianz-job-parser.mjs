/**
 * Allianz Suisse — Umantis ATS parser
 *
 * Listing page: POST https://recruitingapp-2872.umantis.com/Jobs/All
 *   - Filter by Region Tessin: searchSkill1004=38999405
 *   - Jobs in <tr class="tableaslist_contentrow1|2">
 *     - Agency in <span class="tableaslist_element_1152486">
 *     - Title+link in <span class="tableaslist_element_1152488"> → <a href="/Vacancies/{ID}/Description/{lang}">
 *     - Location in <span class="tableaslist_element_1152495">
 *
 * Detail page: /Vacancies/{ID}/Description/4 (Italian)
 *   - og:title = job title
 *   - og:site_name = agency name
 *   - Commented-out keywords meta = title, agency, role, location, contract type
 *   - Body text: "Cosa ti proponiamo" + "Cosa ti chiediamo" + address block
 */

import { JSDOM } from 'jsdom';
import {  inferSwissTargetCanton, inferAnyCanton  } from './target-swiss-locations.mjs';
import { titleOverlap, MIN_TITLE_OVERLAP } from './title-utils.mjs';
import { normalizeSpace, normalizeDescriptionSpace } from './crawler-template.mjs';
import { stripContactPII } from './strip-contact-pii.mjs';

const BASE_URL = 'https://recruitingapp-2872.umantis.com';

function stripHtml(html = '') {
  return html
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<noscript[^>]*>[\s\S]*?<\/noscript>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<li[^>]*>/gi, '\n• ')
    .replace(/<\/p>/gi, '\n')
    .replace(/<\/li>/gi, '\n')
    .replace(/<\/div>/gi, '\n')
    .replace(/<\/tr>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&eacute;/g, 'é')
    .replace(/&uuml;/g, 'ü')
    .replace(/&ouml;/g, 'ö')
    .replace(/&auml;/g, 'ä')
    .replace(/&rtri;/g, '▸')
    .replace(/\u00b7/g, '·')
    .replace(/\u2013/g, '–')
    .replace(/\u2019/g, "'")
    .trim();
}

function slugify(value = '') {
  return String(value || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-+|-+$/g, '')
    .replace(/-{2,}/g, '-')
    .slice(0, 180);
}

const TICINO_AGENCIES = [
  'agenzia generale bellinzona',
  'agenzia generale lugano',
  'tessin',
];

/**
 * Parse the listing page HTML and return an array of { vacancyId, title, agency, location, detailUrl }
 */
export function parseAllianzListingPage(html = '') {
  const document = new JSDOM(html).window.document;
  const rows = [...document.querySelectorAll('tr.tableaslist_contentrow1, tr.tableaslist_contentrow2')];
  const results = [];
  const seen = new Set();

  for (const row of rows) {
    const agencySpan = row.querySelector('.tableaslist_element_1152486');
    const titleSpan = row.querySelector('.tableaslist_element_1152488');
    const locationSpan = row.querySelector('.tableaslist_element_1152495');

    if (!titleSpan) continue;

    const anchor = titleSpan.querySelector('a[href*="/Vacancies/"]');
    if (!anchor) continue;

    const href = String(anchor.getAttribute('href') || '');
    const idMatch = href.match(/\/Vacancies\/(\d+)\//);
    if (!idMatch) continue;

    const vacancyId = idMatch[1];
    if (seen.has(vacancyId)) continue;
    seen.add(vacancyId);

    const title = normalizeSpace(anchor.textContent || '');
    const agency = normalizeSpace(agencySpan?.textContent || '');
    const locationText = normalizeSpace(locationSpan?.textContent || '').replace(/^\s*\|?\s*Arbeitsort:\s*/i, '');

    results.push({
      vacancyId,
      title,
      agency,
      location: locationText,
      detailUrl: `${BASE_URL}/Vacancies/${vacancyId}/Description/4`,
      applyUrl: `${BASE_URL}/Vacancies/${vacancyId}/Application/CheckLogin/4`,
    });
  }

  return results;
}

/**
 * Return true if a title string is generic or consists solely of the site name.
 * @param {string} title
 * @param {string} siteName
 */
function isGenericTitle(title, siteName) {
  if (!title || title.length < 4) return true;
  if (siteName && normalizeSpace(title.toLowerCase()) === normalizeSpace(siteName.toLowerCase())) return true;
  return false;
}

/* ── Detail body extraction ────────────────────────────────────
 *
 * The Umantis ATS is mid-migration between two detail-page templates:
 *   - NEW template: the real role body lives in `.container.page-width` →
 *     `.content` blocks (paragraphs + <ul><li> bullets + headings).
 *   - OLD template: the body lives in `.showblock_textblock` blocks.
 * In BOTH templates the page also carries chrome (skip-links, the
 * "your browser cannot display embedded frames" notice, the
 * "Kontakt / Keine Details erfasst / Aktionen / Ich bin interessiert" sidebar,
 * the "Generalagentur <name> |" agency header).
 *
 * Crucially, a given vacancy is only published in ITS OWN language: the Italian
 * `/Description/4` page for a German job returns a content-less shell, so the
 * old parser (hardcoded `/Description/4`) grabbed the chrome for most jobs →
 * dozens of vacancies ended up with the SAME body+title (the duplicate-listings
 * audit critical). `pickRichestAllianzDescription` probes every language code
 * and keeps the variant with the most real body text.
 */

const CHROME_LINE_RE = /^(Kontakt|Aktionen|Ich bin interessiert|Zurück|Keine Details erfasst|Ihr Browser kann|Zum Hauptinhalt|Springe zur|Jetzt Teil der Allianz|Bewerben|Drucken|Empfehlen|Merken|Teilen)\b/i;
const AGENCY_HEADER_RE = /^(Generalagentur|Agence générale|Agenzia generale)[^.\n]{0,80}\|?\s*$/i;

/**
 * Extract the real job-body HTML from a Umantis detail page, chrome removed.
 * Handles both the new (`.container.page-width`) and old (`.showblock_textblock`)
 * templates and returns the richest candidate's inner HTML (so <ul>/<li>
 * structure survives for downstream markdown conversion). Returns '' if no
 * substantial body is present (e.g. the wrong-language shell page).
 */
export function extractAllianzBodyHtml(html = '') {
  const doc = new JSDOM(html).window.document;
  doc.querySelectorAll('script,style,noscript,header,footer,nav').forEach((n) => n.remove());

  const candidates = [];

  // NEW template — main content area.
  const newMain = doc.querySelector('.container.page-width');
  if (newMain) {
    // Drop obvious chrome sub-blocks (apply CTA / share bar) by class hints.
    for (const el of newMain.querySelectorAll('[class*="apply"],[class*="share"],[class*="action"],[class*="cta"],form')) {
      el.remove();
    }
    candidates.push(newMain);
  }

  // OLD template — substantial showblock textblocks, chrome filtered out.
  const oldBlocks = [...doc.querySelectorAll('.showblock_textblock')].filter((n) => {
    const t = normalizeSpace(n.textContent || '');
    if (t.length < 60) return false;
    if (CHROME_LINE_RE.test(t)) return false;
    if (AGENCY_HEADER_RE.test(t)) return false;
    return true;
  });
  if (oldBlocks.length) {
    candidates.push({ innerHTML: oldBlocks.map((n) => n.outerHTML).join('\n'), textContent: oldBlocks.map((n) => n.textContent).join(' ') });
  }

  let best = '';
  let bestLen = 0;
  for (const c of candidates) {
    const len = normalizeSpace(c.textContent || '').length;
    if (len > bestLen) {
      bestLen = len;
      best = c.innerHTML || '';
    }
  }
  return best;
}

/**
 * Convert an extracted Umantis body HTML into clean markdown, dropping any
 * residual chrome lines. Walks the DOM so that <ul>/<li> nested inside content
 * <div>s are preserved as `- ` bullets and <h*>/bold-only paragraphs as `## `
 * headings — Umantis wraps its lists in <div class="content"> which a flat
 * inline-flatten converter would collapse, so this walker handles lists
 * explicitly wherever they appear in the tree.
 */
export function allianzBodyToMarkdown(bodyHtml = '') {
  if (!bodyHtml || !bodyHtml.trim()) return '';
  const doc = new JSDOM(`<body>${bodyHtml}</body>`).window.document;
  const body = doc.body;
  const lines = [];

  const inlineText = (node) => normalizeSpace(node.textContent || '');

  const walk = (node) => {
    if (node.nodeType === 3) {
      const t = normalizeSpace(node.textContent || '');
      if (t) lines.push(t);
      return;
    }
    if (node.nodeType !== 1) return;
    const tag = node.tagName.toLowerCase();

    if (tag === 'ul' || tag === 'ol') {
      let idx = 0;
      for (const li of node.children) {
        if (li.tagName.toLowerCase() !== 'li') continue;
        idx += 1;
        const text = inlineText(li);
        if (text) lines.push(node.tagName.toLowerCase() === 'ol' ? `${idx}. ${text}` : `- ${text}`);
      }
      return;
    }

    if (/^h[1-6]$/.test(tag)) {
      const t = inlineText(node);
      if (t) lines.push(`## ${t}`);
      return;
    }

    if (tag === 'p') {
      const t = inlineText(node);
      if (t) lines.push(t);
      return;
    }

    // Containers (div/section/article/etc): recurse so nested lists are reached.
    for (const child of node.childNodes) walk(child);
  };

  for (const child of body.childNodes) walk(child);

  const cleaned = lines
    .map((l) => l.trim())
    .filter((l) => {
      if (!l) return false;
      const bare = l.replace(/^[-*#\d.\s]+/, '').trim();
      if (!bare) return false;
      if (CHROME_LINE_RE.test(bare)) return false;
      if (AGENCY_HEADER_RE.test(bare)) return false;
      return true;
    });

  // De-dup consecutive identical lines (some templates repeat headings).
  const out = [];
  for (const l of cleaned) {
    if (out[out.length - 1] !== l) out.push(l);
  }
  return out.join('\n').replace(/\n{3,}/g, '\n\n').trim().slice(0, 5000);
}

/**
 * Parse a detail page (Italian) and extract rich metadata.
 *
 * Title extraction priority:
 *   1. First `h1` in the page body (most reliable on Umantis detail pages)
 *   2. `og:title` meta tag — validated against h1 with overlap guard
 *   3. `<title>` tag — strip " -- {anything}" suffix (Umantis format)
 *   4. fallbackTitle from listing page
 *
 * Overlap guard: if og:title diverges significantly from the h1 (overlap < 0.7),
 * the h1 is preferred as the authoritative source.
 */
export function parseAllianzDetailPage(html = '', fallbackTitle = '', fallbackLocation = '') {
  const document = new JSDOM(html).window.document;

  // og:site_name = agency name
  const ogSiteName = normalizeSpace(
    document.querySelector('meta[property="og:site_name"]')?.getAttribute('content') || ''
  );

  // 1. h1 from page body — most reliable on Umantis detail pages
  const h1El = document.querySelector('h1');
  const h1Title = h1El ? normalizeSpace(h1El.textContent || '') : '';

  // 2. og:title meta tag
  const ogTitle = normalizeSpace(
    document.querySelector('meta[property="og:title"]')?.getAttribute('content') || ''
  );

  // 3. <title> tag — Umantis format: "Job Title -- {SiteName}" or "Job Title -- DE"
  //    Strip everything from " --" onwards to get the bare vacancy title.
  const rawPageTitle = document.querySelector('title')?.textContent || '';
  const cleanPageTitle = normalizeSpace(rawPageTitle.replace(/\s*--\s*.+$/, '').trim());

  // Resolve: prefer h1 when non-generic; validate og:title against h1 with overlap guard
  let title = '';
  if (!isGenericTitle(h1Title, ogSiteName)) {
    // h1 is available and specific — use it as the ground truth
    if (!isGenericTitle(ogTitle, ogSiteName) && titleOverlap(ogTitle, h1Title) >= MIN_TITLE_OVERLAP) {
      // og:title agrees with h1 → og:title is usually cleaner (no extra noise from DOM)
      title = ogTitle;
    } else {
      // og:title absent or diverges from h1 → h1 wins
      title = h1Title;
    }
  } else if (!isGenericTitle(ogTitle, ogSiteName)) {
    title = ogTitle;
  } else if (!isGenericTitle(cleanPageTitle, ogSiteName)) {
    title = cleanPageTitle;
  } else {
    title = fallbackTitle;
  }

  title = normalizeSpace(title || fallbackTitle);

  // Commented-out keywords meta: extract location + contract type
  let keywordsLocation = '';
  let contractType = '';
  const htmlText = html;
  const kwMatch = htmlText.match(/<!--\s*<meta name="keywords"\s+content="([^"]+)"/);
  if (kwMatch) {
    const parts = kwMatch[1].split(',').map((s) => s.trim());
    // Pattern: title, agency, role, location, contract-level, contract-type
    if (parts.length >= 4) {
      keywordsLocation = parts[parts.length - 3] || '';
      contractType = parts[parts.length - 1] || '';
    }
  }

  // Extract the real job body, chrome stripped, as structured markdown. Handles
  // both Umantis templates (new `.container.page-width`, old
  // `.showblock_textblock`) and preserves <ul><li> bullets as `- ` lines so the
  // descriptions aren't flat prose. Returns '' on the wrong-language shell page.
  const bodyHtml = extractAllianzBodyHtml(html);
  let description = allianzBodyToMarkdown(bodyHtml);

  if (!description) {
    // Legacy fallback for any remaining table/email-style template: pull the
    // content cell or the "Was wir bieten / Cosa ti proponiamo" section.
    // NOTE: deliberately NO chrome-grabbing "first N lines" last resort — a
    // wrong-language shell page carries only chrome (skip-links, "Ihr Browser
    // kann keine Frames anzeigen", the Kontakt/Aktionen sidebar). Returning ''
    // for a shell is REQUIRED so fetchBestDetail keeps probing language codes
    // and picks the variant that actually carries the role body. Grabbing the
    // shell chrome here is what produced the duplicate-listings critical.
    const contentMatch = html.match(/<td[^>]*class="[^"]*content[^"]*"[^>]*>([\s\S]*?)<\/td>/i) ||
      html.match(/<div[^>]*class="[^"]*vacancy[^"]*"[^>]*>([\s\S]*?)<\/div>/i);
    if (contentMatch) {
      description = stripHtml(contentMatch[1]);
    } else {
      const stripped = stripHtml(html);
      const startIdx = stripped.search(/Cosa ti (proponiamo|offriamo)|Was wir (dir bieten|Ihnen bieten)|What we offer/i);
      if (startIdx > -1) {
        const endIdx = stripped.indexOf('Ulteriori informazioni', startIdx);
        description = (endIdx > -1 ? stripped.slice(startIdx, endIdx) : stripped.slice(startIdx, startIdx + 3000)).trim();
      }
    }
    description = description
      .replace(/\n{3,}/g, '\n\n')
      .replace(/^\s+|\s+$/gm, '')
      .trim()
      .slice(0, 5000);
  }

  // Extract address from body (e.g. "Piazza del Sole\n6500 Bellinzona")
  let locationFromBody = '';
  const postalMatch = description.match(/(\d{4})\s+([\p{L}\s]+?)(?:\s|$)/u);
  if (postalMatch) {
    const postalCode = postalMatch[1];
    const city = postalMatch[2].trim();
    if (/^6[5-9]\d{2}$/.test(postalCode) || /^7\d{3}$/.test(postalCode)) {
      locationFromBody = city;
    }
  }

  const location = normalizeSpace(locationFromBody || keywordsLocation || fallbackLocation);

  return {
    title,
    agency: normalizeSpace(ogSiteName),
    location,
    description,
    contractType: normalizeSpace(contractType),
  };
}

/**
 * Check if a job is relevant (Ticino or Grigioni) based on agency, location, or keywords.
 * Returns the canton code ('TI' or 'GR') if relevant, or '' if not.
 */
export function inferAllianzCanton(agency = '', location = '') {
  const signal = `${agency} ${location}`;
  const canton = inferAnyCanton(signal);
  if (canton) return canton;

  // Extra agency-level checks for Allianz-specific naming
  const agencyLow = agency.toLowerCase();
  for (const a of TICINO_AGENCIES) {
    if (agencyLow.includes(a)) return 'TI';
  }

  return '';
}

/**
 * @deprecated Use inferAllianzCanton() instead. Kept for backward compatibility.
 */
export function isAllianzTicinoRelevant(agency = '', location = '') {
  return inferAllianzCanton(agency, location) !== '';
}

/**
 * Build localized content for a job.
 */
export function buildAllianzLocalizedContent(job) {
  const title = normalizeSpace(job.title);
  // Allianz vacancy bodies copy the source ATS verbatim, which names an
  // individual recruiter + their direct phone (and embeds the agent's name in
  // the "Agenzia generale <Name>" address block). Re-publishing that is personal
  // data we have no basis to mirror (erasure request, 2026-06-05) — strip it.
  let description = stripContactPII(normalizeDescriptionSpace(job.description));
  const slug = slugify(title);
  const location = normalizeSpace(job.location) || 'Ticino';

  // If description is thin (<50 words), enrich with company context
  const wordCount = description.split(/\s+/).filter(Boolean).length;
  if (wordCount < 50) {
    const agencyText = job.agency ? ` presso l'${job.agency}` : '';
    description = [
      description || `${title} — Allianz Suisse${agencyText}, ${location}.`,
      `Allianz Suisse è una delle principali compagnie assicurative in Svizzera, parte del gruppo Allianz, leader mondiale nel settore assicurativo e della gestione patrimoniale. Con una rete capillare di agenzie generali in tutto il Paese, Allianz Suisse offre soluzioni assicurative complete per privati e aziende nei settori vita, non vita e previdenza professionale. L'azienda si distingue per l'attenzione al cliente, la consulenza personalizzata e un ambiente di lavoro dinamico con opportunità di crescita professionale e formazione continua. Sede regionale in Ticino con agenzie a Bellinzona e Lugano.`,
      `Candidati online tramite il portale recruitingapp-2872.umantis.com.`,
    ].join('\n');
  }

  // All Ticino Allianz jobs are published in Italian
  const titleByLocale = { it: title, en: title, de: title, fr: title };
  const descriptionByLocale = { it: description, en: '', de: '', fr: '' };
  const slugByLocale = { it: slug, en: slug, de: slug, fr: slug };

  return { titleByLocale, descriptionByLocale, slugByLocale };
}
