/**
 * Resolve an employer NAME to its website, when a discovery source gave us a
 * name but no domain (the SECO feed carries a website on 3% of ads).
 *
 * Guess-and-verify, because Swiss SMEs overwhelmingly own their own name as a
 * domain. A first pass that accepted any single-token match resolved 63% of
 * names but produced junk like `CANTINA IL CAVALIERE SA -> cantina.com` and
 * `Cooperativa Migros -> cooperativa.com`: one generic word out of three is not
 * an identification. So verification here scores several independent pieces of
 * evidence and needs more than one of them to agree.
 *
 * A wrong domain is much more expensive than an unresolved one — it sends the
 * careers trail off to a stranger's site and can seed a false platform — so the
 * threshold is deliberately set to under-resolve.
 */
import { politeFetch } from './polite-fetch.mjs';
import { registrableDomain } from './registrable.mjs';
import { textOf } from './extract.mjs';

const STOPWORDS = /^(sa|ag|sagl|gmbh|srl|sarl|spa|ltd|inc|llc|di|e|the|of|und|et|il|lo|la|le|gli|der|die|das|les|des|del|della|dei|group|gruppo|holding|swiss|suisse|svizzera|schweiz|ticino|succursale|filiale|societa|società|cooperativa|fondazione|associazione|studio|ristorante|hotel|garage|azienda|centro|casa)$/;

/**
 * Significant tokens of a company name — the ones that identify it.
 * @param {string} name
 * @returns {string[]}
 */
export function nameTokens(name = '') {
  return String(name)
    .toLowerCase()
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .split(/\s+/)
    .filter((t) => t.length > 1 && !STOPWORDS.test(t));
}

/**
 * Domains an employer of this name plausibly owns.
 *
 * A single-token guess (`cantina.ch` from "Cantina Il Cavaliere") is only
 * offered when the name really is one token — that guess was the entire source
 * of the false positives measured above.
 *
 * @param {string} name
 * @returns {string[]}
 */
export function domainGuesses(name = '') {
  const t = nameTokens(name);
  if (!t.length) return [];
  const bases = new Set();
  bases.add(t.join(''));
  bases.add(t.join('-'));
  if (t.length >= 3) { bases.add(t.slice(0, 2).join('')); bases.add(t.slice(0, 2).join('-')); }
  if (t.length === 1) bases.add(t[0]);
  const out = [];
  for (const b of bases) {
    if (!b || b.length < 3 || b.length > 45) continue;
    out.push(`${b}.ch`, `${b}.com`);
  }
  return out.slice(0, 10);
}

/**
 * Score how strongly a fetched page belongs to this employer.
 *
 * @param {string} html
 * @param {{ name: string, city?: string, zip?: string }} employer
 * @returns {{ score: number, evidence: string[] }}
 */
export function verifyOwnership(html, employer) {
  const evidence = [];
  // Fold accents on the PAGE too, not just on the name tokens. Tokens are
  // already accent-folded (`Zürich` -> `zurich`), so comparing them against a raw
  // page means an accented employer name can never match its own website —
  // silently unresolvable, and the failure looks like "no site found".
  const fold = (v) => String(v).toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  const body = fold(textOf(html));
  const title = fold(/<title[^>]*>([\s\S]{0,300}?)<\/title>/i.exec(html)?.[1] || '');
  const tokens = nameTokens(employer.name);
  if (!tokens.length || body.length < 200) return { score: 0, evidence };

  const hits = tokens.filter((t) => body.includes(t));
  const coverage = hits.length / tokens.length;
  let score = 0;
  if (coverage === 1 && tokens.length >= 2) { score += 2; evidence.push('all-tokens'); }
  else if (coverage >= 0.5) { score += 1; evidence.push(`tokens:${hits.length}/${tokens.length}`); }

  if (tokens.filter((t) => title.includes(t)).length >= Math.min(2, tokens.length)) {
    score += 1.5; evidence.push('title');
  }
  if (employer.zip && body.includes(String(employer.zip))) { score += 1.5; evidence.push('zip'); }
  if (employer.city) {
    const city = String(employer.city).toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').split(/[ ,(]/)[0];
    if (city.length > 2 && body.includes(city)) { score += 1; evidence.push('city'); }
  }
  // A Swiss employer's own site nearly always names the country or a CH phone
  // prefix somewhere; a squatted generic .com usually does not.
  if (/\+41|\bsvizzera\b|\bschweiz\b|\bsuisse\b|\bswitzerland\b/.test(body)) { score += 0.5; evidence.push('ch-signal'); }
  return { score, evidence };
}

/**
 * @param {{ name: string, city?: string, zip?: string }} employer
 * @param {{ minScore?: number }} [opts]
 * @returns {Promise<{ domain: string|null, score: number, evidence: string[], tried: number }>}
 */
export async function resolveDomain(employer, opts = {}) {
  const minScore = opts.minScore ?? 3;
  const guesses = domainGuesses(employer.name);
  let best = { domain: null, score: 0, evidence: [], tried: 0 };
  for (const g of guesses) {
    best.tried++;
    const res = await politeFetch(`https://${g}/`);
    if (!res.ok || res.body.length < 400) continue;
    const v = verifyOwnership(res.body, employer);
    if (v.score > best.score) {
      best = { domain: registrableDomain(new URL(res.url).hostname), score: v.score, evidence: v.evidence, tried: best.tried };
    }
    if (best.score >= minScore + 1) break; // decisive, stop paying for more probes
  }
  return best.score >= minScore ? best : { ...best, domain: null };
}
