#!/usr/bin/env node

/**
 * Find candidate Facebook pages for explicitly configured pharmacies.
 *
 * This is discovery only: it never publishes facts from a search result.
 * Facebook frequently serves login/checkpoint HTML to unauthenticated public
 * searches. Discovery therefore reports only public candidates; an optional
 * Graph adapter may corroborate a candidate, but no Page token is required by
 * this workflow and no unverified facts are published from it.
 */

import { readFile, writeFile } from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const CONFIG_PATH = resolve(REPO_ROOT, 'data/pharmacy-enrichment-sources.json');
const TICINO_PATH = resolve(REPO_ROOT, 'data/pharmacies-ticino-complete.json');
const ITALY_PATH = resolve(REPO_ROOT, 'data/pharmacies-italy-border.json');

function text(value) {
  return String(value ?? '').replace(/\s+/g, ' ').trim();
}

function decodeHtml(value) {
  return String(value || '')
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&#x27;|&#39;/gi, "'")
    .replace(/&nbsp;/gi, ' ')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>');
}

function htmlAttribute(tag, name) {
  const match = String(tag || '').match(new RegExp(`\\b${name}\\s*=\\s*(["'])(.*?)\\1`, 'i'));
  return match ? decodeHtml(match[2]) : '';
}

function htmlText(html) {
  return decodeHtml(String(html || '')
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' '))
    .replace(/\s+/g, ' ')
    .trim();
}

function metaContent(html, key) {
  for (const match of String(html || '').matchAll(/<meta\b[^>]*>/gi)) {
    const tag = match[0];
    const property = htmlAttribute(tag, 'property') || htmlAttribute(tag, 'name');
    if (property.toLowerCase() === key.toLowerCase()) return htmlAttribute(tag, 'content');
  }
  return '';
}

function safePublicHttpsUrl(value) {
  try {
    const parsed = new URL(String(value || '').trim());
    return parsed.protocol === 'https:' ? parsed.toString() : undefined;
  } catch {
    return undefined;
  }
}

