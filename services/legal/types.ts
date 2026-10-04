import { SLUG_TABLES } from '../routeSlugs.data';
import { COMMUNICATIONS_PAGE_PATH } from '../communicationChannels';

export type LegalLocale = 'it' | 'en' | 'de' | 'fr';
/** HTML is trusted editorial copy, never user input. Keep interactive controls out of it. */
export type LegalBlock = { html: string } | { kind: 'ads-controls' };
export type LegalSection = { title: string; id?: string; blocks: LegalBlock[] };
export type LegalDocument = {
  title: string;
  description: string;
  updated: string;
  introHtml: string;
  sections: LegalSection[];
};

export function legalLinks(locale: LegalLocale) {
  const prefix = locale === 'it' ? '' : `/${locale}`;
  const slugs = SLUG_TABLES[locale];
  const page = (slug: string) => `${prefix}/${slug}/`;
  return {
    home: `${prefix}/`, privacy: page(slugs.privacy), terms: page(slugs.terms),
    dataDeletion: page(slugs.dataDeletion), profile: page(slugs.profile),
    contact: page(slugs.contact), communications: COMMUNICATIONS_PAGE_PATH[locale],
  };
}

export const LEGAL_HOME_LABEL: Record<LegalLocale, string> = {
  it: 'Torna alla Home', en: 'Back to home', de: 'Zur Startseite', fr: "Retour à l’accueil",
};
export const LEGAL_CONSENT_STATIC_LABEL: Record<LegalLocale, string> = {
  it: 'Puoi modificare il consenso pubblicitario usando i controlli interattivi in questa pagina.',
  en: 'You can change advertising consent using the interactive controls on this page.',
  de: 'Sie können Ihre Werbe-Einwilligung über die interaktiven Einstellungen auf dieser Seite ändern.',
  fr: 'Vous pouvez modifier votre consentement publicitaire avec les commandes interactives de cette page.',
};
export const LEGAL_BODY_CLASS = 'space-y-3 text-subtle leading-relaxed [&_a]:text-accent [&_a]:underline [&_strong]:text-strong [&_ul]:list-disc [&_ul]:pl-6 [&_ol]:list-decimal [&_ol]:pl-6 [&_li]:mb-1 [&_h3]:font-semibold [&_h3]:text-strong [&_h3]:mt-4 [&_h3]:mb-2 [&_p]:mb-3';
