import { tokenize, splitRoleRegion } from '../scripts/lib/query-tokenizer.mjs';
import { stemSearchToken } from './searchStem.mjs';
import { isSalaryModifier } from './jobSearchIntent';
import { professionSynonymText } from './professionSynonyms';
import {
  matchProfession,
  matchProfessionTitle,
  normalizeText as normalizeProfessionText,
  taxonomyEntry,
} from '../scripts/lib/profession-taxonomy.mjs';

export interface JobOccupationFields {
  title?: string;
  titleByLocale?: Partial<Record<string, string>>;
  description?: string;
  descriptionByLocale?: Partial<Record<string, string>>;
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

/**
 * Structured intent for a related-search query.
 *
 * A job-search phrase is not a bag of equally strict words. The occupation
 * and its domain (for example "medico" + "anestesista") identify the core
 * role; words such as "responsabile" describe the level or remit of that
 * role. Keeping those dimensions separate lets the matcher accept a German
 * title containing `Führungsverantwortung` for an Italian query containing
 * `responsabile`, without accepting every ad whose description happens to
 * mention responsibility.
 */
export interface JobSearchRoleProfile {
  readonly professionId: string | null;
  readonly roleTokens: readonly string[];
  readonly professionTokens: readonly string[];
  readonly professionalTokens: readonly string[];
  readonly specialtyTokens: readonly string[];
  readonly qualifierTokens: readonly string[];
  readonly qualifierFamilies: readonly string[];
}

export type JobSearchMatchTier = 'none' | 'core' | 'semantic' | 'exact';

export interface JobSearchOccupationEvidence {
  readonly tier: JobSearchMatchTier;
  readonly professionId: string | null;
  readonly coreMatched: boolean;
  readonly titleQualifierMatched: boolean;
  readonly contextualQualifierMatched: boolean;
}

/**
 * Specialty families are intentionally small and explicit. Unknown terms
 * remain professional core tokens and must occur in the title; they are not
 * guessed to be qualifiers. The first family is the one needed by the
 * reported page and covers the spelling families used by IT/DE/FR/EN job
 * titles (anestesia, anesthesiologie, Anästhesie, anesthesia).
 */
const SPECIALTY_FAMILIES: Readonly<Record<string, readonly string[]>> = {
  anesthesiology: ['anestes', 'anesthes', 'anastesi', 'anastesiolog', 'anasthesi', 'anasthesiolog', 'anesthet'],
};

/**
 * Leadership/responsibility qualifiers. These are query concepts, not a
 * generic list of words that may be searched in an ad body. `chef`/`chief`,
 * `head`, `senior` and `manager` are deliberately absent: in job titles they
 * also denote ordinary professions or seniority and would overmatch.
 */
const QUALIFIER_FAMILIES: Readonly<Record<string, readonly string[]>> = {
  leadership: [
    'responsabil', 'responsable', 'responsibl', 'responsibility',
    'verantwort', 'fuehrungsverantwort', 'fuhrungsverantwort',
    'leitend', 'leadership', 'leader', 'direktor', 'directeur', 'direttor',
    'chefarzt',
  ],
};

const CONTEXT_RELATION_TOKENS = new Set([
  'team', 'teams', 'equipe', 'equipes', 'staff', 'personale', 'personnel',
  'repart', 'reparto', 'servizi', 'service', 'department', 'departement',
  'unita', 'unit', 'leitung', 'direzion', 'direktor', 'direction',
  'gest', 'coordin', 'supervision', 'supervis', 'management', 'leadership',
  'progett', 'funzion', 'compit', 'attivit', 'svilupp', 'organizz',
  'mitarbeit', 'collaborator', 'collaboratrice', 'collaboratore',
  'formation', 'formazione', 'encadrement', 'cadre',
]);

const STRONG_QUALIFIER_PREFIXES = [
  'fuehrungsverantwort', 'fuhrungsverantwort', 'leitend', 'leadership',
  'leader', 'direktor', 'directeur', 'direttor', 'chefarzt',
];

/** Titles that identify support roles rather than the physician itself. */
const SUPPORT_TITLE_PATTERNS = [
  /sekretar/i,
  /secretar/i,
  /segretar/i,
  /secretaire/i,
  /\bpraxisassistent/i,
  /\bmedizinische[rn]?\s+praxisassistent/i,
  /\bmedical\s+practice\s+assistant/i,
  /\bassistante?\s+medicale/i,
  /\bassistente\s+di\s+studio\s+medico/i,
  /\bmpa\b/i,
  /\b(?:anesthesia|anaesthesia|anesthesie|anaesthesie|anestesia)\s+(?:nurse|pflege|soignant|assistant)/i,
  /\b(?:nurse|pflegefach|infirmier|inferm)\s+(?:anesthesia|anaesthesia|anesthes|anestes)/i,
  /\b(?:student|studente|studierenden|studierend|etudiant|etudiante)\b/i,
];

const jobSearchTitleEvidenceCache = new WeakMap<object, Map<string, PreparedJobSearchTitleEvidence>>();
const jobSearchDescriptionEvidenceCache = new WeakMap<object, Map<string, PreparedJobSearchDescriptionEvidence>>();

interface PreparedJobSearchTitleEvidence {
  readonly titles: readonly string[];
  readonly titleTokens: readonly string[];
  readonly professionIds: ReadonlySet<string>;
  readonly supportTitle: boolean;
  readonly titleQualifierFamilies: ReadonlySet<string>;
  readonly titleSpecialtyFamilies: ReadonlySet<string>;
}

interface PreparedJobSearchDescriptionEvidence {
  readonly descriptions: readonly string[];
  readonly descriptionTokens: readonly string[];
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values.filter(Boolean))];
}

