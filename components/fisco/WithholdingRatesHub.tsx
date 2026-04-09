import React from 'react';
import {
  ArrowRight,
  Calculator,
  CheckCircle2,
  Coins,
  ExternalLink,
  FileText,
  HelpCircle,
  Receipt,
} from 'lucide-react';
import { adjustRateForChildren, getTicinoTaxRate } from '@/services/calculationService';
import { buildPath } from '@/services/router';
import { useLocale, type Locale } from '@/services/i18n';

type TableCode = 'A' | 'B' | 'C' | 'H';

type Scenario = {
  code: TableCode;
  badge: string;
  state: 'SINGLE' | 'MARRIED';
  children: number;
  spouseWorks: boolean;
};

type Copy = {
  badge: string;
  title: string;
  intro: string;
  disclaimer: string;
  cardsTitle: string;
  matrixTitle: string;
  matrixIntro: string;
  matrixColumns: {
    scenario: string;
    who: string;
    low: string;
    medium: string;
    high: string;
  };
  fitTitle: string;
  fitIntro: string;
  notesTitle: string;
  notes: string[];
  deepLinksTitle: string;
  deepLinksIntro: string;
  openLabel: string;
  faqTitle: string;
  faq: Array<{ question: string; answer: string }>;
  cards: Record<TableCode, { title: string; who: string; detail: string }>;
  ctas: Array<{ title: string; body: string; route: Parameters<typeof buildPath>[0] }>;
  officialSourcesTitle: string;
  officialSourcesIntro: string;
  officialLinks: Array<{ label: string; url: string; detail: string }>;
};

const INCOME_STEPS = [50000, 80000, 100000];

const SCENARIOS: Scenario[] = [
  { code: 'A', badge: 'A0', state: 'SINGLE', children: 0, spouseWorks: false },
  { code: 'B', badge: 'B0', state: 'MARRIED', children: 0, spouseWorks: false },
  { code: 'C', badge: 'C0', state: 'MARRIED', children: 0, spouseWorks: true },
  { code: 'H', badge: 'H1', state: 'SINGLE', children: 1, spouseWorks: false },
];

