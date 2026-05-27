/**
 * Author registry — Google News E-E-A-T compliance (FASE 1, A1).
 *
 * Defines the editorial team Person entries used by NewsArticle JSON-LD,
 * per-author profile pages (`/autori/{slug}/`), and topic-based byline
 * assignment via {@link pickAuthorForTopic}.
 *
 * Spec: docs/GOOGLE-NEWS-COMPLIANCE-PLAN.md §4 — FASE 1, A1.
 *
 * The registry is the single source of truth: pages, schema, and tests all
 * read from {@link AUTHORS}. Adding/editing an author here automatically
 * propagates to the author page, JSON-LD, sitemap entry, and (via A2,
 * separate task) NewsArticle bylines.
 */

export interface AuthorSocial {
  /** OBBLIGATORIO per KG link — public LinkedIn profile URL. */
  linkedin?: string;
  twitter?: string;
  mastodon?: string;
  /** Wikidata QID (e.g. `Q12345`) — boost E-E-A-T when present. */
  wikidataId?: string;
}

export interface Author {
  /** Stable kebab-case slug used in URLs (`/autori/{slug}/`). */
  slug: string;
  /** Full display name. */
  name: string;
  /** Short role descriptor shown under the name (e.g. "Esperto fiscalità frontaliera"). */
  role: string;
  /** Italian biography, ~150 words. Plain text, no HTML. */
  bio: string;
  /** Public path under /public, e.g. `/images/authors/marco-ferrari.jpg`. */
  photoPath: string;
  /** Optional contact email. */
  email?: string;
  /** Social profiles for `sameAs` JSON-LD signals. */
  social: AuthorSocial;
  /** Topical keywords used by {@link pickAuthorForTopic}. */
  expertise: string[];
  /** ISO 8601 join date — drives `joinedAt` in JSON-LD where useful. */
  joinedAt: string;
}

/**
 * Frozen registry of authors. Order matters: {@link pickAuthorForTopic}
 * walks the array in declared order before falling back to round-robin,
 * so the most-specialised author for a topic should be listed first.
 */
