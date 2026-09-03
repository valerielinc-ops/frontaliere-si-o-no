#!/usr/bin/env node
/**
 * fachkraft.ch GmbH job parser — Fetcher and job builder.
 *
 * Source: https://www.fachkraft.ch/stellen/
 *
 * Exports the 4 required functions for the crawler template:
 *   - fetchAllFachkraftJobs()  — Fetch and parse all jobs
 *   - isFachkraftJob()         — Match jobs belonging to this company
 *   - isTrustedDomain()           — Validate URLs belong to this company
 *   - slugify() / stripHtml()     — Re-exported from crawler-template.mjs
 */
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { lookup as dnsLookup } from 'node:dns/promises';
import { gateLookup, MAX_CONCURRENT_LOOKUPS } from './dns-lookup-gate.mjs';
import { detectLang } from './dedicated-crawler-common.mjs';
import { slugify, stripHtml } from './crawler-template.mjs';
import { extractDetailFields } from './prospector/extract.mjs';
import { politeFetch } from './prospector/polite-fetch.mjs';
import { resolveDetailOrListingSwissGeography } from './prospector/location-evidence.mjs';
import {
  createSpecUrlPolicy,
  geographyFieldsForDecision,
  loadSpec,
} from './prospector/spec-crawler.mjs';
import { DATA_ROOT } from './prospector/config.mjs';

/* ── Constants ─────────────────────────────────────────────── */

export const FACHKRAFT_KEY = 'fachkraft';
export const FACHKRAFT_COMPANY_NAME = 'fachkraft.ch GmbH';
export const FACHKRAFT_COMPANY_DOMAIN = 'fachkraft.ch';

const CAREER_URL = 'https://www.fachkraft.ch/stellen/';

export const FACHKRAFT_DESCRIPTION_MIN_WORDS = 50;
export const FACHKRAFT_FETCH_BUDGET = Object.freeze({
  requestTimeoutMs: 15_000,
  // fachkraft.ch rate-limits (HTTP 429) after a few hundred sequential detail
  // requests even at the polite 1 req/host-delay pace; a single retry (#7134)
  // exhausts before the site's cooldown window clears. politeFetch already
  // renews the shared host cooldown from Retry-After on every fresh 429
  // (bounded 60s/attempt), so more attempts buy proportionally more patience
  // — well within the 90-minute run budget below.
  retries: 4,
  retryBaseMs: 2_000,
  runTimeoutMs: 90 * 60_000,
  detailWorkers: 4,
});

const FACHKRAFT_EXISTING_SLICE = path.join(DATA_ROOT, 'jobs', 'by-crawler', `${FACHKRAFT_KEY}.json`);

/* ── Helpers ───────────────────────────────────────────────── */

function normalize(value = '') {
  return String(value || '').trim().toLowerCase();
}

function normalizeSpace(s = '') {
  return String(s || '').replace(/\s+/g, ' ').trim();
}

function wordCount(value = '') {
  return normalizeSpace(value).split(/\s+/u).filter(Boolean).length;
}

export function isPublishableFachkraftDescription(value = '') {
  return wordCount(stripHtml(value)) >= FACHKRAFT_DESCRIPTION_MIN_WORDS;
}

function boundedInteger(value, fallback, { min = 1, max = Number.MAX_SAFE_INTEGER } = {}) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(parsed)));
}

function abortError(message, code = 'ERR_FACHKRAFT_ABORTED') {
  const error = new Error(message);
  error.name = 'AbortError';
  error.code = code;
  error.retryable = false;
  return error;
}

function raceWithSignal(promise, signal, message) {
  if (!signal) return promise;
  if (signal.aborted) return Promise.reject(signal.reason || abortError(message));
  return new Promise((resolve, reject) => {
    const onAbort = () => reject(signal.reason || abortError(message));
    signal.addEventListener('abort', onAbort, { once: true });
    Promise.resolve(promise).then(resolve, reject).finally(() => {
      signal.removeEventListener('abort', onAbort);
    });
  });
}

function combineSignals(...signals) {
  const active = signals.filter(Boolean);
  if (active.length === 0) return undefined;
  if (active.length === 1) return active[0];
  return AbortSignal.any(active);
}

