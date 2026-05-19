/**
 * Per-landing hero personality: emoji + eyebrow + tagline.
 * Used by profession/career/nursing/costOfLiving landing plugins.
 *
 * Tagline budget: ≤120 chars across all locales (enforced by vitest).
 * Emoji palette: curated, universal-coverage emoji (🎓🚑🍳⚙️👶📊🏗️💼🩺🏠🚛🍽️🔌).
 */

import { escHtml } from './htmlEscape';

export type HeroLocale = 'it' | 'en' | 'de' | 'fr';

export interface HeroVars {
  openings: number;
  medianSalary?: number;
  city?: string;
}

export interface LandingHeroBadge {
  emoji: string;
  eyebrowLabel: Record<HeroLocale, string>;
  taglineTemplate: Record<HeroLocale, (v: HeroVars) => string>;
}

function chf(n?: number): string {
  return n ? `~CHF ${Math.round(n / 1000)}k` : '';
}

function withSalary(prefix: string, v: HeroVars, locale: HeroLocale): string {
  if (!v.medianSalary) return `${prefix}.`;
  const salaryWord: Record<HeroLocale, string> = {
    it: 'mediana',
    en: 'median',
    de: 'Median',
    fr: 'médian',
  };
  return `${prefix}, ${chf(v.medianSalary)} ${salaryWord[locale]}.`;
}

