#!/usr/bin/env node
/**
 * Klinik Gut AG (Gruppe) — orthopaedic / accident private clinic group in
 * Graubünden + Ascona. HQ in St. Moritz (postal 7500).
 *
 * Public career site (Drupal 11 — RZ theme), German source:
 *   https://www.klinik-gut.ch/de/offene-stellen   ← openings (HTTP 200)
 *
 * Source migration (2026-06, #2966 — crawler-health "broken", 0 jobs):
 *   The previous shape — per-opening `rz-infobox__item` cards on
 *   `…/de/jobs-karriere`, each linking to a `…/de/{slug}` detail page — is GONE.
 *   `…/de/jobs-karriere` now only carries a "Social Media" infobox + location
 *   teasers + a CTA to `…/de/offene-stellen`, so the old listing parser matched
 *   only the off-domain social card and returned zero jobs. Meanwhile the old
 *   `…/de/offene-stellen` HTTP 403 "Zugriff verweigert" wall (#1872) has been
 *   LIFTED: that page now serves 200 to a plain `fetch()` (bot UA included) and
 *   inlines every opening as a Bootstrap accordion, grouped per clinic site:
 *
 *     <h2><a class="btn btn-primary" … title="Klinik Gut St. Moritz">…</a></h2>   ← site
 *     <div class="field__item accordion-item" …>
 *       <h2 class="accordion-header">
 *         <button class="accordion-button …" data-bs-target="#drz-accordion-id-2110">
 *           {title}
 *         </button>
 *       </h2>
 *       <div id="drz-accordion-id-2110" class="accordion-collapse collapse">
 *         <div class="accordion-body"> …full posting body… </div>
 *       </div>
 *     </div>
 *
 *   The full posting body is inline in each `accordion-body` (no detail page to
 *   fetch). The numeric `drz-accordion-id-{NNNN}` is the stable Drupal node id —
 *   used as the canonical per-job token (survives re-crawls). Each job's URL is
 *   the deep-link `…/de/offene-stellen#drz-accordion-id-{NNNN}` (the Galenica
 *   `#job.id=` fragment pattern — `mergeUrlKey`/`assembleUrlKey` preserve the
 *   fragment so the N positions stay distinct).
 *
 * Rendering: server-rendered HTML, so a plain `fetchHtml()` (with the shared
 * Jina clean-IP WAF fallback) replaces the previous Playwright Chromium session
 * — quota-free, no headless browser.
 *
 * Group sites: Klinik St. Moritz (7500), Klinik Fläsch (7306), Praxis Chur /
 * Buchs SG / Zürich / Ascona. Default location = St. Moritz (HQ, GR).
 */
import { createHash } from 'node:crypto';
import { detectLang } from './dedicated-crawler-common.mjs';
import { slugify, fetchHtml } from './crawler-template.mjs';
import {
  decodeEntities,
  normalizeSpace,
  htmlToText,
  detectHealthcareCategory,
  detectHealthcareExperienceLevel,
  detectHealthcareEmploymentType,
} from './hospital-custom-html-helpers.mjs';
import { inferSwissTargetCanton } from './target-swiss-locations.mjs';

/* ── Constants ─────────────────────────────────────────────── */

export const KLINIK_GUT_KEY = 'klinik-gut';
export const KLINIK_GUT_COMPANY_NAME = 'Klinik Gut AG';
export const KLINIK_GUT_COMPANY_DOMAIN = 'klinik-gut.ch';

// Public openings page (HTTP 200). The 403 "Zugriff verweigert" wall on this
// node (#1872) has been lifted; it now inlines every opening as an accordion.
export const PUBLIC_CAREER_URL = 'https://www.klinik-gut.ch/de/offene-stellen';

const STANDORT_PROFILE = {
  'st. moritz': { city: 'St. Moritz', canton: 'GR', postal: '7500' },
  'st moritz':  { city: 'St. Moritz', canton: 'GR', postal: '7500' },
  'flaesch':    { city: 'Fläsch',     canton: 'GR', postal: '7306' },
  'fläsch':     { city: 'Fläsch',     canton: 'GR', postal: '7306' },
  'chur':       { city: 'Chur',       canton: 'GR', postal: '7000' },
  'buchs':      { city: 'Buchs SG',   canton: 'SG', postal: '9470' },
  'zürich':     { city: 'Zürich',     canton: 'ZH', postal: '8001' },
  'zuerich':    { city: 'Zürich',     canton: 'ZH', postal: '8001' },
  'ascona':     { city: 'Ascona',     canton: 'TI', postal: '6612' },
};

const DEFAULT_LOCATION = { city: 'St. Moritz', canton: 'GR', postal: '7500' };

/* ── Company matchers ──────────────────────────────────────── */

