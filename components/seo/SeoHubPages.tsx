/**
 * SEO Hub-page React shells (Phase 2-UI)
 *
 * These are intentionally lightweight SPA fallbacks: the canonical content
 * for each hub is the static HTML emitted by `build-plugins/seoHubsPlugin.ts`
 * during build. The router marks every hub URL `staticOverlay: true`, so on
 * normal page-load the static body stays visible and React only hydrates the
 * header/footer chrome. These components exist for two edge cases:
 *
 *  1. The user soft-navigates back to a hub via in-SPA history.
 *  2. A future build run is missing the static file (defensive fallback).
 *
 * Each component renders a minimal shell — title, breadcrumb, and a "see all"
 * link to the static page. The richer paginated index lives in the static HTML.
 */

import React from 'react';

interface HubShellProps {
  title: string;
  description: string;
  ctaLabel: string;
  ctaHref: string;
}

function HubShell({ title, description, ctaLabel, ctaHref }: HubShellProps) {
  return (
    <main className="max-w-3xl mx-auto px-4 py-12">
      <h1 className="text-3xl font-bold text-strong mb-4">{title}</h1>
      <p className="text-body mb-6">{description}</p>
      <a
        href={ctaHref}
        className="inline-flex items-center gap-2 rounded-lg bg-accent text-white px-4 py-2 font-medium no-underline"
      >
        {ctaLabel} →
      </a>
    </main>
  );
}

interface JobsHubPageProps {
  locale: 'it' | 'en' | 'de' | 'fr';
}

export function JobsHubPage({ locale }: JobsHubPageProps) {
  const copy = {
    it: { t: 'Tutti gli annunci di lavoro disponibili', d: 'Indice completo di tutte le offerte di lavoro indicizzate per i frontalieri in Ticino.', c: 'Vedi tutti gli annunci' },
    en: { t: 'All cross-border job listings', d: 'Complete index of every indexed job posting for cross-border workers in Ticino.', c: 'See all listings' },
    de: { t: 'Alle Stellenangebote', d: 'Vollständiger Index aller indizierten Stellenangebote für Grenzgänger im Tessin.', c: 'Alle Angebote ansehen' },
    fr: { t: 'Toutes les offres d’emploi', d: 'Index complet de toutes les offres d’emploi indexées pour frontaliers au Tessin.', c: 'Voir toutes les offres' },
  }[locale];
  return <HubShell title={copy.t} description={copy.d} ctaLabel={copy.c} ctaHref="#static-content" />;
}

export function SectorsHubPage({ locale }: JobsHubPageProps) {
  const copy = {
    it: { t: 'Tutti i settori professionali', d: 'Esplora le offerte di lavoro per settore: sanitario, ingegneria, banca, ristorazione e altri.', c: 'Esplora i settori' },
    en: { t: 'All professional sectors', d: 'Explore jobs by sector: healthcare, engineering, banking, hospitality and more.', c: 'Explore sectors' },
    de: { t: 'Alle Branchen', d: 'Stellenangebote nach Branche: Gesundheit, Ingenieurwesen, Bank, Gastronomie und mehr.', c: 'Branchen erkunden' },
    fr: { t: 'Tous les secteurs', d: 'Offres d’emploi par secteur : santé, ingénierie, banque, restauration et plus.', c: 'Explorer les secteurs' },
  }[locale];
  return <HubShell title={copy.t} description={copy.d} ctaLabel={copy.c} ctaHref="#static-content" />;
}

export function CompaniesHubPage({ locale }: JobsHubPageProps) {
  const copy = {
    it: { t: 'Tutte le aziende che assumono', d: 'Indice alfabetico delle aziende che assumono in Ticino, con offerte attive per locale e settore.', c: 'Vedi tutte le aziende' },
    en: { t: 'All hiring companies', d: 'Alphabetical index of companies hiring in Ticino, with active openings per location and sector.', c: 'See all companies' },
    de: { t: 'Alle einstellenden Firmen', d: 'Alphabetisches Verzeichnis der Firmen, die im Tessin einstellen.', c: 'Alle Firmen ansehen' },
    fr: { t: 'Toutes les entreprises qui recrutent', d: 'Index alphabétique des entreprises qui recrutent au Tessin.', c: 'Voir toutes les entreprises' },
  }[locale];
  return <HubShell title={copy.t} description={copy.d} ctaLabel={copy.c} ctaHref="#static-content" />;
}

export function ArticlesHubPage({ locale }: JobsHubPageProps) {
  const copy = {
    it: { t: 'Tutti gli articoli per frontalieri', d: 'Archivio completo di guide, analisi fiscali e aggiornamenti dedicati ai lavoratori frontalieri.', c: 'Sfoglia tutti gli articoli' },
    en: { t: 'All cross-border worker articles', d: 'Full archive of guides, tax analysis and updates for cross-border workers.', c: 'Browse all articles' },
    de: { t: 'Alle Grenzgänger-Artikel', d: 'Vollständiges Archiv von Leitfäden, Steueranalysen und Updates für Grenzgänger.', c: 'Alle Artikel durchstöbern' },
    fr: { t: 'Tous les articles pour frontaliers', d: 'Archive complète de guides, analyses fiscales et actualités pour les frontaliers.', c: 'Parcourir tous les articles' },
  }[locale];
  return <HubShell title={copy.t} description={copy.d} ctaLabel={copy.c} ctaHref="#static-content" />;
}

export default { JobsHubPage, SectorsHubPage, CompaniesHubPage, ArticlesHubPage };
