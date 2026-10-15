// Pure utility functions for related-search slug generation.
// Extracted from components/community/JobBoard.tsx so that build plugins can
// reuse them at build time. No React/DOM dependencies.

import type { Locale } from './i18n';
import type { JobListing } from '../components/community/JobBoard';
import { RELATED_SEARCH_JUNK_TERMS, isJunkSearchKeyword } from './relatedSearchJunkTerms.mjs';
import {
 SEARCH_QUERY_BOILERPLATE_PHRASES,
 SEARCH_QUERY_TEMPLATE_SUFFIX_TERMS,
 SEARCH_QUERY_BOILERPLATE_TOKENS,
 stripSearchQueryBoilerplate,
} from './searchQueryBoilerplate.mjs';
import { MARKDOWN_CHUNK_HEADING_RE } from './jobs/plainTextMarkdown.ts';

export { RELATED_SEARCH_JUNK_TERMS, isJunkSearchKeyword };
export {
 SEARCH_QUERY_BOILERPLATE_PHRASES,
 SEARCH_QUERY_TEMPLATE_SUFFIX_TERMS,
 SEARCH_QUERY_BOILERPLATE_TOKENS,
 stripSearchQueryBoilerplate,
};

export const DEFAULT_CANTON_DISPLAY = 'Ticino';

export function sanitizeJobTitle(raw: string): string {
 const decoded = String(raw || '')
 .replace(/&nbsp;/gi, ' ')
 .replace(/&amp;/gi, '&')
 .replace(/&raquo;/gi, '»')
 .replace(/&laquo;/gi, '«')
 .replace(/<[^>]+>/g, ' ')
 .replace(MARKDOWN_CHUNK_HEADING_RE, '')
 .replace(/\s+/g, ' ')
 .trim();

 const normalizedInclusive = decoded
 .replace(/\b([A-Za-zÀ-ÖØ-öø-ÿ]{3,})\/([A-Za-zÀ-ÖØ-öø-ÿ]{1,3})\b/g, '$1 $2')
 // Strip dangling gender-suffix remnants the inclusive rule above can't reach:
 // " /-a", " /-in", or a bare " /" left when the slashed gender form
 // (e.g. "Responsabile Neurologia /-a") was split off. Only fires at end or
 // before punctuation, so a legit " / " separator ("Manager / Director") and
 // mid-token slashes ("TCP/IP", "24/7", "(m/w/d)") are untouched.
 .replace(/\s+\/-?[a-zà-ÿ]{0,3}(?=[,;.)]|$)/gi, '')
 .replace(/\/-[a-zà-ÿ]{1,3}\b/gi, '')
 .replace(/\s{2,}/g, ' ')
 .replace(/\s+,/g, ',')
 .trim();

 return normalizedInclusive || decoded;
}

export function cleanCanonicalItems(value: unknown, max = 12): string[] {
 if (!Array.isArray(value)) return [];
 const seen = new Set<string>();
 const out: string[] = [];
 for (const item of value) {
 const clean = String(item || '').replace(/\s+/g, ' ').trim();
 if (!clean || clean.length < 3) continue;
 const key = clean.toLowerCase();
 if (seen.has(key)) continue;
 seen.add(key);
 out.push(clean);
 if (out.length >= max) break;
 }
 return out;
}

export function slugifyJobPart(value: string): string {
 return String(value || '')
 .toLowerCase()
 .normalize('NFD')
 .replace(/[̀-ͯ]/g, '')
 .replace(/[^a-z0-9]+/g, '-')
 .replace(/^-+|-+$/g, '')
 .slice(0, 200);
}

export function getSearchSlugPrefix(locale: Locale): string {
 if (locale === 'en') return 'search';
 if (locale === 'de') return 'suche';
 if (locale === 'fr') return 'recherche';
 return 'ricerca';
}

