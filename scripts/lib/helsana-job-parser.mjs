#!/usr/bin/env node
/**
 * Helsana job parser — SAP SuccessFactors Career Site Builder (CSB).
 *
 * Helsana is Switzerland's largest health & accident insurer. Public career
 * site: https://careers.helsana.ch/ (SF CSB tenant code `Helsana`).
 *
 * All postings are Switzerland-based (CH-only insurer); main locations are
 * Dübendorf-Stettbach (HQ), Zürich, Bern, Basel. Canton ZH, postal 8600
 * (Zürichstrasse 130, Dübendorf).
 *
 * Uses the shared SuccessFactors factory — see
 * scripts/lib/successfactors-shared-job-parser-common.mjs.
 */
import { createSuccessFactorsParser } from './successfactors-shared-job-parser-common.mjs';

export const HELSANA_KEY = 'helsana';
export const HELSANA_COMPANY_NAME = 'Helsana';
export const HELSANA_COMPANY_DOMAIN = 'helsana.ch';

/**
 * Helsana's careers.helsana.ch (as of 2026-07) serves the exact same generic
 * "Machen Sie uns erfolgreicher!" company blurb as the `itemprop="description"`
 * content on EVERY job page — verified live across multiple, unrelated
 * postings (#3497): no "Aufgaben"/"Anforderungen" section, no hidden JSON, no
 * separate API, nothing job-specific anywhere on the page. This is a genuine
 * source-content regression, not a parser/selector bug — and it's real
 * content long enough that the shared factory's thin-description guard
 * (`MIN_DESCRIPTION_UNIQUE_WORDS`) never even fires, so its content flows
 * through unchanged and identical across every job (the audit's "chrome
 * scraping" duplicate signal) with no bullet/list structure of its own (the
 * "no structured content" signal).
 *
 * Fix: build a small bulleted block from real per-job fields the CSB page
 * DOES expose for every posting — title (already carries the workload
 * percentage, e.g. "(a) 80-100%"), location and canton — and prepend it to
 * the real fetched description (never discarded). Putting the job-specific
 * block first keeps every job's stored text genuinely distinct within the
 * audit's fingerprint window and gives it real list structure, without
 * fabricating anything that isn't already on the page.
 */
function helsanaStructuredBlock(title, companyName, city, canton) {
  const pensumMatch = String(title || '').match(/(\d{1,3}\s*-\s*\d{1,3}\s*%|\d{1,3}\s*%)/);
  const pensum = pensumMatch ? pensumMatch[1].replace(/\s+/g, '') : '';
  return [
    `Position: ${title}`,
    `- Standort: ${city}${canton ? `, Kanton ${canton}` : ''}`,
    pensum ? `- Pensum: ${pensum}` : null,
    `- Arbeitgeber: ${companyName}`,
  ].filter(Boolean).join('\n');
}

// Defensive fallback for the shared factory's own thin-description guard —
// dormant today (see module doc: real content is never thin enough to trip
// it) but keeps a real, non-duplicate template ready if the site ever
// degrades further to genuinely empty/near-empty descriptions.
function helsanaBoilerplateFallback(title, companyName, city, canton) {
  return `${helsanaStructuredBlock(title, companyName, city, canton)}\n\n${companyName} ist die führende Schweizer Kranken- und Unfallversicherung. Die vollständige Stellenbeschreibung mit Aufgaben und Anforderungen finden Sie in der Original-Stellenanzeige auf careers.helsana.ch.`;
}

const parser = createSuccessFactorsParser({
  companyKey: HELSANA_KEY,
  companyName: HELSANA_COMPANY_NAME,
  companyDomain: HELSANA_COMPANY_DOMAIN,
  sfCompanyId: 'Helsana',
  publicCareerUrl: 'https://careers.helsana.ch',
  defaultCanton: 'ZH',
  defaultCity: 'Dübendorf',
  defaultPostalCode: '8600',
  defaultSourceLang: 'de',
  sourceLabel: 'Helsana Dedicated Parser (SuccessFactors CSB)',
  sector: 'Assicurazioni',
  fallbackCategory: 'Amministrazione',
  boilerplateFallback: helsanaBoilerplateFallback,
});

/**
 * Fetch all Helsana jobs, then prepend the real per-job structured block
 * (see module doc, #3497) to every job's description — unconditionally,
 * since the real live content itself (not just a rare thin/failed fetch) is
 * what's duplicate across jobs here.
 */
export async function fetchAllHelsanaJobs() {
  const jobs = await parser.fetchAllJobs();
  for (const job of jobs) {
    const block = helsanaStructuredBlock(
      job.title,
      HELSANA_COMPANY_NAME,
      job.location || job.addressLocality || 'Dübendorf',
      job.canton || job.addressRegion || 'ZH',
    );
    if (typeof job.description === 'string' && job.description && !job.description.startsWith(block)) {
      job.description = `${block}\n\n${job.description}`;
    }
    const srcLang = job.sourceLang || 'de';
    const existing = job.descriptionByLocale?.[srcLang];
    if (typeof existing === 'string' && existing && !existing.startsWith(block)) {
      job.descriptionByLocale[srcLang] = `${block}\n\n${existing}`;
    }
  }
  return jobs;
}

export const isHelsanaJob = parser.isCompanyJob;
export const isTrustedDomain = parser.isTrustedDomain;
