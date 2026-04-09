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
    <section className="mb-6 rounded-[28px] border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 shadow-sm overflow-hidden">
      <div className="px-5 py-6 sm:px-7 sm:py-8 bg-[radial-gradient(circle_at_top_right,_rgba(14,165,233,0.14),_transparent_38%),linear-gradient(180deg,rgba(248,250,252,1),rgba(255,255,255,0.92))] dark:bg-[radial-gradient(circle_at_top_right,_rgba(56,189,248,0.16),_transparent_32%),linear-gradient(180deg,rgba(15,23,42,0.96),rgba(2,6,23,0.98))]">
        <div className="inline-flex items-center gap-2 rounded-full border border-sky-200 dark:border-sky-800 bg-sky-50 dark:bg-sky-950/40 px-3 py-1 text-xs font-semibold text-sky-700 dark:text-sky-300">
          <Sparkles className="w-3.5 h-3.5" />
          {copy.badge}
        </div>
        <h2 className="mt-3 text-2xl sm:text-3xl font-bold tracking-tight text-slate-900 dark:text-white">
          {copy.title}
        </h2>
        <p className="mt-3 max-w-3xl text-sm sm:text-base leading-7 text-slate-600 dark:text-slate-300">
          {copy.subtitle}
        </p>
        <p className="mt-3 max-w-4xl text-sm leading-7 text-slate-600 dark:text-slate-300">
          {copy.intro}
        </p>
        <div className="mt-5 grid grid-cols-1 md:grid-cols-3 gap-3">
          {copy.bullets.map((bullet) => (
            <div
              key={bullet}
              className="rounded-2xl border border-slate-200/80 dark:border-slate-700 bg-white/90 dark:bg-slate-800/90 p-4 text-sm leading-6 text-slate-700 dark:text-slate-200"
            >
              {bullet}
            </div>
          ))}
        </div>
      </div>

      <div className="px-5 py-6 sm:px-7 sm:py-8 space-y-8">
        <div>
          <div className="flex items-center gap-2 text-sm font-bold text-slate-900 dark:text-white">
            <Calculator className="w-4 h-4 text-sky-600 dark:text-sky-400" />
            {copy.casesTitle}
          </div>
          <div className="mt-4 grid grid-cols-1 lg:grid-cols-3 gap-4">
            {cases.map(({ title, summary, result, income }) => (
              <article key={title} className="rounded-2xl border border-warm-200 dark:border-warm-800 bg-warm-50 dark:bg-warm-950 p-4">
                <div className="text-xs font-semibold uppercase tracking-[0.16em] text-slate-500 dark:text-slate-400">
                  {summary}
                </div>
                <h3 className="mt-2 text-lg font-bold text-slate-900 dark:text-white">{title}</h3>
                <div className="mt-4 space-y-2 text-sm">
                  <div className="flex items-center justify-between gap-3">
                    <span className="text-slate-600 dark:text-slate-300">{copy.labelGross}</span>
                    <span className="font-bold text-slate-900 dark:text-white">{money(result.itResident.grossIncome, locale, 'CHF')}</span>
                  </div>
                  <div className="flex items-center justify-between gap-3">
                    <span className="text-slate-600 dark:text-slate-300">{copy.labelSocial}</span>
                    <span className="font-bold text-slate-900 dark:text-white">{money(result.itResident.socialContributions, locale, 'CHF')}</span>
                  </div>
                  <div className="flex items-center justify-between gap-3">
                    <span className="text-slate-600 dark:text-slate-300">{copy.labelTaxes}</span>
                    <span className="font-bold text-slate-900 dark:text-white">{money(result.itResident.taxes, locale, 'CHF')}</span>
                  </div>
                  <div className="mt-2 pt-2 border-t border-slate-200 dark:border-slate-700 flex items-center justify-between gap-3">
                    <span className="text-slate-600 dark:text-slate-300">{copy.labelNetAnnual}</span>
                    <span className="font-bold text-slate-900 dark:text-white">{money(result.itResident.netIncomeAnnual, locale, 'CHF')}</span>
                  </div>
                  <div className="flex items-center justify-between gap-3">
                    <span className="text-slate-600 dark:text-slate-300">{copy.labelNetMonthly}</span>
                    <span className="font-bold text-sky-700 dark:text-sky-300">{money(result.itResident.netIncomeMonthly, locale, 'CHF')}</span>
                  </div>
                  <div className="flex items-center justify-between gap-3">
                    <span className="text-slate-600 dark:text-slate-300">{copy.labelEffRate}</span>
                    <span className="font-bold text-slate-900 dark:text-white">{result.itResident.details.effectiveRate.toFixed(1)}%</span>
                  </div>
                </div>
                <a
                  href={buildPath({ activeTab: 'calculator', calcolatoreSubTab: 'calculator', seoLanding: income === 60000 ? 'salary-60000-over20km' : income === 80000 ? 'salary-80000-over20km' : 'salary-100000-over20km' }, locale)}
                  className="mt-4 inline-flex items-center gap-2 text-sm font-semibold text-sky-700 dark:text-sky-300 no-underline hover:underline"
                >
                  {copy.links[0].label}
                  <ArrowRight className="w-4 h-4" />
                </a>
              </article>
            ))}
          </div>
        </div>

        <div className="rounded-3xl border border-warm-200 dark:border-warm-800 bg-warm-50 dark:bg-warm-950 p-5">
          <div className="flex items-center gap-2 text-sm font-bold text-slate-900 dark:text-white">
            <Scale className="w-4 h-4 text-warm-600 dark:text-warm-400" />
            {copy.compareTitle}
          </div>
          <p className="mt-3 text-sm leading-7 text-slate-600 dark:text-slate-300">{copy.compareBody}</p>
          <div className="mt-4 grid grid-cols-1 md:grid-cols-3 gap-3">
            <div className="rounded-2xl bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 p-4">
              <div className="text-sm text-slate-500 dark:text-slate-400">{copy.compareOver}</div>
              <div className="mt-2 text-xl font-bold text-slate-900 dark:text-white">
                {money(comparison.over20.itResident.netIncomeMonthly, locale, 'CHF')}
              </div>
            </div>
            <div className="rounded-2xl bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 p-4">
              <div className="text-sm text-slate-500 dark:text-slate-400">{copy.compareWithin}</div>
              <div className="mt-2 text-xl font-bold text-slate-900 dark:text-white">
                {money(comparison.within20.itResident.netIncomeMonthly, locale, 'CHF')}
              </div>
            </div>
            <div className="rounded-2xl bg-sky-600 text-white p-4">
              <div className="text-sm text-sky-100">{copy.compareDelta}</div>
              <div className="mt-2 text-xl font-bold">
                {money(comparison.delta, locale, 'CHF')}
              </div>
            </div>
          </div>
        </div>

        <div>
          <div className="flex items-center gap-2 text-sm font-bold text-slate-900 dark:text-white">
            <MapPinned className="w-4 h-4 text-emerald-600 dark:text-emerald-300" />
            {copy.linksTitle}
          </div>
          <div className="mt-4 grid grid-cols-1 md:grid-cols-2 gap-3">
            {copy.links.map((link) => (
              <a
                key={link.label}
                href={buildPath(link.route, locale)}
                className="group rounded-2xl border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 p-4 no-underline hover:border-sky-300 dark:hover:border-sky-600 transition-colors"
              >
                <div className="flex items-center justify-between gap-3">
                  <span className="text-sm font-semibold text-slate-900 dark:text-white">{link.label}</span>
                  <ArrowRight className="w-4 h-4 text-slate-500 group-hover:text-sky-600 dark:group-hover:text-sky-300 transition-colors" />
                </div>
              </a>
            ))}
          </div>
        </div>

        <div>
          <h3 className="text-sm font-bold text-slate-900 dark:text-white">{copy.faqTitle}</h3>
          <div className="mt-4 space-y-3">
            {copy.faq.map((item) => (
              <div key={item.q} className="rounded-2xl border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 p-4">
                <div className="text-sm font-semibold text-slate-900 dark:text-white">{item.q}</div>
                <p className="mt-2 text-sm leading-7 text-slate-600 dark:text-slate-300">{item.a}</p>
              </div>
            ))}
          </div>
        </div>
      </div>
    </section>
  );
};

export default NewFrontierOver20KmHub;
