#!/usr/bin/env node
/**
 * Psychiatrie Baselland (PBL) — dedicated job parser.
 *
 * Public career site: https://jobs.pbl.ch/
 *
 * PBL is the cantonal psychiatric hospital network of Basel-Landschaft (BL),
 * spanning Liestal, Bruderholz and Münchenstein. ~1'500 staff. Career portal
 * runs on the Prospective.ch "careercenter" SSR shell (template ID
 * `careercenter/1002053/...` visible in the page assets), but the public
 * `/medium/{ID}/jobs` JSON API returns HTTP 400 — same pattern as Spital STS
 * AG. We therefore scrape the SSR listing pages directly.
 *
 * Listing pattern (paginated 10 per page, `?offset={0,10,20,...}`):
 *   <div class="job job-N">
 *     <a class="job-title"
 *        href="https://jobs.pbl.ch/offene-stellen/{slug}/{uuid}"
 *        title="...">
 *       {Title} <p class="job-meta">{Location detail}</p>
 *     </a>
 *
 * Detail pattern (one URL per job — slug + uuid combo):
 *   <section id="topTitleArea"><h1>{Title}</h1>
 *     <div class="abteilungen"><h2>{Workplace}</h2><h2>{Team}</h2></div></section>
 *   <section id="tasks"><h3>Ihre Aufgaben</h3>{prose}</section>
 *   <section id="profile"><h3>Ihr Profil</h3>{prose}</section>
 *   <section><h3>Stellenantritt</h3>{prose}</section>
 *   <a href="https://jobs.pbl.ch/apply/ats/{uuid}"> ← apply URL
 *
 * Pattern is the standard Prospective Aequivital shell, similar to
 * `spital-sts-job-parser.mjs` (which uses the same SSR fallback after the
 * /medium API was deprecated).
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

/* ── Constants ─────────────────────────────────────────────── */

export const PBL_KEY = 'pbl';
export const PBL_COMPANY_NAME = 'Psychiatrie Baselland';
export const PBL_COMPANY_DOMAIN = 'pbl.ch';

const LISTING_BASE = 'https://jobs.pbl.ch/';
const MAX_PAGES = 12; // safety cap; each page holds 10 jobs
const PAGE_SIZE = 10;
const DETAIL_DELAY_MS = 220;
const POSTAL_CODE_LIESTAL = '4410';

/* ── Company matchers ──────────────────────────────────────── */

export function isPblJob(job) {
  const url = String(job?.url || '').toLowerCase();
  const company = String(job?.company || '').toLowerCase();
  const key = String(job?.companyKey || '').toLowerCase();
  return (
    key === PBL_KEY ||
    url.includes('jobs.pbl.ch') ||
    url.includes('pbl.ch') ||
    company.includes('psychiatrie baselland') ||
    company.includes('upk baselland') ||
    company === 'pbl'
  );
}

export function isTrustedDomain(rawUrl = '') {
  try {
    const host = new URL(rawUrl).hostname.toLowerCase();
    if (host === 'pbl.ch' || host.endsWith('.pbl.ch')) return true;
    // The Prospective ATS endpoint is the canonical "Jetzt bewerben" target
    if (host === 'ohws.prospective.ch') return true;
    return false;
  } catch {
    return false;
  }
}

/* ── Listing parser ────────────────────────────────────────── */

export function parseJobListHtml(html = '') {
  const out = [];
  const seen = new Set();
  // Match each `<a class="job-title" href=".../offene-stellen/{slug}/{uuid}"` anchor.
  // The listing markup is bare HTML; we don't need the surrounding `<div>` because
  // every job row contains exactly one such anchor.
  const rx = /<a\s+class="job-title"\s+href="(https:\/\/jobs\.pbl\.ch\/offene-stellen\/([a-z0-9-]+)\/([a-f0-9-]{36}))"[\s\S]*?title="([^"]*)"[\s\S]*?>([\s\S]*?)<\/a>/g;
  let m;
  while ((m = rx.exec(html))) {
    const detailUrl = m[1];
    const slug = m[2];
    const uuid = m[3];
    const titleAttr = decodeEntities(m[4]).replace(/\s*%\s*$/, '').trim();
    const inner = m[5];
    if (seen.has(uuid)) continue;
    seen.add(uuid);

    // Inside the anchor: text node = headline title, `<p class="job-meta">` = workplace.
    const metaMatch = inner.match(/<p\s+class="job-meta">([\s\S]*?)<\/p>/i);
    const metaText = metaMatch ? normalizeSpace(decodeEntities(metaMatch[1])) : '';
    const headline = normalizeSpace(decodeEntities(inner.replace(/<p\s+class="job-meta">[\s\S]*?<\/p>/i, '').replace(/<[^>]+>/g, ' ')));
    const title = headline || titleAttr;
    if (!title || title.length < 3) continue;

    out.push({ uuid, slug, detailUrl, title, workplace: metaText, titleAttr });
  }
  return out;
}

