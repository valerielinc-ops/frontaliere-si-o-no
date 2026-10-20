export interface CorrectionsLog {
  policy: { contactEmail: string };
  entries: { date: string; articleId: string; type: string; description: string }[];
}

/** Shared public copy for static and React corrections pages. */
export type CorrectionsLocale = 'it' | 'en' | 'de' | 'fr';
export const CORRECTIONS_PATHS = { it: '/correzioni/', en: '/en/corrections/', de: '/de/korrekturen/', fr: '/fr/corrections/' } as const;
export const CORRECTIONS_COPY = {
  it: {
    title: 'Correzioni', subtitle: 'Politica di rettifica e registro pubblico', home: 'Torna alla Home',
    description: 'Come segnalare un errore a Frontaliere Ticino e consultare le rettifiche presenti nel registro pubblico.',
    intro: 'Questa pagina raccoglie le informazioni per segnalare un errore e le rettifiche inserite nel registro pubblico di Frontaliere Ticino. Ogni voce disponibile indica la data, la pagina interessata, il tipo di correzione e una descrizione della modifica.',
    report: 'Come segnalare un errore', contact: 'Per segnalare un errore scrivi a',
    requirements: ['URL della pagina o titolo dell’articolo', 'Frase o dato contestato, riportato esattamente', 'Fonte verificabile, preferibilmente un documento o un dato ufficiale'],
    handling: 'Verifica delle segnalazioni', handlingText: 'Una segnalazione può richiedere il confronto con documenti, norme o dati ufficiali. I tempi dipendono dalla verifica necessaria: questa pagina non garantisce una risposta o una correzione entro un termine fisso.',
    typesTitle: 'Tipologie di correzione', labels: { factual: 'Errore fattuale', typo: 'Refuso', clarification: 'Chiarimento' },
    types: { factual: 'Dato, citazione o affermazione errata che modifica il contenuto.', typo: 'Errore di scrittura o formattazione.', clarification: 'Precisazione o contesto aggiuntivo per rendere il testo più chiaro.' },
    log: 'Registro pubblico delle correzioni', empty: 'Nessuna correzione registrata finora. Un registro vuoto non dimostra che tutti i contenuti siano privi di errori.',
    article: 'Pagina o articolo', sourceNote: 'Le descrizioni delle singole rettifiche sono riportate nella lingua del registro originale.',
  },
  en: {
    title: 'Corrections', subtitle: 'Corrections policy and public log', home: 'Back to home',
    description: 'How to report an error to Frontaliere Ticino and read the corrections recorded in the public log.',
    intro: 'This page explains how to report an error and lists the corrections entered in the Frontaliere Ticino public log. Each available entry identifies the date, the affected page, the correction type and a description of the change.',
    report: 'How to report an error', contact: 'To report an error, write to',
    requirements: ['Page URL or article title', 'The exact statement or figure you are questioning', 'A verifiable source, preferably an official document or dataset'],
    handling: 'Checking reports', handlingText: 'A report may require comparison with documents, legislation or official data. The time needed depends on those checks: this page does not guarantee a response or correction within a fixed deadline.',
    typesTitle: 'Correction types', labels: { factual: 'Factual error', typo: 'Typo', clarification: 'Clarification' },
    types: { factual: 'An incorrect figure, quotation or statement that changes the content.', typo: 'A spelling or formatting error.', clarification: 'Additional context or precision that makes the text clearer.' },
    log: 'Public corrections log', empty: 'No corrections have been recorded yet. An empty log does not establish that all content is free from errors.',
    article: 'Page or article', sourceNote: 'Individual correction descriptions are shown in the language of the original log.',
  },
  de: {
    title: 'Korrekturen', subtitle: 'Korrekturrichtlinie und öffentliches Register', home: 'Zur Startseite',
    description: 'So melden Sie Frontaliere Ticino einen Fehler und lesen die im öffentlichen Register erfassten Korrekturen.',
    intro: 'Diese Seite erklärt, wie Sie einen Fehler melden können, und zeigt die im öffentlichen Register von Frontaliere Ticino erfassten Korrekturen. Jeder vorhandene Eintrag enthält das Datum, die betroffene Seite, die Art der Korrektur und eine Beschreibung der Änderung.',
    report: 'Einen Fehler melden', contact: 'Um einen Fehler zu melden, schreiben Sie an',
    requirements: ['URL der Seite oder Titel des Artikels', 'Die beanstandete Aussage oder Zahl im genauen Wortlaut', 'Eine überprüfbare Quelle, möglichst ein amtliches Dokument oder ein offizieller Datensatz'],
    handling: 'Prüfung der Meldungen', handlingText: 'Eine Meldung kann einen Abgleich mit Dokumenten, Vorschriften oder amtlichen Daten erfordern. Die Bearbeitungszeit hängt von dieser Prüfung ab: Diese Seite garantiert keine Antwort oder Korrektur innerhalb einer festen Frist.',
    typesTitle: 'Arten von Korrekturen', labels: { factual: 'Sachlicher Fehler', typo: 'Tippfehler', clarification: 'Klarstellung' },
    types: { factual: 'Eine falsche Zahl, ein falsches Zitat oder eine Aussage, die den Inhalt verändert.', typo: 'Ein Schreib- oder Formatierungsfehler.', clarification: 'Zusätzlicher Kontext oder eine Präzisierung, die den Text verständlicher macht.' },
    log: 'Öffentliches Korrekturregister', empty: 'Bisher wurden keine Korrekturen erfasst. Ein leeres Register belegt nicht, dass sämtliche Inhalte fehlerfrei sind.',
    article: 'Seite oder Artikel', sourceNote: 'Die Beschreibungen einzelner Korrekturen erscheinen in der Sprache des ursprünglichen Registers.',
  },
  fr: {
    title: 'Corrections', subtitle: 'Politique de rectification et registre public', home: 'Retour à l’accueil',
    description: 'Comment signaler une erreur à Frontaliere Ticino et consulter les rectifications inscrites au registre public.',
    intro: 'Cette page explique comment signaler une erreur et présente les rectifications inscrites au registre public de Frontaliere Ticino. Chaque entrée disponible indique la date, la page concernée, le type de correction et une description de la modification.',
    report: 'Signaler une erreur', contact: 'Pour signaler une erreur, écrivez à',
    requirements: ['URL de la page ou titre de l’article', 'La phrase ou la donnée contestée, citée exactement', 'Une source vérifiable, de préférence un document ou des données officiels'],
    handling: 'Vérification des signalements', handlingText: 'Un signalement peut nécessiter une comparaison avec des documents, des textes réglementaires ou des données officielles. Le délai dépend de cette vérification : cette page ne garantit pas une réponse ou une correction dans un délai fixe.',
    typesTitle: 'Types de correction', labels: { factual: 'Erreur factuelle', typo: 'Faute de frappe', clarification: 'Clarification' },
    types: { factual: 'Une donnée, une citation ou une affirmation erronée qui modifie le contenu.', typo: 'Une erreur de rédaction ou de mise en forme.', clarification: 'Un complément de contexte ou une précision qui rend le texte plus clair.' },
    log: 'Registre public des corrections', empty: 'Aucune correction n’a encore été enregistrée. Un registre vide ne prouve pas que tous les contenus sont exempts d’erreurs.',
    article: 'Page ou article', sourceNote: 'Les descriptions des rectifications individuelles sont présentées dans la langue du registre original.',
  },
} as const;