function normalizedStemTokens(value: string | undefined | null): string[] {
  return unique(normalizeJobSearchTokens(value).map(stemSearchToken));
}

function hasFamilyPrefix(token: string, prefixes: readonly string[]): boolean {
  return prefixes.some((prefix) => token === prefix || token.startsWith(prefix));
}

function familyForToken(token: string, families: Readonly<Record<string, readonly string[]>>): string | null {
  for (const [family, prefixes] of Object.entries(families)) {
    if (hasFamilyPrefix(token, prefixes)) return family;
  }
  return null;
}

function specialtyFamilyForToken(token: string): string | null {
  return familyForToken(token, SPECIALTY_FAMILIES);
}

function qualifierFamilyForToken(token: string): string | null {
  return familyForToken(token, QUALIFIER_FAMILIES);
}

function titleStrings(job: JobOccupationFields, locale: string): string[] {
  return unique([
    String(job.title || ''),
    String(job.titleByLocale?.[locale] || ''),
  ].map((title) => title.trim()));
}

function descriptionStrings(job: JobOccupationFields, locale: string): string[] {
  return unique([
    String(job.description || ''),
    String(job.descriptionByLocale?.[locale] || ''),
  ].map((description) => description.trim()));
}

function isSupportTitle(titles: readonly string[]): boolean {
  return titles.some((title) => {
    const normalized = normalizeProfessionText(title);
    return SUPPORT_TITLE_PATTERNS.some((pattern) => pattern.test(normalized));
  });
}

function hasMedicoTitleSurface(tokens: readonly string[]): boolean {
  // The taxonomy intentionally keeps aliases token-bounded. Swiss titles
  // such as Chefärztin/Chefarzt are compounds, so they need this narrow
  // physician-only bridge; the support-title guard above excludes
  // Chefarztsekretärin and similar false positives.
  return tokens.some((token) => (
    token.startsWith('chefarzt')
    || token.startsWith('anesthesist')
    || token.startsWith('anaesthesist')
  ));
}

