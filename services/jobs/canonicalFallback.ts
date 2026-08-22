// Heuristic fallback that turns a raw job description + requirements into the
// same `CanonicalLocaleContent` shape produced by the (still-absent) AI canonical
// pipeline. Imported by both `components/community/JobBoard.tsx` (runtime SPA)
// and `build-plugins/jobsSeoPagesPlugin.ts` (SSG) so the static HTML emitted to
// `dist/` and the hydrated SPA render the same sectioned timeline.
//
// Keep this module pure: no React, no DOM, no Node-only APIs.

// Use relative imports (not the `@/...` Vite alias): this module is
// transitively required by build-plugins loaded during `vite.config.ts`
// evaluation, where Node ESM resolves before Vite installs alias support.
//
// Value imports use EXPLICIT `.ts` extensions because this module is also
// loaded directly by `build-plugins/canonicalFallbackWorker.mjs` via tsx
// in a `worker_threads` context — there is no Vite resolver in the worker
// and Node's ESM resolver does NOT auto-append `.ts`. Without the
// extension the worker boots and crashes with
// `ERR_MODULE_NOT_FOUND: Cannot find module '.../relatedSearchClusters'`
// (run 26444788444). The main-thread Vite path tolerates the explicit
// `.ts` extension because `tsconfig.json` sets
// `allowImportingTsExtensions: true`.
import type { Locale } from '../i18n';
import { cleanCanonicalItems } from '../relatedSearchClusters.ts';
// Relative, not `@/`: this module is reachable from vite.config.ts, which Vite
// bundles with esbuild BEFORE its own aliases exist (tests/vite-config-import-graph).
import { MARKDOWN_CHUNK_HEADING_RE } from './plainTextMarkdown.ts';

export type CanonicalLocaleContent = {
 summary: string[];
 sections: Array<{
 id: string;
 heading: string;
 paragraphs: string[];
 bullets: string[];
 }>;
 responsibilities: string[];
 requirements: string[];
 benefits: string[];
 process: string[];
 highlights: string[];
 keywords: string[];
 readingMinutes: number;
};

type FallbackSectionId =
 | 'overview'
 | 'responsibilities'
 | 'requirements'
 | 'benefits'
 | 'application'
 | 'contacts'
 | 'company'
 | 'details'
 | 'notes';

const FALLBACK_SECTION_ORDER: FallbackSectionId[] = [
 'overview',
 'responsibilities',
 'requirements',
 'benefits',
 'application',
 'contacts',
 'company',
 'details',
 'notes',
];

const FALLBACK_HEADING_MAP: Array<{ id: FallbackSectionId; title: string; keys: string[] }> = [
 { id: 'overview', title: 'Panoramica', keys: ['descrizione', 'panoramica', 'overview', 'about the role', 'introduzione'] },
 { id: 'responsibilities', title: 'Mansioni principali', keys: ['mansioni', 'compiti', 'responsabilita', 'tasks', 'responsibilities', 'ihre aufgaben', 'attivita'] },
 { id: 'requirements', title: 'Competenze richieste', keys: ['requisiti', 'competenze richieste', 'profilo', 'ihr profil', 'your profile', 'qualifications', 'istruzione ed esperienza precedente', 'lingue'] },
 { id: 'benefits', title: 'Cosa offre l\'azienda', keys: ['cosa ti offriamo', 'wir bieten', 'offriamo', 'benefit', 'benefits', 'vantaggi'] },
 { id: 'application', title: 'Come candidarsi', keys: ['come candidarsi', 'candidatura', 'application process', 'apply'] },
 { id: 'contacts', title: 'Contatti', keys: ['contatto', 'contatti', 'kontakt', 'contact', 'informazioni aggiuntive', 'informazioni'] },
 { id: 'company', title: 'Azienda e contesto', keys: ['chi siamo', 'azienda', 'hospital', 'ospedale', 'organization', 'organizzazione'] },
 { id: 'details', title: 'Dettagli ulteriori', keys: ['dettagli', 'details', 'altro'] },
 { id: 'notes', title: 'Note e contenuto originale', keys: ['note', 'contenuto originale', 'testo originale', 'estratti originali', 'raw'] },
];

const FALLBACK_INLINE_HEADING_KEYS = [
 'le tue mansioni',
 'mansioni',
 'compiti',
 'responsabilita',
 'responsabilità',
 'attivita chiave',
 'attività chiave',
 'requisiti necessari',
 'requisiti auspicati',
 'requisiti',
 'competenze richieste',
 'profilo',
 'cosa porti con te',
 'ihre aufgaben',
 'ihr profil',
 'wir bieten',
 'cosa ti offriamo',
 'benefits',
 'come candidarsi',
 'candidatura',
 'contatti',
 'contatto',
 'lingue',
 'sede',
 'settori medici',
 'istruzione ed esperienza precedente',
 'manutenzione preventiva e aggiornamenti',
 'informazioni aggiuntive',
 'chi siamo',
 'about us',
];

const FALLBACK_INLINE_FIELD_KEYS = [
 'sede',
 'settori medici',
 'attivita chiave',
 'attività chiave',
 'assistenza sul campo e assistenza clienti',
 'manutenzione preventiva e aggiornamenti',
 'istruzione ed esperienza precedente',
 'lingue',
];