const COPY_BY_LOCALE: Record<Locale, Copy> = {
  it: {
    badge: 'Hub fiscale 2026',
    title: 'Aliquote imposta alla fonte Ticino 2026',
    intro: 'Guida pratica alle tabelle A, B, C e H del Canton Ticino: quando si applicano, quanto incidono sul netto e quali controlli fare prima di accettare un contratto o leggere la busta paga.',
    disclaimer: 'Le percentuali sotto sono stime orientative basate sullo stesso modello del simulatore Frontaliere Ticino. Il datore di lavoro applica sempre la tariffa ufficiale in base a stato civile, figli e situazione familiare aggiornata.',
    cardsTitle: 'Le 4 tabelle che contano davvero',
    matrixTitle: 'Aliquote indicative 2026 per reddito lordo annuo',
    matrixIntro: 'Tabella orientativa utile per capire come cambia la trattenuta svizzera tra un single, una coppia con un solo reddito, una coppia con due redditi e un genitore solo.',
    matrixColumns: {
      scenario: 'Tabella',
      who: 'Scenario',
      low: 'CHF 50.000',
      medium: 'CHF 80.000',
      high: 'CHF 100.000',
    },
    fitTitle: 'Come capire quale tabella ti riguarda',
    fitIntro: 'La classe giusta non dipende dal settore o dall’azienda, ma dalla tua situazione familiare. Se HR o payroll usano la tabella sbagliata, il netto mensile puo cambiare in modo sensibile.',
    notesTitle: 'Controlli rapidi prima della prima busta paga',
    notes: [
      'Verifica se sei in A, B, C o H e non solo la percentuale finale.',
      'Segnala subito nascita figli, matrimonio, separazione o cambio del reddito del coniuge.',
      'Controlla se il simulatore e il cedolino usano la stessa base lorda annua.',
      'Se qualcosa non torna, confronta il cedolino con il simulatore busta paga e la guida fiscale svizzera.',
    ],
    deepLinksTitle: 'Vai subito agli strumenti giusti',
    deepLinksIntro: 'Da questa pagina puoi passare dal quadro teorico alla tua situazione reale: simulazione netto, busta paga e credito d’imposta.',
    openLabel: 'Apri',
    faqTitle: 'FAQ sulle aliquote 2026',
    faq: [
      {
        question: 'Qual e la differenza tra tabella A, B, C e H?',
        answer: 'La A si usa di norma per persone sole senza figli. La B per coniugati con un solo reddito. La C per coniugati con due redditi. La H per genitori soli con figli a carico.',
      },
      {
        question: 'La tabella dipende dal Comune italiano di residenza?',
        answer: 'No. La tabella svizzera dipende soprattutto da stato civile e figli. Il Comune italiano conta invece per la fiscalita italiana, addizionali e casi del nuovo accordo.',
      },
      {
        question: 'Perche il mio cedolino mostra una percentuale diversa dal simulatore?',
        answer: 'Di solito dipende da tabella errata, figli non registrati, tredicesima, bonus, periodo di paga o differenze tra lordo annuo e lordo mensile usato dal payroll.',
      },
      {
        question: 'Se ho figli posso pagare meno imposta alla fonte?',
        answer: 'Spesso si, ma dipende dalla tabella applicata e dalla composizione del nucleo. Nel simulatore puoi vedere subito come cambia il netto nei diversi scenari.',
      },
      {
        question: 'I nuovi frontalieri devono guardare solo la tabella svizzera?',
        answer: 'No. L’imposta alla fonte Ticino resta fondamentale, ma per i nuovi frontalieri va letta insieme a IRPEF italiana, franchigia e credito d’imposta.',
      },
    ],
    cards: {
      A: {
        title: 'Tabella A',
        who: 'Single o divorziato senza figli a carico',
        detail: 'E il caso piu comune per chi entra in Ticino per la prima volta. In genere e anche la tabella con cui si confrontano molte offerte di lavoro.',
      },
      B: {
        title: 'Tabella B',
        who: 'Coniugato con un solo reddito',
        detail: 'Di solito piu favorevole della A a parita di lordo, perche tiene conto del nucleo con un solo reddito principale.',
      },
      C: {
        title: 'Tabella C',
        who: 'Coniugato con due redditi',
        detail: 'Conta quando anche il coniuge lavora. E una delle situazioni dove gli errori di classificazione payroll si notano di piu sul netto.',
      },
      H: {
        title: 'Tabella H',
        who: 'Genitore solo con figli a carico',
        detail: 'Pensata per nuclei monoparentali. Se non e caricata correttamente, il netto puo risultare molto piu basso del dovuto.',
      },
    },
    ctas: [
      {
        title: 'Simula il netto 2026',
        body: 'Vedi subito come cambia lo stipendio netto con la tua tabella e il tuo reddito.',
        route: { activeTab: 'calculator' },
      },
      {
        title: 'Controlla la busta paga',
        body: 'Confronta imposta alla fonte, AVS, LPP e deduzioni del tuo cedolino svizzero.',
        route: { activeTab: 'calculator', calcolatoreSubTab: 'payslip' },
      },
      {
        title: 'Calcola il credito d’imposta',
        body: 'Se sei nuovo frontaliere, incrocia la trattenuta svizzera con l’IRPEF italiana.',
        route: { activeTab: 'fisco', fiscoSubTab: 'tax-credit' },
      },
      {
        title: 'Guida fiscale svizzera',
        body: 'Approfondisci rettifica, TDR e controlli da fare sulla tariffa applicata.',
        route: { activeTab: 'fisco', fiscoSubTab: 'tax-return', taxReturnCountry: 'svizzera' },
      },
    ],
    officialSourcesTitle: 'Tabelle ufficiali Canton Ticino',
    officialSourcesIntro: 'Le aliquote mostrate sopra sono stime indicative. Le tabelle definitive, con tutte le fasce e le classi, sono pubblicate dalla Divisione delle Contribuzioni del Canton Ticino e dall\u2019Amministrazione federale delle contribuzioni.',
    officialLinks: [
      {
        label: 'Tariffe imposta alla fonte – Canton Ticino',
        url: 'https://www4.ti.ch/dfe/dc/imposta-alla-fonte/tariffe',
        detail: 'Pagina ufficiale con le tabelle A, B, C e H in vigore, scaricabili in PDF.',
      },
      {
        label: 'Imposta alla fonte – AFC (Confederazione)',
        url: 'https://www.estv.admin.ch/estv/it/home/direkte-bundessteuer/quellensteuer.html',
        detail: 'Quadro federale sulla ritenuta alla fonte, normativa e circolari aggiornate.',
      },
    ],
  },
  en: {
    badge: '2026 tax hub',
    title: 'Ticino withholding tax rates 2026',
    intro: 'A practical guide to Ticino tax tables A, B, C and H: when each one applies, how much it can affect net pay, and what to check before accepting an offer or reading your first payslip.',
    disclaimer: 'The percentages below are indicative estimates built on the same model used by the Frontaliere Ticino simulator. Employers always apply the official tariff based on marital status, children and updated family situation.',
    cardsTitle: 'The 4 tax tables that matter most',
    matrixTitle: 'Indicative 2026 rates by annual gross salary',
    matrixIntro: 'A quick comparison to understand how Swiss withholding changes for a single worker, a one-income couple, a two-income couple and a single parent.',
    matrixColumns: {
      scenario: 'Table',
      who: 'Scenario',
      low: 'CHF 50,000',
      medium: 'CHF 80,000',
      high: 'CHF 100,000',
    },
    fitTitle: 'How to understand which table fits your case',
    fitIntro: 'The right class does not depend on your sector or employer. It mainly depends on family status. If HR or payroll use the wrong table, your monthly net salary can change materially.',
    notesTitle: 'Quick checks before your first payslip',
    notes: [
      'Check whether you are on A, B, C or H and not just the final percentage.',
      'Report children, marriage, separation or spouse income changes immediately.',
      'Make sure the simulator and the payslip use the same annual gross basis.',
      'If something looks off, compare the payslip with the net salary and payslip simulators.',
    ],
    deepLinksTitle: 'Jump straight to the right tools',
    deepLinksIntro: 'Move from general tax tables to your real scenario with net salary, payslip and tax credit tools.',
    openLabel: 'Open',
    faqTitle: 'FAQ about 2026 withholding rates',
    faq: [
      {
        question: 'What is the difference between tables A, B, C and H?',
        answer: 'A is usually for single people without dependent children. B is for married workers with one income. C is for married workers with two incomes. H is for single parents with dependent children.',
      },
      {
        question: 'Does the Italian municipality of residence decide the Swiss table?',
        answer: 'No. The Swiss table depends mainly on marital and family status. The municipality matters on the Italian tax side, not for the Ticino withholding class itself.',
      },
      {
        question: 'Why is my payslip percentage different from the simulator?',
        answer: 'The most common reasons are a wrong table, children not registered, bonus or 13th salary effects, payroll timing, or a mismatch between annual and monthly gross salary.',
      },
      {
        question: 'If I have children, can the withholding tax be lower?',
        answer: 'Often yes, but it depends on the table applied and the household setup. The simulator helps you compare the impact quickly.',
      },
      {
        question: 'Do new cross-border workers need to look only at the Swiss tax table?',
        answer: 'No. Ticino withholding remains central, but it must be read together with Italian IRPEF, the allowance and the tax credit rules.',
      },
    ],
    cards: {
      A: {
        title: 'Table A',
        who: 'Single or divorced, no dependent children',
        detail: 'This is the most common entry case for workers starting in Ticino and often the baseline used in salary comparisons.',
      },
      B: {
        title: 'Table B',
        who: 'Married, one income',
        detail: 'Usually more favorable than A at the same gross salary because it reflects a family with one main income.',
      },
      C: {
        title: 'Table C',
        who: 'Married, two incomes',
        detail: 'Relevant when both spouses earn. It is also one of the cases where payroll classification mistakes show up quickly.',
      },
      H: {
        title: 'Table H',
        who: 'Single parent with dependent children',
        detail: 'Designed for single-parent households. If it is not applied correctly, net pay can be materially lower than expected.',
      },
    },
    ctas: [
      {
        title: 'Run the 2026 net salary simulator',
        body: 'See how your net pay changes with your own tax table and salary.',
        route: { activeTab: 'calculator' },
      },
      {
        title: 'Check your payslip',
        body: 'Compare withholding tax, AVS, LPP and other deductions line by line.',
        route: { activeTab: 'calculator', calcolatoreSubTab: 'payslip' },
      },
      {
        title: 'Estimate the tax credit',
        body: 'For new cross-border workers, combine Swiss withholding and Italian IRPEF.',
        route: { activeTab: 'fisco', fiscoSubTab: 'tax-credit' },
      },
      {
        title: 'Read the Swiss tax guide',
        body: 'Go deeper on corrections, ordinary assessment and tax table checks.',
        route: { activeTab: 'fisco', fiscoSubTab: 'tax-return', taxReturnCountry: 'svizzera' },
      },
    ],
    officialSourcesTitle: 'Official Canton Ticino tables',
    officialSourcesIntro: 'The rates shown above are indicative estimates. The definitive tables, with all brackets and classes, are published by the Ticino Tax Division and the Swiss Federal Tax Administration.',
    officialLinks: [
      {
        label: 'Withholding tax tariffs – Canton Ticino',
        url: 'https://www4.ti.ch/dfe/dc/imposta-alla-fonte/tariffe',
        detail: 'Official page with the current A, B, C and H tables, downloadable as PDF.',
      },
      {
        label: 'Withholding tax – FTA (Swiss Confederation)',
        url: 'https://www.estv.admin.ch/estv/en/home/direkte-bundessteuer/quellensteuer.html',
        detail: 'Federal framework on withholding tax, regulations and updated circulars.',
      },
    ],
  },
  de: {
    badge: 'Steuerhub 2026',
    title: 'Quellensteuer Tessin 2026',
    intro: 'Praktischer Leitfaden zu den Tessiner Tabellen A, B, C und H: wann sie gelten, wie stark sie den Nettolohn beeinflussen und was Sie vor Vertragsannahme oder erster Lohnabrechnung pruefen sollten.',
    disclaimer: 'Die untenstehenden Prozentsaetze sind Richtwerte auf Basis desselben Modells wie im Frontaliere-Ticino-Simulator. Arbeitgeber wenden immer den offiziellen Tarif gemass Zivilstand, Kindern und aktueller Familiensituation an.',
    cardsTitle: 'Die 4 wichtigsten Quellensteuertabellen',
    matrixTitle: 'Richtwerte 2026 nach Jahresbruttolohn',
    matrixIntro: 'Schneller Vergleich fuer Alleinstehende, Ehepaare mit einem Einkommen, Ehepaare mit zwei Einkommen und Alleinerziehende.',
    matrixColumns: {
      scenario: 'Tabelle',
      who: 'Szenario',
      low: 'CHF 50.000',
      medium: 'CHF 80.000',
      high: 'CHF 100.000',
    },
    fitTitle: 'So erkennen Sie die richtige Tabelle',
    fitIntro: 'Die richtige Klasse haengt nicht von Branche oder Arbeitgeber ab, sondern vor allem von der Familiensituation. Eine falsche Payroll-Einstufung veraendert den Nettolohn schnell spuerbar.',
    notesTitle: 'Schnellchecks vor der ersten Lohnabrechnung',
    notes: [
      'Pruefen Sie, ob A, B, C oder H verwendet wird und nicht nur den Endprozentsatz.',
      'Melden Sie Kinder, Heirat, Trennung oder Aenderungen beim Einkommen des Ehepartners sofort.',
      'Vergleichen Sie, ob Simulator und Payroll dieselbe Jahreslohn-Basis verwenden.',
      'Bei Unstimmigkeiten Lohnabrechnung, Nettolohn-Simulator und Steuerleitfaden gemeinsam pruefen.',
    ],
    deepLinksTitle: 'Direkt zu den passenden Tools',
    deepLinksIntro: 'Von der allgemeinen Tabelle direkt zur eigenen Situation: Nettolohn, Lohnabrechnung und Steuergutschrift.',
    openLabel: 'Oeffnen',
    faqTitle: 'FAQ zur Quellensteuer 2026',
    faq: [
      {
        question: 'Worin unterscheiden sich die Tabellen A, B, C und H?',
        answer: 'A gilt meist fuer Alleinstehende ohne Kinder. B fuer Verheiratete mit einem Einkommen. C fuer Verheiratete mit zwei Einkommen. H fuer Alleinerziehende mit unterhaltspflichtigen Kindern.',
      },
      {
        question: 'Bestimmt die italienische Wohngemeinde die Schweizer Tabelle?',
        answer: 'Nein. Die Schweizer Tabelle richtet sich hauptsaechlich nach Zivilstand und Kindern. Die Wohngemeinde ist eher fuer die italienische Steuerseite relevant.',
      },
      {
        question: 'Warum weicht der Prozentsatz auf meiner Lohnabrechnung vom Simulator ab?',
        answer: 'Hauefige Gruende sind eine falsche Tabelle, nicht erfasste Kinder, Bonus- oder 13.-Monatslohn-Effekte, Payroll-Zeitpunkte oder unterschiedliche Brutto-Basis.',
      },
      {
        question: 'Kann die Quellensteuer mit Kindern tiefer sein?',
        answer: 'Oft ja, aber das haengt von der angewendeten Tabelle und der Familiensituation ab. Der Simulator zeigt die Unterschiede schnell.',
      },
      {
        question: 'Muessen neue Grenzgaenger nur die Schweizer Tabelle ansehen?',
        answer: 'Nein. Die Tessiner Quellensteuer bleibt zentral, muss aber zusammen mit italienischer IRPEF, Freibetrag und Steuergutschrift gelesen werden.',
      },
    ],
    cards: {
      A: {
        title: 'Tabelle A',
        who: 'Ledig oder geschieden, keine Kinder',
        detail: 'Der haeufigste Einstiegsfall fuer neue Jobs im Tessin und oft die Basis bei Lohnvergleichen.',
      },
      B: {
        title: 'Tabelle B',
        who: 'Verheiratet, ein Einkommen',
        detail: 'Meist guenstiger als A bei gleichem Bruttolohn, weil sie einen Haushalt mit einem Haupteinkommen widerspiegelt.',
      },
      C: {
        title: 'Tabelle C',
        who: 'Verheiratet, zwei Einkommen',
        detail: 'Relevant, wenn beide Ehepartner verdienen. Hier fallen Payroll-Fehler oft besonders schnell auf.',
      },
      H: {
        title: 'Tabelle H',
        who: 'Alleinerziehend mit Kindern',
        detail: 'Fuer Einelternhaushalte gedacht. Eine falsche Einstufung kann den Nettolohn deutlich verschlechtern.',
      },
    },
    ctas: [
      {
        title: 'Nettolohn 2026 simulieren',
        body: 'Sehen Sie sofort, wie sich Tabelle und Lohn auf Ihren Nettobetrag auswirken.',
        route: { activeTab: 'calculator' },
      },
      {
        title: 'Lohnabrechnung pruefen',
        body: 'Vergleichen Sie Quellensteuer, AVS, LPP und weitere Abzuege Zeile fuer Zeile.',
        route: { activeTab: 'calculator', calcolatoreSubTab: 'payslip' },
      },
      {
        title: 'Steuergutschrift berechnen',
        body: 'Fuer neue Grenzgaenger: Schweizer Quellensteuer und italienische IRPEF zusammen betrachten.',
        route: { activeTab: 'fisco', fiscoSubTab: 'tax-credit' },
      },
      {
        title: 'Schweizer Steuerleitfaden',
        body: 'Mehr zu Berichtigung, ordentlicher Veranlagung und Tarifpruefung.',
        route: { activeTab: 'fisco', fiscoSubTab: 'tax-return', taxReturnCountry: 'svizzera' },
      },
    ],
    officialSourcesTitle: 'Offizielle Tabellen Kanton Tessin',
    officialSourcesIntro: 'Die oben gezeigten Saetze sind Richtwerte. Die definitiven Tabellen mit allen Stufen und Klassen werden von der Tessiner Steuerverwaltung und der Eidgenoessischen Steuerverwaltung veroeffentlicht.',
    officialLinks: [
      {
        label: 'Quellensteuertarife – Kanton Tessin',
        url: 'https://www4.ti.ch/dfe/dc/imposta-alla-fonte/tariffe',
        detail: 'Offizielle Seite mit den aktuellen Tabellen A, B, C und H als PDF zum Herunterladen.',
      },
      {
        label: 'Quellensteuer – ESTV (Bund)',
        url: 'https://www.estv.admin.ch/estv/de/home/direkte-bundessteuer/quellensteuer.html',
        detail: 'Bundesrechtlicher Rahmen zur Quellensteuer, Verordnungen und aktuelle Rundschreiben.',
      },
    ],
  },
  fr: {
    badge: 'Hub fiscal 2026',
    title: 'Baremes impot a la source Tessin 2026',
    intro: 'Guide pratique des baremes A, B, C et H du Tessin: quand ils s appliquent, leur impact sur le net et les points a verifier avant d accepter une offre ou de lire votre premiere fiche de paie.',
    disclaimer: 'Les pourcentages ci-dessous sont des estimations indicatives basees sur le meme modele que le simulateur Frontaliere Ticino. L employeur applique toujours le bareme officiel selon l etat civil, les enfants et la situation familiale a jour.',
    cardsTitle: 'Les 4 baremes qui comptent vraiment',
    matrixTitle: 'Taux indicatifs 2026 selon le salaire brut annuel',
    matrixIntro: 'Comparaison rapide pour une personne seule, un couple a un revenu, un couple a deux revenus et un parent seul.',
    matrixColumns: {
      scenario: 'Bareme',
      who: 'Situation',
      low: 'CHF 50 000',
      medium: 'CHF 80 000',
      high: 'CHF 100 000',
    },
    fitTitle: 'Comment identifier le bon bareme',
    fitIntro: 'La bonne classe depend surtout de la situation familiale, pas du secteur ni de l employeur. Une mauvaise attribution par la paie peut modifier sensiblement le net mensuel.',
    notesTitle: 'Verifications rapides avant la premiere fiche de paie',
    notes: [
      'Verifiez si vous etes en A, B, C ou H, pas seulement le pourcentage final.',
      'Signalez rapidement enfants, mariage, separation ou changement de revenu du conjoint.',
      'Assurez-vous que le simulateur et la paie utilisent la meme base de salaire brut annuel.',
      'En cas d ecart, comparez la fiche de paie, le simulateur net et le guide fiscal suisse.',
    ],
    deepLinksTitle: 'Accedez directement aux bons outils',
    deepLinksIntro: 'Passez du cadre general a votre situation reelle avec les outils net, fiche de paie et credit d impot.',
    openLabel: 'Ouvrir',
    faqTitle: 'FAQ sur les baremes 2026',
    faq: [
      {
        question: 'Quelle est la difference entre les baremes A, B, C et H?',
        answer: 'Le A s applique generalement aux personnes seules sans enfant. Le B aux couples maries avec un seul revenu. Le C aux couples maries avec deux revenus. Le H aux parents seuls avec enfants a charge.',
      },
      {
        question: 'La commune italienne de residence decide-t-elle du bareme suisse?',
        answer: 'Non. Le bareme suisse depend surtout de l etat civil et des enfants. La commune de residence compte plutot pour la fiscalite italienne.',
      },
      {
        question: 'Pourquoi le pourcentage de ma fiche de paie differe-t-il du simulateur?',
        answer: 'Les raisons les plus frequentes sont un mauvais bareme, des enfants non enregistres, un bonus, un 13e salaire, le calendrier de paie ou une base brute differente.',
      },
      {
        question: 'Avec des enfants, puis-je payer moins d impot a la source?',
        answer: 'Souvent oui, mais cela depend du bareme applique et de la situation du foyer. Le simulateur permet de comparer rapidement les cas.',
      },
      {
        question: 'Les nouveaux frontaliers doivent-ils regarder uniquement le bareme suisse?',
        answer: 'Non. L impot a la source tessinois reste central, mais il doit etre lu avec l IRPEF italienne, la franchise et le credit d impot.',
      },
    ],
    cards: {
      A: {
        title: 'Bareme A',
        who: 'Celibataire ou divorce, sans enfant a charge',
        detail: 'C est le cas le plus courant pour demarrer un emploi au Tessin et la base habituelle des comparaisons salariales.',
      },
      B: {
        title: 'Bareme B',
        who: 'Marie, un seul revenu',
        detail: 'Souvent plus favorable que le A a salaire brut egal, car il reflète un foyer avec un seul revenu principal.',
      },
      C: {
        title: 'Bareme C',
        who: 'Marie, deux revenus',
        detail: 'Important si les deux conjoints travaillent. C est aussi un cas ou les erreurs de paie se voient vite sur le net.',
      },
      H: {
        title: 'Bareme H',
        who: 'Parent seul avec enfants a charge',
        detail: 'Prevue pour les familles monoparentales. Si elle est mal appliquee, le net peut etre nettement plus bas que prevu.',
      },
    },
    ctas: [
      {
        title: 'Simuler le net 2026',
        body: 'Voyez tout de suite comment votre bareme et votre salaire modifient le net.',
        route: { activeTab: 'calculator' },
      },
      {
        title: 'Verifier la fiche de paie',
        body: 'Comparez impot a la source, AVS, LPP et autres retenues ligne par ligne.',
        route: { activeTab: 'calculator', calcolatoreSubTab: 'payslip' },
      },
      {
        title: 'Calculer le credit d impot',
        body: 'Pour les nouveaux frontaliers, croisez retenue suisse et IRPEF italienne.',
        route: { activeTab: 'fisco', fiscoSubTab: 'tax-credit' },
      },
      {
        title: 'Guide fiscal suisse',
        body: 'Approfondissez correction, taxation ordinaire et verification du bareme applique.',
        route: { activeTab: 'fisco', fiscoSubTab: 'tax-return', taxReturnCountry: 'svizzera' },
      },
    ],
    officialSourcesTitle: 'Baremes officiels Canton du Tessin',
    officialSourcesIntro: 'Les taux affiches ci-dessus sont des estimations indicatives. Les baremes definitifs, avec toutes les tranches et classes, sont publies par la Division des contributions du Tessin et l Administration federale des contributions.',
    officialLinks: [
      {
        label: 'Baremes impot a la source – Canton du Tessin',
        url: 'https://www4.ti.ch/dfe/dc/imposta-alla-fonte/tariffe',
        detail: 'Page officielle avec les baremes A, B, C et H en vigueur, telechargeables en PDF.',
      },
      {
        label: 'Impot a la source – AFC (Confederation)',
        url: 'https://www.estv.admin.ch/estv/fr/home/direkte-bundessteuer/quellensteuer.html',
        detail: 'Cadre federal de l impot a la source, reglements et circulaires a jour.',
      },
    ],
  },
};

