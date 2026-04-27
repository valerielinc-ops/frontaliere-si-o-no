/**
 * Salary Hub SEO — Evergreen blog articles.
 *
 * Generates 8 long-form articles in 4 locales (32 pages) that serve as
 * content hubs with cross-links to salary scenario pages.
 * Each article uses the blog 3-column layout with 14 AdSense slots.
 *
 * These are standalone static pages — they don't go through the SPA
 * blog system, but use the same ad layout and visual style.
 */

import type { SimulationResult } from '../types';
import { AD_CLIENT, AD_SLOTS } from '../services/adsenseSlots';
import { BASE_URL } from './constants';
import { buildFullPath, LOCALE_CALC_PREFIX, type SalaryHubScenario } from './salaryHubScenarios';
import { buildSeoPageHtml } from './shared/seoPageShell';
import { renderHreflangTags } from './shared/hreflang';

type Locale = 'it' | 'en' | 'de' | 'fr';

const fmtCHF = (n: number): string => Math.round(n).toLocaleString('de-CH');

function adSlotHtml(slotKey: keyof typeof AD_SLOTS): string {
  const cfg = AD_SLOTS[slotKey];
  const attrs = [
    `class="adsbygoogle"`,
    `style="display:block;min-height:${cfg.placeholderMinHeight}px"`,
    `data-ad-client="${AD_CLIENT}"`,
    `data-ad-slot="${cfg.slot}"`,
    `data-ad-format="${cfg.format}"`,
  ];
  if ('layout' in cfg && cfg.layout) attrs.push(`data-ad-layout="${cfg.layout}"`);
  if ('layoutKey' in cfg && cfg.layoutKey) attrs.push(`data-ad-layout-key="${cfg.layoutKey}"`);
  if (cfg.fullWidthResponsive) attrs.push(`data-full-width-responsive="true"`);
  return `<ins ${attrs.join(' ')}></ins>`;
}

// ── Article definition ──────────────────────────────────────────

export interface EvergreenArticle {
  id: string;
  slugs: Record<Locale, string>;
  titles: Record<Locale, string>;
  descriptions: Record<Locale, string>;
  /** Generate HTML body given pre-computed scenario data */
  body: (locale: Locale, scenarioData: ScenarioDataMap) => string;
  faqItems: (locale: Locale, scenarioData: ScenarioDataMap) => Array<{ q: string; a: string }>;
  /** Which salary hub scenarios to cross-link */
  relatedScenarioFilter: (s: SalaryHubScenario) => boolean;
}

export interface ScenarioDataMap {
  scenarios: SalaryHubScenario[];
  results: Map<SalaryHubScenario, SimulationResult>;
}

/** URL path prefix per locale for articles. */
const ARTICLE_PREFIX: Record<Locale, string> = {
  it: '/guida-frontaliere',
  en: '/en/cross-border-guide',
  de: '/de/grenzgaenger-ratgeber',
  fr: '/fr/guide-frontalier',
};

function articleUrl(article: EvergreenArticle, locale: Locale): string {
  return `${ARTICLE_PREFIX[locale]}/${article.slugs[locale]}/`;
}

function scenarioLink(s: SalaryHubScenario, locale: Locale): string {
  const path = buildFullPath(s, locale);
  return `<a href="${path}">CHF ${fmtCHF(s.salary)}</a>`;
}

function scenarioGrid(scenarios: SalaryHubScenario[], locale: Locale): string {
  const cards = scenarios.slice(0, 8).map(s => {
    const path = buildFullPath(s, locale);
    const desc = s.frontierType === 'OLD' ? (locale === 'it' ? 'Vecchio' : 'Old') : (locale === 'it' ? 'Nuovo' : 'New');
    const family = s.maritalStatus === 'MARRIED' ? (locale === 'it' ? 'Sposato' : 'Married') : (locale === 'it' ? 'Single' : 'Single');
    return `<a href="${path}" class="related-card"><strong>CHF ${fmtCHF(s.salary)}</strong><br>${desc}, ${family}${s.children > 0 ? `, ${s.children} ${locale === 'it' ? 'figli' : 'children'}` : ''}</a>`;
  });
  return `<div class="related-grid">${cards.join('\n')}</div>`;
}

// ── Article definitions ─────────────────────────────────────────

function getNetForScenario(data: ScenarioDataMap, salary: number, type: 'NEW' | 'OLD', marital: 'SINGLE' | 'MARRIED', children: number): string {
  const s = data.scenarios.find(sc =>
    sc.salary === salary && sc.frontierType === type && sc.maritalStatus === marital && sc.children === children
  );
  if (!s) return '—';
  const r = data.results.get(s);
  if (!r) return '—';
  return fmtCHF(r.itResident.netIncomeAnnual);
}