export const AUTHORS: ReadonlyArray<Author> = Object.freeze([
  {
    slug: 'marco-ferrari',
    name: 'Marco Ferrari',
    role: 'Esperto fiscalità frontaliera',
    bio: "Marco Ferrari è specializzato in fiscalità transfrontaliera tra Italia e Svizzera, con particolare attenzione alla disciplina applicabile ai lavoratori frontalieri del Canton Ticino. Si occupa quotidianamente di dichiarazione dei redditi modello 730 e Redditi PF, di imposta alla fonte cantonale e federale, di ristorni IRPEF e di applicazione pratica del nuovo accordo Italia-Svizzera del 2026 sui frontalieri. Segue le novità dell'Agenzia delle Entrate, dell'AFC ticinese e dei comunicati congiunti del Ministero dell'Economia. Su Frontaliere Ticino cura le guide operative su acconti, scadenze, doppia imposizione e calcolo dell'imposta netta in CHF ed EUR. Pubblica analisi sulle implicazioni della soglia di 20 km dal confine, sulla figura del «nuovo frontaliere» e sui regimi transitori per chi ha iniziato a lavorare in Svizzera prima e dopo il 17 luglio 2023. Risponde a quesiti dei lettori sui casi limite della residenza fiscale italiana.",
    photoPath: '/images/authors/marco-ferrari.jpg',
    email: 'marco.ferrari@frontaliereticino.ch',
    social: {
      linkedin: 'https://www.linkedin.com/in/marco-ferrari-frontaliere-ticino/',
    },
    expertise: [
      'fiscalità frontaliera',
      '730',
      'dichiarazione redditi',
      'imposta alla fonte',
      'accordo Italia-Svizzera 2026',
    ],
    joinedAt: '2024-09-01',
  },
  {
    slug: 'laura-bianchi',
    name: 'Laura Bianchi',
    role: 'Specialista previdenza svizzera',
    bio: "Laura Bianchi è specialista in previdenza sociale svizzera applicata ai lavoratori frontalieri italiani in Canton Ticino. Si occupa di AVS (1° pilastro), LPP (2° pilastro), assicurazione contro gli infortuni LAINF e copertura sanitaria LAMal, includendo l'opzione del diritto di scelta verso la cassa malati italiana per i frontalieri. Su Frontaliere Ticino redige guide su rendite di vecchiaia, prestazioni di libero passaggio, riscatto del 2° pilastro alla cessazione del rapporto di lavoro, terzo pilastro 3a/3b e adempimenti presso le casse di compensazione. Segue da vicino la riforma AVS 21, l'andamento dei tassi di conversione LPP minimi, le franchigie cantonali LAMal e le decisioni del Consiglio federale in materia di assicurazioni sociali. Aiuta i lettori a leggere correttamente il certificato LPP annuale e a confrontare le casse pensione con simulatori dedicati al confronto frontaliere/residente B.",
    photoPath: '/images/authors/laura-bianchi.jpg',
    email: 'laura.bianchi@frontaliereticino.ch',
    social: {
      linkedin: 'https://www.linkedin.com/in/laura-bianchi-previdenza-svizzera/',
    },
    expertise: [
      'AVS',
      'LPP',
      'LAMal',
      'pensioni',
      'assicurazioni sociali svizzere',
    ],
    joinedAt: '2024-10-15',
  },
  {
    slug: 'redazione',
    name: 'Redazione Frontaliere Ticino',
    role: 'Team editoriale',
    bio: "La Redazione di Frontaliere Ticino è il team editoriale dedicato alla copertura quotidiana dei temi rilevanti per i lavoratori frontalieri italiani in Canton Ticino. Cura aggiornamenti su mercato del lavoro ticinese, livelli salariali per settore, contratti collettivi nazionali (CCNL) svizzeri, mobilità transfrontaliera e politiche doganali ai principali valichi (Chiasso-Brogeda, Stabio-Gaggiolo, Ponte Tresa, Bizzarone). Verifica i comunicati ufficiali di SECO, USTAT, Cantone Ticino, Comuni di confine e organi italiani come INPS, Agenzia delle Entrate e ATS Insubria. Confronta i dati pubblicati da fonti giornalistiche regionali (RSI, Corriere del Ticino, La Regione, Tio.ch, Como Zero, VareseNews) con le statistiche ufficiali per garantire accuratezza. Coordina inoltre la pubblicazione delle altre firme editoriali quando la materia trattata esce dal perimetro di specializzazione fiscale o previdenziale.",
    photoPath: '/images/authors/redazione.jpg',
    email: 'redazione@frontaliereticino.ch',
    social: {
      linkedin: 'https://www.linkedin.com/company/frontaliere-ticino/',
    },
    expertise: [
      'lavoro frontaliere',
      'salari',
      'trasporti transfrontalieri',
      'dogana',
    ],
    joinedAt: '2024-08-01',
  },
]);

/** Returns the author with the given slug, or `undefined` if not found. */
export function getAuthorBySlug(slug: string): Author | undefined {
  return AUTHORS.find((a) => a.slug === slug);
}

/** Returns a fresh, readonly snapshot of all authors. */
export function getAllAuthors(): ReadonlyArray<Author> {
  return AUTHORS;
}

let _roundRobinIdx = 0;

/**
 * Picks an author best suited for the given topical keywords.
 *
 * Strategy:
 *   1. Score each author by case-insensitive substring overlap between
 *      `keywords` and `expertise`. Highest score wins.
 *   2. On a tie (or zero matches), advance a round-robin pointer over the
 *      full registry. This guarantees byline diversity over a series of
 *      generic articles while still preferring topical specialists when
 *      a clear match exists.
 *
 * Pure when scores diverge; module-stateful (round-robin) only on ties.
 */
export function pickAuthorForTopic(keywords: string[]): Author {
  const normalized = keywords.map((k) => k.toLowerCase());
  const scored = AUTHORS.map((author) => {
    const score = author.expertise.reduce((acc, expertise) => {
      const e = expertise.toLowerCase();
      const hit = normalized.some((kw) => kw.includes(e) || e.includes(kw));
      return acc + (hit ? 1 : 0);
    }, 0);
    return { author, score };
  });
  const maxScore = scored.reduce((m, s) => (s.score > m ? s.score : m), 0);
  if (maxScore > 0) {
    const winners = scored.filter((s) => s.score === maxScore);
    if (winners.length === 1) return winners[0].author;
    // Tied winners — round-robin within the tied group.
    const idx = _roundRobinIdx++ % winners.length;
    return winners[idx].author;
  }
  // No match — global round-robin.
  const idx = _roundRobinIdx++ % AUTHORS.length;
  return AUTHORS[idx];
}
