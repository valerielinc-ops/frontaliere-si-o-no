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

  // ── Career landings ────────────────────────────────────────────────
  'agenzie-lavoro-lugano': {
    emoji: '🏢',
    eyebrowLabel: {
      it: 'Agenzie di lavoro · Lugano',
      en: 'Recruitment agencies · Lugano',
      de: 'Personalvermittler · Lugano',
      fr: 'Agences de placement · Lugano',
    },
    taglineTemplate: {
      it: (v) => withSalary(`Agenzie attive a Lugano: ${v.openings} posti rapidi`, v, 'it'),
      en: (v) => withSalary(`Active agencies in Lugano: ${v.openings} fast openings`, v, 'en'),
      de: (v) => withSalary(`Aktive Agenturen in Lugano: ${v.openings} schnelle Stellen`, v, 'de'),
      fr: (v) => withSalary(`Agences actives à Lugano: ${v.openings} postes rapides`, v, 'fr'),
    },
  },
  'concorsi-pubblici-lugano': {
    emoji: '🏛️',
    eyebrowLabel: {
      it: 'Concorsi pubblici · Lugano',
      en: 'Public competitions · Lugano',
      de: 'Öffentliche Stellen · Lugano',
      fr: 'Concours publics · Lugano',
    },
    taglineTemplate: {
      it: (v) => withSalary(`OSC, EOC e città: ${v.openings} concorsi aperti`, v, 'it'),
      en: (v) => withSalary(`OSC, EOC, city hall: ${v.openings} competitions`, v, 'en'),
      de: (v) => withSalary(`OSC, EOC, Stadt: ${v.openings} öffentliche Stellen`, v, 'de'),
      fr: (v) => withSalary(`OSC, EOC, ville: ${v.openings} concours ouverts`, v, 'fr'),
    },
  },
  'stage-lugano': {
    emoji: '📚',
    eyebrowLabel: {
      it: 'Stage e tirocini · Lugano',
      en: 'Internships · Lugano',
      de: 'Praktika · Lugano',
      fr: 'Stages · Lugano',
    },
    taglineTemplate: {
      it: (v) => withSalary(`Tirocini retribuiti e curricolari: ${v.openings} aperti`, v, 'it'),
      en: (v) => withSalary(`Paid & curricular internships: ${v.openings} open`, v, 'en'),
      de: (v) => withSalary(`Bezahlte & Pflichtpraktika: ${v.openings} offen`, v, 'de'),
      fr: (v) => withSalary(`Stages rémunérés et obligatoires: ${v.openings} ouverts`, v, 'fr'),
    },
  },
  'contratti-lavoro-frontalieri': {
    emoji: '📄',
    eyebrowLabel: {
      it: 'Contratti frontalieri · CCL e accordo fiscale',
      en: 'Cross-border contracts · CCL & tax deal',
      de: 'Grenzgänger-Verträge · GAV & Steuer',
      fr: 'Contrats frontaliers · CCT & fiscal',
    },
    taglineTemplate: {
      it: (v) => withSalary(`CCL, permesso G, fisco: ${v.openings} offerte conformi`, v, 'it'),
      en: (v) => withSalary(`CCL, G permit, tax: ${v.openings} compliant offers`, v, 'en'),
      de: (v) => withSalary(`GAV, G-Bewilligung, Steuer: ${v.openings} Angebote`, v, 'de'),
      fr: (v) => withSalary(`CCT, permis G, fiscal: ${v.openings} offres conformes`, v, 'fr'),
    },
  },

  // ── Nursing landings ───────────────────────────────────────────────
  nurses: {
    emoji: '🩺',
    eyebrowLabel: {
      it: 'Infermieri · Svizzera',
      en: 'Nurses · Switzerland',
      de: 'Pflege · Schweiz',
      fr: 'Infirmiers · Suisse',
    },
    taglineTemplate: {
      it: (v) => withSalary(`Ospedali, cliniche, case anziani: ${v.openings} posti`, v, 'it'),
      en: (v) => withSalary(`Hospitals, clinics, care homes: ${v.openings} open`, v, 'en'),
      de: (v) => withSalary(`Spitäler, Kliniken, Pflegeheime: ${v.openings} offen`, v, 'de'),
      fr: (v) => withSalary(`Hôpitaux, cliniques, EMS: ${v.openings} postes`, v, 'fr'),
    },
  },
  oss: {
    emoji: '🤝',
    eyebrowLabel: {
      it: 'OSS · Operatore socio-sanitario',
      en: 'Healthcare assistants · Switzerland',
      de: 'Pflegehelfer · Schweiz',
      fr: 'Aides-soignants · Suisse',
    },
    taglineTemplate: {
      it: (v) => withSalary(`Assistenza, cura, supporto: ${v.openings} posti aperti`, v, 'it'),
      en: (v) => withSalary(`Care, support, assistance: ${v.openings} open`, v, 'en'),
      de: (v) => withSalary(`Pflege, Unterstützung: ${v.openings} offen`, v, 'de'),
      fr: (v) => withSalary(`Soins, aide, accompagnement: ${v.openings} postes`, v, 'fr'),
    },
  },
  'healthcare-ticino': {
    emoji: '🏥',
    eyebrowLabel: {
      it: 'Sanità · Ticino',
      en: 'Healthcare · Ticino',
      de: 'Gesundheit · Tessin',
      fr: 'Santé · Tessin',
    },
    taglineTemplate: {
      it: (v) => withSalary(`Tutta la sanità ticinese: ${v.openings} posti aperti`, v, 'it'),
      en: (v) => withSalary(`All Ticino healthcare: ${v.openings} open`, v, 'en'),
      de: (v) => withSalary(`Tessiner Gesundheitswesen: ${v.openings} offen`, v, 'de'),
      fr: (v) => withSalary(`Toute la santé tessinoise: ${v.openings} postes`, v, 'fr'),
    },
  },

  // ── CostOfLiving cities ────────────────────────────────────────────
  lugano: {
    emoji: '🏙️',
    eyebrowLabel: {
      it: 'Costo della vita · Lugano',
      en: 'Cost of living · Lugano',
      de: 'Lebenshaltung · Lugano',
      fr: 'Coût de la vie · Lugano',
    },
    taglineTemplate: {
      it: (v) => withSalary(`Affitti, spesa, netto: ${v.openings} lavori a Lugano`, v, 'it'),
      en: (v) => withSalary(`Rent, food, net pay: ${v.openings} Lugano jobs`, v, 'en'),
      de: (v) => withSalary(`Miete, Einkauf, Netto: ${v.openings} Jobs Lugano`, v, 'de'),
      fr: (v) => withSalary(`Loyer, courses, net: ${v.openings} emplois Lugano`, v, 'fr'),
    },
  },
  mendrisio: {
    emoji: '🏙️',
    eyebrowLabel: {
      it: 'Costo della vita · Mendrisio',
      en: 'Cost of living · Mendrisio',
      de: 'Lebenshaltung · Mendrisio',
      fr: 'Coût de la vie · Mendrisio',
    },
    taglineTemplate: {
      it: (v) => withSalary(`Mendrisiotto: affitti più bassi, ${v.openings} lavori`, v, 'it'),
      en: (v) => withSalary(`Mendrisio: lower rents, ${v.openings} jobs`, v, 'en'),
      de: (v) => withSalary(`Mendrisio: tiefe Mieten, ${v.openings} Jobs`, v, 'de'),
      fr: (v) => withSalary(`Mendrisio: loyers bas, ${v.openings} emplois`, v, 'fr'),
    },
  },
  chiasso: {
    emoji: '🏙️',
    eyebrowLabel: {
      it: 'Costo della vita · Chiasso',
      en: 'Cost of living · Chiasso',
      de: 'Lebenshaltung · Chiasso',
      fr: 'Coût de la vie · Chiasso',
    },
    taglineTemplate: {
      it: (v) => withSalary(`Chiasso al confine: ${v.openings} lavori vicino casa`, v, 'it'),
      en: (v) => withSalary(`Chiasso border city: ${v.openings} jobs near home`, v, 'en'),
      de: (v) => withSalary(`Chiasso Grenze: ${v.openings} Jobs nahe`, v, 'de'),
      fr: (v) => withSalary(`Chiasso frontière: ${v.openings} emplois proches`, v, 'fr'),
    },
  },
  bellinzona: {
    emoji: '🏙️',
    eyebrowLabel: {
      it: 'Costo della vita · Bellinzona',
      en: 'Cost of living · Bellinzona',
      de: 'Lebenshaltung · Bellinzona',
      fr: 'Coût de la vie · Bellinzona',
    },
    taglineTemplate: {
      it: (v) => withSalary(`Capitale ticinese: ${v.openings} lavori amministrazione`, v, 'it'),
      en: (v) => withSalary(`Ticino capital: ${v.openings} admin jobs`, v, 'en'),
      de: (v) => withSalary(`Tessiner Hauptstadt: ${v.openings} Verwaltungsjobs`, v, 'de'),
      fr: (v) => withSalary(`Capitale tessinoise: ${v.openings} emplois admin`, v, 'fr'),
    },
  },
  locarno: {
    emoji: '🏙️',
    eyebrowLabel: {
      it: 'Costo della vita · Locarno',
      en: 'Cost of living · Locarno',
      de: 'Lebenshaltung · Locarno',
      fr: 'Coût de la vie · Locarno',
    },
    taglineTemplate: {
      it: (v) => withSalary(`Lago Maggiore: ${v.openings} lavori turismo+industria`, v, 'it'),
      en: (v) => withSalary(`Lake Maggiore: ${v.openings} tourism+industry jobs`, v, 'en'),
      de: (v) => withSalary(`Lago Maggiore: ${v.openings} Jobs Tourismus+Industrie`, v, 'de'),
      fr: (v) => withSalary(`Lac Majeur: ${v.openings} emplois tourisme+industrie`, v, 'fr'),
    },
  },
  ticino: {
    emoji: '🏞️',
    eyebrowLabel: {
      it: 'Costo della vita · tutto il Ticino',
      en: 'Cost of living · all Ticino',
      de: 'Lebenshaltung · ganzes Tessin',
      fr: 'Coût de la vie · tout le Tessin',
    },
    taglineTemplate: {
      it: (v) => withSalary(`Tutto il cantone: ${v.openings} lavori in Ticino`, v, 'it'),
      en: (v) => withSalary(`Whole canton: ${v.openings} jobs in Ticino`, v, 'en'),
      de: (v) => withSalary(`Ganzer Kanton: ${v.openings} Jobs im Tessin`, v, 'de'),
      fr: (v) => withSalary(`Tout le canton: ${v.openings} emplois au Tessin`, v, 'fr'),
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

