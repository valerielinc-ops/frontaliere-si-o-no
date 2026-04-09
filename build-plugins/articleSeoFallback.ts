type Locale = 'it' | 'en' | 'de' | 'fr';

type SeoSection = {
  heading: string;
  paragraphs: string[];
};

const STOP_WORDS: Record<Locale, Set<string>> = {
  it: new Set(['frontaliere', 'frontalieri', 'ticino', 'svizzera', 'italia', 'della', 'delle', 'degli', 'dello', 'dell', 'del', 'dei', 'gli', 'con', 'per', 'tra', 'come', 'cosa', 'nelle', 'nella', 'dopo', 'dove', 'sul', 'sulla', 'una', 'uno', 'alla', 'alle', 'agli', 'nel', 'nei', 'che', 'piu', 'piu', '2026']),
  en: new Set(['cross', 'border', 'worker', 'workers', 'ticino', 'switzerland', 'italy', 'with', 'from', 'this', 'that', 'what', 'when', 'your', 'into', 'over', 'about', '2026']),
  de: new Set(['grenzganger', 'grenzgänger', 'tessin', 'schweiz', 'italien', 'diese', 'dieser', 'dass', 'uber', 'über', 'eine', 'einen', 'fuer', 'für', 'und', 'mit', '2026']),
  fr: new Set(['frontalier', 'frontaliers', 'tessin', 'suisse', 'italie', 'avec', 'dans', 'pour', 'sur', 'cette', 'votre', 'plus', '2026']),
};

const SECTION_LABELS: Record<Locale, { intro: string; why: string; checks: string; impact: string; next: string }> = {
  it: {
    intro: 'Cosa devi sapere',
    why: 'Perche questa pagina conta',
    checks: 'Cosa controllare subito',
    impact: 'Impatto pratico per chi vive in Italia',
    next: 'Prossimi passi utili',
  },
  en: {
    intro: 'What this page covers',
    why: 'Why this matters',
    checks: 'What to verify now',
    impact: 'Practical impact for cross-border workers',
    next: 'Useful next steps',
  },
  de: {
    intro: 'Worum es auf dieser Seite geht',
    why: 'Warum das relevant ist',
    checks: 'Was Sie jetzt prufen sollten',
    impact: 'Praktische Folgen fur Grenzganger',
    next: 'Sinnvolle nachste Schritte',
  },
  fr: {
    intro: 'Ce que cette page explique',
    why: 'Pourquoi c est important',
    checks: 'Ce qu il faut verifier tout de suite',
    impact: 'Impact concret pour les frontaliers',
    next: 'Etapes utiles a suivre',
  },
};

