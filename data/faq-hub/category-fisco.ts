import type { FaqHubEntry } from './types';

/**
 * FAQ hub — category "fisco" (AE-5, 10/100).
 *
 * Scope: imposta alla fonte, nuova legge fiscale 2026 (Accordo CH-IT
 * 17/07/2023 + LF 13 giugno 2023 n. 83), dichiarazione in Italia,
 * ritenute, deduzioni, ristorni ai comuni di confine.
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
    answer: {
      it:
        "Dal 1° gennaio 2024 è operativo il nuovo Accordo CH-IT sui frontalieri firmato il 23/12/2020 e ratificato con la Legge italiana 13 giugno 2023 n. 83 [fonte: Fedlex SR 0.642.045.43]. I «nuovi frontalieri» (assunti dopo il 17/07/2023) sono tassati in Svizzera alla fonte con aliquota piena e poi dichiarano il reddito in Italia con credito d'imposta fino all'80% del prelievo svizzero [fonte: Agenzia Entrate, Circ. 4/E 2024]. I «vecchi frontalieri» restano con tassazione esclusiva in Svizzera più ristorni ai Comuni italiani fino al 2033. Per il 2026 la franchigia IRPEF italiana sale a 10.000 € e la deduzione forfetaria sanitaria è 3.000 € [fonte: AFC Ticino, scheda 2026].",
      en:
        "From 1 January 2024 the new CH-IT cross-border agreement signed 23/12/2020 and ratified by Italian Law 13 June 2023 No. 83 is in force [source: Fedlex SR 0.642.045.43]. «New» cross-border workers (hired after 17/07/2023) are taxed at source in Switzerland at full rate and then declare income in Italy with a tax credit up to 80% of the Swiss levy [source: Agenzia Entrate, Circolare 4/E 2024]. «Old» cross-border workers keep Swiss-only taxation with rebates to Italian border municipalities until 2033. For 2026 the Italian IRPEF exemption rises to €10,000 and the flat healthcare deduction to €3,000 [source: AFC Ticino, 2026 sheet].",
      de:
        "Seit dem 1. Januar 2024 gilt das neue CH-IT-Grenzgängerabkommen vom 23.12.2020, ratifiziert durch das italienische Gesetz 13. Juni 2023 Nr. 83 [Quelle: Fedlex SR 0.642.045.43]. «Neue» Grenzgänger (ab 17.07.2023 angestellt) zahlen in der Schweiz die volle Quellensteuer und versteuern das Einkommen zusätzlich in Italien mit Anrechnung bis 80 % der schweizerischen Abgabe [Quelle: Agenzia Entrate, Rundschr. 4/E 2024]. «Alte» Grenzgänger bleiben bis 2033 ausschliesslich in der Schweiz steuerpflichtig mit Rückzahlungen an italienische Grenzgemeinden. Für 2026 steigt der italienische IRPEF-Freibetrag auf 10'000 € und der Gesundheits-Pauschalabzug auf 3'000 € [Quelle: AFC Tessin, Merkblatt 2026].",
      fr:
        "Depuis le 1er janvier 2024 le nouvel accord CH-IT sur les frontaliers du 23/12/2020, ratifié par la Loi italienne 13 juin 2023 n° 83, est en vigueur [source : Fedlex SR 0.642.045.43]. Les « nouveaux » frontaliers (embauchés après le 17/07/2023) sont imposés à la source en Suisse au taux plein puis déclarent le revenu en Italie avec crédit d'impôt jusqu'à 80 % du prélèvement suisse [source : Agenzia Entrate, circ. 4/E 2024]. Les « anciens » frontaliers gardent l'imposition exclusive en Suisse avec ristournes aux communes italiennes jusqu'en 2033. Pour 2026 la franchise IRPEF italienne passe à 10 000 € et la déduction santé forfaitaire à 3 000 € [source : AFC Tessin, fiche 2026].",
    },
    relatedLinks: [
      {
        href: '/guida-frontaliere/nuova-legge-frontalieri-2024/',
        label: {
          it: 'Guida alla nuova legge frontalieri 2024',
          en: 'Guide to the 2024 cross-border law',
          de: 'Leitfaden zum Grenzgängergesetz 2024',
          fr: "Guide de la nouvelle loi frontaliers 2024",
        },
      },
      {
        href: '/fisco-frontalieri/',
        label: {
          it: 'Hub fiscale frontalieri',
          en: 'Cross-border tax hub',
          de: 'Steuer-Hub für Grenzgänger',
          fr: 'Hub fiscal frontaliers',
        },
      },
    ],
    sources: [
      'https://www.fedlex.admin.ch/eli/cc/2023/694/it',
      'https://www.agenziaentrate.gov.it/portale/documents/20143/5451565/Circolare+n.+4+del+12+febbraio+2024.pdf',
      'https://www4.ti.ch/dfe/dc/imposta-alla-fonte',
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
    answer: {
      it:
        "Lo spartiacque è il 17 luglio 2023, data di entrata in vigore dell'Accordo [fonte: Fedlex SR 0.642.045.43]. I «vecchi frontalieri» (che lavoravano in Ticino, Grigioni o Vallese tra il 31/12/2018 e il 17/07/2023 e risiedono entro 20 km dal confine) restano tassati solo in Svizzera; il Canton Ticino versa ogni anno il 38,8% del gettito ai Comuni italiani di confine come ristorno, fino al 2033 [fonte: Accordo CH-IT art. 9 transitorio]. I «nuovi frontalieri» invece pagano l'imposta alla fonte svizzera ma dichiarano integralmente il reddito in Italia, con credito d'imposta fino all'80%. Applicano la franchigia IRPEF (10.000 € nel 2026) e la deduzione sanitaria (3.000 €) [fonte: Legge 13/06/2023 n. 83 art. 3]. Le aliquote effettive sono quindi molto diverse.",
      en:
        "The watershed is 17 July 2023, the Agreement's entry into force [source: Fedlex SR 0.642.045.43]. «Old» workers (employed in Ticino, Grigioni or Valais between 31/12/2018 and 17/07/2023 and residing within 20 km of the border) remain taxed only in Switzerland; Canton Ticino pays 38.8% of the revenue back to Italian border municipalities every year until 2033 [source: Agreement art. 9 transitional]. «New» workers pay Swiss withholding but declare full income in Italy with a foreign tax credit up to 80%. They apply the IRPEF exemption (€10,000 in 2026) and the healthcare deduction (€3,000) [source: Italian Law 13/06/2023 No. 83 art. 3]. Effective rates differ substantially.",
      de:
        "Die Trennlinie ist der 17. Juli 2023, das Inkrafttreten des Abkommens [Quelle: Fedlex SR 0.642.045.43]. «Alte» Grenzgänger (zwischen 31.12.2018 und 17.07.2023 im Tessin, Graubünden oder Wallis angestellt, wohnhaft innerhalb 20 km von der Grenze) bleiben nur in der Schweiz steuerpflichtig; der Kanton Tessin überweist jährlich 38,8 % des Aufkommens bis 2033 an die italienischen Grenzgemeinden [Quelle: Abkommen Art. 9 Übergang]. «Neue» Grenzgänger zahlen schweizerische Quellensteuer und versteuern das Einkommen auch in Italien mit Anrechnung bis 80 %. Sie wenden den IRPEF-Freibetrag (10'000 € 2026) und den Gesundheitsabzug (3'000 €) an [Quelle: Gesetz 13.06.2023 Nr. 83 Art. 3]. Die Effektivsätze unterscheiden sich erheblich.",
      fr:
        "La date charnière est le 17 juillet 2023, entrée en vigueur de l'Accord [source : Fedlex SR 0.642.045.43]. Les « anciens » frontaliers (employés au Tessin, Grisons ou Valais entre le 31/12/2018 et le 17/07/2023 et résidant à moins de 20 km) restent imposés en Suisse uniquement ; le canton verse 38,8 % du produit aux communes italiennes frontalières jusqu'en 2033 [source : Accord art. 9 transitoire]. Les « nouveaux » paient l'impôt à la source suisse puis déclarent le revenu en Italie avec crédit d'impôt jusqu'à 80 %. Ils appliquent la franchise IRPEF (10 000 € en 2026) et la déduction santé (3 000 €) [source : Loi 13/06/2023 n° 83 art. 3]. Les taux effectifs diffèrent nettement.",
    },
    relatedLinks: [
      {
        href: '/guida-frontaliere/nuova-legge-frontalieri-2024/',
        label: {
          it: 'Nuova legge frontalieri 2024',
          en: 'New 2024 cross-border law',
          de: 'Neues Grenzgängergesetz 2024',
          fr: 'Nouvelle loi frontaliers 2024',
        },
      },
    ],
    sources: [
      'https://www.fedlex.admin.ch/eli/cc/2023/694/it',
      'https://www.normattiva.it/uri-res/N2Ls?urn:nir:stato:legge:2023-06-13;83',
    ],
  },
  {
    id: 'fisco-franchigia-10000-euro',
    category: 'fisco',
    question: {
      it: 'Come funziona la franchigia IRPEF di 10.000 € per i nuovi frontalieri?',
      en: 'How does the €10,000 IRPEF exemption work for new cross-border workers?',
      de: 'Wie funktioniert der IRPEF-Freibetrag von 10 000 € für neue Grenzgänger?',
      fr: 'Comment fonctionne la franchise IRPEF de 10 000 € pour les nouveaux frontaliers ?',
    },
    answer: {
      it:
        "La Legge 13/06/2023 n. 83, art. 4, esclude dalla base imponibile IRPEF i primi 10.000 € del reddito da lavoro dipendente prestato in Svizzera per i «nuovi frontalieri» [fonte: Normattiva, L. 83/2023]. Dal 2024 la franchigia era 10.000 € e resta confermata anche per l'anno d'imposta 2026 [fonte: Circolare Agenzia Entrate 4/E 2024]. Non si cumula con la detassazione degli impatriati. Si applica una sola volta anche se il contribuente ha più datori di lavoro svizzeri. In dichiarazione va indicata nel quadro RC al rigo dedicato ai redditi esteri (codice 9), e il software RedditiPF 2026 la applica automaticamente se il codice Stato è CH. La franchigia si somma alla deduzione forfetaria sanitaria di 3.000 €.",
      en:
        "Italian Law 13/06/2023 No. 83 art. 4 excludes the first €10,000 of Swiss employment income from the IRPEF tax base for «new» cross-border workers [source: Normattiva, L. 83/2023]. The exemption was €10,000 in 2024 and is confirmed for tax year 2026 [source: Agenzia Entrate Circular 4/E 2024]. It cannot be combined with the inbound-workers regime. It applies only once even if the taxpayer has multiple Swiss employers. In the tax return it is reported in box RC on the foreign-income line (code 9); the RedditiPF 2026 software applies it automatically when country code is CH. The exemption stacks with the €3,000 flat healthcare deduction.",
      de:
        "Das italienische Gesetz 13.06.2023 Nr. 83 Art. 4 nimmt die ersten 10 000 € des in der Schweiz erzielten Arbeitseinkommens der «neuen» Grenzgänger von der IRPEF aus [Quelle: Normattiva, L. 83/2023]. Der Freibetrag betrug 2024 10 000 € und ist für Steuerjahr 2026 bestätigt [Quelle: Rundschreiben Agenzia Entrate 4/E 2024]. Er ist nicht mit dem Impatriates-Regime kumulierbar. Er gilt nur einmal, auch bei mehreren Schweizer Arbeitgebern. In der Steuererklärung wird er im Block RC bei den ausländischen Einkünften (Code 9) eingetragen; die Software RedditiPF 2026 wendet ihn automatisch an. Der Freibetrag addiert sich zum Gesundheits-Pauschalabzug von 3 000 €.",
      fr:
        "La loi italienne 13/06/2023 n° 83 art. 4 exclut de la base IRPEF les premiers 10 000 € de revenu de travail suisse des « nouveaux » frontaliers [source : Normattiva, L. 83/2023]. La franchise valait 10 000 € en 2024 et est confirmée pour l'année fiscale 2026 [source : circulaire Agenzia Entrate 4/E 2024]. Non cumulable avec le régime des impatriés. Elle s'applique une seule fois même avec plusieurs employeurs suisses. Dans la déclaration on la reporte au cadre RC à la ligne revenus étrangers (code 9) ; le logiciel RedditiPF 2026 l'applique automatiquement si le code pays est CH. Elle se cumule avec la déduction santé forfaitaire de 3 000 €.",
    },
    relatedLinks: [
      {
        href: '/fisco-frontalieri/',
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
      'https://www.agenziaentrate.gov.it/portale/documents/20143/5451565/Circolare+n.+4+del+12+febbraio+2024.pdf',
    ],
  },
  {
    id: 'fisco-deduzione-sanitaria-3000',
    category: 'fisco',
    question: {
      it: 'Che cos\'è la deduzione forfetaria sanitaria di 3.000 € dei frontalieri?',
      en: 'What is the €3,000 flat healthcare deduction for cross-border workers?',
      de: 'Was ist der pauschale Gesundheitsabzug von 3 000 € für Grenzgänger?',
      fr: 'Qu\'est-ce que la déduction santé forfaitaire de 3 000 € pour frontaliers ?',
    },
    answer: {
      it:
        "L'art. 1, comma 175, legge di bilancio 2024 e la L. 83/2023 art. 5 consentono ai nuovi frontalieri di dedurre un importo forfetario di 3.000 € dal reddito imponibile a titolo di contributi sanitari obbligatori versati in Svizzera (LAMal e LAINF) [fonte: Normattiva, Legge 213/2023]. La deduzione è alternativa alla deduzione analitica dei contributi effettivi (documentati con polizza LAMal). Si applica solo ai nuovi frontalieri tassati in Italia e non ai vecchi. In dichiarazione va riportata nel quadro RP, rigo RP26 codice 10. Chi ha una polizza LAMal con franchigia alta e premio basso (<3.000 €/anno) di solito preferisce il forfait; chi ha famiglia numerosa con premi oltre 5.000 € conviene andare in analitico.",
      en:
        "Italian budget law 2024 art. 1 para. 175 and L. 83/2023 art. 5 allow new cross-border workers to deduct a flat €3,000 from taxable income for mandatory Swiss health contributions (LAMal and LAINF) [source: Normattiva, Law 213/2023]. The deduction is an alternative to the itemised deduction of actual contributions (documented via LAMal policy). It applies only to new workers taxed in Italy, not to old ones. It is reported in box RP, line RP26 code 10. Workers with a LAMal policy with high deductible and premium <€3,000/year usually pick the flat amount; families with premiums above €5,000 should go itemised.",
      de:
        "Das italienische Haushaltsgesetz 2024 Art. 1 Abs. 175 und L. 83/2023 Art. 5 erlauben neuen Grenzgängern einen Pauschalabzug von 3 000 € für obligatorische Schweizer Gesundheitsbeiträge (KVG und UVG) [Quelle: Normattiva, Gesetz 213/2023]. Alternative zur analytischen Abzug der tatsächlichen Beiträge (mit KVG-Police belegt). Gilt nur für neue, in Italien besteuerte Grenzgänger, nicht für alte. Eintrag im Block RP, Zeile RP26 Code 10. Wer eine KVG-Police mit hoher Franchise und Prämie <3 000 €/Jahr hat, wählt meist die Pauschale; Familien mit Prämien über 5 000 € sollten analytisch abziehen.",
      fr:
        "La loi de finances italienne 2024 art. 1 al. 175 et L. 83/2023 art. 5 permettent aux nouveaux frontaliers une déduction forfaitaire de 3 000 € pour cotisations santé suisses obligatoires (LAMal et LAA) [source : Normattiva, Loi 213/2023]. Alternative à la déduction analytique des cotisations réelles (justifiées par la police LAMal). Ne concerne que les nouveaux frontaliers imposés en Italie. À reporter au cadre RP, ligne RP26 code 10. Avec une police LAMal à franchise élevée et prime <3 000 €/an, le forfait est souvent avantageux ; pour les familles avec primes >5 000 € il vaut mieux l'analytique.",
    },
    sources: [
      'https://www.normattiva.it/uri-res/N2Ls?urn:nir:stato:legge:2023-12-30;213',
      'https://www.agenziaentrate.gov.it/portale/documents/20143/5451565/Circolare+n.+4+del+12+febbraio+2024.pdf',
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
    answer: {
      it:
        "L'art. 165 TUIR e la Convenzione CH-IT del 1976 [fonte: Fedlex SR 0.672.945.41] disciplinano il credito per imposte pagate all'estero. Il nuovo frontaliere somma al reddito imponibile IRPEF il reddito lordo svizzero convertito in euro al cambio medio BCE dell'anno, applica aliquote IRPEF e addizionali, e poi detrae il minore tra (a) l'imposta svizzera effettivamente trattenuta e (b) la quota IRPEF proporzionale al reddito estero, con tetto 80% a partire dal 2024 [fonte: L. 83/2023 art. 3]. Il certificato fiscale svizzero (Lohnausweis/certificato salariale) e le ritenute quietanzate sono i documenti probatori. Nel modello Redditi si compila quadro CE sezione I-A. Se il credito eccede l'imposta italiana dovuta, l'eccedenza non è rimborsabile.",
      en:
        "Italian TUIR art. 165 and the CH-IT Convention of 1976 [source: Fedlex SR 0.672.945.41] govern the foreign-tax credit. The new cross-border worker adds to the IRPEF tax base the Swiss gross income converted at the yearly ECB average rate, applies IRPEF and regional surtaxes, then credits the lower of (a) Swiss withholding actually withheld and (b) the IRPEF share proportional to foreign income, capped at 80% from 2024 [source: L. 83/2023 art. 3]. The Swiss Lohnausweis and withholding receipts are the evidence. In the Redditi form, section CE I-A. Any excess credit over Italian tax due is not refundable.",
      de:
        "Der italienische TUIR-Art. 165 und das Abkommen CH-IT von 1976 [Quelle: Fedlex SR 0.672.945.41] regeln die Anrechnung ausländischer Steuern. Der neue Grenzgänger rechnet den in Euro umgerechneten schweizerischen Bruttolohn (EZB-Jahresmittel) zur IRPEF-Basis, wendet IRPEF + Zuschläge an und rechnet den niedrigeren Betrag von (a) tatsächlich abgezogener Quellensteuer oder (b) anteiliger IRPEF auf das Auslandseinkommen an, Obergrenze 80 % ab 2024 [Quelle: L. 83/2023 Art. 3]. Belege: Lohnausweis und Quellensteuerbescheinigung. Im Redditi-Formular Abschnitt CE I-A. Überschuss nicht rückforderbar.",
      fr:
        "L'art. 165 TUIR et la Convention CH-IT de 1976 [source : Fedlex SR 0.672.945.41] régissent le crédit pour impôts payés à l'étranger. Le nouveau frontalier ajoute à la base IRPEF le revenu brut suisse converti au taux moyen BCE de l'année, applique IRPEF et surtaxes, puis déduit le moindre entre (a) l'impôt suisse réellement retenu et (b) la part IRPEF proportionnelle au revenu étranger, plafonnée à 80 % dès 2024 [source : L. 83/2023 art. 3]. Documents : Lohnausweis suisse et quittances de retenue. Dans le modèle Redditi cadre CE section I-A. Excédent non remboursable.",
    },
    relatedLinks: [
      {
        href: '/calcolatore/',
        label: {
          it: 'Calcolatore netto frontaliere',
          en: 'Cross-border net calculator',
          de: 'Grenzgänger-Nettorechner',
          fr: 'Calculateur net frontalier',
        },
      },
    ],
    sources: [
      'https://www.fedlex.admin.ch/eli/cc/1979/441_441_441/it',
      'https://www.normattiva.it/uri-res/N2Ls?urn:nir:stato:legge:2023-06-13;83',
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
    answer: {
      it:
        "Il nuovo frontaliere compila almeno: quadro RC (redditi di lavoro dipendente estero, codice 4), quadro CE sezione I-A (credito per imposte estere), quadro RW (monitoraggio fiscale di conti bancari e 2° pilastro svizzeri con saldo >15.000 €), quadro RP per le deduzioni (incluso rigo RP26 codice 10 per il forfait sanitario) e quadro AC se possiede immobili esteri [fonte: Istruzioni Redditi PF 2026, Agenzia Entrate]. È esonerato dall'IVAFE sui conti correnti svizzeri ma deve pagare l'IVIE sugli immobili in CH. Il termine di trasmissione è il 30 settembre 2026 tramite Entratel/Fisconline; i vecchi frontalieri non devono presentare il Redditi perché la tassazione è esclusivamente svizzera.",
      en:
        "The new cross-border worker must fill at least: section RC (foreign employment income, code 4), section CE I-A (foreign tax credit), section RW (tax monitoring of Swiss bank accounts and 2nd pillar over €15,000), section RP for deductions (including line RP26 code 10 for the flat healthcare amount), and section AC if they own foreign real estate [source: Redditi PF 2026 instructions, Agenzia Entrate]. They are exempt from IVAFE on Swiss accounts but owe IVIE on Swiss real estate. Filing deadline is 30 September 2026 via Entratel/Fisconline; old cross-border workers do not file because taxation is Swiss-only.",
      de:
        "Der neue Grenzgänger füllt mindestens: Block RC (ausländisches Arbeitseinkommen, Code 4), Block CE Abschn. I-A (Steueranrechnung), Block RW (Steuerüberwachung schweizerischer Bankkonten und 2. Säule >15 000 €), Block RP für Abzüge (inkl. Zeile RP26 Code 10 Gesundheitspauschale) und Block AC bei ausländischen Immobilien [Quelle: Anleitungen Redditi PF 2026, Agenzia Entrate]. IVAFE auf CH-Konten entfällt, IVIE auf CH-Immobilien ist zu zahlen. Abgabefrist 30.09.2026 via Entratel/Fisconline; alte Grenzgänger reichen nicht ein.",
      fr:
        "Le nouveau frontalier remplit au moins : cadre RC (revenus d'emploi étrangers, code 4), cadre CE section I-A (crédit d'impôt étranger), cadre RW (surveillance fiscale des comptes suisses et 2e pilier >15 000 €), cadre RP pour les déductions (ligne RP26 code 10 pour la santé forfaitaire) et cadre AC pour les biens immobiliers étrangers [source : instructions Redditi PF 2026, Agenzia Entrate]. IVAFE non due sur comptes CH, IVIE due sur biens CH. Envoi au 30/09/2026 via Entratel/Fisconline ; les anciens frontaliers ne déposent pas.",
    },
    sources: [
      'https://www.agenziaentrate.gov.it/portale/web/guest/schede/dichiarazioni/redditi-pf-2026',
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
      'https://www4.ti.ch/dfe/dc/imposta-alla-fonte',
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
    answer: {
      it:
        "L'accordo CH-IT del 1974 e l'Accordo 2020 prevedono che la Svizzera retroceda ai Comuni italiani di confine (Lombardia, Piemonte) una quota dell'imposta alla fonte sui «vecchi frontalieri»: 38,8% per il 2024-2033, poi 0% [fonte: Accordo 23/12/2020 art. 9]. Il Canton Ticino raccoglie, trasferisce alla Confederazione che bonifica al MEF italiano, il quale ripartisce per 180 Comuni in base al numero di frontalieri residenti. I Comuni usano i ristorni per infrastrutture, trasporti e opere sociali. Per i «nuovi frontalieri» non c'è ristorno: l'Italia tassa direttamente. Elenco dei Comuni beneficiari è l'Allegato 1 del DM 10 ottobre 2023 [fonte: DM 10/10/2023, MEF].",
      en:
        "The 1974 CH-IT Agreement and the 2020 Agreement provide that Switzerland remits to Italian border municipalities (Lombardy, Piemonte) a share of withholding tax on «old» cross-border workers: 38.8% for 2024-2033, then 0% [source: 23/12/2020 Agreement art. 9]. Canton Ticino collects, transfers to the Confederation which remits to the Italian MEF, which distributes across 180 municipalities by number of cross-border residents. Municipalities use rebates for infrastructure, transport and social works. For «new» cross-border workers there is no rebate: Italy taxes directly. The beneficiary list is Annex 1 of Decree 10 October 2023 [source: DM 10/10/2023, Italian MEF].",
      de:
        "Das CH-IT-Abkommen 1974 und jenes von 2020 sehen vor, dass die Schweiz italienischen Grenzgemeinden (Lombardei, Piemont) einen Anteil der Quellensteuer auf «alte» Grenzgänger überweist: 38,8 % für 2024-2033, dann 0 % [Quelle: Abkommen 23.12.2020 Art. 9]. Der Tessin kassiert, überweist an den Bund, der italienische MEF verteilt auf 180 Gemeinden nach Anzahl der Grenzgänger. Die Gemeinden nutzen die Rückzahlungen für Infrastruktur, Verkehr und Soziales. Für «neue» Grenzgänger keine Rückzahlung: Italien besteuert direkt. Anlage 1 des Dekrets 10.10.2023 [Quelle: DM 10/10/2023, MEF].",
      fr:
        "L'Accord CH-IT de 1974 et celui de 2020 prévoient que la Suisse reverse aux communes italiennes frontalières (Lombardie, Piémont) une part de l'impôt à la source sur les « anciens » frontaliers : 38,8 % pour 2024-2033 puis 0 % [source : Accord 23/12/2020 art. 9]. Le canton encaisse, la Confédération rétrocède au MEF italien qui répartit entre 180 communes selon le nombre de frontaliers résidents. Les communes financent infrastructures, transports et social. Pour les « nouveaux » frontaliers pas de ristourne : l'Italie taxe directement. Annexe 1 du décret 10/10/2023 [source : DM 10/10/2023, MEF].",
    },
    sources: [
      'https://www.fedlex.admin.ch/eli/cc/2023/694/it',
      'https://www.mef.gov.it/ministero/comunicati/2023/DM_10_10_2023_frontalieri.html',
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
    answer: {
      it:
        "Gli acquisti volontari nel 2° pilastro svizzero (Einkauf LPP) sono deducibili per il nuovo frontaliere solo limitatamente: l'art. 10 TUIR italiano non riconosce espressamente i contributi LPP eccedenti il minimo obbligatorio come oneri deducibili [fonte: Agenzia Entrate, Interpello 471/2022]. Restano deducibili in Svizzera per il calcolo dell'imposta alla fonte tramite procedura NOV (onere deducibile ex art. 89 LAID). Il nuovo frontaliere può comunque indicare in quadro RP gli oneri previdenziali obbligatori LPP trattenuti in busta paga fino al limite dell'art. 10 TUIR (5.164,57 €/anno). Gli acquisti volontari convengono quindi prevalentemente ai vecchi frontalieri non soggetti a IRPEF italiana.",
      en:
        "Voluntary buy-ins to the Swiss 2nd pillar (LPP Einkauf) are only partially deductible for the new cross-border worker: Italian TUIR art. 10 does not expressly allow LPP contributions exceeding the mandatory minimum as deductible charges [source: Agenzia Entrate, Ruling 471/2022]. They remain deductible in Switzerland via the NOV procedure (deductible charge under LHID art. 89). The new worker may still report mandatory LPP contributions withheld from salary in RP up to TUIR art. 10 limit (€5,164.57/year). Voluntary buy-ins are therefore mostly advantageous to «old» workers not subject to Italian IRPEF.",
      de:
        "Freiwillige Einkäufe in die 2. Säule (BVG-Einkauf) sind für neue Grenzgänger nur beschränkt abziehbar: Der italienische TUIR Art. 10 anerkennt BVG-Beiträge über das Obligatorium hinaus nicht ausdrücklich als abzugsfähig [Quelle: Agenzia Entrate, Anfrage 471/2022]. In der Schweiz bleiben sie via NOV-Verfahren abziehbar (Art. 89 StHG). Pflicht-BVG-Beiträge im Lohnausweis können im Block RP bis zur TUIR-Art.-10-Grenze (5 164,57 €/Jahr) geltend gemacht werden. Freiwillige Einkäufe lohnen sich daher v. a. für alte Grenzgänger ohne IRPEF-Pflicht.",
      fr:
        "Les rachats volontaires au 2e pilier suisse (Einkauf LPP) ne sont que partiellement déductibles pour le nouveau frontalier : l'art. 10 TUIR italien ne reconnaît pas explicitement les cotisations LPP excédant le minimum obligatoire comme charges déductibles [source : Agenzia Entrate, réponse 471/2022]. Ils restent déductibles en Suisse via la procédure TOU (art. 89 LHID). Le nouveau frontalier peut reporter au cadre RP les cotisations LPP obligatoires retenues jusqu'à la limite TUIR art. 10 (5 164,57 €/an). Les rachats volontaires conviennent surtout aux anciens frontaliers non soumis à IRPEF.",
    },
    relatedLinks: [
      {
        href: '/guida-frontaliere/secondo-pilastro-frontalieri/',
        label: {
          it: 'Guida al 2° pilastro',
          en: '2nd pillar guide',
          de: 'Leitfaden 2. Säule',
          fr: 'Guide 2e pilier',
        },
      },
    ],
    sources: [
      'https://www.agenziaentrate.gov.it/portale/web/guest/-/risposta-n-471-del-2022',
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
    answer: {
      it:
        "Sì. Per il nuovo frontaliere la tredicesima è reddito da lavoro dipendente ex art. 51 TUIR e va sommata alla base imponibile IRPEF nel quadro RC [fonte: Istruzioni Redditi PF 2026]. Se è versata con il cedolino di dicembre la ritenuta alla fonte svizzera è calcolata sulla tabella annualizzata; il controvalore in euro va convertito al cambio medio BCE dell'anno di percezione (principio di cassa). Il credito d'imposta copre la ritenuta svizzera. Attenzione a premi una tantum o gratifiche straordinarie: vanno anch'essi dichiarati e non beneficiano di regimi agevolati italiani. Per i vecchi frontalieri la tredicesima resta tassata solo in Svizzera e non entra nella Redditi PF.",
      en:
        "Yes. For the new cross-border worker the 13th-month bonus is employment income under TUIR art. 51 and must be added to the IRPEF tax base in section RC [source: Redditi PF 2026 instructions]. If paid with the December payslip, Swiss withholding uses the annualised table; the EUR equivalent is converted at the yearly ECB average (cash basis). Foreign tax credit covers Swiss withholding. One-off premiums and extraordinary bonuses also go in the return and do not enjoy Italian preferential regimes. For «old» workers, the 13th-month is Swiss-only and does not enter the Italian return.",
      de:
        "Ja. Für den neuen Grenzgänger ist der 13. Monatslohn Arbeitseinkommen gemäss TUIR Art. 51 und wird in Block RC zur IRPEF-Basis gezählt [Quelle: Anleitungen Redditi PF 2026]. Bei Dezemberauszahlung nutzt die Quellensteuer die annualisierte Tabelle; Umrechnung in Euro zum EZB-Jahresmittel (Kassaprinzip). Die Anrechnung deckt die Schweizer Steuer. Einmalprämien sind ebenfalls zu deklarieren, keine italienischen Vergünstigungen. Für alte Grenzgänger bleibt der 13. Monatslohn nur in der Schweiz steuerpflichtig.",
      fr:
        "Oui. Pour le nouveau frontalier le 13e mois est revenu d'emploi art. 51 TUIR et entre dans la base IRPEF au cadre RC [source : instructions Redditi PF 2026]. Payé sur la fiche de décembre, la retenue suisse applique le barème annualisé ; conversion euro au taux moyen BCE de l'année (principe de caisse). Le crédit d'impôt couvre la retenue suisse. Primes one-shot et gratifications sont aussi déclarées sans régime de faveur italien. Pour les anciens frontaliers, le 13e mois reste imposé en Suisse uniquement.",
    },
    sources: [
      'https://www.agenziaentrate.gov.it/portale/web/guest/schede/dichiarazioni/redditi-pf-2026',
    ],
  },
];
