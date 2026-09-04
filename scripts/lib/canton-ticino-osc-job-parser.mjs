#!/usr/bin/env node
/**
 * Canton Ticino — Organizzazione Sociopsichiatrica Cantonale (OSC)
 * and other Dipartimento della Sanità e della Socialità (DSS) postings
 * published on the official cantonal jobportal `concorsi.ti.ch`.
 *
 * The OSC operates the Clinica psichiatrica cantonale (CPC, Mendrisio) and
 * regional outpatient psychiatric services across Ticino. These jobs are
 * NOT discoverable via dedicated parsers (no standalone career page) — they
 * flow through the cantonal `Foglio Ufficiale` aggregator (rexx-systems CMS).
 *
 * Source:
 *   Listing: https://www.concorsi.ti.ch/
 *   Detail : https://www.concorsi.ti.ch/offerte-d'impieghi.html?yid={N}&sid={sid}
 *
 * Workflow:
 *  1. Fetch the listing index (~18 active concorsi).
 *  2. Extract `yid` ids + anchor text (title preview).
 *  3. For each yid, fetch the detail page.
 *  4. Filter to entries where:
 *       - body contains "Dipartimento della sanità e della socialità", OR
 *       - title/body references OSC, Mendrisio, CPC, sociopsichiatric*, EOC,
 *         ente ospedaliero, Clinica psichiatrica cantonale.
 *  5. Skip "Candidature spontanee" (non-job placeholder).
 *  6. Build description from the h2 sections (Compiti, Requisiti, Osservazioni,
 *     Condizioni di presentazione, Condizioni d'impiego, Scadenza).
 *
 * Stable id = yid (cantonal record id, stable for the lifetime of the concorso).
 *
 * Note: jobs are sub-allocated to the right canton (TI) but the location text
 * always reads "Mendrisio" for OSC; some DSS jobs may sit in Bellinzona/Lugano.
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
import { inferSwissTargetCanton } from './target-swiss-locations.mjs';
import { isCantonTicinoOscPosting } from './crawler-company-ownership.mjs';

/* ── Constants ─────────────────────────────────────────────── */

export const CANTON_TICINO_OSC_KEY = 'canton-ticino-osc';
export const CANTON_TICINO_OSC_COMPANY_NAME =
  'Organizzazione Sociopsichiatrica Cantonale (OSC) — Cantone Ticino';
export const CANTON_TICINO_OSC_COMPANY_DOMAIN = 'concorsi.ti.ch';

const LISTING_URL = 'https://www.concorsi.ti.ch/';
const BASE_URL = 'https://www.concorsi.ti.ch';

// Drop these entirely (placeholders / cross-dept).
const SKIP_TITLE_RE = /Candidatur[ae]\s+spontane|spontanbewerb/i;

/* ── Company matchers ──────────────────────────────────────── */

export function isCantonTicinoOscJob(job) {
  return isCantonTicinoOscPosting(job);
}

export function isTrustedDomain(rawUrl = '') {
  try {
    const host = new URL(rawUrl).hostname.toLowerCase();
    return host === 'concorsi.ti.ch' || host.endsWith('.concorsi.ti.ch')
      || host === 'www.concorsi.ti.ch';
  } catch {
    return false;
  }
}

/* ── Helpers ───────────────────────────────────────────────── */

/**
 * Try to derive the city from the title/body text. Defaults to Mendrisio
 * (OSC headquarters / Clinica Psichiatrica Cantonale).
 */
function inferLocation(haystack) {
  const t = String(haystack || '');
  const cities = [
    ['Mendrisio', '6850'],
    ['Casvegno', '6850'],   // CPC campus inside Mendrisio
    ['Cademario', '6936'],  // OSC clinic
    ['Lugano', '6900'],
    ['Bellinzona', '6500'],
    ['Locarno', '6600'],
    ['Chiasso', '6830'],
    ['Coldrerio', '6877'],
  ];
  for (const [city, postal] of cities) {
    if (new RegExp(`\\b${city}\\b`, 'i').test(t)) return { city, postal };
  }
  return { city: 'Mendrisio', postal: '6850' };
}

/* ── Listing parser ────────────────────────────────────────── */

/**
 * Parse the index page; return [{ yid, anchorText }].
 */
export function parseConcorsiListingIndex(html = '') {
  const out = [];
  const seen = new Set();
  // Anchor:  <a href="https://www.concorsi.ti.ch/offerte-d'impieghi.html?yid=4091&amp;sid=…">title</a>
  const linkRe = /<a[^>]+href="([^"]*offerte-d[^"]*\?yid=(\d+)[^"]*)"[^>]*>([\s\S]*?)<\/a>/gi;
  let m;
  while ((m = linkRe.exec(html)) !== null) {
    const yid = m[2];
    if (seen.has(yid)) continue;
    seen.add(yid);
    const anchorText = normalizeSpace(
      decodeEntities(String(m[3]).replace(/<[^>]+>/g, '')),
    );
    out.push({ yid, anchorText });
  }
  return out;
}

