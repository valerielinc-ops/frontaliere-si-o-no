import type { FaqHubEntry } from './types';

/**
 * FAQ hub — category "fisco" (AE-5).
 *
 * Scope: imposta alla fonte, nuova legge fiscale 2026 (Accordo CH-IT
 * 17/07/2023 + LF 13 giugno 2023 n. 83), dichiarazione in Italia,
 * ritenute, deduzioni, ristorni ai comuni di confine. Entries 11-13
 * (added for issue #3653) internal-link to the tax-guide pillar pages
 * and to the evergreen salary-hub tax articles (build-plugins/salaryHubArticles.ts).
 */
export const FAQ_fisco: ReadonlyArray<FaqHubEntry> = [
  {
    id: 'fisco-imposta-fonte-ticino-2026',
    category: 'fisco',
    question: {
      it: "Come cambia l'imposta alla fonte per i frontalieri in Ticino dal 2026?",
      en: 'How does withholding tax change for cross-border workers in Ticino from 2026?',
      de: 'Wie ändert sich die Quellensteuer für Grenzgänger im Tessin ab 2026?',
      fr: "Comment change l'impôt à la source pour les frontaliers au Tessin dès 2026 ?",
    },
    titleShort: {
      it: 'Imposta alla fonte frontalieri in Ticino: cosa cambia dal 2026?',
      en: 'Ticino withholding tax 2026: what changes for cross-border workers',
      de: 'Quellensteuer für Grenzgänger im Tessin: was ändert sich 2026?',
      fr: 'Impôt à la source des frontaliers au Tessin : nouveautés 2026',
    },
    answer: {
      it:
        "L'Accordo CH-IT sui frontalieri del 23/12/2020 è in vigore dal 17/07/2023 e si applica dal 1° gennaio 2024; è stato ratificato con la Legge italiana 13 giugno 2023 n. 83 [fonte: Fedlex SR 0.642.045.43]. I «nuovi frontalieri» sono i frontalieri ai sensi dell'art. 2 dell'Accordo che non rientrano nell'art. 9. La Svizzera preleva alla fonte al massimo l'80% dell'imposta ordinaria; l'Italia tassa il reddito e riconosce il credito per l'imposta svizzera, entro la quota di IRPEF proporzionale al reddito estero [fonte: Accordo art. 3; Convenzione CH-IT art. 24; art. 165 TUIR, dal 2027 art. 185 D.Lgs. 117/2026]. I «vecchi frontalieri» restano tassati solo in Svizzera, con compensazione del 40% all'Italia fino all'anno fiscale 2033 [fonte: Accordo art. 9]. La franchigia IRPEF è di 10.000 € dal 2024 [fonte: L. 83/2023 art. 4; dal 2027 D.Lgs. 117/2026 art. 217].",
      en:
        "The CH-IT cross-border agreement of 23/12/2020 entered into force on 17/07/2023 and has applied since 1 January 2024; Italy ratified it with Law 13 June 2023 No. 83 [source: Fedlex SR 0.642.045.43]. «New» cross-border workers are those covered by art. 2 of the Agreement who do not fall under art. 9. Switzerland withholds at most 80% of the ordinary tax; Italy taxes the income and grants a credit for the Swiss tax, up to the IRPEF share proportional to foreign income [source: Agreement art. 3; CH-IT Convention art. 24; TUIR art. 165, from 2027 art. 185 Legislative Decree 117/2026]. «Old» cross-border workers stay taxed only in Switzerland, with a 40% compensation to Italy through tax year 2033 [source: Agreement art. 9]. The IRPEF exemption has been €10,000 since 2024 [source: Law 83/2023 art. 4; from 2027 Legislative Decree 117/2026 art. 217].",
      de:
        "Das CH-IT-Grenzgängerabkommen vom 23.12.2020 ist seit dem 17.07.2023 in Kraft und gilt seit dem 1. Januar 2024; Italien hat es mit Gesetz 13. Juni 2023 Nr. 83 ratifiziert [Quelle: Fedlex SR 0.642.045.43]. «Neue» Grenzgänger sind Personen nach Art. 2 des Abkommens, die nicht unter Art. 9 fallen. Die Schweiz erhebt höchstens 80 % der ordentlichen Quellensteuer; Italien besteuert das Einkommen und rechnet die Schweizer Steuer an, begrenzt auf den zum Auslandseinkommen proportionalen IRPEF-Anteil [Quelle: Abkommen Art. 3; DBA CH-IT Art. 24; TUIR Art. 165, ab 2027 Art. 185 D.Lgs. 117/2026]. «Alte» Grenzgänger bleiben nur in der Schweiz besteuert, mit einem Ausgleich von 40 % an Italien bis zum Steuerjahr 2033 [Quelle: Abkommen Art. 9]. Der IRPEF-Freibetrag beträgt seit 2024 10'000 € [Quelle: Gesetz 83/2023 Art. 4; ab 2027 D.Lgs. 117/2026 Art. 217].",
      fr:
        "L'accord CH-IT sur les frontaliers du 23/12/2020 est en vigueur depuis le 17/07/2023 et s'applique depuis le 1er janvier 2024 ; l'Italie l'a ratifié par la loi du 13 juin 2023 n° 83 [source : Fedlex SR 0.642.045.43]. Les « nouveaux » frontaliers relèvent de l'art. 2 de l'Accord sans entrer dans l'art. 9. La Suisse prélève au plus 80 % de l'impôt ordinaire ; l'Italie impose le revenu et accorde un crédit pour l'impôt suisse, dans la limite de la part d'IRPEF proportionnelle au revenu étranger [source : Accord art. 3 ; Convention CH-IT art. 24 ; art. 165 TUIR, dès 2027 art. 185 D.Lgs. 117/2026]. Les « anciens » frontaliers restent imposés uniquement en Suisse, avec une compensation de 40 % à l'Italie jusqu'à l'année fiscale 2033 [source : Accord art. 9]. La franchise IRPEF est de 10 000 € depuis 2024 [source : loi 83/2023 art. 4 ; dès 2027 D.Lgs. 117/2026 art. 217].",
    },
    relatedLinks: [
      {
        href: {
          it: '/guida-frontaliere/',
          en: '/en/cross-border-guide/',
          de: '/de/grenzgaenger-ratgeber/',
          fr: '/fr/guide-frontalier/',
        },
        label: {
          it: 'Guida alla nuova legge frontalieri 2024',
          en: 'Guide to the 2024 cross-border law',
          de: 'Leitfaden zum Grenzgängergesetz 2024',
          fr: "Guide de la nouvelle loi frontaliers 2024",
        },
      },
      {
        href: {
          it: '/tasse-e-pensione/',
          en: '/en/taxes-and-pension/',
          de: '/de/steuern-und-vorsorge/',
          fr: '/fr/impots-et-retraite/',
        },
        label: {
          it: 'Hub fiscale frontalieri',
          en: 'Cross-border tax hub',
          de: 'Steuer-Hub für Grenzgänger',
          fr: 'Hub fiscal frontaliers',
        },
      },
    ],
    sources: [
      'https://www.fedlex.admin.ch/eli/oc/2023/410/it',
      'https://www.agenziaentrate.gov.it/portale/documents/20143/5984217/1_TU_Redditi.pdf',
      'https://www4.ti.ch/dfe/dc/dichiarazione/imposte-alla-fonte-1/tabelle-di-calcolo-dellimposta-alla-fonte/',
    ],
  },
  {
    id: 'fisco-nuovi-vs-vecchi-frontalieri',
    category: 'fisco',
    question: {
      it: 'Qual è la differenza fiscale tra «vecchi» e «nuovi» frontalieri?',
      en: 'What is the tax difference between «old» and «new» cross-border workers?',
      de: 'Was ist der steuerliche Unterschied zwischen «alten» und «neuen» Grenzgängern?',
      fr: 'Quelle est la différence fiscale entre « anciens » et « nouveaux » frontaliers ?',
    },
    titleShort: {
      en: '«Old» vs «new» cross-border workers: what is the tax difference?',
      de: '«Alte» und «neue» Grenzgänger: was ist steuerlich anders?',
      fr: 'Différence fiscale entre « anciens » et « nouveaux » frontaliers ?',
    },
    answer: {
      it:
        "Lo spartiacque è il 17 luglio 2023, data di entrata in vigore dell'Accordo [fonte: Fedlex SR 0.642.045.43]. I «vecchi frontalieri» (che al 17/07/2023, o tra il 31/12/2018 e quella data, lavoravano in Ticino, Grigioni o Vallese e risiedono in un Comune dell'elenco ufficiale) restano tassati solo in Svizzera; ciascuno dei Cantoni Ticino, Grigioni e Vallese versa all'Italia il 40% dell'imposta lorda di questi lavoratori, fino all'anno fiscale 2033 [fonte: Accordo art. 9]. I «nuovi frontalieri» invece pagano in Svizzera al massimo l'80% dell'imposta alla fonte ordinaria e dichiarano il reddito in Italia, con credito per l'imposta svizzera entro la quota di IRPEF proporzionale. Applicano la franchigia IRPEF di 10.000 € [fonte: L. 83/2023 art. 4; dal 2027 D.Lgs. 117/2026 art. 217]. Le aliquote effettive sono quindi molto diverse.",
      en:
        "The watershed is 17 July 2023, the Agreement's entry into force [source: Fedlex SR 0.642.045.43]. «Old» workers (employed in Ticino, Grigioni or Valais on 17/07/2023, or between 31/12/2018 and that date, and residing in a municipality on the official list) remain taxed only in Switzerland; each of the cantons of Ticino, Grigioni and Valais pays Italy 40% of the gross tax on these workers, through tax year 2033 [source: Agreement art. 9]. «New» workers pay at most 80% of the ordinary Swiss withholding tax and declare the income in Italy, with a credit for the Swiss tax up to the proportional IRPEF share. They apply the €10,000 IRPEF exemption [source: Law 83/2023 art. 4; from 2027 Legislative Decree 117/2026 art. 217]. Effective rates differ substantially.",
      de:
        "Die Trennlinie ist der 17. Juli 2023, das Inkrafttreten des Abkommens [Quelle: Fedlex SR 0.642.045.43]. «Alte» Grenzgänger (am 17.07.2023 oder zwischen dem 31.12.2018 und diesem Datum im Tessin, Graubünden oder Wallis angestellt, wohnhaft in einer Gemeinde der offiziellen Liste) bleiben nur in der Schweiz steuerpflichtig; die Kantone Tessin, Graubünden und Wallis zahlen je 40 % der Bruttosteuer dieser Personen an Italien, bis zum Steuerjahr 2033 [Quelle: Abkommen Art. 9]. «Neue» Grenzgänger zahlen höchstens 80 % der ordentlichen Quellensteuer und deklarieren das Einkommen in Italien, mit Anrechnung der Schweizer Steuer bis zum proportionalen IRPEF-Anteil. Sie wenden den IRPEF-Freibetrag von 10'000 € an [Quelle: Gesetz 83/2023 Art. 4; ab 2027 D.Lgs. 117/2026 Art. 217]. Die Effektivsätze unterscheiden sich erheblich.",
      fr:
        "La date charnière est le 17 juillet 2023, entrée en vigueur de l'Accord [source : Fedlex SR 0.642.045.43]. Les « anciens » frontaliers (employés au Tessin, aux Grisons ou en Valais le 17/07/2023, ou entre le 31/12/2018 et cette date, et résidant dans une commune de la liste officielle) restent imposés en Suisse uniquement ; chacun des cantons du Tessin, des Grisons et du Valais verse à l'Italie 40 % de l'impôt brut de ces travailleurs, jusqu'à l'année fiscale 2033 [source : Accord art. 9]. Les « nouveaux » paient au plus 80 % de l'impôt à la source ordinaire et déclarent le revenu en Italie, avec un crédit pour l'impôt suisse dans la limite de la part d'IRPEF proportionnelle. Ils appliquent la franchise IRPEF de 10 000 € [source : loi 83/2023 art. 4 ; dès 2027 D.Lgs. 117/2026 art. 217]. Les taux effectifs diffèrent nettement.",
    },
    relatedLinks: [
      {
        href: {
          it: '/guida-frontaliere/',
          en: '/en/cross-border-guide/',
          de: '/de/grenzgaenger-ratgeber/',
          fr: '/fr/guide-frontalier/',
        },
        label: {
          it: 'Nuova legge frontalieri 2024',
          en: 'New 2024 cross-border law',
          de: 'Neues Grenzgängergesetz 2024',
          fr: 'Nouvelle loi frontaliers 2024',
        },
      },
    ],
    sources: [
      'https://www.fedlex.admin.ch/eli/oc/2023/410/it',
      'https://www.normattiva.it/uri-res/N2Ls?urn:nir:stato:legge:2023-06-13;83',
    ],
  },
  {
    id: 'fisco-franchigia-10000-euro',
    category: 'fisco',
    question: {
      it: 'Come funziona la franchigia IRPEF di 10.000 € per i frontalieri?',
      en: 'How does the €10,000 IRPEF exemption work for cross-border workers?',
      de: 'Wie funktioniert der IRPEF-Freibetrag von 10 000 € für Grenzgänger?',
      fr: 'Comment fonctionne la franchise IRPEF de 10 000 € pour les frontaliers ?',
    },
    titleShort: {
      it: 'Franchigia IRPEF 10.000 € per i frontalieri: come funziona?',
      en: '€10,000 IRPEF exemption for cross-border workers: how it works',
      de: 'IRPEF-Freibetrag von 10 000 € für Grenzgänger erklärt',
      fr: 'Franchise IRPEF de 10 000 € pour les frontaliers',
    },
    answer: {
      it:
        "La franchigia è prevista dall'art. 1, comma 175, della L. 147/2013, con il limite fissato dall'art. 4 della L. 83/2023: la quota esente del reddito di lavoro dipendente prestato all'estero in zona di frontiera o in Paesi limitrofi, in via continuativa e come oggetto esclusivo del rapporto, è di 10.000 € [fonte: Normattiva, L. 83/2023 art. 4; dal 2027 D.Lgs. 117/2026 art. 217]. L'importo vale dal periodo d'imposta 2024, prima era 7.500 €. Riguarda tutti i frontalieri, non solo verso la Svizzera, ma conta solo se il reddito è tassato in Italia. Con più redditi la quota esente totale resta 10.000 €. Nel quadro RC si indica il codice 4 in colonna 1 e la quota esente nel rigo RC5 colonna 1 [fonte: Agenzia Entrate, Istruzioni Redditi PF 2026].",
      en:
        "The exemption comes from art. 1 para. 175 of Italian Law 147/2013, with the limit set by art. 4 of Law 83/2023: the exempt share of employment income earned abroad in a border zone or neighbouring country, continuously and as the sole object of the employment relationship, is €10,000 [source: Normattiva, Law 83/2023 art. 4; from 2027 Legislative Decree 117/2026 art. 217]. The amount applies from tax year 2024; it was €7,500 before. It covers all cross-border workers, not only those working in Switzerland, but it matters only if the income is taxed in Italy. With several incomes the total exempt share stays €10,000. In section RC enter code 4 in column 1 and the exempt share in line RC5 column 1 [source: Agenzia Entrate, Redditi PF 2026 instructions].",
      de:
        "Der Freibetrag beruht auf Art. 1 Abs. 175 des italienischen Gesetzes 147/2013, mit der Grenze aus Art. 4 des Gesetzes 83/2023: Der steuerfreie Anteil des Arbeitseinkommens, das im Ausland in einer Grenzzone oder einem Nachbarstaat dauerhaft und als ausschliesslicher Gegenstand des Arbeitsverhältnisses erzielt wird, beträgt 10 000 € [Quelle: Normattiva, Gesetz 83/2023 Art. 4; ab 2027 D.Lgs. 117/2026 Art. 217]. Der Betrag gilt ab Steuerjahr 2024, zuvor waren es 7 500 €. Er betrifft alle Grenzgänger, nicht nur jene in der Schweiz, ist aber nur relevant, wenn das Einkommen in Italien besteuert wird. Bei mehreren Einkommen bleibt der steuerfreie Anteil insgesamt 10 000 €. Im Block RC werden Code 4 in Spalte 1 und der steuerfreie Anteil in Zeile RC5 Spalte 1 eingetragen [Quelle: Agenzia Entrate, Anleitungen Redditi PF 2026].",
      fr:
        "La franchise découle de l'art. 1 al. 175 de la loi italienne 147/2013, avec la limite fixée par l'art. 4 de la loi 83/2023 : la part exonérée du revenu d'activité salariée exercée à l'étranger en zone frontalière ou dans un pays limitrophe, de façon continue et comme objet exclusif du rapport de travail, est de 10 000 € [source : Normattiva, loi 83/2023 art. 4 ; dès 2027 D.Lgs. 117/2026 art. 217]. Ce montant s'applique depuis l'année fiscale 2024, il était de 7 500 € auparavant. Elle concerne tous les frontaliers, pas seulement ceux travaillant en Suisse, mais ne compte que si le revenu est imposé en Italie. Avec plusieurs revenus la part exonérée totale reste 10 000 €. Au cadre RC on indique le code 4 en colonne 1 et la part exonérée à la ligne RC5 colonne 1 [source : Agenzia Entrate, instructions Redditi PF 2026].",
    },
    relatedLinks: [
      {
        href: {
          it: '/tasse-e-pensione/',
          en: '/en/taxes-and-pension/',
          de: '/de/steuern-und-vorsorge/',
          fr: '/fr/impots-et-retraite/',
        },
        label: {
          it: 'Hub fiscale',
          en: 'Tax hub',
          de: 'Steuer-Hub',
          fr: 'Hub fiscal',
        },
      },
    ],
    sources: [
      'https://www.normattiva.it/uri-res/N2Ls?urn:nir:stato:legge:2023-06-13;83',
      'https://www.agenziaentrate.gov.it/portale/documents/20143/5476618/Circolare+Smart+working+e+Frontalieri+18+ago+2023.pdf/988122df-912b-afd1-8942-c2b20f0ab64c',
      'https://www.gazzettaufficiale.it/eli/gu/2026/07/03/152/so/26/sg/pdf',
      'https://www.agenziaentrate.gov.it/portale/documents/d/guest/pf1_istruzioni_2026_agg-28-05-2026',
      'https://infoprecompilata.agenziaentrate.gov.it/portale/quadro-rc',
    ],
  },
  {
    id: 'fisco-deduzione-sanitaria-3000',
    category: 'fisco',
    question: {
      it: 'Esiste una deduzione forfetaria sanitaria di 3.000 € per i frontalieri?',
      en: 'Is there a €3,000 flat healthcare deduction for cross-border workers?',
      de: 'Gibt es einen pauschalen Gesundheitsabzug von 3 000 € für Grenzgänger?',
      fr: 'Existe-t-il une déduction santé forfaitaire de 3 000 € pour frontaliers ?',
    },
    titleShort: {
      it: 'Esiste la deduzione forfetaria sanitaria di 3.000 €?',
      en: 'Is there a €3,000 flat healthcare deduction?',
      de: 'Gibt es einen Gesundheits-Pauschalabzug von 3 000 €?',
      fr: 'La déduction santé forfaitaire de 3 000 € existe-t-elle ?',
    },
    answer: {
      it:
        "No, nelle norme sui frontalieri non risulta. L'art. 5 della L. 83/2023 (dal 2027 art. 218 D.Lgs. 117/2026) riguarda i contributi obbligatori per il prepensionamento di categoria, deducibili nell'importo documentato. Il comma 175 della L. 147/2013 è la franchigia di 10.000 € (dal 2027 art. 217 D.Lgs. 117/2026). La quota SSN («tassa salute») è prevista dai commi 237-239 della L. 213/2023: è un versamento alla Regione, non una deduzione. La deducibilità in Italia dei premi LAMal e LAINF non è confermata dalle fonti citate: va verificata con un CAF o un professionista abilitato.",
      en:
        "No, it does not appear in the rules on cross-border workers. Art. 5 of Italian Law 83/2023 (from 2027 art. 218 Legislative Decree 117/2026) concerns mandatory contributions to sector early-retirement schemes, deductible in the documented amount. Para. 175 of Law 147/2013 is the €10,000 exemption (from 2027 art. 217 Legislative Decree 117/2026). The SSN contribution («tassa salute») comes from paras. 237-239 of Law 213/2023: it is a payment to the Region, not a deduction. The Italian deductibility of LAMal and LAINF premiums is not confirmed by the sources cited: check it with a CAF or a qualified adviser.",
      de:
        "Nein, in den Vorschriften für Grenzgänger findet er sich nicht. Art. 5 des italienischen Gesetzes 83/2023 (ab 2027 Art. 218 D.Lgs. 117/2026) betrifft obligatorische Beiträge an branchenbezogene Vorruhestandsregelungen, abziehbar in belegter Höhe. Abs. 175 des Gesetzes 147/2013 ist der Freibetrag von 10 000 € (ab 2027 Art. 217 D.Lgs. 117/2026). Der SSN-Beitrag («tassa salute») stammt aus Abs. 237-239 des Gesetzes 213/2023: Er ist eine Zahlung an die Region, kein Abzug. Die Abziehbarkeit von KVG- und UVG-Prämien in Italien wird durch die genannten Quellen nicht bestätigt: Bitte bei einem CAF oder einer qualifizierten Fachperson prüfen.",
      fr:
        "Non, elle ne figure pas dans les règles sur les frontaliers. L'art. 5 de la loi italienne 83/2023 (dès 2027 art. 218 D.Lgs. 117/2026) concerne les cotisations obligatoires aux régimes de préretraite de branche, déductibles pour le montant documenté. L'al. 175 de la loi 147/2013 est la franchise de 10 000 € (dès 2027 art. 217 D.Lgs. 117/2026). La contribution SSN (« tassa salute ») découle des al. 237-239 de la loi 213/2023 : c'est un versement à la Région, pas une déduction. La déductibilité en Italie des primes LAMal et LAA n'est pas confirmée par les sources citées : à vérifier auprès d'un CAF ou d'un conseiller qualifié.",
    },
    sources: [
      'https://www.normattiva.it/uri-res/N2Ls?urn:nir:stato:legge:2023-06-13;83',
      'https://www.normattiva.it/uri-res/N2Ls?urn:nir:stato:legge:2023-12-30;213',
      'https://www.agenziaentrate.gov.it/portale/documents/20143/5476618/Circolare+Smart+working+e+Frontalieri+18+ago+2023.pdf/988122df-912b-afd1-8942-c2b20f0ab64c',
      'https://www.gazzettaufficiale.it/eli/gu/2026/07/03/152/so/26/sg/pdf',
    ],
  },
  {
    id: 'fisco-credito-imposta-80-percento',
    category: 'fisco',
    question: {
      it: 'Come calcolo il credito d\'imposta sulle tasse svizzere già pagate?',
      en: 'How do I compute the tax credit on Swiss tax already paid?',
      de: 'Wie berechne ich die Steueranrechnung für bereits gezahlte Schweizer Steuern?',
      fr: 'Comment calculer le crédit d\'impôt sur l\'impôt suisse déjà payé ?',
    },
    titleShort: {
      it: 'Credito d’imposta: tasse svizzere',
      de: 'Wie berechne ich die Steueranrechnung für Schweizer Steuern?',
    },
    answer: {
      it:
        "L'art. 165 TUIR (dal 2027 art. 185 D.Lgs. 117/2026) e la Convenzione CH-IT del 1976 [fonte: Fedlex SR 0.672.945.41] disciplinano il credito per imposte pagate all'estero. Il nuovo frontaliere somma al reddito imponibile IRPEF il reddito svizzero convertito in euro, applica aliquote IRPEF e addizionali, e poi detrae il minore tra (a) l'imposta svizzera pagata a titolo definitivo e (b) la quota IRPEF proporzionale al reddito estero. Non esiste un tetto dell'80% al credito: l'80% riguarda il prelievo svizzero [fonte: Accordo art. 3; Convenzione art. 24]. Se il reddito estero concorre solo in parte, anche l'imposta estera si riduce in proporzione. Il certificato di salario svizzero e le ritenute quietanzate sono i documenti probatori. Nel modello Redditi il credito va nel quadro CE. L'imposta estera eccedente non si detrae nell'anno, ma può essere riportata alle condizioni di legge fino all'ottavo periodo.",
      en:
        "Italian TUIR art. 165 (from 2027 art. 185 Legislative Decree 117/2026) and the CH-IT Convention of 1976 [source: Fedlex SR 0.672.945.41] govern the foreign-tax credit. The new cross-border worker adds the Swiss income converted into euros to the IRPEF tax base, applies IRPEF and surtaxes, then credits the lower of (a) Swiss tax paid on a final basis and (b) the IRPEF share proportional to foreign income. There is no 80% limit on the credit: the 80% refers to the Swiss levy [source: Agreement art. 3; Convention art. 24]. If foreign income is only partly taxable, the foreign tax is reduced in proportion. The Swiss salary certificate and withholding receipts are the evidence. In the Redditi form the credit goes in section CE. Foreign tax above the limit is not credited in that year, but it can be carried over under the legal conditions up to the eighth period.",
      de:
        "Der italienische TUIR-Art. 165 (ab 2027 Art. 185 D.Lgs. 117/2026) und das Abkommen CH-IT von 1976 [Quelle: Fedlex SR 0.672.945.41] regeln die Anrechnung ausländischer Steuern. Der neue Grenzgänger rechnet den in Euro umgerechneten Schweizer Lohn zur IRPEF-Basis, wendet IRPEF und Zuschläge an und rechnet den niedrigeren Betrag an von (a) der endgültig bezahlten Schweizer Steuer und (b) dem zum Auslandseinkommen proportionalen IRPEF-Anteil. Eine 80-%-Grenze für die Anrechnung gibt es nicht: Die 80 % betreffen die Schweizer Abgabe [Quelle: Abkommen Art. 3; DBA Art. 24]. Ist das Auslandseinkommen nur teilweise steuerbar, verringert sich die ausländische Steuer proportional. Belege sind Lohnausweis und Quellensteuerbescheinigung. Im Redditi-Formular gehört die Anrechnung in Block CE. Nicht angerechnete ausländische Steuer kann unter den gesetzlichen Bedingungen bis zur achten Periode vorgetragen werden.",
      fr:
        "L'art. 165 TUIR (dès 2027 art. 185 D.Lgs. 117/2026) et la Convention CH-IT de 1976 [source : Fedlex SR 0.672.945.41] régissent le crédit pour impôts payés à l'étranger. Le nouveau frontalier ajoute à la base IRPEF le revenu suisse converti en euros, applique IRPEF et surtaxes, puis déduit le moindre entre (a) l'impôt suisse payé à titre définitif et (b) la part IRPEF proportionnelle au revenu étranger. Il n'existe aucun plafond de 80 % sur le crédit : les 80 % concernent le prélèvement suisse [source : Accord art. 3 ; Convention art. 24]. Si le revenu étranger n'est imposable qu'en partie, l'impôt étranger est réduit en proportion. Documents : certificat de salaire suisse et quittances de retenue. Dans le modèle Redditi le crédit figure au cadre CE. L'impôt étranger excédentaire n'est pas imputé cette année-là, mais il peut être reporté aux conditions légales jusqu'à la huitième période.",
    },
    relatedLinks: [
      {
        href: '/calcola-stipendio/',
        label: {
          it: 'Calcolatore netto frontaliere',
          en: 'Cross-border net calculator',
          de: 'Grenzgänger-Nettorechner',
          fr: 'Calculateur net frontalier',
        },
      },
    ],
    sources: [
      'https://www.fedlex.admin.ch/eli/cc/1979/461_461_461/it',
      'https://www.fedlex.admin.ch/eli/oc/2023/410/it',
      'https://www.gazzettaufficiale.it/eli/gu/2026/07/03/152/so/26/sg/pdf',
    ],
  },
  {
    id: 'fisco-dichiarazione-redditi-pf-2026',
    category: 'fisco',
    question: {
      it: 'Quali quadri del modello Redditi PF 2026 compila un nuovo frontaliere?',
      en: 'Which sections of Italian Redditi PF 2026 must a new cross-border worker fill?',
      de: 'Welche Abschnitte der italienischen Steuererklärung Redditi PF 2026 füllt ein neuer Grenzgänger aus?',
      fr: 'Quels cadres du formulaire Redditi PF 2026 doit remplir un nouveau frontalier ?',
    },
    titleShort: {
      it: 'Quali quadri del Redditi PF 2026 compila un nuovo frontaliere?',
      en: 'Which Redditi PF 2026 sections must new cross-border workers fill?',
      de: 'Redditi PF 2026: welche Abschnitte für neue Grenzgänger?',
      fr: 'Redditi PF 2026 : quels cadres pour un nouveau frontalier ?',
    },
    answer: {
      it:
        "Il nuovo frontaliere compila almeno il quadro RC (redditi di lavoro dipendente estero, codice 4, con la quota esente nel rigo RC5) e il quadro CE (credito per imposte estere) [fonte: Istruzioni Redditi PF 2026, Agenzia Entrate]. L'eventuale monitoraggio fiscale di conti e previdenza svizzeri nel quadro RW e il trattamento di attività e immobili esteri vanno verificati sulle istruzioni ufficiali o con un CAF. Il termine telematico per i Redditi 2026 è il 2 novembre 2026. Il salario dei vecchi frontalieri coperto dall'art. 9 è imponibile solo in Svizzera; eventuali altri redditi e obblighi italiani vanno valutati separatamente.",
      en:
        "The new cross-border worker fills at least section RC (foreign employment income, code 4, with the exempt share in line RC5) and section CE (foreign tax credit) [source: Redditi PF 2026 instructions, Agenzia Entrate]. Any tax monitoring of Swiss accounts and pension assets in section RW, and the treatment of foreign assets and real estate, should be checked in the official instructions or with a CAF. The online filing deadline for Redditi 2026 is 2 November 2026. The salary of old cross-border workers covered by art. 9 is taxable only in Switzerland; any other Italian income and obligations must be assessed separately.",
      de:
        "Der neue Grenzgänger füllt mindestens Block RC (ausländisches Arbeitseinkommen, Code 4, mit dem steuerfreien Anteil in Zeile RC5) und Block CE (Steueranrechnung) aus [Quelle: Anleitungen Redditi PF 2026, Agenzia Entrate]. Eine allfällige Steuerüberwachung schweizerischer Konten und Vorsorgeguthaben in Block RW sowie die Behandlung ausländischer Vermögenswerte und Immobilien sind anhand der offiziellen Anleitungen oder mit einem CAF zu prüfen. Die elektronische Abgabefrist für Redditi 2026 ist der 2. November 2026. Der von Art. 9 erfasste Lohn alter Grenzgänger ist nur in der Schweiz steuerbar; andere italienische Einkünfte und Pflichten sind separat zu prüfen.",
      fr:
        "Le nouveau frontalier remplit au moins le cadre RC (revenus d'emploi étrangers, code 4, avec la part exonérée à la ligne RC5) et le cadre CE (crédit d'impôt étranger) [source : instructions Redditi PF 2026, Agenzia Entrate]. L'éventuelle surveillance fiscale des comptes et avoirs de prévoyance suisses au cadre RW, ainsi que le traitement des actifs et immeubles étrangers, sont à vérifier dans les instructions officielles ou auprès d'un CAF. Le délai de transmission télématique pour Redditi 2026 est le 2 novembre 2026. Le salaire des anciens frontaliers couvert par l'art. 9 est imposable uniquement en Suisse ; les autres revenus et obligations italiens sont à évaluer séparément.",
    },
    sources: [
      'https://www.agenziaentrate.gov.it/portale/documents/d/guest/pf1_istruzioni_2026_agg-28-05-2026',
      'https://infoprecompilata.agenziaentrate.gov.it/portale/quadro-rc',
    ],
  },
  {
    id: 'fisco-imposta-fonte-aliquote-ticino',
    category: 'fisco',
    question: {
      it: 'Quali sono le aliquote dell\'imposta alla fonte in Ticino nel 2026?',
      en: 'What are the 2026 withholding tax rates in Ticino?',
      de: 'Wie hoch sind die Quellensteuersätze im Tessin 2026?',
      fr: 'Quels sont les taux de l\'impôt à la source au Tessin en 2026 ?',
    },
    titleShort: {
      it: 'Aliquote imposta fonte Ticino 2026',
    },
    answer: {
      it:
        "Il Canton Ticino pubblica ogni anno le tabelle dell'imposta alla fonte per celibi/nubili (A), coniugati monoreddito (B), coniugati bireddito (C), famiglia monoparentale (H) e per minorenni con più datori (L) [fonte: AFC Ticino, Direttive imposta alla fonte 2026]. Le aliquote sono progressive e includono imposta cantonale, comunale e federale diretta (IFD). Esempio 2026 per un celibe senza figli residente in Italia (codice A0N) con reddito mensile lordo di 6.500 CHF: circa 11,9% effettivo. Le aliquote sono ridotte automaticamente nel 2026 per la revisione cantonale del 15 marzo 2024 che ha eliminato lo scaglione intermedio al 15%. Il datore di lavoro svizzero applica la tabella in base al certificato di residenza italiano trasmesso al servizio imposte Ticino.",
      en:
        "Canton Ticino publishes yearly withholding-tax tables for singles (A), married single-earner (B), married dual-earner (C), single-parent (H) and minors with multiple employers (L) [source: AFC Ticino, Withholding-tax directives 2026]. Rates are progressive and include cantonal, municipal and federal direct tax (IFD). Example 2026 for a single without children residing in Italy (code A0N) earning CHF 6,500/month gross: about 11.9% effective. Rates were reduced in 2026 after the 15 March 2024 cantonal reform removed the intermediate 15% bracket. The Swiss employer applies the table based on the Italian residence certificate filed with Ticino tax service.",
      de:
        "Der Kanton Tessin veröffentlicht jährlich Quellensteuertabellen für Ledige (A), verheiratet Einverdiener (B), verheiratet Zweiverdiener (C), Alleinerziehende (H) und Minderjährige mit mehreren Arbeitgebern (L) [Quelle: AFC Tessin, Weisungen Quellensteuer 2026]. Progressive Sätze inkl. Kanton, Gemeinde und direkte Bundessteuer (DBST). Beispiel 2026 Lediger ohne Kinder wohnhaft Italien (Code A0N) mit Bruttolohn 6'500 CHF/Monat: ca. 11,9 % effektiv. Senkung 2026 nach kantonaler Reform vom 15.03.2024 (Wegfall der Zwischenstufe 15 %). Der Schweizer Arbeitgeber wendet die Tabelle gemäss italienischem Wohnsitzzeugnis an.",
      fr:
        "Le canton du Tessin publie chaque année les barèmes d'impôt à la source pour célibataires (A), mariés mono-revenu (B), bi-revenu (C), familles monoparentales (H) et mineurs multi-employeurs (L) [source : AFC Tessin, Directives impôt à la source 2026]. Taux progressifs incluant cantonal, communal et IFD. Exemple 2026 pour célibataire sans enfants résidant en Italie (code A0N), revenu mensuel brut CHF 6 500 : ~11,9 % effectif. Baisse 2026 suite à la réforme cantonale du 15/03/2024 (suppression du palier 15 %). L'employeur suisse applique le barème selon le certificat de résidence italien.",
    },
    sources: [
      'https://www4.ti.ch/dfe/dc/dichiarazione/imposte-alla-fonte-1/tabelle-di-calcolo-dellimposta-alla-fonte/',
    ],
  },
  {
    id: 'fisco-ristorni-comuni-confine',
    category: 'fisco',
    question: {
      it: 'Come funzionano i ristorni ai Comuni italiani di confine?',
      en: 'How do rebates to Italian border municipalities work?',
      de: 'Wie funktionieren die Rückzahlungen an italienische Grenzgemeinden?',
      fr: 'Comment fonctionnent les ristournes aux communes italiennes frontalières ?',
    },
    titleShort: {
      de: 'Wie laufen die Rückzahlungen an italienische Grenzgemeinden ab?',
      fr: 'Comment fonctionnent les ristournes aux communes frontalières ?',
    },
    answer: {
      it:
        "L'Accordo 2020 prevede che ciascuno dei Cantoni Grigioni, Ticino e Vallese versi il 40% dell'imposta lorda dei frontalieri dell'art. 9, per gli anni fiscali fino a quello che termina il 31/12/2033 [fonte: Accordo art. 9]. Il pagamento avviene in franchi, una volta l'anno, su un conto di Tesoreria intestato al MEF; le autorità italiane trasferiscono le somme ai Comuni. Lo Stato italiano garantisce inoltre ai Comuni di frontiera 89 milioni di euro l'anno [fonte: L. 83/2023 artt. 9-10]. Per i nuovi frontalieri non è prevista compensazione.",
      en:
        "The 2020 Agreement provides that each of the cantons of Grigioni, Ticino and Valais pays 40% of the gross tax on art. 9 cross-border workers, for tax years up to the one ending on 31/12/2033 [source: Agreement art. 9]. Payment is made in francs, once a year, into a Treasury account held by the Italian MEF; the Italian authorities then transfer the sums to municipalities. The Italian State also guarantees border municipalities €89 million a year [source: Law 83/2023 arts. 9-10]. No compensation is provided for new cross-border workers.",
      de:
        "Das Abkommen 2020 sieht vor, dass die Kantone Graubünden, Tessin und Wallis je 40 % der Bruttosteuer der Grenzgänger nach Art. 9 zahlen, für die Steuerjahre bis zu jenem, das am 31.12.2033 endet [Quelle: Abkommen Art. 9]. Die Zahlung erfolgt in Franken, einmal jährlich, auf ein Tesoreria-Konto des italienischen MEF; die italienischen Behörden leiten die Beträge an die Gemeinden weiter. Der italienische Staat garantiert den Grenzgemeinden zudem 89 Millionen Euro pro Jahr [Quelle: Gesetz 83/2023 Art. 9-10]. Für neue Grenzgänger ist kein Ausgleich vorgesehen.",
      fr:
        "L'Accord de 2020 prévoit que chacun des cantons des Grisons, du Tessin et du Valais verse 40 % de l'impôt brut des frontaliers de l'art. 9, pour les années fiscales jusqu'à celle qui se termine le 31/12/2033 [source : Accord art. 9]. Le paiement se fait en francs, une fois par an, sur un compte de Trésorerie au nom du MEF italien ; les autorités italiennes transfèrent ensuite les sommes aux communes. L'État italien garantit en outre aux communes frontalières 89 millions d'euros par an [source : loi 83/2023 art. 9-10]. Aucune compensation n'est prévue pour les nouveaux frontaliers.",
    },
    sources: [
      'https://www.fedlex.admin.ch/eli/oc/2023/410/it',
      'https://www.normattiva.it/uri-res/N2Ls?urn:nir:stato:legge:2023-06-13;83',
      'https://www.mef.gov.it/',
    ],
  },
  {
    id: 'fisco-deducibilita-2-pilastro',
    category: 'fisco',
    question: {
      it: 'Il riscatto del 2° pilastro svizzero è deducibile in Italia?',
      en: 'Are Swiss 2nd pillar buy-ins deductible in Italy?',
      de: 'Sind Einkäufe in die schweizerische 2. Säule in Italien abzugsfähig?',
      fr: 'Les rachats du 2e pilier suisse sont-ils déductibles en Italie ?',
    },
    titleShort: {
      de: 'Sind Einkäufe in die Schweizer 2. Säule in Italien abzugsfähig?',
    },
    answer: {
      it:
        "Il trattamento fiscale di un riscatto o di un versamento volontario al 2° pilastro svizzero non è automatico: va verificato in base alla natura del versamento, al periodo d'imposta e alla documentazione disponibile; un acquisto volontario non va assimilato ai contributi LPP obbligatori trattenuti in busta paga [fonte: TUIR, art. 10, Normattiva]. Per il trattamento svizzero occorre verificare con l'istituto di previdenza e l'autorità fiscale la procedura applicabile. Prima di compilare il quadro RP, chiedere conferma a un CAF o a un professionista abilitato.",
      en:
        "The Italian tax treatment of a Swiss 2nd-pillar buy-in or voluntary contribution is not automatic: it must be checked against the type of contribution, tax year and supporting documents; a voluntary buy-in should not be treated as equivalent to mandatory LPP contributions withheld from payroll [source: TUIR art. 10, Normattiva]. For the Swiss treatment, verify the applicable procedure with the pension institution and tax authority. Before reporting it in box RP, confirm the position with a qualified Italian tax adviser.",
      de:
        "Die steuerliche Behandlung eines freiwilligen Einkaufs oder Beitrags in die schweizerische 2. Säule ist in Italien nicht automatisch: Sie muss anhand der Beitragsart, des Steuerjahres und der Belege geprüft werden; ein freiwilliger Einkauf darf nicht mit obligatorischen BVG-Beiträgen auf der Lohnabrechnung gleichgesetzt werden [Quelle: TUIR Art. 10, Normattiva]. Für die Schweizer Behandlung sind das Vorsorgeinstitut und die Steuerbehörde zur anwendbaren Regelung zu konsultieren. Vor dem Eintrag in Block RP sollte die Situation mit einer qualifizierten italienischen Steuerberatung geklärt werden.",
      fr:
        "Le traitement fiscal italien d'un rachat ou d'une cotisation volontaire au 2e pilier suisse n'est pas automatique : il doit être vérifié selon la nature du versement, l'exercice fiscal et les justificatifs ; un rachat volontaire ne doit pas être assimilé aux cotisations LPP obligatoires retenues sur la fiche de salaire [source : TUIR, art. 10, Normattiva]. Pour le traitement suisse, il faut vérifier la procédure applicable auprès de l'institution de prévoyance et de l'autorité fiscale. Avant de le reporter au cadre RP, confirmer la situation auprès d'un conseiller fiscal italien qualifié.",
    },
    relatedLinks: [
      {
        href: {
          it: '/tasse-e-pensione/calcola-previdenza/',
          en: '/en/taxes-and-pension/calculate-retirement/',
          de: '/de/steuern-und-vorsorge/rente-berechnen/',
          fr: '/fr/impots-et-retraite/calculer-pension/',
        },
        label: {
          it: 'Guida al 2° pilastro',
          en: '2nd pillar guide',
          de: 'Leitfaden 2. Säule',
          fr: 'Guide 2e pilier',
        },
      },
    ],
    sources: [
      'https://www.normattiva.it/uri-res/N2Ls?urn:nir:stato:decreto.del.presidente.della.repubblica:1986-12-22;917',
    ],
  },
  {
    id: 'fisco-tredicesima-dichiarazione',
    category: 'fisco',
    question: {
      it: 'La tredicesima svizzera rientra nella dichiarazione italiana?',
      en: 'Is the Swiss 13th-month bonus included in the Italian tax return?',
      de: 'Gehört der schweizerische 13. Monatslohn in die italienische Steuererklärung?',
      fr: 'Le 13e mois suisse entre-t-il dans la déclaration italienne ?',
    },
    titleShort: {
      de: 'Schweizer 13. Monatslohn in der italienischen Steuererklärung?',
    },
    answer: {
      it:
        "Sì. Per il nuovo frontaliere la tredicesima è reddito da lavoro dipendente ex art. 51 TUIR e va sommata alla base imponibile IRPEF nel quadro RC [fonte: Istruzioni Redditi PF 2026]. Se è versata con il cedolino di dicembre la ritenuta alla fonte svizzera è calcolata sulla tabella annualizzata; il controvalore in euro va convertito al cambio medio BCE dell'anno di percezione (principio di cassa). Il credito d'imposta riguarda la ritenuta svizzera, entro la quota di IRPEF proporzionale al reddito estero. Attenzione a premi una tantum o gratifiche straordinarie: vanno anch'essi dichiarati e non beneficiano di regimi agevolati italiani. Per i vecchi frontalieri la tredicesima resta tassata solo in Svizzera e non entra nella Redditi PF.",
      en:
        "Yes. For the new cross-border worker the 13th-month bonus is employment income under TUIR art. 51 and must be added to the IRPEF tax base in section RC [source: Redditi PF 2026 instructions]. If paid with the December payslip, Swiss withholding uses the annualised table; the EUR equivalent is converted at the yearly ECB average (cash basis). The foreign tax credit concerns Swiss withholding, up to the IRPEF share proportional to foreign income. One-off premiums and extraordinary bonuses also go in the return and do not enjoy Italian preferential regimes. For «old» workers, the 13th-month is Swiss-only and does not enter the Italian return.",
      de:
        "Ja. Für den neuen Grenzgänger ist der 13. Monatslohn Arbeitseinkommen gemäss TUIR Art. 51 und wird in Block RC zur IRPEF-Basis gezählt [Quelle: Anleitungen Redditi PF 2026]. Bei Dezemberauszahlung nutzt die Quellensteuer die annualisierte Tabelle; Umrechnung in Euro zum EZB-Jahresmittel (Kassaprinzip). Die Anrechnung betrifft die Schweizer Steuer, begrenzt auf den proportionalen IRPEF-Anteil. Einmalprämien sind ebenfalls zu deklarieren, keine italienischen Vergünstigungen. Für alte Grenzgänger bleibt der 13. Monatslohn nur in der Schweiz steuerpflichtig.",
      fr:
        "Oui. Pour le nouveau frontalier le 13e mois est revenu d'emploi art. 51 TUIR et entre dans la base IRPEF au cadre RC [source : instructions Redditi PF 2026]. Payé sur la fiche de décembre, la retenue suisse applique le barème annualisé ; conversion euro au taux moyen BCE de l'année (principe de caisse). Le crédit d'impôt porte sur la retenue suisse, dans la limite de la part d'IRPEF proportionnelle. Primes one-shot et gratifications sont aussi déclarées sans régime de faveur italien. Pour les anciens frontaliers, le 13e mois reste imposé en Suisse uniquement.",
    },
    sources: [
      'https://infoprecompilata.agenziaentrate.gov.it/portale/quadro-rc',
    ],
  },
  {
    id: 'fisco-guida-completa-tassazione-2026',
    category: 'fisco',
    question: {
      it: 'Dove trovo una guida completa e aggiornata alla tassazione dei frontalieri per il 2026?',
      en: 'Where can I find a complete, up-to-date guide to cross-border worker taxation for 2026?',
      de: 'Wo finde ich einen vollständigen, aktuellen Leitfaden zur Besteuerung von Grenzgängern für 2026?',
      fr: 'Où trouver un guide complet et à jour sur la fiscalité des frontaliers pour 2026 ?',
    },
    titleShort: {
      it: 'Guida completa alla tassazione dei frontalieri 2026',
      en: 'Where to find the complete 2026 cross-border taxation guide?',
      de: 'Wo finde ich den Leitfaden zur Grenzgänger-Besteuerung 2026?',
      fr: 'Où trouver un guide complet de la fiscalité frontalière 2026 ?',
    },
    answer: {
      it: "L'Accordo Italia-Svizzera del 23/12/2020, in vigore dal 17/07/2023, applicabile dal 1° gennaio 2024 e ratificato dalla Legge 83/2023, distingue due regimi: i «vecchi frontalieri» (residenti in Italia che soddisfano i requisiti dell'art. 9, avendo lavorato come frontalieri nei Cantoni GR, TI o VS al 17/07/2023 o tra il 31/12/2018 e quella data) restano tassati solo alla fonte in Svizzera, con compensazione del 40% all'Italia fino all'anno fiscale 2033; i «nuovi frontalieri» sono tassati sia in Svizzera sia in Italia, con franchigia di 10.000 € e credito d'imposta per evitare la doppia imposizione. Per il quadro normativo completo, le tabelle di calcolo e gli scenari pratici aggiornati al 2026 consulta la guida di riferimento e la panoramica pratica qui sotto, oltre alle tabelle ufficiali di imposta alla fonte del Cantone Ticino.",
      en: "The Italy-Switzerland Agreement of 23/12/2020, in force since 17/07/2023, applicable from 1 January 2024 and ratified by Italian Law 83/2023, sets out two regimes: 'old' cross-border workers (Italian residents who meet art. 9, having worked as cross-border workers in the cantons of GR, TI or VS on 17/07/2023 or between 31/12/2018 and that date) remain taxed only at source in Switzerland, with a 40% compensation to Italy through tax year 2033; 'new' cross-border workers are taxed in both Switzerland and Italy, with a €10,000 exemption and a foreign-tax credit to avoid double taxation. For the full legal framework, calculation tables and practical 2026 scenarios, see the reference guide and practical overview below, plus the official Canton Ticino withholding-tax tables.",
      de: "Das Abkommen Italien-Schweiz vom 23.12.2020, seit dem 17.07.2023 in Kraft, ab dem 1. Januar 2024 anwendbar und ratifiziert durch das italienische Gesetz 83/2023, unterscheidet zwei Regelungen: 'alte' Grenzgänger (Personen mit Wohnsitz in Italien, die Art. 9 erfüllen, weil sie am 17.07.2023 oder zwischen dem 31.12.2018 und diesem Datum als Grenzgänger in GR, TI oder VS arbeiteten) werden weiterhin ausschliesslich an der Quelle in der Schweiz besteuert, mit einem Ausgleich von 40 % an Italien bis zum Steuerjahr 2033; 'neue' Grenzgänger werden sowohl in der Schweiz als auch in Italien besteuert, mit einer Freigrenze von 10'000 € und einer Steueranrechnung zur Vermeidung der Doppelbesteuerung. Den vollständigen rechtlichen Rahmen, Berechnungstabellen und praxisnahe Szenarien für 2026 findest du im Referenzleitfaden und in der praktischen Übersicht unten sowie in den offiziellen Quellensteuertabellen des Kantons Tessin.",
      fr: "L'Accord Italie-Suisse du 23/12/2020, en vigueur depuis le 17/07/2023, applicable dès le 1er janvier 2024 et ratifié par la loi italienne 83/2023, distingue deux régimes : les « anciens » frontaliers (résidents italiens remplissant l'art. 9, ayant travaillé comme frontaliers dans les cantons GR, TI ou VS le 17/07/2023 ou entre le 31/12/2018 et cette date) restent imposés uniquement à la source en Suisse, avec une compensation de 40 % à l'Italie jusqu'à l'année fiscale 2033 ; les « nouveaux » frontaliers sont imposés à la fois en Suisse et en Italie, avec une franchise de 10 000 € et un crédit d'impôt pour éviter la double imposition. Pour le cadre juridique complet, les tableaux de calcul et des scénarios pratiques à jour pour 2026, consultez le guide de référence et l'aperçu pratique ci-dessous, ainsi que les barèmes officiels d'impôt à la source du canton du Tessin.",
    },
    relatedLinks: [
      {
        href: {
          it: '/guida-tassazione-frontalieri-2026/',
          en: '/en/cross-border-taxation-guide-2026/',
          de: '/de/grenzgaenger-besteuerung-leitfaden-2026/',
          fr: '/fr/guide-imposition-frontaliers-2026/',
        },
        label: {
          it: 'Guida di riferimento alla tassazione 2026',
          en: '2026 taxation reference guide',
          de: 'Referenzleitfaden Besteuerung 2026',
          fr: 'Guide de référence fiscalité 2026',
        },
      },
      {
        href: {
          it: '/guida-frontaliere/fiscalita/',
          en: '/en/cross-border-guide/taxation/',
          de: '/de/grenzgaenger-ratgeber/besteuerung/',
          fr: '/fr/guide-frontalier/fiscalite/',
        },
        label: {
          it: 'Panoramica pratica della fiscalità frontaliera',
          en: 'Practical cross-border tax overview',
          de: 'Praktische Übersicht Grenzgänger-Besteuerung',
          fr: 'Aperçu pratique de la fiscalité frontalière',
        },
      },
      {
        href: {
          it: '/guida-frontaliere/imposta-alla-fonte-ticino-tabelle-a-b-c-h/',
          en: '/en/cross-border-guide/withholding-tax-ticino-tables-a-b-c-h/',
          de: '/de/grenzgaenger-ratgeber/quellensteuer-tessin-tabellen-a-b-c-h/',
          fr: '/fr/guide-frontalier/impot-source-tessin-baremes-a-b-c-h/',
        },
        label: {
          it: 'Tabelle imposta alla fonte Ticino 2026',
          en: 'Ticino withholding-tax tables 2026',
          de: 'Quellensteuertabellen Tessin 2026',
          fr: 'Barèmes impôt à la source Tessin 2026',
        },
      },
    ],
    sources: [
      'https://www.fedlex.admin.ch/eli/oc/2023/410/it',
      'https://www.normattiva.it/uri-res/N2Ls?urn:nir:stato:legge:2023-06-13;83',
    ],
  },
  {
    id: 'fisco-impatto-coniuge-figli-netto',
    category: 'fisco',
    question: {
      it: 'Sposarsi o avere figli cambia le tasse che pago come frontaliere?',
      en: 'Does getting married or having children change the taxes I pay as a cross-border worker?',
      de: 'Ändert eine Heirat oder Kinder die Steuern, die ich als Grenzgänger zahle?',
      fr: 'Le mariage ou les enfants changent-ils les impôts que je paie en tant que frontalier ?',
    },
    titleShort: {
      en: 'Do marriage and children change my cross-border worker taxes?',
      de: 'Ändern Heirat und Kinder die Steuern für Grenzgänger?',
      fr: 'Mariage et enfants changent-ils les impôts du frontalier ?',
    },
    answer: {
      it: "Sì, ma l'effetto dipende dal tuo regime. Per i «vecchi frontalieri» (tassati solo in Svizzera) stato civile e figli incidono sulla tabella di imposta alla fonte applicata dal datore di lavoro (coniugato monoreddito, coniugato doppio reddito, con figli a carico). Per i «nuovi frontalieri» (tassati anche in Italia) contano inoltre le detrazioni per carichi di famiglia previste dal TUIR nella dichiarazione dei redditi italiana, oltre alla franchigia di 10.000 € valida indipendentemente dallo stato civile. L'impatto esatto sullo stipendio netto varia molto in base a reddito, cantone e numero di figli: per una stima puntuale con i tuoi dati consulta gli approfondimenti dedicati qui sotto.",
      en: "Yes, but the effect depends on your regime. For 'old' cross-border workers (taxed only in Switzerland), marital status and children affect which withholding-tax table the employer applies (single-earner married, dual-earner married, with dependent children). For 'new' cross-border workers (also taxed in Italy), family-dependant deductions under the Italian TUIR also apply in the Italian tax return, on top of the €10,000 exemption that applies regardless of marital status. The exact impact on net salary varies a lot by income, canton and number of children: see the dedicated deep-dives below for a precise estimate with your own figures.",
      de: "Ja, aber die Wirkung hängt vom jeweiligen Regime ab. Für 'alte' Grenzgänger (nur in der Schweiz besteuert) beeinflussen Zivilstand und Kinder, welche Quellensteuertabelle der Arbeitgeber anwendet (verheiratet Einverdiener, verheiratet Zweiverdiener, mit unterhaltsberechtigten Kindern). Für 'neue' Grenzgänger (auch in Italien besteuert) gelten zusätzlich die Familienabzüge nach italienischem TUIR in der italienischen Steuererklärung, zusätzlich zur Freigrenze von 10'000 €, die unabhängig vom Zivilstand gilt. Die genaue Auswirkung auf den Nettolohn hängt stark von Einkommen, Kanton und Kinderzahl ab: Für eine präzise Schätzung mit deinen eigenen Zahlen findest du unten weiterführende Analysen.",
      fr: "Oui, mais l'effet dépend de votre régime. Pour les « anciens » frontaliers (imposés uniquement en Suisse), l'état civil et les enfants déterminent le barème d'impôt à la source appliqué par l'employeur (marié un revenu, marié deux revenus, avec enfants à charge). Pour les « nouveaux » frontaliers (imposés aussi en Italie), les déductions pour charges de famille prévues par le TUIR italien s'appliquent en plus dans la déclaration italienne, en plus de la franchise de 10 000 € valable quel que soit l'état civil. L'impact exact sur le salaire net varie beaucoup selon le revenu, le canton et le nombre d'enfants : consultez les analyses détaillées ci-dessous pour une estimation précise avec vos propres chiffres.",
    },
    relatedLinks: [
      {
        href: {
          it: '/guida-frontaliere/quanto-incidono-figli-stipendio-netto-frontaliere/',
          en: '/en/cross-border-guide/how-children-affect-crossborder-worker-net-salary/',
          de: '/de/grenzgaenger-ratgeber/wie-kinder-nettogehalt-grenzgaenger-beeinflussen/',
          fr: '/fr/guide-frontalier/impact-enfants-salaire-net-frontalier/',
        },
        label: {
          it: 'Impatto dei figli sullo stipendio netto',
          en: 'Impact of children on net salary',
          de: 'Einfluss von Kindern auf den Nettolohn',
          fr: 'Impact des enfants sur le salaire net',
        },
      },
      {
        href: {
          it: '/guida-frontaliere/sposato-o-single-impatto-tasse-frontaliere/',
          en: '/en/cross-border-guide/married-or-single-impact-on-crossborder-taxes/',
          de: '/de/grenzgaenger-ratgeber/verheiratet-oder-ledig-auswirkung-steuern-grenzgaenger/',
          fr: '/fr/guide-frontalier/marie-ou-celibataire-impact-impots-frontalier/',
        },
        label: {
          it: 'Sposato o single: impatto sulle tasse',
          en: 'Married or single: impact on taxes',
          de: 'Verheiratet oder ledig: Einfluss auf die Steuern',
          fr: 'Marié ou célibataire : impact sur les impôts',
        },
      },
      {
        href: {
          it: '/guida-frontaliere/nuovo-vs-vecchio-frontaliere-differenze-fiscali/',
          en: '/en/cross-border-guide/new-vs-old-crossborder-worker-tax-differences/',
          de: '/de/grenzgaenger-ratgeber/neuer-vs-alter-grenzgaenger-steuerliche-unterschiede/',
          fr: '/fr/guide-frontalier/nouveau-vs-ancien-frontalier-differences-fiscales/',
        },
        label: {
          it: 'Vecchio vs nuovo frontaliere: differenze fiscali',
          en: 'Old vs new cross-border worker: tax differences',
          de: 'Alter vs neuer Grenzgänger: steuerliche Unterschiede',
          fr: 'Ancien vs nouveau frontalier : différences fiscales',
        },
      },
    ],
    sources: [
      'https://www.fedlex.admin.ch/eli/oc/2023/410/it',
      'https://www4.ti.ch/dfe/dc/dichiarazione/imposte-alla-fonte-1/tabelle-di-calcolo-dellimposta-alla-fonte/',
    ],
  },
  {
    id: 'fisco-zona-frontaliera-20km-fiscalita',
    category: 'fisco',
    question: {
      it: 'La distanza dal confine (20 km) incide sul mio status fiscale di frontaliere?',
      en: 'Does the 20 km distance from the border affect my cross-border tax status?',
      de: 'Wirkt sich die 20-km-Grenzdistanz auf meinen steuerlichen Grenzgängerstatus aus?',
      fr: 'La distance de 20 km à la frontière a-t-elle un impact sur mon statut fiscal de frontalier ?',
    },
    titleShort: {
      it: 'I 20 km dal confine incidono sullo status fiscale di frontaliere?',
      en: 'Does the 20 km border distance affect my cross-border tax status?',
      de: 'Beeinflusst die 20-km-Zone den steuerlichen Grenzgängerstatus?',
      fr: 'La zone des 20 km change-t-elle mon statut fiscal de frontalier ?',
    },
    answer: {
      it: "La qualifica richiede la residenza in un Comune dell'elenco ufficiale, il cui territorio ricade anche parzialmente nella zona di 20 km, il lavoro nei Cantoni GR, TI o VS e il rientro in linea di principio quotidiano, con tolleranza di 45 giorni l'anno per motivi professionali. Chi risiede fuori dalla fascia non è frontaliere ai sensi dell'Accordo: ritenuta alla fonte ordinaria in Svizzera e tassazione in Italia con credito. La franchigia italiana di 10.000 € non è esclusa solo per questo, se ne ricorrono i requisiti [fonte: Accordo art. 2; L. 83/2023 art. 4; dal 2027 D.Lgs. 117/2026 art. 217]. Per i dettagli su Comuni ammessi e casi limite consulta l'approfondimento dedicato qui sotto.",
      en: "The status requires residence in a municipality on the official list, whose territory falls at least partly within the 20 km zone, work in the cantons of GR, TI or VS, and returning home in principle daily, with a tolerance of 45 days a year for work reasons. Anyone living outside the zone is not a cross-border worker under the Agreement: ordinary Swiss withholding tax and taxation in Italy with a credit. The €10,000 Italian exemption is not excluded for that reason alone, if its requirements are met [source: Agreement art. 2; Law 83/2023 art. 4; from 2027 Legislative Decree 117/2026 art. 217]. For details on eligible municipalities and edge cases, see the dedicated deep-dive below.",
      de: "Der Status setzt den Wohnsitz in einer Gemeinde der offiziellen Liste voraus, deren Gebiet zumindest teilweise in der 20-km-Zone liegt, die Arbeit in den Kantonen GR, TI oder VS und die grundsätzlich tägliche Rückkehr, mit einer Toleranz von 45 Tagen pro Jahr aus beruflichen Gründen. Wer ausserhalb der Zone wohnt, ist kein Grenzgänger im Sinne des Abkommens: ordentliche Quellensteuer in der Schweiz und Besteuerung in Italien mit Anrechnung. Der italienische Freibetrag von 10'000 € ist allein deshalb nicht ausgeschlossen, sofern seine Voraussetzungen erfüllt sind [Quelle: Abkommen Art. 2; Gesetz 83/2023 Art. 4; ab 2027 D.Lgs. 117/2026 Art. 217]. Details zu zulässigen Gemeinden und Grenzfällen findest du in der Vertiefung unten.",
      fr: "Le statut exige la résidence dans une commune de la liste officielle, dont le territoire se situe au moins en partie dans la zone de 20 km, le travail dans les cantons GR, TI ou VS et le retour en principe quotidien, avec une tolérance de 45 jours par an pour raisons professionnelles. Toute personne résidant hors de la zone n'est pas frontalière au sens de l'Accord : impôt à la source ordinaire en Suisse et imposition en Italie avec crédit. La franchise italienne de 10 000 € n'est pas exclue pour cette seule raison, si ses conditions sont remplies [source : Accord art. 2 ; loi 83/2023 art. 4 ; dès 2027 D.Lgs. 117/2026 art. 217]. Pour le détail des communes éligibles et des cas limites, consultez l'analyse dédiée ci-dessous.",
    },
    relatedLinks: [
      {
        href: {
          it: '/guida-frontaliere/frontaliere-entro-o-oltre-20km-cosa-cambia/',
          en: '/en/cross-border-guide/crossborder-within-or-over-20km-what-changes/',
          de: '/de/grenzgaenger-ratgeber/grenzgaenger-innerhalb-oder-ueber-20km-was-aendert-sich/',
          fr: '/fr/guide-frontalier/frontalier-moins-ou-plus-20km-ce-qui-change/',
        },
        label: {
          it: 'Entro o oltre i 20 km: cosa cambia',
          en: 'Within or beyond 20 km: what changes',
          de: 'Innerhalb oder ausserhalb 20 km: was sich ändert',
          fr: 'À moins ou plus de 20 km : ce qui change',
        },
      },
      {
        href: {
          it: '/guida-tassazione-frontalieri-2026/',
          en: '/en/cross-border-taxation-guide-2026/',
          de: '/de/grenzgaenger-besteuerung-leitfaden-2026/',
          fr: '/fr/guide-imposition-frontaliers-2026/',
        },
        label: {
          it: 'Guida di riferimento alla tassazione 2026',
          en: '2026 taxation reference guide',
          de: 'Referenzleitfaden Besteuerung 2026',
          fr: 'Guide de référence fiscalité 2026',
        },
      },
    ],
    sources: [
      'https://www.fedlex.admin.ch/eli/oc/2023/410/it',
    ],
  },
];
