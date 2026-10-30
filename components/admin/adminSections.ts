/**
 * Single source of truth for the owner-admin sections.
 *
 * This module deliberately has no React dependency: the router and the build
 * plugin both consume it to keep URL validation and static shells aligned.
 */

export type AdminSectionGroup = 'oggi' | 'lavoro' | 'aziende' | 'redazione' | 'sistema';

export interface AdminSection {
  slug: string;
  label: string;
  group: AdminSectionGroup;
  description: string;
  planned?: boolean;
}

export const ADMIN_SECTIONS: readonly AdminSection[] = [
  {
    slug: '',
    label: 'Oggi',
    group: 'oggi',
    description: 'Riepilogo operativo del pannello admin.',
  },
  {
    slug: 'crawler',
    label: 'Crawler',
    group: 'lavoro',
    description: 'Stato, qualità e risultati dei crawler offerte di lavoro.',
  },
  {
    slug: 'automazioni',
    label: 'Automazioni',
    group: 'lavoro',
    description: 'Workflow per contenuti, SEO, qualità e dati.',
  },
  {
    slug: 'configurazione-crawler',
    label: 'Configurazione crawler',
    group: 'lavoro',
    description: 'Configurazione delle fonti e generazione dei parser crawler.',
  },
  {
    slug: 'aziende',
    label: 'Aziende',
    group: 'aziende',
    description: 'Insights di traffico e contatti delle aziende.',
  },
  {
    slug: 'candidature',
    label: 'Candidature assistite',
    group: 'aziende',
    description: 'Coda operativa delle candidature assistite.',
  },
  {
    slug: 'servizio-candidature',
    label: 'Servizio candidature · 30 giorni',
    group: 'aziende',
    description: 'Utenti, pagamenti e proposte del servizio di 30 giorni.',
  },
  {
    slug: 'redazione',
    label: 'Redazione',
    group: 'redazione',
    description: 'Profili editoriali e cataloghi degli articoli.',
  },
  {
    slug: 'giornalisti',
    label: 'Giornalisti',
    group: 'redazione',
    description: 'Accessi e ruoli della dashboard redazionale.',
  },
  {
    slug: 'newsletter',
    label: 'Newsletter',
    group: 'redazione',
    description: 'Statistiche, anteprima e invio test della newsletter.',
  },
  {
    slug: 'salute',
    label: 'Salute',
    group: 'sistema',
    description: 'Controlli di salute e diagnostica del sito.',
  },
  {
    slug: 'flag',
    label: 'Flag',
    group: 'sistema',
    description: 'Valori Remote Config non segreti e flag sperimentali.',
  },
  {
    slug: 'registro',
    label: 'Registro',
    group: 'sistema',
    description: 'Registro delle mutazioni eseguite dal pannello admin.',
  },
];

/** Live section slugs used by the router and the noindex static-shell plugin. */
export const ADMIN_SECTION_SLUGS = ADMIN_SECTIONS
  .filter((section) => !section.planned)
  .map((section) => section.slug) as readonly string[];

export const ADMIN_SECTION_GROUPS: readonly AdminSectionGroup[] = [
  'oggi',
  'lavoro',
  'aziende',
  'redazione',
  'sistema',
];

export function isAdminSectionSlug(value: unknown): value is string {
  return typeof value === 'string' && ADMIN_SECTION_SLUGS.includes(value);
}

export function getAdminSection(slug: string | undefined): AdminSection {
  return ADMIN_SECTIONS.find((section) => section.slug === slug && !section.planned)
    || ADMIN_SECTIONS[0];
}

export function getVisibleAdminSections(): readonly AdminSection[] {
  return ADMIN_SECTIONS.filter((section) => !section.planned);
}
