import React, { useMemo } from 'react';
import { ArrowRight, Calculator, MapPinned, Scale, Sparkles } from 'lucide-react';
import { useLocale } from '@/services/i18n';
import { buildPath, type AppRoute } from '@/services/router';
import { calculateSimulation } from '@/services/calculationService';
import { DEFAULT_INPUTS } from '@/constants';
import type { Locale } from '@/services/i18n';
import type { SimulationInputs } from '@/types';

type ScenarioCard = {
 income: number;
 title: string;
 summary: string;
};

type Copy = {
 badge: string;
 title: string;
 subtitle: string;
 intro: string;
 bullets: string[];
 casesTitle: string;
 compareTitle: string;
 compareBody: string;
 compareOver: string;
 compareWithin: string;
 compareDelta: string;
 linksTitle: string;
 links: Array<{ label: string; route: AppRoute }>;
 editorialTitle: string;
 editorialParagraphs: string[];
 faqTitle: string;
 faq: Array<{ q: string; a: string }>;
 caseSummary: string;
 labelGross: string;
 labelSocial: string;
 labelTaxes: string;
 labelNetAnnual: string;
 labelNetMonthly: string;
 labelEffRate: string;
};

const COPY_BY_LOCALE: Record<Locale, Copy> = {
 it: {
 badge: 'Nuovo accordo 2026',
 title: 'Nuovi frontalieri oltre 20 km',
 subtitle: 'Casi pratici, confronto con chi vive entro 20 km e simulazione immediata del tuo netto.',
 intro: 'Questa landing serve a capire in modo concreto cosa cambia se sei un nuovo frontaliere, lavori in Ticino e vivi in un comune italiano oltre 20 km dal confine. Sotto trovi tre casi già calcolati e un confronto diretto con lo scenario entro 20 km.',
 bullets: [
 'Oltre 20 km l’imposta resta integralmente trattenuta in Svizzera.',
 'Entro 20 km la Svizzera trattiene l’80% e l’Italia tassa con credito per le imposte già pagate.',
 'La distanza di residenza cambia quindi cash flow, dichiarazione fiscale e convenienza netta.',
 ],
 casesTitle: 'Casi pratici già calcolati',
 compareTitle: 'Confronto rapido entro vs oltre 20 km',
 compareBody: 'Per uno stesso nuovo frontaliere single con 80.000 CHF, il punto chiave è dove si sposta il carico fiscale: oltre 20 km rimane in Svizzera, entro 20 km si apre la tassazione concorrente con credito d’imposta.',
 compareOver: 'Netto mensile oltre 20 km',
 compareWithin: 'Netto mensile entro 20 km',
 compareDelta: 'Differenza mensile a favore dello scenario migliore',
 linksTitle: 'Tool utili per approfondire',
 links: [
 { label: 'Calcola il tuo caso', route: { activeTab: 'calculator', calcolatoreSubTab: 'calculator' } },
 { label: 'Aliquote imposta alla fonte Ticino 2026', route: { activeTab: 'fisco', fiscoSubTab: 'withholding-rates' } },
 { label: 'Confronto netto 2025 vs 2026 oltre 20 km', route: { activeTab: 'calculator', calcolatoreSubTab: 'calculator', seoLanding: 'net-comparison-2025-2026-over20km' } },
 { label: 'Guida dichiarazione redditi', route: { activeTab: 'fisco', fiscoSubTab: 'tax-return' } },
 ],
 editorialTitle: 'Come si calcolano le tasse del frontaliere oltre 20 km',
 editorialParagraphs: [
 'Per i nuovi frontalieri che risiedono oltre 20 km dal confine, l\'Accordo 2020 (in vigore dal 17 luglio 2023) introduce la regola della **tassazione esclusiva svizzera**: il reddito da lavoro dipendente prodotto in Ticino è tassato integralmente e solo in Svizzera, tramite l\'imposta alla fonte trattenuta in busta paga. In Italia non si dichiara questo reddito (se non ci sono altri redditi rilevanti), e non si applica la tassazione concorrente.',
 'La differenza con i **vecchi frontalieri** (assunti prima del 17 luglio 2023) è sostanziale: i vecchi frontalieri — se residenti nella fascia dei 20 km — continuano a essere tassati solo in Svizzera grazie al regime transitorio, mentre i nuovi frontalieri entro 20 km rientrano nella tassazione concorrente (Svizzera trattiene l\'80% come acconto, Italia completa con credito d\'imposta). Superati i 20 km, invece, i nuovi frontalieri tornano al regime di tassazione esclusiva, simile a quello dei vecchi frontalieri, semplificando di fatto la dichiarazione.',
 'Esempio pratico su uno stipendio lordo di CHF 60\'000 annui (5\'000 CHF/mese), single senza figli: i contributi sociali obbligatori (AVS/AI/IPG/AD ~6,25%, LPP ~7-8%, AINF ~1%, totale circa 14%) sottraggono ~700 CHF/mese, lasciando un imponibile di ~4\'300 CHF. L\'imposta alla fonte ticinese 2026 su questo scaglione (tariffa A0, single) si attesta attorno al 9-11%, ovvero ~420-480 CHF/mese. Il **netto mensile in tasca** risulta quindi di circa **CHF 3\'820-3\'880**, senza ulteriori prelievi italiani. Per numeri esatti sul tuo caso, usa il calcolatore qui sopra inserendo comune di residenza e composizione familiare.',
 ],
 faqTitle: 'FAQ essenziali',
 faq: [
 {
 q: 'Chi è considerato nuovo frontaliere oltre 20 km?',
 a: 'Chi ha iniziato a lavorare in Svizzera dal 17 luglio 2023 in poi e vive in un comune italiano oltre 20 km dalla frontiera.',
 },
 {
 q: 'È meglio vivere entro o oltre 20 km?',
 a: 'Non esiste una risposta unica: oltre 20 km spesso semplifica la tassazione svizzera, entro 20 km può cambiare il saldo finale in Italia. Va simulato sul tuo reddito reale.',
 },
 {
 q: 'Questa pagina basta per fare la dichiarazione?',
 a: 'No. È una guida pratica per orientarti e stimare il netto. Per la dichiarazione serve sempre una verifica puntuale della tua situazione.',
 },
 ],
 caseSummary: 'Nuovo frontaliere, residenza oltre 20 km',
 labelGross: 'Stipendio lordo',
 labelSocial: 'Contributi sociali',
 labelTaxes: 'Imposte totali',
 labelNetAnnual: 'Netto annuo',
 labelNetMonthly: 'Netto mensile',
 labelEffRate: 'Aliquota effettiva',
 },
 en: {
 badge: '2026 tax rules',
 title: 'New cross-border workers over 20 km',
 subtitle: 'Practical cases, comparison with residents within 20 km, and a ready-to-use net salary simulation.',
 intro: 'This page helps you understand what changes when you are a new cross-border worker, work in Ticino, and live in an Italian municipality more than 20 km from the border. Below you can see three pre-calculated cases and a direct comparison with the within-20-km scenario.',
 bullets: [
 'Over 20 km, tax is fully withheld in Switzerland.',
 'Within 20 km, Switzerland withholds 80% and Italy taxes the income with a foreign tax credit.',
 'Your residence distance changes cash flow, tax filing, and overall net convenience.',
 ],
 casesTitle: 'Pre-calculated practical cases',
 compareTitle: 'Quick comparison: within vs over 20 km',
 compareBody: 'For the same new single cross-border worker earning CHF 80,000, the key difference is where taxation is settled: over 20 km it remains in Switzerland, within 20 km it becomes concurrent taxation with tax credit.',
 compareOver: 'Monthly net over 20 km',
 compareWithin: 'Monthly net within 20 km',
 compareDelta: 'Monthly difference in favor of the better scenario',
 linksTitle: 'Useful tools',
 links: [
 { label: 'Calculate your case', route: { activeTab: 'calculator', calcolatoreSubTab: 'calculator' } },
 { label: 'Ticino withholding tax rates 2026', route: { activeTab: 'fisco', fiscoSubTab: 'withholding-rates' } },
 { label: 'Net comparison 2025 vs 2026 over 20 km', route: { activeTab: 'calculator', calcolatoreSubTab: 'calculator', seoLanding: 'net-comparison-2025-2026-over20km' } },
 { label: 'Tax return guide', route: { activeTab: 'fisco', fiscoSubTab: 'tax-return' } },
 ],
 editorialTitle: 'How taxes are calculated for cross-border workers over 20 km',
 editorialParagraphs: [
 'For new cross-border workers residing more than 20 km from the border, the 2020 Agreement (in force from 17 July 2023) introduces **Swiss-exclusive taxation**: employment income earned in Ticino is taxed fully and only in Switzerland via payroll withholding tax. In Italy this income is not declared (unless other Italian-source income exists), and concurrent taxation does not apply.',
 'The contrast with **old cross-border workers** (hired before 17 July 2023) is significant: old frontalieri — when living inside the 20 km band — remain taxed only in Switzerland under the transitional regime, while new frontalieri inside 20 km fall under concurrent taxation (Switzerland withholds 80% as an advance, Italy tops it up with a foreign tax credit). Beyond 20 km, new frontalieri return to an exclusive-taxation regime similar to old frontalieri, which materially simplifies the Italian filing.',
 'Worked example on a gross salary of CHF 60\'000/year (CHF 5\'000/month), single, no children: mandatory social contributions (AHV/AI/EO/ALV ~6.25%, BVG ~7-8%, accident ~1%, total around 14%) remove ~CHF 700/month, leaving a taxable base of ~CHF 4\'300. Ticino 2026 withholding tax on this bracket (A0 single tariff) lands around 9-11%, i.e. ~CHF 420-480/month. The **monthly take-home net** therefore sits around **CHF 3\'820-3\'880**, with no further Italian withholdings. For exact figures on your own case, use the calculator above with your residence municipality and family composition.',
 ],
 faqTitle: 'Essential FAQ',
 faq: [
 {
 q: 'Who is considered a new cross-border worker over 20 km?',
 a: 'Someone who started cross-border work in Switzerland on or after July 17, 2023 and lives in an Italian municipality more than 20 km from the border.',
 },
 {
 q: 'Is it better to live within or over 20 km?',
 a: 'There is no universal answer: over 20 km often simplifies Swiss taxation, while within 20 km may change the final Italian balance. It should be simulated on your actual income.',
 },
 {
 q: 'Is this page enough to file taxes?',
 a: 'No. This is a practical guide to estimate your net position. Your real tax filing still needs a case-specific review.',
 },
 ],
 caseSummary: 'New cross-border worker, residence over 20 km',
 labelGross: 'Gross salary',
 labelSocial: 'Social contributions',
 labelTaxes: 'Total taxes',
 labelNetAnnual: 'Net annual',
 labelNetMonthly: 'Net monthly',
 labelEffRate: 'Effective rate',
 },
 de: {
 badge: 'Steuerregeln 2026',
 title: 'Neue Grenzgaenger ueber 20 km',
 subtitle: 'Praxisfaelle, Vergleich mit Wohnsitz innerhalb von 20 km und direkter Netto-Rechner.',
 intro: 'Diese Seite zeigt konkret, was sich aendert, wenn du ein neuer Grenzgaenger bist, im Tessin arbeitest und in einer italienischen Gemeinde mehr als 20 km von der Grenze entfernt wohnst. Unten findest du drei bereits berechnete Faelle und einen direkten Vergleich mit dem Szenario innerhalb von 20 km.',
 bullets: [
 'Ueber 20 km bleibt die Steuer vollstaendig in der Schweiz einbehalten.',
 'Innerhalb von 20 km behaelt die Schweiz 80% ein und Italien besteuert mit Steuergutschrift.',
 'Die Distanz des Wohnsitzes veraendert Cashflow, Steuererklaerung und den effektiven Netto-Vorteil.',
 ],
 casesTitle: 'Berechnete Praxisfaelle',
 compareTitle: 'Schnellvergleich: innerhalb vs ueber 20 km',
 compareBody: 'Bei einem neuen alleinstehenden Grenzgaenger mit CHF 80.000 liegt der Unterschied vor allem darin, wo die Steuerwirkung entsteht: ueber 20 km in der Schweiz, innerhalb 20 km als konkurrierende Besteuerung mit Steuergutschrift.',
 compareOver: 'Monatliches Netto ueber 20 km',
 compareWithin: 'Monatliches Netto innerhalb 20 km',
 compareDelta: 'Monatliche Differenz zugunsten des besseren Szenarios',
 linksTitle: 'Nuetzliche Tools',
 links: [
 { label: 'Eigenen Fall berechnen', route: { activeTab: 'calculator', calcolatoreSubTab: 'calculator' } },
 { label: 'Quellensteuer Tessin 2026', route: { activeTab: 'fisco', fiscoSubTab: 'withholding-rates' } },
 { label: 'Nettovergleich 2025 vs 2026 ueber 20 km', route: { activeTab: 'calculator', calcolatoreSubTab: 'calculator', seoLanding: 'net-comparison-2025-2026-over20km' } },
 { label: 'Steuererklaerung Leitfaden', route: { activeTab: 'fisco', fiscoSubTab: 'tax-return' } },
 ],
 editorialTitle: 'So werden die Steuern fuer Grenzgaenger ueber 20 km berechnet',
 editorialParagraphs: [
 'Fuer neue Grenzgaenger mit Wohnsitz mehr als 20 km von der Grenze entfernt fuehrt das Abkommen 2020 (in Kraft seit 17. Juli 2023) die **ausschliessliche Besteuerung in der Schweiz** ein: das in Tessin erzielte Arbeitseinkommen wird voll und ausschliesslich in der Schweiz ueber die Lohnquellensteuer besteuert. In Italien wird dieses Einkommen nicht deklariert (sofern keine weiteren italienischen Einkuenfte vorliegen), und eine konkurrierende Besteuerung findet nicht statt.',
 'Der Unterschied zu den **alten Grenzgaengern** (vor dem 17. Juli 2023 angestellt) ist erheblich: alte Grenzgaenger innerhalb der 20-km-Zone bleiben dank der Uebergangsregelung nur in der Schweiz steuerpflichtig, waehrend neue Grenzgaenger innerhalb 20 km der konkurrierenden Besteuerung unterliegen (Schweiz behaelt 80 % als Vorauszahlung ein, Italien ergaenzt mit Steuergutschrift). Ueber 20 km kehren die neuen Grenzgaenger zur ausschliesslichen Besteuerung zurueck, aehnlich dem Regime der alten Grenzgaenger, was die italienische Erklaerung erheblich vereinfacht.',
 'Rechenbeispiel bei einem Bruttolohn von CHF 60\'000/Jahr (CHF 5\'000/Monat), alleinstehend, kinderlos: die Pflichtsozialabgaben (AHV/IV/EO/ALV ~6,25 %, BVG ~7-8 %, UVG ~1 %, insgesamt rund 14 %) reduzieren den Betrag um ~CHF 700/Monat und lassen eine Bemessungsgrundlage von ~CHF 4\'300. Die Tessiner Quellensteuer 2026 liegt fuer diesen Bereich (Tarif A0, alleinstehend) bei rund 9-11 %, also ~CHF 420-480/Monat. Das **monatliche Netto auf dem Konto** betraegt damit rund **CHF 3\'820-3\'880**, ohne weitere italienische Abzuege. Fuer exakte Werte verwende den obigen Rechner mit Wohngemeinde und Familienstand.',
 ],
 faqTitle: 'Wichtige FAQ',
 faq: [
 {
 q: 'Wer gilt als neuer Grenzgaenger ueber 20 km?',
 a: 'Wer ab dem 17. Juli 2023 eine grenzueberschreitende Beschaeftigung begonnen hat und in einer italienischen Gemeinde mehr als 20 km von der Grenze entfernt wohnt.',
 },
 {
 q: 'Ist es besser innerhalb oder ueber 20 km zu wohnen?',
 a: 'Das haengt vom konkreten Fall ab: ueber 20 km ist die Schweizer Besteuerung oft einfacher, innerhalb 20 km kann sich der Endsaldo in Italien aendern. Man sollte es konkret simulieren.',
 },
 {
 q: 'Reicht diese Seite fuer die Steuererklaerung aus?',
 a: 'Nein. Sie hilft bei Orientierung und Groessenordnung, ersetzt aber keine individuelle steuerliche Pruefung.',
 },
 ],
 caseSummary: 'Neuer Grenzgaenger, Wohnsitz ueber 20 km',
 labelGross: 'Bruttolohn',
 labelSocial: 'Sozialabgaben',
 labelTaxes: 'Steuern gesamt',
 labelNetAnnual: 'Netto jaehrlich',
 labelNetMonthly: 'Netto monatlich',
 labelEffRate: 'Effektiver Steuersatz',
 },
 fr: {
 badge: 'Regles fiscales 2026',
 title: 'Nouveaux frontaliers a plus de 20 km',
 subtitle: 'Cas pratiques, comparaison avec les residents a moins de 20 km et simulation immediate du net.',
 intro: 'Cette page explique concretement ce qui change si vous etes un nouveau frontalier, travaillez au Tessin et vivez dans une commune italienne a plus de 20 km de la frontiere. Vous trouverez ci-dessous trois cas deja calcules et une comparaison directe avec le scenario a moins de 20 km.',
 bullets: [
 'Au-dela de 20 km, l’impot reste integralement retenu en Suisse.',
 'En dessous de 20 km, la Suisse retient 80% et l’Italie taxe avec credit pour l’impot deja paye.',
 'La distance de residence change donc le cash-flow, la declaration et l’avantage net reel.',
 ],
 casesTitle: 'Cas pratiques deja calcules',
 compareTitle: 'Comparaison rapide: moins vs plus de 20 km',
 compareBody: 'Pour un meme nouveau frontalier celibataire avec CHF 80 000, la difference principale est l’endroit ou l’effet fiscal se produit: au-dela de 20 km il reste en Suisse, en dessous de 20 km il y a une imposition concurrente avec credit d’impot.',
 compareOver: 'Net mensuel au-dela de 20 km',
 compareWithin: 'Net mensuel dans les 20 km',
 compareDelta: 'Difference mensuelle en faveur du meilleur scenario',
 linksTitle: 'Outils utiles',
 links: [
 { label: 'Calculer votre cas', route: { activeTab: 'calculator', calcolatoreSubTab: 'calculator' } },
 { label: 'Baremes impot a la source Tessin 2026', route: { activeTab: 'fisco', fiscoSubTab: 'withholding-rates' } },
 { label: 'Comparaison net 2025 vs 2026 au-dela de 20 km', route: { activeTab: 'calculator', calcolatoreSubTab: 'calculator', seoLanding: 'net-comparison-2025-2026-over20km' } },
 { label: 'Guide declaration fiscale', route: { activeTab: 'fisco', fiscoSubTab: 'tax-return' } },
 ],
 editorialTitle: 'Comment calculer les impots du frontalier a plus de 20 km',
 editorialParagraphs: [
 'Pour les nouveaux frontaliers residant a plus de 20 km de la frontiere, l\'Accord 2020 (en vigueur depuis le 17 juillet 2023) introduit la regle de **l\'imposition exclusive en Suisse** : le revenu d\'activite salariee produit au Tessin est impose integralement et uniquement en Suisse via l\'impot a la source retenu sur le salaire. En Italie, ce revenu n\'est pas declare (sauf autres revenus italiens) et l\'imposition concurrente ne s\'applique pas.',
 'La difference avec les **anciens frontaliers** (embauches avant le 17 juillet 2023) est substantielle : les anciens frontaliers residant dans la bande des 20 km restent imposes uniquement en Suisse grace au regime transitoire, tandis que les nouveaux frontaliers dans les 20 km entrent dans l\'imposition concurrente (la Suisse retient 80 % en acompte, l\'Italie complete avec un credit d\'impot). Au-dela de 20 km, les nouveaux frontaliers retrouvent un regime d\'imposition exclusive similaire a celui des anciens, ce qui simplifie nettement la declaration italienne.',
 'Exemple chiffre sur un salaire brut de CHF 60\'000/an (CHF 5\'000/mois), celibataire sans enfant : les cotisations sociales obligatoires (AVS/AI/APG/AC ~6,25 %, LPP ~7-8 %, LAA ~1 %, soit environ 14 %) reduisent le salaire de ~CHF 700/mois, laissant une base imposable de ~CHF 4\'300. L\'impot a la source tessinois 2026 sur cette tranche (bareme A0, celibataire) est d\'environ 9-11 %, soit ~CHF 420-480/mois. Le **net mensuel en poche** se situe donc autour de **CHF 3\'820-3\'880**, sans prelevement italien supplementaire. Pour des chiffres precis adaptes a votre cas, utilisez le calculateur ci-dessus avec votre commune et composition familiale.',
 ],
 faqTitle: 'FAQ essentielles',
 faq: [
 {
 q: 'Qui est considere comme nouveau frontalier a plus de 20 km?',
 a: 'Toute personne ayant commence a travailler en Suisse a partir du 17 juillet 2023 et residant dans une commune italienne situee a plus de 20 km de la frontiere.',
 },
 {
 q: 'Vaut-il mieux vivre a moins ou a plus de 20 km?',
 a: 'Il n’y a pas de reponse unique: au-dela de 20 km la fiscalite suisse est souvent plus simple, tandis qu’en dessous de 20 km le solde final en Italie peut changer. Il faut le simuler sur votre revenu reel.',
 },
 {
 q: 'Cette page suffit-elle pour faire la declaration?',
 a: 'Non. C’est une page d’orientation pratique pour estimer le net. Une verification individuelle reste necessaire pour la declaration reelle.',
 },
 ],
 caseSummary: 'Nouveau frontalier, residence a plus de 20 km',
 labelGross: 'Salaire brut',
 labelSocial: 'Cotisations sociales',
 labelTaxes: 'Impots totaux',
 labelNetAnnual: 'Net annuel',
 labelNetMonthly: 'Net mensuel',
 labelEffRate: 'Taux effectif',
 },
};