// BLOCK-B: Regionalize for national expansion — currently hardcodes Ticino/Tessin text
export function getJobBoardSectionSlug(locale: Locale): string {
 if (locale === 'en') return 'find-jobs-ticino'; // cathedral-allow: TI legacy section default
 if (locale === 'de') return 'jobs-im-tessin'; // cathedral-allow: TI legacy section default
 if (locale === 'fr') return 'trouver-emploi-tessin'; // cathedral-allow: TI legacy section default
 return 'cerca-lavoro-ticino'; // cathedral-allow: TI legacy section default
}

export function buildSearchSlug(term: string, locale: Locale): string {
 const prefix = getSearchSlugPrefix(locale);
 const core = slugifyJobPart(term);
 return `${prefix}-${core || 'lavoro'}`;
}

// Job-search boilerplate that GSC queries routinely prepend to the real
// intent ("offerte di lavoro cuoco", "lavoro infermiere", "stellenangebote
// koch"). These words never occur in job titles, so leaving them in the
// seeded query makes the strict AND-match impossible to satisfy and forces
// every such slug-landing into the "Nessun risultato esatto" fuzzy fallback —
// and, on the static cluster pages, into the same OR-fallback dilution. The
// same strip is therefore applied both here (SPA query seed) and at build time
// (build-plugins/relatedSearchClustersPlugin.ts, related-search matching) so
// the static and hydrated job sets stay in lockstep.
//
// Single source of truth for both the phrase/token lists AND
// stripSearchQueryBoilerplate(): services/searchQueryBoilerplate.mjs (plain
// .mjs so scripts/build-search-cluster-301-map.mjs can import it too — see
// that module's docblock). Re-exported here for existing callers of this file
// (tests/seo/related-search-clusters-emitted.test.ts and others import them
// from this path).

export function parseSearchSlugFilter(initialJobSlug?: string): string | null {
 if (!initialJobSlug) return null;
 const prefixes = ['ricerca-', 'search-', 'suche-', 'recherche-'];
 const hit = prefixes.find((p) => initialJobSlug.startsWith(p));
 if (!hit) return null;
 const raw = initialJobSlug.slice(hit.length).trim();
 if (!raw) return null;
 let decoded = raw;
 try {
 decoded = decodeURIComponent(raw);
 } catch {
 // keep raw
 }
 const query = decoded.replace(/-/g, ' ').replace(/\s+/g, ' ').trim();
 if (!query) return null;
 // stripSearchQueryBoilerplate never returns empty (falls back to the
 // original term), so no extra null-guard is needed here.
 return stripSearchQueryBoilerplate(query);
}