/* ── Detail parser ─────────────────────────────────────────── */

/**
 * Extract structured fields from a detail page.
 */
export function parseConcorsiDetail(html = '') {
  // h2 blocks in document order:
  //   [0] = Dipartimento della sanità e della socialità (or other dept name)
  //   [1] = concorso #/yy (e.g. 23/26)
  //   [2] = full title (long sentence)
  //   [3+] = Compiti, Requisiti, Osservazioni, Condizioni di presentazione,
  //          Condizioni d'impiego, Scadenza
  const heads = [];
  const headRe = /<h2[^>]*>([\s\S]*?)<\/h2>/gi;
  let hm;
  while ((hm = headRe.exec(html)) !== null) {
    const txt = normalizeSpace(
      decodeEntities(String(hm[1]).replace(/<[^>]+>/g, '')),
    );
    if (!txt || txt === '&nbsp;') continue;
    heads.push({ text: txt, start: hm.index, end: headRe.lastIndex });
  }
  if (heads.length === 0) return null;

  // Department = first heading that mentions "Dipartimento" OR first heading
  // (some non-DSS jobs use just the office name, e.g. "Controllo cantonale
  // delle finanze").
  let dept = '';
  let titleIdx = -1;
  for (let i = 0; i < heads.length; i += 1) {
    if (/^\d+\/\d+/.test(heads[i].text)) {
      titleIdx = i + 1; // title is the next non-empty h2
      if (i > 0) dept = heads[i - 1].text;
      break;
    }
  }
  if (titleIdx < 0 || titleIdx >= heads.length) return null;

  const title = heads[titleIdx].text;
  if (!title || title.length < 10) return null;

  // Body sections: everything from title.end to the next h2 (Compiti / etc),
  // and concatenate Compiti…Scadenza for the description.
  const sectionStart = heads[titleIdx].end;
  const sectionEnd = html.search(/<\/?(footer|nav|aside)/i);
  const bodyHtml = html.slice(sectionStart, sectionEnd > sectionStart ? sectionEnd : undefined);
  // Compiti/Requisiti are <ul><li> lists on the source page; htmlToText flattens
  // </li> to a bare newline, dropping the bullet so the description reads as flat
  // prose (fails the parser-quality structured-content check). Inject a newline +
  // bullet at each list item — same idiom as rexx-systems-job-parser-common.mjs —
  // so the bullet lands at line start even for a single-item list right after
  // inline text (a bare `<li>•` would depend on a preceding block close).
  const bulletedBodyHtml = bodyHtml.replace(/<li[^>]*>/gi, '\n• ');
  let text = htmlToText(bulletedBodyHtml);

  // sectionEnd only cuts on footer|nav|aside, so the inline navigation anchors
  // ("Indietro", "candidatura online »") leak into the description tail and end
  // up in the indexed JobPosting. Strip that trailing chrome cluster.
  text = text.replace(/\s*\bIndietro\b[\s·|]*candidatura\s+online\s*»?\s*$/i, '').trim();

  return { dept, title, text };
}

/* ── Description fallback ──────────────────────────────────── */

function buildFallbackDescription(title, city) {
  return [
    `${title} presso l'Amministrazione cantonale del Ticino (sede di ${city}).`,
    '',
    "Il concorso è pubblicato dalla Sezione delle risorse umane del Cantone Ticino sul portale ufficiale www.concorsi.ti.ch (Foglio Ufficiale). L'Organizzazione sociopsichiatrica cantonale (OSC) gestisce la Clinica psichiatrica cantonale (CPC) di Mendrisio e i servizi psichiatrici e psicosociali ambulatoriali su tutto il territorio ticinese, inseriti nel Dipartimento della sanità e della socialità (DSS).",
    '',
    "Il dettaglio completo (compiti, requisiti, condizioni d'impiego, scadenza e modalità di candidatura) è disponibile sul bando ufficiale linkato. Le candidature avvengono tramite il portale concorsi.ti.ch oppure secondo le istruzioni del bando.",
  ].join('\n');
}

/* ── Main fetch ────────────────────────────────────────────── */

