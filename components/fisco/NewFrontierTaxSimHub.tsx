import React, { Suspense } from 'react';
import {
 ArrowRight,
 Calculator,
 CheckCircle2,
 FileText,
 HelpCircle,
 Receipt,
 Shield,
 Users,
} from 'lucide-react';
import { lazyRetry } from '@/services/lazyRetry';

const RelatedTools = lazyRetry(() => import('@/components/shared/RelatedTools'));
import { buildPath } from '@/services/router';
import { useLocale, type Locale } from '@/services/i18n';

type Copy = {
 badge: string;
 title: string;
 intro: string;
 disclaimer: string;
 regimeTitle: string;
 regimeCards: Array<{ icon: 'shield' | 'receipt' | 'users' | 'calculator'; title: string; body: string }>;
 howTitle: string;
 howSteps: string[];
 exampleTitle: string;
 exampleIntro: string;
 exampleRows: Array<{ label: string; value: string }>;
 exampleNote: string;
 deepLinksTitle: string;
 deepLinksIntro: string;
 openLabel: string;
 faqTitle: string;
 faq: Array<{ question: string; answer: string }>;
 ctas: Array<{ title: string; body: string; route: Parameters<typeof buildPath>[0] }>;
};

const ICON_MAP = { shield: Shield, receipt: Receipt, users: Users, calculator: Calculator };

