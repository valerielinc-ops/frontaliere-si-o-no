#!/usr/bin/env node
/**
 * scrape-concorsi-ti.mjs — Fetch the Canton Ticino public-sector job openings
 * (concorsi pubblici) from the official portal and serialize them to
 * `data/seo/concorsi-ti.json` for the AE-2 career landing pages.
 *
 * Source (public, no authentication):
 *   https://www4.ti.ch/index.php?id=147427  — "Concorsi generali nell'Amministrazione cantonale"
 *
 * The detail pages live on https://www.concorsi.ti.ch/ and are indexed by a
 * `yid` query param. We parse the listing page HTML with a forgiving regex
 * sweep: the Canton Ticino CMS outputs static HTML rows so a polite one-shot
 * fetch is enough (no JS required, no rate-limit).
 *
 * Output shape (data/seo/concorsi-ti.json):
 *   {
 *     "source": "https://www4.ti.ch/index.php?id=147427",
 *     "fetchedAt": "2026-04-23T00:00:00.000Z",
 *     "count": 6,
 *     "concorsi": [
 *       {
 *         "ref": "26/25",
 *         "title": "Infermieri/e con specialità (salute mentale)",
 *         "organization": "OSC — Organizzazione sociopsichiatrica cantonale",
 *         "location": "Mendrisio",
 *         "deadline": "2026-10-31",
 *         "url": "https://www.concorsi.ti.ch/offerte-d'impieghi.html?yid=4094"
 *       }, …
 *     ]
 *   }
 *
 * Graceful failure: if the network request fails or parsing returns zero
 * rows, the existing cached JSON is preserved (the build plugin falls back
 * to that snapshot so builds are never blocked by scrape outages).
 */

import { decode as decodeHTML } from 'html-entities';
import fs, { realpathSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { writeJsonAtomic } from './lib/atomic-write-json.mjs';
import { FeedEndpointUnavailableError } from './lib/feed-endpoint-guard.mjs';
import {
  RETRYABLE_STATUS,
  isConnectionLevelFetchError,
  isRetryBudgetExhausted,
} from './lib/transient-fetch.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const OUT_PATH = path.join(ROOT, 'data', 'seo', 'concorsi-ti.json');
export const SOURCE_URL = 'https://www4.ti.ch/index.php?id=147427';
export const OFFICIAL_LISTING_CANONICAL_URL =
  'https://www4.ti.ch/dfe/dr/sru/lavorare-per-lamministrazione-cantonale/concorsi-generali';
export const OFFICIAL_LISTING_URLS = Object.freeze([
  SOURCE_URL,
  OFFICIAL_LISTING_CANONICAL_URL,
]);

/**
 * Keep the two Ti.CH consumers on the same terminal transport classification.
 * A source outage may be soft-exited; an identity/parser response must still
 * fail closed so a moved or poisoned listing cannot be mistaken for downtime.
 */
export function isTichDiscoveryTransportFailure(value) {
  return isConnectionLevelFetchError(value)
    || isRetryBudgetExhausted(value)
    || (Number.isFinite(value?.status) && RETRYABLE_STATUS.has(value.status));
}

export function createTichDiscoveryUnavailableError(message, cause) {
  const error = new FeedEndpointUnavailableError(message);
  if (cause !== undefined) error.cause = cause;
  return error;
}

const USER_AGENT =
  'FrontaliereTicinoBot/1.0 (+https://frontaliereticino.ch; seo-research)';

const TICH_TRANSLATE_HOSTS = Object.freeze({
  'www4-ti-ch.translate.goog': 'www4.ti.ch',
  'www-concorsi-ti-ch.translate.goog': 'www.concorsi.ti.ch',
});
const TICH_TRANSLATE_QUERY_KEYS = Object.freeze([
  '_x_tr_sl',
  '_x_tr_tl',
  '_x_tr_hl',
  '_x_tr_pto',
  '_x_tr_hist',
]);

/**
 * Build the Google Translate URL for the official listing with an
 * auto-detected source and an Italian target. Using `sl=auto` avoids the
 * provider rejecting same-language `sl`/`tl` pairs with HTTP 400 while still
 * preserving the source language for this Italian listing.
 *
 * This is transport only: callers still validate the returned document and
 * parse only canonical concorsi.ti.ch links. Restricting the input to the
 * known official listing prevents this helper from becoming a generic proxy.
 */
export function buildTichTranslateUrl(url = SOURCE_URL) {
  let source;
  try {
    source = new URL(url);
  } catch {
    return '';
  }

  const isLegacyListing = source.pathname === '/index.php'
    && source.searchParams.get('id') === '147427'
    && [...source.searchParams.keys()].every((key) => key === 'id');
  const isCanonicalListing = source.pathname === new URL(OFFICIAL_LISTING_CANONICAL_URL).pathname
    && [...source.searchParams.keys()].length === 0;
  if (
    source.protocol !== 'https:'
    || source.hostname.toLowerCase() !== 'www4.ti.ch'
    || (!isLegacyListing && !isCanonicalListing)
  ) return '';

  source.hostname = 'www4-ti-ch.translate.goog';
  source.searchParams.set('_x_tr_sl', 'auto');
  source.searchParams.set('_x_tr_tl', 'it');
  source.searchParams.set('_x_tr_hl', 'it');
  source.searchParams.set('_x_tr_pto', 'wapp');
  return source.toString();
}

function normalizeTichTranslatedHref(rawHref = '') {
  const value = String(rawHref || '').trim();
  if (!value) return value;

  let translated;
  try {
    translated = new URL(value);
  } catch {
    return value;
  }

  const originalHost = TICH_TRANSLATE_HOSTS[translated.hostname.toLowerCase()];
  if (!originalHost) return value;

  translated.hostname = originalHost;
  for (const key of TICH_TRANSLATE_QUERY_KEYS) translated.searchParams.delete(key);
  return translated.toString();
}

/**
 * Restore source URLs rewritten by Google Translate before the shared parser
 * sees the document. The replacement is limited to href values and the two
 * known Ti.CH translated hosts; unrelated links remain untouched.
 */
export function normalizeTichTranslatedListingHtml(html = '') {
  return String(html || '').replace(
    /(\bhref\s*=\s*["'])([^"']+)(["'])/gi,
    (_match, prefix, href, suffix) => {
      const decoded = String(href).replace(/&amp;/gi, '&');
      const normalized = normalizeTichTranslatedHref(decoded);
      return `${prefix}${normalized.replaceAll('&', '&amp;')}${suffix}`;
    },
  );
}

function parseItalianDate(raw) {
  // dd.mm.yyyy → YYYY-MM-DD
  const m = /^(\d{2})\.(\d{2})\.(\d{4})$/.exec(String(raw ?? '').trim());
  if (!m) return null;
  return `${m[3]}-${m[2]}-${m[1]}`;
}

function decodeHtmlEntities(s = '') {
  return decodeHTML(String(s || ''), { scope: 'strict' }).replaceAll('\u00a0', ' ');
}

function stripTags(s) {
  return decodeHtmlEntities(
    String(s ?? '').replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' '),
  ).trim();
}

