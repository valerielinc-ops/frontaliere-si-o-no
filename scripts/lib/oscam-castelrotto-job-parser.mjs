#!/usr/bin/env node
import { sourcePostingDateFields } from './source-posting-date.mjs';
/**
 * Ospedale Malcantonese OSCAM (Fondazione Giuseppe Rossi), Castelrotto (TI).
 *
 * Public career site (Italian only, WordPress + ACF):
 *   https://www.oscam.ch/lavoraconnoi/
 *
 * Each open competition ("concorso attivo") is published as:
 *
 *   <h2>CONCORSI ATTIVI</h2>
 *   <h3>{concorso title}</h3>
 *   <h4><a …> Apri il <a href="…YYYY/MM/{slug}.pdf">{concorso title (or short)}</a></h4>
 *   <hr />
 *   …repeats…
 *   <h3>Certificato medico da compilare</h3>   ← boundary (form, not a job)
 *   <h3>Autocertificazioni</h3>                ← boundary
 *
 * Strategy:
 *  - Slice the page between `CONCORSI ATTIVI` and `Certificato medico da compilare`
 *    (or `Autocertificazioni`, or `CANDIDATURE`, or end-of-section).
 *  - Each `<h3>` inside that slice is a concorso.
 *  - The associated PDF is the LAST anchor inside the next `<h4>…Apri il…</h4>` block
 *    (skipping the static document-icon anchor that points to a placeholder).
 *  - The description is the text of the PDF bando only (the page itself doesn't
 *    expose body content); a bando without readable text gets none.
 *
 * Inventory note: 3 concorsi at probe time. OSCAM serves Malcantone (Castelrotto,
 * postal 6980) — TI audience priority for the frontaliere job-board.
 */
import { createHash } from 'node:crypto';
import { detectLang } from './dedicated-crawler-common.mjs';
import { slugify } from './crawler-template.mjs';
import { textFragmentUrl } from './text-fragment-url.mjs';
import {
  fetchHtml,
  decodeEntities,
  normalizeSpace,
  detectHealthcareCategory,
  detectHealthcareExperienceLevel,
  detectHealthcareEmploymentType,
} from './hospital-custom-html-helpers.mjs';
import { buildPdfBackedDescription, extractPdfJobContentFromUrl } from './pdf-job-content.mjs';

/* ── Constants ─────────────────────────────────────────────── */

export const OSCAM_CASTELROTTO_KEY = 'oscam-castelrotto';
export const OSCAM_CASTELROTTO_COMPANY_NAME =
  'Ospedale Malcantonese OSCAM (Fondazione Giuseppe Rossi)';
export const OSCAM_CASTELROTTO_COMPANY_DOMAIN = 'oscam.ch';
export const OSCAM_CASTELROTTO_ADDRESS = Object.freeze({
  streetAddress: 'Nucleo 30',
  addressLocality: 'Castelrotto',
  addressRegion: 'TI',
  postalCode: '6980',
  addressCountry: 'CH',
});

const PUBLIC_CAREER_URL = 'https://www.oscam.ch/lavoraconnoi/';
const DEFAULT_CITY = 'Castelrotto';
const DEFAULT_CANTON = 'TI';
const DEFAULT_STREET = OSCAM_CASTELROTTO_ADDRESS.streetAddress;
const DEFAULT_POSTAL = OSCAM_CASTELROTTO_ADDRESS.postalCode;

// Stale placeholder PDF that lives inside every h4 wrapper (icon anchor).
const STATIC_PLACEHOLDER_RE = /\/Concorso_generale_medici_assistenti_01\.pdf$/i;

// Section boundaries (concorsi end and admin forms begin).
const SECTION_END_RE =
  /Certificato medico da compilare|Autocertificazioni|CANDIDATURE|NORMATIVE INTERNE/i;

// Concorso titles must contain at least one of these tokens — guards against
// accidentally promoting "Autocertificazioni" et al. if section boundaries shift.
const CONCORSO_TITLE_RE =
  /(concorso|bando|assunzione|medico|infermier|operator|persona|reparto)/i;

/* ── Company matchers ──────────────────────────────────────── */

export function isOscamCastelrottoJob(job) {
  const key = String(job?.companyKey || '').toLowerCase();
  const company = String(job?.company || '').toLowerCase();
  const url = String(job?.url || '').toLowerCase();
  return (
    key === OSCAM_CASTELROTTO_KEY ||
    key.startsWith('oscam') ||
    company.includes('ospedale malcantonese') ||
    company.includes('oscam') ||
    company.includes('fondazione giuseppe rossi') ||
    url.includes('oscam.ch')
  );
}

export function isTrustedDomain(rawUrl = '') {
  try {
    const host = new URL(rawUrl).hostname.toLowerCase();
    return host === 'oscam.ch' || host.endsWith('.oscam.ch');
  } catch {
    return false;
  }
}

