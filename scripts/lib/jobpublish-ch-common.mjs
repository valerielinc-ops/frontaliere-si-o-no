#!/usr/bin/env node
/**
 * Shared factory for Swiss employers using **JobPublish** (jobpublish.ch)
 * as their public ATS. JobPublish is a Swiss HR-tech SaaS that serves a
 * stable public XML feed per tenant plus a server-rendered detail page on
 * the tenant's own subdomain.
 *
 * Public endpoints (no authentication):
 *
 *   GET https://jobs.jobpublish.ch/feed/v2/website/{TENANT}
 *     → XML payload `<response><job>…</job>…</response>` with:
 *       id, title, category (numeric), workload, contract_type,
 *       detail_url, application_url, publishStartDate, publishEndDate,
 *       jobStartDate. Stable schema — verified May 2026 on `rkb`.
 *
 *   GET {detail_url}  (typically `https://job.{tenant-domain}/job/...`)
 *     → Server-rendered HTML. The job body lives in
 *       `<section class="wrapper job-content">` and contains `<h2>` headings
 *       followed by `<ul>` content (Aufgaben, Profil, Wir bieten, etc.).
 *       Brand statement / intro typically in
 *       `<div class="wrapper statement-text">` + `<div class="wrapper job-information">`.
 *       Workload / contract / city are exposed in `<div class="wrapper subtitle">`.
 *
 * `TENANT` is the slug carved out by the jobs subdomain template, e.g. Reha
 * Bellikon hosts at `https://jobs.rehabellikon.ch` and the asset path
 * `static.jobpublish.ch/clients/rkb/joblist-XXXX.js` reveals tenant=`rkb`.
 *
 * Confirmed tenants (May 2026):
 *   - Rehaklinik Bellikon (Reha Bellikon AG) → tenant `rkb` (~14 active jobs)
 *   - `crr` accepts the feed but returns zero jobs at the moment (Clinique
 *     romande de réadaptation has its own TYPO3 listing).
 */
import { createHash } from 'node:crypto';
import { detectLang } from './dedicated-crawler-common.mjs';
import { slugify } from './crawler-template.mjs';
import { inferSwissTargetCanton } from './target-swiss-locations.mjs';
import {
  decodeEntities,
  normalizeSpace,
  htmlToText,
  fetchHtml,
  detectHealthcareCategory,
  detectHealthcareExperienceLevel,
  detectHealthcareEmploymentType,
} from './hospital-custom-html-helpers.mjs';

const FEED_HOST = 'https://jobs.jobpublish.ch';
const DETAIL_DELAY_MS = 250;
const USER_AGENT = process.env.JOBS_CRAWLER_USER_AGENT
  || 'Mozilla/5.0 (compatible; FrontaliereTicinoBot/1.0; +https://frontaliereticino.ch/)';

function normalize(s = '') {
  return String(s || '').trim().toLowerCase();
}

/**
 * Parse a JobPublish XML feed. The XML is small and predictable — a
 * regex-based pull is cheaper and more robust than wiring in a parser
 * dependency. Returns an array of `{ id, title, category, workload,
 * contract_type, detail_url, application_url, publishStartDate,
 * publishEndDate, jobStartDate }` records.
 */
export function parseJobpublishFeed(xml = '') {
  if (!xml || typeof xml !== 'string') return [];
  const out = [];
  const jobRx = /<job>([\s\S]*?)<\/job>/g;
  let m;
  while ((m = jobRx.exec(xml))) {
    const block = m[1];
    const pick = (tag) => {
      const re = new RegExp(`<${tag}>([\\s\\S]*?)<\\/${tag}>`);
      const x = block.match(re);
      return x ? normalizeSpace(decodeEntities(x[1])) : '';
    };
    const id = pick('id');
    const title = pick('title');
    if (!id || !title) continue;
    out.push({
      id,
      title,
      category: pick('category'),
      workload: pick('workload'),
      contract_type: pick('contract_type'),
      detail_url: pick('detail_url'),
      application_url: pick('application_url'),
      publishStartDate: pick('publishStartDate'),
      publishEndDate: pick('publishEndDate'),
      jobStartDate: pick('jobStartDate'),
    });
  }
  return out;
}

/**
 * Extract a substantive description text from a JobPublish detail page.
 * We concatenate `.statement-text`, `.job-information`, `.subtitle`, and
 * the `<section class="wrapper job-content">` block (which holds the
 * Aufgaben / Profil / Wir bieten lists) — preserving `\n• item` bullets.
 */