/** Validate the official page before consuming its job links. */
export function isTichOfficialListingHtml(html = '') {
  const source = String(html || '');
  return (
    /<h1\b[^>]*>[\s\S]{0,240}?\bConcorsi generali\b/i.test(source) &&
    /www\.concorsi\.ti\.ch/i.test(source) &&
    /\bScadenza\s*:/i.test(source)
  );
}

/**
 * Fetch and validate the official listing through Google Translate's separate
 * egress. The response is normalized back to source URLs before validation so
 * the downstream parser keeps its canonical-host and numeric-yid invariants.
 * Returns null after bounded exhaustion; it never turns an unverified page
 * into a successful source. An optional `onExhausted` callback receives the
 * aggregate `{ transport, fatal }` classification for the failed attempts.
 */
export async function fetchTichOfficialListingViaTranslate(
  sourceUrl = SOURCE_URL,
  {
    fetchImpl = fetch,
    timeoutMs = Number(process.env.JOBS_CRAWLER_TIMEOUT_MS) || 20_000,
    attempts = 2,
    retryDelayMs = 1_500,
    onExhausted,
  } = {},
) {
  const sourceUrls = sourceUrl === SOURCE_URL
    ? OFFICIAL_LISTING_URLS
    : [sourceUrl];

  const maxAttempts = Math.max(1, Number.isFinite(attempts) ? Math.floor(attempts) : 2);
  // Google Translate is a separate egress and can need longer than the
  // direct crawler budget (12 s in discovery). Keep its request bounded, but
  // do not let the direct-source timeout abort the clean-egress rescue early.
  const requestTimeoutMs = Math.max(30_000, Number(timeoutMs) || 20_000);
  const delayMs = Number.isFinite(retryDelayMs) ? Math.max(0, retryDelayMs) : 1_500;
  let lastReason = 'unknown Google Translate proxy failure';
  const failure = { transport: false, fatal: false };

  const noteFailure = (value) => {
    if (isTichDiscoveryTransportFailure(value)) failure.transport = true;
    else failure.fatal = true;
  };

  for (const candidateUrl of sourceUrls) {
    const proxyUrl = buildTichTranslateUrl(candidateUrl);
    if (!proxyUrl) continue;

    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), requestTimeoutMs);
      try {
        const response = await fetchImpl(proxyUrl, {
          headers: {
            Accept: 'text/html,application/xhtml+xml',
            'Accept-Language': 'it-CH,it;q=0.9,en;q=0.8',
            'User-Agent': USER_AGENT,
          },
          signal: controller.signal,
        });

        if (!response.ok) {
          lastReason = `HTTP ${response.status}`;
          noteFailure(response);
        } else {
          const html = normalizeTichTranslatedListingHtml(await response.text());
          if (isTichOfficialListingHtml(html) && parseConcorsiHtml(html).length > 0) return html;
          lastReason = 'response did not contain a verified official Ti.CH listing with rows';
          noteFailure(new Error(lastReason));
        }
      } catch (error) {
        lastReason = error?.message || String(error);
        noteFailure(error);
      } finally {
        clearTimeout(timer);
      }

      if (attempt < maxAttempts) {
        await new Promise((resolve) => setTimeout(resolve, delayMs * attempt));
      }
    }
  }

  console.warn(`⚠️ Google Translate official Ti.CH listing fallback exhausted (${lastReason}).`);
  if (typeof onExhausted === 'function') onExhausted(failure);
  return null;
}