export const EVERGREEN_ARTICLES: EvergreenArticle[] = [
  // ── Article 1: Complete guide ──────────────────────────────────
  {
    id: 'guida-calcolo-stipendio-2026',
    slugs: {
      it: 'guida-completa-calcolo-stipendio-frontaliere-2026',
      en: 'complete-guide-crossborder-salary-calculation-2026',
      de: 'kompletter-leitfaden-gehaltsberechnung-grenzgaenger-2026',
      fr: 'guide-complet-calcul-salaire-frontalier-2026',
    },
    titles: {
      it: 'Stipendio netto frontaliere 2026: guida completa al calcolo',
      en: 'Cross-border worker net salary 2026: complete calculation guide',
      de: 'Nettogehalt Grenzgänger 2026: Kompletter Berechnungsleitfaden',
      fr: 'Salaire net frontalier 2026: guide complet du calcul',
    },
    descriptions: {
      it: 'Come calcolare lo stipendio netto di un frontaliere in Ticino nel 2026. Tabelle fiscali, contributi sociali, IRPEF e confronto tra regimi vecchio e nuovo.',
      en: 'How to calculate a cross-border worker\'s net salary in Ticino in 2026. Tax tables, social contributions, IRPEF and comparison between old and new regimes.',
      de: 'So berechnen Sie das Nettogehalt eines Grenzgängers im Tessin 2026. Steuertabellen, Sozialabgaben, IRPEF und Vergleich zwischen altem und neuem Regime.',
      fr: 'Comment calculer le salaire net d\'un frontalier au Tessin en 2026. Barèmes fiscaux, cotisations sociales, IRPEF et comparaison entre ancien et nouveau régime.',
    },
    body: (locale, data) => {
      const net60 = getNetForScenario(data, 60_000, 'NEW', 'SINGLE', 0);
      const net80 = getNetForScenario(data, 80_000, 'NEW', 'SINGLE', 0);
      const net100 = getNetForScenario(data, 100_000, 'NEW', 'SINGLE', 0);
      if (locale === 'it') return `
        <p>Lo stipendio netto di un frontaliere in Ticino dipende da cinque variabili principali: il reddito lordo annuo, lo status di vecchio o nuovo frontaliere, lo stato civile, il numero di figli a carico e la distanza del domicilio dal confine svizzero. In questa guida analizziamo ogni fattore e forniamo esempi concreti con dati calcolati per il 2026.</p>
        <h2>Come funziona la tassazione dei frontalieri</h2>
        <p>I frontalieri in Ticino sono soggetti all'imposta alla fonte, calcolata direttamente sulla busta paga secondo le tabelle cantonali (A per single, B per sposati con coniuge non lavoratore, C per sposati con coniuge lavoratore, H per genitori single). L'aliquota è progressiva e varia in base al reddito e alla situazione familiare.</p>
        <p>Per il 2026, un frontaliere single con CHF 60'000 lordi percepisce circa CHF ${net60} netti. Con CHF 80'000 il netto sale a circa CHF ${net80}, mentre con CHF 100'000 raggiunge circa CHF ${net100}.</p>
        <h2>Contributi sociali obbligatori</h2>
        <p>Prima dell'imposta alla fonte, il datore di lavoro trattiene i contributi sociali obbligatori: AVS/AI/IPG (5,3%), assicurazione disoccupazione AD (1,1%), infortuni LAINF (0,7%), indennità giornaliera malattia IJM (0,8%) e previdenza professionale LPP (dal 3,5% al 9% in base all'età). Questi contributi riducono il reddito imponibile.</p>
        <h2>Il regime dei nuovi frontalieri (post-2024)</h2>
        <p>Dal 2024 i nuovi frontalieri sono soggetti a tassazione concorrente: pagano l'imposta alla fonte in Svizzera (ridotta all'80%) più l'IRPEF in Italia sul reddito eccedente la franchigia di EUR 10'000. Questo regime si applica automaticamente a chi ha iniziato a lavorare come frontaliere dopo il 17 luglio 2023.</p>
        <h2>Tabelle di esempio per fasce di reddito</h2>
        <p>Ecco una panoramica del netto annuo per le fasce di reddito più comuni tra i frontalieri ticinesi:</p>`;
      return `
        <p>A cross-border worker's net salary in Ticino depends on five main variables: gross annual income, old or new frontier status, marital status, number of dependent children, and distance from the Swiss border. This guide analyzes each factor with calculated examples for 2026.</p>
        <h2>How cross-border taxation works</h2>
        <p>Cross-border workers in Ticino are subject to withholding tax, calculated directly on the payslip according to cantonal tables (A for single, B for married with non-working spouse, C for married with working spouse, H for single parents). The rate is progressive and varies based on income and family situation.</p>
        <p>For 2026, a single cross-border worker earning CHF 60,000 gross receives approximately CHF ${net60} net. At CHF 80,000 the net rises to approximately CHF ${net80}, while at CHF 100,000 it reaches approximately CHF ${net100}.</p>`;
    },
    faqItems: (locale, data) => {
      const net80 = getNetForScenario(data, 80_000, 'NEW', 'SINGLE', 0);
      if (locale === 'it') return [
        { q: 'Quanto guadagna netto un frontaliere con CHF 80\'000 lordi?', a: `Un frontaliere single con CHF 80'000 lordi annui percepisce circa CHF ${net80} netti all'anno nel 2026.` },
        { q: 'Quale tabella fiscale si applica ai frontalieri in Ticino?', a: 'Si applica la tabella A per i single, B per i coniugati con coniuge non lavoratore, C per coniugati con coniuge lavoratore, e H per i genitori single.' },
      ];
      return [
        { q: 'How much does a cross-border worker earn net with CHF 80,000 gross?', a: `A single cross-border worker with CHF 80,000 gross annual income earns approximately CHF ${net80} net per year in 2026.` },
        { q: 'Which tax table applies to cross-border workers in Ticino?', a: 'Table A applies to single workers, B for married with non-working spouse, C for married with working spouse, and H for single parents.' },
      ];
    },
    relatedScenarioFilter: (s) => s.maritalStatus === 'SINGLE' && s.children === 0 && s.frontierType === 'NEW' && s.distanceZone === 'WITHIN_20KM',
  },

  // ── Article 2: Old vs New frontier comparison ──────────────────
  {
    id: 'confronto-vecchio-nuovo-frontaliere',
    slugs: {
      it: 'nuovo-vs-vecchio-frontaliere-differenze-fiscali',
      en: 'new-vs-old-crossborder-worker-tax-differences',
      de: 'neuer-vs-alter-grenzgaenger-steuerliche-unterschiede',
      fr: 'nouveau-vs-ancien-frontalier-differences-fiscales',
    },
    titles: {
      it: 'Nuovo vs vecchio frontaliere: differenze fiscali e quale conviene',
      en: 'New vs old cross-border worker: tax differences explained',
      de: 'Neuer vs alter Grenzgänger: Steuerliche Unterschiede erklärt',
      fr: 'Nouveau vs ancien frontalier: différences fiscales expliquées',
    },
    descriptions: {
      it: 'Confronto dettagliato tra il regime fiscale dei vecchi frontalieri (pre-2024) e dei nuovi frontalieri (2024+). Quando conviene uno o l\'altro? Simulazioni reali.',
      en: 'Detailed comparison between old (pre-2024) and new (2024+) cross-border worker tax regimes. Which is better? Real simulations.',
      de: 'Detaillierter Vergleich zwischen dem alten (vor 2024) und neuen (2024+) Grenzgänger-Steuerregime. Was ist besser? Echte Simulationen.',
      fr: 'Comparaison détaillée entre l\'ancien (pré-2024) et le nouveau (2024+) régime fiscal frontalier. Lequel est le plus avantageux? Simulations réelles.',
    },
    body: (locale, data) => {
      const oldNet80 = getNetForScenario(data, 80_000, 'OLD', 'SINGLE', 0);
      const newNet80 = getNetForScenario(data, 80_000, 'NEW', 'SINGLE', 0);
      if (locale === 'it') return `
        <p>La distinzione tra vecchi e nuovi frontalieri è il fattore che ha il maggior impatto sullo stipendio netto. Con il nuovo accordo fiscale Italia-Svizzera entrato in vigore nel 2024, chi ha iniziato a lavorare come frontaliere dopo il 17 luglio 2023 è soggetto a un regime di tassazione concorrente completamente diverso da quello dei "vecchi" frontalieri.</p>
        <h2>Il regime dei vecchi frontalieri</h2>
        <p>I vecchi frontalieri pagano solo l'imposta alla fonte in Svizzera. Non devono dichiarare il reddito svizzero in Italia (eccetto per il monitoraggio fiscale). Questo regime è più semplice e, per redditi medio-alti, spesso più vantaggioso. Con CHF 80'000 lordi, un vecchio frontaliere single percepisce circa CHF ${oldNet80} netti annui.</p>
        <h2>Il regime dei nuovi frontalieri</h2>
        <p>I nuovi frontalieri pagano l'imposta alla fonte ridotta all'80% in Svizzera, più l'IRPEF in Italia sul reddito eccedente la franchigia di EUR 10'000. Ricevono un credito d'imposta per le tasse pagate in Svizzera. Con CHF 80'000 lordi, un nuovo frontaliere single percepisce circa CHF ${newNet80} netti annui.</p>
        <h2>Quando conviene essere "nuovo" frontaliere?</h2>
        <p>Per redditi bassi (sotto CHF 50'000) la differenza è minima grazie alla franchigia di EUR 10'000. Per redditi alti (sopra CHF 100'000) il vecchio regime è quasi sempre più vantaggioso a causa della progressività dell'IRPEF italiana. La scelta non è tuttavia volontaria: dipende dalla data di inizio dell'attività frontaliera.</p>`;
      return `
        <p>The distinction between old and new cross-border workers is the single biggest factor affecting net salary. With the new Italy-Switzerland tax agreement that came into force in 2024, those who started working as cross-border commuters after July 17, 2023 are subject to an entirely different concurrent taxation regime.</p>
        <h2>The old cross-border worker regime</h2>
        <p>Old cross-border workers pay only withholding tax in Switzerland. They don't need to declare Swiss income in Italy (except for tax monitoring). This regime is simpler and, for medium-high incomes, often more advantageous. With CHF 80,000 gross, an old single cross-border worker earns approximately CHF ${oldNet80} net per year.</p>
        <h2>The new cross-border worker regime</h2>
        <p>New cross-border workers pay reduced withholding tax (80%) in Switzerland, plus IRPEF in Italy on income exceeding the EUR 10,000 allowance. They receive a tax credit for taxes paid in Switzerland. With CHF 80,000 gross, a new single cross-border worker earns approximately CHF ${newNet80} net per year.</p>`;
    },
    faqItems: (locale, _data) => {
      if (locale === 'it') return [
        { q: 'Chi è considerato "vecchio" frontaliere?', a: 'È considerato vecchio frontaliere chi lavorava come frontaliere prima del 17 luglio 2023 e ha continuato senza interruzioni significative.' },
        { q: 'Posso scegliere quale regime applicare?', a: 'No, il regime dipende dalla data di inizio dell\'attività frontaliera. Non è una scelta volontaria.' },
      ];
      return [
        { q: 'Who is considered an "old" cross-border worker?', a: 'Those who were working as cross-border commuters before July 17, 2023 and continued without significant interruptions.' },
        { q: 'Can I choose which regime applies?', a: 'No, the regime depends on when you started cross-border work. It is not a voluntary choice.' },
      ];
    },
    relatedScenarioFilter: (s) => s.salary === 80_000 && s.children === 0 && s.maritalStatus === 'SINGLE',
  },

  // ── Article 3: Tax tables explained ──────────────────────────
  {
    id: 'tabelle-imposta-fonte-ticino',
    slugs: {
      it: 'imposta-alla-fonte-ticino-tabelle-a-b-c-h',
      en: 'withholding-tax-ticino-tables-a-b-c-h',
      de: 'quellensteuer-tessin-tabellen-a-b-c-h',
      fr: 'impot-source-tessin-baremes-a-b-c-h',
    },
    titles: {
      it: 'Imposta alla fonte Ticino 2026: tabelle A, B, C, H spiegate',
      en: 'Ticino withholding tax 2026: tables A, B, C, H explained',
      de: 'Quellensteuer Tessin 2026: Tabellen A, B, C, H erklärt',
      fr: 'Impôt à la source Tessin 2026: barèmes A, B, C, H expliqués',
    },
    descriptions: {
      it: 'Guida alle tabelle fiscali dell\'imposta alla fonte in Ticino: tabella A (single), B (coniugato), C (coniugato con coniuge lavoratore), H (genitori single). Esempi pratici 2026.',
      en: 'Guide to Ticino withholding tax tables: table A (single), B (married), C (married working spouse), H (single parents). Practical 2026 examples.',
      de: 'Leitfaden zu den Quellensteuertabellen im Tessin: Tabelle A (ledig), B (verheiratet), C (verheiratet mit arbeitendem Ehepartner), H (alleinerziehend). Praktische Beispiele 2026.',
      fr: 'Guide des barèmes de l\'impôt à la source au Tessin: barème A (célibataire), B (marié), C (marié conjoint actif), H (parent seul). Exemples pratiques 2026.',
    },
    body: (locale, data) => {
      const singleNet80 = getNetForScenario(data, 80_000, 'NEW', 'SINGLE', 0);
      const marriedNet80 = getNetForScenario(data, 80_000, 'NEW', 'MARRIED', 0);
      if (locale === 'it') return `
        <p>L'imposta alla fonte è il principale prelievo fiscale che ogni frontaliere in Ticino trova sulla busta paga. Viene calcolata dal datore di lavoro secondo tabelle cantonali che tengono conto dello stato civile, del numero di figli e del reddito annuo. Comprendere quale tabella si applica è fondamentale per prevedere il proprio stipendio netto.</p>
        <h2>Tabella A — Lavoratori single senza figli</h2>
        <p>La tabella A si applica ai lavoratori single senza figli a carico. È la tabella con le aliquote più alte per redditi medio-bassi. Con CHF 80'000 lordi, un frontaliere single con tabella A percepisce circa CHF ${singleNet80} netti.</p>
        <h2>Tabella B — Coniugati con coniuge non lavoratore</h2>
        <p>La tabella B si applica ai lavoratori sposati il cui coniuge non ha un reddito proprio. Le aliquote sono sensibilmente più basse della tabella A, soprattutto per redditi medi. Con CHF 80'000 lordi in tabella B, il netto annuo sale a circa CHF ${marriedNet80}.</p>
        <h2>Tabella C — Coniugati con coniuge lavoratore</h2>
        <p>La tabella C si applica quando entrambi i coniugi lavorano. Le aliquote sono simili alla tabella A ma tengono conto del doppio reddito familiare. In pratica, l'aliquota è leggermente superiore alla tabella B.</p>
        <h2>Tabella H — Genitori single</h2>
        <p>La tabella H si applica ai genitori single con figli a carico. Le aliquote sono intermedie tra A e B, riconoscendo il carico familiare senza il beneficio del matrimonio.</p>`;
      return `
        <p>Withholding tax is the main tax deduction that every cross-border worker in Ticino sees on their payslip. It is calculated by the employer according to cantonal tables that take into account marital status, number of children, and annual income.</p>
        <h2>Table A — Single workers without children</h2>
        <p>Table A applies to single workers without dependent children. It has the highest rates for low-medium incomes. With CHF 80,000 gross, a single cross-border worker under table A earns approximately CHF ${singleNet80} net.</p>
        <h2>Table B — Married with non-working spouse</h2>
        <p>Table B applies to married workers whose spouse has no income. Rates are significantly lower than table A, especially for medium incomes. With CHF 80,000 gross under table B, annual net rises to approximately CHF ${marriedNet80}.</p>`;
    },
    faqItems: (locale, _data) => {
      if (locale === 'it') return [
        { q: 'Come faccio a sapere quale tabella fiscale si applica a me?', a: 'La tabella dipende dal tuo stato civile: A per single, B per sposato con coniuge non lavoratore, C per sposato con coniuge lavoratore, H per genitore single. Il datore di lavoro la applica automaticamente.' },
        { q: 'Posso passare da tabella A a tabella B?', a: 'Sì, se ti sposi e il tuo coniuge non lavora, passi automaticamente dalla tabella A alla B. Devi comunicare il cambio di stato civile al datore di lavoro.' },
      ];
      return [
        { q: 'How do I know which tax table applies to me?', a: 'The table depends on your marital status: A for single, B for married with non-working spouse, C for married with working spouse, H for single parent. Your employer applies it automatically.' },
        { q: 'Can I switch from table A to table B?', a: 'Yes, if you get married and your spouse doesn\'t work, you automatically switch from table A to B. You need to notify your employer of the change.' },
      ];
    },
    relatedScenarioFilter: (s) => s.salary === 80_000 && s.frontierType === 'NEW',
  },

  // ── Article 4: Children impact ──────────────────────────────
  {
    id: 'impatto-figli-stipendio-frontaliere',
    slugs: {
      it: 'quanto-incidono-figli-stipendio-netto-frontaliere',
      en: 'how-children-affect-crossborder-worker-net-salary',
      de: 'wie-kinder-nettogehalt-grenzgaenger-beeinflussen',
      fr: 'impact-enfants-salaire-net-frontalier',
    },
    titles: {
      it: 'Quanto incidono i figli sullo stipendio netto di un frontaliere?',
      en: 'How do children affect a cross-border worker\'s net salary?',
      de: 'Wie beeinflussen Kinder das Nettogehalt eines Grenzgängers?',
      fr: 'Quel est l\'impact des enfants sur le salaire net d\'un frontalier?',
    },
    descriptions: {
      it: 'Analisi dell\'impatto dei figli sullo stipendio netto: assegni familiari, deduzioni fiscali e tabelle diverse. Confronto 0, 1, 2 e 3 figli con simulazioni reali.',
      en: 'Analysis of children\'s impact on net salary: family allowances, tax deductions and different tables. Comparison of 0, 1, 2 and 3 children with real simulations.',
      de: 'Analyse der Auswirkung von Kindern auf das Nettogehalt: Kinderzulagen, Steuerabzüge und verschiedene Tabellen. Vergleich von 0, 1, 2 und 3 Kindern.',
      fr: 'Analyse de l\'impact des enfants sur le salaire net: allocations familiales, déductions fiscales et barèmes différents. Comparaison avec 0, 1, 2 et 3 enfants.',
    },
    body: (locale, data) => {
      const net0 = getNetForScenario(data, 80_000, 'NEW', 'MARRIED', 0);
      const net1 = getNetForScenario(data, 80_000, 'NEW', 'MARRIED', 1);
      const net2 = getNetForScenario(data, 80_000, 'NEW', 'MARRIED', 2);
      const net3 = getNetForScenario(data, 80_000, 'NEW', 'MARRIED', 3);
      if (locale === 'it') return `
        <p>Per un frontaliere sposato, il numero di figli a carico influisce sullo stipendio netto in tre modi: modifica l'aliquota dell'imposta alla fonte (deduzioni per figli nella tabella B/C), determina il diritto agli assegni familiari svizzeri (CHF 250/mese per figlio), e in Italia consente ulteriori detrazioni IRPEF per carichi familiari.</p>
        <h2>Assegni familiari in Ticino</h2>
        <p>In Canton Ticino, ogni figlio a carico dà diritto a un assegno familiare di CHF 250 al mese (CHF 3'000 all'anno). Questo assegno è esente da imposta alla fonte e si aggiunge direttamente allo stipendio netto. Per 2 figli l'assegno annuo è di CHF 6'000, per 3 figli CHF 9'000.</p>
        <h2>Confronto netto con CHF 80'000 lordi (sposato)</h2>
        <p>Ecco come cambia il netto annuo per un frontaliere sposato con CHF 80'000 lordi in base al numero di figli:</p>
        <ul>
          <li><strong>0 figli:</strong> CHF ${net0} netti/anno</li>
          <li><strong>1 figlio:</strong> CHF ${net1} netti/anno</li>
          <li><strong>2 figli:</strong> CHF ${net2} netti/anno</li>
          <li><strong>3 figli:</strong> CHF ${net3} netti/anno</li>
        </ul>
        <h2>L'effetto combinato su tutti i redditi</h2>
        <p>L'impatto dei figli è relativamente costante in valore assoluto (gli assegni sono fissi), ma diventa percentualmente più significativo per redditi bassi. Per un frontaliere con CHF 40'000 lordi, 2 figli rappresentano un incremento netto molto più rilevante in percentuale rispetto a chi guadagna CHF 150'000.</p>`;
      return `
        <p>For a married cross-border worker, the number of dependent children affects net salary in three ways: it modifies the withholding tax rate (child deductions in table B/C), determines eligibility for Swiss family allowances (CHF 250/month per child), and in Italy allows additional IRPEF deductions for dependents.</p>
        <h2>Family allowances in Ticino</h2>
        <p>In Canton Ticino, each dependent child entitles the worker to a family allowance of CHF 250 per month (CHF 3,000 per year). This allowance is exempt from withholding tax and adds directly to net salary.</p>
        <h2>Net comparison with CHF 80,000 gross (married)</h2>
        <ul>
          <li><strong>0 children:</strong> CHF ${net0} net/year</li>
          <li><strong>1 child:</strong> CHF ${net1} net/year</li>
          <li><strong>2 children:</strong> CHF ${net2} net/year</li>
          <li><strong>3 children:</strong> CHF ${net3} net/year</li>
        </ul>`;
    },
    faqItems: (locale, _data) => {
      if (locale === 'it') return [
        { q: 'Quanto valgono gli assegni familiari in Ticino?', a: 'In Canton Ticino gli assegni familiari sono di CHF 250 al mese per figlio (CHF 3\'000 all\'anno). Sono esenti dall\'imposta alla fonte.' },
        { q: 'I figli influiscono sulla tabella fiscale?', a: 'Sì, il numero di figli modifica le deduzioni all\'interno della tabella B o C, riducendo l\'aliquota effettiva dell\'imposta alla fonte.' },
      ];
      return [
        { q: 'How much are family allowances in Ticino?', a: 'In Canton Ticino, family allowances are CHF 250 per month per child (CHF 3,000 per year). They are exempt from withholding tax.' },
        { q: 'Do children affect the tax table?', a: 'Yes, the number of children modifies the deductions within table B or C, reducing the effective withholding tax rate.' },
      ];
    },
    relatedScenarioFilter: (s) => s.salary === 80_000 && s.maritalStatus === 'MARRIED' && s.frontierType === 'NEW',
  },

  // ── Article 5: Distance zones ──────────────────────────────
  {
    id: 'distanza-confine-20km-frontaliere',
    slugs: {
      it: 'frontaliere-entro-o-oltre-20km-cosa-cambia',
      en: 'crossborder-within-or-over-20km-what-changes',
      de: 'grenzgaenger-innerhalb-oder-ueber-20km-was-aendert-sich',
      fr: 'frontalier-moins-ou-plus-20km-ce-qui-change',
    },
    titles: {
      it: 'Frontaliere entro o oltre 20 km: cosa cambia davvero',
      en: 'Cross-border within or over 20 km: what really changes',
      de: 'Grenzgänger innerhalb oder über 20 km: Was sich wirklich ändert',
      fr: 'Frontalier à moins ou plus de 20 km: ce qui change vraiment',
    },
    descriptions: {
      it: 'La distanza del domicilio dal confine svizzero (entro o oltre 20 km) influisce sulla tassazione dei nuovi frontalieri. Ecco come e quando conta.',
      en: 'The distance of your home from the Swiss border (within or over 20 km) affects new cross-border worker taxation. Here\'s how and when it matters.',
      de: 'Die Entfernung des Wohnorts von der Schweizer Grenze (innerhalb oder über 20 km) beeinflusst die Besteuerung neuer Grenzgänger.',
      fr: 'La distance du domicile par rapport à la frontière suisse (moins ou plus de 20 km) affecte l\'imposition des nouveaux frontaliers.',
    },
    body: (locale, data) => {
      const within80 = getNetForScenario(data, 80_000, 'NEW', 'SINGLE', 0);
      const findOver = data.scenarios.find(sc => sc.salary === 80_000 && sc.frontierType === 'NEW' && sc.maritalStatus === 'SINGLE' && sc.children === 0 && sc.distanceZone === 'OVER_20KM');
      const over80 = findOver ? fmtCHF(data.results.get(findOver)?.itResident.netIncomeAnnual ?? 0) : '—';
      if (locale === 'it') return `
        <p>Con il nuovo accordo fiscale Italia-Svizzera del 2024, la distanza del domicilio dal confine svizzero è diventata un fattore determinante per i nuovi frontalieri. La soglia dei 20 km traccia una linea netta tra due trattamenti fiscali diversi.</p>
        <h2>Frontalieri entro 20 km dal confine</h2>
        <p>I nuovi frontalieri che risiedono entro 20 km dal confine svizzero beneficiano del regime standard: imposta alla fonte ridotta all'80% in Svizzera e tassazione concorrente IRPEF in Italia con franchigia di EUR 10'000 e credito d'imposta proporzionale. Con CHF 80'000 lordi, il netto annuo è circa CHF ${within80}.</p>
        <h2>Frontalieri oltre 20 km dal confine</h2>
        <p>Chi risiede oltre 20 km dal confine non è tecnicamente un "frontaliere" ai fini fiscali dell'accordo bilaterale. Questo comporta una tassazione diversa: l'imposta alla fonte viene comunque trattenuta, ma l'Italia tassa l'intero reddito senza franchigia. Con CHF 80'000 lordi e residenza oltre 20 km, il netto scende a circa CHF ${over80}.</p>
        <h2>Come si misura la distanza</h2>
        <p>La distanza si misura in linea d'aria tra il comune di residenza in Italia e il confine italo-svizzero più vicino. Non conta la distanza dal luogo di lavoro né il percorso stradale. I comuni interessati sono elencati in un elenco ufficiale concordato tra i due stati.</p>`;
      return `
        <p>With the 2024 Italy-Switzerland tax agreement, the distance from the Swiss border has become a determining factor for new cross-border workers. The 20 km threshold draws a clear line between two different tax treatments.</p>
        <h2>Cross-border workers within 20 km</h2>
        <p>New cross-border workers residing within 20 km of the Swiss border benefit from the standard regime: 80% withholding tax in Switzerland and concurrent IRPEF taxation in Italy with EUR 10,000 allowance. With CHF 80,000 gross, annual net is approximately CHF ${within80}.</p>
        <h2>Cross-border workers over 20 km</h2>
        <p>Those residing over 20 km from the border are not technically "cross-border workers" for tax purposes. Italy taxes the full income without allowance. With CHF 80,000 gross and residence over 20 km, net drops to approximately CHF ${over80}.</p>`;
    },
    faqItems: (locale, _data) => {
      if (locale === 'it') return [
        { q: 'Come si misura la distanza dei 20 km?', a: 'La distanza si misura in linea d\'aria tra il comune di residenza e il confine italo-svizzero più vicino, non in base al percorso stradale.' },
        { q: 'La regola dei 20 km si applica ai vecchi frontalieri?', a: 'No, i vecchi frontalieri (pre-2024) non sono soggetti alla regola dei 20 km. Si applica solo ai nuovi frontalieri.' },
      ];
      return [
        { q: 'How is the 20 km distance measured?', a: 'The distance is measured as the crow flies between the municipality of residence and the nearest Italy-Switzerland border, not by road.' },
        { q: 'Does the 20 km rule apply to old cross-border workers?', a: 'No, old cross-border workers (pre-2024) are not subject to the 20 km rule. It only applies to new cross-border workers.' },
      ];
    },
    relatedScenarioFilter: (s) => s.salary === 80_000 && s.frontierType === 'NEW' && s.maritalStatus === 'SINGLE' && s.children === 0,
  },

  // ── Article 6: Salary progression ──────────────────────────
  {
    id: 'progressione-stipendio-frontaliere',
    slugs: {
      it: 'da-50000-a-150000-chf-come-cambia-netto-frontaliere',
      en: 'from-50000-to-150000-chf-how-net-changes-crossborder',
      de: 'von-50000-bis-150000-chf-wie-sich-netto-aendert-grenzgaenger',
      fr: 'de-50000-a-150000-chf-comment-le-net-change-frontalier',
    },
    titles: {
      it: 'Da 50.000 a 150.000 CHF: come cambia il netto di un frontaliere',
      en: 'From 50,000 to 150,000 CHF: how a cross-border worker\'s net changes',
      de: 'Von 50.000 bis 150.000 CHF: Wie sich das Netto eines Grenzgängers ändert',
      fr: 'De 50.000 à 150.000 CHF: comment le net d\'un frontalier change',
    },
    descriptions: {
      it: 'Analisi della progressione fiscale per frontalieri dal CHF 50\'000 al CHF 150\'000 lordi. Come aumenta la pressione fiscale e quanto resta netto a ogni fascia.',
      en: 'Tax progression analysis for cross-border workers from CHF 50,000 to CHF 150,000 gross. How tax pressure increases and what remains net.',
      de: 'Steuerprogression-Analyse für Grenzgänger von CHF 50.000 bis CHF 150.000 brutto.',
      fr: 'Analyse de la progression fiscale pour frontaliers de CHF 50.000 à CHF 150.000 bruts.',
    },
    body: (locale, data) => {
      const salaries = [50_000, 60_000, 70_000, 80_000, 90_000, 100_000, 120_000, 150_000];
      const rows = salaries.map(s => {
        const net = getNetForScenario(data, s, 'NEW', 'SINGLE', 0);
        return `<li><strong>CHF ${fmtCHF(s)} lordi:</strong> CHF ${net} netti/anno</li>`;
      }).join('\n');
      if (locale === 'it') return `
        <p>La pressione fiscale sui frontalieri in Ticino è progressiva: all'aumentare del reddito lordo, l'aliquota effettiva dell'imposta alla fonte cresce. Ma non cresce in modo lineare — ci sono fasce dove l'incremento è più marcato e altre dove è più graduale.</p>
        <h2>Progressione netta per un nuovo frontaliere single</h2>
        <p>Ecco il netto annuo per le fasce di reddito più comuni (frontaliere single, nuovo regime, entro 20 km):</p>
        <ul>${rows}</ul>
        <h2>Dove "morde" di più la progressione</h2>
        <p>Il salto fiscale più significativo si verifica tra CHF 80'000 e CHF 100'000, dove l'aliquota marginale dell'imposta alla fonte cresce rapidamente. Per i nuovi frontalieri, a questo si aggiunge l'effetto della tassazione IRPEF italiana che amplifica la progressione.</p>
        <h2>Il "punto di equilibrio" tra regimi</h2>
        <p>Per redditi sotto CHF 50'000, la differenza tra vecchio e nuovo regime è minima grazie alla franchigia. Sopra CHF 100'000, il vecchio regime diventa progressivamente più vantaggioso. Il "punto di equilibrio" dove i due regimi si equivalgono si aggira intorno ai CHF 60'000-70'000.</p>`;
      return `
        <p>Tax pressure on cross-border workers in Ticino is progressive: as gross income increases, the effective withholding tax rate grows.</p>
        <h2>Net progression for a new single cross-border worker</h2>
        <ul>${rows}</ul>
        <h2>Where progression bites most</h2>
        <p>The most significant tax jump occurs between CHF 80,000 and CHF 100,000, where the marginal withholding tax rate increases rapidly.</p>`;
    },
    faqItems: (locale, _data) => {
      if (locale === 'it') return [
        { q: 'Qual è l\'aliquota fiscale media per un frontaliere?', a: 'L\'aliquota effettiva varia dal 5-7% per redditi intorno a CHF 50\'000 fino al 15-20% per redditi sopra CHF 120\'000, inclusi contributi sociali.' },
        { q: 'Conviene guadagnare di più come frontaliere?', a: 'Sì, sempre. Anche se l\'aliquota marginale aumenta, il netto in valore assoluto cresce sempre con il reddito. Non esistono "trappole fiscali" dove guadagnare di più riduce il netto.' },
      ];
      return [
        { q: 'What is the average tax rate for a cross-border worker?', a: 'The effective rate varies from 5-7% for income around CHF 50,000 to 15-20% for income above CHF 120,000, including social contributions.' },
        { q: 'Is it worth earning more as a cross-border worker?', a: 'Yes, always. Even though the marginal rate increases, the absolute net always grows with income. There are no "tax traps" where earning more reduces net income.' },
      ];
    },
    relatedScenarioFilter: (s) => s.maritalStatus === 'SINGLE' && s.children === 0 && s.frontierType === 'NEW' && s.distanceZone === 'WITHIN_20KM',
  },

  // ── Article 7: Married vs single ──────────────────────────
  {
    id: 'sposato-single-tasse-frontaliere',
    slugs: {
      it: 'sposato-o-single-impatto-tasse-frontaliere',
      en: 'married-or-single-impact-on-crossborder-taxes',
      de: 'verheiratet-oder-ledig-auswirkung-steuern-grenzgaenger',
      fr: 'marie-ou-celibataire-impact-impots-frontalier',
    },
    titles: {
      it: 'Sposato o single: l\'impatto sulle tasse del frontaliere',
      en: 'Married or single: the impact on cross-border worker taxes',
      de: 'Verheiratet oder ledig: Die Auswirkung auf Grenzgänger-Steuern',
      fr: 'Marié ou célibataire: l\'impact sur les impôts du frontalier',
    },
    descriptions: {
      it: 'Come lo stato civile influisce sulle tasse e sullo stipendio netto di un frontaliere. Confronto tra tabella A e tabella B con simulazioni reali.',
      en: 'How marital status affects taxes and net salary for cross-border workers. Comparison between table A and table B with real simulations.',
      de: 'Wie der Familienstand die Steuern und das Nettogehalt eines Grenzgängers beeinflusst.',
      fr: 'Comment l\'état civil affecte les impôts et le salaire net d\'un frontalier.',
    },
    body: (locale, data) => {
      const single80 = getNetForScenario(data, 80_000, 'NEW', 'SINGLE', 0);
      const married80 = getNetForScenario(data, 80_000, 'NEW', 'MARRIED', 0);
      if (locale === 'it') return `
        <p>Lo stato civile è il secondo fattore più importante (dopo il reddito) nella determinazione dell'imposta alla fonte di un frontaliere in Ticino. Un lavoratore sposato con coniuge non lavoratore beneficia della tabella B, con aliquote sensibilmente più basse della tabella A applicata ai single.</p>
        <h2>Tabella A vs Tabella B: il confronto</h2>
        <p>Con CHF 80'000 lordi, un frontaliere single (tabella A) percepisce circa CHF ${single80} netti annui. Un frontaliere sposato con coniuge non lavoratore (tabella B) con lo stesso reddito percepisce circa CHF ${married80} netti — una differenza significativa dovuta alla deduzione per il coniuge a carico.</p>
        <h2>Quando entrambi i coniugi lavorano</h2>
        <p>Se entrambi i coniugi lavorano, si applica la tabella C. Le aliquote sono più vicine alla tabella A, perché il sistema tiene conto del reddito familiare complessivo. In pratica, due coniugi con tabella C pagano complessivamente un'imposta simile a due single con tabella A.</p>
        <h2>L'effetto in Italia (IRPEF)</h2>
        <p>Per i nuovi frontalieri, lo stato civile influisce anche sulla tassazione IRPEF italiana: i coniugati con figli possono beneficiare di detrazioni per carichi di famiglia che riducono l'imposta netta dovuta in Italia.</p>`;
      return `
        <p>Marital status is the second most important factor (after income) in determining a cross-border worker's withholding tax in Ticino. A married worker with a non-working spouse benefits from table B, with significantly lower rates than table A applied to singles.</p>
        <h2>Table A vs Table B: the comparison</h2>
        <p>With CHF 80,000 gross, a single cross-border worker (table A) earns approximately CHF ${single80} net per year. A married worker with non-working spouse (table B) earns approximately CHF ${married80} net.</p>`;
    },
    faqItems: (locale, _data) => {
      if (locale === 'it') return [
        { q: 'Conviene sposarsi per pagare meno tasse come frontaliere?', a: 'Se il coniuge non lavora, il passaggio dalla tabella A alla B riduce significativamente l\'imposta alla fonte. Se entrambi lavorano, il beneficio è minore (tabella C).' },
        { q: 'Come comunico il cambio di stato civile al datore di lavoro?', a: 'Devi presentare il certificato di matrimonio (o divorzio) al datore di lavoro, che aggiornerà la tabella fiscale dalla busta paga successiva.' },
      ];
      return [
        { q: 'Is it worth getting married to pay less tax as a cross-border worker?', a: 'If your spouse doesn\'t work, switching from table A to B significantly reduces withholding tax. If both work, the benefit is smaller (table C).' },
        { q: 'How do I notify my employer of a change in marital status?', a: 'You need to present a marriage (or divorce) certificate to your employer, who will update the tax table from the next payslip.' },
      ];
    },
    relatedScenarioFilter: (s) => s.salary === 80_000 && s.children === 0 && s.frontierType === 'NEW',
  },

  // ── Article 8: CHF-EUR exchange impact ──────────────────────
  {
    id: 'cambio-chf-eur-stipendio-frontaliere',
    slugs: {
      it: 'costo-nascosto-cambio-chf-eur-stipendio-netto',
      en: 'hidden-cost-chf-eur-exchange-net-salary',
      de: 'versteckte-kosten-chf-eur-wechselkurs-nettogehalt',
      fr: 'cout-cache-change-chf-eur-salaire-net',
    },
    titles: {
      it: 'Il costo nascosto del cambio CHF-EUR sullo stipendio netto',
      en: 'The hidden cost of CHF-EUR exchange on net salary',
      de: 'Die versteckten Kosten des CHF-EUR Wechselkurses auf das Nettogehalt',
      fr: 'Le coût caché du change CHF-EUR sur le salaire net',
    },
    descriptions: {
      it: 'Come il tasso di cambio CHF-EUR impatta sullo stipendio reale dei frontalieri. Strategie per minimizzare le perdite: Wise, Fineco e banche convenzionate.',
      en: 'How the CHF-EUR exchange rate impacts cross-border workers\' real salary. Strategies to minimize losses: Wise, Fineco and partner banks.',
      de: 'Wie der CHF-EUR Wechselkurs das reale Gehalt von Grenzgängern beeinflusst. Strategien zur Minimierung von Verlusten.',
      fr: 'Comment le taux de change CHF-EUR impacte le salaire réel des frontaliers. Stratégies pour minimiser les pertes.',
    },
    body: (locale, _data) => {
      if (locale === 'it') return `
        <p>Ogni frontaliere che vive in Italia e guadagna in franchi svizzeri affronta un costo spesso sottovalutato: la conversione dello stipendio da CHF a EUR. Con un tasso di cambio intorno a 1,10 (1 CHF = circa 0,91 EUR), le commissioni bancarie e lo spread possono erodere silenziosamente dal 1% al 3% dello stipendio netto.</p>
        <h2>Il costo reale del cambio con le banche tradizionali</h2>
        <p>Le banche italiane applicano tipicamente uno spread del 1,5-2,5% sul tasso interbancario. Su uno stipendio di CHF 5'000 al mese, questo significa una perdita di CHF 75-125 mensili (CHF 900-1'500 annui). Le banche svizzere non sono necessariamente migliori per i bonifici verso l'Italia.</p>
        <h2>Alternative più economiche</h2>
        <p><strong>Wise (ex TransferWise):</strong> Applica il tasso interbancario reale con una commissione trasparente dello 0,3-0,5%. Su CHF 5'000 mensili, il risparmio rispetto alla banca tradizionale è di CHF 50-100 al mese.</p>
        <p><strong>Fineco:</strong> Per i clienti con conto multivaluta, offre cambio a spread ridotto (0,1-0,3%) e la possibilità di mantenere il saldo in CHF aspettando un tasso favorevole.</p>
        <h2>Strategie intelligenti</h2>
        <p>La strategia più efficace è non cambiare tutto subito: mantenere una riserva in CHF per le spese svizzere (benzina, spesa al confine, pedaggi) e convertire solo la parte necessaria per le spese italiane. Molti frontalieri esperti mantengono il 30-40% dello stipendio in franchi.</p>`;
      return `
        <p>Every cross-border worker living in Italy and earning in Swiss francs faces an often underestimated cost: converting salary from CHF to EUR. With exchange rates around 1.10, bank fees and spreads can silently erode 1-3% of net salary.</p>
        <h2>The real cost of exchange with traditional banks</h2>
        <p>Italian banks typically apply a 1.5-2.5% spread on the interbank rate. On a salary of CHF 5,000/month, this means a loss of CHF 75-125 monthly (CHF 900-1,500 annually).</p>
        <h2>Cheaper alternatives</h2>
        <p><strong>Wise:</strong> Uses the real interbank rate with a transparent 0.3-0.5% fee. On CHF 5,000 monthly, savings vs traditional bank: CHF 50-100/month.</p>
        <p><strong>Fineco:</strong> Multi-currency accounts with reduced spread (0.1-0.3%) and ability to hold CHF balance.</p>`;
    },
    faqItems: (locale, _data) => {
      if (locale === 'it') return [
        { q: 'Qual è il modo più economico per convertire CHF in EUR?', a: 'Servizi come Wise offrono il tasso interbancario reale con commissioni dello 0,3-0,5%, molto inferiori allo spread bancario tradizionale (1,5-2,5%).' },
        { q: 'Conviene mantenere lo stipendio in CHF?', a: 'Sì, per le spese in Svizzera (benzina, spesa, pedaggi). Molti frontalieri mantengono il 30-40% in CHF e convertono solo la parte necessaria per le spese italiane.' },
      ];
      return [
        { q: 'What is the cheapest way to convert CHF to EUR?', a: 'Services like Wise offer the real interbank rate with 0.3-0.5% fees, much lower than traditional bank spreads (1.5-2.5%).' },
        { q: 'Should I keep my salary in CHF?', a: 'Yes, for Swiss expenses (fuel, groceries, tolls). Many experienced cross-border workers keep 30-40% in CHF and only convert what\'s needed for Italian expenses.' },
      ];
    },
    relatedScenarioFilter: (s) => s.maritalStatus === 'SINGLE' && s.children === 0 && s.frontierType === 'NEW' && [60_000, 80_000, 100_000].includes(s.salary),
  },
];

