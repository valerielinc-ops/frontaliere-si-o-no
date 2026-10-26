/**
 * Static SEO copy for the SPA tabs that have no editorial of their own:
 * support (`feedback`), community (`forum`), gamification, personal profile
 * (`dashboard`), newsletter confirmation (`email-confirmed`) and the EN/DE/FR
 * metadata of the consulting page.
 *
 * Why. `staticPagesPlugin` renders one static HTML file per sitemap URL so a
 * crawler sees the page before the SPA hydrates. For these tabs nothing named
 * the page: the EN/DE/FR variants got a title-cased slug («Assistance |
 * Frontaliere Ticino»), the generic «… — outils gratuits et guides experts»
 * description, an H1 with the «(guide frontalier)» differentiator, and a body
 * made of the homepage editorial padded with the site-wide LOCALE_EDITORIAL —
 * the same twelve segments on every one of them. audit:information-gain
 * scored that body 0 % (cohort `fr:/fr/~83248f`, `de:/de/~5b78c1`, run
 * 2026-10-24); the Italian pages got the slug-interpolated generic fallback.
 *
 * What. Each tab gets, in all four locales, the facts its own component
 * implements (file references next to each block), so the static page
 * describes what the user can actually do there. Titles and H1s mirror the
 * SPA strings (`feedback.title`, `forum.title`, `gamification.pageTitle`,
 * `profile.title`, `emailConfirmed.title`); descriptions reuse
 * `seo.<id>.description` where that string is accurate.
 *
 * Consumers: `staticPagesPlugin.ts` (deriveLocaleSeo + the editorial chain of
 * buildPage). Measured by tests/spa-tab-static-content.test.ts.
 */

import { SECTION_LEGACY_TI_PATH } from './cantonSection';

export type SpaTabStaticId = 'feedback' | 'forum' | 'gamification' | 'dashboard' | 'emailConfirmed' | 'consulting';
export type SpaTabLocale = 'it' | 'en' | 'de' | 'fr';
export type SpaTabForeignLocale = Exclude<SpaTabLocale, 'it'>;

export interface SpaTabLocaleSeo {
  /** Title without the brand suffix (the caller applies buildTitleWithBrand). */
  readonly title: string;
  readonly h1: string;
  readonly desc: string;
}

/** Italian source path (no trailing slash) → tab. Same paths as services/seo/seo-pages.ts. */
const ITALIAN_PATH_TO_TAB: ReadonlyMap<string, SpaTabStaticId> = new Map([
  ['/supporto', 'feedback'],
  ['/community', 'forum'],
  ['/gamificazione', 'gamification'],
  ['/profilo', 'dashboard'],
  ['/benvenuto-frontaliere', 'emailConfirmed'],
  ['/consulenza', 'consulting'],
]);

/** Localized paths of the pages the copy links to (seeded sitemap hreflang groups). */
const PATHS: Record<
  'calculator' | 'jobs' | 'articles' | 'community' | 'consulting' | 'gamification' | 'privacy' | 'dataDeletion',
  Record<SpaTabLocale, string>
> = {
  calculator: { it: '/calcola-stipendio/', en: '/en/calculate-salary/', de: '/de/gehalt-berechnen/', fr: '/fr/calculer-salaire/' },
  jobs: SECTION_LEGACY_TI_PATH,
  articles: { it: '/articoli-frontaliere/', en: '/en/cross-border-articles/', de: '/de/grenzgaenger-artikel/', fr: '/fr/articles-frontalier/' },
  community: { it: '/community/', en: '/en/community/', de: '/de/gemeinschaft/', fr: '/fr/communaute/' },
  consulting: { it: '/consulenza/', en: '/en/consulting/', de: '/de/beratung/', fr: '/fr/consultation/' },
  gamification: { it: '/gamificazione/', en: '/en/gamification/', de: '/de/gamification/', fr: '/fr/gamification/' },
  privacy: { it: '/privacy/', en: '/en/privacy/', de: '/de/datenschutz/', fr: '/fr/confidentialite/' },
  dataDeletion: { it: '/eliminazione-dati/', en: '/en/data-deletion/', de: '/de/daten-loeschen/', fr: '/fr/suppression-donnees/' },
};

/** Every href the copy emits, for the link-resolution test. */
export const SPA_TAB_LINKED_PATHS: readonly string[] = Object.values(PATHS).flatMap((byLocale) => Object.values(byLocale));

const H2 = (text: string) => `<h2 class="s-o3IET6">${text}</h2>`;
const A = (href: string, label: string) => `<a class="s-U9K6Vf" href="${href}">${label}</a>`;