function parseJsonLdObjects(html) {
  const objects = [];
  for (const match of String(html || '').matchAll(/<script\b[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)) {
    try {
      const parsed = JSON.parse(decodeHtml(match[1]));
      const queue = Array.isArray(parsed) ? [...parsed] : [parsed];
      while (queue.length) {
        const value = queue.shift();
        if (!value || typeof value !== 'object') continue;
        if (Array.isArray(value)) queue.push(...value);
        else {
          objects.push(value);
          for (const child of Object.values(value)) if (child && typeof child === 'object') queue.push(child);
        }
      }
    } catch {
      // Public pages frequently contain analytics JSON that is not valid JSON-LD.
    }
  }
  return objects;
}

function normalize(value) {
  return text(value)
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase();
}

function digits(value) {
  return text(value).replace(/\D/g, '');
}

function nameTokens(value) {
  return [...new Set(normalize(value)
    .split(/[^a-z0-9]+/)
    .filter((token) => token.length > 2 && !['farmacia', 'farmacie', 'dott', 'del', 'dei', 'della', 'sas', 'srl'].includes(token)))];
}

function parsePublicTime(value) {
  const match = text(value).match(/^(\d{1,2})[.:](\d{2})$/);
  if (!match) return undefined;
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  return hour >= 0 && hour <= 23 && minute >= 0 && minute <= 59
    ? `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`
    : undefined;
}

function parsePublicHours(value) {
  const days = [
    ['lunedi', 'monday'], ['martedi', 'tuesday'], ['mercoledi', 'wednesday'],
    ['giovedi', 'thursday'], ['venerdi', 'friday'], ['sabato', 'saturday'], ['domenica', 'sunday'],
  ];
  const result = [];
  const raw = normalize(value);
  for (const [label, dayOfWeek] of days) {
    const match = raw.match(new RegExp(`${label}\\s*:?[\\s-]*(\\d{1,2}[.:]\\d{2})\\s*[-–—]\\s*(\\d{1,2}[.:]\\d{2})`, 'i'));
    const opens = parsePublicTime(match?.[1]);
    const closes = parsePublicTime(match?.[2]);
    if (opens && closes) result.push({ dayOfWeek, opens, closes });
    if (new RegExp(`${label}\\s*:?[\\s-]*(?:chius[oa]|closed)\\b`, 'i').test(raw)) {
      result.push({ dayOfWeek, opens: '', closes: '', isClosed: true });
    }
  }
  return result;
}

function publicIdentityMatches(pharmacy, sourceText, phone) {
  const body = normalize(sourceText);
  const city = normalize(pharmacy.city);
  const address = normalize(pharmacy.address);
  const street = address.replace(/\b\d+[a-z]?\b/g, '').replace(/[^a-z0-9]+/g, ' ').trim();
  const number = (address.match(/\b\d+[a-z]?\b/i) || [])[0];
  const nameMatch = nameTokens(pharmacy.name).some((token) => body.includes(token));
  const addressMatch = Boolean(city && body.includes(city) && street && body.includes(street) && number && body.includes(number));
  const phoneMatch = Boolean(digits(pharmacy.phone) && phone && digits(phone) === digits(pharmacy.phone));
  // A public page may omit the address but expose the exact catalogue phone.
  // Name + city + exact phone is an equally strong branch identity anchor.
  return Boolean(city && body.includes(city) && nameMatch && (addressMatch || phoneMatch));
}

/**
 * Extract only reusable public profile facts from an accessible Facebook page.
 * It deliberately ignores posts, reviews, ratings, follower counts and any
 * value that cannot be tied to the catalogue identity.
 */
export function extractFacebookPublicFacts(html, pharmacy, pageUrl) {
  const title = metaContent(html, 'og:title') || metaContent(html, 'twitter:title');
  const description = metaContent(html, 'og:description') || metaContent(html, 'description');
  const jsonLd = parseJsonLdObjects(html);
  const phone = [...String(html || '').matchAll(/href=["']tel:([^"']+)["']/gi)].map((match) => decodeHtml(match[1]))[0]
    || jsonLd.map((object) => object.telephone).find(Boolean)
    || undefined;
  const email = [...String(html || '').matchAll(/href=["']mailto:([^"']+)["']/gi)].map((match) => decodeHtml(match[1]).split('?')[0])[0]
    || jsonLd.map((object) => object.email).find((value) => /@/.test(String(value || '')))
    || undefined;
  const website = jsonLd
    .map((object) => object.url)
    .map(safePublicHttpsUrl)
    .find((url) => url && !/facebook\.com$/i.test(new URL(url).hostname));
  const body = htmlText(html);
  const sourceText = `${title} ${description} ${body}`;
  const matched = publicIdentityMatches(pharmacy, sourceText, phone);
  if (!matched) return { matched: false, facts: {}, pageUrl };
  const facts = {};
  if (phone && digits(phone).length >= 8) facts.phone = text(phone);
  if (email && /@/.test(String(email))) facts.contactEmail = text(email);
  if (website) facts.website = website;
  const openingHours = parsePublicHours(sourceText);
  if (openingHours.length) facts.openingHours = openingHours;
  return { matched: true, facts, pageUrl };
}

export function facebookSearchUrl(pharmacy) {
  const query = encodeURIComponent(`${pharmacy.name} ${pharmacy.city}`.trim());
  return `https://www.facebook.com/public/${query}`;
}

export function extractFacebookCandidateUrls(html) {
  const candidates = new Set();
  for (const match of String(html || '').matchAll(/https?:\/\/(?:www\.)?facebook\.com\/[^\s"'<>\\]+/gi)) {
    let value = decodeHtml(match[0]).replace(/[),.;]+$/, '');
    try {
      const url = new URL(value);
      const host = url.hostname.toLowerCase();
      const path = url.pathname.toLowerCase();
      if (!['facebook.com', 'www.facebook.com', 'm.facebook.com'].includes(host)) continue;
      if (!path || /^\/(?:public|login|checkpoint|recover|watch|security|ajax|hsts|help|policies|privacy|terms)(?:\/|$)/.test(path)) continue;
      url.search = '';
      url.hash = '';
      candidates.add(url.toString());
    } catch {
      // Ignore malformed links from the search HTML.
    }
  }
  return [...candidates].slice(0, 10);
}

function isBlockedSearchPage(html) {
  return /(?:checkpoint|login|log\s+in|create\s+new\s+account)/i.test(String(html || ''));
}

export async function discoverFacebookCandidates({
  config,
  pharmacies,
  checkedAt = new Date().toISOString(),
  fetchDocument,
} = {}) {
  const configuredIds = config?.providers?.facebook?.discoveryPharmacyIds || [];
  const byId = new Map((pharmacies || []).map((pharmacy) => [pharmacy.id, pharmacy]));
  const candidates = [];
  const warnings = [];

  for (const pharmacyId of configuredIds) {
    const pharmacy = byId.get(pharmacyId);
    if (!pharmacy) {
      warnings.push(`${pharmacyId}: pharmacy is not in the catalogue`);
      continue;
    }
    const searchUrl = facebookSearchUrl(pharmacy);
    try {
      const html = await fetchDocument(searchUrl);
      const urls = extractFacebookCandidateUrls(html);
      const blocked = isBlockedSearchPage(html);
      const candidate = {
        pharmacyId,
        query: text(`${pharmacy.name} ${pharmacy.city}`),
        searchUrl,
        checkedAt,
        status: blocked ? 'public_search_blocked' : urls.length ? 'candidate_needs_identity_verification' : 'no_candidate',
        urls: blocked ? [] : urls,
      };
      if (!blocked && urls.length) {
        for (const url of urls.slice(0, 10)) {
          try {
            const pageHtml = await fetchDocument(url);
            if (isBlockedSearchPage(pageHtml)) continue;
            const publicPage = extractFacebookPublicFacts(pageHtml, pharmacy, url);
            if (!publicPage.matched || !Object.keys(publicPage.facts).length) continue;
            candidate.status = 'candidate_publicly_verified';
            candidate.verified = publicPage;
            break;
          } catch (error) {
            candidate.pageWarnings ||= [];
            candidate.pageWarnings.push(`${url}: ${error instanceof Error ? error.message : String(error)}`);
          }
        }
      }
      candidates.push(candidate);
    } catch (error) {
      candidates.push({
        pharmacyId,
        query: text(`${pharmacy.name} ${pharmacy.city}`),
        searchUrl,
        checkedAt,
        status: 'fetch_failed',
        urls: [],
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return { schemaVersion: 1, generatedAt: checkedAt, candidates, warnings };
}

async function defaultFetchDocument(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15_000);
  try {
    const response = await fetch(url, {
      headers: { 'User-Agent': 'FrontaliereTicino-FacebookDiscovery/1.0 (+https://frontaliereticino.ch/bot)' },
      redirect: 'follow',
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`HTTP ${response.status} for ${url}`);
    return response.text();
  } finally {
    clearTimeout(timer);
  }
}

async function readJson(path) {
  return JSON.parse(await readFile(path, 'utf8'));
}

async function main() {
  const outputFlag = process.argv.indexOf('--output');
  const outputPath = outputFlag >= 0 && process.argv[outputFlag + 1]
    ? resolve(process.argv[outputFlag + 1])
    : resolve(REPO_ROOT, 'data/pharmacy-facebook-discovery.json');
  const [config, ticino, italy] = await Promise.all([
    readJson(CONFIG_PATH),
    readJson(TICINO_PATH),
    readJson(ITALY_PATH),
  ]);
  const result = await discoverFacebookCandidates({
    config,
    pharmacies: [...(ticino.pharmacies || []), ...(italy.pharmacies || [])],
    fetchDocument: defaultFetchDocument,
  });
  await writeFile(outputPath, `${JSON.stringify(result, null, 2)}\n`);
  for (const candidate of result.candidates) {
    console.log(`[facebook-discovery] ${candidate.pharmacyId}: ${candidate.status} (${candidate.urls.length} candidate URL(s))`);
  }
  for (const warning of result.warnings) console.warn(`[facebook-discovery] ${warning}`);
}

if (process.argv[1] && (() => { try { return import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href; } catch { return false; } })()) {
  main().catch((error) => {
    console.error(`[facebook-discovery] fatal: ${error?.stack || error}`);
    process.exitCode = 1;
  });
}