const stripArticleMarkup = (text: string): string =>
  text
    .replace(/\[([^\]]+)\]\(nav:[^)]+\)/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/`+/g, '')
    .replace(/\*\*(.*?)\*\*/g, '$1')
    .replace(/\*(.*?)\*/g, '$1')
    .replace(/^#+\s*/gm, '')
    .replace(/^\s*>\s*/gm, '')
    .replace(/^\s*[-*]\s+/gm, '• ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

const tokenizeTopic = (value: string): string[] =>
  value
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter((token) => token.length >= 4);

const extractTopicTerms = (locale: Locale, title: string, desc: string, keywords: string): string[] => {
  const scores = new Map<string, number>();
  const stopWords = STOP_WORDS[locale];
  const weightedSources = [
    { value: title, weight: 3 },
    { value: desc, weight: 2 },
    { value: keywords, weight: 2 },
  ];

  for (const source of weightedSources) {
    for (const token of tokenizeTopic(source.value)) {
      if (stopWords.has(token)) continue;
      scores.set(token, (scores.get(token) ?? 0) + source.weight);
    }
  }

  return [...scores.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, 6)
    .map(([token]) => token);
};

const formatTopicList = (locale: Locale, topics: string[]): string => {
  if (!topics.length) return '';
  if (locale === 'en') return topics.join(', ');
  if (locale === 'de') return topics.join(', ');
  if (locale === 'fr') return topics.join(', ');
  return topics.join(', ');
};

export function buildArticleSeoSections(locale: Locale, title: string, desc: string, keywords: string): SeoSection[] {
  const labels = SECTION_LABELS[locale];
  const topics = extractTopicTerms(locale, title, desc, keywords);
  const topicList = formatTopicList(locale, topics);

  if (locale === 'de') {
    return [
      {
        heading: labels.intro,
        paragraphs: [
          `${title} wird hier nicht nur als kurze Meldung, sondern als Orientierungshilfe fur Grenzganger aufbereitet. ${desc} Der statische Inhalt erklart die Ausgangslage, ordnet den Kontext im Tessiner Arbeits- und Steueralltag ein und hilft dabei, die Relevanz fur die eigene Situation sauber einzuordnen.`,
          `Besonders wichtig ist das fur Nutzer, die direkt aus der Google-Suche kommen und schnell verstehen mussen, ob das Thema ihren Nettolohn, ihre Planung, ihre Versicherung oder ihre tagliche Organisation betrifft. Statt nur eine kurze Zusammenfassung zu zeigen, deckt diese Seite die praktischen Zusammenhange ab, die bei grenzuberschreitender Arbeit regelmassig zu Fehlentscheidungen fuhren.`,
        ],
      },
      {
        heading: labels.why,
        paragraphs: [
          `Das Thema beruhrt in vielen Fallen mehrere Ebenen gleichzeitig: Regeln des Schweizer Arbeitgebers, italienische Steuerfolgen, Pendelkosten, Fristen und Dokumentationspflichten. ${topicList ? `Im Mittelpunkt stehen Begriffe wie ${topicList}. ` : ''}Gerade bei neuen Regeln oder regionalen Anderungen im Tessin reicht eine Uberschrift nicht aus, um die Auswirkungen realistisch einzuschatzen.`,
          `Diese Seite gibt deshalb genug semantischen Kontext fur Suchmaschinen und fur Nutzer: Worum geht es konkret, welche Betroffenen sind gemeint, welche Entscheidungen hangen daran und welche Folgefragen sollten unmittelbar mitgepruft werden. Das verbessert sowohl die Orientierung als auch die inhaltliche Tiefe der Indexierung.`,
        ],
      },
      {
        heading: labels.checks,
        paragraphs: [
          `Prufen Sie zuerst, ob der Artikel Ihre Konstellation tatsachlich trifft: Wohnsitz in Italien, Arbeitsort im Tessin, altes oder neues Grenzgangerregime, Familienstand, Lohnniveau und allfallige Homeoffice-Tage. Schon kleine Unterschiede in diesen Variablen konnen dazu fuhren, dass dieselbe Nachricht fur zwei Personen vollig unterschiedliche finanzielle Folgen hat.`,
          `Ebenso sinnvoll ist ein Abgleich mit den bei Frontaliere Ticino verlinkten Rechnern und Leitfaden. Wer Zahlen wie Quellensteuer, IRPEF-Nachbelastung, Krankenkasse, Wechselkurs oder Fahrtkosten parallel kontrolliert, erkennt schneller, ob das in diesem Beitrag behandelte Thema nur informativ ist oder eine unmittelbare Handlung auslost.`,
        ],
      },
      {
        heading: labels.impact,
        paragraphs: [
          `Fur Grenzganger ist der eigentliche Wert eines Artikels selten nur die Nachricht selbst, sondern die Konsequenz im Monatsbudget und in der Jahresplanung. Deshalb wird der Inhalt so strukturiert, dass Leser die Auswirkungen auf Netto, Abzuge, Verpflichtungen gegenuber italienischen Behorden und praktische Alltagsfragen nachvollziehen konnen.`,
          `Wenn sich aus dem Thema weitere Risiken ergeben, etwa bei Fristen, Formularen, Versicherungswahl, Steuererklarung oder Arbeitsplatzwechsel, sollte der nachste Schritt nie auf Vermutung basieren. Ziel dieser Seite ist es, die Ausgangsinformation mit genug Tiefe zu verbinden, damit Nutzer anschliessend gezielt weiterrechnen oder eine Entscheidung vorbereiten konnen.`,
        ],
      },
      {
        heading: labels.next,
        paragraphs: [
          `Nutzen Sie anschliessend die verknupften Bereiche zu Rechnern, Ratgebern, Stellenangeboten und FAQ, um das Thema in Ihren konkreten Fall zu ubertragen. So bleibt der Besuch nicht bei einer kurzen Nachricht stehen, sondern wird zu einer verwertbaren Entscheidungshilfe fur Arbeit, Steuern und Leben zwischen Italien und der Schweiz.`,
          `Falls Sie spezifische Fragen haben, wie dieses Thema Ihre personliche Situation betrifft — Gehalt, Besteuerung, Krankenversicherung, Vorsorge oder Pendeln — konnen die interaktiven Rechner der Plattform Ihnen prazise quantitative Antworten mit offiziellen Steuerparametern 2026 liefern, ohne externe Beratung.`,
        ],
      },
    ];
  }

  if (locale === 'fr') {
    return [
      {
        heading: labels.intro,
        paragraphs: [
          `${title} est presente ici comme une ressource utile, pas seulement comme une breve. ${desc} Le contenu statique ajoute le contexte indispensable pour comprendre a qui la situation s applique, ce qui change concretement et pourquoi le sujet compte pour les frontaliers entre l Italie et le Tessin.`,
          `De nombreux visiteurs arrivent directement depuis Google et doivent savoir en quelques secondes si la page concerne leur salaire net, leur fiscalite, leur assurance, leur emploi ou leur organisation quotidienne. Cette structure donne une base plus solide que quelques lignes generiques et renforce la valeur editoriale percue par les moteurs de recherche.`,
        ],
      },
      {
        heading: labels.why,
        paragraphs: [
          `Pour un frontalier, une information apparemment simple a souvent plusieurs consequences en meme temps: obligations cote suisse, effets fiscaux cote italien, cout des deplacements, echanges CHF/EUR, calendrier administratif et impact sur le budget mensuel. ${topicList ? `Les notions les plus liees a cette page incluent ${topicList}. ` : ''}Il faut donc expliciter le contexte et pas seulement le titre.`,
          `Cette page est construite pour resumer l enjeu, replacer le sujet dans l ecosysteme du travail frontalier et suggerer les verifications utiles avant de prendre une decision. Cela renforce la comprehension utilisateur et la qualite semantique de la page pour l indexation.`,
        ],
      },
      {
        heading: labels.checks,
        paragraphs: [
          `La premiere verification consiste a comparer le contenu avec votre propre situation: commune de residence, lieu de travail, ancien ou nouveau regime frontalier, situation familiale, niveau salarial et eventuel teletravail. Ces variables changent souvent l interpretation pratique d une actualite ou d une regle.`,
          `Il est ensuite utile de confronter l article aux autres ressources de Frontaliere Ticino, notamment les simulateurs, les guides fiscaux et les pages emploi. Ce croisement permet de distinguer ce qui releve d une information generale de ce qui exige une action concrete dans les prochains jours ou mois.`,
        ],
      },
      {
        heading: labels.impact,
        paragraphs: [
          `Le point le plus important n est pas seulement de savoir qu une regle ou une actualite existe, mais de mesurer son effet reel sur la vie d un frontalier: revenu disponible, charges, demarches, choix d assurance ou organisation du trajet domicile travail. Le texte est donc redige pour faire ressortir les implications concretement utiles.`,
          `Lorsque le sujet touche des echeances, des formulaires, des droits ou des couts recurrents, il faut eviter de se fier a une lecture superficielle. Cette page sert de point de depart fiable pour ensuite approfondir avec des outils pratiques et des contenus lies.`,
        ],
      },
      {
        heading: labels.next,
        paragraphs: [
          `Apres cette lecture, le plus utile est d ouvrir les simulateurs, les guides et les autres pages liees afin de transformer l information en plan d action. L objectif est qu un lecteur quitte cette page avec une meilleure vision des options, des risques et des etapes suivantes a verifier.`,
          `Si vous avez des questions specifiques sur l impact de ce sujet sur votre situation personnelle — salaire, fiscalite, assurance maladie, prevoyance ou transport — les calculateurs interactifs de la plateforme peuvent vous donner des reponses quantitatives precises avec les parametres fiscaux officiels 2026, sans consultation externe.`,
        ],
      },
    ];
  }

  if (locale === 'en') {
    return [
      {
        heading: labels.intro,
        paragraphs: [
          `${title} is presented here as a practical resource rather than a thin summary. ${desc} The static SEO content adds the missing context users need to understand who is affected, what may change in practice, and why the topic matters for people living in Italy and working in Ticino.`,
          `Many visits start from Google, not from the homepage, so the page needs enough substance on first load to explain the scenario clearly. That means giving readers more than a short excerpt: it should show the business, tax, salary, and day-to-day implications that normally drive real decisions for cross-border workers.`,
        ],
      },
      {
        heading: labels.why,
        paragraphs: [
          `For cross-border workers, a single update often sits at the intersection of several systems: Swiss payroll rules, Italian tax consequences, commuting costs, health coverage, and administrative deadlines. ${topicList ? `Relevant themes on this page include ${topicList}. ` : ''}Without that wider framing, a page can look too thin even when the topic itself is important.`,
          `This page therefore expands the intent behind the article: what changed, why readers should care, which profiles are most exposed, and what additional checks are worth running before acting on the information. That improves both user comprehension and the page's search quality signals.`,
        ],
      },
      {
        heading: labels.checks,
        paragraphs: [
          `A useful first step is to compare the article with your own profile: place of residence, job location, old or new frontier-worker tax regime, family situation, salary level, and any remote-work arrangement. Small differences in those inputs can produce very different outcomes, especially on net income and compliance.`,
          `It is also worth validating the topic against the calculators, guides, and job pages linked across Frontaliere Ticino. When readers connect the article to real numbers such as withholding tax, IRPEF top-up, insurance costs, exchange-rate exposure, or commuting expenses, they can tell whether the update is informational or requires action.`,
        ],
      },
      {
        heading: labels.impact,
        paragraphs: [
          `The practical value of an article for this audience is not just the headline. What matters is the likely effect on monthly cash flow, annual planning, documents to prepare, and choices about salary, insurance, work arrangement, or relocation. The page is structured to keep that practical lens visible from the start.`,
          `If the topic creates downstream questions around deadlines, forms, deductions, hiring, or policy changes, readers should not have to leave with only a vague summary. This static content is designed to bridge that gap and make the page useful enough to stand on its own while still connecting naturally to deeper tools and guides.`,
        ],
      },
      {
        heading: labels.next,
        paragraphs: [
          `The best next step is to use the linked calculators, guides, FAQs, and job search pages to test the topic against your exact case. That turns a single article into a practical decision flow, which is the core value users expect from Frontaliere Ticino.`,
          `If you have specific questions about how this topic affects your personal situation — salary, taxation, health insurance, pension planning, or transport — the platform's interactive calculators can give you precise quantitative answers using official 2026 fiscal parameters, without the need for external consultations.`,
        ],
      },
    ];
  }

  return [
    {
      heading: labels.intro,
      paragraphs: [
        `${title} viene presentato come una risorsa utile, non come una scheda vuota o una notizia troppo breve. ${desc} Il contenuto statico aggiunge il contesto che serve per capire subito chi e coinvolto, quali decisioni puo influenzare e perche il tema conta davvero per chi vive in Italia e lavora in Ticino.`,
        `Molte visite arrivano direttamente da Google e non dalla homepage, quindi la pagina deve spiegare da sola scenario, utilita e possibili conseguenze. Per questo il testo estende il significato del titolo e rende piu chiari i collegamenti con stipendio netto, tassazione, assicurazione, documenti, lavoro e organizzazione quotidiana del frontaliere.`,
      ],
    },
    {
      heading: labels.why,
      paragraphs: [
        `Per i frontalieri un singolo aggiornamento raramente ha un effetto isolato. Puo incidere insieme su regole svizzere del datore di lavoro, dichiarazione italiana, costi di spostamento, scadenze, copertura sanitaria e pianificazione familiare. ${topicList ? `I temi che emergono con piu forza in questa pagina sono ${topicList}. ` : ''}Per questo Google e gli utenti hanno bisogno di trovare un contesto piu ampio rispetto a un semplice estratto.`,
        `La pagina e costruita per esplicitare cosa cambia, per quali profili il contenuto e piu rilevante, quali controlli conviene fare subito e quali domande successive e naturale porsi. In questo modo il contenuto diventa piu utile anche se il corpo localizzato completo dell articolo non e ancora disponibile.`,
      ],
    },
    {
      heading: labels.checks,
      paragraphs: [
        `Il primo controllo utile e confrontare il tema con la propria situazione reale: comune di residenza, luogo di lavoro, vecchio o nuovo regime frontaliero, stipendio lordo, composizione del nucleo familiare e presenza di telelavoro. Sono proprio queste variabili che cambiano il risultato concreto di una regola o di una notizia.`,
        `Subito dopo conviene incrociare la pagina con i simulatori, le guide fiscali e le pagine di cerca lavoro di Frontaliere Ticino. Quando si verificano numeri come imposta alla fonte, eventuale integrazione IRPEF, premi sanitari, cambio franco euro o spese di commuting, si capisce se la novita letta richiede davvero un'azione.`,
      ],
    },
    {
      heading: labels.impact,
      paragraphs: [
        `Il valore pratico di una pagina per un frontaliere non sta solo nel titolo ma nelle conseguenze sul budget mensile e sulla pianificazione annuale. Per questo il testo mette in evidenza l'impatto su netto, costi ricorrenti, adempimenti, scelta dell'assicurazione, ricerca lavoro o valutazione di una nuova offerta in Ticino.`,
        `Se dal tema emergono scadenze, moduli, rischi fiscali, opportunita lavorative o dubbi operativi, l'obiettivo e evitare interpretazioni superficiali. Questa pagina serve proprio a fare da ponte tra la notizia iniziale e le verifiche piu approfondite che il lettore dovrebbe svolgere prima di decidere.`,
      ],
    },
    {
      heading: labels.next,
      paragraphs: [
        `Il passo successivo migliore e usare i link interni verso simulatore fiscale, guida frontalieri, FAQ e cerca lavoro per trasformare l'informazione in un piano concreto. In questo modo la visita non si ferma alla lettura del titolo ma diventa un supporto reale per scegliere meglio tra Italia e Ticino.`,
        `Se hai domande specifiche su come questo tema influisce sulla tua situazione personale — stipendio, tassazione, assicurazione sanitaria, previdenza o trasporti — i calcolatori interattivi della piattaforma possono darti risposte quantitative precise, aggiornate ai parametri fiscali 2026, senza bisogno di consulenze esterne.`,
      ],
    },
  ];
}

export function cleanupArticleBodySections(sections: Array<string | undefined>): string[] {
  return sections
    .filter((section): section is string => !!section)
    .map(stripArticleMarkup)
    .map((section) => section.length > 1800 ? `${section.slice(0, 1800).trim()}...` : section)
    .filter(Boolean);
}