/* ── Detail extractor ──────────────────────────────────────── */

function extractSectionContent(html, id) {
  const re = new RegExp(`<section[^>]*\\bid="${id}"[^>]*>([\\s\\S]*?)<\\/section>`, 'i');
  const m = html.match(re);
  if (!m) return '';
  return htmlToText(m[1]);
}

function extractGenericSection(html, headlineRx) {
  // Generic `<section><h3>{headline}</h3>{...}</section>` block extractor.
  // Used for Stellenantritt + Weitere Informationen which don't have an `id`.
  const re = new RegExp(
    `<section[^>]*>\\s*(?:<div[^>]*>\\s*)?<h3>\\s*(${headlineRx.source})\\s*<\\/h3>([\\s\\S]*?)<\\/section>`,
    'i'
  );
  const m = html.match(re);
  if (!m) return '';
  return htmlToText(m[2]);
}

async function fetchDetailDescription(detailUrl, fallbackTeaser) {
  if (!detailUrl) return fallbackTeaser || '';
  try {
    const html = await fetchHtml(detailUrl);
    if (!html) return fallbackTeaser || '';

    const parts = [];
    // The introduction block lives inside `topTitleArea` (the Abteilungen)
    const topTitle = normalizeSpace(extractSectionContent(html, 'topTitleArea'));
    // Filter out the always-present "Jetzt bewerben" button text
    const intro = topTitle.replace(/^\s*Jetzt bewerben\s*/i, '').trim();
    if (intro) parts.push(intro);

    const tasks = normalizeSpace(extractSectionContent(html, 'tasks'));
    if (tasks) parts.push(tasks);

    const profile = normalizeSpace(extractSectionContent(html, 'profile'));
    if (profile) parts.push(profile);

    const stellenantritt = normalizeSpace(extractGenericSection(html, /Stellenantritt/));
    if (stellenantritt) parts.push(`Stellenantritt: ${stellenantritt}`);

    const text = parts.filter(Boolean).join('\n\n').trim();
    if (text && text.split(/\s+/).length >= 30) return text.slice(0, 6000);
    return [fallbackTeaser, text].filter(Boolean).join('\n\n').trim();
  } catch (err) {
    console.warn(`  ⚠️ PBL detail fetch failed (${detailUrl}): ${err?.message || err}`);
    return fallbackTeaser || '';
  }
}

/* ── Location heuristics ───────────────────────────────────── */

function pickPostalCode(workplace) {
  const w = String(workplace || '').toLowerCase();
  if (w.includes('liestal')) return '4410';
  if (w.includes('bruderholz')) return '4101';
  if (w.includes('münchenstein') || w.includes('muenchenstein')) return '4142';
  if (w.includes('binningen')) return '4102';
  if (w.includes('arlesheim')) return '4144';
  return POSTAL_CODE_LIESTAL;
}

function pickCity(workplace) {
  const w = String(workplace || '');
  if (/Liestal/i.test(w)) return 'Liestal';
  if (/Bruderholz/i.test(w)) return 'Bruderholz';
  if (/M(ü|ue)nchenstein/i.test(w)) return 'Münchenstein';
  if (/Binningen/i.test(w)) return 'Binningen';
  if (/Arlesheim/i.test(w)) return 'Arlesheim';
  return 'Liestal';
}

/* ── Main entry ────────────────────────────────────────────── */