export function isKlinikGutJob(job) {
  const key = String(job?.companyKey || '').toLowerCase();
  const company = String(job?.company || '').toLowerCase();
  const url = String(job?.url || '').toLowerCase();
  return (
    key === KLINIK_GUT_KEY ||
    key.startsWith('klinik-gut') ||
    company.includes('klinik gut') ||
    url.includes('klinik-gut.ch')
  );
}

export function isTrustedDomain(rawUrl = '') {
  try {
    const host = new URL(rawUrl).hostname.toLowerCase();
    return host === 'klinik-gut.ch' || host.endsWith('.klinik-gut.ch');
  } catch {
    return false;
  }
}

/* ── Helpers ───────────────────────────────────────────────── */

/**
 * Resolve a group-site profile from card text, but ONLY when exactly one site
 * is named — a card mentioning both St. Moritz AND Fläsch (the common case)
 * stays on the HQ default rather than picking an arbitrary one.
 */
function resolveCardLocation(text) {
  const lc = String(text || '').toLowerCase();
  const cities = new Set();
  let firstHit = null;
  for (const key of Object.keys(STANDORT_PROFILE)) {
    if (lc.includes(key)) {
      cities.add(STANDORT_PROFILE[key].city);
      if (!firstHit) firstHit = STANDORT_PROFILE[key];
    }
  }
  return cities.size === 1 ? firstHit : null;
}

/* ── Parser: openings (accordion items) ────────────────────── */

/**
 * Parse the `…/de/offene-stellen` page into a list of openings. Each opening is
 * a Bootstrap accordion item: the title lives in the `accordion-button` text and
 * the full posting body in the matching `accordion-collapse` → `accordion-body`.
 * Openings are grouped under per-site headings rendered as
 * `<a class="btn btn-primary" … title="Klinik Gut St. Moritz">` — the nearest
 * preceding heading scopes the location.
 *
 * Returns `{ id, num, title, body, detailUrl, location }[]`. `num` is the stable
 * Drupal node id (the `drz-accordion-id-{NNNN}` suffix); `detailUrl` is the
 * fragment deep-link to that accordion item.
 */
export function parseKlinikGutOpenings(html = '') {
  if (!html || typeof html !== 'string') return [];

  // Per-site headings: `<a class="btn btn-primary" … title="Klinik Gut Fläsch">`.
  // Record each heading's position + the location it resolves to so the nearest
  // preceding heading can scope each opening below.
  const sections = [];
  const secRe = /<a[^>]*class="[^"]*\bbtn-primary\b[^"]*"[^>]*\btitle="([^"]*)"[^>]*>/gi;
  let sm;
  while ((sm = secRe.exec(html)) !== null) {
    sections.push({ pos: sm.index, location: resolveCardLocation(decodeEntities(sm[1])) });
  }

  // Each opening = an `accordion-button` carrying `data-bs-target="#drz-accordion-id-NNNN"`.
  const buttons = [];
  const btnRe =
    /<button[^>]*\baccordion-button\b[^>]*data-bs-target="#(drz-accordion-id-(\d+))"[^>]*>([\s\S]*?)<\/button>/gi;
  let bm;
  while ((bm = btnRe.exec(html)) !== null) {
    const title = normalizeSpace(decodeEntities(bm[3].replace(/<[^>]+>/g, ' ')));
    if (!title || title.length < 3) continue;
    buttons.push({ pos: bm.index, domId: bm[1], num: bm[2], title });
  }
  if (buttons.length === 0) return [];

  // Body of each opening is bounded by the next opening OR the next per-site
  // heading (so a trailing PDF/contact paragraph of the last item in a group,
  // and the next group's heading, never leak into the description).
  const boundaries = [...buttons.map((b) => b.pos), ...sections.map((s) => s.pos)].sort(
    (a, b) => a - b,
  );

  const out = [];
  const seen = new Set();
  for (const btn of buttons) {
    if (seen.has(btn.num)) continue;
    seen.add(btn.num);

    const idIdx = html.indexOf(`id="${btn.domId}"`, btn.pos);
    let body = '';
    if (idIdx >= 0) {
      const bodyOpen = /<div[^>]*\baccordion-body\b[^>]*>/i.exec(html.slice(idIdx));
      const bodyStart = bodyOpen ? idIdx + bodyOpen.index + bodyOpen[0].length : idIdx;
      const next = boundaries.find((p) => p > btn.pos) ?? html.length;
      body = htmlToText(html.slice(bodyStart, Math.max(bodyStart, next)));
      // Trim a trailing contact card ("Zuständige Personen …") if it leaked past
      // the bound, then strip the file-download artifact a Drupal
      // `paragraph--type--document` leaves inline ("Datei <file>.pdf (288 KB)").
      const contactIdx = body.search(/Zuständige Personen/i);
      if (contactIdx > 80) body = body.slice(0, contactIdx).trimEnd();
      body = body
        .replace(
          /\s*(?:Datei\s+)?[\w.\-]+\.(?:pdf|docx?|xlsx?|pptx?|zip)\s*(?:\(\s*[\d.,]+\s*[KMGT]?B\s*\))?/gi,
          '',
        )
        .replace(/[ \t]+\n/g, '\n')
        .trim();
    }

    // Scope to the nearest preceding per-site heading that resolves to one site.
    let location = DEFAULT_LOCATION;
    for (const s of sections) {
      if (s.pos >= btn.pos) break;
      if (s.location) location = s.location;
    }

    const detailUrl = `${PUBLIC_CAREER_URL}#${btn.domId}`;
    out.push({ id: btn.domId, num: btn.num, title: btn.title, body, detailUrl, location });
  }

  return out;
}