// ── HTML page generation ────────────────────────────────────────

export function generateArticleHtml(
  article: EvergreenArticle,
  locale: Locale,
  scenarioData: ScenarioDataMap,
  distDir: string,
): string {
  const title = article.titles[locale];
  const description = article.descriptions[locale];
  const canonicalUrl = `${BASE_URL}${articleUrl(article, locale)}`;
  const articleBodyHtml = article.body(locale, scenarioData);
  const faqs = article.faqItems(locale, scenarioData);

  const hreflangHtml = renderHreflangTags({
    it: articleUrl(article, 'it'),
    en: articleUrl(article, 'en'),
    de: articleUrl(article, 'de'),
    fr: articleUrl(article, 'fr'),
  });

  const faqSchema = JSON.stringify({
    '@context': 'https://schema.org',
    '@type': 'FAQPage',
    mainEntity: faqs.map(f => ({
      '@type': 'Question',
      name: f.q,
      acceptedAnswer: { '@type': 'Answer', text: f.a },
    })),
  });

  const breadcrumbSchema = JSON.stringify({
    '@context': 'https://schema.org',
    '@type': 'BreadcrumbList',
    itemListElement: [
      { '@type': 'ListItem', position: 1, name: 'Home', item: `${BASE_URL}/` },
      { '@type': 'ListItem', position: 2, name: title },
    ],
  });

  // Get related scenarios for cross-linking grid
  const related = scenarioData.scenarios
    .filter(article.relatedScenarioFilter)
    .slice(0, 8);

  const pageBody = `<article class="salary-hub-page">
    <div class="hub-grid">
      <div class="content">
        <h1>${title}</h1>

        ${articleBodyHtml}

        <div class="ad-unit">${adSlotHtml('ARTICLE_INLINE_MOBILE')}</div>

        <h2>${locale === 'it' ? 'Simulazioni correlate' : 'Related simulations'}</h2>
        ${scenarioGrid(related, locale)}

        <div class="cta-box">
          <p>${locale === 'it' ? 'Calcola il tuo stipendio netto personalizzato' : 'Calculate your personalized net salary'}</p>
          <a href="${LOCALE_CALC_PREFIX[locale]}/">${locale === 'it' ? 'Apri il calcolatore' : 'Open calculator'} &rarr;</a>
        </div>

        <div class="faq-section">
          <h2>${locale === 'it' ? 'Domande frequenti' : 'FAQ'}</h2>
          ${faqs.map(f => `<div class="faq-item"><div class="faq-q">${f.q}</div><div class="faq-a">${f.a}</div></div>`).join('\n')}
        </div>

        <div class="ad-unit">${adSlotHtml('ARTICLE_END_MULTIPLEX')}</div>
      </div>
    </div>
  </article>`;

  return buildSeoPageHtml({
    locale,
    title: `${title} | Frontaliere Ticino`,
    description,
    canonicalUrl,
    hreflangHtml,
    ogType: 'article',
    extraHeadHtml: SALARY_HUB_ARTICLE_STYLE,
    jsonLdScripts: [faqSchema, breadcrumbSchema],
    bodyHtml: pageBody,
    distDir,
  });
}

