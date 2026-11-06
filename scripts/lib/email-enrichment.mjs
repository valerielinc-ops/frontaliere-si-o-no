// Shared employer-contact enrichment network helpers.
//
// The pure parsing/scoring logic lives in `email-finder.mjs` / `domain-finder.mjs`
// (unit-tested). This module holds the network + DNS side-effecting helpers that
// were previously duplicated between `enrich-employer-contacts.mjs` and
// `sync-employer-contacts-to-firestore.mjs`: a single copy keeps the ATS
// blocklist, scrape paths and DDG rate-limit from drifting apart.

import dns from 'node:dns/promises';
import { extractCompanyEmails } from './email-finder.mjs';
import { extractDdgDomains, guessDomains, rankDomains } from './domain-finder.mjs';

// Third-party ATS / job-board domains: a careers/website URL pointing here is
// NOT the employer's own domain, so its apex would be wrong (e.g. emailing
// ncoreplat.com). Skip email-scraping when the resolved apex is one of these.
export const ATS_DOMAINS = new Set([
  'lever.co', 'greenhouse.io', 'myworkdayjobs.com', 'workday.com', 'smartrecruiters.com',
  'personio.de', 'personio.com', 'recruitee.com', 'ncoreplat.com', 'ostendis.com',
  'refline.ch', 'prospective.ch', 'jobs.ch', 'jobscout24.ch', 'indeed.com',
  'jobcloud.ch', 'softgarden.io', 'teamtailor.com', 'workable.com', 'bamboohr.com',
  'orior.ch', 'oraclecloud.com', 'taleo.net', 'successfactors.com', 'eu.greenhouse.io',
  'intervieweb.it', 'inrecruiting.intervieweb.it', 'abacuscity.ch', 'umantis.com',
  'dualoo.com', 'guidecom.de', 'rexx-systems.com', 'join.com', 'factorial.co',
]);

/** Fetch a URL's text (best-effort, capped, timed out). Empty string on any failure. */
export async function fetchText(url, timeoutMs = 8000) {
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), timeoutMs);
    const r = await fetch(url, { signal: ctrl.signal, redirect: 'follow', headers: { 'User-Agent': 'Mozilla/5.0 (compatible; frontaliereticino-enrichment/1.0)' } });
    clearTimeout(t);
    if (!r.ok) return '';
    return (await r.text()).slice(0, 500_000);
  } catch { return ''; }
}

/** True when the apex domain publishes at least one MX record (mailbox exists). */
export async function mxOk(domain) {
  try { const mx = await dns.resolveMx(domain); return Array.isArray(mx) && mx.length > 0; } catch { return false; }
}

// Find the employer's own domain when the registry lacks it: web search +
// heuristic guesses, validated by MX + a name-token match (rejects directories).
let _lastDdg = 0;
export async function findDomain(name) {
  const wait = 2500 - (Date.now() - _lastDdg); // space DDG calls (avoid throttling)
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  _lastDdg = Date.now();
  let candidates = [];
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 9000);
    const r = await fetch('https://html.duckduckgo.com/html/?q=' + encodeURIComponent(name + ' sito ufficiale'),
      { signal: ctrl.signal, headers: { 'User-Agent': 'Mozilla/5.0', 'Accept-Language': 'it' } });
    clearTimeout(t);
    if (r.ok) candidates = extractDdgDomains(await r.text());
  } catch { /* search unavailable → fall back to guesses */ }
  candidates.push(...guessDomains(name));
  const valid = [];
  for (const d of [...new Set(candidates)]) { if (!ATS_DOMAINS.has(d) && await mxOk(d)) valid.push(d); if (valid.length >= 6) break; }
  return rankDomains(valid, name)[0] || '';
}

/** Contact/impressum/careers paths probed on an employer's own domain. */
export const CONTACT_PATHS = [
  '', '/contatti', '/contatti/', '/it/contatti', '/contact', '/contact/', '/kontakt',
  '/impressum', '/chi-siamo', '/lavora-con-noi', '/lavora-con-noi/', '/jobs', '/careers',
  '/azienda/contatti',
];

/**
 * Deep-scrape the employer's OWN domain (contact/impressum/careers pages) and
 * return the on-domain emails found (third-party noise dropped by the domain
 * filter in email-finder). Returns [] for unknown/ATS domains.
 */
export async function scrapeCompanyEmails(domain) {
  if (!domain || ATS_DOMAINS.has(domain)) return [];
  const origins = [`https://www.${domain}`, `https://${domain}`];
  const found = new Set();
  for (const origin of origins) {
    for (const p of CONTACT_PATHS) {
      const html = await fetchText(origin + p);
      if (!html) continue;
      for (const e of extractCompanyEmails(html, domain)) found.add(e);
      if (found.size >= 8) return [...found];
    }
    if (found.size) break;
  }
  return [...found];
}