function createBoundedRuntime(options, runSignal) {
  const envRequestTimeout = String(process.env.JOBS_CRAWLER_TIMEOUT_MS || '').trim();
  const requestTimeoutMs = boundedInteger(
    options.requestTimeoutMs ?? (envRequestTimeout || undefined),
    FACHKRAFT_FETCH_BUDGET.requestTimeoutMs,
    { min: 10, max: FACHKRAFT_FETCH_BUDGET.requestTimeoutMs },
  );
  const retries = boundedInteger(options.retries, FACHKRAFT_FETCH_BUDGET.retries, { min: 0, max: 6 });
  const retryBaseMs = boundedInteger(options.retryBaseMs, FACHKRAFT_FETCH_BUDGET.retryBaseMs, {
    min: 0,
    max: 10_000,
  });
  const fetchImpl = options.fetchImpl || globalThis.fetch;
  // `raceWithSignal` below only stops *waiting* on a timed-out lookup, not the
  // underlying `lookupImpl` call itself (node:dns/promises has no cancellation
  // hook) — gate it so abandoned lookups can't pile up unbounded (#7149 item 3).
  const lookupImpl = gateLookup(options.lookupImpl || dnsLookup, MAX_CONCURRENT_LOOKUPS);
  const sleepImpl = options.sleepImpl || ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));

  const boundedFetch = async (url, init = {}) => {
    const requestSignal = AbortSignal.timeout(requestTimeoutMs);
    const signal = combineSignals(init.signal, requestSignal, runSignal);
    if (signal.aborted) throw signal.reason || abortError(`fachkraft request aborted for ${url}`);
    return raceWithSignal(
      Promise.resolve().then(() => fetchImpl(url, { ...init, signal })),
      signal,
      `fachkraft request timeout for ${url}`,
    );
  };
  const boundedLookup = (hostname, lookupOptions) => raceWithSignal(
    lookupImpl(hostname, lookupOptions),
    combineSignals(AbortSignal.timeout(requestTimeoutMs), runSignal),
    `fachkraft DNS timeout for ${hostname}`,
  );
  return {
    requestTimeoutMs,
    retries,
    retryBaseMs,
    fetchImpl: boundedFetch,
    lookupImpl: boundedLookup,
    sleepImpl,
  };
}

function classBody(html, className, tags = 'p|div|span') {
  const escaped = className.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = new RegExp(
    `<(${tags})\\b[^>]*\\bclass\\s*=\\s*["'][^"']*\\b${escaped}\\b[^"']*["'][^>]*>([\\s\\S]*?)<\\/\\1>`,
    'i',
  ).exec(html);
  return stripHtml(match?.[2] || '');
}