const FALLBACK_INLINE_FIELD_SPLIT_LABELS = [
 'Sede',
 'Settori medici',
 'Attività chiave',
 'Assistenza sul campo e assistenza clienti',
 'Manutenzione preventiva e aggiornamenti',
 'Istruzione ed esperienza precedente',
 'Lingue',
 'Tedesco',
 'Inglese',
 'Francese',
];

// Pre-compiled RegExps for description normalization (Vercel rule 7.10)
const INLINE_HEADING_REGEXPS = [...FALLBACK_INLINE_HEADING_KEYS]
 .sort((a, b) => b.length - a.length)
 .map((key) => {
 const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
 return new RegExp(`(^|[\\n\\.;:!?]\\s+|\\s{2,})(?=${escaped}\\b)`, 'gi');
 });

const INLINE_FIELD_LABEL_REGEXPS = [...FALLBACK_INLINE_FIELD_KEYS]
 .sort((a, b) => b.length - a.length)
 .map((key) => {
 const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
 return new RegExp(`\\s+(?=${escaped}(?:\\s*:|\\b))`, 'gi');
 });

const INLINE_FIELD_SPLIT_REGEXP = new RegExp(
 `\\s+(?=(?:${FALLBACK_INLINE_FIELD_SPLIT_LABELS.map((label) => label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})(?:\\s*:|\\b))`,
 'g',
);

const HEADING_PREFIX_REGEXP_CACHE = new Map<string, RegExp[]>();
function getHeadingPrefixRegexps(group: { id: string; keys: string[] }): RegExp[] {
 let cached = HEADING_PREFIX_REGEXP_CACHE.get(group.id);
 if (!cached) {
 cached = [...group.keys]
 .sort((a, b) => b.length - a.length)
 .map((key) => {
 const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
 return new RegExp(`^\\s*#*\\s*${escaped}\\s*[:\\-]?\\s*`, 'i');
 });
 HEADING_PREFIX_REGEXP_CACHE.set(group.id, cached);
 }
 return cached;
}

function fallbackSplitInlineFieldItems(text: string): string[] {
 const inlineFieldSplitRegex = INLINE_FIELD_SPLIT_REGEXP;
 const candidate = fallbackCleanSpaces(text);
 const parts = candidate
 .split(inlineFieldSplitRegex)
 .map((x) => fallbackCleanSpaces(x))
 .filter(Boolean);
 return parts.length >= 2 ? parts : [candidate];
}

const FALLBACK_SECTION_HINTS: Record<FallbackSectionId, string[]> = {
 overview: ['descrizione', 'panoramica', 'overview', 'ruolo', 'posizione', 'introduzione', 'profilo del ruolo'],
 responsibilities: ['mansioni', 'compiti', 'responsabilita', 'attivita', 'tasks', 'responsibilities', 'ihre aufgaben', 'impari', 'svolgi', 'contribuisci', 'prendi'],
 requirements: ['requisiti', 'requisiti necessari', 'requisiti auspicati', 'competenze', 'profilo', 'ihr profil', 'qualifiche', 'diploma', 'esperienza', 'conoscenza'],
 benefits: ['cosa ti offriamo', 'wir bieten', 'offriamo', 'benefit', 'vantaggi', 'vacanze', 'sconti', 'ambiente di lavoro', 'opportunita'],
 application: ['come candidarsi', 'candidatura', 'interessato', 'invia', 'application', 'apply', 'selezione', 'colloquio', 'entro e non oltre'],
 contacts: ['contatti', 'contatto', 'email', 'e-mail', 'telefono', 'tel', 'scrivere', 'chiama', '091', '+41', '0041'],
 company: ['chi siamo', 'azienda', 'ospedale', 'hospital', 'organizzazione', 'organization', 'collaboratori', 'contesto'],
 details: ['dettagli', 'details', 'ulteriori informazioni', 'note aggiuntive'],
 notes: ['contenuto originale', 'testo originale', 'estratti originali', 'appendice', 'raw'],
};

const FALLBACK_NOISE_BLOCK_PATTERNS = [
 /##\s*(Vedi dettagli|View details|See details)[\s\S]*$/i,
 /##\s*(Annunci correlati|Related jobs|Offres d'emploi similaires)[\s\S]*$/i,
 /##\s*(Mappa|Map|Carte)[\s\S]*$/i,
];

