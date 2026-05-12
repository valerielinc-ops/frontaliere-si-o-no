// Pure utility functions for related-search slug generation.
// Extracted from components/community/JobBoard.tsx so that build plugins can
// reuse them at build time. No React/DOM dependencies.

import type { Locale } from '@/services/i18n';
import type { JobListing } from '@/components/community/JobBoard';

export const DEFAULT_CANTON_DISPLAY = 'Ticino';

export function sanitizeJobTitle(raw: string): string {
 const decoded = String(raw || '')
 .replace(/&nbsp;/gi, ' ')
 .replace(/&amp;/gi, '&')
 .replace(/&raquo;/gi, '»')
 .replace(/&laquo;/gi, '«')
 .replace(/<[^>]+>/g, ' ')
 .replace(/^#+\s*/, '')
 .replace(/\s+/g, ' ')
 .trim();

 const normalizedInclusive = decoded
 .replace(/\b([A-Za-zÀ-ÖØ-öø-ÿ]{3,})\/([A-Za-zÀ-ÖØ-öø-ÿ]{1,3})\b/g, '$1 $2')
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
 if (locale === 'en') return 'find-jobs-ticino';
 if (locale === 'de') return 'jobs-im-tessin';
 if (locale === 'fr') return 'trouver-emploi-tessin';
 return 'cerca-lavoro-ticino';
}

export function buildSearchSlug(term: string, locale: Locale): string {
 const prefix = getSearchSlugPrefix(locale);
 const core = slugifyJobPart(term);
 return `${prefix}-${core || 'lavoro'}`;
}

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
 return query || null;
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
 .filter((token) => token !== locationToken);

 const generated = locale === 'it'
 ? bodyTokens.map((token) => `${token} ${location || DEFAULT_CANTON_DISPLAY.toLowerCase()}`.trim())
 : bodyTokens.map((token) => `${token} ${location}`.trim());

 // N2 decision (2026-05-06): drop `${company} ${location}` — that intent is
 // already covered by the `azienda-*` / `company-*` slug family
 // (parseCompanySlugFilter, JobBoard.tsx). Keeping it would duplicate
 // company-hub pages at /search-{company}-{city}/ and /azienda-{company}/.
 // N3 decision: KEEP the template-string candidates (offerte lavoro / salary
 // switzerland / requirements) — they may capture long-tail Google queries.
 const candidates = cleanCanonicalItems([
 ...aiKeywords,
 shortTitle,
 `${shortTitle} ${location}`.trim(),
 `${shortTitle} ${company}`.trim(),
 // `${company} ${location}` removed (N2 filter)
 ...(locale === 'it'
 ? [
 `offerte lavoro ${shortTitle}`.trim(),
 `stipendio ${shortTitle} svizzera`.trim(),
 `mansioni ${shortTitle}`.trim(),
 ]
 : [
 `${shortTitle} salary switzerland`.trim(),
 `${shortTitle} requirements`.trim(),
 ]),
 ...generated,
 ], 24);

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