export function extractJobpublishDetailContent(html = '') {
  if (!html || typeof html !== 'string') return '';
  const sections = [];

  const pickBlock = (re) => {
    const m = html.match(re);
    if (!m) return '';
    return m[1]
      .replace(/<li[^>]*>/gi, '\n• ')
      .replace(/<\/li\s*>/gi, '')
      .replace(/<br\s*\/?>(?!\s*<)/gi, '\n')
      .replace(/<[^>]+>/g, ' ');
  };

  const statement = pickBlock(/<div\s+class="wrapper statement-text">([\s\S]*?)<\/div>\s*(?=<(?:div|section|main|footer)\b|$)/i);
  if (statement) {
    const t = normalizeSpace(decodeEntities(statement));
    if (t && t.length > 20) sections.push(t);
  }
  const info = pickBlock(/<div\s+class="wrapper job-information">([\s\S]*?)<\/div>\s*(?=<(?:div|section|main|footer)\b|$)/i);
  if (info) {
    const t = normalizeSpace(decodeEntities(info));
    if (t && t.length > 20) sections.push(t);
  }

  // Job content: a top-level <section class="wrapper job-content"> with multiple
  // <h2>title</h2><ul>…</ul> alternations inside <div> wrappers.
  const contentMatch = html.match(/<section\s+class="wrapper job-content">([\s\S]*?)<\/section>/i);
  if (contentMatch) {
    const inner = contentMatch[1];
    const titledRx = /<h2[^>]*>([\s\S]*?)<\/h2>([\s\S]*?)(?=<h2|$)/g;
    let tm;
    while ((tm = titledRx.exec(inner))) {
      const title = normalizeSpace(decodeEntities(tm[1].replace(/<[^>]+>/g, ' ')));
      if (!title) continue;
      let body = tm[2]
        .replace(/<li[^>]*>/gi, '\n• ')
        .replace(/<\/li\s*>/gi, '')
        .replace(/<br\s*\/?>(?!\s*<)/gi, '\n')
        .replace(/<[^>]+>/g, ' ');
      body = normalizeSpace(decodeEntities(body)).replace(/\s*•\s*/g, '\n• ');
      if (body && body.length > 5) sections.push(`${title}\n${body}`);
    }
  }
  return sections.join('\n\n');
}

/**
 * Pull workload range "80-100%" / "100%" from feed string and detail subtitle.
 * Returns { pensumMin, pensumMax }.
 */
export function parseWorkload(s = '') {
  if (!s) return { pensumMin: null, pensumMax: null };
  const range = s.match(/(\d{1,3})\s*[-–]\s*(\d{1,3})\s*%/);
  if (range) return { pensumMin: parseInt(range[1], 10), pensumMax: parseInt(range[2], 10) };
  const single = s.match(/(\d{1,3})\s*%/);
  if (single) return { pensumMin: parseInt(single[1], 10), pensumMax: parseInt(single[1], 10) };
  return { pensumMin: null, pensumMax: null };
}

/**
 * Extract the "city" line from the JobPublish detail subtitle block. The
 * line typically looks like `<i class="fas fa-map-marker-alt"></i> Bellikon AG`.
 */
export function extractDetailCity(html = '') {
  const sub = html.match(/<div\s+class="wrapper subtitle">([\s\S]*?)<\/div>\s*(?=<(?:div|section|main|footer)\b|$)/i);
  if (!sub) return '';
  const mapMatch = sub[1].match(/fa-map-marker-alt[^<]*<\/i>([\s\S]*?)<\/div>/i);
  if (!mapMatch) return '';
  return normalizeSpace(decodeEntities(mapMatch[1].replace(/<[^>]+>/g, ' ')));
}

/**
 * Fetch the XML feed for a given tenant.
 */
export async function fetchJobpublishFeedXml(tenant) {
  if (!tenant) throw new Error('fetchJobpublishFeedXml: missing tenant');
  const url = `${FEED_HOST}/feed/v2/website/${encodeURIComponent(tenant)}`;
  const timeoutMs = Number(process.env.JOBS_CRAWLER_TIMEOUT_MS) || 20000;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      headers: { Accept: 'application/xml,text/xml,*/*', 'User-Agent': USER_AGENT },
      signal: controller.signal,
    });
    clearTimeout(timer);
    if (!res.ok) throw new Error(`HTTP ${res.status} from ${url}`);
    return await res.text();
  } catch (err) {
    clearTimeout(timer);
    throw err;
  }
}

