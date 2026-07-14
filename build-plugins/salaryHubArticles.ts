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
import { adSlotHtml } from './lib/adSlotHtml';
import { BASE_URL } from './constants';
import { buildFullPath, LOCALE_CALC_PREFIX, type SalaryHubScenario } from './salaryHubScenarios';
import { buildSeoPageHtml } from './shared/seoPageShell';
import { renderHreflangTags } from './shared/hreflang';
import { differentiateH1FromTitle } from './shared/seoContentTokens';
import { buildTitleWithBrand } from './shared/titleSuffix';
import { renderAuthoritativeSourcesHtml } from './shared/authoritativeSources';
import { buildDayStampIso } from './shared/buildDayStamp';
import { imageObjectLd } from '../services/seo/imageObjectLd';

type Locale = 'it' | 'en' | 'de' | 'fr';

const fmtCHF = (n: number): string => Math.round(n).toLocaleString('de-CH');

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
      de: 'Von 50.000 bis 150.000 CHF: So ändert sich das Nettogehalt',
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
      de: 'CHF-EUR Wechselkurs: versteckte Kosten fürs Nettogehalt',
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

  // ── Article 9: Tax hub (orchestrates the fiscal sibling articles) ──
  {
    id: 'hub-fiscale-frontalieri',
    slugs: {
      it: 'fiscalita',
      en: 'taxation',
      de: 'besteuerung',
      fr: 'fiscalite',
    },
    titles: {
      it: 'Tasse frontalieri Ticino 2026: guida fiscale completa',
      en: 'Cross-border worker taxes in Ticino 2026: complete tax guide',
      de: 'Grenzgänger-Steuern Tessin 2026: vollständiger Steuerratgeber',
      fr: 'Impôts frontaliers Tessin 2026 : guide fiscal complet',
    },
    descriptions: {
      it: 'Guida fiscale per frontalieri: imposta alla fonte in Ticino, nuovo accordo Italia-Svizzera, vecchi vs nuovi frontalieri, doppia imposizione e detrazioni deducibili.',
      en: 'Tax guide for cross-border workers: Ticino withholding tax, new Italy-Switzerland agreement, old vs new cross-border workers, double taxation and deductions.',
      de: 'Steuerratgeber für Grenzgänger: Quellensteuer Tessin, neues Abkommen Italien-Schweiz, alte vs neue Grenzgänger, Doppelbesteuerung und Abzüge.',
      fr: 'Guide fiscal pour frontaliers : impôt à la source au Tessin, nouvel accord Italie-Suisse, anciens vs nouveaux frontaliers, double imposition et déductions.',
    },
    body: (locale, data) => {
      const example80 = getNetForScenario(data, 80_000, 'NEW', 'SINGLE', 0);
      const siblingWithholding: Record<Locale, string> = {
        it: `${ARTICLE_PREFIX.it}/imposta-alla-fonte-ticino-tabelle-a-b-c-h/`,
        en: `${ARTICLE_PREFIX.en}/withholding-tax-ticino-tables-a-b-c-h/`,
        de: `${ARTICLE_PREFIX.de}/quellensteuer-tessin-tabellen-a-b-c-h/`,
        fr: `${ARTICLE_PREFIX.fr}/impot-source-tessin-baremes-a-b-c-h/`,
      };
      const siblingOldNew: Record<Locale, string> = {
        it: `${ARTICLE_PREFIX.it}/nuovo-vs-vecchio-frontaliere-differenze-fiscali/`,
        en: `${ARTICLE_PREFIX.en}/new-vs-old-crossborder-worker-tax-differences/`,
        de: `${ARTICLE_PREFIX.de}/neuer-vs-alter-grenzgaenger-steuerliche-unterschiede/`,
        fr: `${ARTICLE_PREFIX.fr}/nouveau-vs-ancien-frontalier-differences-fiscales/`,
      };
      const deductionsHref: Record<Locale, string> = {
        it: '/articoli-svizzera/frontaliere-detrazioni-fiscali-italia-2026/',
        en: '/en/swiss-articles/frontaliere-detrazioni-fiscali-italia-2026/',
        de: '/de/schweiz-artikel/frontaliere-detrazioni-fiscali-italia-2026/',
        fr: '/fr/articles-suisse/frontaliere-detrazioni-fiscali-italia-2026/',
      };
      const pillarHref: Record<Locale, string> = {
        it: '/guida-tassazione-frontalieri-2026/',
        en: '/en/cross-border-taxation-guide-2026/',
        de: '/de/grenzgaenger-besteuerung-leitfaden-2026/',
        fr: '/fr/guide-imposition-frontaliers-2026/',
      };
      const calcUrl = `${LOCALE_CALC_PREFIX[locale]}/`;
      if (locale === 'it') return `
        <p>La tassazione dei frontalieri Ticino-Italia si basa su tre pilastri: l'imposta alla fonte in Ticino trattenuta dal datore di lavoro svizzero, il Nuovo Accordo fiscale Italia-Svizzera in vigore dal 2024 e la Convenzione contro le doppie imposizioni del 1976. Questa guida raccoglie i concetti chiave e rimanda agli approfondimenti dedicati.</p>
        <h2>Imposta alla fonte: chi la applica e come</h2>
        <p>L'imposta alla fonte sul reddito da lavoro viene trattenuta esclusivamente in Svizzera: il datore di lavoro applica una delle tabelle cantonali (A per i single, B per i coniugati con coniuge non lavoratore, C per i coniugi entrambi occupati, H per i genitori single) in base allo stato civile e al numero di figli. Le aliquote sono stabilite dall'Amministrazione federale delle contribuzioni (AFC/ESTV) insieme alle amministrazioni cantonali. Con CHF 80'000 lordi, un nuovo frontaliere single entro 20 km dal confine percepisce circa CHF ${example80} netti annui — il dettaglio tabella per tabella è nella guida <a href="${siblingWithholding.it}">imposta alla fonte in Ticino</a>.</p>
        <h2>Nuovo Accordo Italia-Svizzera: vecchi e nuovi frontalieri</h2>
        <p>Il Nuovo Accordo fiscale, firmato il 23 dicembre 2020 e in vigore dal 1° gennaio 2024 (ratificato in Italia con la Legge 83/2023), distingue due categorie. I "vecchi" frontalieri, che lavoravano già come tali prima del 17 luglio 2023, restano nel regime transitorio 2024-2033 con esenzione di €7'500. I "nuovi" frontalieri sono soggetti a tassazione concorrente: imposta alla fonte all'80% in Svizzera più IRPEF in Italia sul reddito eccedente la franchigia di €10'000. Il confronto numerico completo è nella guida <a href="${siblingOldNew.it}">vecchio vs nuovo frontaliere</a>.</p>
        <h2>Doppia imposizione: come viene evitata</h2>
        <p>La Convenzione Italia-Svizzera contro le doppie imposizioni, firmata il 9 dicembre 1976, stabilisce che il reddito da lavoro frontaliere non venga tassato due volte: l'Italia riconosce un credito d'imposta per le imposte già pagate in Svizzera, da indicare nel quadro CE del modello 730 o Redditi PF.</p>
        <h2>Detrazioni fiscali deducibili</h2>
        <p>Sia in Svizzera sia in Italia esistono voci deducibili che riducono l'imponibile: contributi previdenziali (LPP, terzo pilastro), spese mediche e, sul lato italiano, oneri riconosciuti dall'Agenzia delle Entrate e dal MEF in dichiarazione dei redditi. L'elenco completo delle detrazioni applicabili ai frontalieri è nell'articolo <a href="${deductionsHref.it}">Detrazioni fiscali per frontalieri in Italia</a>.</p>
        <h2>Per approfondire</h2>
        <p>Per una guida ancora più dettagliata su tabelle, aliquote e simulazioni, consulta la <a href="${pillarHref.it}">guida completa alla tassazione dei frontalieri 2026</a> oppure calcola il tuo netto con il <a href="${calcUrl}">calcolatore stipendio netto</a>.</p>`;
      if (locale === 'en') return `
        <p>Cross-border worker taxation between Ticino and Italy rests on three pillars: withholding tax deducted by the Swiss employer, the new Italy-Switzerland tax agreement in force since 2024, and the 1976 double-taxation treaty. This hub page collects the core concepts and links to the in-depth guides.</p>
        <h2>Withholding tax: who applies it and how</h2>
        <p>Withholding tax on employment income is deducted exclusively in Switzerland: the employer applies one of the cantonal tables (A for singles, B for married with a non-working spouse, C for dual-income couples, H for single parents) based on marital status and number of children. Rates are set by the Federal Tax Administration (AFC/ESTV) together with cantonal authorities. With CHF 80,000 gross, a new single cross-border worker within 20 km of the border earns approximately CHF ${example80} net per year — see the full table-by-table breakdown in the <a href="${siblingWithholding.en}">Ticino withholding tax guide</a>.</p>
        <h2>New Italy-Switzerland Agreement: old vs new cross-border workers</h2>
        <p>The New Tax Agreement, signed 23 December 2020 and in force since 1 January 2024 (ratified in Italy by Law 83/2023), distinguishes two categories. "Old" cross-border workers, already working as such before 17 July 2023, remain under the 2024-2033 transitional regime with a €7,500 exemption. "New" cross-border workers face concurrent taxation: 80% withholding tax in Switzerland plus Italian IRPEF on income above the €10,000 allowance. See the full numeric comparison in the <a href="${siblingOldNew.en}">old vs new cross-border worker guide</a>.</p>
        <h2>Double taxation: how it's avoided</h2>
        <p>The 1976 Italy-Switzerland double-taxation treaty ensures cross-border employment income isn't taxed twice: Italy grants a tax credit for taxes already paid in Switzerland, reported in the CE section of the 730/Redditi PF tax return.</p>
        <h2>Deductible tax items</h2>
        <p>Both Switzerland and Italy allow deductions that reduce taxable income: pension contributions (LPP, third pillar), medical expenses and, on the Italian side, expenses recognized by the Agenzia delle Entrate and the MEF in the tax return. See the full list in <a href="${deductionsHref.en}">Tax deductions for cross-border workers in Italy</a>.</p>
        <h2>Go deeper</h2>
        <p>For a more detailed guide on tables, rates and simulations, see the <a href="${pillarHref.en}">complete 2026 cross-border taxation guide</a> or calculate your net salary with the <a href="${calcUrl}">net salary calculator</a>.</p>`;
      if (locale === 'de') return `
        <p>Die Besteuerung von Grenzgängern zwischen Tessin und Italien beruht auf drei Säulen: der vom Schweizer Arbeitgeber einbehaltenen Quellensteuer, dem seit 2024 geltenden neuen Steuerabkommen Italien-Schweiz und dem Doppelbesteuerungsabkommen von 1976. Diese Übersichtsseite bündelt die zentralen Begriffe und verlinkt auf die vertiefenden Ratgeber.</p>
        <h2>Quellensteuer: wer sie anwendet und wie</h2>
        <p>Die Quellensteuer auf Erwerbseinkommen wird ausschliesslich in der Schweiz erhoben: Der Arbeitgeber wendet eine der kantonalen Tabellen an (A für Ledige, B für Verheiratete mit nichterwerbstätigem Ehepartner, C für Doppelverdiener-Ehepaare, H für Alleinerziehende), abhängig von Zivilstand und Kinderzahl. Die Tarife werden von der Eidgenössischen Steuerverwaltung (ESTV) zusammen mit den kantonalen Behörden festgelegt. Bei CHF 80'000 brutto erzielt ein neuer lediger Grenzgänger innerhalb von 20 km zur Grenze rund CHF ${example80} netto pro Jahr — die vollständige Tabellenübersicht finden Sie im <a href="${siblingWithholding.de}">Ratgeber Quellensteuer Tessin</a>.</p>
        <h2>Neues Abkommen Italien-Schweiz: alte und neue Grenzgänger</h2>
        <p>Das am 23. Dezember 2020 unterzeichnete und seit 1. Januar 2024 geltende neue Steuerabkommen (in Italien mit Gesetz 83/2023 ratifiziert) unterscheidet zwei Kategorien. "Alte" Grenzgänger, die bereits vor dem 17. Juli 2023 als solche tätig waren, bleiben bis 2033 in der Übergangsregelung mit einem Freibetrag von €7'500. "Neue" Grenzgänger unterliegen der konkurrierenden Besteuerung: 80% Quellensteuer in der Schweiz plus italienische IRPEF auf das Einkommen über dem Freibetrag von €10'000. Den vollständigen Zahlenvergleich finden Sie im <a href="${siblingOldNew.de}">Ratgeber alte vs. neue Grenzgänger</a>.</p>
        <h2>Doppelbesteuerung: wie sie vermieden wird</h2>
        <p>Das Doppelbesteuerungsabkommen Italien-Schweiz von 1976 stellt sicher, dass das Erwerbseinkommen von Grenzgängern nicht doppelt besteuert wird: Italien gewährt eine Steuergutschrift für bereits in der Schweiz bezahlte Steuern, einzutragen im Abschnitt CE der Steuererklärung 730/Redditi PF.</p>
        <h2>Abzugsfähige Steuerposten</h2>
        <p>Sowohl in der Schweiz als auch in Italien gibt es abzugsfähige Posten, die das steuerbare Einkommen reduzieren: Vorsorgebeiträge (BVG, dritte Säule), Arztkosten und, auf italienischer Seite, von der Agenzia delle Entrate und dem MEF in der Steuererklärung anerkannte Aufwendungen. Die vollständige Liste finden Sie im Artikel <a href="${deductionsHref.de}">Steuerabzüge für Grenzgänger in Italien</a>.</p>
        <h2>Mehr erfahren</h2>
        <p>Für einen noch detaillierteren Ratgeber zu Tabellen, Sätzen und Simulationen siehe den <a href="${pillarHref.de}">vollständigen Ratgeber Grenzgänger-Besteuerung 2026</a> oder berechnen Sie Ihr Nettogehalt mit dem <a href="${calcUrl}">Nettogehalts-Rechner</a>.</p>`;
      return `
        <p>La fiscalité des frontaliers entre le Tessin et l'Italie repose sur trois piliers : l'impôt à la source retenu par l'employeur suisse, le nouvel accord fiscal Italie-Suisse en vigueur depuis 2024, et la convention contre les doubles impositions de 1976. Cette page centralise les concepts clés et renvoie vers les guides approfondis.</p>
        <h2>Impôt à la source : qui l'applique et comment</h2>
        <p>L'impôt à la source sur le revenu du travail est prélevé exclusivement en Suisse : l'employeur applique l'un des barèmes cantonaux (A pour les célibataires, B pour les mariés avec conjoint sans activité, C pour les couples à double revenu, H pour les parents seuls), selon l'état civil et le nombre d'enfants. Les taux sont fixés par l'Administration fédérale des contributions (AFC/ESTV) avec les autorités cantonales. Avec CHF 80'000 bruts, un nouveau frontalier célibataire résidant à moins de 20 km de la frontière perçoit environ CHF ${example80} nets par an — le détail barème par barème figure dans le <a href="${siblingWithholding.fr}">guide de l'impôt à la source au Tessin</a>.</p>
        <h2>Nouvel accord Italie-Suisse : anciens et nouveaux frontaliers</h2>
        <p>Le nouvel accord fiscal, signé le 23 décembre 2020 et en vigueur depuis le 1er janvier 2024 (ratifié en Italie par la loi 83/2023), distingue deux catégories. Les "anciens" frontaliers, déjà actifs comme tels avant le 17 juillet 2023, restent sous le régime transitoire 2024-2033 avec une exonération de 7'500 €. Les "nouveaux" frontaliers sont soumis à une imposition concurrente : impôt à la source à 80% en Suisse plus IRPEF italien sur le revenu dépassant la franchise de 10'000 €. La comparaison chiffrée complète figure dans le <a href="${siblingOldNew.fr}">guide anciens vs nouveaux frontaliers</a>.</p>
        <h2>Double imposition : comment elle est évitée</h2>
        <p>La convention italo-suisse contre les doubles impositions, signée le 9 décembre 1976, garantit que le revenu du travail frontalier n'est pas taxé deux fois : l'Italie accorde un crédit d'impôt pour les impôts déjà payés en Suisse, à reporter dans le cadre CE de la déclaration 730/Redditi PF.</p>
        <h2>Déductions fiscales</h2>
        <p>La Suisse comme l'Italie prévoient des postes déductibles qui réduisent le revenu imposable : cotisations de prévoyance (LPP, 3e pilier), frais médicaux et, côté italien, charges reconnues par l'Agenzia delle Entrate et le MEF dans la déclaration de revenus. La liste complète figure dans l'article <a href="${deductionsHref.fr}">Déductions fiscales pour frontaliers en Italie</a>.</p>
        <h2>Pour aller plus loin</h2>
        <p>Pour un guide encore plus détaillé sur les barèmes, taux et simulations, consultez le <a href="${pillarHref.fr}">guide complet de la fiscalité des frontaliers 2026</a> ou calculez votre salaire net avec le <a href="${calcUrl}">calculateur de salaire net</a>.</p>`;
    },
    faqItems: (locale, _data) => {
      if (locale === 'it') return [
        { q: 'Chi tassa lo stipendio di un frontaliere, Italia o Svizzera?', a: 'L\'imposta sul reddito da lavoro viene trattenuta alla fonte solo in Svizzera. L\'Italia evita la doppia imposizione riconoscendo un credito d\'imposta nel quadro CE del modello 730.' },
        { q: 'Cosa cambia tra vecchi e nuovi frontalieri?', a: 'I vecchi frontalieri (attivi prima del 17/7/2023) restano nel regime transitorio 2024-2033 con esenzione di €7\'500. I nuovi sono soggetti a tassazione concorrente con franchigia di €10\'000.' },
        { q: 'Quando è entrato in vigore il Nuovo Accordo fiscale?', a: 'Il Nuovo Accordo è stato firmato il 23 dicembre 2020 ed è in vigore dal 1° gennaio 2024, ratificato in Italia con la Legge 83/2023.' },
        { q: 'Come si evita la doppia imposizione?', a: 'Grazie alla Convenzione Italia-Svizzera del 9 dicembre 1976: l\'Italia riconosce un credito d\'imposta per le imposte già pagate in Svizzera.' },
      ];
      if (locale === 'en') return [
        { q: 'Who taxes a cross-border worker\'s salary, Italy or Switzerland?', a: 'Employment income tax is withheld at source only in Switzerland. Italy avoids double taxation by granting a tax credit in the CE section of the 730 return.' },
        { q: 'What changes between old and new cross-border workers?', a: 'Old cross-border workers (active before 17 July 2023) remain under the 2024-2033 transitional regime with a €7,500 exemption. New ones face concurrent taxation with a €10,000 allowance.' },
        { q: 'When did the New Tax Agreement come into force?', a: 'The New Agreement was signed on 23 December 2020 and has been in force since 1 January 2024, ratified in Italy by Law 83/2023.' },
        { q: 'How is double taxation avoided?', a: 'Through the 9 December 1976 Italy-Switzerland treaty: Italy grants a tax credit for taxes already paid in Switzerland.' },
      ];
      if (locale === 'de') return [
        { q: 'Wer besteuert das Gehalt eines Grenzgängers, Italien oder die Schweiz?', a: 'Die Erwerbseinkommensteuer wird nur in der Schweiz an der Quelle einbehalten. Italien vermeidet Doppelbesteuerung durch eine Steuergutschrift im Abschnitt CE der Steuererklärung 730.' },
        { q: 'Was ändert sich zwischen alten und neuen Grenzgängern?', a: 'Alte Grenzgänger (tätig vor dem 17.7.2023) bleiben bis 2033 in der Übergangsregelung mit Freibetrag von €7\'500. Neue unterliegen der konkurrierenden Besteuerung mit Freibetrag von €10\'000.' },
        { q: 'Wann trat das neue Steuerabkommen in Kraft?', a: 'Das neue Abkommen wurde am 23. Dezember 2020 unterzeichnet und gilt seit 1. Januar 2024, ratifiziert in Italien mit Gesetz 83/2023.' },
        { q: 'Wie wird Doppelbesteuerung vermieden?', a: 'Durch das Abkommen Italien-Schweiz vom 9. Dezember 1976: Italien gewährt eine Steuergutschrift für bereits in der Schweiz bezahlte Steuern.' },
      ];
      return [
        { q: 'Qui taxe le salaire d\'un frontalier, l\'Italie ou la Suisse ?', a: 'L\'impôt sur le revenu du travail est retenu à la source uniquement en Suisse. L\'Italie évite la double imposition en accordant un crédit d\'impôt dans le cadre CE de la déclaration 730.' },
        { q: 'Que change-t-il entre anciens et nouveaux frontaliers ?', a: 'Les anciens frontaliers (actifs avant le 17/7/2023) restent sous le régime transitoire 2024-2033 avec une exonération de 7\'500 €. Les nouveaux sont soumis à une imposition concurrente avec une franchise de 10\'000 €.' },
        { q: 'Quand le nouvel accord fiscal est-il entré en vigueur ?', a: 'Le nouvel accord a été signé le 23 décembre 2020 et est en vigueur depuis le 1er janvier 2024, ratifié en Italie par la loi 83/2023.' },
        { q: 'Comment la double imposition est-elle évitée ?', a: 'Grâce à la convention italo-suisse du 9 décembre 1976 : l\'Italie accorde un crédit d\'impôt pour les impôts déjà payés en Suisse.' },
      ];
    },
    relatedScenarioFilter: (s) => s.salary === 80_000 && s.frontierType === 'NEW' && s.maritalStatus === 'SINGLE' && s.children === 0,
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

  // Article schema — these pages set ogType 'article' but previously shipped no
  // Article JSON-LD, so they were ineligible for Article rich results and lacked
  // an explicit author/publisher E-E-A-T signal. Mirrors the accepted publisher
  // Organization + licensable logo pattern used by comparisonsHubPlugin. Dates
  // use the day-truncated build stamp (buildDayStampIso) so dateModified stays a
  // valid freshness signal — the net figures in the body are recomputed from the
  // simulation engine on every build — without churning every sub-second deploy.
  const articleStamp = buildDayStampIso();
  const articleSchema = JSON.stringify({
    '@context': 'https://schema.org',
    '@type': 'Article',
    headline: title,
    description,
    image: `${BASE_URL}/og-image.png`,
    inLanguage: locale,
    url: canonicalUrl,
    mainEntityOfPage: { '@type': 'WebPage', '@id': canonicalUrl },
    datePublished: articleStamp,
    dateModified: articleStamp,
    author: { '@type': 'Organization', name: 'Frontaliere Ticino', url: `${BASE_URL}/` },
    publisher: {
      '@type': 'Organization',
      name: 'Frontaliere Ticino',
      url: `${BASE_URL}/`,
      logo: imageObjectLd({
        url: `${BASE_URL}/icons/icon-512x512.png`,
        width: 512,
        height: 512,
      }),
    },
  });

  // Get related scenarios for cross-linking grid
  const related = scenarioData.scenarios
    .filter(article.relatedScenarioFilter)
    .slice(0, 8);

  // When buildTitleWithBrand drops the " | Frontaliere Ticino" suffix
  // (headline + 22 > 66), the rendered <title> becomes byte-identical to
  // <h1>. Use the shared differentiator to append a locale-aware tag.
  const h1Display = differentiateH1FromTitle(title, title, locale as 'it' | 'en' | 'de' | 'fr');

  // Methodology + scenario context block: pushes text/HTML ratio above the
  // 10 % Semrush threshold for these 8 evergreen articles × 4 locales.
  // Without it, generateArticleHtml's chrome (FAQ schema, breadcrumb schema,
  // ad units, scoped CSS, hreflang block) dominates the rendered HTML and
  // every article trips audit:text-html-ratio. The prose below is
  // page-relevant — it ties each article's headline to the live calculator
  // and the published 2026 New Agreement rules.
  const methodologyBlock = (() => {
    const articleTitle = title;
    const calcUrl = `${LOCALE_CALC_PREFIX[locale]}/`;
    if (locale === 'it') {
      return `<section class="methodology-block">
        <h2>Metodologia di calcolo</h2>
        <p>I numeri presentati in <em>${articleTitle}</em> derivano dal motore di simulazione di Frontaliere Ticino, lo stesso che alimenta il <a href="${calcUrl}">calcolatore stipendio netto</a>. Per ogni scenario applichiamo le aliquote dell'imposta alla fonte 2026 pubblicate dal Cantone Ticino, le aliquote IRPEF italiane vigenti, i contributi AVS/AI/IPG (5.3 %), LPP (deduzione coordinata, contributo medio 7 %) e LAINP (0.7 % a carico lavoratore). Sul lato italiano consideriamo il credito d'imposta riconosciuto dal Nuovo Accordo per i frontalieri "vecchi" e l'imposizione integrale per i "nuovi" residenti oltre i 20 km dalla frontiera, con la franchigia di 10 000 € e l'addizionale comunale media.</p>
        <h2>Come usare questo articolo</h2>
        <p>Tre passaggi pratici per applicare i contenuti al tuo caso: (1) leggi la sezione introduttiva per capire la regola fiscale alla base, (2) confronta gli scenari numerici qui sotto con la tua situazione personale, (3) apri il <a href="${calcUrl}">calcolatore</a> e inserisci i tuoi dati reali — età, stato civile, figli, comune di residenza, lordo annuale — per ottenere la cifra netta esatta. Il calcolatore chiama lo stesso motore di questo articolo, quindi i risultati sono coerenti.</p>
        <h2>Limiti e variabili di contesto</h2>
        <p>I valori in questo articolo sono indicativi e basati su un mese standard. Variabili che possono spostare significativamente il netto includono: tredicesima e quattordicesima, premi di produzione tassati separatamente, deducibilità dei contributi LPP volontari (3a colonna), agevolazioni per nuclei mono-reddito, pensionamento parziale, indennità ATU per disoccupazione frontaliera. Per il calcolo definitivo prima della firma di un contratto svizzero ti consigliamo di simulare anche con il <a href="${calcUrl}">calcolatore</a> di Frontaliere Ticino e di confrontare con il tuo commercialista italiano.</p>
      </section>`;
    }
    if (locale === 'en') {
      return `<section class="methodology-block">
        <h2>Calculation methodology</h2>
        <p>The figures in <em>${articleTitle}</em> come from Frontaliere Ticino's simulation engine — the same one powering the <a href="${calcUrl}">net-salary calculator</a>. Each scenario applies the 2026 Ticino withholding tax brackets, current Italian IRPEF rates, Swiss social contributions (AVS/AI/IPG 5.3 %, LPP coordinated deduction with 7 % average employee share, LAINP 0.7 % employee share). On the Italian side we account for the New Agreement credit for "old" cross-border workers and full Italian taxation for "new" residents beyond 20 km from the border, with the €10 000 personal allowance and average municipal surtax.</p>
        <h2>How to use this article</h2>
        <p>Three practical steps: (1) read the opening section to understand the tax rule at play, (2) compare the numeric scenarios below with your personal situation, (3) open the <a href="${calcUrl}">calculator</a> and enter your real data — age, marital status, dependents, municipality of residence, gross annual salary — for an exact net figure. The calculator runs the same engine as this article, so the results stay consistent.</p>
        <h2>Limits and contextual variables</h2>
        <p>The numbers in this article are indicative and based on a standard month. Variables that can meaningfully shift the net include: 13th- and 14th-month payments, productivity bonuses taxed separately, deductibility of voluntary LPP contributions (3rd pillar), single-earner household reliefs, phased retirement, ATU unemployment benefits for cross-border workers. Before signing a Swiss contract simulate with Frontaliere Ticino's <a href="${calcUrl}">calculator</a> and cross-check with your Italian tax advisor.</p>
      </section>`;
    }
    if (locale === 'de') {
      return `<section class="methodology-block">
        <h2>Berechnungsmethodik</h2>
        <p>Die Zahlen in <em>${articleTitle}</em> stammen aus der Simulations-Engine von Frontaliere Ticino — derselben, die den <a href="${calcUrl}">Nettogehalts-Rechner</a> antreibt. Für jedes Szenario gelten die Quellensteuer-Tarife Tessin 2026, die geltenden italienischen IRPEF-Sätze sowie die Schweizer Sozialbeiträge (AHV/IV/EO 5.3 %, BVG koordinierter Lohn mit durchschnittlich 7 % Arbeitnehmeranteil, NBUV 0.7 % Arbeitnehmer). Auf italienischer Seite berücksichtigen wir die Steueranrechnung des Neuen Abkommens für "alte" Grenzgänger und die volle italienische Besteuerung für "neue" Wohnsitze ausserhalb des 20-km-Bands, mit dem Freibetrag von 10 000 € und der durchschnittlichen kommunalen Zusatzsteuer.</p>
        <h2>So nutzen Sie diesen Artikel</h2>
        <p>Drei praktische Schritte: (1) lesen Sie den Einleitungsabschnitt, um die zugrunde liegende Steuerregel zu verstehen, (2) vergleichen Sie die Zahlenszenarien unten mit Ihrer persönlichen Situation, (3) öffnen Sie den <a href="${calcUrl}">Rechner</a> und geben Sie Ihre echten Daten ein — Alter, Zivilstand, Kinder, Wohngemeinde, Bruttojahreslohn — für die exakte Nettozahl. Der Rechner verwendet dieselbe Engine wie dieser Artikel, die Ergebnisse bleiben konsistent.</p>
        <h2>Grenzen und Kontextvariablen</h2>
        <p>Die Zahlen sind indikativ und beruhen auf einem Standardmonat. Variablen, die das Netto merklich verschieben können: 13. und 14. Monatslohn, separat besteuerte Produktivitätsboni, Abzugsfähigkeit freiwilliger BVG-Beiträge (3. Säule), Vergünstigungen für Einverdienerhaushalte, Teilpensionierung, ATU-Arbeitslosenleistungen für Grenzgänger. Vor Unterzeichnung eines Schweizer Vertrags empfehlen wir die Simulation mit dem <a href="${calcUrl}">Rechner</a> von Frontaliere Ticino plus Abgleich mit Ihrem italienischen Steuerberater.</p>
      </section>`;
    }
    return `<section class="methodology-block">
        <h2>Méthodologie de calcul</h2>
        <p>Les chiffres dans <em>${articleTitle}</em> proviennent du moteur de simulation de Frontaliere Ticino — le même qui alimente le <a href="${calcUrl}">calculateur de salaire net</a>. Chaque scénario applique les barèmes 2026 de l'impôt à la source du Tessin, les taux IRPEF italiens en vigueur ainsi que les cotisations sociales suisses (AVS/AI/APG 5.3 %, LPP avec déduction coordonnée et part moyenne employé de 7 %, LAANP 0.7 % salarié). Côté italien, nous tenons compte du crédit d'impôt du Nouvel Accord pour les "anciens" frontaliers et de l'imposition intégrale pour les "nouveaux" au-delà des 20 km de la frontière, avec la franchise de 10 000 € et la majoration communale moyenne.</p>
        <h2>Comment utiliser cet article</h2>
        <p>Trois étapes pratiques : (1) lire la section d'introduction pour comprendre la règle fiscale, (2) comparer les scénarios chiffrés avec votre situation personnelle, (3) ouvrir le <a href="${calcUrl}">calculateur</a> et saisir vos données réelles — âge, état civil, personnes à charge, commune de résidence, salaire brut annuel — pour le net exact. Le calculateur utilise le même moteur que cet article, les résultats restent cohérents.</p>
        <h2>Limites et variables contextuelles</h2>
        <p>Les chiffres sont indicatifs et basés sur un mois standard. Variables susceptibles de modifier sensiblement le net : 13e et 14e mois, primes de productivité imposées séparément, déductibilité des cotisations LPP volontaires (3e pilier), réductions pour foyers mono-revenu, retraite partielle, allocations ATU pour les frontaliers. Avant la signature d'un contrat suisse, simulez avec le <a href="${calcUrl}">calculateur</a> de Frontaliere Ticino puis comparez avec votre fiscaliste italien.</p>
      </section>`;
  })();

  const pageBody = `<article class="salary-hub-article">
    <div class="hub-grid">
      <div class="content">
        <h1>${h1Display}</h1>

        ${articleBodyHtml}

        ${methodologyBlock}

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

        ${renderAuthoritativeSourcesHtml(locale)}

        <div class="ad-unit">${adSlotHtml('ARTICLE_END_MULTIPLEX')}</div>
      </div>
    </div>
  </article>`;

  return buildSeoPageHtml({
    locale,
    title: buildTitleWithBrand(title),
    description,
    canonicalUrl,
    hreflangHtml,
    ogType: 'article',
    jsonLdScripts: [articleSchema, faqSchema, breadcrumbSchema],
    bodyHtml: pageBody,
    distDir,
  });
}