/** Parse the authoritative current listing index. Malformed cards fail closed. */
export function parseFachkraftListingPage(html = '') {
  const cards = [...String(html).matchAll(
    /<li\b([^>]*\bclass\s*=\s*["'][^"']*\bff-job-entry\b[^"']*["'][^>]*)>([\s\S]*?)<\/li>/gi,
  )];
  if (cards.length === 0) {
    throw new Error('fachkraft listing page contained no ff-job-entry cards');
  }

  const rows = [];
  const malformed = [];
  for (const [index, card] of cards.entries()) {
    const attributes = card[1];
    const body = card[2];
    const anchor = /<a\b[^>]*\bhref\s*=\s*["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/i.exec(body);
    const canton = /\bdata-canton\s*=\s*["']([^"']+)["']/i.exec(attributes)?.[1] || '';
    const title = normalizeSpace(stripHtml(anchor?.[2] || ''));
    const url = normalizeSpace(anchor?.[1] || '');
    const teaser = normalizeSpace(classBody(body, 'ff-job-entry__description', 'p|div'));
    const location = normalizeSpace(
      classBody(body, 'ff-job-entry__region', 'div|p').replace(/^Region\s*:\s*/i, ''),
    );
    if (!title || !url || !teaser || !isTrustedDomain(url)) {
      malformed.push(index + 1);
      continue;
    }
    rows.push({
      title,
      url,
      teaser,
      location,
      addressLocality: location,
      addressRegion: canton.toUpperCase(),
      addressCountry: 'CH',
      country: 'CH',
    });
  }
  if (malformed.length > 0) {
    throw new Error(
      `fachkraft listing snapshot malformed: ${malformed.length}/${cards.length} cards (first: ${malformed.slice(0, 5).join(', ')})`,
    );
  }

  const byUrl = new Map();
  for (const row of rows) byUrl.set(row.url, row);
  if (byUrl.size !== rows.length) {
    throw new Error(`fachkraft listing snapshot has ${rows.length - byUrl.size} duplicate URL card(s)`);
  }
  return [...byUrl.values()];
}

function readExistingFachkraftJobs(options = {}) {
  if (Array.isArray(options.existingJobs)) return options.existingJobs;
  const existingJobsPath = options.existingJobsPath || FACHKRAFT_EXISTING_SLICE;
  if (!fs.existsSync(existingJobsPath)) return [];
  const raw = JSON.parse(fs.readFileSync(existingJobsPath, 'utf8'));
  return Array.isArray(raw) ? raw : Array.isArray(raw?.jobs) ? raw.jobs : [];
}

function currentSourceText(job, field) {
  const locale = String(job?.sourceLang || 'de');
  const localized = job?.[`${field}ByLocale`]?.[locale];
  return normalizeSpace(localized || job?.[field] || '');
}

function reusableExistingListing(row, existing) {
  if (!existing || normalize(currentSourceText(existing, 'title')) !== normalize(row.title)) return null;
  const description = currentSourceText(existing, 'description');
  if (!isPublishableFachkraftDescription(description)) return null;
  const existingLocation = normalizeSpace(existing.location || existing.addressLocality || '');
  const rowLocation = normalizeSpace(row.location || '');
  const location = existingLocation
    && (!rowLocation || normalize(existingLocation).includes(normalize(rowLocation)))
    ? existingLocation
    : rowLocation || existingLocation;
  const preGeography = {
    ...row,
    location,
    addressLocality: existing.addressLocality || rowLocation || location,
    addressRegion: row.addressRegion || existing.addressRegion || existing.canton || '',
    addressCountry: existing.addressCountry || existing.country || row.addressCountry,
    country: existing.country || existing.addressCountry || row.country,
  };
  const geography = geographyFieldsForDecision(resolveDetailOrListingSwissGeography({}, preGeography));
  if (!geography) return null;
  // Merge the accepted geography fields in now (parity with freshDetailListing
  // below): the acceptance decision above is the ONLY authoritative evaluation
  // of this listing's geography. Downstream (fetchAllFachkraftJobs) must read
  // these fields as-is rather than re-deriving them, because that decision can
  // legitimately accept a listing via loose canton inference (no explicit
  // addressLocality/addressRegion) while the fields synthesized here as a
  // fallback are not guaranteed to pass the same evaluator's *stricter*
  // explicit-evidence branch a second time — re-running it would silently
  // drop a listing already counted as published in the snapshot audit (#7134).
  return {
    ...preGeography,
    ...geography,
    description,
    postedDate: existing.postedDate || existing.datePosted || null,
    employmentType: existing.employmentType || existing.contract || '',
    ...(existing.postalCode ? { postalCode: existing.postalCode } : {}),
    ...(existing.streetAddress ? { streetAddress: existing.streetAddress } : {}),
  };
}

function freshDetailListing(row, page) {
  const detail = extractDetailFields(page.body, page.url || row.url);
  const decision = resolveDetailOrListingSwissGeography(detail, row);
  const geography = geographyFieldsForDecision(decision);
  const description = normalizeSpace(stripHtml(detail.description || ''));
  if (!geography || !isPublishableFachkraftDescription(description)) return null;
  return {
    ...row,
    ...geography,
    title: normalizeSpace(detail.title || row.title),
    description,
    postedDate: detail.postedDate || null,
    employmentType: detail.employmentType || '',
  };
}

async function fetchFachkraftPage(url, transport, urlPolicy, signal, label) {
  const startedAt = Date.now();
  const result = await politeFetch(url, {
    urlPolicy,
    dispatcher: urlPolicy.dispatcher,
    fetchImpl: (target, init) => transport.fetchImpl(target, {
      ...init,
      signal: combineSignals(init?.signal, signal),
    }),
    lookupImpl: transport.lookupImpl,
    sleepImpl: (ms) => raceWithSignal(
      transport.sleepImpl(ms),
      signal,
      `fachkraft ${label} retry/politeness sleep aborted`,
    ),
    retries: transport.retries,
    retryBaseMs: transport.retryBaseMs,
    timeoutMs: transport.requestTimeoutMs,
  });
  if (result.ok) return result;
  const reason = result.policyBlocked
    ? result.error || 'public URL policy rejected the request'
    : result.blockedByRobots ? 'robots.txt denied the request' : `HTTP ${result.status || 0}`;
  const error = new Error(
    `fachkraft ${label} failed after <=${transport.retries + 1} attempt(s) in ${Date.now() - startedAt}ms: ${reason}`,
  );
  error.status = result.status;
  error.retryable = false;
  throw error;
}

/**
 * One complete, all-or-nothing source snapshot. A failed detail aborts sibling
 * workers and rejects before the standard pipeline can write a scratch slice.
 */
export async function fetchFachkraftSnapshot(options = {}) {
  const runTimeoutMs = boundedInteger(options.runTimeoutMs, FACHKRAFT_FETCH_BUDGET.runTimeoutMs, {
    min: 50,
    max: FACHKRAFT_FETCH_BUDGET.runTimeoutMs,
  });
  const runController = new AbortController();
  const runTimer = setTimeout(() => runController.abort(abortError(
    `fachkraft authoritative snapshot exceeded ${runTimeoutMs}ms`,
    'ERR_FACHKRAFT_RUN_TIMEOUT',
  )), runTimeoutMs);
  const transport = createBoundedRuntime(options, runController.signal);
  const spec = options.spec || loadSpec(FACHKRAFT_KEY);
  const urlPolicy = createSpecUrlPolicy(spec, { lookupImpl: transport.lookupImpl });
  try {
    console.log(
      `[fachkraft] bounded transport: request=${transport.requestTimeoutMs}ms retries=${transport.retries} run=${runTimeoutMs}ms`,
    );
    const listingPage = await fetchFachkraftPage(
      CAREER_URL,
      transport,
      urlPolicy,
      runController.signal,
      'listing',
    );
    const rows = parseFachkraftListingPage(listingPage.body);
    const existingByUrl = new Map(readExistingFachkraftJobs(options).map((job) => [job?.url, job]));
    const enriched = new Array(rows.length);
    const pending = [];
    let reused = 0;
    for (const [index, row] of rows.entries()) {
      const cached = reusableExistingListing(row, existingByUrl.get(row.url));
      if (cached) {
        enriched[index] = cached;
        reused++;
      } else {
        pending.push({ index, row });
      }
    }
    console.log(`[fachkraft] listing=${rows.length} cached-source=${reused} detail-required=${pending.length}`);

    let next = 0;
    let completed = 0;
    let qualityDropped = 0;
    let firstError = null;
    const detailController = new AbortController();
    const detailSignal = combineSignals(runController.signal, detailController.signal);
    const worker = async () => {
      while (!firstError && next < pending.length) {
        const item = pending[next++];
        try {
          const page = await fetchFachkraftPage(
            item.row.url,
            transport,
            urlPolicy,
            detailSignal,
            `detail ${item.index + 1}/${rows.length}`,
          );
          const fresh = freshDetailListing(item.row, page);
          if (fresh) enriched[item.index] = fresh;
          else qualityDropped++;
          completed++;
          if (completed % 100 === 0 || completed === pending.length) {
            console.log(`[fachkraft] detail progress ${completed}/${pending.length}; quality-dropped=${qualityDropped}`);
          }
        } catch (error) {
          firstError ||= error;
          detailController.abort(error);
        }
      }
    };
    const workerCount = Math.max(1, Math.min(
      boundedInteger(options.detailWorkers, FACHKRAFT_FETCH_BUDGET.detailWorkers, { min: 1, max: 8 }),
      pending.length || 1,
    ));
    await Promise.allSettled(Array.from({ length: workerCount }, worker));
    if (firstError) throw firstError;
    if (runController.signal.aborted) throw runController.signal.reason;
    if (completed !== pending.length) {
      throw new Error(`fachkraft detail accounting incomplete: ${completed}/${pending.length}`);
    }

    const listings = enriched.filter(Boolean);
    const audit = Object.freeze({
      complete: true,
      discovered: rows.length,
      published: listings.length,
      reused,
      detailRequested: pending.length,
      detailCompleted: completed,
      qualityDropped,
      fetchFailures: 0,
      accounted: listings.length + qualityDropped,
    });
    if (audit.accounted !== audit.discovered) {
      throw new Error(`fachkraft snapshot accounting mismatch: ${audit.accounted}/${audit.discovered}`);
    }
    Object.defineProperty(listings, 'fachkraftSnapshot', { value: audit, enumerable: false });
    return listings;
  } finally {
    clearTimeout(runTimer);
    await urlPolicy.dispatcher.close();
  }
}

export function validateFachkraftAuthoritativeSnapshot(jobs) {
  const audit = jobs?.fachkraftSnapshot;
  if (!audit?.complete
    || audit.discovered <= 0
    || audit.fetchFailures !== 0
    || audit.detailCompleted !== audit.detailRequested
    || audit.accounted !== audit.discovered
    || audit.published !== jobs.length) {
    throw new Error(`fachkraft authoritative snapshot proof missing or incomplete: ${JSON.stringify(audit || null)}`);
  }
  return true;
}

/* ── Company Matchers ──────────────────────────────────────── */

/**
 * Check if a job belongs to fachkraft.ch GmbH.
 * Used by the template to filter this company's jobs from the global dataset.
 */
export function isFachkraftJob(job) {
  const key = normalize(job?.companyKey || job?.company || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  const company = normalize(job?.company || '');
  const url = normalize(job?.url || '');

  return (
    key === FACHKRAFT_KEY ||
    key.startsWith('fachkraft') ||
    company.includes('fachkraft.ch gmbh') ||
    url.includes('fachkraft.ch')
  );
}

/**
 * Validate that a URL belongs to fachkraft.ch GmbH's domain.
 */
export function isTrustedDomain(rawUrl = '') {
  try {
    const host = new URL(rawUrl).hostname.toLowerCase();
    return host === 'fachkraft.ch' || host.endsWith('.fachkraft.ch');
  } catch {
    return false;
  }
}

/* ── Category Detection ────────────────────────────────────── */

function detectCategory(title = '') {
  const t = normalize(title);
  if (/\b(ingegner|engineer|entwickl)/.test(t)) return 'Ingegneria';
  if (/\b(techni|tecnic|mecanic|elektr|install)/.test(t)) return 'Tecnica';
  if (/\b(admin|segret|contab|buchhalt|account)/.test(t)) return 'Amministrazione';
  if (/\b(vendita|sales|verkauf|commerce)/.test(t)) return 'Commerciale';
  if (/\b(logist|magazz|lager|warehouse)/.test(t)) return 'Logistica';
  if (/\b(produz|operat|operator|manufactur)/.test(t)) return 'Produzione';
  if (/\b(qualit|qa|qc|quality)/.test(t)) return 'Qualità';
  if (/\b(it|software|develop|programm)/.test(t)) return 'IT';
  if (/\b(hr|human|risorse|personal)/.test(t)) return 'Risorse Umane';
  if (/\b(market|kommunik|comunicaz)/.test(t)) return 'Marketing';
  if (/\b(finanz|finance|financ)/.test(t)) return 'Finanza';
  if (/\b(legal|giurid|recht)/.test(t)) return 'Legale';
  return 'Altro';
}

function detectExperienceLevel(title = '') {
  const t = normalize(title);
  if (/\b(praktik|stages?(?![a-zA-Z0-9_À-ÖØ-öø-ÿ])|stagiair|intern(?:ship)?s?(?![a-zA-Z0-9_À-ÖØ-öø-ÿ])|apprendist|lehrling|lernend|apprenti)/.test(t)) return 'intern';
  if (/\b(junior|jr)/.test(t)) return 'junior';
  if (/\b(senior|sr|lead|head|director|dirett|chef|verantwort|responsab)/.test(t)) return 'senior';
  return 'mid';
}

function detectEmploymentType(text = '') {
  const t = normalize(text);
  if (/\b(part.?time|teilzeit|tempo parziale|temps partiel)/.test(t)) return 'PART_TIME';
  if (/\b(full.?time|vollzeit|tempo pieno|temps plein)/.test(t)) return 'FULL_TIME';
  return 'OTHER';
}

/* ── Fetcher guidato dalla spec ───────────────────────────────
 * Spec: data/prospector/crawlers/{key}.json — seed, modalita' di estrazione e
 * template degli URL di dettaglio, appresi dalla pagina reale.
 */
async function fetchJobListings(options = {}) {
  return fetchFachkraftSnapshot(options);
}

/**
 * Fetch all fachkraft.ch GmbH jobs.
 * Returns an array of ParsedJob objects (source-locale only).
 *
 * IMPORTANT: Only set source-locale fields. Other locales are filled
 * by the AI localization step and translate-pending pipeline.
 */
export async function fetchAllFachkraftJobs(options = {}) {
  console.log(`🔍 Fetching fachkraft.ch GmbH jobs`);
  console.log(`   Source: ${CAREER_URL}\n`);

  const listings = await fetchJobListings(options);
  if (!listings) {
    console.warn('⚠️ No job listings returned.');
    return [];
  }

  if (listings.length === 0) {
    console.warn('⚠️ Authoritative source snapshot contains no publishable listings.');
    const empty = [];
    empty.discoveredCount = listings.fachkraftSnapshot?.discovered ?? 0;
    Object.defineProperty(empty, 'fachkraftSnapshot', {
      value: listings.fachkraftSnapshot,
      enumerable: false,
    });
    return empty;
  }

  console.log(`  📋 Listings found: ${listings.length}`);

  const jobs = [];
  for (const listing of listings) {
    // TODO: Extract fields from each listing.
    // Adapt these field names to match the actual API response.
    const title = normalizeSpace(listing.title || '');
    if (!title || title.length < 3) continue;

    // Trust the geography already accepted by fetchFachkraftSnapshot (via
    // reusableExistingListing/freshDetailListing) rather than re-deriving it:
    // that evaluator's acceptance can rest on loose canton inference from raw
    // evidence, while re-running it here on the *synthesized* addressLocality/
    // addressRegion fallback fields hits its stricter explicit-evidence branch
    // and can reject a listing that was already counted in the snapshot audit
    // (`published`), breaking the published===jobs.length invariant that
    // validateFachkraftAuthoritativeSnapshot enforces (#7134).
    const location = normalizeSpace(listing.location || '');
    const canton = normalizeSpace(listing.canton || '');
    if (!location || !canton) continue;
    const descriptionText = normalizeSpace(stripHtml(listing.description || ''));
    if (!isPublishableFachkraftDescription(descriptionText)) continue;
    const publicUrl = listing.url || CAREER_URL;

    const sourceLang = detectLang(descriptionText || title, 'de');
    const jobSlug = slugify(`${title} ${location} fachkraft ch`);
    const urlHash = createHash('sha1').update(publicUrl).digest('hex').slice(0, 12);

    const job = {
      // ── Required fields ──
      id: `fachkraft-${urlHash}`,
      slug: jobSlug,
      slugByLocale: { [sourceLang]: jobSlug },
      company: FACHKRAFT_COMPANY_NAME,
      companyKey: FACHKRAFT_KEY,
      companyDomain: FACHKRAFT_COMPANY_DOMAIN,
      title,
      titleByLocale: { [sourceLang]: title },
      description: descriptionText,
      descriptionByLocale: { [sourceLang]: descriptionText },
      location,
      canton,
      url: publicUrl,
      source: 'fachkraft.ch GmbH Dedicated Parser',
      sourceLang,
      crawledAt: new Date().toISOString(),

      // ── Recommended fields ──
      addressLocality: normalizeSpace(listing.addressLocality || location.split(/[,;/|]/)[0]),
      addressRegion: normalizeSpace(listing.addressRegion || canton),
      addressCountry: normalizeSpace(listing.addressCountry || "CH"),
      country: normalizeSpace(listing.addressCountry || "CH"),
      ...(listing.postalCode ? { postalCode: normalizeSpace(listing.postalCode) } : {}),
      ...(listing.streetAddress ? { streetAddress: normalizeSpace(listing.streetAddress) } : {}),
      category: detectCategory(title),
      contract: 'full-time',
      employmentType: detectEmploymentType(listing.employmentType || listing.timeType || title),
      experienceLevel: detectExperienceLevel(title),
      sector: 'Altro', // TODO: Set appropriate sector
      currency: 'CHF',
      featured: false,
      postedDate: listing.postedDate || new Date().toISOString().split('T')[0],
      applyUrl: publicUrl,
      requirements: [],
      requirementsByLocale: { [sourceLang]: [] },
    };

    jobs.push(job);
  }

  console.log(`\n📋 Total fachkraft.ch GmbH jobs discovered: ${jobs.length}`);
  jobs.discoveredCount = listings.fachkraftSnapshot?.discovered ?? listings.length;
  Object.defineProperty(jobs, 'fachkraftSnapshot', {
    value: listings.fachkraftSnapshot,
    enumerable: false,
  });
  return jobs;
}
