import { hasPostingDateProvenance, mergeSourcePostingDates } from './source-posting-date.mjs';
import { decode as decodeHTML } from 'html-entities';
import { meetsSourceBodyFloor } from './source-body-floor.mjs';
import { truncateSlugAtWordBoundary } from './slug-truncate.mjs';
/**
 * PEMSA — WordPress career page parser
 *
 * Listing: https://www.pemsa.ch/it/le-nostre-offerte-di-lavoro/
 *   WordPress with WP Grid Builder. National listing (all cantons, no canton
 *   facet). Job links in format: https://www.pemsa.ch/it/job/{slug}-{id}/
 *
 * Detail: https://www.pemsa.ch/it/job/{slug}-{id}/
 *   JSON-LD JobPosting with title, description, datePosted, validThrough,
 *   jobLocation (addressLocality, addressRegion, postalCode, addressCountry).
 *
 * PEMSA is a Swiss staffing agency for construction, civil engineering,
 * electrical, HVAC, and industrial trades. HQ in Geneva, branch in Ticino.
 */

import { isTargetSwissLocation, inferAnyCanton } from './target-swiss-locations.mjs';
import {
  detectLang,
  getCompanyBoilerplateIT,
  mergeLocaleTextMap,
  repairRelabeledSourceLocale,
} from './dedicated-crawler-common.mjs';
import { dropStaleLocaleDescriptions, sourceSlotTitleAndSlug } from './source-locale-slots.mjs';
import { fetchHtml } from './crawler-template.mjs';
import { extractDetailFields, renderedVacancySourceLength } from './prospector/extract.mjs';

const LISTING_URL = 'https://www.pemsa.ch/it/le-nostre-offerte-di-lavoro/';