export async function fetchAllCantonTicinoOscJobs() {
  const timeoutMs = Number(process.env.JOBS_CRAWLER_TIMEOUT_MS) || 20000;
  const requestDelayMs = Number(process.env.JOBS_CRAWLER_DELAY_MS) || 350;

  console.log(`🏥 Fetching ${CANTON_TICINO_OSC_COMPANY_NAME} jobs`);
  console.log(`   Source: ${LISTING_URL} (TI cantonal jobportal — filtered to DSS / OSC)\n`);

  let indexHtml;
  try {
    indexHtml = await fetchHtml(LISTING_URL, { timeoutMs });
  } catch (err) {
    throw new Error(`Failed to fetch concorsi.ti.ch index: ${err?.message || err}`);
  }
  const candidates = parseConcorsiListingIndex(indexHtml);
  console.log(`  📋 Found ${candidates.length} active concorsi on index\n`);
  if (candidates.length === 0) return [];

  const jobs = [];
  const todayIso = new Date().toISOString().slice(0, 10);

  for (const cand of candidates) {
    if (SKIP_TITLE_RE.test(cand.anchorText)) {
      console.log(`  ⏭  yid=${cand.yid} skipped (spontaneous): ${cand.anchorText.slice(0, 60)}`);
      continue;
    }

    const detailUrl = `${BASE_URL}/offerte-d'impieghi.html?yid=${cand.yid}`;
    let detailHtml;
    try {
      detailHtml = await fetchHtml(detailUrl, { timeoutMs });
    } catch (err) {
      console.warn(`  ⚠️  yid=${cand.yid} detail fetch failed: ${err?.message || err}`);
      continue;
    }

    const detail = parseConcorsiDetail(detailHtml);
    if (!detail) {
      console.warn(`  ⚠️  yid=${cand.yid} no structured detail`);
      continue;
    }

    // Exact OSC ownership: generic DSS/health vacancies remain with the
    // cantonal-administration crawler even though they share this board.
    const haystack = `${detail.dept} ${detail.title} ${detail.text}`;
    if (!isCantonTicinoOscPosting(detail)) {
      console.log(`  ⏭  yid=${cand.yid} skipped (not OSC: ${detail.dept || 'no dept'})`);
      continue;
    }

    const title = detail.title;
    const loc = inferLocation(`${title} ${detail.text}`);
    let description = detail.text && detail.text.split(/\s+/).length >= 80
      ? detail.text
      : buildFallbackDescription(title, loc.city);
    if (description.split(/\s+/).length < 100) {
      description = `${description}\n\n${buildFallbackDescription(title, loc.city)}`;
    }

    const sourceLang = 'it';
    const jobSlug = slugify(`${title} ${CANTON_TICINO_OSC_KEY} ${loc.city}`);
    const urlHash = createHash('sha1').update(`${detailUrl}|${cand.yid}`).digest('hex').slice(0, 12);
    const employmentType = detectHealthcareEmploymentType(haystack);

    jobs.push({
      id: `${CANTON_TICINO_OSC_KEY}-${cand.yid}-${urlHash}`,
      slug: jobSlug,
      slugByLocale: { [sourceLang]: jobSlug },
      company: CANTON_TICINO_OSC_COMPANY_NAME,
      companyKey: CANTON_TICINO_OSC_KEY,
      companyDomain: CANTON_TICINO_OSC_COMPANY_DOMAIN,
      title,
      titleByLocale: { [sourceLang]: title },
      description,
      descriptionByLocale: { [sourceLang]: description },
      needsRetranslation: true,
      location: loc.city,
      canton: inferSwissTargetCanton(loc.city) || 'TI',
      url: detailUrl,
      source: 'Canton Ticino OSC Dedicated Parser (rexx-systems jobportal, DSS filter)',
      sourceLang,
      crawledAt: new Date().toISOString(),

      addressLocality: loc.city,
      addressRegion: 'TI',
      addressCountry: 'CH',
      country: 'CH',
      postalCode: loc.postal,
      category: detectHealthcareCategory(haystack),
      contract: employmentType === 'PART_TIME' ? 'part-time' : 'full-time',
      employmentType,
      experienceLevel: detectHealthcareExperienceLevel(haystack),
      sector: 'Sanità / Ospedali',
      currency: 'CHF',
      featured: false,
      postedDate: todayIso,
      applyUrl: detailUrl,
      requirements: [],
      requirementsByLocale: { [sourceLang]: [] },
    });

    console.log(`  ✅ yid=${cand.yid} ${title.substring(0, 75)} → ${loc.city}`);

    // Polite pacing — cantonal site is small.
    if (requestDelayMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, requestDelayMs));
    }
  }

  // Reconcile sourceLang via detectLang (Italian is canonical for TI canton).
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

  console.log(`\n📋 Total ${CANTON_TICINO_OSC_COMPANY_NAME} jobs discovered: ${jobs.length}`);
  return jobs;
}
