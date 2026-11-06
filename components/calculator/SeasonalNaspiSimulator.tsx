import React, { useMemo, useState } from 'react';
import { AlertTriangle, ArrowRight, Calculator, MapPinned, Scale, Sparkles } from 'lucide-react';
import { useLocale } from '@/services/i18n';
import { buildPath, type AppRoute } from '@/services/router';
import { useExchangeRate } from '@/services/exchangeRateService';
import { calculateSeasonalScenario, PENSION_FUND_DEDUCTION_CAP_EUR, type SeasonalScenarioInput, type SeasonalScenarioResult } from '@/services/calculationService';
import { MUNICIPALITIES } from '@/data/municipalities';
import type { Locale } from '@/services/i18n';

type MaritalStatus = SeasonalScenarioInput['maritalStatus'];

type Copy = {
  badge: string;
  title: string;
  subtitle: string;
  intro: string;
  bullets: string[];
  disclaimerTitle: string;
  disclaimerBody: string;
  formTitle: string;
  labelGrossMonthly: string;
  labelComune: string;
  labelAge: string;
  labelMaritalStatus: string;
  maritalSingle: string;
  maritalMarried: string;
  maritalDivorced: string;
  maritalWidowed: string;
  labelSpouseWorks: string;
  labelChildren: string;
  labelMonthsWorked: string;
  labelContributedMonths: string;
  labelAlreadyIndemnified: string;
  labelPensionContribution: string;
  scenarioTitle1: string;
  scenarioTitle2: string;
  scenarioTitle3: string;
  scenarioTitle4: string;
  scenarioDesc1: string;
  scenarioDesc2: string;
  scenarioDesc3: string;
  scenarioDesc4: string;
  labelNetAnnual: string;
  labelNetMonthly: string;
  labelGrossWorked: string;
  labelSocialCH: string;
  labelSourceTaxCH: string;
  labelNaspiGross: string;
  labelNaspiMonths: string;
  labelItalianTax: string;
  labelPensionDeduction: string;
  labelPensionCashOut: string;
  shortfallWarning: (paid: number, requested: number) => string;
  comparisonTitle: string;
  comparisonBody: string;
  linksTitle: string;
  links: Array<{ label: string; route: AppRoute }>;
  editorialTitle: string;
  editorialParagraphs: string[];
  faqTitle: string;
  faq: Array<{ q: string; a: string }>;
};