const FALLBACK_NOISE_LINE_PATTERNS = [
 /^powered by\b/i,
 /^var\s+careerjet_apply_data\b/i,
 /^\(function\s*\(d,\s*s,\s*id\)/i,
 /^postuler\b/i,
 /^connexion\b/i,
 /^share this job\b/i,
 /^condividi questo annuncio\b/i,
 /^tell a friend\b/i,
];

const FALLBACK_FRAGMENT_START_RE = /^(di|del|della|dello|dei|degli|delle|con|per|e|oppure|o|che|da|a|al|alla|alle|agli|sul|sulla|sulle|nel|nella|nelle|d')\b/i;

const FALLBACK_PASS3_ROUTE_RULES: Array<{ id: FallbackSectionId; re: RegExp }> = [
 { id: 'application', re: /\b(candidatur|inoltrat|invia|apply|application|entro le ore|scadenz|selezion)\b/i },
 { id: 'contacts', re: /\b(tel\.?|telefono|email|e-mail|contatt|ulteriori informazioni|responsabile)\b/i },
 { id: 'company', re: /\b(repubblica e cantone|ente|organizzazione|collaboratori|ospedale|strutture|chi siamo)\b/i },
 { id: 'requirements', re: /\b(requisit|diploma|titolo|esperienz|conoscenza|attitudine|profilo|ihr profil)\b/i },
 { id: 'benefits', re: /\b(cosa ti offriamo|wir bieten|offriamo|vacanze|sconti|benefit|ambiente di lavoro|opportunita)\b/i },
 { id: 'responsibilities', re: /\b(mansion|compit|responsabilit|attivit|consulenza|gestire|svolgere|ihre aufgaben)\b/i },
];

function fallbackDecodeHtml(input: string): string {
 return String(input || '')
 .replace(/&nbsp;/gi, ' ')
 .replace(/&raquo;|»/gi, ' ')
 .replace(/&amp;/gi, '&')
 .replace(/&quot;/gi, '"')
 .replace(/&#39;|&apos;/gi, '\'')
 .replace(/&lt;/gi, '<')
 .replace(/&gt;/gi, '>');
}

function fallbackDecodeLooseEntities(input: string): string {
 return String(input || '').replace(/&(sol|comma|ndash|newline|colo|times);/gi, (_m, ent) => {
 const map: Record<string, string> = {
 sol: '/',
 comma: ',',
 ndash: ' - ',
 newline: '\n',
 colo: ':',
 times: 'x',
 };
 return map[String(ent || '').toLowerCase()] || ' ';
 });
}

function fallbackCleanSpaces(value: string): string {
 return String(value || '').replace(/\s+/g, ' ').trim();
}

function fallbackNormalizeIdSource(value: string): string {
 return fallbackDecodeHtml(value || '')
 .toLowerCase()
 .normalize('NFD')
 .replace(/[̀-ͯ]/g, '')
 .replace(/[^a-z0-9 ]/g, ' ')
 .replace(/\s+/g, ' ')
 .trim();
}

// Pre-normalized FALLBACK_SECTION_HINTS — the per-call `fallbackScoreSectionHints`
// was running `fallbackNormalizeIdSource(hint)` on every hint of every section
// for every input text. With ~23k tuples × ~80 score-calls × ~10 hints/section
// = ~18M normalize ops/build (~100s CPU across the 4-worker pre-pass). Compute
// once at module load, reuse forever. Output unchanged; only the redundant
// per-call normalization is gone.
const FALLBACK_SECTION_HINTS_NORM: Record<FallbackSectionId, string[]> = (() => {
 const out = {} as Record<FallbackSectionId, string[]>;
 for (const key of Object.keys(FALLBACK_SECTION_HINTS) as FallbackSectionId[]) {
 out[key] = FALLBACK_SECTION_HINTS[key]
 .map((h) => fallbackNormalizeIdSource(h))
 .filter((t) => t.length > 0);
 }
 return out;
})();

function fallbackUniq(items: string[], max = 999): string[] {
 const out: string[] = [];
 const seen = new Set<string>();
 for (const raw of items) {
 const clean = fallbackCleanSpaces(raw);
 if (!clean) continue;
 const key = clean.toLowerCase();
 if (seen.has(key)) continue;
 seen.add(key);
 out.push(clean);
 if (out.length >= max) break;
 }
 return out;
}

function fallbackDetectHeading(value: string): FallbackSectionId | null {
 const source = fallbackNormalizeIdSource(value.replace(MARKDOWN_CHUNK_HEADING_RE, '').replace(/:$/, ''));
 for (const group of FALLBACK_HEADING_MAP) {
 for (const key of group.keys) {
 const normalized = fallbackNormalizeIdSource(key);
 if (!normalized) continue;
 if (source === normalized || source.startsWith(`${normalized} `) || source.startsWith(`${normalized}:`)) {
 return group.id;
 }
 }
 }
 return null;
}

function fallbackRemoveHeadingPrefix(line: string, sectionId: FallbackSectionId): string {
 const group = FALLBACK_HEADING_MAP.find((g) => g.id === sectionId);
 if (!group) return line;
 let out = line;
 for (const rx of getHeadingPrefixRegexps(group)) {
 out = out.replace(rx, '');
 }
 return out.replace(MARKDOWN_CHUNK_HEADING_RE, '').trim();
}

function fallbackSplitByInlineHeadings(text: string): string {
 let out = String(text || '');
 for (const rx of INLINE_HEADING_REGEXPS) {
 out = out.replace(rx, '$1\n');
 }
 return out;
}

function fallbackSplitByInlineFieldLabels(text: string): string {
 let out = String(text || '');
 for (const rx of INLINE_FIELD_LABEL_REGEXPS) {
 out = out.replace(rx, '\n');
 }
 return out;
}

function fallbackIsUiNoiseChunk(line: string): boolean {
 const raw = fallbackCleanSpaces(line);
 if (!raw) return true;
 if (FALLBACK_NOISE_LINE_PATTERNS.some((rx) => rx.test(raw))) return true;
 if (/(@context|careerjet|indeed-apply|apply_button|bootstrap\.js)/i.test(raw)) return true;
 if (/^https?:\/\/\S+$/.test(raw) && /(careerjetApply|indeed)/i.test(raw)) return true;
 if (/^##\s*(offres d'emploi similaires|annunci correlati|related jobs|mappa|map|carte)/i.test(raw)) return true;
 return false;
}

function fallbackNormalizeRaw(raw: string): string {
 let text = fallbackDecodeLooseEntities(fallbackDecodeHtml(raw || ''));
 text = text
 .replace(/&(?:amp;)?newline;?/gi, '\n')
 .replace(/\\n/g, '\n')
 .replace(/<br\s*\/?>/gi, '\n')
 .replace(/<\/(p|li|h1|h2|h3|h4|div)>/gi, '\n')
 .replace(/<[^>]+>/g, ' ')
 .replace(/&[a-z]{2,20};?/gi, ' ')
 .replace(/ /g, ' ')
 .replace(/\r/g, '\n')
 .replace(/[ \t]+/g, ' ')
 .replace(/([^#\n])\s*##+\s*/g, '$1\n## ')
 .replace(/(^|\n)\s*#\s+/g, '$1## ')
 .replace(/\s+[•·▪◦]\s+/g, '\n- ')
 .replace(/\s+-\s+(?=[A-ZÀ-ÖÙ-Ü])/g, '\n- ')
 .replace(/;\s+(?=[A-ZÀ-ÖÙ-Ü])/g, ';\n')
 .trim();
 for (const rx of FALLBACK_NOISE_BLOCK_PATTERNS) {
 text = text.replace(rx, '');
 }
 text = fallbackSplitByInlineHeadings(text);
 text = fallbackSplitByInlineFieldLabels(text);
 text = text.replace(/\n{3,}/g, '\n\n');
 return text;
}

function fallbackSplitAtomicChunks(normalized: string): string[] {
 const chunks: string[] = [];
 const lines = String(normalized || '').split(/\n+/);
 for (const rawLine of lines) {
 const line = fallbackCleanSpaces(rawLine);
 if (!line || fallbackIsUiNoiseChunk(line)) continue;
 // Safari <16.4 / many in-app browsers reject lookbehind ("invalid group
 // specifier name" SyntaxError → whole chunk fails to parse). Equivalent
 // lookbehind-free split: capture the boundary punctuation, drop the
 // following whitespace, and split on a NUL sentinel that never occurs in
 // job text. Lookahead (?=…) is universally supported, so it stays.
 const sentenceChunks = line.replace(/([.!?;])\s+(?=[A-ZÀ-ÖÙ-Ü])/g, '$1\u0000').split('\u0000');
 for (const piece of sentenceChunks) {
 const atom = fallbackCleanSpaces(piece);
 if (!atom || fallbackIsUiNoiseChunk(atom)) continue;
 // Detect enumeration lists: 3+ ' - ' separators → split even on lowercase items
 // (handles Italian infinitive lists from public-administration job postings)
 const inlineDashParts = atom.split(/ - (?=[a-zA-ZÀ-ÖÙ-Üà-öù-ü])/);
 if (inlineDashParts.length >= 3) {
 const cleanedParts = inlineDashParts.map((x) => fallbackCleanSpaces(x)).filter(Boolean);
 const longParts = cleanedParts.filter((x) => x.length > 8);
 if (longParts.length >= 3) {
 // Emit ALL parts (including short heading words like "Compiti")
 // so downstream heading detection can categorize the section.
 for (const part of cleanedParts) {
 if (!fallbackIsUiNoiseChunk(part)) chunks.push(part);
 }
 continue;
 }
 }
 const splitByBullets = atom
 .split(/\s*(?:^|\s)(?:-\s+|•\s+|▪\s+|\*\s+)(?=[A-Z0-9À-ÖÙ-Ü])/g)
 .map((x) => fallbackCleanSpaces(x))
 .filter(Boolean);
 const splitByInfinitives = (splitByBullets.length > 0 ? splitByBullets : [atom]).flatMap((value) => {
 const candidate = fallbackCleanSpaces(value);
 if (candidate.length < 160) return [candidate];
 const parts = candidate
 .split(/\s+(?=(?:[A-ZÀ-ÖÙ-Ü][a-zà-öù-ü]{4,}(?:are|ere|ire)\b))/g)
 .map((x) => fallbackCleanSpaces(x))
 .filter(Boolean);
 return parts.length >= 2 ? parts : [candidate];
 });
 const splitByFieldLabels = splitByInfinitives.flatMap((value) => {
 return fallbackSplitInlineFieldItems(value);
 });
 for (const item of splitByFieldLabels) {
 if (!item || fallbackIsUiNoiseChunk(item)) continue;
 chunks.push(item);
 }
 }
 }
 return chunks;
}

function fallbackExtractContacts(fullText: string): { emails: string[]; phones: string[] } {
 const source = fallbackDecodeHtml(fullText || '');
 const emails = fallbackUniq(source.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi) || [], 8);
 const phones = fallbackUniq(source.match(/(?:\+41|0041|0)\s?\d{2}\s?\d{3}\s?\d{2}\s?\d{2}/g) || [], 8);
 return { emails, phones };
}

function fallbackNormalizeRequirementLine(line: string): string {
 let out = fallbackCleanSpaces(line)
 .replace(/^['"`]+|['"`]+$/g, '')
 // Shared with the gate teaser (services/jobs/plainTextMarkdown.ts) so the
 // two surfaces cannot drift on what counts as a heading marker.
 .replace(MARKDOWN_CHUNK_HEADING_RE, '')
 .replace(/^[-–—•*]+\s*/, '')
 .replace(/^[\],.;:!?)\s]+/, '')
 .replace(/&(?:amp;)?newline;?/gi, ' ')
 .replace(/&[a-z]{2,20};?/gi, ' ');
 if (/^i\s*\(/i.test(out)) out = out.replace(/^i\s*/i, '');
 out = out.replace(/\s*\.\.\.\s*$/g, '');
 return out.replace(/\s+/g, ' ').trim();
}

function fallbackIsGarbageChunk(line: string): boolean {
 const base = fallbackCleanSpaces(String(line || '').replace(/^[-–—•*]+/, ''));
 const normalized = fallbackNormalizeIdSource(base);
 if (!normalized) return true;
 if (/^(chiave|chiavi|key|keys|none|n d|n a|nd|na|colo)$/.test(normalized)) return true;
 if (/^\?+$/.test(base) || /^(null|undefined|nan)$/i.test(base)) return true;
 if (/^\d{2}\/\d{2}\/\d{4}\s*-\s*\d{2}\/\d{2}\/\d{4}$/.test(base)) return true;
 if (fallbackIsUiNoiseChunk(base)) return true;
 return normalized.length <= 1;
}

function fallbackScoreSectionHints(text: string, sectionId: FallbackSectionId): number {
 const normalized = fallbackNormalizeIdSource(text);
 // Hints are pre-normalized at module load (FALLBACK_SECTION_HINTS_NORM),
 // skipping the ~10× fallbackNormalizeIdSource calls per section per text
 // that the prior form re-ran on every call.
 const tokens = FALLBACK_SECTION_HINTS_NORM[sectionId] || [];
 let score = 0;
 for (const token of tokens) {
 if (normalized.includes(token)) score += token.length >= 10 ? 2 : 1;
 }
 return score;
}

function fallbackGuessSectionByContent(text: string, fallback: FallbackSectionId = 'overview'): { id: FallbackSectionId; score: number } {
 const raw = String(text || '');
 if (!raw.trim()) return { id: fallback, score: 0 };
 if (/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i.test(raw) || /(?:\+41|0041|0)\s?\d{2}\s?\d{3}\s?\d{2}\s?\d{2}/.test(raw)) {
 return { id: 'contacts', score: 99 };
 }
 const direct = fallbackDetectHeading(raw);
 if (direct) return { id: direct, score: 90 };
 let best: { id: FallbackSectionId; score: number } = { id: fallback, score: 0 };
 for (const id of FALLBACK_SECTION_ORDER) {
 const score = fallbackScoreSectionHints(raw, id);
 if (score > best.score) best = { id, score };
 }
 return best;
}

function fallbackRepairSectionItems(items: string[], sectionId: FallbackSectionId, overflow: string[]): string[] {
 const out: string[] = [];
 for (const raw of items || []) {
 for (const splitRaw of fallbackSplitInlineFieldItems(raw)) {
 let item = fallbackNormalizeRequirementLine(splitRaw);
 if (!item) continue;
 if (fallbackIsGarbageChunk(item)) {
 overflow.push(item);
 continue;
 }
 if (/^di\s+/i.test(item) && out.length > 0) {
 const prev = out[out.length - 1];
 if (/(requisiti|criteri|condizioni|ordine|profilo|idoneita|eleggibilita)$/i.test(prev) || prev.length <= 45) {
 out[out.length - 1] = `${prev} ${item}`.replace(/\s+/g, ' ').trim();
 continue;
 }
 }
 if (item.length <= 14 && out.length > 0 && /^(requirements|application|details)$/.test(sectionId)) {
 const prev = out[out.length - 1];
 if (prev.length <= 120 && !/[.!?]$/.test(prev)) {
 out[out.length - 1] = `${prev} ${item}`.replace(/\s+/g, ' ').trim();
 continue;
 }
 }
 if (FALLBACK_FRAGMENT_START_RE.test(item) && out.length > 0 && item.length <= 72) {
 out[out.length - 1] = `${out[out.length - 1]} ${item}`.replace(/\s+/g, ' ').trim();
 continue;
 }
 if (/^[a-zà-öù-ü][^.!?]{1,90}$/i.test(item) && out.length > 0 && item.length <= 42) {
 out[out.length - 1] = `${out[out.length - 1]} ${item}`.replace(/\s+/g, ' ').trim();
 continue;
 }
 out.push(item);
 }
 }
 return fallbackUniq(out, 150);
}

function fallbackNormalizeRequirementSubheading(line: string): string {
 const item = fallbackCleanSpaces(String(line || ''));
 if (!item) return item;
 if (/^requisiti necessari\b/i.test(item)) return 'Requisiti necessari';
 if (/^requisiti auspicati\b/i.test(item)) return 'Requisiti auspicati';
 if (/^requisiti preferenziali\b/i.test(item)) return 'Requisiti preferenziali';
 if (/^required\b/i.test(item)) return 'Required';
 if (/^preferred\b/i.test(item)) return 'Preferred';
 return item;
}

function fallbackExplodeDenseItem(item: string, sectionId: FallbackSectionId): string[] {
 const clean = fallbackCleanSpaces(item);
 if (!clean || clean.length < 210) return [clean];
 const canExplode = /^(overview|details|company|requirements|responsibilities)$/.test(sectionId);
 if (!canExplode) return [clean];
 const bySemi = clean.split(/;\s+(?=[A-ZÀ-ÖÙ-Üa-zà-öù-ü])/g).map((x) => fallbackCleanSpaces(x)).filter(Boolean);
 if (bySemi.length >= 3) return bySemi;
 // Lookbehind-free split (Safari <16.4 compat) — see fallbackSplitAtomicChunks above.
 const bySent = clean.replace(/([.!?])\s+(?=[A-ZÀ-ÖÙ-Ü])/g, '$1\u0000').split('\u0000').map((x) => fallbackCleanSpaces(x)).filter(Boolean);
 if (bySent.length >= 3) return bySent;
 return [clean];
}

function fallbackRouteByPass3Rules(item: string, currentId: FallbackSectionId): FallbackSectionId {
 const line = String(item || '');
 const guessed = fallbackGuessSectionByContent(line, currentId);
 let best: { id: FallbackSectionId; score: number } = { id: currentId, score: guessed.id === currentId ? guessed.score : 0 };
 for (const rule of FALLBACK_PASS3_ROUTE_RULES) {
 if (rule.re.test(line)) {
 const base = 6 + fallbackScoreSectionHints(line, rule.id);
 if (base > best.score) best = { id: rule.id, score: base };
 }
 }
 if (guessed.id !== currentId && guessed.score >= 4 && guessed.score > best.score) best = guessed;
 return best.id;
}

function fallbackThirdPassAiStyle(sectionMap: Record<FallbackSectionId, string[]>, normalizedRaw: string): { sections: Record<FallbackSectionId, string[]>; moved: number; split: number; reconciled: number } {
 const out = {} as Record<FallbackSectionId, string[]>;
 for (const id of FALLBACK_SECTION_ORDER) out[id] = [];
 let moved = 0;
 let split = 0;

 for (const id of FALLBACK_SECTION_ORDER) {
 const sourceItems = sectionMap[id] || [];
 for (const raw of sourceItems) {
 const item = fallbackNormalizeRequirementSubheading(fallbackNormalizeRequirementLine(raw));
 if (!item || fallbackIsGarbageChunk(item)) continue;
 const exploded = fallbackExplodeDenseItem(item, id);
 if (exploded.length > 1) split += exploded.length - 1;
 for (const part of exploded) {
 let clean = fallbackNormalizeRequirementSubheading(fallbackNormalizeRequirementLine(part));
 if (!clean || fallbackIsGarbageChunk(clean)) continue;
 clean = clean
 .replace(/^#\s*/g, '')
 .replace(/^(?:compiti|mansioni principali)\s*:\s*/i, '')
 .replace(/^(?:come candidarsi|contatti)\s*:\s*/i, '');
 if (!clean) continue;
 const target = fallbackRouteByPass3Rules(clean, id);
 if (target !== id) moved += 1;
 out[target].push(clean);
 }
 }
 }

 const represented = new Set<string>();
 for (const id of FALLBACK_SECTION_ORDER) {
 for (const item of out[id]) {
 const key = fallbackNormalizeIdSource(item);
 if (key.length >= 14) represented.add(key);
 }
 }

 let reconciled = 0;
 const rawChunks = fallbackSplitAtomicChunks(normalizedRaw || '');
 for (const raw of rawChunks) {
 const clean = fallbackNormalizeRequirementSubheading(fallbackNormalizeRequirementLine(raw));
 if (!clean || fallbackIsGarbageChunk(clean)) continue;
 const key = fallbackNormalizeIdSource(clean);
 if (key.length < 18) continue;
 if (!represented.has(key)) {
 out.details.push(clean);
 represented.add(key);
 reconciled += 1;
 }
 }

 for (const id of FALLBACK_SECTION_ORDER) {
 out[id] = fallbackRepairSectionItems(out[id], id, out.details);
 if (id === 'requirements') out[id] = out[id].map(fallbackNormalizeRequirementSubheading);
 out[id] = fallbackUniq(out[id], 260);
 }
 return { sections: out, moved, split, reconciled };
}

function fallbackBuildResidualNotes(normalizedRaw: string, sectionMap: Record<FallbackSectionId, string[]>): string[] {
 const represented = new Set<string>();
 for (const id of FALLBACK_SECTION_ORDER) {
 if (id === 'notes') continue;
 for (const item of sectionMap[id] || []) {
 const key = fallbackNormalizeIdSource(item);
 if (key.length >= 10) represented.add(key);
 }
 }
 const leftovers: string[] = [];
 const rawChunks = fallbackSplitAtomicChunks(normalizedRaw || '');
 for (const raw of rawChunks) {
 const clean = fallbackNormalizeRequirementSubheading(fallbackNormalizeRequirementLine(raw));
 if (!clean || fallbackIsUiNoiseChunk(clean)) continue;
 const key = fallbackNormalizeIdSource(clean);
 if (key.length < 10) continue;
 if (!represented.has(key)) {
 leftovers.push(clean);
 represented.add(key);
 }
 }
 return fallbackUniq(leftovers, 400);
}

export function canonicalizeFallbackRaw(description: string, requirements: string[]): {
 sections: Record<FallbackSectionId, string[]>;
 metrics: { coverage: number };
} {
 const normalized = fallbackNormalizeRaw(description || '');
 const chunks = fallbackSplitAtomicChunks(normalized);
 const sections = {} as Record<FallbackSectionId, string[]>;
 for (const id of FALLBACK_SECTION_ORDER) sections[id] = [];
 const overflow: string[] = [];
 let current: FallbackSectionId = 'overview';
 const originalCount = chunks.length;
 let assignedCount = 0;

 for (const rawChunk of chunks) {
 let chunk = fallbackCleanSpaces(rawChunk);
 if (!chunk) continue;
 const headingIdFromChunk = fallbackDetectHeading(chunk);
 if (headingIdFromChunk) {
 current = headingIdFromChunk;
 const body = fallbackNormalizeRequirementLine(fallbackRemoveHeadingPrefix(chunk, headingIdFromChunk));
 if (body) {
 sections[current].push(body);
 assignedCount += 1;
 }
 continue;
 }
 if (/^[A-ZÀ-ÖÙ-Ü][^.!?]{2,65}:$/.test(chunk)) {
 const direct = fallbackDetectHeading(chunk.replace(/:$/, ''));
 if (direct) {
 current = direct;
 continue;
 }
 }
 chunk = fallbackNormalizeRequirementLine(chunk);
 if (!chunk) continue;
 if (fallbackIsGarbageChunk(chunk)) {
 overflow.push(chunk);
 continue;
 }
 const guessed = fallbackGuessSectionByContent(chunk, current);
 if (guessed.score >= 2) current = guessed.id;
 sections[current].push(chunk);
 assignedCount += 1;
 }

 const reqLines = requirements
 .map((x) => fallbackNormalizeRequirementLine(x))
 .filter(Boolean);
 sections.requirements = fallbackUniq([...sections.requirements, ...reqLines], 120);

 for (const id of FALLBACK_SECTION_ORDER) {
 sections[id] = fallbackRepairSectionItems(
 sections[id].map((x) => fallbackNormalizeRequirementLine(x)).filter(Boolean),
 id,
 overflow
 );
 }

 const movedMap = {} as Record<FallbackSectionId, string[]>;
 for (const id of FALLBACK_SECTION_ORDER) movedMap[id] = [];
 for (const id of FALLBACK_SECTION_ORDER) {
 for (const item of sections[id]) {
 const guessed = fallbackGuessSectionByContent(item, id);
 const moveThreshold = guessed.id === 'contacts' ? 6 : 3;
 if (guessed.id !== id && guessed.score >= moveThreshold) movedMap[guessed.id].push(item);
 else movedMap[id].push(item);
 }
 }
 for (const id of FALLBACK_SECTION_ORDER) sections[id] = fallbackUniq(movedMap[id], 200);

 const cleanedOverflow = fallbackUniq(
 overflow.map((x) => fallbackNormalizeRequirementLine(x)).filter((x) => x && !fallbackIsGarbageChunk(x)),
 80
 );
 if (cleanedOverflow.length > 0) {
 sections.details = fallbackUniq([...sections.details, ...cleanedOverflow], 200);
 }

 const pass3 = fallbackThirdPassAiStyle(sections, normalized);
 for (const id of FALLBACK_SECTION_ORDER) sections[id] = fallbackUniq(pass3.sections[id] || [], 260);

 const contacts = fallbackExtractContacts(`${normalized}\n${requirements.join('\n')}`);
 if (contacts.phones.length > 0) {
 for (const phone of contacts.phones) {
 if (!sections.contacts.some((x) => x.includes(phone))) sections.contacts.push(`Telefono: ${phone}`);
 }
 }
 if (contacts.emails.length > 0) {
 for (const email of contacts.emails) {
 if (!sections.contacts.some((x) => x.includes(email))) sections.contacts.push(`Email: ${email}`);
 }
 }

 const residualNotes = fallbackBuildResidualNotes(normalized, sections);
 if (residualNotes.length > 0) {
 sections.notes = fallbackUniq([...(sections.notes || []), ...residualNotes], 400);
 }

 const coverage = originalCount > 0 ? Math.min(100, Math.round((assignedCount / originalCount) * 100)) : 100;
 return { sections, metrics: { coverage } };
}

export function localizedExtraSectionHeading(id: FallbackSectionId, locale: Locale): string {
 const map: Record<'it' | 'en' | 'de' | 'fr', Partial<Record<FallbackSectionId, string>>> = {
 it: {
 contacts: 'Contatti',
 company: 'Azienda e contesto',
 details: 'Dettagli ulteriori',
 notes: 'Note e contenuto originale',
 },
 en: {
 contacts: 'Contacts',
 company: 'Company and context',
 details: 'Additional details',
 notes: 'Notes and original content',
 },
 de: {
 contacts: 'Kontakte',
 company: 'Unternehmen und Kontext',
 details: 'Weitere Details',
 notes: 'Notizen und Originalinhalt',
 },
 fr: {
 contacts: 'Contacts',
 company: 'Entreprise et contexte',
 details: 'Détails supplémentaires',
 notes: 'Notes et contenu original',
 },
 };
 const key = (locale in map ? locale : 'it') as 'it' | 'en' | 'de' | 'fr';
 return map[key][id] || FALLBACK_HEADING_MAP.find((h) => h.id === id)?.title || 'Dettagli';
}

/**
 * Locale-invariant slice of the fallback build: the expensive parse +
 * cleanCanonicalItems chain. The output carries everything needed to
 * assemble a `CanonicalLocaleContent` for any locale, minus the localized
 * section headings (which are cheap and applied by
 * `localizeFallbackCanonical`).
 *
 * Why split: profiling showed `ph:canonical-fallback` dominated the
 * per-page render at 22.7 ms × ~23k pages ≈ 528 s wall on the sequential
 * closeBundle. The previous memoization key included `locale`, which
 * made the cache miss whenever the SAME `(description, requirements)`
 * pair was processed under different locales — exactly the duplicate
 * work this split removes. Now the heavy 90-95% of `buildFallback...`
 * can be cached per `(description, requirements)` and the 4 per-locale
 * iterations share the result.
 */
export type CleanedFallbackContent = {
  parsed: ReturnType<typeof canonicalizeFallbackRaw>;
  summary: string[];
  responsibilities: string[];
  mergedRequirements: string[];
  benefits: string[];
  process: string[];
  contactsItems: string[];
  companyItems: string[];
  detailsItems: string[];
  notesItems: string[];
  highlights: string[];
};

export function canonicalizeFallbackCleaned(description: string, requirements: string[]): CleanedFallbackContent {
  const parsed = canonicalizeFallbackRaw(description, requirements);
  const summary = cleanCanonicalItems(parsed.sections.overview, 3);
  const responsibilities = cleanCanonicalItems(parsed.sections.responsibilities, 12);
  const parsedRequirements = cleanCanonicalItems(parsed.sections.requirements, 12);
  const mergedRequirements = parsedRequirements.length > 0
    ? parsedRequirements
    : cleanCanonicalItems(requirements, 12);
  const benefits = cleanCanonicalItems(parsed.sections.benefits, 10);
  const process = cleanCanonicalItems(parsed.sections.application, 8);
  const contactsItems = cleanCanonicalItems(parsed.sections.contacts, 12);
  const companyItems = cleanCanonicalItems(parsed.sections.company, 12);
  const detailsItems = cleanCanonicalItems(parsed.sections.details, 12);
  const notesItems = cleanCanonicalItems(parsed.sections.notes, 24);
  const highlights = cleanCanonicalItems([
    ...summary.slice(0, 2),
    ...responsibilities.slice(0, 2),
    ...mergedRequirements.slice(0, 2),
    ...benefits.slice(0, 2),
  ], 8);
  return {
    parsed,
    summary,
    responsibilities,
    mergedRequirements,
    benefits,
    process,
    contactsItems,
    companyItems,
    detailsItems,
    notesItems,
    highlights,
  };
}

/**
 * Locale-specific tail of the fallback build. Cheap — translates the
 * extra section headings and computes `readingMinutes` from the
 * locale-specific `description` length. Safe to call repeatedly for the
 * same `cleaned` value across locales.
 */
export function localizeFallbackCanonical(
  cleaned: CleanedFallbackContent,
  description: string,
  locale: Locale,
): CanonicalLocaleContent {
  const sections: CanonicalLocaleContent['sections'] = [];
  const extras: Array<{ id: FallbackSectionId; items: string[] }> = [
    { id: 'contacts', items: cleaned.contactsItems },
    { id: 'company', items: cleaned.companyItems },
    { id: 'details', items: cleaned.detailsItems },
    { id: 'notes', items: cleaned.notesItems },
  ];
  for (const { id, items } of extras) {
    if (items.length === 0) continue;
    sections.push({
      id,
      heading: localizedExtraSectionHeading(id, locale),
      paragraphs: [],
      bullets: items,
    });
  }
  const compact = String(description || '').replace(/\s+/g, ' ').trim();
  const wordCount = compact ? compact.split(/\s+/).length : 0;
  return {
    summary: cleaned.summary,
    sections,
    responsibilities: cleaned.responsibilities,
    requirements: cleaned.mergedRequirements,
    benefits: cleaned.benefits,
    process: cleaned.process,
    highlights: cleaned.highlights,
    keywords: [],
    readingMinutes: Math.max(1, Math.round(Math.max(1, wordCount) / 180)),
  };
}

export function buildFallbackCanonicalContent(description: string, requirements: string[], locale: Locale): CanonicalLocaleContent {
  // Wrapper kept for backward compatibility — SPA runtime (JobBoard.tsx)
  // still calls this single-shot API. The SSG plugin uses the split form
  // (canonicalizeFallbackCleaned + localizeFallbackCanonical) so the heavy
  // half can be cached across locales.
  const cleaned = canonicalizeFallbackCleaned(description, requirements);
  return localizeFallbackCanonical(cleaned, description, locale);
}