// Tokens are filtered by `t.length >= 4` upstream, so 1-3 char stopwords are
// excluded by the length gate (no need to list `il`, `la`, `da`, `di`, etc.).
// Kept in this set: 4+ char function words across IT/EN/DE/FR + domain noise
// that leaks from job-description boilerplate (e.g. "vous", "dans", "sind",
// "have"). Without these, slugs like /recherche-vous-chur/ get emitted as real
// anchor links on every Chur job in French — high-frequency, zero search
// intent, doorway-page risk if promoted to canonical landings.
export const RELATED_SEARCH_STOPWORDS = new Set([
 // IT
 'della', 'delle', 'dello', 'degli', 'dell', 'alla', 'alle', 'allo', 'agli', 'con', 'per', 'nel', 'nella', 'nelle',
 'sul', 'sulla', 'sulle', 'dei', 'del', 'di', 'da', 'tra', 'fra', 'che', 'chi', 'con', 'su', 'il', 'lo', 'la', 'i', 'gli', 'le',
 'anche', 'ancora', 'sempre', 'ogni', 'tutto', 'tutta', 'tutti', 'tutte', 'dopo', 'prima', 'sotto', 'sopra',
 'dentro', 'fuori', 'senza', 'molto', 'poco', 'tanto', 'questo', 'questa', 'questi', 'queste', 'quello', 'quella',
 'quelli', 'quelle', 'come', 'quando', 'dove', 'mentre', 'perche', 'hanno', 'sono', 'siamo', 'siete', 'sara',
 'saranno', 'noi', 'voi', 'loro', 'nostro', 'nostra', 'nostri', 'nostre', 'vostro', 'vostra', 'vostri', 'vostre',
 // EN
 'the', 'and', 'for', 'with', 'from', 'this', 'that', 'these', 'those', 'have', 'will', 'would', 'could', 'should',
 'only', 'even', 'also', 'some', 'more', 'most', 'much', 'many', 'well', 'your', 'ours', 'them', 'they', 'their',
 'into', 'after', 'before', 'about', 'where', 'while', 'when', 'than', 'what', 'which', 'been', 'were', 'being',
 // DE
 'der', 'die', 'das', 'und', 'sein', 'sind', 'ihre', 'ihren', 'deren', 'ihnen', 'haben', 'hatte', 'wird', 'werden',
 'wurde', 'worden', 'nicht', 'kein', 'keine', 'keinen', 'alle', 'alles', 'allen', 'aber', 'oder', 'doch', 'schon',
 'sehr', 'mehr', 'immer', 'noch', 'beim', 'dies', 'diese', 'dieser', 'dieses', 'diesen', 'ohne', 'gegen', 'durch',
 'sich', 'nach', 'wenn', 'dann', 'unter', 'ueber',
 'eine', 'einer', 'eines', 'einen', 'einem', 'deine', 'deiner', 'deinen', 'deinem', 'mein', 'meine', 'meiner', 'meinen',
 // FR
 'pour', 'avec', 'des', 'les', 'vous', 'votre', 'vos', 'nous', 'notre', 'nos', 'leur', 'leurs', 'dans', 'sans',
 'sous', 'vers', 'chez', 'mais', 'aussi', 'ainsi', 'encore', 'plus', 'sont', 'sera', 'seront', 'etre', 'avoir',
 'faire', 'autre', 'autres', 'meme', 'memes', 'cette', 'celle', 'celui', 'ceux', 'entre', 'avant', 'apres',
 'depuis', 'durant', 'lorsque', 'quand', 'comme', 'parce', 'alors', 'donc', 'ensuite', 'puis', 'toujours',
 'jamais', 'tres', 'bien', 'mieux', 'tout', 'tous', 'toute', 'toutes', 'aucun', 'chaque', 'plusieurs', 'certains',
 // Domain noise
 'lavoro', 'offerta', 'annuncio', 'job', 'jobs', 'stelle', 'emploi', 'emplois', 'posto', 'ruolo', 'position', 'ticino', 'svizzera',
 'team', 'teams', 'candidato', 'candidata', 'candidat', 'candidate', 'candidates', 'kandidat', 'kandidatin',
 'azienda', 'aziende', 'unternehmen', 'entreprise', 'company', 'companies', 'societa', 'societe',
 'experience', 'esperienza', 'erfahrung', 'erfahrungen',
 'client', 'clients', 'clienti', 'cliente', 'kunde', 'kunden', 'customer', 'customers',
]);

export function extractRelatedTopicTokens(value: string, max = 8): string[] {
 const counts = new Map<string, number>();
 const tokens = String(value || '')
 .toLowerCase()
 .normalize('NFD')
 .replace(/[̀-ͯ]/g, '')
 .replace(/[^a-z0-9\s]/g, ' ')
 .split(/\s+/)
 .map((t) => t.trim())
 .filter((t) => t.length >= 4 && !RELATED_SEARCH_STOPWORDS.has(t) && !/^\d+$/.test(t));
 for (const token of tokens) {
 counts.set(token, (counts.get(token) || 0) + 1);
 }
 return Array.from(counts.entries())
 .sort((a, b) => b[1] - a[1])
 .slice(0, max)
 .map(([token]) => token);
}

export function isValidRelatedSearchTerm(value: string): boolean {
 const clean = String(value || '').replace(/\s+/g, ' ').trim();
 if (!clean) return false;
 if (clean.length < 3 || clean.length > 70) return false;
 if (clean.split(' ').length > 8) return false;
 return true;
}