const COPY_BY_LOCALE: Record<Locale, Copy> = {
 it: {
 badge: 'Nuovo accordo 2024',
 title: 'Simulazione Tasse Nuovi Frontalieri',
 intro: 'Se hai iniziato a lavorare in Svizzera dopo il 17 luglio 2023, rientri nella categoria dei"nuovi frontalieri" e sei soggetto a una tassazione concorrente in Svizzera e in Italia. Questa guida spiega come funziona il regime fiscale e come calcolare il tuo stipendio netto.',
 disclaimer: 'Le informazioni sono aggiornate all\'accordo fiscale Italia-Svizzera 2024 e alle tabelle Ticino 2026. Per casi particolari si consiglia di consultare un professionista fiscale.',
 regimeTitle: 'Come funziona la tassazione dei nuovi frontalieri',
 regimeCards: [
 {
 icon: 'shield',
 title: 'Imposta alla fonte in Svizzera',
 body: 'Il datore di lavoro svizzero trattiene l\'imposta alla fonte direttamente dalla busta paga. Per i frontalieri in Ticino si applica l\'80% dell\'aliquota ordinaria, calcolata in base a stato civile, figli e reddito lordo annuo.',
 },
 {
 icon: 'receipt',
 title: 'IRPEF in Italia con franchigia',
 body: 'L\'Italia tassa il reddito svizzero con l\'IRPEF ordinaria, ma concede una franchigia di \u20AC10.000: i primi 10.000 euro di reddito non vengono tassati in Italia. La franchigia si applica solo ai residenti entro 20 km dal confine.',
 },
 {
 icon: 'users',
 title: 'Credito d\'imposta anti-doppia imposizione',
 body: 'Per evitare di pagare due volte, l\'imposta alla fonte svizzera viene detratta dall\'IRPEF italiana tramite il credito d\'imposta (Art. 165 TUIR). Il credito non puo superare la quota di IRPEF relativa al reddito estero.',
 },
 {
 icon: 'calculator',
 title: 'Calcolo automatico nel simulatore',
 body: 'Il simulatore Frontaliere Ticino applica automaticamente tutti questi meccanismi: inserisci il lordo annuo, lo stato civile, i figli e il comune di residenza per ottenere il netto mensile in pochi secondi.',
 },
 ],
 howTitle: 'Passaggi chiave per calcolare il netto',
 howSteps: [
 'Parti dallo stipendio lordo annuo in CHF indicato nel contratto svizzero.',
 'Sottrai i contributi sociali: AVS 5,3%, AC 1,1%, LAINF, IGM e LPP (variabile per eta).',
 'Applica l\'imposta alla fonte ticinese con la tabella corretta (A, B, C o H) — per i frontalieri al 80%.',
 'Converti il reddito netto svizzero in EUR al tasso di cambio medio annuo.',
 'Calcola l\'IRPEF italiana sul reddito estero meno la franchigia di \u20AC10.000 (se entro 20 km).',
 'Detrai il credito d\'imposta per le tasse svizzere gia pagate.',
 'Il risultato finale e il tuo stipendio netto mensile in euro.',
 ],
 exampleTitle: 'Esempio pratico: CHF 80.000 lordi, single, senza figli',
 exampleIntro: 'Ecco una simulazione indicativa per un nuovo frontaliere single residente entro 20 km dal confine:',
 exampleRows: [
 { label: 'Lordo annuo', value: 'CHF 80.000' },
 { label: 'Contributi CH (AVS, AC, LPP...)', value: '~ CHF 10.400' },
 { label: 'Imposta alla fonte Ticino (80%)', value: '~ CHF 6.700' },
 { label: 'Netto CH annuo', value: '~ CHF 62.900' },
 { label: 'Conversione EUR (cambio 0,94)', value: '~ \u20AC59.100' },
 { label: 'IRPEF su reddito estero (con franchigia)', value: '~ \u20AC8.200' },
 { label: 'Credito d\'imposta (tasse CH)', value: '~ -\u20AC6.300' },
 { label: 'Netto finale annuo', value: '~ \u20AC57.200' },
 ],
 exampleNote: 'I valori sono stime indicative. Il simulatore calcola il netto esatto in base ai parametri personali.',
 deepLinksTitle: 'Calcola il tuo netto adesso',
 deepLinksIntro: 'Passa dalla teoria alla pratica: usa gli strumenti gratuiti per simulare la tua situazione reale.',
 openLabel: 'Apri',
 faqTitle: 'Domande frequenti sui nuovi frontalieri',
 faq: [
 {
 question: 'Chi sono i"nuovi frontalieri"?',
 answer: 'Sono i lavoratori che hanno iniziato l\'attivita in Svizzera dopo il 17 luglio 2023. A differenza dei vecchi frontalieri, pagano tasse sia in Svizzera (imposta alla fonte) sia in Italia (IRPEF con franchigia).',
 },
 {
 question: 'La franchigia di \u20AC10.000 si applica sempre?',
 answer: 'No. La franchigia si applica solo ai frontalieri residenti entro 20 km dal confine svizzero. Chi risiede oltre 20 km paga l\'IRPEF piena senza franchigia, ma ha comunque diritto al credito d\'imposta.',
 },
 {
 question: 'Devo fare la dichiarazione dei redditi in Italia?',
 answer: 'Si. I nuovi frontalieri devono dichiarare il reddito svizzero in Italia tramite il Modello 730 o il Modello Redditi PF, indicando il credito d\'imposta nel quadro CE per le tasse pagate in Svizzera.',
 },
 {
 question: 'Quanto costa usare il simulatore?',
 answer: 'Nulla. Il simulatore e completamente gratuito e non richiede registrazione. Inserisci i tuoi dati e ottieni il calcolo in pochi secondi.',
 },
 ],
 ctas: [
 {
 title: 'Simula il tuo netto 2026',
 body: 'Calcola lo stipendio netto con il regime nuovi frontalieri in pochi click.',
 route: { activeTab: 'calculator' },
 },
 {
 title: 'Credito d\'imposta',
 body: 'Approfondisci il meccanismo anti-doppia imposizione e calcola la detrazione.',
 route: { activeTab: 'fisco', fiscoSubTab: 'tax-credit' },
 },
 {
 title: 'Dichiarazione dei redditi',
 body: 'Guida passo-passo per compilare il 730 o il Modello Redditi PF come frontaliere.',
 route: { activeTab: 'fisco', fiscoSubTab: 'tax-return', taxReturnCountry: 'italia' },
 },
 ],
 },
 en: {
 badge: 'New Agreement 2024',
 title: 'Tax Simulation for New Cross-Border Workers',
 intro: 'If you started working in Switzerland after 17 July 2023, you are classified as a"new cross-border worker" and subject to concurrent taxation in Switzerland and Italy. This guide explains how the tax regime works and how to calculate your net salary.',
 disclaimer: 'Information is based on the Italy-Switzerland fiscal agreement 2024 and Ticino 2026 tax tables. For complex cases, consult a tax professional.',
 regimeTitle: 'How new cross-border worker taxation works',
 regimeCards: [
 {
 icon: 'shield',
 title: 'Withholding tax in Switzerland',
 body: 'Your Swiss employer withholds tax at source from your payslip. In Ticino, new cross-border workers pay 80% of the ordinary rate, based on marital status, children, and gross annual income.',
 },
 {
 icon: 'receipt',
 title: 'IRPEF in Italy with franchise',
 body: 'Italy taxes your Swiss income with standard IRPEF rates, but grants a EUR 10,000 franchise: the first 10,000 euros are not taxed in Italy. The franchise applies only to residents within 20 km of the border.',
 },
 {
 icon: 'users',
 title: 'Tax credit to avoid double taxation',
 body: 'To prevent paying twice, Swiss withholding tax is deducted from Italian IRPEF through the foreign tax credit (Art. 165 TUIR). The credit cannot exceed the IRPEF share attributable to foreign income.',
 },
 {
 icon: 'calculator',
 title: 'Automatic calculation in the simulator',
 body: 'The Frontaliere Ticino simulator applies all these mechanisms automatically: enter your gross salary, marital status, children, and municipality to get your monthly net in seconds.',
 },
 ],
 howTitle: 'Key steps to calculate your net salary',
 howSteps: [
 'Start from the gross annual salary in CHF stated in your Swiss contract.',
 'Deduct social contributions: AVS 5.3%, unemployment 1.1%, accident insurance, sickness benefits, and LPP (varies by age).',
 'Apply Ticino withholding tax using the correct table (A, B, C or H) — at 80% for cross-border workers.',
 'Convert Swiss net income to EUR at the annual average exchange rate.',
 'Calculate Italian IRPEF on foreign income minus the EUR 10,000 franchise (if within 20 km).',
 'Deduct the tax credit for Swiss taxes already paid.',
 'The result is your monthly net salary in euros.',
 ],
 exampleTitle: 'Practical example: CHF 80,000 gross, single, no children',
 exampleIntro: 'Here is an indicative simulation for a new single cross-border worker residing within 20 km of the border:',
 exampleRows: [
 { label: 'Annual gross', value: 'CHF 80,000' },
 { label: 'Swiss contributions (AVS, AC, LPP...)', value: '~ CHF 10,400' },
 { label: 'Ticino withholding tax (80%)', value: '~ CHF 6,700' },
 { label: 'Swiss net annual', value: '~ CHF 62,900' },
 { label: 'EUR conversion (rate 0.94)', value: '~ EUR 59,100' },
 { label: 'IRPEF on foreign income (with franchise)', value: '~ EUR 8,200' },
 { label: 'Tax credit (Swiss taxes)', value: '~ -EUR 6,300' },
 { label: 'Final net annual', value: '~ EUR 57,200' },
 ],
 exampleNote: 'Values are estimates. The simulator calculates the exact net based on your personal parameters.',
 deepLinksTitle: 'Calculate your net now',
 deepLinksIntro: 'Go from theory to practice: use the free tools to simulate your real situation.',
 openLabel: 'Open',
 faqTitle: 'Frequently asked questions about new cross-border workers',
 faq: [
 {
 question: 'Who are"new cross-border workers"?',
 answer: 'Workers who started employment in Switzerland after 17 July 2023. Unlike old cross-border workers, they pay taxes in both Switzerland (withholding tax) and Italy (IRPEF with franchise).',
 },
 {
 question: 'Does the EUR 10,000 franchise always apply?',
 answer: 'No. The franchise applies only to cross-border workers residing within 20 km of the Swiss border. Those beyond 20 km pay full IRPEF without the franchise, but still qualify for the tax credit.',
 },
 {
 question: 'Do I need to file a tax return in Italy?',
 answer: 'Yes. New cross-border workers must declare their Swiss income in Italy using Modello 730 or Modello Redditi PF, indicating the tax credit in section CE for taxes paid in Switzerland.',
 },
 {
 question: 'How much does the simulator cost?',
 answer: 'Nothing. The simulator is completely free and requires no registration. Enter your data and get the calculation in seconds.',
 },
 ],
 ctas: [
 {
 title: 'Simulate your 2026 net',
 body: 'Calculate your net salary under the new cross-border worker regime in a few clicks.',
 route: { activeTab: 'calculator' },
 },
 {
 title: 'Tax credit',
 body: 'Learn about the double taxation prevention mechanism and calculate your deduction.',
 route: { activeTab: 'fisco', fiscoSubTab: 'tax-credit' },
 },
 {
 title: 'Tax return guide',
 body: 'Step-by-step guide to filing your Italian tax return as a cross-border worker.',
 route: { activeTab: 'fisco', fiscoSubTab: 'tax-return', taxReturnCountry: 'italia' },
 },
 ],
 },
 de: {
 badge: 'Neues Abkommen 2024',
 title: 'Steuerberechnung fuer neue Grenzgaenger',
 intro: 'Wenn Sie nach dem 17. Juli 2023 in der Schweiz zu arbeiten begonnen haben, gelten Sie als"neuer Grenzgaenger" und unterliegen der konkurrierenden Besteuerung in der Schweiz und in Italien. Dieser Leitfaden erklaert das Steuersystem und wie Sie Ihr Nettogehalt berechnen.',
 disclaimer: 'Die Angaben basieren auf dem Steuerabkommen Italien-Schweiz 2024 und den Tessiner Tabellen 2026. Bei besonderen Faellen empfehlen wir eine professionelle Steuerberatung.',
 regimeTitle: 'So funktioniert die Besteuerung neuer Grenzgaenger',
 regimeCards: [
 {
 icon: 'shield',
 title: 'Quellensteuer in der Schweiz',
 body: 'Ihr Schweizer Arbeitgeber zieht die Quellensteuer direkt vom Lohn ab. Im Tessin zahlen neue Grenzgaenger 80% des ordentlichen Satzes, berechnet nach Zivilstand, Kindern und Bruttojahreseinkommen.',
 },
 {
 icon: 'receipt',
 title: 'IRPEF in Italien mit Franchise',
 body: 'Italien besteuert Ihr Schweizer Einkommen mit den normalen IRPEF-Saetzen, gewaehrt aber eine Franchise von EUR 10.000: Die ersten 10.000 Euro werden in Italien nicht besteuert. Die Franchise gilt nur fuer Einwohner innerhalb von 20 km der Grenze.',
 },
 {
 icon: 'users',
 title: 'Steuergutschrift gegen Doppelbesteuerung',
 body: 'Um doppelte Zahlung zu vermeiden, wird die Schweizer Quellensteuer von der italienischen IRPEF ueber die Steuergutschrift (Art. 165 TUIR) abgezogen. Die Gutschrift darf den IRPEF-Anteil des auslaendischen Einkommens nicht uebersteigen.',
 },
 {
 icon: 'calculator',
 title: 'Automatische Berechnung im Simulator',
 body: 'Der Frontaliere Ticino-Simulator wendet alle diese Mechanismen automatisch an: Geben Sie Ihr Bruttogehalt, Zivilstand, Kinder und Wohngemeinde ein, um Ihr monatliches Netto in Sekunden zu erhalten.',
 },
 ],
 howTitle: 'Wichtige Schritte zur Berechnung Ihres Nettogehalts',
 howSteps: [
 'Ausgangspunkt ist das Bruttojahresgehalt in CHF laut Schweizer Vertrag.',
 'Sozialabzuege abziehen: AHV 5,3%, ALV 1,1%, UVG, KTG und BVG (variiert nach Alter).',
 'Tessiner Quellensteuer mit der richtigen Tabelle (A, B, C oder H) anwenden — fuer Grenzgaenger zu 80%.',
 'Schweizer Nettoeinkommen zum Jahres-Durchschnittskurs in EUR umrechnen.',
 'Italienische IRPEF auf das auslaendische Einkommen abzueglich der EUR 10.000 Franchise (innerhalb 20 km) berechnen.',
 'Steuergutschrift fuer bereits gezahlte Schweizer Steuern abziehen.',
 'Das Ergebnis ist Ihr monatliches Nettogehalt in Euro.',
 ],
 exampleTitle: 'Praxisbeispiel: CHF 80.000 brutto, ledig, ohne Kinder',
 exampleIntro: 'Hier eine indikative Simulation fuer einen neuen ledigen Grenzgaenger mit Wohnsitz innerhalb von 20 km der Grenze:',
 exampleRows: [
 { label: 'Jahresbrutto', value: 'CHF 80.000' },
 { label: 'CH-Beitraege (AHV, ALV, BVG...)', value: '~ CHF 10.400' },
 { label: 'Quellensteuer Tessin (80%)', value: '~ CHF 6.700' },
 { label: 'CH-Netto jaehrlich', value: '~ CHF 62.900' },
 { label: 'EUR-Umrechnung (Kurs 0,94)', value: '~ EUR 59.100' },
 { label: 'IRPEF auf Auslandseinkommen (mit Franchise)', value: '~ EUR 8.200' },
 { label: 'Steuergutschrift (CH-Steuern)', value: '~ -EUR 6.300' },
 { label: 'Endgueltiges Jahresnetto', value: '~ EUR 57.200' },
 ],
 exampleNote: 'Werte sind Schaetzungen. Der Simulator berechnet das genaue Netto basierend auf Ihren persoenlichen Parametern.',
 deepLinksTitle: 'Berechnen Sie jetzt Ihr Netto',
 deepLinksIntro: 'Von der Theorie zur Praxis: Nutzen Sie die kostenlosen Tools, um Ihre reale Situation zu simulieren.',
 openLabel: 'Oeffnen',
 faqTitle: 'Haeufige Fragen zu neuen Grenzgaengern',
 faq: [
 {
 question: 'Wer sind"neue Grenzgaenger"?',
 answer: 'Arbeitnehmer, die nach dem 17. Juli 2023 in der Schweiz begonnen haben. Im Unterschied zu alten Grenzgaengern zahlen sie Steuern in der Schweiz (Quellensteuer) und in Italien (IRPEF mit Franchise).',
 },
 {
 question: 'Gilt die Franchise von EUR 10.000 immer?',
 answer: 'Nein. Die Franchise gilt nur fuer Grenzgaenger mit Wohnsitz innerhalb von 20 km der Schweizer Grenze. Wer weiter als 20 km entfernt wohnt, zahlt volle IRPEF ohne Franchise, hat aber Anspruch auf die Steuergutschrift.',
 },
 {
 question: 'Muss ich in Italien eine Steuererklaerung abgeben?',
 answer: 'Ja. Neue Grenzgaenger muessen ihr Schweizer Einkommen in Italien ueber das Modello 730 oder Modello Redditi PF deklarieren und die Steuergutschrift im Quadro CE angeben.',
 },
 {
 question: 'Kostet der Simulator etwas?',
 answer: 'Nein. Der Simulator ist voellig kostenlos und erfordert keine Registrierung. Geben Sie Ihre Daten ein und erhalten Sie die Berechnung in Sekunden.',
 },
 ],
 ctas: [
 {
 title: 'Netto 2026 simulieren',
 body: 'Berechnen Sie Ihr Nettogehalt unter dem neuen Grenzgaenger-Regime mit wenigen Klicks.',
 route: { activeTab: 'calculator' },
 },
 {
 title: 'Steuergutschrift',
 body: 'Erfahren Sie mehr ueber den Doppelbesteuerungsschutz und berechnen Sie Ihren Abzug.',
 route: { activeTab: 'fisco', fiscoSubTab: 'tax-credit' },
 },
 {
 title: 'Steuererklaerung',
 body: 'Schritt-fuer-Schritt-Anleitung fuer die italienische Steuererklaerung als Grenzgaenger.',
 route: { activeTab: 'fisco', fiscoSubTab: 'tax-return', taxReturnCountry: 'italia' },
 },
 ],
 },
 fr: {
 badge: 'Nouvel accord 2024',
 title: 'Simulation fiscale pour nouveaux frontaliers',
 intro: 'Si vous avez commence a travailler en Suisse apres le 17 juillet 2023, vous etes classe comme"nouveau frontalier" et soumis a la taxation concurrente en Suisse et en Italie. Ce guide explique le regime fiscal et comment calculer votre salaire net.',
 disclaimer: 'Les informations sont basees sur l\'accord fiscal Italie-Suisse 2024 et les baremes du Tessin 2026. Pour les cas complexes, consultez un professionnel fiscal.',
 regimeTitle: 'Comment fonctionne la taxation des nouveaux frontaliers',
 regimeCards: [
 {
 icon: 'shield',
 title: 'Impot a la source en Suisse',
 body: 'Votre employeur suisse preleve l\'impot a la source directement sur votre salaire. Au Tessin, les nouveaux frontaliers paient 80% du taux ordinaire, calcule selon l\'etat civil, les enfants et le revenu brut annuel.',
 },
 {
 icon: 'receipt',
 title: 'IRPEF en Italie avec franchise',
 body: 'L\'Italie impose votre revenu suisse avec les taux IRPEF ordinaires, mais accorde une franchise de 10 000 EUR : les premiers 10 000 euros ne sont pas imposes en Italie. La franchise s\'applique uniquement aux residents a moins de 20 km de la frontiere.',
 },
 {
 icon: 'users',
 title: 'Credit d\'impot anti-double imposition',
 body: 'Pour eviter de payer deux fois, l\'impot a la source suisse est deduit de l\'IRPEF italienne via le credit d\'impot (Art. 165 TUIR). Le credit ne peut pas depasser la part d\'IRPEF relative au revenu etranger.',
 },
 {
 icon: 'calculator',
 title: 'Calcul automatique dans le simulateur',
 body: 'Le simulateur Frontaliere Ticino applique automatiquement tous ces mecanismes : entrez votre salaire brut, etat civil, enfants et commune de residence pour obtenir votre net mensuel en quelques secondes.',
 },
 ],
 howTitle: 'Etapes cles pour calculer votre net',
 howSteps: [
 'Partez du salaire brut annuel en CHF indique dans votre contrat suisse.',
 'Deduisez les cotisations sociales : AVS 5,3%, AC 1,1%, LAA, IJM et LPP (variable selon l\'age).',
 'Appliquez l\'impot a la source tessinois avec le bon bareme (A, B, C ou H) — a 80% pour les frontaliers.',
 'Convertissez le net suisse en EUR au taux de change moyen annuel.',
 'Calculez l\'IRPEF italienne sur le revenu etranger moins la franchise de 10 000 EUR (si dans les 20 km).',
 'Deduisez le credit d\'impot pour les impots suisses deja payes.',
 'Le resultat est votre salaire net mensuel en euros.',
 ],
 exampleTitle: 'Exemple pratique : CHF 80 000 bruts, celibataire, sans enfants',
 exampleIntro: 'Voici une simulation indicative pour un nouveau frontalier celibataire residant a moins de 20 km de la frontiere :',
 exampleRows: [
 { label: 'Brut annuel', value: 'CHF 80 000' },
 { label: 'Cotisations CH (AVS, AC, LPP...)', value: '~ CHF 10 400' },
 { label: 'Impot a la source Tessin (80%)', value: '~ CHF 6 700' },
 { label: 'Net CH annuel', value: '~ CHF 62 900' },
 { label: 'Conversion EUR (taux 0,94)', value: '~ EUR 59 100' },
 { label: 'IRPEF sur revenu etranger (avec franchise)', value: '~ EUR 8 200' },
 { label: 'Credit d\'impot (impots CH)', value: '~ -EUR 6 300' },
 { label: 'Net final annuel', value: '~ EUR 57 200' },
 ],
 exampleNote: 'Les valeurs sont des estimations. Le simulateur calcule le net exact selon vos parametres personnels.',
 deepLinksTitle: 'Calculez votre net maintenant',
 deepLinksIntro: 'Passez de la theorie a la pratique : utilisez les outils gratuits pour simuler votre situation reelle.',
 openLabel: 'Ouvrir',
 faqTitle: 'Questions frequentes sur les nouveaux frontaliers',
 faq: [
 {
 question: 'Qui sont les"nouveaux frontaliers" ?',
 answer: 'Les travailleurs ayant debute en Suisse apres le 17 juillet 2023. Contrairement aux anciens frontaliers, ils paient des impots en Suisse (impot a la source) et en Italie (IRPEF avec franchise).',
 },
 {
 question: 'La franchise de 10 000 EUR s\'applique-t-elle toujours ?',
 answer: 'Non. La franchise ne s\'applique qu\'aux frontaliers residant a moins de 20 km de la frontiere suisse. Au-dela de 20 km, l\'IRPEF complete s\'applique sans franchise, mais le credit d\'impot reste applicable.',
 },
 {
 question: 'Dois-je faire une declaration de revenus en Italie ?',
 answer: 'Oui. Les nouveaux frontaliers doivent declarer leurs revenus suisses en Italie via le Modello 730 ou Modello Redditi PF, en indiquant le credit d\'impot dans le quadro CE.',
 },
 {
 question: 'Le simulateur est-il payant ?',
 answer: 'Non. Le simulateur est entierement gratuit et ne necessite aucune inscription. Entrez vos donnees et obtenez le calcul en quelques secondes.',
 },
 ],
 ctas: [
 {
 title: 'Simuler votre net 2026',
 body: 'Calculez votre salaire net sous le regime des nouveaux frontaliers en quelques clics.',
 route: { activeTab: 'calculator' },
 },
 {
 title: 'Credit d\'impot',
 body: 'Decouvrez le mecanisme anti-double imposition et calculez votre deduction.',
 route: { activeTab: 'fisco', fiscoSubTab: 'tax-credit' },
 },
 {
 title: 'Declaration de revenus',
 body: 'Guide pas a pas pour remplir votre declaration italienne en tant que frontalier.',
 route: { activeTab: 'fisco', fiscoSubTab: 'tax-return', taxReturnCountry: 'italia' },
 },
 ],
 },
};

