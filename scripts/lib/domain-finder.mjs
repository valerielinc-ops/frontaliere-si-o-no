// Company domain finder — fills the "no domain" gap so the email-finder can
// scrape an employer's own site. Empirically (research 2026-06-17): a web search
// ("<name> sito ufficiale") returns the real domain for most companies; a
// slug.ch/.com guess covers single-word names. Both are validated by (a) an MX
// record and (b) a name-token overlap (rejects directories like yellowpages /
// help.ch that a raw search surfaces).
//
// Pure helpers are unit-tested; network (search fetch) + DNS live in the caller.

import { apexDomain } from './email-finder.mjs';

// Directories / social / ATS / search engines — never a company's own domain.
const BLOCK = /(linkedin|facebook|instagram|xing|twitter|^x\.com$|youtube|wikipedia|indeed|lever\.co|greenhouse|workday|jobs\.ch|jobscout24|glassdoor|kununu|google\.|moneyhouse|local\.ch|search\.ch|zefix|yellowpages|help\.ch|dnb\.com|tel\.search|paginegialle|europages|north-data|companyhouse)/i;

const STOPWORDS = new Set(['sa', 'sagl', 'ag', 'gmbh', 'srl', 'spa', 'the', 'group', 'international', 'holding', 'holdings', 'suisse', 'svizzera', 'schweiz', 'switzerland', 'di', 'e', 'la', 'il', 'lo', 'der', 'die', 'das', 'and', 'co']);

/** Significant lowercased, accent-stripped name tokens (≥3 chars, no legal/stop words). */
export function nameTokens(name) {
  return String(name || '')
    .normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()
    .split(/[^a-z0-9]+/).filter((t) => t.length >= 3 && !STOPWORDS.has(t));
}

/** True when the domain's label shares a ≥3-char token with the company name. */
export function domainMatchesName(domain, name) {
  const label = String(domain || '').split('.')[0].replace(/[^a-z0-9]/gi, '').toLowerCase();
  if (!label) return false;
  for (const tok of nameTokens(name)) {
    if (label.includes(tok) || tok.includes(label)) return true;
  }
  return false;
}

/** Parse DuckDuckGo HTML results → candidate apex domains (blocklist-filtered). */
export function extractDdgDomains(html) {
  const out = [];
  for (const m of String(html || '').matchAll(/uddg=([^&"']+)/g)) {
    try {
      const u = new URL(decodeURIComponent(m[1]));
      const a = apexDomain(u.hostname.toLowerCase());
      if (a && !BLOCK.test(a) && !out.includes(a)) out.push(a);
    } catch { /* skip */ }
    if (out.length >= 8) break;
  }
  return out;
}

/** Heuristic domain guesses for a company name (single-word + acronym). */
export function guessDomains(name) {
  const toks = nameTokens(name);
  const out = [];
  if (toks[0]) { out.push(`${toks[0]}.ch`, `${toks[0]}.com`); }
  // acronym of first letters (e.g. "USI", "EOC") when 2–4 significant tokens
  const allToks = String(name || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
  if (allToks.length >= 2 && allToks.length <= 4) {
    const acr = allToks.map((t) => t[0]).join('');
    if (acr.length >= 2) out.push(`${acr}.ch`);
  }
  return [...new Set(out)];
}

/**
 * Rank validated candidates: prefer .ch (Swiss employers), then name-match
 * strength (shorter label = stronger), drop non-name-matching directories.
 * `candidates` must already be MX-validated by the caller.
 */
export function rankDomains(candidates, name) {
  const matched = [...new Set(candidates)].filter((d) => domainMatchesName(d, name));
  return matched.sort((a, b) => {
    const ch = (b.endsWith('.ch') ? 1 : 0) - (a.endsWith('.ch') ? 1 : 0);
    if (ch) return ch;
    return a.split('.')[0].length - b.split('.')[0].length;
  });
}