/**
 * Build a parser bundle for one JobPublish tenant.
 *
 * @param {Object} config
 * @param {string} config.jobpublishTenant   Tenant slug (e.g. `rkb`).
 * @param {string} config.companyKey         Internal slug.
 * @param {string} config.companyName        Brand string.
 * @param {string} config.companyDomain      Public domain (no scheme).
 * @param {string} config.defaultCanton      ISO canton.
 * @param {string} config.defaultCity        Fallback city when subtitle empty.
 * @param {string} [config.defaultPostalCode]
 * @param {string} [config.publicCareerUrl]  Human-facing career page.
 * @param {string} [config.defaultSourceLang='de']
 * @param {string} [config.sourceLabel]
 * @param {Array<string>} [config.extraTrustedHosts] Additional accepted hosts
 *                                          (e.g. the `job.{tenant}.ch` mirror).
 */
export function createJobpublishChParser(config) {
  const {
    jobpublishTenant,
    companyKey,
    companyName,
    companyDomain,
    defaultCanton,
    defaultCity,
    defaultPostalCode = '',
    publicCareerUrl = '',
    defaultSourceLang = 'de',
    sourceLabel,
    extraTrustedHosts = [],
  } = config;

  if (!jobpublishTenant || !companyKey || !companyName || !defaultCanton) {
    throw new Error('createJobpublishChParser: missing required config');
  }

  const corporateHost = String(companyDomain || '').replace(/^www\./, '').toLowerCase();
  const label = sourceLabel || `${companyName} Dedicated Parser (JobPublish.ch)`;
  const trustedHostSet = new Set([
    'jobs.jobpublish.ch',
    'jobpublish.ch',
    ...extraTrustedHosts.map((h) => String(h || '').toLowerCase()),
  ].filter(Boolean));

  function isCompanyJob(job) {
    const key = normalize(job?.companyKey || '');
    const url = normalize(job?.url || '');
    if (key === companyKey) return true;
    if (corporateHost && url.includes(corporateHost)) return true;
    if (url.includes(`/${jobpublishTenant}/`) || url.includes(`/website/${jobpublishTenant}`)) return true;
    return false;
  }

  function isTrustedDomain(rawUrl = '') {
    try {
      const host = new URL(rawUrl).hostname.toLowerCase();
      if (corporateHost && (host === corporateHost || host.endsWith(`.${corporateHost}`))) return true;
      if (trustedHostSet.has(host)) return true;
      return false;
    } catch {
      return false;
    }
  }

  async function fetchAllJobs() {
    console.log(`🏥 Fetching ${companyName} jobs`);
    console.log(`   Source: ${FEED_HOST}/feed/v2/website/${jobpublishTenant} (JobPublish.ch)\n`);

    let xml;
    try {
      xml = await fetchJobpublishFeedXml(jobpublishTenant);
    } catch (err) {
      console.warn(`⚠️ JobPublish feed fetch failed: ${err?.message || err}`);
      return [];
    }
    const feed = parseJobpublishFeed(xml);
    if (!feed.length) {
      console.warn(`⚠️ Empty JobPublish feed for tenant '${jobpublishTenant}'`);
      return [];
    }
    console.log(`  ✓ ${feed.length} openings in JobPublish XML feed`);

    const todayIso = new Date().toISOString().slice(0, 10);
    const jobs = [];
    let detailHits = 0;
    let failed = 0;

    for (let i = 0; i < feed.length; i += 1) {
      const item = feed[i];
      const detailUrl = item.detail_url || '';
      let detailHtml = '';
      if (detailUrl) {
        try {
          detailHtml = await fetchHtml(detailUrl);
          if (detailHtml) detailHits += 1;
        } catch (err) {
          console.warn(`  ⚠️ Detail fetch failed (${detailUrl}): ${err?.message || err}`);
        }
      }

      const detailText = detailHtml ? extractJobpublishDetailContent(detailHtml) : '';
      const cityFromDetail = detailHtml ? extractDetailCity(detailHtml) : '';
      const workload = parseWorkload(item.workload);

      // Title from feed (already plain text).
      const title = normalizeSpace(decodeEntities(item.title));
      if (!title) {
        failed += 1;
        if (i < feed.length - 1) await new Promise((r) => setTimeout(r, DETAIL_DELAY_MS));
        continue;
      }

      // Pick best city: detail subtitle > defaultCity. Strip trailing canton
      // abbreviation ("Bellikon AG" → "Bellikon").
      let city = cityFromDetail || defaultCity;
      city = city.replace(/\s+[A-Z]{2}$/, '').trim() || defaultCity;
      const canton = inferSwissTargetCanton(`${city} ${cityFromDetail}`) || defaultCanton;

      const descParts = [];
      if (detailText) descParts.push(detailText);
      if (Number.isFinite(workload.pensumMax)) {
        const pStr = workload.pensumMin !== workload.pensumMax
          ? `${workload.pensumMin}-${workload.pensumMax}%`
          : `${workload.pensumMax}%`;
        descParts.push(`Pensum: ${pStr}`);
      }
      if (item.contract_type) descParts.push(`Anstellung: ${item.contract_type}`);
      if (item.jobStartDate && !/^9999/.test(item.jobStartDate)) {
        descParts.push(`Eintritt: ${item.jobStartDate}`);
      }
      const description = descParts.length
        ? descParts.join('\n\n')
        : `${title} — ${companyName} (${city}).`;

      const sourceLang = detectLang(description || title, defaultSourceLang);

      const isPermanent = /unbefristet/i.test(item.contract_type) || /permanent/i.test(item.contract_type);
      const isTemporary = /befristet/i.test(item.contract_type) && !isPermanent;
      const contract = isTemporary ? 'temporary' : 'full-time';
      const employmentType = Number.isFinite(workload.pensumMax) && workload.pensumMax < 90
        ? 'PART_TIME'
        : detectHealthcareEmploymentType(`${title} ${item.workload || ''}`);

      const jobSlug = slugify(`${title} ${companyKey} ${city}`);
      const urlHash = createHash('sha1')
        .update(`${companyKey}:${item.id || detailUrl || title}`)
        .digest('hex')
        .slice(0, 12);

      // Posted date: prefer publishStartDate, fallback to today.
      const postedDate = (item.publishStartDate && /^\d{4}-\d{2}-\d{2}$/.test(item.publishStartDate))
        ? item.publishStartDate
        : todayIso;

      const publicUrl = detailUrl || (publicCareerUrl || `${FEED_HOST}/feed/v2/website/${jobpublishTenant}`);

      const job = {
        id: `${companyKey}-${urlHash}`,
        slug: jobSlug,
        slugByLocale: { [sourceLang]: jobSlug },
        company: companyName,
        companyKey,
        companyDomain,
        title,
        titleByLocale: { [sourceLang]: title },
        description,
        descriptionByLocale: { [sourceLang]: description },
        needsRetranslation: true,
        location: city,
        canton,
        url: publicUrl,
        source: label,
        sourceLang,
        crawledAt: new Date().toISOString(),
        addressLocality: city,
        addressRegion: canton,
        addressCountry: 'CH',
        country: 'CH',
        postalCode: defaultPostalCode,
        category: detectHealthcareCategory(`${title} ${detailText || ''}`),
        contract,
        employmentType,
        experienceLevel: detectHealthcareExperienceLevel(title),
        sector: 'Sanità / Ospedali',
        currency: 'CHF',
        featured: false,
        postedDate,
        applyUrl: item.application_url || publicUrl,
        requirements: [],
        requirementsByLocale: { [sourceLang]: [] },
        externalId: String(item.id || ''),
      };

      if (Number.isFinite(workload.pensumMin) || Number.isFinite(workload.pensumMax)) {
        const mn = Number.isFinite(workload.pensumMin) ? workload.pensumMin : workload.pensumMax;
        const mx = Number.isFinite(workload.pensumMax) ? workload.pensumMax : workload.pensumMin;
        job.pensumMin = mn;
        job.pensumMax = mx;
        job.pensum = mn === mx ? `${mx}%` : `${mn} - ${mx}%`;
      }
      if (isTemporary) job.contractDuration = 'temporary';
      else if (isPermanent) job.contractDuration = 'permanent';

      jobs.push(job);
      if (i < feed.length - 1) await new Promise((r) => setTimeout(r, DETAIL_DELAY_MS));
    }

    console.log(`📋 Total ${companyName} jobs discovered: ${jobs.length} (${detailHits}/${feed.length} with rich detail content, ${failed} skipped)`);
    return jobs;
  }

  return { fetchAllJobs, isCompanyJob, isTrustedDomain };
}