export default function NewFrontierTaxSimHub() {
 const [locale] = useLocale();
 const c = COPY_BY_LOCALE[locale] || COPY_BY_LOCALE.it;

 return (
 <article className="max-w-4xl mx-auto px-4 py-6 space-y-6">
 {/* Badge + Title */}
 <header className="space-y-3">
 <span className="inline-block rounded-full bg-success-subtle text-success text-xs font-bold px-3 py-1 uppercase tracking-wide">
 {c.badge}
 </span>
 <h1 className="text-3xl sm:text-4xl font-extrabold font-display text-heading leading-tight">{c.title}</h1>
 <p className="text-base sm:text-lg text-subtle leading-relaxed max-w-3xl">{c.intro}</p>
 <p className="text-xs text-muted italic">{c.disclaimer}</p>
 </header>

 {/* Regime explanation cards */}
 <section className="space-y-4" data-speakable>
 <h2 className="text-2xl font-bold font-display text-heading">{c.regimeTitle}</h2>
 <div className="grid gap-4 sm:grid-cols-2">
 {c.regimeCards.map((card) => {
 const Icon = ICON_MAP[card.icon];
 return (
 <div key={card.title} className="rounded-2xl border border-edge p-5 bg-surface">
 <div className="flex items-start gap-3">
 <div className="flex-shrink-0 w-9 h-9 rounded-lg bg-success-subtle flex items-center justify-center">
 <Icon className="w-5 h-5 text-success" />
 </div>
 <div>
 <h3 className="font-semibold text-heading text-sm">{card.title}</h3>
 <p className="mt-1 text-sm text-subtle leading-relaxed">{card.body}</p>
 </div>
 </div>
 </div>
 );
 })}
 </div>
 </section>

 {/* How to calculate steps */}
 <section className="space-y-4">
 <h2 className="text-2xl font-bold font-display text-heading">{c.howTitle}</h2>
 <ol className="space-y-3 pl-0 list-none">
 {c.howSteps.map((step, i) => (
 <li key={i} className="flex items-start gap-3">
 <span className="flex-shrink-0 w-7 h-7 rounded-full bg-success-subtle text-success text-xs font-bold flex items-center justify-center mt-0.5">
 {i + 1}
 </span>
 <span className="text-sm text-body leading-relaxed">{step}</span>
 </li>
 ))}
 </ol>
 </section>

 {/* Example table */}
 <section className="space-y-4">
 <h2 className="text-2xl font-bold font-display text-heading">{c.exampleTitle}</h2>
 <p className="text-sm text-subtle">{c.exampleIntro}</p>
 <div className="rounded-2xl border border-edge overflow-hidden">
 <table className="w-full text-sm">
 <tbody>
 {c.exampleRows.map((row, i) => (
 <tr key={i} className={i % 2 === 0 ? 'bg-surface-alt/50' : 'bg-surface'}>
 <td className="px-4 py-2.5 text-body font-medium">{row.label}</td>
 <td className="px-4 py-2.5 text-right text-heading font-semibold tabular-nums">{row.value}</td>
 </tr>
 ))}
 </tbody>
 </table>
 </div>
 <p className="text-xs text-muted italic">{c.exampleNote}</p>
 </section>

 {/* CTA deep links */}
 <section className="space-y-4">
 <h2 className="text-2xl font-bold font-display text-heading">{c.deepLinksTitle}</h2>
 <p className="text-sm text-subtle">{c.deepLinksIntro}</p>
 <div className="grid gap-3 sm:grid-cols-3">
 {c.ctas.map((cta) => (
 <a
 key={cta.title}
 href={buildPath(cta.route)}
 className="group rounded-2xl border border-edge p-5 bg-surface hover:border-success transition-colors no-underline"
 >
 <h3 className="font-semibold text-success text-sm flex items-center gap-1.5">
 {cta.title}
 <ArrowRight className="w-3.5 h-3.5 opacity-0 group-hover:opacity-100 transition-opacity" />
 </h3>
 <p className="mt-1 text-xs text-subtle leading-relaxed">{cta.body}</p>
 </a>
 ))}
 </div>
 </section>

 {/* FAQ */}
 <section className="space-y-4" data-speakable>
 <h2 className="text-2xl font-bold font-display text-heading flex items-center gap-2">
 <HelpCircle className="w-5 h-5 text-success" />
 {c.faqTitle}
 </h2>
 <div className="space-y-3">
 {c.faq.map((item) => (
 <details key={item.question} className="group rounded-2xl border border-edge bg-surface overflow-hidden">
 <summary className="cursor-pointer px-5 py-4 text-sm font-medium text-heading select-none list-none flex items-center justify-between">
 {item.question}
 <CheckCircle2 className="w-4 h-4 text-success opacity-0 group-open:opacity-100 transition-opacity flex-shrink-0 ml-2" />
 </summary>
 <div className="px-5 pb-4 text-sm text-subtle leading-relaxed faq-answer">{item.answer}</div>
 </details>
 ))}
 </div>
 </section>
 <Suspense fallback={null}><RelatedTools context="tax" /></Suspense>
 </article>
 );
}
