import type { Locale } from './i18n';

export type ConversionSurfaceKind = 'fuel' | 'border' | 'health' | 'editorial' | 'guide';

export type ContextualConversionContext = {
 kind: ConversionSurfaceKind;
 source: string;
 heading: string;
 body: string;
 cta: string;
 newsletterHeading: string;
 newsletterSubtitle: string;
};

type ContextCopy = Omit<ContextualConversionContext, 'kind'>;

const COPY: Record<Locale, Record<ConversionSurfaceKind, ContextCopy>> = {
 it: {
  fuel: {
   source: 'contextual_fuel',
   heading: 'Confronta prima di partire',
   body: 'I prezzi cambiano da zona a zona. Ricevi gli aggiornamenti utili per scegliere quando e dove fare rifornimento.',
   cta: 'Ricevi gli aggiornamenti',
   newsletterHeading: 'Prezzi e informazioni per chi attraversa il confine',
   newsletterSubtitle: 'Un riepilogo essenziale su carburante, traffico e novità fiscali.',
  },
  border: {
   source: 'contextual_border',
   heading: 'Parti con un vantaggio',
   body: 'I tempi al confine cambiano durante la giornata. Ricevi segnali pratici e aggiornamenti per organizzare meglio il tragitto.',
   cta: 'Ricevi gli aggiornamenti',
   newsletterHeading: 'Aggiornamenti per il tragitto casa-lavoro',
   newsletterSubtitle: 'Traffico, carburante e novità utili per i frontalieri, senza rumore.',
  },
  health: {
   source: 'contextual_health',
   heading: 'Confronta il costo reale',
   body: 'Il premio è solo una parte della scelta. Metti a confronto le opzioni e ricevi gli aggiornamenti che cambiano il budget familiare.',
   cta: 'Ricevi gli aggiornamenti',
   newsletterHeading: 'Le informazioni che incidono sul tuo budget',
   newsletterSubtitle: 'Premi, cambio e novità fiscali spiegati in modo pratico.',
  },
  editorial: {
   source: 'contextual_editorial',
   heading: 'Trasforma l’informazione in una scelta',
   body: 'Ricevi una sintesi periodica delle novità che possono cambiare il tuo netto, il tragitto o le opportunità di lavoro.',
   cta: 'Ricevi la sintesi',
   newsletterHeading: 'Una sintesi utile per i frontalieri',
   newsletterSubtitle: 'Novità fiscali, lavoro, traffico e cambio in poche righe.',
  },
  guide: {
   source: 'contextual_guide',
   heading: 'Tieni a portata di mano ciò che cambia',
   body: 'Le regole e i costi si aggiornano. Ricevi solo le novità pratiche per lavorare oltreconfine con più consapevolezza.',
   cta: 'Ricevi le novità',
   newsletterHeading: 'Novità pratiche per lavorare oltreconfine',
   newsletterSubtitle: 'Guide, scadenze e strumenti per decidere con dati aggiornati.',
  },
 },
 en: {
  fuel: {
   source: 'contextual_fuel',
   heading: 'Compare before you leave',
   body: 'Prices vary by area. Get the updates that help you decide when and where to refuel.',
   cta: 'Get the updates',
   newsletterHeading: 'Useful updates for cross-border commuters',
   newsletterSubtitle: 'Fuel, border traffic and tax news in one short briefing.',
  },
  border: {
   source: 'contextual_border',
   heading: 'Start with better information',
   body: 'Border times change throughout the day. Get practical updates to plan your commute with less guesswork.',
   cta: 'Get the updates',
   newsletterHeading: 'Updates for your daily commute',
   newsletterSubtitle: 'Traffic, fuel and tax changes for cross-border workers.',
  },
  health: {
   source: 'contextual_health',
   heading: 'Compare the real cost',
   body: 'The premium is only one part of the decision. Compare your options and keep up with changes that affect your budget.',
   cta: 'Get the updates',
   newsletterHeading: 'Information that affects your budget',
   newsletterSubtitle: 'Premiums, exchange rates and tax changes, explained clearly.',
  },
  editorial: {
   source: 'contextual_editorial',
   heading: 'Turn information into a decision',
   body: 'Get a short briefing on changes that can affect your take-home pay, commute or job search.',
   cta: 'Get the briefing',
   newsletterHeading: 'A useful briefing for cross-border workers',
   newsletterSubtitle: 'Tax, jobs, traffic and exchange-rate updates in a few lines.',
  },
  guide: {
   source: 'contextual_guide',
   heading: 'Keep up with what changes',
   body: 'Rules and costs move. Get practical updates for working across the border with better information.',
   cta: 'Get the updates',
   newsletterHeading: 'Practical cross-border updates',
   newsletterSubtitle: 'Guides, deadlines and tools for better decisions.',
  },
 },
 de: {
  fuel: {
   source: 'contextual_fuel',
   heading: 'Vor der Fahrt vergleichen',
   body: 'Die Preise unterscheiden sich je nach Region. Erhalte die wichtigsten Updates für deine Tankentscheidung.',
   cta: 'Updates erhalten',
   newsletterHeading: 'Nützliche Updates für Grenzgänger',
   newsletterSubtitle: 'Treibstoff, Grenzverkehr und Steuernews kompakt erklärt.',
  },
  border: {
   source: 'contextual_border',
   heading: 'Besser informiert losfahren',
   body: 'Die Wartezeiten am Grenzübergang ändern sich im Tagesverlauf. Erhalte praktische Updates für deinen Arbeitsweg.',
   cta: 'Updates erhalten',
   newsletterHeading: 'Updates für deinen Arbeitsweg',
   newsletterSubtitle: 'Verkehr, Treibstoff und Steueränderungen für Grenzgänger.',
  },
  health: {
   source: 'contextual_health',
   heading: 'Die echten Kosten vergleichen',
   body: 'Die Prämie ist nur ein Teil der Entscheidung. Vergleiche Optionen und behalte Änderungen für dein Budget im Blick.',
   cta: 'Updates erhalten',
   newsletterHeading: 'Informationen für dein Budget',
   newsletterSubtitle: 'Prämien, Wechselkurs und Steuernews verständlich erklärt.',
  },
  editorial: {
   source: 'contextual_editorial',
   heading: 'Informationen in Entscheidungen verwandeln',
   body: 'Erhalte eine kurze Zusammenfassung der Änderungen, die Nettolohn, Arbeitsweg oder Jobsuche betreffen.',
   cta: 'Zusammenfassung erhalten',
   newsletterHeading: 'Ein nützlicher Überblick für Grenzgänger',
   newsletterSubtitle: 'Steuern, Jobs, Verkehr und Wechselkurs auf einen Blick.',
  },
  guide: {
   source: 'contextual_guide',
   heading: 'Wichtiges im Blick behalten',
   body: 'Regeln und Kosten ändern sich. Erhalte praktische Updates für deine Arbeit über die Grenze hinweg.',
   cta: 'Updates erhalten',
   newsletterHeading: 'Praktische Updates für Grenzgänger',
   newsletterSubtitle: 'Ratgeber, Fristen und Tools für bessere Entscheidungen.',
  },
 },
 fr: {
  fuel: {
   source: 'contextual_fuel',
   heading: 'Comparez avant de partir',
   body: 'Les prix varient selon les zones. Recevez les informations utiles pour choisir quand et où faire le plein.',
   cta: 'Recevoir les infos',
   newsletterHeading: 'Les infos utiles pour les frontaliers',
   newsletterSubtitle: 'Carburant, trafic à la frontière et fiscalité en bref.',
  },
  border: {
   source: 'contextual_border',
   heading: 'Prenez la route mieux informé',
   body: 'Les temps d’attente changent au fil de la journée. Recevez des informations pratiques pour organiser votre trajet.',
   cta: 'Recevoir les infos',
   newsletterHeading: 'Infos pour votre trajet quotidien',
   newsletterSubtitle: 'Trafic, carburant et changements fiscaux pour les frontaliers.',
  },
  health: {
   source: 'contextual_health',
   heading: 'Comparez le coût réel',
   body: 'La prime n’est qu’une partie du choix. Comparez les options et suivez les changements qui affectent votre budget.',
   cta: 'Recevoir les infos',
   newsletterHeading: 'Les informations qui comptent pour votre budget',
   newsletterSubtitle: 'Primes, change et fiscalité expliqués clairement.',
  },
  editorial: {
   source: 'contextual_editorial',
   heading: 'Transformez l’information en décision',
   body: 'Recevez une synthèse des changements qui peuvent affecter votre salaire net, votre trajet ou votre recherche d’emploi.',
   cta: 'Recevoir la synthèse',
   newsletterHeading: 'Une synthèse utile pour les frontaliers',
   newsletterSubtitle: 'Fiscalité, emploi, trafic et change en quelques lignes.',
  },
  guide: {
   source: 'contextual_guide',
   heading: 'Gardez l’essentiel à portée de main',
   body: 'Les règles et les coûts évoluent. Recevez les informations pratiques pour travailler de l’autre côté de la frontière.',
   cta: 'Recevoir les nouveautés',
   newsletterHeading: 'Nouveautés pratiques pour les frontaliers',
   newsletterSubtitle: 'Guides, échéances et outils pour décider avec des données à jour.',
  },
 },
};