function formatPercent(locale: Locale, value: number): string {
  return new Intl.NumberFormat(locale, {
    style: 'percent',
    minimumFractionDigits: 1,
    maximumFractionDigits: 1,
  }).format(value);
}

function computeRate(code: TableCode, income: number): number {
  const scenario = SCENARIOS.find((item) => item.code === code)!;
  const base = getTicinoTaxRate(income, scenario.state, scenario.children, scenario.spouseWorks);
  return adjustRateForChildren(base.rate, base.tableCode, scenario.children);
}

export default function WithholdingRatesHub() {
  const [locale] = useLocale();
  const copy = COPY_BY_LOCALE[locale];

  return (
    <div className="space-y-8">
      <section className="rounded-3xl bg-gradient-to-br from-emerald-600 via-emerald-700 to-teal-700 p-6 sm:p-8 text-white shadow-xl shadow-emerald-900/20">
        <div className="inline-flex items-center gap-2 rounded-full bg-white/15 px-3 py-1 text-xs font-bold uppercase tracking-[0.14em]">
          <Coins className="h-4 w-4" />
          {copy.badge}
        </div>
        <h1 className="mt-4 max-w-4xl text-3xl font-bold leading-tight sm:text-4xl">{copy.title}</h1>
        <p className="mt-4 max-w-4xl text-sm leading-7 text-emerald-50 sm:text-base">{copy.intro}</p>
        <div className="mt-6 rounded-2xl border border-white/20 bg-white/10 p-4 text-sm leading-7 text-emerald-50">
          {copy.disclaimer}
        </div>
        <div className="mt-6 flex flex-wrap gap-3">
          {copy.ctas.slice(0, 2).map((cta) => (
            <a
              key={cta.title}
              href={buildPath(cta.route, locale)}
              className="inline-flex items-center gap-2 rounded-2xl bg-surface px-4 py-3 text-sm font-bold text-emerald-800 dark:text-emerald-300 no-underline transition hover:-translate-y-0.5 hover:bg-emerald-50 dark:hover:bg-slate-700"
            >
              {cta.title}
              <ArrowRight className="h-4 w-4" />
            </a>
          ))}
        </div>
      </section>

      <section className="space-y-4">
        <div>
          <h2 className="text-2xl font-bold text-slate-900 dark:text-white">{copy.cardsTitle}</h2>
        </div>
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
          {SCENARIOS.map((scenario) => {
            const item = copy.cards[scenario.code];
            return (
              <article
                key={scenario.code}
                className="rounded-3xl border border-slate-200 bg-white p-5 shadow-sm dark:border-slate-700 dark:bg-slate-800"
              >
                <div className="inline-flex rounded-full bg-emerald-100 px-3 py-1 text-xs font-bold text-emerald-800 dark:bg-emerald-900/30 dark:text-emerald-300">
                  {scenario.badge}
                </div>
                <h3 className="mt-4 text-lg font-bold text-slate-900 dark:text-white">{item.title}</h3>
                <p className="mt-2 text-sm font-semibold text-slate-700 dark:text-slate-200">{item.who}</p>
                <p className="mt-3 text-sm leading-7 text-slate-600 dark:text-slate-300">{item.detail}</p>
              </article>
            );
          })}
        </div>
      </section>

      <section className="rounded-3xl border border-slate-200 bg-white p-6 shadow-sm dark:border-slate-700 dark:bg-slate-800">
        <div className="flex items-center gap-3">
          <Receipt className="h-5 w-5 text-emerald-600 dark:text-emerald-300" />
          <h2 className="text-2xl font-bold text-slate-900 dark:text-white">{copy.matrixTitle}</h2>
        </div>
        <p className="mt-3 max-w-4xl text-sm leading-7 text-slate-600 dark:text-slate-300">{copy.matrixIntro}</p>
        <div className="mt-5 overflow-x-auto">
          <table className="min-w-full border-separate border-spacing-0 overflow-hidden rounded-2xl">
            <thead>
              <tr>
                <th className="bg-slate-100 px-4 py-3 text-left text-xs font-bold uppercase tracking-[0.12em] text-slate-600 dark:bg-slate-900 dark:text-slate-300">{copy.matrixColumns.scenario}</th>
                <th className="bg-slate-100 px-4 py-3 text-left text-xs font-bold uppercase tracking-[0.12em] text-slate-600 dark:bg-slate-900 dark:text-slate-300">{copy.matrixColumns.who}</th>
                <th className="bg-slate-100 px-4 py-3 text-left text-xs font-bold uppercase tracking-[0.12em] text-slate-600 dark:bg-slate-900 dark:text-slate-300">{copy.matrixColumns.low}</th>
                <th className="bg-slate-100 px-4 py-3 text-left text-xs font-bold uppercase tracking-[0.12em] text-slate-600 dark:bg-slate-900 dark:text-slate-300">{copy.matrixColumns.medium}</th>
                <th className="bg-slate-100 px-4 py-3 text-left text-xs font-bold uppercase tracking-[0.12em] text-slate-600 dark:bg-slate-900 dark:text-slate-300">{copy.matrixColumns.high}</th>
              </tr>
            </thead>
            <tbody>
              {SCENARIOS.map((scenario) => (
                <tr key={scenario.code}>
                  <td className="border-t border-slate-200 px-4 py-4 text-sm font-bold text-slate-900 dark:border-slate-700 dark:text-white">{scenario.badge}</td>
                  <td className="border-t border-slate-200 px-4 py-4 text-sm text-slate-600 dark:border-slate-700 dark:text-slate-300">{copy.cards[scenario.code].who}</td>
                  {INCOME_STEPS.map((income) => (
                    <td key={income} className="border-t border-slate-200 px-4 py-4 text-sm font-semibold text-slate-800 dark:border-slate-700 dark:text-slate-200">
                      {formatPercent(locale, computeRate(scenario.code, income))}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section className="rounded-3xl border border-emerald-200 bg-emerald-50 p-6 shadow-sm dark:border-emerald-800 dark:bg-emerald-950/40">
        <div className="flex items-center gap-3">
          <ExternalLink className="h-5 w-5 text-emerald-700 dark:text-emerald-300" />
          <h2 className="text-2xl font-bold text-slate-900 dark:text-white">{copy.officialSourcesTitle}</h2>
        </div>
        <p className="mt-3 max-w-4xl text-sm leading-7 text-body">{copy.officialSourcesIntro}</p>
        <div className="mt-5 grid gap-4 sm:grid-cols-2">
          {copy.officialLinks.map((link) => (
            <a
              key={link.url}
              href={link.url}
              target="_blank"
              rel="noopener noreferrer"
              className="group rounded-2xl border border-emerald-200 bg-white p-4 no-underline transition hover:-translate-y-0.5 hover:border-emerald-400 dark:border-emerald-800 dark:bg-slate-800 dark:hover:border-emerald-600"
            >
              <div className="flex items-center gap-2">
                <span className="text-sm font-bold text-emerald-800 dark:text-emerald-200">{link.label}</span>
                <ExternalLink className="h-3.5 w-3.5 text-emerald-600 dark:text-emerald-400" />
              </div>
              <p className="mt-2 text-sm leading-6 text-slate-600 dark:text-slate-300">{link.detail}</p>
            </a>
          ))}
        </div>
      </section>

      <section className="grid gap-6 xl:grid-cols-[1.15fr_0.85fr]">
        <article className="rounded-3xl border border-slate-200 bg-white p-6 shadow-sm dark:border-slate-700 dark:bg-slate-800">
          <div className="flex items-center gap-3">
            <HelpCircle className="h-5 w-5 text-emerald-600 dark:text-emerald-300" />
            <h2 className="text-2xl font-bold text-slate-900 dark:text-white">{copy.fitTitle}</h2>
          </div>
          <p className="mt-3 text-sm leading-7 text-slate-600 dark:text-slate-300">{copy.fitIntro}</p>
          <div className="mt-5 space-y-3">
            {SCENARIOS.map((scenario) => (
              <div key={scenario.code} className="rounded-2xl border border-slate-200 p-4 dark:border-slate-700">
                <div className="flex items-center gap-3">
                  <div className="inline-flex h-8 w-8 items-center justify-center rounded-full bg-emerald-100 text-xs font-bold text-emerald-800 dark:bg-emerald-900/30 dark:text-emerald-300">
                    {scenario.code}
                  </div>
                  <div>
                    <h3 className="text-sm font-bold text-slate-900 dark:text-white">{copy.cards[scenario.code].title}</h3>
                    <p className="text-sm text-slate-600 dark:text-slate-300">{copy.cards[scenario.code].who}</p>
                  </div>
                </div>
              </div>
            ))}
          </div>
        </article>

        <article className="rounded-3xl border border-slate-200 bg-white p-6 shadow-sm dark:border-slate-700 dark:bg-slate-800">
          <div className="flex items-center gap-3">
            <CheckCircle2 className="h-5 w-5 text-emerald-600 dark:text-emerald-300" />
            <h2 className="text-2xl font-bold text-slate-900 dark:text-white">{copy.notesTitle}</h2>
          </div>
          <ul className="mt-5 space-y-3">
            {copy.notes.map((note) => (
              <li key={note} className="rounded-2xl bg-slate-50 px-4 py-3 text-sm leading-7 text-slate-700 dark:bg-slate-900 dark:text-slate-300">
                {note}
              </li>
            ))}
          </ul>
        </article>
      </section>

      <section className="rounded-3xl border border-slate-200 bg-white p-6 shadow-sm dark:border-slate-700 dark:bg-slate-800">
        <div className="flex items-center gap-3">
          <Calculator className="h-5 w-5 text-emerald-600 dark:text-emerald-300" />
          <h2 className="text-2xl font-bold text-slate-900 dark:text-white">{copy.deepLinksTitle}</h2>
        </div>
        <p className="mt-3 max-w-4xl text-sm leading-7 text-slate-600 dark:text-slate-300">{copy.deepLinksIntro}</p>
        <div className="mt-5 grid gap-4 md:grid-cols-2 xl:grid-cols-4">
          {copy.ctas.map((cta) => (
            <a
              key={cta.title}
              href={buildPath(cta.route, locale)}
              className="group rounded-3xl border border-slate-200 p-5 no-underline transition hover:-translate-y-0.5 hover:border-emerald-300 dark:border-slate-700 dark:hover:border-emerald-700"
            >
              <h3 className="text-base font-bold text-slate-900 dark:text-white">{cta.title}</h3>
              <p className="mt-2 text-sm leading-7 text-slate-600 dark:text-slate-300">{cta.body}</p>
              <span className="mt-4 inline-flex items-center gap-2 text-sm font-bold text-emerald-700 dark:text-emerald-300">
                {copy.openLabel}
                <ArrowRight className="h-4 w-4 transition group-hover:translate-x-0.5" />
              </span>
            </a>
          ))}
        </div>
      </section>

      <section className="rounded-3xl border border-slate-200 bg-white p-6 shadow-sm dark:border-slate-700 dark:bg-slate-800">
        <div className="flex items-center gap-3">
          <FileText className="h-5 w-5 text-emerald-600 dark:text-emerald-300" />
          <h2 className="text-2xl font-bold text-slate-900 dark:text-white">{copy.faqTitle}</h2>
        </div>
        <div className="mt-5 grid gap-4">
          {copy.faq.map((item) => (
            <article key={item.question} className="rounded-2xl border border-slate-200 p-5 dark:border-slate-700">
              <h3 className="text-base font-bold text-slate-900 dark:text-white">{item.question}</h3>
              <p className="mt-2 text-sm leading-7 text-slate-600 dark:text-slate-300">{item.answer}</p>
            </article>
          ))}
        </div>
      </section>
    </div>
  );
}