export function buildRelatedSearches(params: {
 job: JobListing;
 locale: Locale;
 summary: string[];
 requirements: string[];
 aiKeywords: string[];
}): string[] {
 const { job, locale, summary, requirements, aiKeywords } = params;
 const title = sanitizeJobTitle(job.titleByLocale?.[locale] ?? job.title).replace(/\s+/g, ' ').trim();
 const shortTitle = title.split(/[-–—|•·]/)[0]?.trim() || title;
 const location = String(job.location || '').trim();
 const company = String(job.company || '').trim();
 // Strip body tokens that equal the location itself (avoids self-duplicating
 // slugs like /suche-gossau-gossau/ when a job in Gossau mentions "Gossau" in
 // the description and the token-extractor pulls it as a "topic").
 const locationToken = String(location || DEFAULT_CANTON_DISPLAY)
 .toLowerCase()
 .normalize('NFD')
 .replace(/[̀-ͯ]/g, '');
 const bodyTokens = extractRelatedTopicTokens(`${summary.join(' ')} ${requirements.join(' ')}`, 6)
 // Drop generic filler / cross-language connectives / scraped UI noise so the
 // `${token} ${location}` candidates never become thin doorway landings
 // (e.g. "cookie bern", "sowie basel"). See relatedSearchJunkTerms.mjs.
 .filter((token) => token !== locationToken && !RELATED_SEARCH_JUNK_TERMS.has(token));

 const generated = locale === 'it'
 ? bodyTokens.map((token) => `${token} ${location || DEFAULT_CANTON_DISPLAY.toLowerCase()}`.trim())
 : bodyTokens.map((token) => `${token} ${location}`.trim());

 // N2 decision (2026-05-06): drop `${company} ${location}` — that intent is
 // already covered by the `azienda-*` / `company-*` slug family
 // (parseCompanySlugFilter, JobBoard.tsx). Keeping it would duplicate
 // company-hub pages at /search-{company}-{city}/ and /azienda-{company}/.
 // N4 decision (2026-06-02): DROP the template-string candidates
 // ("offerte lavoro …", "stipendio … svizzera", "… salary switzerland",
 // "… requirements"). They seeded slugs whose trailing nation/template token
 // ("switzerland"/"svizzera") OR-matched any job mentioning the nation,
 // surfacing off-intent listings on the slug landing (the reported
 // pizzaiolo-…-salary-switzerland case). Every proposed term is now run
 // through stripSearchQueryBoilerplate so no candidate carries leading
 // job-search noise or a trailing nation/salary/requirements suffix — terms
 // that collapse to boilerplate-only are dropped (never-empty fallback yields
 // a dup of the bare title, deduped by cleanCanonicalItems).
 const candidates = cleanCanonicalItems([
 ...aiKeywords,
 shortTitle,
 `${shortTitle} ${location}`.trim(),
 `${shortTitle} ${company}`.trim(),
 // `${company} ${location}` removed (N2 filter)
 // template-string candidates removed (N4 filter)
 ...generated,
 ].map((term) => stripSearchQueryBoilerplate(term)), 24);

 return candidates.filter(isValidRelatedSearchTerm).slice(0, 10);
}

// Resolves the best related-search keyword to surface in the post-login
// alert prompt when the user has no active text query but is viewing a
// detail page. Uses only the template-derived candidates from title +
// location + company (passes empty summary/requirements/aiKeywords) so it
// works synchronously without waiting for the async canonical-content fetch.
// Returns the candidate with the highest count of matching jobs in `jobs`,
// or null if no candidate matches any job.
export function pickBestRelatedSearchForPrompt(params: {
 job: JobListing;
 locale: Locale;
 jobs: readonly JobListing[];
 matches: (job: JobListing, term: string) => boolean;
}): string | null {
 const { job, locale, jobs, matches } = params;
 const candidates = buildRelatedSearches({
 job,
 locale,
 summary: [],
 requirements: [],
 aiKeywords: [],
 });
 let bestTerm: string | null = null;
 let bestCount = 0;
 for (const term of candidates) {
 let count = 0;
 for (const j of jobs) {
 if (matches(j, term)) count++;
 }
 if (count > bestCount) {
 bestCount = count;
 bestTerm = term;
 }
 }
 return bestTerm;
}
