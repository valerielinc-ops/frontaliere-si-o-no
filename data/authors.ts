/**
 * Author registry — Google News E-E-A-T compliance (FASE 1, A1).
 *
 * The registry distinguishes editorial signatures from real authors. Editorial
 * profiles describe the newsroom's coverage without personal identity fields;
 * real authors may carry the public identity and attribution fields needed for
 * a Person entity and uid-based bylines.
 */

export type AuthorKind = 'editorial-profile' | 'real-author';

export interface AuthorBase {
  /** Stable kebab-case slug used in URLs (`/autori/{slug}/`). */
  slug: string;
  /** Display name of the signature or author. */
  name: string;
  /** Short role descriptor shown under the name. */
  role: string;
  /** Italian biography or editorial description, plain text and without HTML. */
  bio: string;
  /** Public path under /public. */
  photoPath: string;
  /** Topical keywords used by {@link pickAuthorForTopic}. */
  expertise: string[];
}

/** Public social identity fields used by real authors' structured data. */
export interface AuthorSocial {
  /** Public LinkedIn profile URL. */
  linkedin?: string;
  twitter?: string;
  mastodon?: string;
  /** Wikidata QID (e.g. `Q12345`). */
  wikidataId?: string;
}

/** A newsroom signature with no personal identity or attribution fields. */
export interface EditorialProfile extends AuthorBase {
  kind: 'editorial-profile';
  /** Organization LinkedIn URL; currently used by the Redazione team only. */
  linkedin?: string;
}

/** A real author whose public identity may be represented as a schema.org Person. */
export interface RealAuthor extends AuthorBase {
  kind: 'real-author';
  /** Optional public contact email. */
  email?: string;
  /** Firebase Auth uid used for trusted byline attribution. */
  uid: string;
  /** Optional downloadable CV. */
  cvPath?: string;
  /** Social fields, including the author's public LinkedIn URL. */
  social: AuthorSocial;
  /** ISO 8601 join date. */
  joinedAt: string;
}

export type Author = EditorialProfile | RealAuthor;