function normalizePath(inputPath: string): string {
 const withoutQuery = String(inputPath || '/').split(/[?#]/, 1)[0] || '/';
 const withLeadingSlash = withoutQuery.startsWith('/') ? withoutQuery : `/${withoutQuery}`;
 return withLeadingSlash.length > 1 && withLeadingSlash.endsWith('/')
  ? withLeadingSlash.slice(0, -1)
  : withLeadingSlash;
}

function withoutLocale(path: string): string {
 return path.replace(/^\/(en|de|fr)(?=\/|$)/i, '') || '/';
}

function startsWithAny(path: string, prefixes: readonly string[]): boolean {
 return prefixes.some((prefix) => path === prefix || path.startsWith(`${prefix}/`));
}

export function getContextualConversionContext(
 inputPath: string,
 locale: Locale,
): ContextualConversionContext | null {
 const localPath = withoutLocale(normalizePath(inputPath));
 const kind = startsWithAny(localPath, ['/prezzi-benzina', '/prezzi-diesel', '/fuel-prices', '/diesel-price-switzerland', '/benzinpreise', '/dieselpreise', '/prix-essence', '/prix-diesel'])
  ? 'fuel'
  : startsWithAny(localPath, ['/traffico-dogane', '/border-wait', '/grenzwartezeiten', '/temps-attente-frontiere'])
   ? 'border'
   : startsWithAny(localPath, ['/premi-cassa-malati', '/health-insurance-premiums', '/krankenkassenpraemien', '/primes-assurance-maladie'])
    ? 'health'
    : startsWithAny(localPath, ['/articoli-frontaliere', '/cross-border-articles', '/artikel-grenzgaenger', '/articles-frontaliers'])
     ? 'editorial'
     : startsWithAny(localPath, ['/guida-frontaliere', '/cross-border-guide', '/grenzgaenger-guide', '/guide-frontalier', '/tasse-e-pensione', '/taxes-and-pension', '/steuern-und-rente', '/impots-et-pension', '/vivere-in-ticino', '/living-in-ticino', '/leben-im-tessin', '/vivre-au-tessin'])
      ? 'guide'
      : null;

 return kind ? { kind, ...COPY[locale][kind] } : null;
}