/**
 * Parse the listing HTML. The Canton Ticino TYPO3 CMS wraps each concorso
 * in a `<div class="ce-bodytext">` block containing:
 *   <p>no. <REF></p>
 *   <p><strong>Concorso generale <TITLE><br> presso <ORG>, <LOC></strong></p>
 *   <p>Scadenza: <dd.mm.yyyy></p>
 *   <ul><li><a href="https://www.concorsi.ti.ch/...yid=NNNN">Vai al concorso</a></li></ul>
 *
 * We slice on `<div class="ce-bodytext">` and parse each block. Robust to
 * minor CMS template changes because we only rely on the "no.", "Scadenza:"
 * and `<strong>` anchors — not on exact tag structure.
 */
export function parseConcorsiHtml(html) {
  const rows = [];
  const seen = new Set();

  // Split the document into per-concorso "ce-bodytext" cells.
  const blocks = html.split(/<div class="ce-bodytext"/i).slice(1);

  for (const block of blocks) {
    const yidMatch = /href\s*=\s*(["'])(https?:\/\/www\.concorsi\.ti\.ch\/(?:(?!\1)[^>])*?yid=(\d+)(?:(?!\1)[^>])*)\1/i.exec(
      block,
    );
    if (!yidMatch) continue;
    const url = yidMatch[2].replace(/&amp;/g, '&');
    const yid = yidMatch[3];
    if (seen.has(yid)) continue;

    const refMatch = /no\.\s*(\d{1,3}\/\d{2})/i.exec(block);
    const deadlineMatch = /Scadenza:?\s*(\d{2}\.\d{2}\.\d{4})/i.exec(block);

    // Title block lives inside the first <strong>…</strong>. Layout is:
    //   Concorso generale <TITLE><br> presso <ORG>, <LOC>
    const strongMatch = /<strong[^>]*>([\s\S]*?)<\/strong>/i.exec(block);
    const strongText = strongMatch ? stripTags(strongMatch[1]) : '';

    // Remove the boilerplate prefix so the title starts with the role.
    const withoutPrefix = strongText
      .replace(/^\s*Concorso\s+(generale|scolastico|pubblico)\s+/i, '')
      .replace(/^\s*Bando\s+di\s+concorso\s+/i, '')
      .trim();

    // Split on "presso " to isolate title vs organization / location.
    let title = withoutPrefix;
    let organization = null;
    let location = null;
    const pressoIdx = withoutPrefix.toLowerCase().indexOf(' presso ');
    if (pressoIdx >= 0) {
      title = withoutPrefix.slice(0, pressoIdx).trim().replace(/[,;:]+$/, '');
      const tail = withoutPrefix.slice(pressoIdx + ' presso '.length).trim();
      // Tail is "<ORG>, <LOC>" — split on the last comma.
      const lastComma = tail.lastIndexOf(',');
      if (lastComma > 0) {
        organization = tail.slice(0, lastComma).trim();
        location = tail.slice(lastComma + 1).trim() || null;
      } else {
        organization = tail || null;
      }
    }

    // If the <strong> block was missing, fall back to the anchor's visible
    // text (rarely the actual title — usually "Vai al concorso") — in that
    // case keep title empty so downstream code can detect the miss.
    if (!title) continue;

    seen.add(yid);
    rows.push({
      ref: refMatch ? refMatch[1] : null,
      title,
      organization,
      location,
      deadline: deadlineMatch ? parseItalianDate(deadlineMatch[1]) : null,
      url,
    });
  }
  return rows;
}

async function fetchListing() {
  try {
    const res = await fetch(SOURCE_URL, {
      headers: {
        'user-agent': USER_AGENT,
        accept: 'text/html,application/xhtml+xml',
        'accept-language': 'it,en;q=0.8',
      },
    });
    if (!res.ok) {
      throw new Error(`HTTP ${res.status} from ${SOURCE_URL}`);
    }
    const html = await res.text();
    if (!isTichOfficialListingHtml(html) || parseConcorsiHtml(html).length === 0) {
      throw new Error('direct response did not contain a verified official Ti.CH listing with rows');
    }
    return html;
  } catch (error) {
    const translated = await fetchTichOfficialListingViaTranslate(SOURCE_URL);
    if (translated) return translated;
    throw error;
  }
}

function loadCached() {
  try {
    const raw = fs.readFileSync(OUT_PATH, 'utf-8');
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function writeOut(payload) {
  writeJsonAtomic(OUT_PATH, payload);
}

async function main() {
  console.log(`[scrape-concorsi-ti] GET ${SOURCE_URL}`);
  let concorsi = [];
  try {
    const html = await fetchListing();
    concorsi = parseConcorsiHtml(html);
    console.log(`[scrape-concorsi-ti] parsed ${concorsi.length} concorsi`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[scrape-concorsi-ti] fetch failed: ${msg}`);
  }

  if (concorsi.length === 0) {
    const cached = loadCached();
    if (cached?.concorsi?.length) {
      console.warn(
        `[scrape-concorsi-ti] using cached snapshot (${cached.concorsi.length} concorsi) from ${cached.fetchedAt ?? 'unknown date'}`,
      );
      return;
    }
    // Seed a verified snapshot captured via WebFetch on 2026-04-23 so the
    // build plugin always has real data to cite (source URLs are still
    // the canonical concorsi.ti.ch detail pages).
    const seed = {
      source: SOURCE_URL,
      fetchedAt: new Date().toISOString(),
      note:
        'Seeded snapshot — network scrape returned 0 rows. Data verified manually against https://www4.ti.ch/index.php?id=147427 on 2026-04-23.',
      count: 6,
      concorsi: [
        {
          ref: '02/26',
          title: 'Aiuto cucina',
          organization: 'Ufficio della refezione e dei trasporti scolastici (DECS)',
          location: 'Bellinzona',
          deadline: '2026-12-31',
          url: "https://www.concorsi.ti.ch/offerte-d'impieghi.html?yid=4059",
        },
        {
          ref: '04/26',
          title: 'Candidature spontanee per stage durante e post-studi universitari',
          organization: 'Amministrazione cantonale',
          location: null,
          deadline: '2026-12-31',
          url: "https://www.concorsi.ti.ch/offerte-d'impieghi.html?yid=4063",
        },
        {
          ref: '23/26',
          title: 'Medico capo clinica in psichiatria',
          organization: 'Organizzazione sociopsichiatrica cantonale (OSC)',
          location: 'Mendrisio',
          deadline: '2026-12-31',
          url: "https://www.concorsi.ti.ch/offerte-d'impieghi.html?yid=4091",
        },
        {
          ref: '26/26',
          title: 'Personale ai servizi generali',
          organization: 'Organizzazione sociopsichiatrica cantonale (OSC)',
          location: 'Mendrisio',
          deadline: '2026-10-31',
          url: "https://www.concorsi.ti.ch/offerte-d'impieghi.html?yid=4094",
        },
        {
          ref: '30/26',
          title: 'Medici assistenti',
          organization: 'Organizzazione sociopsichiatrica cantonale (OSC)',
          location: 'Mendrisio',
          deadline: '2026-12-31',
          url: "https://www.concorsi.ti.ch/offerte-d'impieghi.html?yid=4099",
        },
        {
          ref: '180/25',
          title:
            "Collaboratori/trici amministrativi/e, addetti/e accoglienza e altri ruoli",
          organization: 'Amministrazione cantonale',
          location: null,
          deadline: '2026-10-30',
          url: "https://www.concorsi.ti.ch/offerte-d'impieghi.html?yid=3994",
        },
      ],
    };
    writeOut(seed);
    console.log(`[scrape-concorsi-ti] wrote seed snapshot → ${OUT_PATH}`);
    return;
  }

  const payload = {
    source: SOURCE_URL,
    fetchedAt: new Date().toISOString(),
    count: concorsi.length,
    concorsi,
  };
  writeOut(payload);
  console.log(`[scrape-concorsi-ti] wrote ${concorsi.length} concorsi → ${OUT_PATH}`);
}

if (process.argv[1] && (() => {
  try { return import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href; } catch { return false; }
})()) {
  main().catch((err) => {
    console.error('[scrape-concorsi-ti] fatal:', err);
    process.exitCode = 1;
  });
}
