/**
 * The ONE statement about how the site uses AI — shared by every surface that
 * talks about it.
 *
 * Before this module the site said three different things: the static
 * /chi-siamo/ HTML claimed a "redazione composta da esperti", the React
 * /chi-siamo/ said generative AI without guaranteed human review, and the
 * article aside said "bozza assistita da IA, revisionata dalla redazione" and
 * then, in the same sentence, that this did not certify human review. Only the
 * second matches the published methodology (`services/editorialMethodology.ts`,
 * section `ai`), so it is the wording every surface now reuses:
 *
 * - `components/pages/chiSiamoCopy.ts` (React /chi-siamo/, 4 locales)
 * - `build-plugins/staticPagesPlugin.ts` + `build-plugins/editorialContent.ts`
 *   (static /chi-siamo/ and /about/)
 * - `components/community/BlogArticles.tsx` (article aside after hydration)
 * - `packages/articles/engine/ogPagesPlugin.ts` (static article HTML)
 *
 * Lives in the engine because the static article renderer cannot import from
 * the site; the site imports it from here (same pattern as
 * `shared/articleBodyQuality.ts`). `tests/ai-disclosure-single-source.test.ts`
 * keeps the surfaces on it.
 */

export type DisclosureLocale = 'it' | 'en' | 'de' | 'fr';

/** The site-wide AI statement (about pages, methodology summary). */
export const AI_USE_STATEMENT: Readonly<Record<DisclosureLocale, string>> = Object.freeze({
  it: 'Usiamo strumenti di IA generativa per bozze e traduzioni, con controlli automatici e possibili correzioni redazionali. Non garantiamo una revisione umana preventiva di ogni articolo.',
  en: 'We use generative AI tools for drafts and translations, with automated checks and possible editorial corrections. We do not guarantee human review of every article before publication.',
  de: 'Wir nutzen generative KI für Entwürfe und Übersetzungen, mit automatisierten Prüfungen und möglichen redaktionellen Korrekturen. Eine menschliche Prüfung jedes Artikels vor der Veröffentlichung garantieren wir nicht.',
  fr: 'Nous utilisons des outils d’IA générative pour les brouillons et les traductions, avec des contrôles automatiques et d’éventuelles corrections rédactionnelles. Nous ne garantissons pas une relecture humaine de chaque article avant publication.',
});

/** Editorial methodology page per locale (mirrors `METHODOLOGY_PATHS`). */
export const METHODOLOGY_PAGE_PATHS: Readonly<Record<DisclosureLocale, string>> = Object.freeze({
  it: '/metodologia/', en: '/en/methodology/', de: '/de/methodik/', fr: '/fr/methodologie/',
});

/** Public corrections register per locale (mirrors `CORRECTIONS_PATHS`). */
export const CORRECTIONS_PAGE_PATHS: Readonly<Record<DisclosureLocale, string>> = Object.freeze({
  it: '/correzioni/', en: '/en/corrections/', de: '/de/korrekturen/', fr: '/fr/corrections/',
});

export interface ArticleTransparencyCopy {
  readonly label: string;
  /** Machine-drafted article (no human contributor on the byline). */
  readonly aiAssisted: string;
  /** Original contribution by a registered human author. */
  readonly human: (authorName: string) => string;
  readonly sources: string;
  readonly methodology: string;
  readonly corrections: string;
  /** Short labels for the static trust navigation. */
  readonly navMethodology: string;
  readonly navCorrections: string;
}

/** Per-article disclosure: the same claim as `AI_USE_STATEMENT`, applied to one article. */
export const ARTICLE_TRANSPARENCY: Readonly<Record<DisclosureLocale, ArticleTransparencyCopy>> = Object.freeze({
  it: {
    label: 'Trasparenza editoriale',
    aiAssisted: 'testo preparato con strumenti di IA generativa e pubblicato dopo controlli automatici; eventuali correzioni redazionali possono avvenire dopo la pubblicazione. Non garantiamo una revisione umana preventiva.',
    human: (name) => `contributo originale di ${name}, pubblicato dalla redazione senza stesura assistita da intelligenza artificiale.`,
    sources: 'Le fonti utilizzate sono linkate nel testo.',
    methodology: 'Come scriviamo gli articoli',
    corrections: 'Segnala una correzione',
    navMethodology: 'Metodologia',
    navCorrections: 'Correzioni',
  },
  en: {
    label: 'Editorial transparency',
    aiAssisted: 'text prepared with generative AI tools and published after automated checks; editorial corrections may follow publication. We do not guarantee human review before publication.',
    human: (name) => `original contribution by ${name}, published by the newsroom without AI-assisted drafting.`,
    sources: 'The sources used are linked in the text.',
    methodology: 'How we write articles',
    corrections: 'Report a correction',
    navMethodology: 'Methodology',
    navCorrections: 'Corrections',
  },
  de: {
    label: 'Redaktionelle Transparenz',
    aiAssisted: 'Text mit generativer KI erstellt und nach automatisierten Prüfungen veröffentlicht; redaktionelle Korrekturen können nach der Veröffentlichung erfolgen. Eine menschliche Prüfung vor der Veröffentlichung garantieren wir nicht.',
    human: (name) => `Originalbeitrag von ${name}, von der Redaktion ohne KI-gestützte Erstellung veröffentlicht.`,
    sources: 'Die verwendeten Quellen sind im Text verlinkt.',
    methodology: 'Wie wir Artikel schreiben',
    corrections: 'Korrektur melden',
    navMethodology: 'Methodik',
    navCorrections: 'Korrekturen',
  },
  fr: {
    label: 'Transparence éditoriale',
    aiAssisted: 'texte préparé avec des outils d’IA générative et publié après des contrôles automatiques ; des corrections rédactionnelles peuvent suivre la publication. Nous ne garantissons pas de relecture humaine avant publication.',
    human: (name) => `contribution originale de ${name}, publiée par la rédaction sans rédaction assistée par l’IA.`,
    sources: 'Les sources utilisées sont liées dans le texte.',
    methodology: 'Comment nous rédigeons les articles',
    corrections: 'Signaler une correction',
    navMethodology: 'Méthodologie',
    navCorrections: 'Corrections',
  },
});

export function disclosureLocale(locale: string): DisclosureLocale {
  return locale === 'en' || locale === 'de' || locale === 'fr' ? locale : 'it';
}