/**
 * Merge key for an OSCAM record: its listing id, not its URL.
 *
 * The source changed from an invented page anchor to the bando PDF. The
 * parser's persisted id includes a URL digest, so strip only that final
 * digest before matching the old anchor record with the fresh PDF record.
 * This keeps mergePreserveLocaleData's existing-id/slug preservation path.
 *
 * @param {{ id?: string, url?: string }} job
 * @returns {string}
 */
export function oscamCastelrottoMatchKey(job = {}) {
  const id = String(job?.id || '').trim();
  if (id) return id.replace(/-[0-9a-f]{12}$/i, '');
  return String(job?.url || '').trim();
}

/* ── Parser ────────────────────────────────────────────────── */

/**
 * Extract concorsi from the OSCAM "lavora con noi" page.
 * Returns: [{ id, title, pdfUrl }]
 */
export function parseOscamCastelrottoListing(html = '') {
  if (!html || typeof html !== 'string') return [];

  const startIdx = html.search(/CONCORSI\s+ATTIVI/i);
  if (startIdx < 0) return [];

  // Slice to the first downstream section boundary.
  const tail = html.slice(startIdx);
  const endMatch = tail.match(SECTION_END_RE);
  const slice = endMatch ? tail.slice(0, endMatch.index) : tail;

  const out = [];
  const seen = new Set();

  // Index every <h3> within the slice.
  const headRe = /<h3[^>]*>([\s\S]*?)<\/h3>/gi;
  const heads = [];
  let hm;
  while ((hm = headRe.exec(slice)) !== null) {
    heads.push({ start: hm.index, end: headRe.lastIndex, raw: hm[1] });
  }
  if (heads.length === 0) return [];

  for (let i = 0; i < heads.length; i += 1) {
    const head = heads[i];
    const next = heads[i + 1];
    const block = slice.slice(head.end, next ? next.start : Math.min(head.end + 4000, slice.length));

    const title = normalizeSpace(
      decodeEntities(String(head.raw).replace(/<[^>]+>/g, '')),
    );
    if (!title || title.length < 5) continue;
    if (!CONCORSO_TITLE_RE.test(title)) continue;

    // Collect all anchor PDFs in the next-h4 region; the real concorso PDF
    // is the LAST one (the icon-anchor placeholder appears first).
    const pdfHrefs = [...block.matchAll(/href="([^"]+\.pdf)"/gi)]
      .map((m) => m[1])
      .filter((href) => !STATIC_PLACEHOLDER_RE.test(href));

    const pdfUrl = pdfHrefs.length > 0 ? pdfHrefs[pdfHrefs.length - 1] : '';

    // Stable id from the PDF filename (preferred) or h3 slug fallback.
    let stableId;
    if (pdfUrl) {
      const fileBase = pdfUrl.split('/').pop() || '';
      stableId = slugify(fileBase.replace(/\.pdf$/i, '')).slice(0, 50);
    } else {
      stableId = slugify(title).slice(0, 50);
    }
    if (!stableId) continue;
    if (seen.has(stableId)) continue;
    seen.add(stableId);

    out.push({ id: stableId, title, pdfUrl });
  }

  return out;
}

/* ── Description ───────────────────────────────────────────── */

/**
 * The description of one concorso is the text of its PDF bando and nothing
 * else. The parser used to put two lines of its own before it ("<titolo>
 * presso l'Ospedale Malcantonese OSCAM …" and a paragraph on the hospital),
 * the PDF link after it, and to write "Il concorso è pubblicato come bando
 * ufficiale…" when the PDF had no text; a bando without readable text now gets
 * no description and takes the pipeline's thin-source path.
 */
export function buildDescription(pdfText = '') {
  return buildPdfBackedDescription({ pdfText });
}

/**
 * The former wrapper as it opened every description: "<titolo> presso
 * l'Ospedale Malcantonese OSCAM (Fondazione Giuseppe Rossi), Castelrotto
 * (Malcantone, Canton Ticino)." followed by the parser's whole paragraph on the
 * hospital. Anchored at the start of the text: a bando that quotes either line
 * further down is never taken for it.
 */
export const OSCAM_CASTELROTTO_FABRICATED_DESCRIPTION_RE =
  /^[^\n]{3,300} presso l'Ospedale Malcantonese OSCAM \(Fondazione Giuseppe Rossi\), Castelrotto \(Malcantone, Canton Ticino\)\.\n\nL'OSCAM è un ospedale di cure acute con sede a Castelrotto che serve la regione del Malcantone\. La fondazione Giuseppe Rossi gestisce reparti di medicina interna, chirurgia, psichiatria, ostetricia-ginecologia e cure palliative, oltre a un pronto soccorso e a servizi ambulatoriali per la popolazione del distretto di Lugano-Malcantone\.(?:\n\n|\s*$)/;

/* ── Main fetch ────────────────────────────────────────────── */