export async function fetchAllPblJobs() {
  console.log(`🏥 Fetching ${PBL_COMPANY_NAME} jobs`);
  console.log(`   Source: ${LISTING_BASE} (SSR career list, paginated by ?offset=)\n`);

  // Collect rows across paginated career-list pages until we see a page that
  // contains only already-seen UUIDs (Prospective recycles results past the
  // last real page).
  const all = [];
  const seen = new Set();
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const offset = page * PAGE_SIZE;
    const url = offset === 0 ? LISTING_BASE : `${LISTING_BASE}?offset=${offset}`;
    let html = '';
    try {
      html = await fetchHtml(url);
    } catch (err) {
      console.warn(`  ⚠️ PBL list fetch failed at offset=${offset}: ${err?.message || err}`);
      break;
    }
    const rows = parseJobListHtml(html);
    const fresh = rows.filter((r) => !seen.has(r.uuid));
    if (!fresh.length) {
      console.log(`  ✓ offset=${offset}: no new jobs → stop`);
      break;
    }
    fresh.forEach((r) => { seen.add(r.uuid); all.push(r); });
    console.log(`  ✓ offset=${offset}: ${rows.length} rows (${fresh.length} new, ${all.length} total)`);
    if (rows.length < PAGE_SIZE) break; // last partial page
    if (page > 0) await new Promise((res) => setTimeout(res, 200));
  }

  console.log(`  ✓ Parsed ${all.length} unique job rows from career list HTML`);
  if (!all.length) return [];

  const jobs = [];
  const todayIso = new Date().toISOString().slice(0, 10);
  let detailHits = 0;
  for (let i = 0; i < all.length; i += 1) {
    const r = all[i];
    if (i > 0) await new Promise((res) => setTimeout(res, DETAIL_DELAY_MS));

    const fallback = `${r.title} — ${PBL_COMPANY_NAME}, ${r.workplace || 'Liestal'}.`;
    const desc = await fetchDetailDescription(r.detailUrl, fallback);
    if (desc && desc.length > fallback.length + 20) detailHits += 1;
    const safeDescription = desc && desc.split(/\s+/).length >= 30
      ? desc
      : [fallback, desc].filter(Boolean).join('\n\n');

    const city = pickCity(r.workplace);
    const canton = inferSwissTargetCanton(city) || 'BL';
    const sourceLang = detectLang(safeDescription || r.title, 'de');
    const jobSlug = slugify(`${r.title} ${PBL_KEY} ${city}`);
    const urlHash = createHash('sha1').update(r.detailUrl).digest('hex').slice(0, 12);

    const employmentType = detectHealthcareEmploymentType(`${r.titleAttr || r.title} ${safeDescription}`);
    const applyUrl = `https://jobs.pbl.ch/apply/ats/${r.uuid}`;

    jobs.push({
      id: `${PBL_KEY}-${urlHash}`,
      slug: jobSlug,
      slugByLocale: { [sourceLang]: jobSlug },
      company: PBL_COMPANY_NAME,
      companyKey: PBL_KEY,
      companyDomain: PBL_COMPANY_DOMAIN,
      title: r.title,
      titleByLocale: { [sourceLang]: r.title },
      description: safeDescription,
      descriptionByLocale: { [sourceLang]: safeDescription },
      needsRetranslation: true,
      location: city,
      canton,
      url: r.detailUrl,
      source: 'Psychiatrie Baselland Dedicated Parser (SSR + career detail)',
      sourceLang,
      crawledAt: new Date().toISOString(),

      addressLocality: city,
      addressRegion: canton,
      addressCountry: 'CH',
      country: 'CH',
      postalCode: pickPostalCode(r.workplace),
      category: detectHealthcareCategory(`${r.title} ${safeDescription}`),
      contract: 'full-time',
      employmentType,
      experienceLevel: detectHealthcareExperienceLevel(r.title),
      sector: 'Sanità / Ospedali',
      currency: 'CHF',
      featured: false,
      postedDate: todayIso,
      applyUrl,
      requirements: [],
      requirementsByLocale: { [sourceLang]: [] },
    });
  }

  console.log(`📋 Total ${PBL_COMPANY_NAME} jobs discovered: ${jobs.length} (${detailHits}/${all.length} with rich detail content)`);
  return jobs;
}
