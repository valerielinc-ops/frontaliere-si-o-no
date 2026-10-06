import { getAuthorBySlug, type Author } from './authors';

export type AuthorLocale = 'it' | 'en' | 'de' | 'fr';

/** Disclosure shown on every editorial-profile page and card. */
export const EDITORIAL_PROFILE_DISCLOSURE: Record<AuthorLocale, string> = {
  it: 'Profilo editoriale della redazione di frontaliereticino.ch',
  en: 'Editorial profile of the frontaliereticino.ch newsroom',
  de: 'Redaktionelles Profil der Redaktion von frontaliereticino.ch',
  fr: 'Profil éditorial de la rédaction de frontaliereticino.ch',
};

type LocalizedFields = Pick<Author, 'role' | 'bio' | 'expertise'>;

/** Translations of the registered authors and editorial profiles. */
const PROFILES: Record<string, Record<Exclude<AuthorLocale, 'it'>, LocalizedFields>> = {
  'marco-ferrari': {
    en: {
      role: 'Editorial profile — cross-border taxation',
      bio: 'This editorial profile gathers guides on taxation between Italy and Switzerland, with a focus on cross-border workers in Canton Ticino. It covers Italian 730 and Redditi PF returns, cantonal and federal withholding tax, IRPEF transfers and the Italy–Switzerland cross-border agreement. The newsroom follows communications from the Italian Revenue Agency, Ticino tax administration and the Ministry of Economy, and publishes analysis on deadlines, double taxation, net-tax calculations, the 20 km border area, new cross-border workers and transitional rules.',
      expertise: ['cross-border taxation', '730', 'income tax returns', 'withholding tax', 'Italy–Switzerland agreement'],
    },
    de: {
      role: 'Redaktionelles Profil — Grenzgängerbesteuerung',
      bio: 'Dieses redaktionelle Profil bündelt Leitfäden zur Besteuerung zwischen Italien und der Schweiz mit Schwerpunkt auf Grenzgängern im Kanton Tessin. Behandelt werden die italienischen Steuererklärungen 730 und Redditi PF, kantonale und eidgenössische Quellensteuern, IRPEF-Ausgleichszahlungen und das Grenzgängerabkommen Italien–Schweiz. Die Redaktion verfolgt Mitteilungen der italienischen Steuerbehörde, der Tessiner Steuerverwaltung und des Wirtschaftsministeriums sowie Fragen zu Fristen, Doppelbesteuerung, Nettosteuer, 20-km-Grenzzone, neuen Grenzgängern und Übergangsregelungen.',
      expertise: ['Grenzgängerbesteuerung', '730', 'Steuererklärung', 'Quellensteuer', 'Abkommen Italien–Schweiz'],
    },
    fr: {
      role: 'Profil éditorial — fiscalité frontalière',
      bio: 'Ce profil éditorial rassemble des guides sur la fiscalité entre l’Italie et la Suisse, notamment pour les frontaliers du canton du Tessin. Il traite les déclarations italiennes 730 et Redditi PF, l’impôt à la source cantonal et fédéral, les rétrocessions IRPEF et l’accord Italie–Suisse. La rédaction suit les communications de l’administration fiscale italienne, du fisc tessinois et du ministère de l’Économie, ainsi que les échéances, la double imposition, le calcul de l’impôt net, la zone frontalière de 20 km et les régimes transitoires.',
      expertise: ['fiscalité frontalière', '730', 'déclaration de revenus', 'impôt à la source', 'accord Italie–Suisse'],
    },
  },
  'laura-bianchi': {
    en: {
      role: 'Editorial profile — Swiss social insurance',
      bio: 'This editorial profile gathers practical content on Swiss social insurance for Italian cross-border workers in Canton Ticino. Topics include AHV first-pillar pensions, occupational pensions, accident insurance and LAMal health cover, including the right of option. Guides cover retirement pensions, vested benefits, second-pillar benefits, pillars 3a and 3b, compensation-office procedures, the AHV 21 reform, conversion rates, premiums and cover according to residence.',
      expertise: ['AHV', 'occupational pensions', 'LAMal', 'pensions', 'Swiss social insurance'],
    },
    de: {
      role: 'Redaktionelles Profil — Schweizer Sozialversicherungen',
      bio: 'Dieses redaktionelle Profil bündelt Inhalte zur Schweizer Sozialvorsorge für italienische Grenzgänger im Kanton Tessin. Themen sind AHV, berufliche Vorsorge, Unfallversicherung und LAMal-Krankenversicherung einschliesslich des Optionsrechts. Die Leitfäden behandeln Altersrenten, Freizügigkeitsleistungen, die zweite Säule, Säulen 3a und 3b, Verfahren bei Ausgleichskassen, die Reform AHV 21, Umwandlungssätze, Prämien und Deckung nach Wohnsitz.',
      expertise: ['AHV', 'BVG', 'LAMal', 'Renten', 'Schweizer Sozialversicherungen'],
    },
    fr: {
      role: 'Profil éditorial — prévoyance suisse',
      bio: 'Ce profil éditorial rassemble des contenus pratiques sur la prévoyance sociale suisse pour les frontaliers italiens au Tessin. Les thèmes incluent l’AVS, la prévoyance professionnelle, l’assurance accidents et la couverture LAMal, y compris le droit d’option. Les guides traitent des rentes de vieillesse, du libre passage, du deuxième pilier, des piliers 3a et 3b, des démarches auprès des caisses de compensation, de la réforme AVS 21, des taux de conversion et des primes selon la résidence.',
      expertise: ['AVS', 'LPP', 'LAMal', 'retraites', 'assurances sociales suisses'],
    },
  },
  redazione: {
    en: {
      role: 'Editorial profile — Ticino news desk',
      bio: 'This editorial profile covers the daily concerns of Italian cross-border workers in Canton Ticino: jobs, sector salaries, Swiss collective agreements, cross-border transport and customs. The newsroom checks communications from SECO, USTAT, Canton Ticino, border municipalities, INPS and the Italian Revenue Agency, compares regional reporting with official statistics and coordinates topics outside the other editorial areas.',
      expertise: ['cross-border employment', 'salaries', 'cross-border transport', 'customs'],
    },
    de: {
      role: 'Redaktionelles Profil — Tessiner Nachrichten',
      bio: 'Dieses redaktionelle Profil behandelt Alltagsthemen italienischer Grenzgänger im Kanton Tessin: Arbeitsmarkt, Branchenlöhne, Schweizer Gesamtarbeitsverträge, grenzüberschreitender Verkehr und Zoll. Die Redaktion prüft Mitteilungen von SECO, USTAT, Kanton Tessin, Grenzgemeinden, INPS und der italienischen Steuerbehörde, vergleicht regionale Berichte mit amtlichen Statistiken und koordiniert Themen ausserhalb der übrigen redaktionellen Bereiche.',
      expertise: ['Grenzgängerarbeit', 'Löhne', 'grenzüberschreitender Verkehr', 'Zoll'],
    },
    fr: {
      role: 'Profil éditorial — actualité tessinoise',
      bio: 'Ce profil éditorial couvre les préoccupations quotidiennes des frontaliers italiens au Tessin : emploi, salaires par secteur, conventions collectives suisses, mobilité transfrontalière et douanes. La rédaction vérifie les communications du SECO, d’USTAT, du canton du Tessin, des communes frontalières, de l’INPS et de l’administration fiscale italienne, compare les informations régionales aux statistiques officielles et coordonne les sujets qui dépassent les autres domaines éditoriaux.',
      expertise: ['emploi frontalier', 'salaires', 'transports transfrontaliers', 'douanes'],
    },
  },
  'samuele-valente': {
    en: {
      role: 'Guest author — cross-border taxation',
      bio: 'Samuele Valente is a professional specialising in international and cross-border taxation between Italy and Switzerland. As a guest author for Frontaliere Ticino, he contributes analysis and commentary on Italian Revenue Agency practice and the Italy–Switzerland cross-border workers agreement, applicable from 1 January 2024. His articles examine tax rulings, border-area requirements, tax residence and concurrent taxation affecting workers in Canton Ticino and the Italian border regions.',
      expertise: ['cross-border taxation', 'Italy–Switzerland agreement', 'Italian tax rulings', 'tax residence', 'cross-border workers'],
    },
    de: {
      role: 'Gastautor — grenzüberschreitende Besteuerung',
      bio: 'Samuele Valente ist auf internationale und grenzüberschreitende Besteuerung zwischen Italien und der Schweiz spezialisiert. Als Gastautor von Frontaliere Ticino analysiert und kommentiert er die Praxis der italienischen Steuerbehörde und das seit 1. Januar 2024 anwendbare Grenzgängerabkommen Italien–Schweiz. Seine Beiträge behandeln Steuerauskünfte, Voraussetzungen des Grenzgebiets, den Steuerwohnsitz und konkurrierende Besteuerung von Arbeitnehmern im Kanton Tessin und in den italienischen Grenzregionen.',
      expertise: ['grenzüberschreitende Besteuerung', 'Abkommen Italien–Schweiz', 'italienische Steuerauskünfte', 'Steuerwohnsitz', 'Grenzgänger'],
    },
    fr: {
      role: 'Auteur invité — fiscalité transfrontalière',
      bio: 'Samuele Valente est spécialisé dans la fiscalité internationale et transfrontalière entre l’Italie et la Suisse. Auteur invité de Frontaliere Ticino, il propose des analyses et commentaires sur la pratique de l’administration fiscale italienne et sur l’accord Italie–Suisse relatif aux frontaliers, applicable depuis le 1er janvier 2024. Ses contributions portent sur les réponses aux demandes de rescrit, les conditions de la zone frontalière, la résidence fiscale et les mécanismes d’imposition concurrente concernant les travailleurs du Tessin et des régions frontalières italiennes.',
      expertise: ['fiscalité transfrontalière', 'accord Italie–Suisse', 'rescrits fiscaux italiens', 'résidence fiscale', 'frontaliers'],
    },
  },
};

/** Preserve independently edited public fields while localizing unchanged text. */
export function localizeAuthor(author: Author, locale: AuthorLocale): Author {
  const base = getAuthorBySlug(author.slug);
  const translation = locale === 'it' ? undefined : PROFILES[author.slug]?.[locale];
  if (!base || !translation) return author;
  return {
    ...author,
    role: author.role === base.role ? translation.role : author.role,
    bio: author.bio === base.bio ? translation.bio : author.bio,
    expertise: JSON.stringify(author.expertise) === JSON.stringify(base.expertise) ? [...translation.expertise] : author.expertise,
  };
}
