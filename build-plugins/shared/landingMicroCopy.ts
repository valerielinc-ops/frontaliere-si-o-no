/**
 * Curated micro-copy for SEO landings: empty-states + "see all jobs" CTAs.
 * Deterministic per-(id × locale) selection via hash so the same page
 * always renders the same string (no build-to-build flicker), but
 * different landings get variety.
 */

export type MicroCopyLocale = 'it' | 'en' | 'de' | 'fr';

export const EMPTY_FEATURED_JOBS: Record<MicroCopyLocale, ReadonlyArray<string>> = {
  it: [
    'Per ora nessuna offerta: torna lunedì, le aziende caricano dopo il weekend.',
    'Categoria silenziosa oggi. Iscriviti alla newsletter per essere il primo a saperlo.',
    'Zero annunci freschi qui — ma il tuo CV potrebbe già fare la differenza.',
    'Niente da mostrare ora. I crawler passano due volte al giorno, ripassa più tardi.',
  ],
  en: [
    "No openings right now — come back Monday, employers post after the weekend.",
    'Quiet category today. Subscribe to the newsletter to hear it first.',
    "Zero fresh listings here — your CV could still be the right answer.",
    'Nothing to show now. Our crawlers run twice a day, check back later.',
  ],
  de: [
    'Aktuell keine Stellen — Montag schauen die Firmen meist neue Angebote rein.',
    'Heute ruhige Kategorie. Newsletter abonnieren und als Erster erfahren.',
    'Keine frischen Anzeigen — dein CV könnte trotzdem die Antwort sein.',
    'Gerade nichts. Unsere Crawler laufen zweimal täglich, später wiederkommen.',
  ],
  fr: [
    "Aucune offre pour l'instant — repassez lundi, les entreprises publient après le weekend.",
    "Catégorie calme aujourd'hui. Inscrivez-vous à la newsletter pour être averti.",
    'Zéro annonce fraîche ici — votre CV peut quand même faire mouche.',
    'Rien à montrer maintenant. Les crawlers passent deux fois par jour.',
  ],
};

export const CTA_ALL_JOBS: Record<MicroCopyLocale, ReadonlyArray<(n: number) => string>> = {
  it: [
    (n) => `Vedi tutti i ${n} annunci →`,
    (n) => `Sfoglia i ${n} posti aperti →`,
    (n) => `Apri tutte le ${n} offerte →`,
  ],
  en: [
    (n) => `See all ${n} listings →`,
    (n) => `Browse ${n} openings →`,
    (n) => `Open all ${n} jobs →`,
  ],
  de: [
    (n) => `Alle ${n} Anzeigen anzeigen →`,
    (n) => `${n} offene Stellen durchstöbern →`,
    (n) => `Alle ${n} Jobs öffnen →`,
  ],
  fr: [
    (n) => `Voir les ${n} annonces →`,
    (n) => `Parcourir ${n} postes ouverts →`,
    (n) => `Ouvrir les ${n} offres →`,
  ],
};

function hash(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return h;
}

export function pickEmptyState(id: string, locale: MicroCopyLocale): string {
  const pool = EMPTY_FEATURED_JOBS[locale];
  return pool[hash(`${id}|${locale}`) % pool.length];
}

export function pickCtaAllJobs(id: string, locale: MicroCopyLocale, count: number): string {
  const pool = CTA_ALL_JOBS[locale];
  const tpl = pool[hash(`${id}|${locale}|cta`) % pool.length];
  return tpl(count);
}