/* ── Description fallback ──────────────────────────────────── */

function buildFallbackDescription(title, cityName) {
  return [
    `${title} bei der Klinik Gut AG am Standort ${cityName}.`,
    '',
    'Die Klinik Gut ist eine etablierte private Klinik-Gruppe für Orthopädie, Unfallchirurgie und Sportmedizin mit Hauptstandorten in St. Moritz und Fläsch (Graubünden) sowie Praxisstandorten in Chur, Buchs SG, Zürich und Ascona. Sie betreut nationale und internationale Patientinnen und Patienten und legt Wert auf ein engagiertes Team und individuelle Versorgung.',
  ].join('\n');
}

/* ── Main fetch ────────────────────────────────────────────── */

export async function fetchAllKlinikGutJobs() {
  console.log(`🏥 Fetching ${KLINIK_GUT_COMPANY_NAME} jobs`);
  console.log(`   Source: ${PUBLIC_CAREER_URL} (Drupal 11 — DE source, accordion)\n`);

  // fetchHtml carries the shared retry + Jina clean-IP fallback for an
  // IP-reputation WAF; a genuine HTTP error (404 source gone, persistent 5xx)
  // propagates so the shared pipeline surfaces a real break rather than wiping
  // the existing slice. A connection-level failure is soft-handled upstream.
  const listingHtml = await fetchHtml(PUBLIC_CAREER_URL, {
    headers: { 'Accept-Language': 'de-CH,de;q=0.9,en;q=0.8' },
  });

  const openings = parseKlinikGutOpenings(listingHtml);
  console.log(`  📋 Found ${openings.length} openings\n`);
  if (openings.length === 0) {
    // A 200 page with zero accordion items is a real "no current openings" state
    // OR a markup change — surface it but don't crash the whole pipeline. The
    // crawler-health monitor still catches a persistent 0-job streak.
    console.warn('⚠️ No vacancies parsed from Klinik Gut openings page.');
    return [];
  }

  const todayIso = new Date().toISOString().slice(0, 10);
  const jobs = [];

  for (const opening of openings) {
    const title = opening.title;
    const loc = opening.location || DEFAULT_LOCATION;

    // The full posting body is inline in the accordion item — no detail fetch.
    let description = opening.body && opening.body.split(/\s+/).length >= 40
      ? opening.body
      : buildFallbackDescription(title, loc.city);
    if (description.split(/\s+/).length < 80) {
      description = `${description}\n\n${buildFallbackDescription(title, loc.city)}`;
    }

    const haystack = `${title} ${description}`;
    const sourceLang = detectLang(description || title, 'de');
    const jobSlug = slugify(`${title} ${KLINIK_GUT_KEY} ${loc.city}`);
    const url = opening.detailUrl;
    const urlHash = createHash('sha1')
      .update(`${url}|${opening.num}`)
      .digest('hex')
      .slice(0, 12);
    const employmentType = detectHealthcareEmploymentType(haystack);

    jobs.push({
      id: `${KLINIK_GUT_KEY}-${opening.num}-${urlHash}`,
      slug: jobSlug,
      slugByLocale: { [sourceLang]: jobSlug },
      company: KLINIK_GUT_COMPANY_NAME,
      companyKey: KLINIK_GUT_KEY,
      companyDomain: KLINIK_GUT_COMPANY_DOMAIN,
      title,
      titleByLocale: { [sourceLang]: title },
      description,
      descriptionByLocale: { [sourceLang]: description },
      needsRetranslation: true,
      location: loc.city,
      canton: inferSwissTargetCanton(loc.city) || loc.canton,
      url,
      source: 'Klinik Gut Dedicated Parser (Drupal accordion)',
      sourceLang,
      crawledAt: new Date().toISOString(),

      addressLocality: loc.city,
      addressRegion: loc.canton,
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
      applyUrl: url,
      requirements: [],
      requirementsByLocale: { [sourceLang]: [] },
    });

    console.log(`  ✅ ${title.substring(0, 65)} → ${loc.city} (${opening.id})`);
  }

  console.log(`\n📋 Total ${KLINIK_GUT_COMPANY_NAME} jobs discovered: ${jobs.length}`);
  return jobs;
}