/** Frozen registry of editorial profiles and real authors. */
export const AUTHORS: ReadonlyArray<Author> = Object.freeze([
  {
    kind: 'editorial-profile',
    slug: 'marco-ferrari',
    name: 'Marco Ferrari',
    role: 'Profilo editoriale — fiscalità frontaliera',
    bio: 'Questo profilo editoriale raccoglie guide sulla fiscalità transfrontaliera tra Italia e Svizzera, con attenzione ai lavoratori frontalieri del Canton Ticino. Copre dichiarazioni dei redditi 730 e Redditi PF, imposta alla fonte cantonale e federale, ristorni IRPEF e applicazione pratica dell’accordo Italia-Svizzera. La redazione segue le comunicazioni dell’Agenzia delle Entrate, dell’AFC ticinese e del Ministero dell’Economia e pubblica analisi su acconti, scadenze, doppia imposizione, calcolo dell’imposta netta in CHF ed EUR, soglia dei 20 km, nuovi frontalieri e regimi transitori.',
    photoPath: '/images/authors/marco-ferrari.webp',
    expertise: [
      'fiscalità frontaliera',
      '730',
      'dichiarazione redditi',
      'imposta alla fonte',
      'accordo Italia-Svizzera',
    ],
  },
  {
    kind: 'editorial-profile',
    slug: 'laura-bianchi',
    name: 'Laura Bianchi',
    role: 'Profilo editoriale — previdenza svizzera',
    bio: 'Questo profilo editoriale raccoglie contenuti sulla previdenza sociale svizzera per i lavoratori frontalieri italiani in Canton Ticino. I temi includono AVS, LPP, assicurazione contro gli infortuni LAINF e copertura sanitaria LAMal, compreso il diritto di scelta verso la cassa malati italiana. Le guide trattano rendite di vecchiaia, libero passaggio, riscatto del secondo pilastro, terzo pilastro 3a/3b, casse di compensazione, riforma AVS 21, tassi di conversione LPP, premi e coperture secondo la residenza.',
    photoPath: '/images/authors/laura-bianchi.webp',
    expertise: [
      'AVS',
      'LPP',
      'LAMal',
      'pensioni',
      'assicurazioni sociali svizzere',
    ],
  },
  {
    kind: 'editorial-profile',
    slug: 'redazione',
    name: 'Redazione Frontaliere Ticino',
    role: 'Profilo editoriale — attualità ticinese',
    bio: 'Questo profilo editoriale copre i temi quotidiani dei lavoratori frontalieri italiani in Canton Ticino: mercato del lavoro, salari per settore, contratti collettivi svizzeri, mobilità transfrontaliera e dogana ai principali valichi. La redazione verifica i comunicati di SECO, USTAT, Cantone Ticino, Comuni di confine, INPS e Agenzia delle Entrate, confrontando le fonti giornalistiche regionali con le statistiche ufficiali e coordinando i contenuti che non rientrano negli altri ambiti editoriali.',
    photoPath: '/images/authors/redazione.webp',
    linkedin: 'https://www.linkedin.com/company/frontaliere-ticino/',
    expertise: [
      'lavoro frontaliere',
      'salari',
      'trasporti transfrontalieri',
      'dogana',
    ],
  },
  {
    kind: 'real-author',
    slug: 'samuele-valente',
    name: 'Samuele Valente',
    uid: 'rAaDN0AvhkUjvRxN2TJijgYodm22',
    role: 'Autore ospite — fiscalità transfrontaliera',
    bio: "Samuele Valente è un professionista esperto di fiscalità internazionale e transfrontaliera tra Italia e Svizzera. Collabora con Frontaliere Ticino come autore ospite, proponendo analisi e commenti sulla prassi dell'Agenzia delle Entrate e sull'applicazione del nuovo Accordo tra Italia e Svizzera sui lavoratori frontalieri, entrato in vigore dal 1° gennaio 2024. Nei suoi contributi approfondisce in particolare le risposte a interpello, i requisiti dell'area di frontiera, la nozione di residenza fiscale e i meccanismi di imposizione concorrente che riguardano i frontalieri del Canton Ticino e delle regioni italiane di confine. Il suo obiettivo è tradurre la normativa e i documenti di prassi in indicazioni chiare e operative per i lavoratori e le imprese interessati dalla disciplina convenzionale.",
    photoPath: '/images/authors/samuele-valente.webp',
    cvPath: '/documents/authors/samuele-valente-cv.pdf',
    social: {
      linkedin: 'https://www.linkedin.com/in/samuele-valente-9b8a4335b/',
    },
    expertise: [
      'fiscalità transfrontaliera',
      'accordo Italia-Svizzera',
      'interpelli Agenzia delle Entrate',
      'residenza fiscale',
      'frontalieri',
    ],
    joinedAt: '2026-06-30',
  },
]);

export function isEditorialProfile(author: Author): author is EditorialProfile {
  return author.kind === 'editorial-profile';
}

export function isRealAuthor(author: Author): author is RealAuthor {
  return author.kind === 'real-author';
}

/** Returns the registered signature with the given slug, or `undefined`. */
export function getAuthorBySlug(slug: string): Author | undefined {
  return AUTHORS.find((author) => author.slug === slug);
}

/** Returns the real author associated with a Firebase Auth uid. */
export function getAuthorByUid(uid: string): RealAuthor | undefined {
  return AUTHORS.find((author): author is RealAuthor => isRealAuthor(author) && author.uid === uid);
}

export function getAllAuthors(): ReadonlyArray<Author> {
  return AUTHORS;
}

let _roundRobinIdx = 0;

/** Picks the registered author best suited to the given topical keywords. */
export function pickAuthorForTopic(keywords: string[]): Author {
  const normalized = keywords.map((keyword) => keyword.toLowerCase());
  const scored = AUTHORS.map((author) => {
    const score = author.expertise.reduce((acc, expertise) => {
      const normalizedExpertise = expertise.toLowerCase();
      const hit = normalized.some((keyword) => keyword.includes(normalizedExpertise) || normalizedExpertise.includes(keyword));
      return acc + (hit ? 1 : 0);
    }, 0);
    return { author, score };
  });
  const maxScore = scored.reduce((max, item) => (item.score > max ? item.score : max), 0);
  if (maxScore > 0) {
    const winners = scored.filter((item) => item.score === maxScore);
    if (winners.length === 1) return winners[0].author;
    const index = _roundRobinIdx++ % winners.length;
    return winners[index].author;
  }
  const index = _roundRobinIdx++ % AUTHORS.length;
  return AUTHORS[index];
}
