/** Shared editorial disclosure: the static page and SPA must describe the same process. */
export type MethodologyLocale = 'it' | 'en' | 'de' | 'fr';
interface MethodologyCopy {
  title: string;
  description: string;
  back: string;
  links: string;
  about: string;
  corrections: string;
  sections: { id: string; title: string; paragraphs: string[] }[];
}
export const METHODOLOGY_PATHS: Record<MethodologyLocale, string> = {
  it: '/metodologia/', en: '/en/methodology/', de: '/de/methodik/', fr: '/fr/methodologie/',
};
export const METHODOLOGY_COPY: Record<MethodologyLocale, MethodologyCopy> = {
  it: {
    title: 'Metodologia editoriale — Come scriviamo gli articoli',
    description: 'Come Frontaliere Ticino usa fonti, generazione assistita da IA e controlli automatici. Limiti della revisione, aggiornamenti e segnalazioni di errori.',
    back: 'Torna alla Home', links: 'Pagine collegate', about: 'Chi siamo', corrections: 'Registro delle correzioni',
    sections: [
      { id: 'process', title: 'Produzione e pubblicazione', paragraphs: [
        'Frontaliere Ticino pubblica guide, simulazioni e notizie per i lavoratori frontalieri tra Italia e Svizzera. Il processo comprende raccolta delle fonti, preparazione di bozze con assistenza automatica, controlli tecnici e pubblicazione. Le verifiche redazionali e le correzioni possono avvenire anche dopo la pubblicazione.',
        'La firma di un articolo identifica l’autore o la redazione indicati, ma non certifica da sola una revisione umana di ogni affermazione. Per capire il fondamento di una notizia, consulta le fonti collegate nel testo e le eventuali note di attribuzione.',
      ] },
      { id: 'ai', title: 'Assistenza automatica e suoi limiti', paragraphs: [
        'Usiamo modelli linguistici, tra cui Claude di Anthropic e GPT di OpenAI, per preparare bozze, strutturare i testi e tradurli in italiano, inglese, tedesco e francese. La pipeline può pubblicare contenuti generati automaticamente dopo i controlli tecnici. Non dichiariamo una revisione umana preventiva per ogni articolo.',
        'Le istruzioni di generazione richiedono di basarsi sulle fonti fornite. Queste istruzioni e i controlli automatici non garantiscono l’assenza di errori: un testo può contenere interpretazioni inesatte, riferimenti incompleti o traduzioni imprecise. Non applichiamo una percentuale garantita di riscrittura umana.',
      ] },
      { id: 'sources', title: 'Fonti e attribuzione', paragraphs: [
        'Privilegiamo fonti primarie per norme, importi e scadenze: autorità fiscali, enti previdenziali, uffici di statistica, testi normativi e decisioni giudiziarie. Le notizie possono basarsi anche su fonti giornalistiche o comunicati di organizzazioni, attribuiti e collegati nel testo.',
        'Una notizia riportata non equivale a una verifica indipendente della fonte primaria. Quando un articolo riporta la posizione di un’organizzazione o una vicenda ancora aperta, tale attribuzione non va interpretata come una decisione definitiva dell’autorità competente.',
      ] },
      { id: 'fact-checking', title: 'Verifiche e uso delle informazioni', paragraphs: [
        'I controlli automatici aiutano a individuare incoerenze e fonti mancanti. Non equivalgono a una verifica umana né a un parere fiscale, legale o previdenziale. Per aliquote, importi, requisiti e scadenze, il riferimento resta il documento ufficiale applicabile al tuo caso.',
        'Le simulazioni aiutano a confrontare scenari e dipendono dai dati inseriti e dalle ipotesi indicate. Prima di prendere una decisione personale, verifica i parametri con l’autorità competente o un professionista qualificato.',
      ] },
      { id: 'corrections', title: 'Aggiornamenti e correzioni', paragraphs: [
        'Una modifica normativa o una segnalazione può richiedere l’aggiornamento di un articolo. Una correzione rettifica invece un errore nel contenuto pubblicato. Le date e le note disponibili sulla pagina aiutano a ricostruire le modifiche; la data non certifica da sola una nuova verifica completa.',
        'Per segnalare un errore, indica l’URL, il passaggio contestato e una fonte verificabile nel messaggio alla redazione. Il registro delle correzioni raccoglie le rettifiche documentate. La possibilità di segnalare un problema non costituisce una garanzia di esattezza del contenuto già pubblicato.',
      ] },
    ],
  },
  en: {
    title: 'Editorial methodology — How we write articles',
    description: 'How Frontaliere Ticino uses sources, AI-assisted drafting and automated checks. Review limitations, updates and reporting errors.',
    back: 'Back to home', links: 'Related pages', about: 'About us', corrections: 'Corrections log',
    sections: [
      { id: 'process', title: 'Production and publication', paragraphs: [
        'Frontaliere Ticino publishes guides, simulations and news for cross-border workers between Italy and Switzerland. The process includes gathering sources, preparing drafts with automated assistance, technical checks and publication. Editorial checks and corrections may also take place after publication.',
        'An article’s byline identifies the named author or editorial team, but does not by itself certify human review of every claim. To understand the basis of a news story, consult its linked sources and any attribution notes.',
      ] },
      { id: 'ai', title: 'Automated assistance and its limitations', paragraphs: [
        'We use language models, including Anthropic’s Claude and OpenAI’s GPT, to prepare drafts, structure text and translate it into Italian, English, German and French. The pipeline can publish automatically generated content after technical checks. We do not claim human review before publication for every article.',
        'Generation instructions require the use of supplied sources. These instructions and automated checks do not guarantee error-free content: text may contain inaccurate interpretations, incomplete references or imprecise translations. We do not guarantee a percentage of human rewriting.',
      ] },
      { id: 'sources', title: 'Sources and attribution', paragraphs: [
        'We prioritise primary sources for rules, amounts and deadlines: tax authorities, social security institutions, statistical offices, legislation and court decisions. News may also rely on journalistic sources or statements from organisations, attributed and linked in the text.',
        'Reporting a story does not amount to independent verification of its primary source. When an article reports an organisation’s position or an ongoing case, that attribution should not be understood as a final decision by the competent authority.',
      ] },
      { id: 'fact-checking', title: 'Checks and use of information', paragraphs: [
        'Automated checks help identify inconsistencies and missing sources. They are not equivalent to human verification or tax, legal or pension advice. For rates, amounts, requirements and deadlines, the applicable official document remains the reference for your circumstances.',
        'Simulations help compare scenarios and depend on the data entered and stated assumptions. Before making a personal decision, check the parameters with the competent authority or a qualified professional.',
      ] },
      { id: 'corrections', title: 'Updates and corrections', paragraphs: [
        'A regulatory change or a reader’s report may require an article to be updated. A correction rectifies an error in published content. Dates and notes available on a page help track changes; a date alone does not certify a new, complete review.',
        'To report an error, include the URL, the disputed passage and a verifiable source in your message to the editorial team. The corrections log records documented corrections. Being able to report a problem does not guarantee that previously published content is accurate.',
      ] },
    ],
  },
  de: {
    title: 'Redaktionelle Methodik — Wie unsere Artikel entstehen',
    description: 'Wie Frontaliere Ticino Quellen, KI-gestützte Entwürfe und automatische Prüfungen nutzt. Grenzen der Prüfung, Aktualisierungen und Fehlermeldungen.',
    back: 'Zur Startseite', links: 'Verwandte Seiten', about: 'Über uns', corrections: 'Korrekturverzeichnis',
    sections: [
      { id: 'process', title: 'Erstellung und Veröffentlichung', paragraphs: [
        'Frontaliere Ticino veröffentlicht Ratgeber, Simulationen und Nachrichten für Grenzgänger zwischen Italien und der Schweiz. Der Prozess umfasst die Sammlung von Quellen, automatisch unterstützte Entwürfe, technische Prüfungen und die Veröffentlichung. Redaktionelle Prüfungen und Korrekturen können auch nach der Veröffentlichung stattfinden.',
        'Die Autorenangabe nennt den Autor oder die Redaktion, bestätigt aber für sich allein keine menschliche Prüfung jeder Aussage. Um die Grundlage einer Nachricht nachzuvollziehen, lesen Sie die verlinkten Quellen und gegebenenfalls die Hinweise zur Zuschreibung.',
      ] },
      { id: 'ai', title: 'Automatische Unterstützung und ihre Grenzen', paragraphs: [
        'Wir verwenden Sprachmodelle, darunter Claude von Anthropic und GPT von OpenAI, um Entwürfe zu erstellen, Texte zu strukturieren und ins Italienische, Englische, Deutsche und Französische zu übersetzen. Die Pipeline kann automatisch erzeugte Inhalte nach technischen Prüfungen veröffentlichen. Wir behaupten nicht, dass jeder Artikel vorab von Menschen geprüft wird.',
        'Die Generierungsanweisungen verlangen die Verwendung der bereitgestellten Quellen. Diese Anweisungen und automatische Prüfungen garantieren keine Fehlerfreiheit: Texte können ungenaue Auslegungen, unvollständige Verweise oder Übersetzungsfehler enthalten. Einen festen Anteil menschlicher Überarbeitung garantieren wir nicht.',
      ] },
      { id: 'sources', title: 'Quellen und Zuschreibung', paragraphs: [
        'Bei Vorschriften, Beträgen und Fristen bevorzugen wir Primärquellen: Steuerbehörden, Sozialversicherungsträger, Statistikämter, Gesetzestexte und Gerichtsentscheidungen. Nachrichten können auch auf journalistischen Quellen oder Mitteilungen von Organisationen beruhen, die im Text benannt und verlinkt werden.',
        'Die Wiedergabe einer Nachricht ist keine unabhängige Prüfung ihrer Primärquelle. Berichtet ein Artikel über die Position einer Organisation oder ein laufendes Verfahren, darf diese Zuschreibung nicht als endgültige Entscheidung der zuständigen Behörde verstanden werden.',
      ] },
      { id: 'fact-checking', title: 'Prüfungen und Nutzung der Informationen', paragraphs: [
        'Automatische Prüfungen helfen, Widersprüche und fehlende Quellen zu erkennen. Sie ersetzen weder eine menschliche Prüfung noch Steuer-, Rechts- oder Vorsorgeberatung. Für Sätze, Beträge, Voraussetzungen und Fristen bleibt das auf Ihren Fall anwendbare amtliche Dokument massgeblich.',
        'Simulationen unterstützen den Vergleich von Szenarien und hängen von den eingegebenen Daten und angegebenen Annahmen ab. Prüfen Sie die Parameter vor einer persönlichen Entscheidung bei der zuständigen Behörde oder einer qualifizierten Fachperson.',
      ] },
      { id: 'corrections', title: 'Aktualisierungen und Korrekturen', paragraphs: [
        'Eine Rechtsänderung oder ein Hinweis kann die Aktualisierung eines Artikels erfordern. Eine Korrektur berichtigt dagegen einen Fehler in veröffentlichten Inhalten. Verfügbare Datumsangaben und Hinweise erleichtern das Nachvollziehen von Änderungen; ein Datum allein bestätigt keine erneute vollständige Prüfung.',
        'Nennen Sie bei einer Fehlermeldung an die Redaktion die URL, die beanstandete Passage und eine überprüfbare Quelle. Das Korrekturverzeichnis enthält dokumentierte Berichtigungen. Die Möglichkeit, ein Problem zu melden, garantiert nicht die Richtigkeit bereits veröffentlichter Inhalte.',
      ] },
    ],
  },
  fr: {
    title: 'Méthodologie éditoriale — Comment nous rédigeons les articles',
    description: 'Comment Frontaliere Ticino utilise les sources, la rédaction assistée par IA et les contrôles automatiques. Limites, mises à jour et signalement des erreurs.',
    back: 'Retour à l’accueil', links: 'Pages associées', about: 'À propos', corrections: 'Registre des corrections',
    sections: [
      { id: 'process', title: 'Production et publication', paragraphs: [
        'Frontaliere Ticino publie des guides, des simulations et des actualités pour les travailleurs frontaliers entre l’Italie et la Suisse. Le processus comprend la collecte des sources, la préparation de brouillons avec une assistance automatique, des contrôles techniques et la publication. Les vérifications éditoriales et les corrections peuvent aussi intervenir après publication.',
        'La signature d’un article identifie l’auteur ou la rédaction indiqués, mais ne certifie pas à elle seule une vérification humaine de chaque affirmation. Pour comprendre le fondement d’une actualité, consultez les sources liées et les éventuelles notes d’attribution.',
      ] },
      { id: 'ai', title: 'Assistance automatique et limites', paragraphs: [
        'Nous utilisons des modèles de langage, dont Claude d’Anthropic et GPT d’OpenAI, pour préparer des brouillons, structurer les textes et les traduire en italien, anglais, allemand et français. La chaîne de production peut publier des contenus générés automatiquement après les contrôles techniques. Nous ne prétendons pas que chaque article fait l’objet d’une vérification humaine préalable.',
        'Les consignes de génération imposent de s’appuyer sur les sources fournies. Ces consignes et les contrôles automatiques ne garantissent pas l’absence d’erreurs : les textes peuvent contenir des interprétations inexactes, des références incomplètes ou des traductions imprécises. Nous ne garantissons aucun pourcentage de réécriture humaine.',
      ] },
      { id: 'sources', title: 'Sources et attribution', paragraphs: [
        'Nous privilégions les sources primaires pour les règles, les montants et les échéances : administrations fiscales, organismes de sécurité sociale, offices statistiques, textes législatifs et décisions de justice. Les actualités peuvent aussi reposer sur des sources journalistiques ou des communiqués d’organisations, attribués et liés dans le texte.',
        'Relayer une information ne constitue pas une vérification indépendante de sa source primaire. Lorsqu’un article rapporte la position d’une organisation ou une affaire en cours, cette attribution ne doit pas être comprise comme une décision définitive de l’autorité compétente.',
      ] },
      { id: 'fact-checking', title: 'Vérifications et utilisation des informations', paragraphs: [
        'Les contrôles automatiques aident à repérer les incohérences et les sources manquantes. Ils ne remplacent ni une vérification humaine ni un avis fiscal, juridique ou relatif à la retraite. Pour les taux, montants, conditions et échéances, le document officiel applicable à votre situation reste la référence.',
        'Les simulations permettent de comparer des scénarios et dépendent des données saisies et des hypothèses indiquées. Avant une décision personnelle, vérifiez les paramètres auprès de l’autorité compétente ou d’un professionnel qualifié.',
      ] },
      { id: 'corrections', title: 'Mises à jour et corrections', paragraphs: [
        'Une modification réglementaire ou un signalement peut nécessiter la mise à jour d’un article. Une correction rectifie une erreur dans le contenu publié. Les dates et notes disponibles sur la page permettent de retracer les modifications ; une date seule ne certifie pas une nouvelle vérification complète.',
        'Pour signaler une erreur à la rédaction, indiquez l’URL, le passage contesté et une source vérifiable. Le registre des corrections rassemble les rectifications documentées. La possibilité de signaler un problème ne garantit pas l’exactitude du contenu déjà publié.',
      ] },
    ],
  },
};