function prepareJobSearchTitleEvidence(job: JobOccupationFields, locale: string): PreparedJobSearchTitleEvidence {
  const objectJob = job as object;
  let byLocale = jobSearchTitleEvidenceCache.get(objectJob);
  if (!byLocale) {
    byLocale = new Map<string, PreparedJobSearchTitleEvidence>();
    jobSearchTitleEvidenceCache.set(objectJob, byLocale);
  }
  const cached = byLocale.get(locale);
  if (cached) return cached;

  const titles = titleStrings(job, locale);
  const titleTokens = unique(titles.flatMap(normalizedStemTokens));
  const professionIds = new Set<string>();
  for (const title of titles) {
    const id = matchProfessionTitle(title);
    if (id) professionIds.add(id);
  }
  if (hasMedicoTitleSurface(titleTokens)) professionIds.add('medico');

  const titleQualifierFamilies = new Set<string>();
  const titleSpecialtyFamilies = new Set<string>();
  for (const token of titleTokens) {
    const qualifierFamily = qualifierFamilyForToken(token);
    if (qualifierFamily) titleQualifierFamilies.add(qualifierFamily);
    const specialtyFamily = specialtyFamilyForToken(token);
    if (specialtyFamily) titleSpecialtyFamilies.add(specialtyFamily);
  }

  const prepared: PreparedJobSearchTitleEvidence = {
    titles,
    titleTokens,
    professionIds,
    supportTitle: isSupportTitle(titles),
    titleQualifierFamilies,
    titleSpecialtyFamilies,
  };
  byLocale.set(locale, prepared);
  return prepared;
}

function prepareJobSearchDescriptionEvidence(job: JobOccupationFields, locale: string): PreparedJobSearchDescriptionEvidence {
  const objectJob = job as object;
  let byLocale = jobSearchDescriptionEvidenceCache.get(objectJob);
  if (!byLocale) {
    byLocale = new Map<string, PreparedJobSearchDescriptionEvidence>();
    jobSearchDescriptionEvidenceCache.set(objectJob, byLocale);
  }
  const cached = byLocale.get(locale);
  if (cached) return cached;

  const descriptions = descriptionStrings(job, locale);
  const prepared: PreparedJobSearchDescriptionEvidence = {
    descriptions,
    descriptionTokens: unique(descriptions.flatMap(normalizedStemTokens)),
  };
  byLocale.set(locale, prepared);
  return prepared;
}

function professionPhraseTokens(queryTokens: readonly string[], professionId: string | null): ReadonlySet<string> {
  if (!professionId) return new Set();
  const aliases = taxonomyEntry(professionId)?.aliases || [];
  const matching = aliases
    // Use the same stop-word removal as the query side: otherwise the alias
    // "responsable de magasin" could not match a query whose tokenizer
    // correctly removed "de", and `responsable` would be misclassified as a
    // leadership qualifier.
    .map((alias) => unique(tokenize(alias).map(stemSearchToken)))
    .filter((aliasTokens) => aliasTokens.length > 0 && aliasTokens.every((aliasToken) => (
      queryTokens.some((queryToken) => tokenMatchesStem([queryToken], aliasToken))
    )))
    .sort((a, b) => b.length - a.length);
  return new Set(matching[0] || []);
}

/**
 * Classify a query without treating every adjective as a qualifier.
 * Taxonomy phrases win first: "responsabile negozio" remains one profession
 * phrase and its `responsabile` token is not reinterpreted as leadership.
 * Unknown non-boilerplate words stay in the professional core (fail closed).
 */