/** Resolve the tab from the Italian source path of a page (any slash form). */
export function resolveSpaTabStaticPage(italianPath: string): SpaTabStaticId | null {
  const clean = String(italianPath || '').split(/[?#]/)[0].replace(/\/+$/, '');
  return ITALIAN_PATH_TO_TAB.get(clean) ?? null;
}

const LOCALE_SEO: Record<SpaTabStaticId, Record<SpaTabForeignLocale, SpaTabLocaleSeo>> = {
  feedback: {
    en: {
      title: 'Help Us Improve: Bug Reports and Suggestions',
      h1: 'Reports and ideas for Frontaliere Ticino',
      desc: 'Help us improve Frontaliere Ticino: report a bug or suggest a new feature on GitHub and help shape the tax simulator built for cross-border workers.',
    },
    de: {
      title: 'Helfen Sie uns: Fehlermeldungen und Vorschläge',
      h1: 'Meldungen und Ideen für Frontaliere Ticino',
      desc: 'Hilf uns, Frontaliere Ticino zu verbessern: melde einen Fehler oder schlage eine neue Funktion auf GitHub vor und gestalte den Steuersimulator für Grenzgänger.',
    },
    fr: {
      title: 'Aidez-nous : signalements et suggestions',
      h1: 'Signalements et idées pour Frontaliere Ticino',
      desc: 'Aidez-nous à améliorer Frontaliere Ticino : signalez une erreur ou proposez une fonctionnalité sur GitHub et participez au simulateur fiscal pour frontaliers.',
    },
  },
  forum: {
    en: {
      title: 'Cross-Border Community: Questions and Answers',
      h1: 'Cross-Border Community',
      desc: 'Cross-border workers community forum: ask questions on taxes, permits, insurance, pensions and transport and get answers from people with hands-on experience.',
    },
    de: {
      title: 'Grenzgänger-Community: Fragen und Antworten',
      h1: 'Grenzgänger-Community',
      desc: 'Community-Forum der Grenzgänger: stelle Fragen zu Steuern, Bewilligungen, Versicherungen, Rente und Verkehr und erhalte Antworten von erfahrenen Grenzgängern.',
    },
    fr: {
      title: 'Communauté frontalière : questions et réponses',
      h1: 'Communauté frontalière',
      desc: 'Forum de la communauté des frontaliers : posez vos questions sur les impôts, permis, assurances, retraite et transports et obtenez des réponses d\'initiés.',
    },
  },
  gamification: {
    en: {
      title: 'Gamification: Levels, XP and Achievements',
      h1: 'Your progress on Frontaliere Ticino',
      desc: 'Gamification system for cross-border workers: earn XP by exploring the tax simulator, complete challenges and unlock levels while learning and having fun.',
    },
    de: {
      title: 'Gamification: Stufen, XP und Erfolge',
      h1: 'Deine Fortschritte auf Frontaliere Ticino',
      desc: 'Gamification für Grenzgänger: sammle XP-Punkte beim Erkunden des Steuersimulators, erfülle Ziele und schalte Stufen frei, während du lernst und Spass hast.',
    },
    fr: {
      title: 'Gamification : niveaux, XP et succès',
      h1: 'Vos progrès sur Frontaliere Ticino',
      desc: 'Système de gamification pour frontaliers : gagnez des points XP en explorant le simulateur fiscal, relevez des défis et débloquez des niveaux en vous amusant.',
    },
  },
  dashboard: {
    en: {
      title: 'Personal Dashboard for Cross-Border Workers',
      h1: 'Your cross-border worker profile',
      desc: 'Personal area for cross-border workers: save your profile and permit expiry, estimate your net salary, follow applications and saved jobs, export your data.',
    },
    de: {
      title: 'Persönliches Dashboard für Grenzgänger',
      h1: 'Ihr Grenzgänger-Profil',
      desc: 'Persönlicher Bereich für Grenzgänger: Profil und Bewilligungsablauf speichern, Nettolohn schätzen, Bewerbungen und Stellen verfolgen, Daten exportieren.',
    },
    fr: {
      title: 'Tableau de bord personnel du frontalier',
      h1: 'Votre profil de frontalier',
      desc: 'Espace personnel du frontalier : profil et échéance du permis, estimation du salaire net, candidatures et offres sauvegardées, export de vos données.',
    },
  },
  emailConfirmed: {
    en: {
      title: 'Welcome, Cross-Border Worker! Newsletter Confirmed',
      h1: 'Welcome, cross-border worker!',
      desc: 'Your Frontaliere Ticino newsletter subscription is confirmed: the weekly CHF/EUR rate, border traffic and news on salaries, taxes and jobs in Ticino.',
    },
    de: {
      title: 'Willkommen, Grenzgänger! Newsletter bestätigt',
      h1: 'Willkommen, Grenzgänger!',
      desc: 'Ihr Abonnement des Frontaliere Ticino Newsletters ist bestätigt: wöchentlich CHF/EUR-Kurs, Grenzverkehr und News zu Löhnen, Steuern und Stellen im Tessin.',
    },
    fr: {
      title: 'Bienvenue, frontalier ! Newsletter confirmée',
      h1: 'Bienvenue, frontalier !',
      desc: 'Abonnement à la newsletter Frontaliere Ticino confirmé : chaque semaine le taux CHF/EUR, le trafic aux frontières et l\'actualité salaires, impôts et emploi.',
    },
  },
  consulting: {
    en: {
      title: 'Tax Consulting for Cross-Border Workers 2026',
      h1: 'Tax consulting for Switzerland–Italy cross-border workers',
      desc: 'Tax consulting for cross-border workers: Switzerland–Italy tax optimisation, Italian tax return and choosing the tax regime under the new 2026 agreement.',
    },
    de: {
      title: 'Steuerberatung für Grenzgänger 2026',
      h1: 'Steuerberatung für Grenzgänger Schweiz–Italien',
      desc: 'Steuerberatung für Grenzgänger: Steueroptimierung Schweiz–Italien, italienische Steuererklärung und Wahl des Steuerregimes nach dem neuen Abkommen 2026.',
    },
    fr: {
      title: 'Conseil fiscal pour frontaliers 2026',
      h1: 'Conseil fiscal pour frontaliers Suisse–Italie',
      desc: 'Conseil fiscal pour frontaliers : optimisation fiscale Suisse–Italie, déclaration de revenus italienne et choix du régime fiscal selon le nouvel accord 2026.',
    },
  },
};

/** Title (pre-brand), H1 and meta description of an EN/DE/FR variant. */
export function spaTabLocaleSeo(id: SpaTabStaticId, locale: SpaTabForeignLocale): SpaTabLocaleSeo {
  return LOCALE_SEO[id][locale];
}

type EditorialBuilder = (p: Record<keyof typeof PATHS, string>) => string[];

/**
 * Page-specific editorial blocks. Facts and their source:
 *  - feedback:       components/community/FeedbackSection.tsx (types, required
 *                    title, reCAPTCHA, PII scrub, createFeedbackIssue → GitHub,
 *                    AI help, latest 10 issues).
 *  - forum:          components/community/CommunityForum.tsx +
 *                    services/firestoreService.ts (9 categories, filters/sort,
 *                    Google sign-in to post, one vote per user, accepted answer,
 *                    first-question/first-answer achievements).
 *  - gamification:   services/gamificationService.ts (31 achievements, +50 XP
 *                    each, 10 levels and thresholds, localStorage),
 *                    GamificationWidget.tsx (daily streak), quiz/survey/wizard
 *                    XP awards, services/frontaliereChecklist.ts (8 steps × 15 XP).
 *  - dashboard:      components/pages/UserProfile.tsx +
 *                    services/profileFirestore.ts (sign-in, saved fields, net
 *                    estimate, permit expiry, applications, saved jobs, JSON
 *                    export, account deletion).
 *  - emailConfirmed: components/pages/EmailConfirmed.tsx (confirmation + three
 *                    entry points) and the weekly newsletter it confirms.
 * `consulting` has no entry: its editorial already lives in SECTION_EDITORIAL
 * ('/consulenza') and in the Italian inline chain.
 */
const EDITORIAL: Partial<Record<SpaTabStaticId, Record<SpaTabLocale, EditorialBuilder>>> = {
  feedback: {
    it: (p) => [
      H2('Come funziona una segnalazione'),
      'Scegli se segnalare un errore oppure proporre una nuova funzionalità, scrivi un titolo e descrivi il caso: il titolo è l’unico campo obbligatorio. Prima dell’invio un controllo reCAPTCHA ferma i messaggi automatici e dal testo vengono tolti nomi, indirizzi e altri dati personali.',
      'Ogni segnalazione diventa una issue pubblica sul repository GitHub del sito. La crea una funzione lato server, quindi non servono un account GitHub né l’accesso a Frontaliere Ticino.',
      H2('Aiuto nella scrittura e segnalazioni recenti'),
      'Il pulsante «AI Help» riscrive la descrizione in un testo chiaro e ordinato prima dell’invio. Accanto al modulo trovi le ultime dieci segnalazioni, aperte e chiuse, con tipo, stato e data, e il collegamento all’elenco completo su GitHub.',
      `Questa pagina serve a migliorare gli strumenti del sito. Per una domanda sul tuo caso (imposta alla fonte, permessi, cassa malati) usa la ${A(p.community, 'community dei frontalieri')} o il servizio di ${A(p.consulting, 'consulenza')}.`,
    ],
    en: (p) => [
      H2('How a report works'),
      'Choose whether you are reporting a bug or suggesting a new feature, write a title and describe the case: the title is the only required field. Before sending, a reCAPTCHA check stops automated messages and names, addresses and other personal data are removed from the text.',
      'Every report becomes a public issue on the site’s GitHub repository. A server-side function creates it, so you need neither a GitHub account nor a Frontaliere Ticino login.',
      H2('Writing help and recent reports'),
      'The “AI Help” button rewrites your description into a clear, well-structured text before you send it. Next to the form you see the ten latest reports, open and closed, with type, status and date, plus a link to the full list on GitHub.',
      `This page is for improving the site’s tools. For a question about your own situation (withholding tax, permits, health insurance) use the ${A(p.community, 'cross-border community')} or the ${A(p.consulting, 'consulting service')}.`,
    ],
    de: (p) => [
      H2('So funktioniert eine Meldung'),
      'Wähle, ob du einen Fehler meldest oder eine neue Funktion vorschlägst, gib einen Titel ein und beschreibe den Fall: Der Titel ist das einzige Pflichtfeld. Vor dem Senden hält eine reCAPTCHA-Prüfung automatische Nachrichten auf, und Namen, Adressen und andere persönliche Daten werden aus dem Text entfernt.',
      'Jede Meldung wird zu einem öffentlichen Issue im GitHub-Repository der Website. Eine serverseitige Funktion legt es an, du brauchst also weder ein GitHub-Konto noch ein Login bei Frontaliere Ticino.',
      H2('Schreibhilfe und neueste Meldungen'),
      'Die Schaltfläche «AI Help» formuliert deine Beschreibung vor dem Senden in einen klaren, geordneten Text um. Neben dem Formular stehen die zehn neuesten Meldungen, offen und geschlossen, mit Typ, Status und Datum, dazu der Link zur vollständigen Liste auf GitHub.',
      `Diese Seite dient dazu, die Werkzeuge der Website zu verbessern. Für eine Frage zu deiner eigenen Situation (Quellensteuer, Bewilligungen, Krankenkasse) nutze die ${A(p.community, 'Grenzgänger-Community')} oder die ${A(p.consulting, 'Beratung')}.`,
    ],
    fr: (p) => [
      H2('Comment fonctionne un signalement'),
      'Choisissez si vous signalez une erreur ou proposez une nouvelle fonctionnalité, saisissez un titre et décrivez le cas : le titre est le seul champ obligatoire. Avant l’envoi, un contrôle reCAPTCHA bloque les messages automatiques et les noms, adresses et autres données personnelles sont retirés du texte.',
      'Chaque signalement devient une issue publique sur le dépôt GitHub du site. Une fonction côté serveur la crée : il ne faut ni compte GitHub ni connexion à Frontaliere Ticino.',
      H2('Aide à la rédaction et signalements récents'),
      'Le bouton « AI Help » reformule votre description en un texte clair et structuré avant l’envoi. À côté du formulaire figurent les dix derniers signalements, ouverts et fermés, avec type, statut et date, ainsi que le lien vers la liste complète sur GitHub.',
      `Cette page sert à améliorer les outils du site. Pour une question sur votre propre situation (impôt à la source, permis, assurance maladie), passez par la ${A(p.community, 'communauté des frontaliers')} ou par le ${A(p.consulting, 'service de conseil')}.`,
    ],
  },
  forum: {
    it: (p) => [
      H2('Domande e risposte tra frontalieri'),
      'La community raccoglie le domande in nove categorie: fiscalità, permessi, assicurazioni, pensione, trasporti, residenza, lavoro, famiglia e generale. Ogni domanda ha titolo, testo, categoria e tag; l’elenco si filtra per categoria e si ordina per le più recenti o le più votate.',
      'Leggere domande e risposte è libero. Per chiedere o rispondere serve l’accesso con un account Google.',
      H2('Voti e risposte accettate'),
      `Domande e risposte si votano, con un voto per utente che un secondo clic ritira, e una risposta può essere segnata come accettata. La prima domanda e la prima risposta sbloccano un traguardo nella pagina dei ${A(p.gamification, 'progressi')}.`,
      `Le risposte arrivano da altri frontalieri, non da consulenti: per un caso fiscale personale verifica i numeri con il ${A(p.calculator, 'calcolatore dello stipendio netto')} o chiedi una ${A(p.consulting, 'consulenza')}.`,
    ],
    en: (p) => [
      H2('Questions and answers between cross-border workers'),
      'The community groups questions into nine categories: taxation, permits, insurance, pensions, transport, residence, work, family and general. Each question has a title, a body, a category and tags; the list can be filtered by category and sorted by newest or most voted.',
      'Reading questions and answers is open to everyone. Asking or answering requires signing in with a Google account.',
      H2('Votes and accepted answers'),
      `Questions and answers can be upvoted, one vote per user, and a second click withdraws it; an answer can be marked as accepted. Your first question and your first answer each unlock an achievement on the ${A(p.gamification, 'progress page')}.`,
      `Answers come from other cross-border workers, not from advisers: for a personal tax case check the figures with the ${A(p.calculator, 'net salary calculator')} or ask for ${A(p.consulting, 'consulting')}.`,
    ],
    de: (p) => [
      H2('Fragen und Antworten unter Grenzgängern'),
      'Die Community ordnet Fragen in neun Kategorien: Steuern, Bewilligungen, Versicherungen, Rente, Verkehr, Wohnsitz, Arbeit, Familie und Allgemeines. Jede Frage hat Titel, Text, Kategorie und Tags; die Liste lässt sich nach Kategorie filtern und nach neuesten oder meistbewerteten Beiträgen sortieren.',
      'Fragen und Antworten lesen kann jeder. Um zu fragen oder zu antworten, ist die Anmeldung mit einem Google-Konto nötig.',
      H2('Stimmen und akzeptierte Antworten'),
      `Fragen und Antworten lassen sich bewerten, eine Stimme pro Nutzer, die ein zweiter Klick zurücknimmt, und eine Antwort kann als akzeptiert markiert werden. Die erste Frage und die erste Antwort schalten je einen Erfolg auf der ${A(p.gamification, 'Fortschrittsseite')} frei.`,
      `Die Antworten stammen von anderen Grenzgängern, nicht von Beratern: Prüfe einen persönlichen Steuerfall mit dem ${A(p.calculator, 'Nettolohnrechner')} oder frage eine ${A(p.consulting, 'Beratung')} an.`,
    ],
    fr: (p) => [
      H2('Questions et réponses entre frontaliers'),
      'La communauté classe les questions en neuf catégories : fiscalité, permis, assurances, retraite, transports, résidence, travail, famille et général. Chaque question a un titre, un texte, une catégorie et des tags ; la liste se filtre par catégorie et se trie par plus récentes ou plus votées.',
      'La lecture des questions et des réponses est libre. Pour poser une question ou répondre, il faut se connecter avec un compte Google.',
      H2('Votes et réponses acceptées'),
      `Questions et réponses se votent, à raison d’un vote par utilisateur qu’un second clic retire, et une réponse peut être marquée comme acceptée. La première question et la première réponse débloquent chacune un succès sur la ${A(p.gamification, 'page des progrès')}.`,
      `Les réponses viennent d’autres frontaliers, pas de conseillers : pour un cas fiscal personnel, vérifiez les chiffres avec le ${A(p.calculator, 'calculateur de salaire net')} ou demandez un ${A(p.consulting, 'conseil')}.`,
    ],
  },
  gamification: {
    it: (p) => [
      H2('Livelli, XP e traguardi'),
      'I progressi si misurano in punti esperienza (XP) su dieci livelli: Novizio (0 XP), Esploratore (100), Viaggiatore (250), Pendolare (500), Veterano (800), Esperto (1200), Maestro (1700), Guru (2300), Leggenda (3000) e Frontaliere DOC (4000).',
      'I traguardi sono 31, in quattro categorie: esploratore (8), calcolatore (5), esperto (7) e social (11). Ognuno vale 50 XP; alcuni chiedono azioni ripetute, per esempio usare più volte i comparatori o il simulatore.',
      H2('Come si guadagnano gli XP'),
      'La prima visita del giorno vale 10 XP; nei giorni consecutivi il premio cresce di 10 XP per ogni giorno di serie, fino a 70 XP. Altri punti arrivano dal quiz settimanale (20, 50 o 100 XP), dal sondaggio sugli stipendi (30 XP), dal quiz sullo stipendio (20 XP), dal test «Sei pronto a diventare frontaliere?» (20 XP) e dalla guida al primo giorno di lavoro (25 XP).',
      'La checklist «Il tuo percorso da frontaliere» ha otto tappe da 15 XP ciascuna — permesso G, contratto, conto in franchi, LAMal, dogana e targa, imposta alla fonte, prima busta paga, primo giorno — e completarle tutte sblocca un traguardo dedicato.',
      `I progressi sono salvati nella memoria locale del browser: non serve un account, e cancellando i dati del browser si riparte da zero. Un buon inizio è il ${A(p.calculator, 'calcolatore dello stipendio netto')}.`,
    ],
    en: (p) => [
      H2('Levels, XP and achievements'),
      'Progress is measured in experience points (XP) across ten levels, shown with their Italian names: Novizio (0 XP), Esploratore (100), Viaggiatore (250), Pendolare (500), Veterano (800), Esperto (1,200), Maestro (1,700), Guru (2,300), Leggenda (3,000) and Frontaliere DOC (4,000).',
      'There are 31 achievements in four categories: explorer (8), calculator (5), expert (7) and social (11). Each one is worth 50 XP; some need repeated actions, such as using the comparators or the simulator several times.',
      H2('How to earn XP'),
      'The first visit of the day is worth 10 XP; on consecutive days the reward grows by 10 XP per day of the streak, up to 70 XP. More points come from the weekly quiz (20, 50 or 100 XP), the salary survey (30 XP), the salary quiz (20 XP), the “Ready to become a cross-border worker?” wizard (20 XP) and the first-day-at-work guide (25 XP).',
      'The “Your path to becoming a cross-border worker” checklist has eight steps worth 15 XP each — G permit, contract, CHF account, LAMal, customs and number plate, withholding tax, first payslip, first day — and completing all of them unlocks a dedicated achievement.',
      `Progress is stored in your browser’s local storage: no account is needed, and clearing the browser data starts you over. A good first step is the ${A(p.calculator, 'net salary calculator')}.`,
    ],
    de: (p) => [
      H2('Stufen, XP und Erfolge'),
      'Der Fortschritt wird in Erfahrungspunkten (XP) über zehn Stufen gemessen, die ihre italienischen Namen tragen: Novizio (0 XP), Esploratore (100), Viaggiatore (250), Pendolare (500), Veterano (800), Esperto (1200), Maestro (1700), Guru (2300), Leggenda (3000) und Frontaliere DOC (4000).',
      'Es gibt 31 Erfolge in vier Kategorien: Entdecker (8), Rechner (5), Experte (7) und Social (11). Jeder bringt 50 XP; manche verlangen wiederholte Aktionen, etwa die Vergleiche oder den Simulator mehrmals zu nutzen.',
      H2('So sammelst du XP'),
      'Der erste Besuch des Tages bringt 10 XP; an aufeinanderfolgenden Tagen steigt die Belohnung um 10 XP pro Tag der Serie, bis zu 70 XP. Weitere Punkte gibt es für das Wochenquiz (20, 50 oder 100 XP), die Lohnumfrage (30 XP), das Lohnquiz (20 XP), den Assistenten «Bereit, Grenzgänger zu werden?» (20 XP) und den Leitfaden zum ersten Arbeitstag (25 XP).',
      'Die Checkliste «Ihr Weg zum Grenzgänger» hat acht Schritte zu je 15 XP — G-Bewilligung, Vertrag, CHF-Konto, KVG, Zoll und Kennzeichen, Quellensteuer, erste Lohnabrechnung, erster Arbeitstag —, und wer alle abschliesst, schaltet einen eigenen Erfolg frei.',
      `Der Fortschritt liegt im lokalen Speicher deines Browsers: Ein Konto ist nicht nötig, und wer die Browserdaten löscht, beginnt von vorn. Ein guter Einstieg ist der ${A(p.calculator, 'Nettolohnrechner')}.`,
    ],
    fr: (p) => [
      H2('Niveaux, XP et succès'),
      'La progression se mesure en points d’expérience (XP) sur dix niveaux, affichés sous leur nom italien : Novizio (0 XP), Esploratore (100), Viaggiatore (250), Pendolare (500), Veterano (800), Esperto (1200), Maestro (1700), Guru (2300), Leggenda (3000) et Frontaliere DOC (4000).',
      'Il existe 31 succès répartis en quatre catégories : explorateur (8), calculateur (5), expert (7) et social (11). Chacun rapporte 50 XP ; certains demandent des actions répétées, par exemple utiliser plusieurs fois les comparateurs ou le simulateur.',
      H2('Comment gagner des XP'),
      'La première visite de la journée vaut 10 XP ; les jours consécutifs, la récompense augmente de 10 XP par jour de série, jusqu’à 70 XP. D’autres points viennent du quiz hebdomadaire (20, 50 ou 100 XP), de l’enquête sur les salaires (30 XP), du quiz sur le salaire (20 XP), de l’assistant « Prêt à devenir frontalier ? » (20 XP) et du guide du premier jour de travail (25 XP).',
      'La checklist « Votre parcours pour devenir frontalier » compte huit étapes de 15 XP chacune — permis G, contrat, compte en francs, LAMal, douane et plaques, impôt à la source, première fiche de paie, premier jour — et les terminer toutes débloque un succès dédié.',
      `La progression est enregistrée dans le stockage local du navigateur : aucun compte n’est nécessaire, et effacer les données du navigateur remet tout à zéro. Un bon point de départ est le ${A(p.calculator, 'calculateur de salaire net')}.`,
    ],
  },
  dashboard: {
    it: (p) => [
      H2('Cosa contiene il profilo'),
      'L’area personale richiede l’accesso con Google, o con LinkedIn quando è attivo. Il profilo conserva professione, età, situazione familiare, tipo di frontaliere (permesso G o B), comune di residenza, figli e familiari, luogo di lavoro, valico preferito, lingua, stipendio lordo in franchi e scadenza del permesso.',
      'Con questi dati la pagina mostra una stima rapida dello stipendio netto, una barra di completezza del profilo e il promemoria sulla scadenza del permesso, oltre alle candidature inviate, alle offerte di lavoro salvate e alle preferenze su email e notifiche.',
      H2('I tuoi dati, sotto il tuo controllo'),
      `Il profilo è salvato nel tuo account con una copia locale nel browser. Puoi scaricare in ogni momento un file JSON con profilo, traguardi e preferenze, oppure eliminare l’account: la cancellazione rimuove i dati salvati, la copia locale e l’utente di accesso. I dettagli sono nell’${A(p.privacy, 'informativa privacy')} e nella pagina ${A(p.dataDeletion, 'eliminazione dati')}.`,
      `Senza accesso puoi usare comunque il ${A(p.calculator, 'calcolatore dello stipendio netto')} e la ${A(p.jobs, 'bacheca delle offerte di lavoro in Ticino')}.`,
    ],
    en: (p) => [
      H2('What the profile holds'),
      'The personal area requires signing in with Google, or with LinkedIn when it is enabled. The profile keeps your job title, age, family situation, cross-border status (G or B permit), municipality of residence, children and family members, workplace, preferred border crossing, language, gross salary in CHF and permit expiry date.',
      'With this data the page shows a quick net salary estimate, a profile completeness bar and a reminder of your permit expiry, together with the applications you sent, the jobs you saved and your email and notification preferences.',
      H2('Your data, under your control'),
      `The profile is stored in your account with a local copy in the browser. At any time you can download a JSON file with your profile, achievements and preferences, or delete the account: deletion removes the saved data, the local copy and the sign-in user. Details are in the ${A(p.privacy, 'privacy policy')} and on the ${A(p.dataDeletion, 'data deletion page')}.`,
      `Without signing in you can still use the ${A(p.calculator, 'net salary calculator')} and the ${A(p.jobs, 'Ticino job board')}.`,
    ],
    de: (p) => [
      H2('Was das Profil enthält'),
      'Der persönliche Bereich erfordert die Anmeldung mit Google oder, sofern aktiviert, mit LinkedIn. Das Profil speichert Beruf, Alter, Familiensituation, Grenzgängerstatus (G- oder B-Bewilligung), Wohngemeinde, Kinder und Familienangehörige, Arbeitsort, bevorzugten Grenzübergang, Sprache, Bruttolohn in CHF und Ablaufdatum der Bewilligung.',
      'Mit diesen Daten zeigt die Seite eine schnelle Nettolohnschätzung, einen Balken zur Vollständigkeit des Profils und eine Erinnerung an den Ablauf der Bewilligung, dazu die gesendeten Bewerbungen, die gemerkten Stellen und die Einstellungen zu E-Mail und Benachrichtigungen.',
      H2('Ihre Daten, unter Ihrer Kontrolle'),
      `Das Profil wird in Ihrem Konto gespeichert, mit einer lokalen Kopie im Browser. Jederzeit können Sie eine JSON-Datei mit Profil, Erfolgen und Einstellungen herunterladen oder das Konto löschen: Die Löschung entfernt die gespeicherten Daten, die lokale Kopie und den Anmeldenutzer. Einzelheiten stehen in der ${A(p.privacy, 'Datenschutzerklärung')} und auf der Seite ${A(p.dataDeletion, 'Daten löschen')}.`,
      `Ohne Anmeldung nutzen Sie weiterhin den ${A(p.calculator, 'Nettolohnrechner')} und die ${A(p.jobs, 'Stellenbörse im Tessin')}.`,
    ],
    fr: (p) => [
      H2('Ce que contient le profil'),
      'L’espace personnel nécessite une connexion avec Google, ou avec LinkedIn lorsqu’il est activé. Le profil conserve profession, âge, situation familiale, statut de frontalier (permis G ou B), commune de résidence, enfants et membres de la famille, lieu de travail, passage de frontière préféré, langue, salaire brut en francs et date d’échéance du permis.',
      'Avec ces données, la page affiche une estimation rapide du salaire net, une barre de complétude du profil et un rappel de l’échéance du permis, ainsi que les candidatures envoyées, les offres sauvegardées et les préférences d’e-mail et de notifications.',
      H2('Vos données, sous votre contrôle'),
      `Le profil est enregistré dans votre compte avec une copie locale dans le navigateur. Vous pouvez à tout moment télécharger un fichier JSON avec profil, succès et préférences, ou supprimer le compte : la suppression efface les données enregistrées, la copie locale et l’utilisateur de connexion. Les détails figurent dans la ${A(p.privacy, 'politique de confidentialité')} et sur la page ${A(p.dataDeletion, 'suppression des données')}.`,
      `Sans connexion, vous pouvez toujours utiliser le ${A(p.calculator, 'calculateur de salaire net')} et la ${A(p.jobs, 'bourse de l’emploi au Tessin')}.`,
    ],
  },
  emailConfirmed: {
    it: (p) => [
      H2('Iscrizione alla newsletter confermata'),
      'Questa pagina si apre dal link di conferma della newsletter di Frontaliere Ticino. Da qui l’indirizzo è iscritto e riceve il riepilogo settimanale con il cambio CHF/EUR, il traffico ai valichi e le novità su stipendi, tasse e offerte di lavoro in Ticino.',
      'Ogni email contiene il collegamento per gestire le preferenze o annullare l’iscrizione, senza bisogno di un account.',
      H2('Da dove iniziare'),
      `Tre punti di partenza: il ${A(p.calculator, 'calcolatore dello stipendio netto')} per capire quanto resta in tasca, la ${A(p.jobs, 'bacheca delle offerte di lavoro in Ticino')} e l’${A(p.articles, 'archivio degli articoli per frontalieri')}, aggiornato con le regole del nuovo accordo fiscale.`,
    ],
    en: (p) => [
      H2('Newsletter subscription confirmed'),
      'This page opens from the confirmation link of the Frontaliere Ticino newsletter. From now on the address is subscribed and receives the weekly summary with the CHF/EUR rate, border crossing traffic and news on salaries, taxes and job offers in Ticino.',
      'Every email contains the link to manage your preferences or unsubscribe, with no account needed.',
      H2('Where to start'),
      `Three starting points: the ${A(p.calculator, 'net salary calculator')} to see what you actually take home, the ${A(p.jobs, 'Ticino job board')} and the ${A(p.articles, 'cross-border worker articles')}, kept up to date with the rules of the new tax agreement.`,
    ],
    de: (p) => [
      H2('Newsletter-Anmeldung bestätigt'),
      'Diese Seite öffnet sich über den Bestätigungslink des Frontaliere Ticino Newsletters. Ab jetzt ist die Adresse angemeldet und erhält die wöchentliche Zusammenfassung mit CHF/EUR-Kurs, Verkehr an den Grenzübergängen und Neuigkeiten zu Löhnen, Steuern und Stellenangeboten im Tessin.',
      'Jede E-Mail enthält den Link, um die Einstellungen zu verwalten oder sich abzumelden, ohne dass ein Konto nötig ist.',
      H2('Wo Sie anfangen'),
      `Drei Einstiege: der ${A(p.calculator, 'Nettolohnrechner')}, um zu sehen, was netto bleibt, die ${A(p.jobs, 'Stellenbörse im Tessin')} und die ${A(p.articles, 'Grenzgänger-Artikel')}, aktuell nach den Regeln des neuen Steuerabkommens.`,
    ],
    fr: (p) => [
      H2('Abonnement à la newsletter confirmé'),
      'Cette page s’ouvre depuis le lien de confirmation de la newsletter Frontaliere Ticino. Désormais l’adresse est abonnée et reçoit le résumé hebdomadaire avec le taux CHF/EUR, le trafic aux passages de frontière et l’actualité des salaires, des impôts et des offres d’emploi au Tessin.',
      'Chaque e-mail contient le lien pour gérer vos préférences ou vous désabonner, sans compte nécessaire.',
      H2('Par où commencer'),
      `Trois points de départ : le ${A(p.calculator, 'calculateur de salaire net')} pour voir ce qui reste réellement, la ${A(p.jobs, 'bourse de l’emploi au Tessin')} et les ${A(p.articles, 'articles pour frontaliers')}, tenus à jour avec les règles du nouvel accord fiscal.`,
    ],
  },
};

/**
 * Page-specific editorial blocks of a tab in `locale`, or `null` when the tab
 * has none here (consulting: SECTION_EDITORIAL owns it).
 */
export function renderSpaTabEditorial(id: SpaTabStaticId, locale: SpaTabLocale): string[] | null {
  const build = EDITORIAL[id]?.[locale];
  if (!build) return null;
  const paths = Object.fromEntries(
    (Object.keys(PATHS) as Array<keyof typeof PATHS>).map((key) => [key, PATHS[key][locale]]),
  ) as Record<keyof typeof PATHS, string>;
  return build(paths);
}
