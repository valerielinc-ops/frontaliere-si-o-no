/** Shared by raw queries and stemmed tokens (salaire → salair, salaries → salarie). */
export function hasSalaryIntent(query: string): boolean {
  return query.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .split(/[^a-z]+/).some(isSalaryModifier);
}

/** A profession such as Lohnbuchhalter is not itself a salary modifier. */
export function isSalaryModifier(token: string): boolean {
  return /^(?:stipend(?:io|i)?|salar(?:y|ies|ie|i|io|ios)?|salair(?:e|es)?|gehalt(?:er|s)?|lohn(?:e|en|s)?|wage(?:s)?|pay)$/.test(token);
}

/** The router strips salary boilerplate; retain route intent only for its current query. */
export function hasActiveSalarySearchIntent(query: string, routeQuery?: string | null, routeSlug?: string | null): boolean {
  return hasSalaryIntent(query) || Boolean(routeQuery && query.trim() === routeQuery.trim() && hasSalaryIntent(routeSlug || ''));
}