export function getJobSearchRoleProfile(query: string): JobSearchRoleProfile {
  const roleTokens = occupationalRoleTokens(splitRoleRegion(tokenize(query)).role.map(stemSearchToken));
  const professionId = matchProfession(query);
  const phraseTokens = professionPhraseTokens(roleTokens, professionId);
  const qualifierByFamily = new Map<string, string[]>();

  for (const token of roleTokens) {
    if (phraseTokens.has(token)) continue;
    const family = qualifierFamilyForToken(token);
    if (!family) continue;
    const values = qualifierByFamily.get(family) || [];
    values.push(token);
    qualifierByFamily.set(family, values);
  }

  const qualifierTokens = unique([...qualifierByFamily.values()].flat());
  const qualifierFamilies = unique([...qualifierByFamily.keys()]);
  const candidateProfessionalTokens = roleTokens.filter((token) => !qualifierTokens.includes(token));
  // A qualifier has meaning only with a professional anchor. A bare search
  // for "responsabile" must remain a normal core search instead of producing
  // an empty probe and zero results.
  const hasProfessionalAnchor = candidateProfessionalTokens.length > 0;
  const effectiveQualifierTokens = hasProfessionalAnchor ? qualifierTokens : [];
  const effectiveQualifierFamilies = hasProfessionalAnchor ? qualifierFamilies : [];
  const professionalTokens = hasProfessionalAnchor ? candidateProfessionalTokens : roleTokens;
  const specialtyTokens = professionalTokens.filter((token) => Boolean(specialtyFamilyForToken(token)));

  return {
    professionId,
    roleTokens,
    professionTokens: [...phraseTokens],
    professionalTokens,
    specialtyTokens,
    qualifierTokens: effectiveQualifierTokens,
    qualifierFamilies: effectiveQualifierFamilies,
  };
}

function matchesSpecialtyToken(token: string, evidence: PreparedJobSearchTitleEvidence): boolean {
  const family = specialtyFamilyForToken(token);
  if (family) return evidence.titleSpecialtyFamilies.has(family);
  return tokenMatchesStem(evidence.titleTokens, token);
}

function matchesProfessionalCore(profile: JobSearchRoleProfile, evidence: PreparedJobSearchTitleEvidence): boolean {
  // Support markers are negative evidence only when the query asks for the
  // physician profession. A nurse/anesthesia support title is a legitimate
  // answer to an explicitly nursing query, while the same title must not
  // satisfy a physician query. The support professions themselves remain
  // searchable through their taxonomy ids.
  if (evidence.supportTitle && profile.professionId === 'medico') return false;
  if (profile.professionId) {
    if (!evidence.professionIds.has(profile.professionId)) return false;
  }
  for (const token of profile.professionalTokens) {
    if (profile.specialtyTokens.includes(token)) {
      if (!matchesSpecialtyToken(token, evidence)) return false;
    } else if (profile.professionTokens.includes(token)) {
      // The taxonomy id is the proof for the profession phrase. Cross-locale
      // aliases are intentionally not required literally in the title
      // ("nurse" ↔ "Infermiera", "medico" ↔ "Facharzt").
      continue;
    } else if (!tokenMatchesStem(evidence.titleTokens, token)) {
      // Every non-taxonomy, non-specialty word remains hard title evidence.
      return false;
    }
  }
  return profile.professionalTokens.length > 0;
}

function isGenericCareResponsibility(text: string): boolean {
  const normalized = normalizeProfessionText(text);
  return /responsabil\w*\s+(?:dell?\s+|de\s+|des\s+|for\s+|fur\s+)?(?:assistenz|cura|pazient|patient\s+care|soin)/.test(normalized);
}

function hasStrongQualifierSurface(tokens: readonly string[]): boolean {
  return tokens.some((token) => hasFamilyPrefix(token, STRONG_QUALIFIER_PREFIXES));
}

function qualifierInContext(tokens: readonly string[], family: string): boolean {
  const qualifierIndexes = tokens
    .map((token, index) => qualifierFamilyForToken(token) === family ? index : -1)
    .filter((index) => index >= 0);
  if (qualifierIndexes.length === 0) return false;
  return qualifierIndexes.some((index) => tokens
    .slice(Math.max(0, index - 8), index + 9)
    .some((token) => CONTEXT_RELATION_TOKENS.has(token) || [...CONTEXT_RELATION_TOKENS].some((prefix) => token.startsWith(prefix))));
}