const COPY_BY_LOCALE: Record<Locale, Copy> = {
  it: {
    badge: 'Nuovo frontaliere · Accordo 2024',
    title: 'Lavoro stagionale vs annuale con NASpI',
    subtitle: 'Confronta il netto annuo tra 12 mesi di lavoro continuativo e un regime stagionale coperto da NASpI, con o senza versamento a un fondo pensione.',
    intro: 'Questo simulatore è pensato per un nuovo frontaliere che lavora in Canton Ticino e valuta se convenga lavorare tutto l\'anno oppure alternare periodi di lavoro a periodi di disoccupazione coperti da NASpI. Imposta i tuoi dati e confronta 4 scenari calcolati sullo stesso motore fiscale del resto del sito.',
    bullets: [
      'La NASpI copre il 75% della retribuzione media fino a una soglia, il 25% oltre — non l\'intero stipendio.',
      'Se hai già percepito NASpI negli ultimi 4 anni, la nuova spettanza si riduce di conseguenza.',
      'Un versamento a fondo pensione è deducibile fino a un massimale annuo, ma resta un\'uscita di cassa reale.',
    ],
    disclaimerTitle: 'Attenzione: stima informativa, non consulenza fiscale',
    disclaimerBody: 'I risultati sono una simulazione basata su aliquote e soglie 2026 note al momento della pubblicazione (IRPEF, addizionali, NASpI, contributi svizzeri). Non sostituiscono una consulenza personalizzata: verifica sempre con un commercialista o un CAF prima di decidere, soprattutto per la spettanza NASpI residua e la deducibilità del fondo pensione nel tuo caso specifico.',
    formTitle: 'I tuoi dati',
    labelGrossMonthly: 'Stipendio lordo mensile (CHF)',
    labelComune: 'Comune di residenza (Italia)',
    labelAge: 'Età',
    labelMaritalStatus: 'Stato civile',
    maritalSingle: 'Celibe/nubile',
    maritalMarried: 'Coniugato/a',
    maritalDivorced: 'Divorziato/a',
    maritalWidowed: 'Vedovo/a',
    labelSpouseWorks: 'Coniuge lavora',
    labelChildren: 'Figli a carico',
    labelMonthsWorked: 'Mesi lavorati (scenario stagionale)',
    labelContributedMonths: 'Mesi contribuiti in CH negli ultimi 4 anni',
    labelAlreadyIndemnified: 'Mesi di NASpI già percepiti nel quadriennio',
    labelPensionContribution: 'Versamento volontario a fondo pensione (EUR/anno)',
    scenarioTitle1: '12 mesi continuativi',
    scenarioTitle2: 'Stagionale + NASpI',
    scenarioTitle3: 'Stagionale + NASpI + fondo pensione',
    scenarioTitle4: 'Stagionale senza NASpI',
    scenarioDesc1: 'Lavoro tutto l\'anno, nessuna disoccupazione.',
    scenarioDesc2: 'Lavoro per i mesi indicati, NASpI per i restanti.',
    scenarioDesc3: 'Come sopra, più un versamento a fondo pensione deducibile.',
    scenarioDesc4: 'Lavoro per i mesi indicati, nessun reddito sostitutivo nei mesi restanti.',
    labelNetAnnual: 'Netto annuo',
    labelNetMonthly: 'Netto mensile equivalente',
    labelGrossWorked: 'Lordo dei mesi lavorati',
    labelSocialCH: 'Contributi sociali svizzeri',
    labelSourceTaxCH: 'Imposta alla fonte svizzera',
    labelNaspiGross: 'NASpI lorda percepita',
    labelNaspiMonths: 'Mesi di NASpI pagati',
    labelItalianTax: 'Imposta italiana finale (dopo credito)',
    labelPensionDeduction: 'Deduzione fiscale fondo pensione',
    labelPensionCashOut: 'Versato a fondo pensione',
    shortfallWarning: (paid, requested) => `Attenzione: con questo storico contributivo la NASpI residua copre solo ${paid} dei ${requested} mesi richiesti. Verifica la tua spettanza reale con l'INPS.`,
    comparisonTitle: 'Confronto netto annuo',
    comparisonBody: 'Il netto annuo è la somma di stipendio netto e NASpI netta (dove presente), al netto dell\'imposta italiana finale dopo il credito per le imposte già pagate in Svizzera.',
    linksTitle: 'Tool utili per approfondire',
    links: [
      { label: 'Calcola il tuo caso completo', route: { activeTab: 'calculator', calcolatoreSubTab: 'calculator' } },
      { label: 'Calcolatore NASpI dedicato', route: { activeTab: 'guida', guidaSubTab: 'unemployment' } },
      { label: 'Nuovi frontalieri oltre 20 km', route: { activeTab: 'calculator', calcolatoreSubTab: 'calculator', seoLanding: 'new-frontier-over20km' } },
      { label: 'Guida dichiarazione redditi', route: { activeTab: 'fisco', fiscoSubTab: 'tax-return' } },
    ],
    editorialTitle: 'Come funziona il confronto stagionale vs annuale',
    editorialParagraphs: [
      'Per un **nuovo frontaliere** (assunto dal 17 luglio 2023 in poi) che risiede entro 20 km dal confine, lo stipendio svizzero è tassato in via concorrente: la Svizzera trattiene l\'imposta alla fonte sull\'80% del reddito, l\'Italia tassa il reddito complessivo con IRPEF (dopo una franchigia fissa di €10.000) e riconosce un credito d\'imposta proporzionale per quanto già pagato in Svizzera.',
      'La **NASpI** è un reddito assimilato a lavoro dipendente: si somma al reddito da frontaliere nella stessa dichiarazione IRPEF, non beneficia della franchigia di €10.000 (che vale solo per il reddito da lavoro estero) ed è quindi tassata insieme al resto sulla stessa base progressiva.',
      'La **durata della NASpI** dipende dalle settimane contribuite negli ultimi 4 anni, al netto di quelle già "consumate" da una NASpI precedente nello stesso periodo: se hai già percepito mesi di NASpI di recente, la spettanza residua per un nuovo evento di disoccupazione è inferiore — verificalo sempre con l\'INPS prima di pianificare uno scenario stagionale.',
      'Un **versamento volontario a un fondo pensione complementare** riduce l\'imponibile IRPEF fino a un massimale annuo (art. 8 D.Lgs. 252/2005), ma è comunque denaro che esce dalle tue tasche quest\'anno: il risparmio fiscale è sempre inferiore all\'importo versato, la convenienza va vista nel lungo periodo (accumulo previdenziale), non sul netto immediato.',
    ],
    faqTitle: 'FAQ',
    faq: [
      { q: 'Conviene lavorare 12 mesi o passare a un regime stagionale con NASpI?', a: 'Dipende dal netto complessivo annuo: la NASpI copre solo una percentuale della retribuzione, quindi lo scenario stagionale quasi sempre produce un netto annuo inferiore al lavoro continuativo — ma può avere senso per altri motivi (tempo libero, formazione, ricerca di un impiego migliore). Il simulatore ti dà il numero esatto per decidere consapevolmente.' },
      { q: 'Il fondo pensione fa sempre aumentare il netto?', a: 'No: il versamento riduce le tasse ma resta un\'uscita di cassa reale superiore al risparmio fiscale ottenuto. Nello scenario 3 il netto immediato è tipicamente più basso dello scenario 2, a fronte di un accumulo previdenziale futuro.' },
      { q: 'Come faccio a sapere quanti mesi di NASpI mi restano davvero?', a: 'Il simulatore stima la spettanza residua dalle settimane contribuite nel quadriennio meno quelle già indennizzate, ma il calcolo ufficiale spetta all\'INPS: richiedi sempre una verifica puntuale prima di pianificare uno scenario di disoccupazione.' },
      { q: 'Questa simulazione basta per decidere?', a: 'No: è uno strumento di orientamento. Per una decisione definitiva, soprattutto con NASpI e fondo pensione coinvolti, verifica con un commercialista o un CAF.' },
    ],
  },
  en: {
    badge: 'New cross-border worker · 2024 Agreement',
    title: 'Seasonal vs annual work with NASpI',
    subtitle: 'Compare the annual net between 12 months of continuous work and a seasonal regime covered by NASpI unemployment benefit, with or without a pension fund contribution.',
    intro: 'This simulator is for a new cross-border worker in Ticino weighing whether to work all year or alternate work periods with NASpI-covered unemployment periods. Enter your data and compare 4 scenarios computed on the same tax engine used across this site.',
    bullets: [
      'NASpI covers 75% of average pay up to a threshold, 25% above it — not the full salary.',
      'If you already received NASpI in the last 4 years, your new entitlement is reduced accordingly.',
      'A pension fund contribution is deductible up to an annual cap, but it is still a real cash outflow.',
    ],
    disclaimerTitle: 'Warning: informational estimate, not tax advice',
    disclaimerBody: 'Results are a simulation based on 2026 rates and thresholds known at publication time (IRPEF, surtaxes, NASpI, Swiss contributions). They do not replace personalized advice: always check with a tax professional before deciding, especially for residual NASpI entitlement and pension-fund deductibility in your specific case.',
    formTitle: 'Your data',
    labelGrossMonthly: 'Gross monthly salary (CHF)',
    labelComune: 'Municipality of residence (Italy)',
    labelAge: 'Age',
    labelMaritalStatus: 'Marital status',
    maritalSingle: 'Single',
    maritalMarried: 'Married',
    maritalDivorced: 'Divorced',
    maritalWidowed: 'Widowed',
    labelSpouseWorks: 'Spouse works',
    labelChildren: 'Dependent children',
    labelMonthsWorked: 'Months worked (seasonal scenario)',
    labelContributedMonths: 'Months contributed in CH in the last 4 years',
    labelAlreadyIndemnified: 'NASpI months already received in the reference period',
    labelPensionContribution: 'Voluntary pension fund contribution (EUR/year)',
    scenarioTitle1: '12 continuous months',
    scenarioTitle2: 'Seasonal + NASpI',
    scenarioTitle3: 'Seasonal + NASpI + pension fund',
    scenarioTitle4: 'Seasonal without NASpI',
    scenarioDesc1: 'Work all year, no unemployment.',
    scenarioDesc2: 'Work the given months, NASpI for the rest.',
    scenarioDesc3: 'As above, plus a deductible pension fund contribution.',
    scenarioDesc4: 'Work the given months, no replacement income for the rest.',
    labelNetAnnual: 'Annual net',
    labelNetMonthly: 'Equivalent monthly net',
    labelGrossWorked: 'Gross of months worked',
    labelSocialCH: 'Swiss social contributions',
    labelSourceTaxCH: 'Swiss source tax',
    labelNaspiGross: 'Gross NASpI received',
    labelNaspiMonths: 'NASpI months paid',
    labelItalianTax: 'Final Italian tax (after credit)',
    labelPensionDeduction: 'Pension fund tax deduction',
    labelPensionCashOut: 'Paid into pension fund',
    shortfallWarning: (paid, requested) => `Warning: with this contribution history, residual NASpI only covers ${paid} of the ${requested} requested months. Verify your actual entitlement with INPS.`,
    comparisonTitle: 'Annual net comparison',
    comparisonBody: 'Annual net is net salary plus net NASpI (where applicable), after the final Italian tax net of the credit for tax already paid in Switzerland.',
    linksTitle: 'Useful tools',
    links: [
      { label: 'Calculate your full case', route: { activeTab: 'calculator', calcolatoreSubTab: 'calculator' } },
      { label: 'Dedicated NASpI calculator', route: { activeTab: 'guida', guidaSubTab: 'unemployment' } },
      { label: 'New cross-border workers over 20 km', route: { activeTab: 'calculator', calcolatoreSubTab: 'calculator', seoLanding: 'new-frontier-over20km' } },
      { label: 'Tax return guide', route: { activeTab: 'fisco', fiscoSubTab: 'tax-return' } },
    ],
    editorialTitle: 'How the seasonal vs annual comparison works',
    editorialParagraphs: [
      'For a **new cross-border worker** (hired from 17 July 2023 onward) residing within 20 km of the border, the Swiss salary is taxed concurrently: Switzerland withholds source tax on 80% of income, Italy taxes total income via IRPEF (after a flat €10,000 exemption) and grants a proportional tax credit for what was already paid in Switzerland.',
      '**NASpI** is income assimilated to employment income: it is added to the frontaliere income in the same IRPEF return, does not benefit from the €10,000 exemption (which applies only to foreign employment income), and is therefore taxed together with the rest on the same progressive base.',
      '**NASpI duration** depends on weeks contributed in the last 4 years, net of weeks already "used" by a prior NASpI in the same period: if you already received NASpI months recently, your residual entitlement for a new unemployment event is lower — always verify with INPS before planning a seasonal scenario.',
      'A **voluntary contribution to a supplementary pension fund** reduces the IRPEF taxable base up to an annual cap (Art. 8 Legislative Decree 252/2005), but it is still money leaving your pocket this year: the tax saving is always lower than the amount contributed, and the benefit should be judged over the long term (retirement savings), not on the immediate net.',
    ],
    faqTitle: 'FAQ',
    faq: [
      { q: 'Is it better to work 12 months or switch to a seasonal regime with NASpI?', a: 'It depends on the total annual net: NASpI only covers a percentage of pay, so the seasonal scenario almost always produces a lower annual net than continuous work — but it can make sense for other reasons (free time, training, looking for a better job). The simulator gives you the exact number to decide consciously.' },
      { q: 'Does a pension fund always increase your net?', a: 'No: the contribution reduces taxes but remains a real cash outflow larger than the tax saving obtained. In scenario 3 the immediate net is typically lower than scenario 2, in exchange for future retirement savings.' },
      { q: 'How do I know how many NASpI months I actually have left?', a: 'The simulator estimates residual entitlement from weeks contributed in the reference period minus those already indemnified, but the official calculation belongs to INPS: always request a specific verification before planning an unemployment scenario.' },
      { q: 'Is this simulation enough to decide?', a: 'No: it is an orientation tool. For a final decision, especially involving NASpI and a pension fund, check with a tax professional or CAF.' },
    ],
  },
  de: {
    badge: 'Neuer Grenzgaenger · Abkommen 2024',
    title: 'Saisonarbeit vs Ganzjahresarbeit mit NASpI',
    subtitle: 'Vergleiche das Jahresnetto zwischen 12 Monaten durchgehender Arbeit und einem Saisonmodell mit NASpI-Arbeitslosengeld, mit oder ohne Einzahlung in eine Pensionskasse.',
    intro: 'Dieser Rechner richtet sich an neue Grenzgaenger im Tessin, die abwaegen, ob sich Ganzjahresarbeit oder ein Wechsel zwischen Arbeit und NASpI-gedeckter Arbeitslosigkeit mehr lohnt. Gib deine Daten ein und vergleiche 4 Szenarien mit derselben Steuerlogik wie der Rest der Seite.',
    bullets: [
      'NASpI deckt 75% des Durchschnittslohns bis zu einer Schwelle, darueber 25% — nicht das volle Gehalt.',
      'Wurde in den letzten 4 Jahren bereits NASpI bezogen, verringert sich der neue Anspruch entsprechend.',
      'Eine Einzahlung in eine Pensionskasse ist bis zu einem Jahreshoechstbetrag abzugsfaehig, bleibt aber ein realer Geldabfluss.',
    ],
    disclaimerTitle: 'Achtung: informative Schaetzung, keine Steuerberatung',
    disclaimerBody: 'Die Ergebnisse sind eine Simulation auf Basis der zum Zeitpunkt der Veroeffentlichung bekannten Saetze und Schwellen 2026 (IRPEF, Zuschlaege, NASpI, Schweizer Abgaben). Sie ersetzen keine individuelle Beratung: pruefe vor einer Entscheidung immer mit einem Steuerberater, insbesondere fuer den verbleibenden NASpI-Anspruch und die Abzugsfaehigkeit der Pensionskasse in deinem konkreten Fall.',
    formTitle: 'Deine Daten',
    labelGrossMonthly: 'Bruttomonatslohn (CHF)',
    labelComune: 'Wohngemeinde (Italien)',
    labelAge: 'Alter',
    labelMaritalStatus: 'Zivilstand',
    maritalSingle: 'Ledig',
    maritalMarried: 'Verheiratet',
    maritalDivorced: 'Geschieden',
    maritalWidowed: 'Verwitwet',
    labelSpouseWorks: 'Ehepartner arbeitet',
    labelChildren: 'Unterhaltsberechtigte Kinder',
    labelMonthsWorked: 'Gearbeitete Monate (Saisonszenario)',
    labelContributedMonths: 'In der Schweiz beitragspflichtige Monate der letzten 4 Jahre',
    labelAlreadyIndemnified: 'Bereits bezogene NASpI-Monate im Referenzzeitraum',
    labelPensionContribution: 'Freiwillige Einzahlung in Pensionskasse (EUR/Jahr)',
    scenarioTitle1: '12 durchgehende Monate',
    scenarioTitle2: 'Saisonal + NASpI',
    scenarioTitle3: 'Saisonal + NASpI + Pensionskasse',
    scenarioTitle4: 'Saisonal ohne NASpI',
    scenarioDesc1: 'Ganzjahresarbeit, keine Arbeitslosigkeit.',
    scenarioDesc2: 'Arbeit fuer die angegebenen Monate, NASpI fuer den Rest.',
    scenarioDesc3: 'Wie oben, plus eine abzugsfaehige Pensionskasseneinzahlung.',
    scenarioDesc4: 'Arbeit fuer die angegebenen Monate, kein Ersatzeinkommen fuer den Rest.',
    labelNetAnnual: 'Jahresnetto',
    labelNetMonthly: 'Aequivalentes Monatsnetto',
    labelGrossWorked: 'Brutto der gearbeiteten Monate',
    labelSocialCH: 'Schweizer Sozialabgaben',
    labelSourceTaxCH: 'Schweizer Quellensteuer',
    labelNaspiGross: 'Bezogene Brutto-NASpI',
    labelNaspiMonths: 'Bezahlte NASpI-Monate',
    labelItalianTax: 'Endgueltige italienische Steuer (nach Anrechnung)',
    labelPensionDeduction: 'Steuerabzug Pensionskasse',
    labelPensionCashOut: 'Eingezahlt in Pensionskasse',
    shortfallWarning: (paid, requested) => `Achtung: bei dieser Beitragshistorie deckt die verbleibende NASpI nur ${paid} der ${requested} gewuenschten Monate. Pruefe deinen tatsaechlichen Anspruch bei der INPS.`,
    comparisonTitle: 'Vergleich Jahresnetto',
    comparisonBody: 'Das Jahresnetto ist die Summe aus Nettolohn und Netto-NASpI (falls vorhanden), nach der endgueltigen italienischen Steuer abzueglich der Anrechnung fuer bereits in der Schweiz bezahlte Steuern.',
    linksTitle: 'Nuetzliche Tools',
    links: [
      { label: 'Eigenen Fall vollstaendig berechnen', route: { activeTab: 'calculator', calcolatoreSubTab: 'calculator' } },
      { label: 'Eigener NASpI-Rechner', route: { activeTab: 'guida', guidaSubTab: 'unemployment' } },
      { label: 'Neue Grenzgaenger ueber 20 km', route: { activeTab: 'calculator', calcolatoreSubTab: 'calculator', seoLanding: 'new-frontier-over20km' } },
      { label: 'Steuererklaerung Leitfaden', route: { activeTab: 'fisco', fiscoSubTab: 'tax-return' } },
    ],
    editorialTitle: 'So funktioniert der Vergleich Saison vs Ganzjahr',
    editorialParagraphs: [
      'Fuer einen **neuen Grenzgaenger** (angestellt ab dem 17. Juli 2023) mit Wohnsitz innerhalb von 20 km von der Grenze wird der Schweizer Lohn konkurrierend besteuert: die Schweiz behaelt die Quellensteuer auf 80% des Einkommens ein, Italien besteuert das Gesamteinkommen mittels IRPEF (nach einem festen Freibetrag von 10.000 Euro) und gewaehrt eine proportionale Anrechnung fuer bereits in der Schweiz bezahlte Steuern.',
      'Die **NASpI** ist ein dem Arbeitseinkommen gleichgestelltes Einkommen: sie wird in derselben IRPEF-Erklaerung zum Grenzgaengereinkommen addiert, profitiert nicht vom Freibetrag von 10.000 Euro (der nur fuer auslaendisches Arbeitseinkommen gilt) und wird daher zusammen mit dem Rest auf derselben progressiven Basis besteuert.',
      'Die **Dauer der NASpI** haengt von den in den letzten 4 Jahren beitragspflichtigen Wochen ab, abzueglich jener, die bereits durch eine vorherige NASpI im selben Zeitraum "verbraucht" wurden: wurde kuerzlich bereits NASpI bezogen, ist der verbleibende Anspruch fuer ein neues Arbeitslosigkeitsereignis geringer — pruefe dies immer bei der INPS, bevor du ein Saisonszenario planst.',
      'Eine **freiwillige Einzahlung in eine ergaenzende Pensionskasse** reduziert die IRPEF-Bemessungsgrundlage bis zu einem Jahreshoechstbetrag (Art. 8 Gesetzesdekret 252/2005), bleibt aber Geld, das dieses Jahr aus deiner Tasche fliesst: die Steuerersparnis ist immer geringer als der eingezahlte Betrag, der Nutzen zeigt sich langfristig (Altersvorsorge), nicht im unmittelbaren Netto.',
    ],
    faqTitle: 'FAQ',
    faq: [
      { q: 'Lohnt es sich, 12 Monate zu arbeiten oder zu einem Saisonmodell mit NASpI zu wechseln?', a: 'Das haengt vom gesamten Jahresnetto ab: NASpI deckt nur einen Prozentsatz des Lohns, daher ergibt das Saisonszenario fast immer ein niedrigeres Jahresnetto als durchgehende Arbeit — kann aber aus anderen Gruenden sinnvoll sein (Freizeit, Weiterbildung, Suche nach einer besseren Stelle). Der Rechner liefert die genaue Zahl fuer eine bewusste Entscheidung.' },
      { q: 'Erhoeht eine Pensionskasse immer das Netto?', a: 'Nein: die Einzahlung senkt die Steuern, bleibt aber ein realer Geldabfluss, der groesser ist als die erzielte Steuerersparnis. In Szenario 3 ist das unmittelbare Netto typischerweise niedriger als in Szenario 2, dafuer profitierst du von zukuenftiger Altersvorsorge.' },
      { q: 'Wie erfahre ich, wie viele NASpI-Monate mir tatsaechlich bleiben?', a: 'Der Rechner schaetzt den verbleibenden Anspruch aus den beitragspflichtigen Wochen im Referenzzeitraum abzueglich der bereits entschaedigten, aber die offizielle Berechnung obliegt der INPS: fordere immer eine konkrete Pruefung an, bevor du ein Arbeitslosigkeitsszenario planst.' },
      { q: 'Reicht diese Simulation fuer eine Entscheidung?', a: 'Nein: sie ist ein Orientierungswerkzeug. Fuer eine endgueltige Entscheidung, besonders mit NASpI und Pensionskasse, pruefe mit einem Steuerberater oder CAF.' },
    ],
  },
  fr: {
    badge: 'Nouveau frontalier · Accord 2024',
    title: 'Travail saisonnier vs annuel avec NASpI',
    subtitle: 'Comparez le net annuel entre 12 mois de travail continu et un regime saisonnier couvert par le NASpI, avec ou sans versement a un fonds de pension.',
    intro: 'Ce simulateur s\'adresse a un nouveau frontalier travaillant au Tessin qui evalue s\'il vaut mieux travailler toute l\'annee ou alterner des periodes de travail et de chomage couvertes par le NASpI. Entrez vos donnees et comparez 4 scenarios calcules avec le meme moteur fiscal que le reste du site.',
    bullets: [
      'Le NASpI couvre 75% de la remuneration moyenne jusqu\'a un seuil, 25% au-dela — pas le salaire entier.',
      'Si vous avez deja percu le NASpI ces 4 dernieres annees, le nouveau droit est reduit en consequence.',
      'Un versement a un fonds de pension est deductible jusqu\'a un plafond annuel, mais reste une sortie de tresorerie reelle.',
    ],
    disclaimerTitle: 'Attention : estimation informative, pas un conseil fiscal',
    disclaimerBody: 'Les resultats sont une simulation basee sur les taux et seuils 2026 connus au moment de la publication (IRPEF, additionnels, NASpI, cotisations suisses). Ils ne remplacent pas un conseil personnalise : verifiez toujours aupres d\'un expert-comptable avant de decider, surtout pour le droit residuel au NASpI et la deductibilite du fonds de pension dans votre cas.',
    formTitle: 'Vos donnees',
    labelGrossMonthly: 'Salaire brut mensuel (CHF)',
    labelComune: 'Commune de residence (Italie)',
    labelAge: 'Age',
    labelMaritalStatus: 'Etat civil',
    maritalSingle: 'Celibataire',
    maritalMarried: 'Marie(e)',
    maritalDivorced: 'Divorce(e)',
    maritalWidowed: 'Veuf/veuve',
    labelSpouseWorks: 'Le conjoint travaille',
    labelChildren: 'Enfants a charge',
    labelMonthsWorked: 'Mois travailles (scenario saisonnier)',
    labelContributedMonths: 'Mois cotises en Suisse ces 4 dernieres annees',
    labelAlreadyIndemnified: 'Mois de NASpI deja percus dans la periode de reference',
    labelPensionContribution: 'Versement volontaire a un fonds de pension (EUR/an)',
    scenarioTitle1: '12 mois continus',
    scenarioTitle2: 'Saisonnier + NASpI',
    scenarioTitle3: 'Saisonnier + NASpI + fonds de pension',
    scenarioTitle4: 'Saisonnier sans NASpI',
    scenarioDesc1: 'Travail toute l\'annee, pas de chomage.',
    scenarioDesc2: 'Travail pour les mois indiques, NASpI pour le reste.',
    scenarioDesc3: 'Comme ci-dessus, plus un versement deductible a un fonds de pension.',
    scenarioDesc4: 'Travail pour les mois indiques, aucun revenu de remplacement pour le reste.',
    labelNetAnnual: 'Net annuel',
    labelNetMonthly: 'Net mensuel equivalent',
    labelGrossWorked: 'Brut des mois travailles',
    labelSocialCH: 'Cotisations sociales suisses',
    labelSourceTaxCH: 'Impot a la source suisse',
    labelNaspiGross: 'NASpI brut percu',
    labelNaspiMonths: 'Mois de NASpI payes',
    labelItalianTax: 'Impot italien final (apres credit)',
    labelPensionDeduction: 'Deduction fiscale fonds de pension',
    labelPensionCashOut: 'Verse au fonds de pension',
    shortfallWarning: (paid, requested) => `Attention : avec cet historique de cotisation, le NASpI residuel ne couvre que ${paid} des ${requested} mois demandes. Verifiez votre droit reel aupres de l'INPS.`,
    comparisonTitle: 'Comparaison du net annuel',
    comparisonBody: 'Le net annuel est la somme du salaire net et du NASpI net (le cas echeant), apres l\'impot italien final net du credit pour l\'impot deja paye en Suisse.',
    linksTitle: 'Outils utiles',
    links: [
      { label: 'Calculer votre cas complet', route: { activeTab: 'calculator', calcolatoreSubTab: 'calculator' } },
      { label: 'Calculateur NASpI dedie', route: { activeTab: 'guida', guidaSubTab: 'unemployment' } },
      { label: 'Nouveaux frontaliers plus de 20 km', route: { activeTab: 'calculator', calcolatoreSubTab: 'calculator', seoLanding: 'new-frontier-over20km' } },
      { label: 'Guide declaration fiscale', route: { activeTab: 'fisco', fiscoSubTab: 'tax-return' } },
    ],
    editorialTitle: 'Comment fonctionne la comparaison saisonnier vs annuel',
    editorialParagraphs: [
      'Pour un **nouveau frontalier** (embauche a partir du 17 juillet 2023) residant a moins de 20 km de la frontiere, le salaire suisse est impose de maniere concurrente : la Suisse retient l\'impot a la source sur 80% du revenu, l\'Italie impose le revenu total via l\'IRPEF (apres un abattement fixe de 10 000 euros) et accorde un credit d\'impot proportionnel pour ce qui a deja ete paye en Suisse.',
      'Le **NASpI** est un revenu assimile au revenu d\'activite salariee : il s\'ajoute au revenu de frontalier dans la meme declaration IRPEF, ne beneficie pas de l\'abattement de 10 000 euros (qui ne s\'applique qu\'au revenu de travail etranger) et est donc impose avec le reste sur la meme base progressive.',
      'La **duree du NASpI** depend des semaines cotisees ces 4 dernieres annees, deduction faite de celles deja "consommees" par un NASpI precedent dans la meme periode : si vous avez deja percu des mois de NASpI recemment, votre droit residuel pour un nouvel evenement de chomage est plus faible — verifiez-le toujours aupres de l\'INPS avant de planifier un scenario saisonnier.',
      'Un **versement volontaire a un fonds de pension complementaire** reduit la base imposable IRPEF jusqu\'a un plafond annuel (art. 8 Decret legislatif 252/2005), mais reste de l\'argent qui sort de votre poche cette annee : l\'economie fiscale est toujours inferieure au montant verse, l\'interet se juge sur le long terme (epargne retraite), pas sur le net immediat.',
    ],
    faqTitle: 'FAQ',
    faq: [
      { q: 'Vaut-il mieux travailler 12 mois ou passer a un regime saisonnier avec NASpI?', a: 'Cela depend du net annuel total : le NASpI ne couvre qu\'un pourcentage du salaire, donc le scenario saisonnier produit presque toujours un net annuel inferieur au travail continu — mais cela peut avoir du sens pour d\'autres raisons (temps libre, formation, recherche d\'un meilleur emploi). Le simulateur vous donne le chiffre exact pour decider en connaissance de cause.' },
      { q: 'Un fonds de pension augmente-t-il toujours le net?', a: 'Non : le versement reduit les impots mais reste une sortie de tresorerie reelle superieure a l\'economie fiscale obtenue. Dans le scenario 3, le net immediat est generalement inferieur au scenario 2, en echange d\'une epargne retraite future.' },
      { q: 'Comment savoir combien de mois de NASpI il me reste reellement?', a: 'Le simulateur estime le droit residuel a partir des semaines cotisees dans la periode de reference moins celles deja indemnisees, mais le calcul officiel appartient a l\'INPS : demandez toujours une verification precise avant de planifier un scenario de chomage.' },
      { q: 'Cette simulation suffit-elle pour decider?', a: 'Non : c\'est un outil d\'orientation. Pour une decision definitive, surtout avec NASpI et fonds de pension, verifiez aupres d\'un expert-comptable.' },
    ],
  },
};

