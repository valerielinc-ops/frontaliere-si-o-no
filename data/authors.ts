/**
 * Editorial profile registry.
 *
 * The four stable signatures are newsroom profiles, not biographies of
 * identifiable people. The registry intentionally contains only the public
 * editorial identity needed by bylines, profile pages and topic assignment;
 * it has no contact, social, CV, authentication or employment history fields.
 */

export interface Author {
  /** Stable kebab-case slug used in URLs (`/autori/{slug}/`). */
  slug: string;
  /** Display name of the editorial signature. */
  name: string;
  /** Short editorial area shown under the signature. */
  role: string;
  /** Italian editorial description, plain text and without personal claims. */
  bio: string;
  /** Generated illustrated avatar under /public. */
  photoPath: string;
  /** Topical keywords used by {@link pickAuthorForTopic}. */
  expertise: string[];
}

/**
 * Frozen registry of editorial profiles. Order matters: {@link
 * pickAuthorForTopic} walks the array in declared order before falling back to
 * round-robin, so the most specialised profile for a topic should be listed
 * first.
 */
export const AUTHORS: ReadonlyArray<Author> = Object.freeze([
  {
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
    slug: 'redazione',
    name: 'Redazione Frontaliere Ticino',
    role: 'Profilo editoriale — attualità ticinese',
    bio: 'Questo profilo editoriale copre i temi quotidiani dei lavoratori frontalieri italiani in Canton Ticino: mercato del lavoro, salari per settore, contratti collettivi svizzeri, mobilità transfrontaliera e dogana ai principali valichi. La redazione verifica i comunicati di SECO, USTAT, Cantone Ticino, Comuni di confine, INPS e Agenzia delle Entrate, confrontando le fonti giornalistiche regionali con le statistiche ufficiali e coordinando i contenuti che non rientrano negli altri ambiti editoriali.',
    photoPath: '/images/authors/redazione.webp',
    expertise: [
      'lavoro frontaliere',
      'salari',
      'trasporti transfrontalieri',
      'dogana',
    ],
  },
  {
    slug: 'samuele-valente',
    name: 'Samuele Valente',
    role: 'Profilo editoriale — fiscalità transfrontaliera',
    bio: 'Questo profilo editoriale raccoglie analisi sulla fiscalità internazionale e transfrontaliera tra Italia e Svizzera. I contenuti seguono la prassi dell’Agenzia delle Entrate e l’accordo Italia-Svizzera sui lavoratori frontalieri, con approfondimenti su risposte a interpello, requisiti dell’area di frontiera, residenza fiscale e meccanismi di imposizione concorrente per il Canton Ticino e le regioni italiane di confine.',
    photoPath: '/images/authors/samuele-valente.webp',
    expertise: [
      'fiscalità transfrontaliera',
      'accordo Italia-Svizzera',
      'interpelli Agenzia delle Entrate',
      'residenza fiscale',
      'frontalieri',
    ],
  },
]);

/** Returns the editorial profile with the given slug, or `undefined`. */
export function getAuthorBySlug(slug: string): Author | undefined {
  return AUTHORS.find((author) => author.slug === slug);
}

/** Returns the frozen editorial-profile registry. */
export function getAllAuthors(): ReadonlyArray<Author> {
  return AUTHORS;
}

let _roundRobinIdx = 0;

/**
 * Picks the editorial profile best suited for the given topical keywords.
 *
 * The function scores case-insensitive substring overlap and uses a
 * round-robin tie-breaker so generic articles still receive a stable profile
 * assignment without inventing a personal author identity.
 */
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