function matchesTitleQualifier(profile: JobSearchRoleProfile, evidence: PreparedJobSearchTitleEvidence): boolean {
  if (!profile.qualifierFamilies.every((family) => evidence.titleQualifierFamilies.has(family))) return false;
  // A bare "responsabile dell'assistenza" is a description of care, not
  // evidence of managerial responsibility. Explicit leadership wording (or a
  // leadership relation in the title) remains valid.
  if (evidence.titles.some(isGenericCareResponsibility)
    && !hasStrongQualifierSurface(evidence.titleTokens)
    && !evidence.titleTokens.some((token) => CONTEXT_RELATION_TOKENS.has(token))) return false;
  return true;
}

function matchesContextualQualifier(profile: JobSearchRoleProfile, evidence: PreparedJobSearchDescriptionEvidence): boolean {
  if (evidence.descriptions.some(isGenericCareResponsibility)
    && !hasStrongQualifierSurface(evidence.descriptionTokens)) {
    // Do not let the common phrase "responsabile dell'assistenza" alone
    // promote a page. The same description can still qualify if it contains a
    // separate leadership relation close to the qualifier.
    const hasContext = profile.qualifierFamilies.every((family) => qualifierInContext(evidence.descriptionTokens, family));
    if (!hasContext) return false;
  }
  return profile.qualifierFamilies.every((family) => qualifierInContext(evidence.descriptionTokens, family));
}

/**
 * Evidence-ranked occupation matcher used by qualifier-bearing clusters.
 * `exact` is title evidence; `semantic` is title-confirmed core plus a
 * contextual leadership statement in the description. Core-only matches are
 * intentionally returned separately so the indexability gate never counts
 * them as answers to a qualified query.
 */
export function classifyJobSearchOccupation(
  job: JobOccupationFields,
  locale: string,
  profile: JobSearchRoleProfile,
): JobSearchOccupationEvidence {
  const titleEvidence = prepareJobSearchTitleEvidence(job, locale);
  const coreMatched = matchesProfessionalCore(profile, titleEvidence);
  if (!coreMatched) {
    return {
      tier: 'none',
      professionId: titleEvidence.professionIds.values().next().value || null,
      coreMatched: false,
      titleQualifierMatched: false,
      contextualQualifierMatched: false,
    };
  }

  if (profile.qualifierFamilies.length === 0) {
    return {
      tier: 'core',
      professionId: titleEvidence.professionIds.values().next().value || null,
      coreMatched: true,
      titleQualifierMatched: false,
      contextualQualifierMatched: false,
    };
  }

  const titleQualifierMatched = matchesTitleQualifier(profile, titleEvidence);
  const contextualQualifierMatched = !titleQualifierMatched
    && matchesContextualQualifier(profile, prepareJobSearchDescriptionEvidence(job, locale));
  return {
    tier: titleQualifierMatched ? 'exact' : contextualQualifierMatched ? 'semantic' : 'core',
    professionId: titleEvidence.professionIds.values().next().value || null,
    coreMatched: true,
    titleQualifierMatched,
    contextualQualifierMatched,
  };
}

export function matchesJobSearchRoleProfile(
  job: JobOccupationFields,
  locale: string,
  profile: JobSearchRoleProfile,
  options: { readonly allowSemantic?: boolean } = {},
): boolean {
  if (options.allowSemantic !== true) {
    // Strict matches are used for indexability floors. They depend only on
    // title evidence, so avoid tokenizing and retaining full descriptions.
    const titleEvidence = prepareJobSearchTitleEvidence(job, locale);
    if (!matchesProfessionalCore(profile, titleEvidence)) return false;
    return profile.qualifierFamilies.length === 0 || matchesTitleQualifier(profile, titleEvidence);
  }

  const tier = classifyJobSearchOccupation(job, locale, profile).tier;
  if (tier === 'none') return false;
  if (!profile.qualifierFamilies.length) return true;
  return tier === 'exact' || tier === 'semantic';
}