export async function fetchAllOscamCastelrottoJobs() {
  const timeoutMs = Number(process.env.JOBS_CRAWLER_TIMEOUT_MS) || 20000;

  console.log(`🏥 Fetching ${OSCAM_CASTELROTTO_COMPANY_NAME} jobs`);
  console.log(`   Source: ${PUBLIC_CAREER_URL} (custom HTML, IT source)\n`);

  let html;
  try {
    html = await fetchHtml(PUBLIC_CAREER_URL, { timeoutMs });
  } catch (err) {
    throw new Error(`Failed to fetch OSCAM career page: ${err?.message || err}`);
  }

  const listings = parseOscamCastelrottoListing(html);
  console.log(`  📋 Found ${listings.length} concorsi attivi\n`);
  if (listings.length === 0) {
    console.warn('⚠️ No concorsi parsed from OSCAM page.');
    return [];
  }

  const jobs = [];

  for (const listing of listings) {
    const title = listing.title;
    const sourceLang = 'it';
    let pdfText = '';
    if (listing.pdfUrl) {
      console.log(`  📄 Extracting PDF: ${listing.pdfUrl.split('/').pop()}`);
      const pdf = await extractPdfJobContentFromUrl(listing.pdfUrl, { timeoutMs });
      if (pdf.error) console.warn(`     ⚠️ PDF error: ${pdf.error}`);
      if (pdf.warning) console.warn(`     ⚠️ ${pdf.warning}`);
      pdfText = pdf.thin ? '' : (pdf.rawText || pdf.text || '');
    }
    const description = buildDescription(pdfText);
    const haystack = `${title} ${description}`;

    // The bando PDF IS the advertisement: it is the posting's URL. Without a
    // PDF the concorso is addressed by its heading on the page (text
    // fragment), never by an invented `#<slug>` anchor the page does not
    // have (issue 5253).
    const url = listing.pdfUrl
      ? listing.pdfUrl.replace(/^http:\/\//i, 'https://')
      : textFragmentUrl(PUBLIC_CAREER_URL, title);
    const jobSlug = slugify(`${title} ${OSCAM_CASTELROTTO_KEY} ${DEFAULT_CITY}`);
    const urlHash = createHash('sha1')
      .update(`${url}|${listing.id}`)
      .digest('hex')
      .slice(0, 12);
    const employmentType = detectHealthcareEmploymentType(haystack);

    jobs.push({
      id: `${OSCAM_CASTELROTTO_KEY}-${listing.id}-${urlHash}`,
      slug: jobSlug,
      slugByLocale: { [sourceLang]: jobSlug },
      company: OSCAM_CASTELROTTO_COMPANY_NAME,
      companyKey: OSCAM_CASTELROTTO_KEY,
      companyDomain: OSCAM_CASTELROTTO_COMPANY_DOMAIN,
      title,
      titleByLocale: { [sourceLang]: title },
      description,
      descriptionByLocale: { [sourceLang]: description },
      // Newly-discovered jobs ship source-locale-only; AI step backfills
      // EN/DE/FR. Without this flag the locale-completeness gate trips before
      // translation runs (see L1 in docs/plans/crawlers-batch-16-and-followup.md).
      needsRetranslation: true,
      location: DEFAULT_CITY,
      canton: DEFAULT_CANTON,
      url,
      source: 'OSCAM Castelrotto Dedicated Parser (WordPress HTML, PDF concorsi)',
      sourceLang,
      crawledAt: new Date().toISOString(),

      addressLocality: DEFAULT_CITY,
      addressRegion: DEFAULT_CANTON,
      streetAddress: DEFAULT_STREET,
      addressCountry: 'CH',
      country: 'CH',
      postalCode: DEFAULT_POSTAL,
      category: detectHealthcareCategory(haystack),
      contract: employmentType === 'PART_TIME' ? 'part-time' : 'full-time',
      employmentType,
      experienceLevel: detectHealthcareExperienceLevel(haystack),
      sector: 'Sanità / Ospedali',
      currency: 'CHF',
      featured: false,
      ...sourcePostingDateFields(''),
      applyUrl: listing.pdfUrl || url,
      requirements: [],
      requirementsByLocale: { [sourceLang]: [] },
    });

    console.log(`  ✅ ${title.substring(0, 70)} (${listing.id})`);
  }

  // Force source-lang detection consistency: the slot is the language of the
  // bando's text (the title when there is none).
  for (const j of jobs) {
    const detected = detectLang(j.description || j.title, 'it');
    if (detected !== j.sourceLang) {
      j.sourceLang = detected;
      j.titleByLocale = { [detected]: j.title };
      j.descriptionByLocale = { [detected]: j.description };
      j.slugByLocale = { [detected]: j.slug };
      j.requirementsByLocale = { [detected]: [] };
    }
  }

  console.log(
    `\n📋 Total ${OSCAM_CASTELROTTO_COMPANY_NAME} jobs discovered: ${jobs.length}`,
  );
  return jobs;
}