function normalizeSpace(value = '') {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function slugify(value = '') {
  return truncateSlugAtWordBoundary(String(value || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-+|-+$/g, '')
    .replace(/-{2,}/g, '-'), 180);
}

function stripHtml(html = '') {
  return decodeHTML(String(html || '')
    .replace(/<[^>]+>/g, ' '), { scope: 'strict' })
    .replaceAll('\u00a0', ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function countRenderedDescriptionSections(text = '') {
  const lines = String(text || '')
    .split('\n')
    .map((line) => normalizeSpace(line))
    .filter(Boolean);
  return lines.filter((line, index) => !line.startsWith('- ')
    && lines[index + 1]?.startsWith('- ')).length;
}

/**
 * Decode HTML entities to get raw HTML, then convert to structured markdown.
 * The JSON-LD description from PEMSA contains HTML-encoded tags like
 * &lt;h2&gt;, &lt;ul&gt;, &lt;li&gt;, &lt;strong&gt; etc.
 */
function decodeHtmlEntities(text = '') {
  return decodeHTML(String(text || ''), { scope: 'strict' }).replaceAll('\u00a0', ' ');
}

/**
 * Parse the decoded HTML into structured markdown with sections and bullets.
 * Skips "contatto" / "persona di contatto" sections.
 *
 * Returns { text, sectionCount, sourceTextLength }.
 */
export function parseDescriptionToMarkdown(rawDescription = '') {
  if (typeof rawDescription !== 'string' || !rawDescription) return { text: '', sectionCount: 0, sourceTextLength: 0 };

  // Some API records transport escaped HTML; unwrap that layer before parsing.
  const markup = rawDescription.includes('<') ? rawDescription : decodeHtmlEntities(rawDescription);
  const sourceTextLength = stripHtml(markup).length;

  // Clean up: remove </br> self-closing breaks used as spacers
  let html = markup.replace(/<\/br>/gi, '').replace(/<br\s*\/?>/gi, '\n')
    .replace(/<li[^>]*>/gi, '\n• ');

  // Some PEMSA ads mark their sections with a bold paragraph instead of an
  // <h2-4> ("<p><strong>Il tuo incarico: </strong></p><ul>…"). Without a
  // heading nothing below was extracted and the ad published as EMPTY — the
  // runner then filled it with invented text (issue 5253: 3/313 jobs carried
  // the central company boilerplate). Promote those paragraphs to headings,
  // only when the ad has no real heading at all.
  if (!/<h[2-4][^>]*>/i.test(html)) {
    html = html.replace(/<p[^>]*>\s*<(?:strong|b)>([\s\S]*?)<\/(?:strong|b)>\s*<\/p>/gi, '<h3>$1</h3>');
  }

  const sections = [];
  const skipHeadings = /contatto|persona di contatto|contact|Kontakt|votre interlocuteur/i;

  // Extract intro text before first heading
  const firstHeadingIdx = html.search(/<h[2-4][^>]*>/i);
  if (firstHeadingIdx > 0) {
    const introHtml = html.slice(0, firstHeadingIdx);
    const intro = stripHtml(introHtml);
    if (intro.length > 30) sections.push(intro);
  }

  // Extract heading + content blocks
  const headingRegex = /<h[2-4][^>]*>([\s\S]*?)<\/h[2-4]>\s*([\s\S]*?)(?=<h[2-4][^>]*>|$)/gi;
  let match;
  while ((match = headingRegex.exec(html)) !== null) {
    const heading = stripHtml(match[1]);
    if (!heading || skipHeadings.test(heading)) continue;

    const contentBlock = match[2];

    // Try <ul><li> extraction
    const ulMatch = contentBlock.match(/<ul>([\s\S]*?)<\/ul>/i);
    if (ulMatch) {
      const items = [];
      const liRegex = /<li>([\s\S]*?)<\/li>/gi;
      let li;
      while ((li = liRegex.exec(ulMatch[1])) !== null) {
        const text = stripHtml(li[1]);
        if (text) items.push(text);
      }
      if (items.length > 0) {
        sections.push(`## ${heading}\n${items.map((i) => `- ${i}`).join('\n')}`);
        continue;
      }
    }

    // Try <p> content
    const pMatches = contentBlock.match(/<p>([\s\S]*?)<\/p>/gi);
    if (pMatches) {
      const lines = pMatches.map((p) =>
        stripHtml(p),
      ).filter(Boolean);
      if (lines.length > 0 && lines.join(' ').length > 20) {
        sections.push(`## ${heading}\n${lines.join('\n')}`);
        continue;
      }
    }

    // Plain text. List items were turned into "• " markers above: keep each
    // on its own "- " line instead of flattening the list into prose.
    const plain = stripHtml(contentBlock)
      .replace(/^•\s*/, '- ').replace(/\s*•\s*/g, '\n- ');
    if (plain.length > 20) {
      sections.push(`## ${heading}\n${plain}`);
    }
  }

  const text = sections.join('\n\n');
  const sectionCount = sections.filter((s) => s.startsWith('## ')).length;
  return { text, sectionCount, sourceTextLength };
}

/**
 * Fetch the listing page and extract all job URLs.
 */
export async function parsePemsaListingPage(timeoutMs = 20000) {
    const html = await fetchHtml(LISTING_URL, {
      timeoutMs,
      headers: {
        Accept: 'text/html',
        'User-Agent': 'Mozilla/5.0 (compatible; FrontaliereTicinoBot/1.0; +https://frontaliereticino.ch/)',
      },
    });

  const urls = new Set();
    const regex = /href="(https:\/\/www\.pemsa\.ch\/it\/job\/[^"]+)"/g;
  let match;
  while ((match = regex.exec(html)) !== null) {
    urls.add(match[1].replace(/\/$/, '') + '/');
  }
  return [...urls];
}

/**
 * Fetch a detail page and extract JSON-LD JobPosting data.
 */
export async function parsePemsaDetailPage(url, timeoutMs = 15000) {
  try {
    const html = await fetchHtml(url, {
      timeoutMs,
      headers: {
        Accept: 'text/html',
        'User-Agent': 'Mozilla/5.0 (compatible; FrontaliereTicinoBot/1.0; +https://frontaliereticino.ch/)',
      },
    });

    return parsePemsaDetailHtml(html, url);
  } catch {
    return null;
  }
}

/**
 * Parse one fetched detail page. PEMSA's JSON-LD carries only the intro and
 * the rendered detail body carries the remaining mission/profile sections.
 * Use the same balanced, chrome-aware extractor as the source-detail audit so
 * forms, footer text and related jobs cannot become vacancy content.
 */
export function parsePemsaDetailHtml(html, url = '') {
  try {
    const rendered = extractDetailFields(html, url, { recordUrl: url });

    const ldBlocks = html.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g) || [];
    for (const block of ldBlocks) {
      const jsonStr = block.replace(/<script[^>]*>/, '').replace(/<\/script>/, '');
      try {
        const data = JSON.parse(jsonStr);
        if (data?.['@type'] === 'JobPosting') {
          const loc = data.jobLocation?.address || {};
          const rawDesc = data.description || '';
          const parsed = parseDescriptionToMarkdown(rawDesc);
          const description = String(rendered.description || parsed.text || '').trim();
          return {
            title: normalizeSpace(data.title || ''),
            description,
            descriptionSectionCount: Math.max(
              parsed.sectionCount,
              countRenderedDescriptionSections(description),
            ),
            descriptionSourceLength: renderedVacancySourceLength(html, data.title || ''),
            datePosted: normalizeSpace(data.datePosted || ''),
            validThrough: normalizeSpace(data.validThrough || ''),
            employmentType: normalizeSpace(data.employmentType || ''),
            city: normalizeSpace(loc.addressLocality || ''),
            region: normalizeSpace(loc.addressRegion || ''),
            postalCode: normalizeSpace(loc.postalCode || ''),
            country: normalizeSpace(loc.addressCountry || ''),
            company: normalizeSpace(data.hiringOrganization?.name || 'PEMSA'),
          };
        }
      } catch { /* skip invalid JSON-LD */ }
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Check if a PEMSA job is in a Swiss target canton (all 26).
 * The predicate is CH-wide: a Swiss city/canton is accepted across all 26
 * cantons, while foreign locations are rejected.
 */
export function isPemsaSwissRelevant(job = {}) {
  const region = normalizeSpace(job.region || '');
  const city = normalizeSpace(job.city || '');
  // inferAnyCanton resolves both canton codes ("GE") and city names ("Genève").
  if (inferAnyCanton(region) || inferAnyCanton(city)) return true;
  if (!city && !region) return true; // PEMSA is a Swiss-only agency — keep location-less rows
  return isTargetSwissLocation(city);
}

/** @deprecated Use isPemsaSwissRelevant() instead. Kept for test/API compatibility. */
export const isPemsaTicinoRelevant = isPemsaSwissRelevant;

/**
 * Build localized content for a PEMSA job: the source slot only.
 *
 * Issue 5253: the language was guessed from the TITLE ("Imbianchino (M/F)" →
 * en, "Carpentiere AFC / AEC (m/f/d)" → de) while every body comes from the
 * Italian site, so 19/314 jobs filed the Italian text under a foreign source
 * slot. The builder also wrote an INVENTED recruitment paragraph into en/de/fr
 * (267/314 jobs) and into `it` when the body was missing. The language now
 * comes from the body, only that slot is written, and the other locales are
 * left to the translation step. Without a body the description stays empty:
 * `mergePemsaJobRecord` then keeps the body read by an earlier run or does not
 * publish the job.
 */
export function buildPemsaLocalizedContent(job = {}) {
  const title = normalizeSpace(job.title);
  const city = normalizeSpace(job.city) || 'Svizzera';
  const desc = String(job.description || '').trim();
  const sectionCount = job.descriptionSectionCount || 0;
  const sourceLength = job.descriptionSourceLength || 0;
  const MIN_BODY_RATIO = 0.20;
  const MIN_SECTIONS = 2;

  // Quality guard: reject thin descriptions
  if (desc && sourceLength > 0) {
    const ratio = desc.length / sourceLength;
    if (ratio < MIN_BODY_RATIO) {
      console.warn(`  ⚠️ PEMSA body ratio too low for "${title}": ${(ratio * 100).toFixed(1)}% (need ≥${(MIN_BODY_RATIO * 100).toFixed(0)}%)`);
    }
    if (sectionCount < MIN_SECTIONS && sourceLength > 400) {
      console.warn(`  ⚠️ PEMSA too few sections for "${title}": ${sectionCount} (need ≥${MIN_SECTIONS})`);
    }
  }

  const sourceLang = detectLang(desc || title, 'it');
  const slug = slugify(`${title} pemsa ${city}`);
  return {
    sourceLang,
    ...sourceSlotTitleAndSlug(title, slug, sourceLang),
    descriptionByLocale: desc ? { [sourceLang]: desc } : {},
  };
}

// Text the crawler side once wrote into PEMSA descriptions, only ever
// recognised to be removed from stored records (`dropFabricatedDescriptions`
// in the runner, before the merge): the recruitment paragraph the builder
// invented, in its four languages, and the central company paragraph
// `ensureMinimumDescriptionWordCount` appended to short bodies. The latter is
// matched on its first sentence read from dedicated-crawler-common (never
// copied here), across the "• " line breaks `normalizeDescriptionBullets`
// inserted into the stored copies.
const PEMSA_CENTRAL_BOILERPLATE_LEAD = String(getCompanyBoilerplateIT('PEMSA') || '').split(/(?<=\.)\s/)[0].trim();
export const PEMSA_FABRICATED_DESCRIPTION_RE = new RegExp([
  '(?:^|\\n)PEMSA, (?:agenzia di reclutamento specializzata|a staffing agency specialised|eine auf Bau und Technik spezialisierte|agence de recrutement spécialisée)',
  ...(PEMSA_CENTRAL_BOILERPLATE_LEAD
    ? [PEMSA_CENTRAL_BOILERPLATE_LEAD.split(/\s+/).map((word) => word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('[\\s•*-]+')]
    : []),
].join('|'), 'i');
function pemsaSourceBody(job = {}) {
  const candidates = [job?.descriptionByLocale?.[job?.sourceLang], job?.description];
  // The shared 50-word floor (source-body-floor.mjs) for the fresh and the
  // stored body alike: 100 characters let a 20-word text through.
  for (const raw of candidates) {
    const text = String(raw || '').trim();
    if (meetsSourceBodyFloor(text)) return text;
  }
  return '';
}

/**
 * Merge a freshly built PEMSA job with its stored record (pure). The stored
 * record has already lost any crawler-written text
 * (`dropFabricatedDescriptions` with `PEMSA_FABRICATED_DESCRIPTION_RE`).
 *
 * - No body this run: keep the body an earlier run read from the source, with
 *   its language; without one the job is not published (returns null).
 * - A re-derived source language drops the mislabeled verbatim copy of the
 *   source under the old key (`repairRelabeledSourceLocale`) and sets
 *   `needsRetranslation`, so the translation step rebuilds the other locales
 *   from the real source text.
 *
 * @param {object|null} prev  Stored record, or null for a new job.
 * @param {object}      job   Fresh job from `buildPemsaJob`.
 * @returns {object|null}
 */
export function mergePemsaJobRecord(prev, job) {
  let fresh = job;
  if (!pemsaSourceBody(fresh)) {
    const storedBody = prev ? pemsaSourceBody(prev) : '';
    if (!storedBody) return null;
    // Re-derive the language from the kept body: the stored label may be
    // the title-derived one this change corrects.
    const storedLang = detectLang(storedBody, prev.sourceLang || 'it');
    fresh = {
      ...fresh,
      sourceLang: storedLang,
      description: storedBody,
      descriptionByLocale: { [storedLang]: storedBody },
    };
  }
  if (!prev) return fresh;

  const sourceLang = fresh.sourceLang || prev.sourceLang || 'it';
  const merged = {
    ...prev,
    ...fresh,
    ...(hasPostingDateProvenance(prev) || hasPostingDateProvenance(fresh) ? mergeSourcePostingDates(prev, fresh) : {}),
    sourceLang,
    titleByLocale: mergeLocaleTextMap(prev.titleByLocale, fresh.titleByLocale || {}, 3, sourceLang),
    descriptionByLocale: mergeLocaleTextMap(prev.descriptionByLocale, fresh.descriptionByLocale || {}, 30, sourceLang),
    slugByLocale: mergeLocaleTextMap(prev.slugByLocale, fresh.slugByLocale || {}, 3),
  };

  const relabeled = Boolean(prev.sourceLang && prev.sourceLang !== sourceLang);
  if (relabeled) {
    const relabel = { prevLang: prev.sourceLang, nextLang: sourceLang };
    merged.titleByLocale = repairRelabeledSourceLocale(merged.titleByLocale, {
      ...relabel,
      sourceTexts: [fresh.title, prev.title],
    }).map;
    merged.descriptionByLocale = repairRelabeledSourceLocale(merged.descriptionByLocale, {
      ...relabel,
      sourceTexts: [fresh.description, prev.description],
    }).map;
  }
  if (relabeled) merged.needsRetranslation = true;
  dropStaleLocaleDescriptions(merged);
  return merged;
}
