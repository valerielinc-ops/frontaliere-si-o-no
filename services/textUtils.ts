/**
 * Shared text utilities for search normalization, keyword extraction,
 * and job matching primitives.
 *
 * Used by:
 * - components/community/JobBoard.tsx (search, relatedJobs)
 * - services/personalizationScoring.ts (behavior matching)
 */

/** Normalize text for search: lowercase, strip diacritics, strip non-alphanumeric. */
export function normalizeSearchText(value: string): string {
 return String(value || '')
 .toLowerCase()
 .normalize('NFD')
 .replace(/[\u0300-\u036f]/g, '')
 .replace(/[^a-z0-9\s]/g, ' ')
 .replace(/\s+/g, ' ')
 .trim();
}

/**
 * Stop words for keyword extraction.
 * Duplicated from newsletter-content.mjs:163 (Node-only .mjs, not importable by browser TS).
 */
const STOP_WORDS = new Set([
 // IT connectives
 'il', 'lo', 'la', 'le', 'i', 'gli', 'un', 'uno', 'una', 'di', 'del', 'della',
 'dei', 'delle', 'dello', 'degli', 'da', 'dal', 'dalla', 'a', 'al', 'alla',
 'in', 'nel', 'nella', 'con', 'su', 'sul', 'sulla', 'per', 'tra', 'fra', 'e', 'o',
 // EN connectives
 'the', 'an', 'of', 'for', 'and', 'or', 'at', 'to', 'on', 'with', 'from',
 // DE connectives
 'der', 'die', 'das', 'ein', 'eine', 'und', 'oder', 'fur', 'von', 'mit', 'im', 'am',
 // FR connectives
 'les', 'une', 'de', 'du', 'des', 'et', 'ou', 'pour', 'dans', 'en',
 // Generic filler
 'sa', 'ag', 'gmbh', 'srl', 'spa', 'ltd', 'inc', 'se', 'che', 'non', 'trice',
 'm', 'f', 'd', 'mfd', 'w', 'h', 'hf',
]);

/** Extract meaningful keywords from text. Filters stop words and short tokens (<3 chars). */
export function extractKeywords(text: string): Set<string> {
 if (!text) return new Set();
 const tokens = String(text)
 .toLowerCase()
 .replace(/[^a-zà-ü0-9\s-]/g, '')
 .split(/[-\s]+/)
 .filter((t) => t.length >= 3 && !STOP_WORDS.has(t));
 return new Set(tokens);
}

/** Count keyword overlap between two sets. */
export function keywordOverlap(a: Set<string>, b: Set<string>): number {
 let count = 0;
 for (const word of a) {
 if (b.has(word)) count++;
 }
 return count;
}

// ─── Job matching primitives ────────────────────────────────────
// Shared by relatedJobs (JobBoard.tsx) and computePersonalScore.

/** Check if two category values match (exact string comparison). */
export function isCategoryMatch(a: string, b: string): boolean {
 return !!a && !!b && a === b;
}

/** Check if two location values match (normalized substring). */
export function isLocationMatch(a: string, b: string): boolean {
 if (!a || !b) return false;
 const na = normalizeSearchText(a);
 const nb = normalizeSearchText(b);
 return na === nb || na.includes(nb) || nb.includes(na);
}

/** Check if two company values match (normalized exact). */
export function isCompanyMatch(a: string, b: string): boolean {
 if (!a || !b) return false;
 return normalizeSearchText(a) === normalizeSearchText(b);
}