const money = (value: number, locale: Locale, currency: 'CHF' | 'EUR') =>
 new Intl.NumberFormat(locale === 'de' ? 'de-CH' : locale === 'fr' ? 'fr-CH' : locale === 'en' ? 'en-CH' : 'it-CH', {
 style: 'currency',
 currency,
 maximumFractionDigits: 0,
 }).format(value);

const buildScenarioInputs = (annualIncomeCHF: number, distanceZone: SimulationInputs['distanceZone']): SimulationInputs => ({
 ...DEFAULT_INPUTS,
 annualIncomeCHF,
 distanceZone,
 frontierWorkerType: 'NEW',
 maritalStatus: 'SINGLE',
 familyMembers: 1,
 children: 0,
 spouseWorks: false,
 age: annualIncomeCHF >= 100000 ? 40 : 35,
});

const NewFrontierOver20KmHub: React.FC = () => {
 const [locale] = useLocale();
 const copy = COPY_BY_LOCALE[locale];

 const cases = useMemo(() => {
 const definitions: ScenarioCard[] = [
 { income: 60000, title: 'CHF 60.000', summary: copy.caseSummary },
 { income: 80000, title: 'CHF 80.000', summary: copy.caseSummary },
 { income: 100000, title: 'CHF 100.000', summary: copy.caseSummary },
 ];
 return definitions.map((item) => {
 const result = calculateSimulation(buildScenarioInputs(item.income, 'OVER_20KM'));
 return {
 ...item,
 result,
 };
 });
 }, [copy.caseSummary]);

 const comparison = useMemo(() => {
 const over20 = calculateSimulation(buildScenarioInputs(80000, 'OVER_20KM'));
 const within20 = calculateSimulation(buildScenarioInputs(80000, 'WITHIN_20KM'));
 return {
 over20,
 within20,
 delta: Math.abs(over20.itResident.netIncomeMonthly - within20.itResident.netIncomeMonthly),
 };
 }, []);

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
 <div
 key={bullet}
 className="rounded-2xl border border-edge bg-surface/90 p-4 text-sm leading-6 text-body"
 >
 {bullet}
 </div>
 ))}
 </div>
 </div>

 <div className="px-5 py-6 sm:px-7 sm:py-8 space-y-8">
 <div>
 <div className="flex items-center gap-2 text-sm font-bold text-heading">
 <Calculator className="w-4 h-4 text-info" />
 {copy.casesTitle}
 </div>
 <div className="mt-4 grid grid-cols-1 lg:grid-cols-3 gap-4">
 {cases.map(({ title, summary, result, income }) => (
 <article key={title} className="rounded-2xl border border-neutral-border bg-neutral-subtle p-4">
 <div className="text-xs font-semibold uppercase tracking-[0.16em] text-muted">
 {summary}
 </div>
 <h3 className="mt-2 text-lg font-bold font-display text-heading">{title}</h3>
 <div className="mt-4 space-y-2 text-sm">
 <div className="flex items-center justify-between gap-3">
 <span className="text-subtle">{copy.labelGross}</span>
 <span className="font-bold text-heading">{money(result.itResident.grossIncome, locale, 'CHF')}</span>
 </div>
 <div className="flex items-center justify-between gap-3">
 <span className="text-subtle">{copy.labelSocial}</span>
 <span className="font-bold text-heading">{money(result.itResident.socialContributions, locale, 'CHF')}</span>
 </div>
 <div className="flex items-center justify-between gap-3">
 <span className="text-subtle">{copy.labelTaxes}</span>
 <span className="font-bold text-heading">{money(result.itResident.taxes, locale, 'CHF')}</span>
 </div>
 <div className="mt-2 pt-2 border-t border-edge flex items-center justify-between gap-3">
 <span className="text-subtle">{copy.labelNetAnnual}</span>
 <span className="font-bold text-heading">{money(result.itResident.netIncomeAnnual, locale, 'CHF')}</span>
 </div>
 <div className="flex items-center justify-between gap-3">
 <span className="text-subtle">{copy.labelNetMonthly}</span>
 <span className="font-bold text-info">{money(result.itResident.netIncomeMonthly, locale, 'CHF')}</span>
 </div>
 <div className="flex items-center justify-between gap-3">
 <span className="text-subtle">{copy.labelEffRate}</span>
 <span className="font-bold text-heading">{result.itResident.details.effectiveRate.toFixed(1)}%</span>
 </div>
 </div>
 <a
 href={buildPath({ activeTab: 'calculator', calcolatoreSubTab: 'calculator', seoLanding: income === 60000 ? 'salary-60000-over20km' : income === 80000 ? 'salary-80000-over20km' : 'salary-100000-over20km' }, locale)}
 className="mt-4 inline-flex items-center gap-2 text-sm font-semibold text-info no-underline hover:underline"
 >
 {copy.links[0].label}
 <ArrowRight className="w-4 h-4" />
 </a>
 </article>
 ))}
 </div>
 </div>

 <div className="rounded-3xl border border-neutral-border bg-neutral-subtle p-5">
 <div className="flex items-center gap-2 text-sm font-bold text-heading">
 <Scale className="w-4 h-4 text-neutral" />
 {copy.compareTitle}
 </div>
 <p className="mt-3 text-sm leading-7 text-subtle">{copy.compareBody}</p>
 <div className="mt-4 grid grid-cols-1 md:grid-cols-3 gap-3">
 <div className="rounded-2xl bg-surface border border-edge p-4">
 <div className="text-sm text-muted">{copy.compareOver}</div>
 <div className="mt-2 text-xl font-bold text-heading">
 {money(comparison.over20.itResident.netIncomeMonthly, locale, 'CHF')}
 </div>
 </div>
 <div className="rounded-2xl bg-surface border border-edge p-4">
 <div className="text-sm text-muted">{copy.compareWithin}</div>
 <div className="mt-2 text-xl font-bold text-heading">
 {money(comparison.within20.itResident.netIncomeMonthly, locale, 'CHF')}
 </div>
 </div>
 <div className="rounded-2xl bg-info-strong text-on-accent p-4">
 <div className="text-sm text-on-accent">{copy.compareDelta}</div>
 <div className="mt-2 text-xl font-bold">
 {money(comparison.delta, locale, 'CHF')}
 </div>
 </div>
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
 __html: paragraph
 .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>'),
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

export default NewFrontierOver20KmHub;