/** Salary-hub article-scoped CSS (mirrors generatePageHtml's scoped style). */
const SALARY_HUB_ARTICLE_STYLE = `<style>
.salary-hub-page{max-width:1200px;margin:0 auto;padding:24px 16px;color:#334155;line-height:1.7}
.salary-hub-page .hub-grid{display:grid;grid-template-columns:1fr;gap:24px}
.salary-hub-page .rail{display:none}
@media(min-width:1024px){.salary-hub-page .hub-grid{grid-template-columns:160px minmax(0,1fr) 160px}.salary-hub-page .rail{position:sticky;top:80px;align-self:start;display:block}.salary-hub-page .content{grid-column:2}}
.salary-hub-page .content{min-width:0}
.salary-hub-page h1{font-size:28px;font-weight:800;color:#1e293b;margin:0 0 16px;line-height:1.3}
.salary-hub-page h2{font-size:20px;font-weight:700;color:#1e293b;margin:32px 0 12px}
.salary-hub-page p{margin:0 0 16px;font-size:15px}
.salary-hub-page ul{margin:0 0 16px 24px;font-size:15px}
.salary-hub-page li{margin-bottom:8px}
.salary-hub-page a{color:#533afd}
.salary-hub-page .related-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(200px,1fr));gap:12px;margin-top:16px}
.salary-hub-page .related-card{display:block;padding:16px;background:#fff;border:1px solid #e2e8f0;border-radius:8px;text-decoration:none;color:#334155;font-size:14px;transition:box-shadow .15s}
.salary-hub-page .related-card:hover{box-shadow:0 4px 12px rgba(0,0,0,.1)}
.salary-hub-page .faq-section{margin-top:32px}
.salary-hub-page .faq-item{border-bottom:1px solid #e2e8f0;padding:16px 0}
.salary-hub-page .faq-q{font-weight:700;font-size:15px;color:#1e293b}
.salary-hub-page .faq-a{font-size:14px;color:#475569;margin-top:8px}
.salary-hub-page .ad-unit{margin:24px 0;min-height:220px}
.salary-hub-page .cta-box{background:linear-gradient(135deg,#533afd 0%,#7c3aed 100%);color:#fff;padding:24px;border-radius:12px;text-align:center;margin:32px 0}
.salary-hub-page .cta-box p{margin:0;color:#fff}
.salary-hub-page .cta-box a{display:inline-block;background:#fff;color:#533afd;padding:12px 32px;border-radius:8px;font-weight:700;text-decoration:none;margin-top:12px}
</style>`;