export const HERO_BADGES: Record<string, LandingHeroBadge> = {
  infermiere: {
    emoji: '🩺',
    eyebrowLabel: {
      it: 'Professione · Infermiere in Ticino',
      en: 'Profession · Nurse in Ticino',
      de: 'Beruf · Krankenpfleger im Tessin',
      fr: 'Métier · Infirmier au Tessin',
    },
    taglineTemplate: {
      it: (v) => withSalary(`Case anziani, ospedali, cliniche: ${v.openings} posti aperti`, v, 'it'),
      en: (v) => withSalary(`Care homes, hospitals, clinics: ${v.openings} open`, v, 'en'),
      de: (v) => withSalary(`Pflegeheime, Spitäler, Kliniken: ${v.openings} offen`, v, 'de'),
      fr: (v) => withSalary(`EMS, hôpitaux, cliniques: ${v.openings} postes`, v, 'fr'),
    },
  },
  operaio: {
    emoji: '⚙️',
    eyebrowLabel: {
      it: 'Professione · Operaio in Ticino',
      en: 'Profession · Worker in Ticino',
      de: 'Beruf · Arbeiter im Tessin',
      fr: 'Métier · Ouvrier au Tessin',
    },
    taglineTemplate: {
      it: (v) => withSalary(`Industria, manifattura, cantieri: ${v.openings} posti aperti`, v, 'it'),
      en: (v) => withSalary(`Industry, manufacturing, sites: ${v.openings} open`, v, 'en'),
      de: (v) => withSalary(`Industrie, Fertigung, Baustellen: ${v.openings} offen`, v, 'de'),
      fr: (v) => withSalary(`Industrie, fabrication, chantiers: ${v.openings} postes`, v, 'fr'),
    },
  },
  impiegato: {
    emoji: '💼',
    eyebrowLabel: {
      it: 'Professione · Impiegato in Ticino',
      en: 'Profession · Office clerk in Ticino',
      de: 'Beruf · Angestellter im Tessin',
      fr: 'Métier · Employé au Tessin',
    },
    taglineTemplate: {
      it: (v) => withSalary(`Uffici, amministrazione, banche: ${v.openings} posti aperti`, v, 'it'),
      en: (v) => withSalary(`Offices, admin, banks: ${v.openings} open`, v, 'en'),
      de: (v) => withSalary(`Büros, Verwaltung, Banken: ${v.openings} offen`, v, 'de'),
      fr: (v) => withSalary(`Bureaux, admin, banques: ${v.openings} postes`, v, 'fr'),
    },
  },
  ingegnere: {
    emoji: '📐',
    eyebrowLabel: {
      it: 'Professione · Ingegnere in Ticino',
      en: 'Profession · Engineer in Ticino',
      de: 'Beruf · Ingenieur im Tessin',
      fr: 'Métier · Ingénieur au Tessin',
    },
    taglineTemplate: {
      it: (v) => withSalary(`Software, civile, meccanica: ${v.openings} posti aperti`, v, 'it'),
      en: (v) => withSalary(`Software, civil, mechanical: ${v.openings} open`, v, 'en'),
      de: (v) => withSalary(`Software, Bau, Maschinen: ${v.openings} offen`, v, 'de'),
      fr: (v) => withSalary(`Logiciel, civil, mécanique: ${v.openings} postes`, v, 'fr'),
    },
  },
  educatore: {
    emoji: '🎓',
    eyebrowLabel: {
      it: 'Professione · Educatore in Ticino',
      en: 'Profession · Educator in Ticino',
      de: 'Beruf · Erzieher im Tessin',
      fr: 'Métier · Éducateur au Tessin',
    },
    taglineTemplate: {
      it: (v) => withSalary(`Lavoro con bambini e ragazzi: ${v.openings} posti aperti`, v, 'it'),
      en: (v) => withSalary(`Working with kids & teens: ${v.openings} open`, v, 'en'),
      de: (v) => withSalary(`Mit Kindern & Jugendlichen: ${v.openings} offen`, v, 'de'),
      fr: (v) => withSalary(`Avec enfants & ados: ${v.openings} postes`, v, 'fr'),
    },
  },
  autista: {
    emoji: '🚛',
    eyebrowLabel: {
      it: 'Professione · Autista in Ticino',
      en: 'Profession · Driver in Ticino',
      de: 'Beruf · Fahrer im Tessin',
      fr: 'Métier · Chauffeur au Tessin',
    },
    taglineTemplate: {
      it: (v) => withSalary(`Camion, bus, consegne: ${v.openings} posti aperti`, v, 'it'),
      en: (v) => withSalary(`Trucks, buses, delivery: ${v.openings} open`, v, 'en'),
      de: (v) => withSalary(`LKW, Bus, Lieferung: ${v.openings} offen`, v, 'de'),
      fr: (v) => withSalary(`Camions, bus, livraison: ${v.openings} postes`, v, 'fr'),
    },
  },
  muratore: {
    emoji: '🏗️',
    eyebrowLabel: {
      it: 'Professione · Muratore in Ticino',
      en: 'Profession · Mason in Ticino',
      de: 'Beruf · Maurer im Tessin',
      fr: 'Métier · Maçon au Tessin',
    },
    taglineTemplate: {
      it: (v) => withSalary(`Cantieri, edilizia, restauro: ${v.openings} posti aperti`, v, 'it'),
      en: (v) => withSalary(`Construction sites, building: ${v.openings} open`, v, 'en'),
      de: (v) => withSalary(`Baustellen, Bauwesen: ${v.openings} offen`, v, 'de'),
      fr: (v) => withSalary(`Chantiers, bâtiment: ${v.openings} postes`, v, 'fr'),
    },
  },
  cuoco: {
    emoji: '🍳',
    eyebrowLabel: {
      it: 'Professione · Cuoco in Ticino',
      en: 'Profession · Cook in Ticino',
      de: 'Beruf · Koch im Tessin',
      fr: 'Métier · Cuisinier au Tessin',
    },
    taglineTemplate: {
      it: (v) => withSalary(`Ristoranti, hotel, mense: ${v.openings} posti aperti`, v, 'it'),
      en: (v) => withSalary(`Restaurants, hotels, canteens: ${v.openings} open`, v, 'en'),
      de: (v) => withSalary(`Restaurants, Hotels, Mensen: ${v.openings} offen`, v, 'de'),
      fr: (v) => withSalary(`Restos, hôtels, cantines: ${v.openings} postes`, v, 'fr'),
    },
  },
  cameriere: {
    emoji: '🍽️',
    eyebrowLabel: {
      it: 'Professione · Cameriere in Ticino',
      en: 'Profession · Waiter in Ticino',
      de: 'Beruf · Kellner im Tessin',
      fr: 'Métier · Serveur au Tessin',
    },
    taglineTemplate: {
      it: (v) => withSalary(`Sala, bar, banchetti: ${v.openings} posti aperti`, v, 'it'),
      en: (v) => withSalary(`Dining, bar, banquets: ${v.openings} open`, v, 'en'),
      de: (v) => withSalary(`Saal, Bar, Bankette: ${v.openings} offen`, v, 'de'),
      fr: (v) => withSalary(`Salle, bar, banquets: ${v.openings} postes`, v, 'fr'),
    },
  },
  elettricista: {
    emoji: '🔌',
    eyebrowLabel: {
      it: 'Professione · Elettricista in Ticino',
      en: 'Profession · Electrician in Ticino',
      de: 'Beruf · Elektriker im Tessin',
      fr: 'Métier · Électricien au Tessin',
    },
    taglineTemplate: {
      it: (v) => withSalary(`Impianti, manutenzione, cantieri: ${v.openings} posti aperti`, v, 'it'),
      en: (v) => withSalary(`Wiring, maintenance, sites: ${v.openings} open`, v, 'en'),
      de: (v) => withSalary(`Anlagen, Wartung, Baustellen: ${v.openings} offen`, v, 'de'),
      fr: (v) => withSalary(`Installations, sites: ${v.openings} postes`, v, 'fr'),
    },
  },
};

export function renderLandingHero(
  id: string,
  locale: HeroLocale,
  vars: HeroVars,
  title: string,
  fallbackTagline?: string,
): string {
  const badge = HERO_BADGES[id];
  const eyebrow = badge
    ? `<p class="text-sm font-semibold text-accent flex items-center gap-1.5"><span aria-hidden="true">${badge.emoji}</span>${escHtml(badge.eyebrowLabel[locale])}</p>`
    : '';
  const tagline = badge
    ? badge.taglineTemplate[locale](vars)
    : (fallbackTagline ?? '');
  const taglineHtml = tagline
    ? `<p class="text-base text-body mt-2 max-w-prose">${escHtml(tagline)}</p>`
    : '';
  return `<header>${eyebrow}<h1 class="text-2xl sm:text-3xl font-display font-bold text-heading mt-2">${escHtml(title)}</h1>${taglineHtml}</header>`;
}

