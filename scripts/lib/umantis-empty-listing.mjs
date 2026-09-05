#!/usr/bin/env node
/**
 * Shared reader for an Umantis job-market listing page.
 *
 * Four spec-driven crawlers (recruitingapp-2563, recruitingapp-1154,
 * recruitingapp-2677, jsafrasarasin) all did `return runSpecInProduction(spec)`
 * and nothing else, so a run that reached an empty board and a run that never
 * reached the board at all produced the same value: `[]`. That ambiguity is why
 * `[crawler-health] recruitingapp-2563` (#6660) reopens forever — the monitor
 * has nothing to read.
 *
 * Here the run reports which of the two it saw, using the platform's own
 * empty-state sentence as the evidence.
 */
import { fetch as undiciFetch } from 'undici';
import { loadSpec, runSpecInProduction } from './prospector/spec-crawler.mjs';
import { markAuthoritativeEmptySnapshot } from './authoritative-empty-snapshot.mjs';

/**
 * Umantis' own "this board has nothing on it" sentence, in the two languages
 * our tenants request.
 */
const UMANTIS_EMPTY_STATE_RE = /(?:Es wurden noch keine Eintr\S*ge erfasst|There are no entries)/i;

/**
 * MUST be tested against the *rendered* text, never the raw HTML.
 *
 * Measured 2026-09-05 on all five tenants: Umantis ships that same sentence
 * HTML-escaped inside a client-side string table (`wNoEntries'] = "&lt;i&gt;…"`)
 * on EVERY page, including boards with 20 open vacancies. A raw-HTML `.test()`
 * therefore returns true everywhere and the "proof" silently degenerates into
 * "the parser found nothing" — the exact ambiguity this module exists to
 * remove, and a false proof would then retire live vacancies.
 *
 * Raw match: true on all 5 tenants. Visible-text match: true only on
 * recruitingapp-2563, the one board that is genuinely empty.
 *
 * @param {string} html
 */
export function umantisListingStatesEmpty(html = '') {
  const visible = String(html || '')
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ');
  return UMANTIS_EMPTY_STATE_RE.test(visible);
}

/** @param {string} rawUrl */
function isListingSeedUrl(rawUrl) {
  try { return /^\/Jobs\/(?:\d+|All)\/?$/i.test(new URL(rawUrl).pathname); } catch { return false; }
}

/**
 * Run the learned spec while watching the listing page go by.
 *
 * @param {string} companyKey
 * @param {Record<string, any>} [runtime]
 * @returns {Promise<object[]>} the published rows, carrying a non-enumerable
 *   `listingEvidence` describing what the listing page said.
 */
export async function runUmantisSpecWithEmptyProof(companyKey, runtime = {}) {
  const spec = loadSpec(companyKey);
  const evidence = { listingPageSeen: false, explicitEmptyState: false };
  // `fetch` must come from the SAME undici copy that supplies the dispatcher
  // `politeFetch` hands down: the built-in global skips gunzip in silence with a
  // foreign dispatcher, every page reads as empty, and here that would
  // manufacture a *false* proof. Never `globalThis.fetch`.
  const sourceFetch = runtime.fetchImpl || undiciFetch;

  const observingFetch = async (input, init) => {
    const rawUrl = typeof input === 'string' || input instanceof URL
      ? String(input)
      : String(input?.url || '');
    const response = await sourceFetch(input, init);
    if (isListingSeedUrl(rawUrl) && response?.ok && typeof response.clone === 'function') {
      const html = await response.clone().text();
      evidence.listingPageSeen = true;
      if (umantisListingStatesEmpty(html)) evidence.explicitEmptyState = true;
    }
    return response;
  };

  const rows = await runSpecInProduction(spec, { ...runtime, fetchImpl: observingFetch });
  Object.defineProperty(rows, 'listingEvidence', { value: evidence, enumerable: false });
  return rows;
}

/**
 * Turn an empty result into a source-proven zero, or into nothing at all.
 *
 * @param {object[]|null|undefined} listings result of `runUmantisSpecWithEmptyProof`
 * @param {string} label company label, for the log line
 * @returns {object[]|null} a marked empty batch, or null when the run cannot
 *   prove it observed an empty board — in which case the caller returns a bare
 *   `[]` and the pipeline keeps the previous slice.
 */
export function umantisAuthoritativeEmptyOrNull(listings, label) {
  const evidence = Reflect.get(listings || [], 'listingEvidence') || {};
  if (!evidence.listingPageSeen || !evidence.explicitEmptyState) {
    console.warn(
      `  ⚠️ ${label}: listing page did not state an empty job market`
      + ` (seen=${Boolean(evidence.listingPageSeen)}, emptyMarker=${Boolean(evidence.explicitEmptyState)}).`
      + ' Keeping existing jobs.',
    );
    return null;
  }
  console.log(`  🧩 Source-proven zero: Umantis rendered its own empty-state marker for ${label}`);
  return markAuthoritativeEmptySnapshot(
    [],
    'umantis listing page renders its platform empty-state marker with zero vacancy links',
  );
}
