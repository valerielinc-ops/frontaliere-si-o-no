import { tokenize, splitRoleRegion } from '../scripts/lib/query-tokenizer.mjs';
import { stemSearchToken } from './searchStem.mjs';
import { isSalaryModifier } from './jobSearchIntent';
import { professionSynonymText } from './professionSynonyms';

interface JobOccupationFields {
  title?: string;
  titleByLocale?: Partial<Record<string, string>>;
  company?: string;
}

export function normalizeJobSearchTokens(s: string | undefined | null): string[] {
  if (!s) return [];
  return String(s)
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9\s-]/g, ' ')
    .split(/[\s-]+/)
    .filter((t) => t.length >= 2);
}

const GENERIC_ROLE_STEMS = new Set<string>([
  ...['offerte', 'offres', 'emploi', 'emplois', 'assunzioni', 'assunzione', 'vacancies', 'openings', 'hiring', 'employment', 'careers', 'recherche', 'stellenangebote', 'stellenangebot', 'offene', 'lavoro', 'lavori', 'lavorare'].map(stemSearchToken),
  'lavor', 'lavorar', 'lav', 'job', 'jobs', 'offert', 'offerta', 'offr', 'offre',
  'emplo', 'employ', 'travail', 'travaill', 'cerc', 'cerco', 'cercas', 'ricerc',
  'ricerch', 'trovar', 'trov', 'post', 'posizion', 'apert', 'assumon', 'assunzion',
  'aziend', 'annunc', 'concors', 'vacant', 'recrutement', 'recrut', 'search', 'find',
  'near', 'nah', 'vicin', 'stellen', 'stellenangebot', 'stelleninserat', 'arbeit',
  // recency / filler qualifiers from queries like "…da ieri", "3 derniers jours"
  'noi', 'ier', 'hier', 'ultim', 'giorn', 'settiman', 'tutt', 'letzten', 'tagen',
  'dernier', 'jour', 'press', 'ent',
  // Salary intent is answered by the page, not an occupational title.
  'stipendi', 'stipend', 'salari', 'salary', 'salar', 'gehalt', 'lohn', 'salaire',
]);

/** Search modifiers do not describe an occupation. */
export function occupationalRoleTokens(tokens: readonly string[]): string[] {
  return tokens.filter((token) => !GENERIC_ROLE_STEMS.has(token) && !isSalaryModifier(token));
}

export function matchesJobOccupation(job: JobOccupationFields, locale: string, roles: readonly string[]): boolean {
  if (roles.length === 0) return true;
  return matchesPreparedJobOccupation(prepareJobOccupationTerms(job, locale), roles);
}

/** Build-scoped callers can reuse these terms while the job snapshot is immutable. */
export function prepareJobOccupationTerms(job: JobOccupationFields, locale: string): readonly string[] {
  const localizedTitle = job.titleByLocale?.[locale] || job.title;
  const titles = [...normalizeJobSearchTokens(job.title), ...normalizeJobSearchTokens(localizedTitle), ...normalizeJobSearchTokens(job.company), ...normalizeJobSearchTokens(professionSynonymText(localizedTitle))];
  return [...titles, ...titles.map(stemSearchToken)];
}

export function matchesPreparedJobOccupation(terms: readonly string[], roles: readonly string[]): boolean {
  return roles.every((role) => tokenMatchesStem(terms, role));
}

/** Exact short acronyms; bounded prefix tolerance for occupational words. */
export function tokenMatchesStem(tokens: Iterable<string>, stem: string): boolean {
  if (stem.length < 2) return false;
  if (stem.length === 2) return [...tokens].includes(stem);
  for (const tok of tokens) {
    const prefixLength = Math.max(3, stem.length - 1);
    if (tok.startsWith(stem) || (tok.length >= prefixLength && stem.startsWith(tok.slice(0, prefixLength)))) return true;
  }
  return false;
}

export function getJobSearchRoleTokens(query: string): string[] {
  return occupationalRoleTokens(splitRoleRegion(tokenize(query)).role.map(stemSearchToken));
}