const money = (value: number, locale: Locale, currency: 'CHF' | 'EUR') =>
  new Intl.NumberFormat(locale === 'de' ? 'de-CH' : locale === 'fr' ? 'fr-CH' : locale === 'en' ? 'en-CH' : 'it-CH', {
    style: 'currency',
    currency,
    maximumFractionDigits: 0,
  }).format(value);

const SORTED_MUNICIPALITIES = [...MUNICIPALITIES].sort((a, b) => a.name.localeCompare(b.name));
const DEFAULT_MUNICIPALITY = SORTED_MUNICIPALITIES.find((m) => m.name === 'Sumirago') ?? SORTED_MUNICIPALITIES[0];

const SeasonalNaspiSimulator: React.FC = () => {
  const [locale] = useLocale();
  const copy = COPY_BY_LOCALE[locale];
  const { rate: exchangeRate } = useExchangeRate();

  const [grossMonthlyCHF, setGrossMonthlyCHF] = useState(4300);
  const [comuneName, setComuneName] = useState(DEFAULT_MUNICIPALITY.name);
  const [age, setAge] = useState(25);
  const [maritalStatus, setMaritalStatus] = useState<MaritalStatus>('SINGLE');
  const [spouseWorks, setSpouseWorks] = useState(false);
  const [children, setChildren] = useState(0);
  const [monthsWorked, setMonthsWorked] = useState(8);
  const [contributedMonthsLast4Years, setContributedMonthsLast4Years] = useState(48);
  const [monthsAlreadyIndemnifiedInQuadriennio, setMonthsAlreadyIndemnifiedInQuadriennio] = useState(0);
  const [pensionContributionEUR, setPensionContributionEUR] = useState(5000);

  const comune = useMemo(
    () => SORTED_MUNICIPALITIES.find((m) => m.name === comuneName) ?? DEFAULT_MUNICIPALITY,
    [comuneName],
  );
  const distanceZone: SeasonalScenarioInput['distanceZone'] = (comune.fascia === '1' || comune.fascia === '1A') ? 'WITHIN_20KM' : 'OVER_20KM';

  const baseInput = useMemo((): Omit<SeasonalScenarioInput, 'monthsWorked' | 'monthsOnNaspi' | 'pensionContributionEUR'> => ({
    grossMonthlyCHF,
    contributedMonthsLast4Years,
    monthsAlreadyIndemnifiedInQuadriennio,
    age,
    maritalStatus,
    spouseWorks,
    children,
    distanceZone,
    addizionaleComunalePercent: comune.irpefAddizionale,
    exchangeRate,
  }), [grossMonthlyCHF, contributedMonthsLast4Years, monthsAlreadyIndemnifiedInQuadriennio, age, maritalStatus, spouseWorks, children, distanceZone, comune.irpefAddizionale, exchangeRate]);

  const monthsOnNaspi = 12 - monthsWorked;

  const scenarios = useMemo((): Array<{ title: string; desc: string; result: SeasonalScenarioResult }> => [
    { title: copy.scenarioTitle1, desc: copy.scenarioDesc1, result: calculateSeasonalScenario({ ...baseInput, monthsWorked: 12, monthsOnNaspi: 0 }) },
    { title: copy.scenarioTitle2, desc: copy.scenarioDesc2, result: calculateSeasonalScenario({ ...baseInput, monthsWorked, monthsOnNaspi }) },
    { title: copy.scenarioTitle3, desc: copy.scenarioDesc3, result: calculateSeasonalScenario({ ...baseInput, monthsWorked, monthsOnNaspi, pensionContributionEUR }) },
    { title: copy.scenarioTitle4, desc: copy.scenarioDesc4, result: calculateSeasonalScenario({ ...baseInput, monthsWorked, monthsOnNaspi: 0 }) },
  ], [baseInput, monthsWorked, monthsOnNaspi, pensionContributionEUR, copy]);

  const shortfallScenario = scenarios.find((s) => s.result.naspiShortfallMonths > 0);

  return (
    <section className="mb-6 rounded-[28px] border border-edge bg-surface shadow-sm overflow-hidden">
      <div className="px-5 py-6 sm:px-7 sm:py-8 bg-hero-info">
        <div className="inline-flex items-center gap-2 rounded-full border border-info-border bg-info-subtle px-3 py-1 text-xs font-semibold text-info">
          <Sparkles className="w-3.5 h-3.5" />
          {copy.badge}
        </div>
        <h2 className="mt-3 text-2xl sm:text-3xl font-bold font-display tracking-tight text-heading">
          {copy.title}
        </h2>
        <p className="mt-3 max-w-3xl text-sm sm:text-base leading-7 text-subtle">
          {copy.subtitle}
        </p>
        <p className="mt-3 max-w-4xl text-sm leading-7 text-subtle">
          {copy.intro}
        </p>
        <div className="mt-5 grid grid-cols-1 md:grid-cols-3 gap-3">
          {copy.bullets.map((bullet) => (
            <div key={bullet} className="rounded-2xl border border-edge bg-surface/90 p-4 text-sm leading-6 text-body">
              {bullet}
            </div>
          ))}
        </div>
      </div>

      <div className="px-5 py-4 sm:px-7 bg-warning-subtle border-y border-warning-border">
        <div className="flex items-start gap-2">
          <AlertTriangle className="w-4 h-4 text-warning flex-shrink-0 mt-0.5" />
          <div>
            <div className="text-sm font-bold text-heading">{copy.disclaimerTitle}</div>
            <p className="mt-1 text-sm leading-6 text-subtle">{copy.disclaimerBody}</p>
          </div>
        </div>
      </div>

      <div className="px-5 py-6 sm:px-7 sm:py-8 space-y-8">
        <div>
          <div className="flex items-center gap-2 text-sm font-bold text-heading">
            <Calculator className="w-4 h-4 text-info" />
            {copy.formTitle}
          </div>
          <div className="mt-4 grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
            <label className="space-y-1.5">
              <span className="text-xs font-semibold text-muted">{copy.labelGrossMonthly}</span>
              <input
                type="number"
                min={0}
                step={50}
                value={grossMonthlyCHF}
                onChange={(e) => setGrossMonthlyCHF(Math.max(0, Number(e.target.value)))}
                className="w-full rounded-xl border border-edge bg-surface px-3 py-2 text-sm text-body"
              />
            </label>
            <label className="space-y-1.5">
              <span className="text-xs font-semibold text-muted">{copy.labelComune}</span>
              <select
                value={comuneName}
                onChange={(e) => setComuneName(e.target.value)}
                className="w-full rounded-xl border border-edge bg-surface px-3 py-2 text-sm text-body"
              >
                {SORTED_MUNICIPALITIES.map((m) => (
                  <option key={`${m.name}-${m.province}`} value={m.name}>{m.name} ({m.province})</option>
                ))}
              </select>
            </label>
            <label className="space-y-1.5">
              <span className="text-xs font-semibold text-muted">{copy.labelAge}</span>
              <input
                type="number"
                min={16}
                max={99}
                value={age}
                onChange={(e) => setAge(Math.max(16, Math.min(99, Number(e.target.value))))}
                className="w-full rounded-xl border border-edge bg-surface px-3 py-2 text-sm text-body"
              />
            </label>
            <label className="space-y-1.5">
              <span className="text-xs font-semibold text-muted">{copy.labelMaritalStatus}</span>
              <select
                value={maritalStatus}
                onChange={(e) => setMaritalStatus(e.target.value as MaritalStatus)}
                className="w-full rounded-xl border border-edge bg-surface px-3 py-2 text-sm text-body"
              >
                <option value="SINGLE">{copy.maritalSingle}</option>
                <option value="MARRIED">{copy.maritalMarried}</option>
                <option value="DIVORCED">{copy.maritalDivorced}</option>
                <option value="WIDOWED">{copy.maritalWidowed}</option>
              </select>
            </label>
            {maritalStatus === 'MARRIED' && (
              <label className="flex items-center gap-2 pt-5">
                <input type="checkbox" checked={spouseWorks} onChange={(e) => setSpouseWorks(e.target.checked)} className="w-4 h-4" />
                <span className="text-xs font-semibold text-muted">{copy.labelSpouseWorks}</span>
              </label>
            )}
            <label className="space-y-1.5">
              <span className="text-xs font-semibold text-muted">{copy.labelChildren}</span>
              <input
                type="number"
                min={0}
                max={10}
                value={children}
                onChange={(e) => setChildren(Math.max(0, Math.min(10, Number(e.target.value))))}
                className="w-full rounded-xl border border-edge bg-surface px-3 py-2 text-sm text-body"
              />
            </label>
            <label className="space-y-1.5">
              <span className="text-xs font-semibold text-muted">{copy.labelMonthsWorked}: {monthsWorked}</span>
              <input
                type="range"
                min={1}
                max={11}
                step={1}
                value={monthsWorked}
                onChange={(e) => setMonthsWorked(Number(e.target.value))}
                aria-label={copy.labelMonthsWorked}
                className="w-full h-2 bg-surface-raised rounded-full appearance-none cursor-pointer accent-info"
              />
            </label>
            <label className="space-y-1.5">
              <span className="text-xs font-semibold text-muted">{copy.labelContributedMonths}</span>
              <input
                type="number"
                min={0}
                max={48}
                value={contributedMonthsLast4Years}
                onChange={(e) => setContributedMonthsLast4Years(Math.max(0, Math.min(48, Number(e.target.value))))}
                className="w-full rounded-xl border border-edge bg-surface px-3 py-2 text-sm text-body"
              />
            </label>
            <label className="space-y-1.5">
              <span className="text-xs font-semibold text-muted">{copy.labelAlreadyIndemnified}</span>
              <input
                type="number"
                min={0}
                max={24}
                value={monthsAlreadyIndemnifiedInQuadriennio}
                onChange={(e) => setMonthsAlreadyIndemnifiedInQuadriennio(Math.max(0, Math.min(24, Number(e.target.value))))}
                className="w-full rounded-xl border border-edge bg-surface px-3 py-2 text-sm text-body"
              />
            </label>
            <label className="space-y-1.5">
              <span className="text-xs font-semibold text-muted">{copy.labelPensionContribution}</span>
              <input
                type="number"
                min={0}
                step={100}
                value={pensionContributionEUR}
                onChange={(e) => setPensionContributionEUR(Math.max(0, Number(e.target.value)))}
                className="w-full rounded-xl border border-edge bg-surface px-3 py-2 text-sm text-body"
              />
            </label>
          </div>
        </div>

        {shortfallScenario && (
          <div className="rounded-2xl border border-danger-border bg-danger-subtle p-4 flex items-start gap-2">
            <AlertTriangle className="w-4 h-4 text-danger flex-shrink-0 mt-0.5" />
            <p className="text-sm leading-6 text-body">
              {copy.shortfallWarning(shortfallScenario.result.naspiMonthsPaid, monthsOnNaspi)}
            </p>
          </div>
        )}

        <div>
          <div className="flex items-center gap-2 text-sm font-bold text-heading">
            <Scale className="w-4 h-4 text-neutral" />
            {copy.comparisonTitle}
          </div>
          <p className="mt-2 text-sm leading-7 text-subtle">{copy.comparisonBody}</p>
          <div className="mt-4 grid grid-cols-1 lg:grid-cols-4 gap-4">
            {scenarios.map(({ title, desc, result }) => (
              <article key={title} className="rounded-2xl border border-neutral-border bg-neutral-subtle p-4">
                <h3 className="text-sm font-bold font-display text-heading">{title}</h3>
                <p className="mt-1 text-xs leading-5 text-muted">{desc}</p>
                <div className="mt-4 space-y-2 text-sm">
                  <div className="pt-2 flex items-center justify-between gap-3">
                    <span className="text-subtle">{copy.labelNetAnnual}</span>
                    <span className="font-bold text-heading">{money(result.netAnnualEUR, locale, 'EUR')}</span>
                  </div>
                  <div className="flex items-center justify-between gap-3">
                    <span className="text-subtle">{copy.labelNetMonthly}</span>
                    <span className="font-bold text-info">{money(result.netMonthlyEquivalentEUR, locale, 'EUR')}</span>
                  </div>
                  <div className="mt-2 pt-2 border-t border-edge flex items-center justify-between gap-3">
                    <span className="text-subtle">{copy.labelGrossWorked}</span>
                    <span className="text-heading">{money(result.grossWorkedCHF, locale, 'CHF')}</span>
                  </div>
                  <div className="flex items-center justify-between gap-3">
                    <span className="text-subtle">{copy.labelSocialCH}</span>
                    <span className="text-heading">{money(result.swissSocialContributionsCHF, locale, 'CHF')}</span>
                  </div>
                  <div className="flex items-center justify-between gap-3">
                    <span className="text-subtle">{copy.labelSourceTaxCH}</span>
                    <span className="text-heading">{money(result.swissSourceTaxCHF, locale, 'CHF')}</span>
                  </div>
                  {result.naspiMonthsPaid > 0 && (
                    <>
                      <div className="flex items-center justify-between gap-3">
                        <span className="text-subtle">{copy.labelNaspiGross}</span>
                        <span className="text-heading">{money(result.naspiTotalGrossEUR, locale, 'EUR')}</span>
                      </div>
                      <div className="flex items-center justify-between gap-3">
                        <span className="text-subtle">{copy.labelNaspiMonths}</span>
                        <span className="text-heading">{result.naspiMonthsPaid}</span>
                      </div>
                    </>
                  )}
                  <div className="flex items-center justify-between gap-3">
                    <span className="text-subtle">{copy.labelItalianTax}</span>
                    <span className="text-danger">{money(result.finalItalianTaxEUR, locale, 'EUR')}</span>
                  </div>
                  {result.pensionContributionCashOutEUR > 0 && (
                    <>
                      <div className="flex items-center justify-between gap-3">
                        <span className="text-subtle">{copy.labelPensionDeduction}</span>
                        <span className="text-success">{money(result.pensionDeductionEUR, locale, 'EUR')}</span>
                      </div>
                      <div className="flex items-center justify-between gap-3">
                        <span className="text-subtle">{copy.labelPensionCashOut}</span>
                        <span className="text-heading">-{money(result.pensionContributionCashOutEUR, locale, 'EUR')}</span>
                      </div>
                    </>
                  )}
                </div>
              </article>
            ))}
          </div>
        </div>

        <div>
          <div className="flex items-center gap-2 text-sm font-bold text-heading">
            <MapPinned className="w-4 h-4 text-success" />
            {copy.linksTitle}
          </div>
          <div className="mt-4 grid grid-cols-1 md:grid-cols-2 gap-3">
            {copy.links.map((link) => (
              <a
                key={link.label}
                href={buildPath(link.route, locale)}
                className="group rounded-2xl border border-edge bg-surface p-4 no-underline hover:border-info-border transition-colors"
              >
                <div className="flex items-center justify-between gap-3">
                  <span className="text-sm font-semibold text-heading">{link.label}</span>
                  <ArrowRight className="w-4 h-4 text-muted group-hover:text-info transition-colors" />
                </div>
              </a>
            ))}
          </div>
        </div>

        <div>
          <h3 className="text-base font-bold font-display text-heading">{copy.editorialTitle}</h3>
          <div className="mt-3 space-y-3 text-sm leading-7 text-body max-w-4xl">
            {copy.editorialParagraphs.map((paragraph, idx) => (
              <p
                key={idx}
                dangerouslySetInnerHTML={{
                  __html: paragraph.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>'),
                }}
              />
            ))}
          </div>
        </div>

        <div>
          <h3 className="text-sm font-bold text-heading">{copy.faqTitle}</h3>
          <div className="mt-4 space-y-3">
            {copy.faq.map((item) => (
              <div key={item.q} className="rounded-2xl border border-edge bg-surface p-4">
                <div className="text-sm font-semibold text-heading">{item.q}</div>
                <p className="mt-2 text-sm leading-7 text-subtle">{item.a}</p>
              </div>
            ))}
          </div>
        </div>
      </div>
    </section>
  );
};

export default SeasonalNaspiSimulator;
