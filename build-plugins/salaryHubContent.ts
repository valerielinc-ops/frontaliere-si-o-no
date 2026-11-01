/**
 * Salary Hub SEO — Parameterized content templates for 4 locales.
 *
 * Each page contains: H1, results table, 5-7 editorial paragraphs,
 * FAQ schema, related scenario links, CTA to full calculator, and
 * contextual affiliate recommendations.
 *
 * Templates are deterministic (no AI) — each produces unique content
 * because the numbers, tax tables, and explanations vary per scenario.
 */

import { FISCAL_PARAMS_UPDATED_AT } from '../services/contentDates';
import { renderRevenueNoteHtml } from '../services/revenueDisclosure';
import { renderFiscalParamsDate } from './shared/fiscalParamsDate';
import { SimulationResult } from '../types';
import { SalaryHubScenario, buildFullPath, getRelatedScenarios, LOCALE_CALC_PREFIX } from './salaryHubScenarios';
import { adSlotHtml } from './lib/adSlotHtml';
import { BASE_URL } from './constants';
import { buildSeoPageHtml } from './shared/seoPageShell';
import { renderHreflangTags } from './shared/hreflang';
import { renderAuthoritativeSourcesHtml } from './shared/authoritativeSources';
import { buildNearestExchangeAmountPath } from '../services/exchangeSsgPaths';
import { renderScenarioLeverComparison } from './shared/scenarioLeverComparison';
import {
  renderSalaryLandingShell,
  type SalaryLandingData,
  type SalaryLocale,
} from './shared/salaryLandingShell';

type Locale = 'it' | 'en' | 'de' | 'fr';

// ── Number formatting ───────────────────────────────────────────

const fmtCHF = (n: number): string => Math.round(n).toLocaleString('de-CH');
const fmtEUR = (n: number): string => Math.round(n).toLocaleString('de-DE');
const fmtPct = (n: number): string => (n * 100).toFixed(1);

/**
 * Human tax-table letter from the calc source key: 'calc.tableA' → 'A'.
 * `details.source` carries the i18n KEY (see calculationService.ts
 * getTicinoTaxRate), not display copy — interpolating a bare
 * `replace('calc.', '')` leaked the raw identifier into meta descriptions
 * and body prose ("Tabella tableA", issue #3519). One shared helper for all
 * template call sites so the munging can't drift again; anything that isn't
 * a clean single table letter falls back to 'A' (the pre-existing default).
 */
const taxTableCode = (source?: string): string => {
  const code = (source ?? '').replace(/^calc\.table/, '');
  return /^[A-Z]$/.test(code) ? code : 'A';
};

// ── Locale labels ───────────────────────────────────────────────

interface Labels {
  siteName: string;
  home: string;
  calcSection: string;
  grossIncome: string;
  socialDeductions: string;
  withholdingTax: string;
  irpefItaly: string;
  healthInsurance: string;
  netAnnual: string;
  netMonthly: string;
  chResident: string;
  itFrontier: string;
  savings: string;
  annual: string;
  monthly: string;
  taxTable: string;
  effectiveRate: string;
  familyAllowance: string;
  personalizeBtn: string;
  relatedTitle: string;
  faqTitle: string;
  breadcrumbCalc: string;
  oldFrontier: string;
  newFrontier: string;
  single: string;
  married: string;
  childrenLabel: (n: number) => string;
  within20: string;
  over20: string;
  howToCalcTitle: string;
  regimeTitle: string;
  familyTitle: string;
  distanceTitle: string;
  budgetTitle: string;
  tipsTitle: string;
  howToCalc: (salary: number, scenario: SalaryHubScenario, result: SimulationResult) => string;
  regimeExplain: (scenario: SalaryHubScenario, result: SimulationResult) => string;
  familyExplain: (scenario: SalaryHubScenario, result: SimulationResult) => string;
  distanceExplain: (scenario: SalaryHubScenario, result: SimulationResult) => string;
  budgetExplain: (scenario: SalaryHubScenario, result: SimulationResult) => string;
  tipsExplain: (scenario: SalaryHubScenario, result: SimulationResult) => string;
  metaTitle: (scenario: SalaryHubScenario) => string;
  metaDesc: (scenario: SalaryHubScenario, result: SimulationResult) => string;
  h1: (scenario: SalaryHubScenario) => string;
  subtitle: (scenario: SalaryHubScenario, result: SimulationResult) => string;
  faqItems: (scenario: SalaryHubScenario, result: SimulationResult) => Array<{ q: string; a: string }>;
}

function scenarioDesc(s: SalaryHubScenario, l: Labels): string {
  const parts: string[] = [];
  if (s.maritalStatus === 'MARRIED') parts.push(l.married);
  else parts.push(l.single);
  if (s.children > 0) parts.push(l.childrenLabel(s.children));
  if (s.frontierType === 'OLD') parts.push(l.oldFrontier);
  else parts.push(l.newFrontier);
  if (s.distanceZone === 'OVER_20KM') parts.push(l.over20);
  else parts.push(l.within20);
  return parts.join(', ');
}

// ── Italian labels ──────────────────────────────────────────────

/**
 * Verdetto unico del confronto netto Permesso B / Permesso G. Tile, consiglio,
 * FAQ, badge e budget leggono solo questo: `savingsCHF` e' netto frontaliere
 * meno netto residente, e chi ne rileggeva il segno a mano l'aveva invertito.
 */
export interface NetComparison {
  readonly winner: 'frontier' | 'resident' | 'tie';
  readonly gapCHF: number;
  readonly gapEUR: number;
}

type VerdictCopy = Record<NetComparison['winner'], (gapCHF: string, gapEUR: string) => string>;

export function compareNet(r: SimulationResult): NetComparison {
  const gap = r.itResident.netIncomeAnnual - r.chResident.netIncomeAnnual;
  const gapCHF = Math.abs(gap);
  if (gapCHF < 1) return { winner: 'tie', gapCHF: 0, gapEUR: 0 };
  return { winner: gap > 0 ? 'frontier' : 'resident', gapCHF, gapEUR: gapCHF * r.exchangeRate };
}

function verdictText(r: SimulationResult, copy: VerdictCopy): string {
  const c = compareNet(r);
  return copy[c.winner](fmtCHF(c.gapCHF), fmtEUR(c.gapEUR));
}

const IT: Labels = {
  siteName: 'Frontaliere Ticino',
  home: 'Home',
  calcSection: 'Calcola Stipendio',
  grossIncome: 'Reddito lordo annuo',
  socialDeductions: 'Contributi sociali (AVS/AD/LAA/IJM/LPP)',
  withholdingTax: 'Imposta alla fonte Ticino',
  irpefItaly: 'IRPEF Italia (saldo)',
  healthInsurance: 'Assicurazione malattia',
  netAnnual: 'Reddito netto annuo',
  netMonthly: 'Reddito netto mensile',
  chResident: 'Residente CH (Permesso B)',
  itFrontier: 'Frontaliere IT (Permesso G)',
  savings: 'Differenza',
  annual: 'annuo',
  monthly: 'mensile',
  taxTable: 'Tabella fiscale',
  effectiveRate: 'Aliquota effettiva',
  familyAllowance: 'Assegni familiari',
  personalizeBtn: 'Personalizza questa simulazione',
  relatedTitle: 'Scenari correlati',
  faqTitle: 'Domande frequenti',
  breadcrumbCalc: 'Calcola Stipendio',
  oldFrontier: 'vecchio frontaliere',
  newFrontier: 'nuovo frontaliere',
  single: 'single',
  married: 'sposato/a',
  childrenLabel: (n) => n === 1 ? '1 figlio' : `${n} figli`,
  within20: 'entro 20 km',
  over20: 'oltre 20 km',
  howToCalcTitle: 'Come si calcola lo stipendio netto',
  regimeTitle: 'Il regime fiscale applicato',
  familyTitle: 'Impatto della situazione familiare',
  distanceTitle: 'La zona di distanza dal confine',
  budgetTitle: 'Budget mensile indicativo',
  tipsTitle: 'Consigli pratici e servizi utili',
  howToCalc: (salary, s, r) =>
    `Con un reddito lordo di CHF ${fmtCHF(salary)} annui, il datore di lavoro svizzero trattiene contributi sociali obbligatori per circa CHF ${fmtCHF(r.chResident.socialContributions)}: AVS (5,3%), assicurazione disoccupazione (1,1%), LAINF (0,7%), indennità giornaliera malattia (0,8%) e previdenza professionale LPP (5% a 35 anni). A queste si aggiunge l'imposta alla fonte ticinese calcolata secondo la tabella ${taxTableCode(r.chResident.details.source)}, che per questo reddito corrisponde a un'aliquota effettiva del ${fmtPct(r.chResident.details.effectiveRate / 100)}%.`,
  regimeExplain: (s, r) => {
    if (s.frontierType === 'OLD') return `In qualità di vecchio frontaliere (art. 9 dell'Accordo Italia-Svizzera), il salario è imponibile soltanto in Svizzera tramite l'imposta alla fonte: su questo salario non c'è IRPEF italiana. L'aliquota effettiva complessiva è del ${fmtPct(r.itResident.details.effectiveRate / 100)}%.`;
    const ch = s.distanceZone === 'WITHIN_20KM'
      ? 'Come nuovo frontaliere (Accordo applicato dal 1° gennaio 2024), la Svizzera preleva l\'80% dell\'imposta alla fonte ordinaria.'
      : 'Oltre la fascia dei 20 km non si è frontalieri ai sensi dell\'Accordo: la Svizzera applica la ritenuta alla fonte ordinaria.';
    return `${ch} L'Italia tassa il reddito con una franchigia di €10.000, se ne ricorrono i requisiti, e riconosce un credito per l'imposta svizzera entro la quota di IRPEF proporzionale al reddito estero. Il saldo IRPEF netto è di circa EUR ${fmtEUR(r.itResident.details.irpefDetails?.finalNetTaxEUR ?? 0)}.`;
  },
  familyExplain: (s, r) => {
    if (s.maritalStatus === 'MARRIED' && s.children > 0)
      return `Essendo sposato/a con ${s.children} ${s.children === 1 ? 'figlio' : 'figli'}, si applica la tabella fiscale ${r.chResident.details.source?.includes('B') ? 'B' : 'C'} con una riduzione dell'aliquota di ${(0.025 * s.children * 100).toFixed(1)} punti percentuali per i figli. Gli assegni familiari svizzeri ammontano a CHF ${fmtCHF(r.chResident.familyAllowance)}/anno (CHF ${fmtCHF(3000)} per figlio). In Italia, le detrazioni per figli a carico sono di EUR ${fmtEUR(950 * s.children)} più EUR 690 per coniuge a carico.`;
    if (s.children > 0)
      return `Con ${s.children} ${s.children === 1 ? 'figlio' : 'figli'} a carico, si applica la tabella H (genitore solo con figli) con aliquota ridotta. Gli assegni familiari svizzeri sono di CHF ${fmtCHF(r.chResident.familyAllowance)}/anno. In Italia sono previste detrazioni di EUR ${fmtEUR(950 * s.children)} per figli a carico.`;
    if (s.maritalStatus === 'MARRIED')
      return `Come persona sposata senza figli, si applica la tabella B (coniuge non lavoratore) che offre un'aliquota più bassa rispetto alla tabella A dei single. In Italia, la detrazione per coniuge a carico è di EUR 690.`;
    return `Come persona single senza figli, si applica la tabella A dell'imposta alla fonte, la più standard. Non sono previsti assegni familiari né detrazioni per carichi di famiglia.`;
  },
  distanceExplain: (s, _r) => {
    if (s.distanceZone !== 'WITHIN_20KM') return `Chi risiede oltre la fascia dei 20 km non è frontaliere ai sensi dell'Accordo: ritenuta alla fonte ordinaria in Svizzera e tassazione in Italia con credito per l'imposta svizzera. La franchigia di €10.000 non è esclusa dalla sola distanza, se ne ricorrono i requisiti.`;
    if (s.frontierType === 'OLD') return `La qualifica richiede la residenza in un Comune dell'elenco ufficiale, con territorio anche solo in parte nella fascia dei 20 km, e il rientro in linea di principio quotidiano. I Cantoni Ticino, Grigioni e Vallese versano all'Italia una compensazione del 40% fino all'anno fiscale 2033: non modifica il tuo netto.`;
    return `Se sono soddisfatti tutti i requisiti dell'Accordo (Comune dell'elenco ufficiale, lavoro in Ticino, Grigioni o Vallese, rientro in linea di principio quotidiano), la ritenuta svizzera è pari all'80% di quella ordinaria. Il restante 20% non viene prelevato. Il credito italiano riguarda l'imposta svizzera effettivamente dovuta.`;
  },
  budgetExplain: (s, r) => {
    const monthCH = r.chResident.netIncomeMonthly;
    const monthIT = r.itResident.netIncomeMonthly;
    const rate = r.exchangeRate;
    return `Su base mensile, un residente in Svizzera con questo reddito netta circa CHF ${fmtCHF(monthCH)}, mentre un frontaliere italiano riceve uno stipendio netto svizzero che convertito corrisponde a circa EUR ${fmtEUR(monthIT * rate)}/mese (al cambio CHF/EUR ${rate.toFixed(3)}). ${verdictText(r, {
      frontier: () => `La differenza mensile è di circa CHF ${fmtCHF(compareNet(r).gapCHF / 12)} a favore del frontaliere.`,
      resident: () => `La differenza mensile è di circa CHF ${fmtCHF(compareNet(r).gapCHF / 12)} a favore del residente.`,
      tie: () => 'Il netto mensile è praticamente lo stesso.',
    })}`;
  },
  tipsExplain: (_s, _r) =>
    `Per ottimizzare il cambio CHF-EUR sullo stipendio, servizi come <a href="/go/wise/" rel="sponsored">Wise</a> o <a href="/go/fineco/" rel="sponsored">Fineco</a> offrono tassi di cambio più vantaggiosi rispetto alle banche tradizionali, con commissioni trasparenti. Se ricevi lo stipendio in CHF, convertire tramite questi servizi può farti risparmiare centinaia di euro all'anno rispetto al cambio bancario standard.`,
  metaTitle: (s) => {
    // Compact format keeps the headline + brand suffix inside the
    // universal 70-char SERP cap. Older format ("Stipendio netto …
    // frontaliere vecchio sposato 3 figli oltre 20km | Simulazione 2026")
    // overflowed and got truncated to a non-distinctive prefix, collapsing
    // ~120 scenario titles to ~10 unique ones and tripping
    // audit:title-uniqueness. Order: salary → frontier type → marital →
    // children (compact "Nf") → distance zone (compact "≤20km/>20km").
    // Brand suffix " | Frontaliere Ticino" is appended downstream by
    // buildSeoPageHtml/buildTitleWithBrand.
    const parts = [`Netto ${fmtCHF(s.salary)} CHF`];
    parts.push(s.frontierType === 'NEW' ? 'nuovo' : 'vecchio');
    if (s.maritalStatus === 'MARRIED') parts.push('sposato');
    if (s.children > 0) parts.push(`${s.children}f`);
    if (s.distanceZone === 'WITHIN_20KM') parts.push('≤20km');
    else if (s.distanceZone === 'OVER_20KM') parts.push('>20km');
    return parts.join(' ');
  },
  metaDesc: (s, r) => {
    const netMonthEUR = fmtEUR(r.itResident.netIncomeMonthly * r.exchangeRate);
    return `Con ${fmtCHF(s.salary)} CHF lordi, un frontaliere ${s.frontierType === 'OLD' ? 'vecchio' : 'nuovo'} ${s.maritalStatus === 'MARRIED' ? 'sposato' : 'single'}${s.children > 0 ? ` con ${s.children} figli` : ''} netta circa EUR ${netMonthEUR}/mese. Tabella ${taxTableCode(r.chResident.details.source)}, aliquota ${fmtPct(r.itResident.details.effectiveRate / 100)}%. Simulazione 2026.`;
  },
  h1: (s) => {
    const parts = [`Stipendio Netto ${fmtCHF(s.salary)} CHF`];
    if (s.maritalStatus === 'MARRIED') parts.push('Sposato');
    if (s.children > 0) parts.push(s.children === 1 ? '1 Figlio' : `${s.children} Figli`);
    if (s.frontierType === 'OLD') parts.push('Vecchio Frontaliere');
    if (s.distanceZone === 'OVER_20KM') parts.push('Oltre 20 km');
    return parts.join(' — ');
  },
  subtitle: (s, r) =>
    `Simulazione completa dello stipendio netto per un frontaliere con reddito lordo CHF ${fmtCHF(s.salary)} — confronto tra residente in Svizzera e frontaliere italiano.`,
  faqItems: (s, r) => [
    {
      q: `Quanto è lo stipendio netto con ${fmtCHF(s.salary)} CHF lordi per un frontaliere?`,
      a: `Un frontaliere ${s.frontierType === 'OLD' ? 'vecchio' : 'nuovo'} con ${fmtCHF(s.salary)} CHF lordi netta circa CHF ${fmtCHF(r.itResident.netIncomeAnnual)} annui (CHF ${fmtCHF(r.itResident.netIncomeMonthly)}/mese). Come residente in Svizzera, il netto sarebbe CHF ${fmtCHF(r.chResident.netIncomeAnnual)} annui.`,
    },
    {
      q: `Quale tabella fiscale si applica con ${fmtCHF(s.salary)} CHF ${s.maritalStatus === 'MARRIED' ? 'da sposato' : 'da single'}?`,
      a: `Si applica la tabella ${taxTableCode(r.chResident.details.source)} dell'imposta alla fonte ticinese, con un'aliquota effettiva del ${fmtPct(r.chResident.details.effectiveRate / 100)}% sul reddito lordo.`,
    },
    {
      q: `Conviene vivere in Svizzera o fare il frontaliere con ${fmtCHF(s.salary)} CHF?`,
      a: verdictText(r, {
        frontier: (gap, gapEUR) => `Sul netto, il frontaliere ha un vantaggio di circa CHF ${gap} annui (EUR ${gapEUR}) rispetto al residente svizzero. Il calcolo non include affitto e costo della vita.`,
        resident: (gap, gapEUR) => `Sul netto, il residente svizzero ha un vantaggio di circa CHF ${gap} annui (EUR ${gapEUR}) rispetto al frontaliere. Il calcolo non include affitto e costo della vita.`,
        tie: () => 'Con questo profilo il netto è praticamente lo stesso. Il calcolo non include affitto e costo della vita.',
      }),
    },
  ],
};

// ── Simplified EN/DE/FR (share same structure, translated labels) ─

const EN: Labels = {
  ...IT,
  siteName: 'Frontaliere Ticino',
  home: 'Home',
  calcSection: 'Calculate Salary',
  grossIncome: 'Annual gross income',
  socialDeductions: 'Social contributions (AVS/AD/LAA/IJM/LPP)',
  withholdingTax: 'Ticino withholding tax',
  irpefItaly: 'Italian IRPEF (balance)',
  healthInsurance: 'Health insurance',
  netAnnual: 'Annual net income',
  netMonthly: 'Monthly net income',
  chResident: 'CH Resident (Permit B)',
  itFrontier: 'IT Cross-border (Permit G)',
  savings: 'Difference',
  annual: 'annual',
  monthly: 'monthly',
  taxTable: 'Tax table',
  effectiveRate: 'Effective rate',
  familyAllowance: 'Family allowances',
  personalizeBtn: 'Customize this simulation',
  relatedTitle: 'Related scenarios',
  faqTitle: 'Frequently asked questions',
  breadcrumbCalc: 'Calculate Salary',
  oldFrontier: 'old cross-border worker',
  newFrontier: 'new cross-border worker',
  single: 'single',
  married: 'married',
  childrenLabel: (n) => n === 1 ? '1 child' : `${n} children`,
  within20: 'within 20 km',
  over20: 'over 20 km',
  howToCalcTitle: 'How net salary is calculated',
  regimeTitle: 'Tax regime applied',
  familyTitle: 'Family situation impact',
  distanceTitle: 'Border distance zone',
  budgetTitle: 'Indicative monthly budget',
  tipsTitle: 'Practical tips and useful services',
  howToCalc: (salary, s, r) =>
    `With a gross annual income of CHF ${fmtCHF(salary)}, the Swiss employer withholds mandatory social contributions of approximately CHF ${fmtCHF(r.chResident.socialContributions)}: AVS (5.3%), unemployment insurance (1.1%), accident insurance (0.7%), daily sickness allowance (0.8%), and occupational pension LPP. The Ticino withholding tax is calculated using table ${taxTableCode(r.chResident.details.source)}, resulting in an effective rate of ${fmtPct(r.chResident.details.effectiveRate / 100)}%.`,
  regimeExplain: (s, r) => {
    if (s.frontierType === 'OLD') return `As an old cross-border worker (Article 9 of the Italy-Switzerland agreement), your salary is taxable only in Switzerland through withholding tax: no Italian IRPEF is due on it. The overall effective rate is ${fmtPct(r.itResident.details.effectiveRate / 100)}%.`;
    const ch = s.distanceZone === 'WITHIN_20KM'
      ? 'As a new cross-border worker (agreement applied since 1 January 2024), Switzerland levies 80% of the ordinary withholding tax.'
      : 'Beyond the 20 km zone you are not a cross-border worker under the agreement: Switzerland applies the ordinary withholding tax.';
    return `${ch} Italy taxes the income with a €10,000 exemption, where the requirements are met, and grants a credit for Swiss tax up to the IRPEF share proportional to foreign income. The net IRPEF balance is about EUR ${fmtEUR(r.itResident.details.irpefDetails?.finalNetTaxEUR ?? 0)}.`;
  },
  familyExplain: (s, r) =>
    s.maritalStatus === 'MARRIED'
      ? `As a married person${s.children > 0 ? ` with ${s.children} ${s.children === 1 ? 'child' : 'children'}` : ''}, tax table ${r.chResident.details.source?.includes('B') ? 'B' : 'C'} applies with reduced rates. Swiss family allowances amount to CHF ${fmtCHF(r.chResident.familyAllowance)}/year.`
      : `As a single person${s.children > 0 ? ` with ${s.children} ${s.children === 1 ? 'child' : 'children'}` : ''}, tax table ${s.children > 0 ? 'H' : 'A'} applies. ${s.children > 0 ? `Swiss family allowances: CHF ${fmtCHF(r.chResident.familyAllowance)}/year.` : 'No family allowances apply.'}`,
  distanceExplain: (s, _r) => {
    if (s.distanceZone !== 'WITHIN_20KM') return `Living beyond the 20 km zone, you are not a cross-border worker under the agreement: ordinary Swiss withholding tax, and taxation in Italy with a credit for Swiss tax. The €10,000 exemption is not ruled out by distance alone, where its requirements are met.`;
    if (s.frontierType === 'OLD') return `The status requires residence in a municipality on the official list, with territory at least partly inside the 20 km zone, and a return home that is in principle daily. The cantons of Ticino, Graubünden and Valais pay Italy a 40% compensation through tax year 2033: it does not change your net pay.`;
    return `If all the agreement's requirements are met (municipality on the official list, work in Ticino, Graubünden or Valais, return home in principle daily), Swiss withholding is 80% of the ordinary amount. The remaining 20% is not levied. The Italian credit covers the Swiss tax actually due.`;
  },
  budgetExplain: (s, r) =>
    `Monthly, a Swiss resident nets approximately CHF ${fmtCHF(r.chResident.netIncomeMonthly)}, while an Italian cross-border worker receives about EUR ${fmtEUR(r.itResident.netIncomeMonthly * r.exchangeRate)}/month (at CHF/EUR ${r.exchangeRate.toFixed(3)}). ${verdictText(r, {
      frontier: () => `The monthly gap is about CHF ${fmtCHF(compareNet(r).gapCHF / 12)} in favour of the cross-border worker.`,
      resident: () => `The monthly gap is about CHF ${fmtCHF(compareNet(r).gapCHF / 12)} in favour of the Swiss resident.`,
      tie: () => 'Monthly net pay is practically the same.',
    })}`,
  tipsExplain: (_s, _r) =>
    `To optimize your CHF-EUR conversion, services like <a href="/go/wise/" rel="sponsored">Wise</a> or <a href="/go/fineco/" rel="sponsored">Fineco</a> offer better exchange rates than traditional banks.`,
  metaTitle: (s) => {
    // Compact format — see the IT metaTitle for the rationale.
    const parts = [`Net ${fmtCHF(s.salary)} CHF`];
    parts.push(s.frontierType === 'NEW' ? 'new' : 'old');
    if (s.maritalStatus === 'MARRIED') parts.push('married');
    if (s.children > 0) parts.push(`${s.children}c`);
    if (s.distanceZone === 'WITHIN_20KM') parts.push('≤20km');
    else if (s.distanceZone === 'OVER_20KM') parts.push('>20km');
    return parts.join(' ');
  },
  metaDesc: (s, r) => `With CHF ${fmtCHF(s.salary)} gross, a ${s.frontierType === 'OLD' ? 'old' : 'new'} cross-border worker nets approximately EUR ${fmtEUR(r.itResident.netIncomeMonthly * r.exchangeRate)}/month. 2026 simulation with full tax breakdown.`,
  h1: (s) => {
    const parts = [`Net Salary CHF ${fmtCHF(s.salary)}`];
    if (s.maritalStatus === 'MARRIED') parts.push('Married');
    if (s.children > 0) parts.push(s.children === 1 ? '1 Child' : `${s.children} Children`);
    if (s.frontierType === 'OLD') parts.push('Old Cross-Border Worker');
    if (s.distanceZone === 'OVER_20KM') parts.push('Over 20 km');
    return parts.join(' — ');
  },
  subtitle: (s, _r) => `Full net salary simulation for a cross-border worker earning CHF ${fmtCHF(s.salary)} gross — Swiss resident vs Italian cross-border comparison.`,
  faqItems: (s, r) => [
    {
      q: `What is the net salary with CHF ${fmtCHF(s.salary)} gross as a cross-border worker?`,
      a: `${s.frontierType === 'OLD' ? 'An old' : 'A new'} cross-border worker earning CHF ${fmtCHF(s.salary)} gross nets approximately CHF ${fmtCHF(r.itResident.netIncomeAnnual)} annually (CHF ${fmtCHF(r.itResident.netIncomeMonthly)}/month).`,
    },
    {
      q: `Which tax table applies to CHF ${fmtCHF(s.salary)} ${s.maritalStatus === 'MARRIED' ? 'married' : 'single'}?`,
      a: `Tax table ${taxTableCode(r.chResident.details.source)} applies with an effective rate of ${fmtPct(r.chResident.details.effectiveRate / 100)}%.`,
    },
    {
      q: `Is it better to live in Switzerland or commute with CHF ${fmtCHF(s.salary)}?`,
      a: verdictText(r, {
        frontier: (gap, gapEUR) => `On net pay, the cross-border worker is ahead by about CHF ${gap} a year (EUR ${gapEUR}) compared to a Swiss resident. Rent and cost of living are not included.`,
        resident: (gap, gapEUR) => `On net pay, the Swiss resident is ahead by about CHF ${gap} a year (EUR ${gapEUR}) compared to a cross-border worker. Rent and cost of living are not included.`,
        tie: () => 'With this profile the net pay is practically the same. Rent and cost of living are not included.',
      }),
    },
  ],
};

const DE: Labels = {
  ...EN,
  taxTable: 'Steuertabelle',
  effectiveRate: 'Effektiver Satz',
  familyAllowance: 'Familienzulagen',
  howToCalc: (salary, _s, r) =>
    `Bei einem Bruttojahreseinkommen von CHF ${fmtCHF(salary)} behält der Schweizer Arbeitgeber obligatorische Sozialabzüge von rund CHF ${fmtCHF(r.chResident.socialContributions)} ein: AHV/IV/EO (5,3%), Arbeitslosenversicherung (1,1%), Unfallversicherung (0,7%), Krankentaggeld (0,8%) und berufliche Vorsorge BVG (5% mit 35 Jahren). Hinzu kommt die Tessiner Quellensteuer nach Tabelle ${taxTableCode(r.chResident.details.source)}, was einem effektiven Satz von ${fmtPct(r.chResident.details.effectiveRate / 100)}% entspricht.`,
  regimeExplain: (s, r) => {
    if (s.frontierType === 'OLD') return `Als alter Grenzgänger (Art. 9 des Abkommens Italien-Schweiz) ist Ihr Lohn nur in der Schweiz über die Quellensteuer steuerbar: Auf diesen Lohn fällt keine italienische IRPEF an. Der effektive Gesamtsatz beträgt ${fmtPct(r.itResident.details.effectiveRate / 100)}%.`;
    const ch = s.distanceZone === 'WITHIN_20KM'
      ? 'Als neuer Grenzgänger (Abkommen seit dem 1. Januar 2024 angewendet) erhebt die Schweiz 80% der ordentlichen Quellensteuer.'
      : 'Ausserhalb der 20-km-Zone sind Sie kein Grenzgänger im Sinne des Abkommens: Die Schweiz wendet die ordentliche Quellensteuer an.';
    return `${ch} Italien besteuert das Einkommen mit einem Freibetrag von €10.000, sofern die Voraussetzungen erfüllt sind, und gewährt eine Anrechnung der Schweizer Steuer bis zum IRPEF-Anteil, der dem ausländischen Einkommen entspricht. Der IRPEF-Nettosaldo beträgt rund EUR ${fmtEUR(r.itResident.details.irpefDetails?.finalNetTaxEUR ?? 0)}.`;
  },
  familyExplain: (s, r) => {
    const kids = s.children > 0 ? ` mit ${s.children} ${s.children === 1 ? 'Kind' : 'Kindern'}` : '';
    const allowance = s.children > 0 ? ` Schweizer Familienzulagen: CHF ${fmtCHF(r.chResident.familyAllowance)}/Jahr.` : '';
    return s.maritalStatus === 'MARRIED'
      ? `Für verheiratete Personen${kids} gilt Tabelle ${r.chResident.details.source?.includes('B') ? 'B' : 'C'} mit reduzierten Sätzen.${allowance}`
      : `Für ledige Personen${kids} gilt Tabelle ${s.children > 0 ? 'H' : 'A'}.${allowance}`;
  },
  distanceExplain: (s, _r) => {
    if (s.distanceZone !== 'WITHIN_20KM') return `Wer ausserhalb der 20-km-Zone wohnt, ist kein Grenzgänger im Sinne des Abkommens: ordentliche Quellensteuer in der Schweiz und Besteuerung in Italien mit Anrechnung der Schweizer Steuer. Der Freibetrag von €10.000 ist nicht allein wegen der Distanz ausgeschlossen, sofern seine Voraussetzungen erfüllt sind.`;
    if (s.frontierType === 'OLD') return `Der Status setzt den Wohnsitz in einer Gemeinde der offiziellen Liste voraus, deren Gebiet mindestens teilweise in der 20-km-Zone liegt, sowie die grundsätzlich tägliche Rückkehr. Die Kantone Tessin, Graubünden und Wallis zahlen Italien bis zum Steuerjahr 2033 eine Ausgleichszahlung von 40%: Sie verändert Ihren Nettolohn nicht.`;
    return `Sind alle Voraussetzungen des Abkommens erfüllt (Gemeinde der offiziellen Liste, Arbeit im Tessin, in Graubünden oder im Wallis, grundsätzlich tägliche Rückkehr), beträgt die Schweizer Quellensteuer 80% der ordentlichen. Die restlichen 20% werden nicht erhoben. Die italienische Anrechnung betrifft die tatsächlich geschuldete Schweizer Steuer.`;
  },
  budgetExplain: (s, r) =>
    `Monatlich erzielt ein Einwohner der Schweiz rund CHF ${fmtCHF(r.chResident.netIncomeMonthly)} netto, ein italienischer Grenzgänger rund EUR ${fmtEUR(r.itResident.netIncomeMonthly * r.exchangeRate)} (Kurs CHF/EUR ${r.exchangeRate.toFixed(3)}). ${verdictText(r, {
      frontier: () => `Die monatliche Differenz beträgt rund CHF ${fmtCHF(compareNet(r).gapCHF / 12)} zugunsten des Grenzgängers.`,
      resident: () => `Die monatliche Differenz beträgt rund CHF ${fmtCHF(compareNet(r).gapCHF / 12)} zugunsten des Einwohners.`,
      tie: () => 'Der monatliche Nettolohn ist praktisch gleich.',
    })}`,
  tipsExplain: (_s, _r) =>
    `Für den Wechsel von CHF in EUR bieten Dienste wie <a href="/go/wise/" rel="sponsored">Wise</a> oder <a href="/go/fineco/" rel="sponsored">Fineco</a> bessere Kurse als traditionelle Banken.`,
  home: 'Startseite',
  calcSection: 'Gehalt berechnen',
  grossIncome: 'Jährliches Bruttoeinkommen',
  socialDeductions: 'Sozialabzüge (AHV/ALV/UVG/KTG/BVG)',
  withholdingTax: 'Tessiner Quellensteuer',
  irpefItaly: 'Italienische IRPEF (Saldo)',
  healthInsurance: 'Krankenversicherung',
  netAnnual: 'Jährliches Nettoeinkommen',
  netMonthly: 'Monatliches Nettoeinkommen',
  chResident: 'CH-Wohnsitz (Bewilligung B)',
  itFrontier: 'IT-Grenzgänger (Bewilligung G)',
  savings: 'Differenz',
  annual: 'jährlich',
  monthly: 'monatlich',
  personalizeBtn: 'Diese Simulation anpassen',
  relatedTitle: 'Verwandte Szenarien',
  faqTitle: 'Häufig gestellte Fragen',
  breadcrumbCalc: 'Gehalt berechnen',
  oldFrontier: 'alter Grenzgänger',
  newFrontier: 'neuer Grenzgänger',
  single: 'ledig',
  married: 'verheiratet',
  childrenLabel: (n) => n === 1 ? '1 Kind' : `${n} Kinder`,
  within20: 'innerhalb 20 km',
  over20: 'über 20 km',
  howToCalcTitle: 'Wie das Nettogehalt berechnet wird',
  regimeTitle: 'Angewandtes Steuerregime',
  familyTitle: 'Auswirkung der Familiensituation',
  distanceTitle: 'Grenz-Distanzzone',
  budgetTitle: 'Indikatives Monatsbudget',
  tipsTitle: 'Praktische Tipps',
  metaTitle: (s) => {
    // Compact format — see the IT metaTitle for the rationale.
    const parts = [`Netto ${fmtCHF(s.salary)} CHF`];
    parts.push(s.frontierType === 'NEW' ? 'neuer' : 'alter');
    if (s.maritalStatus === 'MARRIED') parts.push('verh.');
    if (s.children > 0) parts.push(`${s.children}K`);
    if (s.distanceZone === 'WITHIN_20KM') parts.push('≤20km');
    else if (s.distanceZone === 'OVER_20KM') parts.push('>20km');
    return parts.join(' ');
  },
  metaDesc: (s, r) => `Mit CHF ${fmtCHF(s.salary)} brutto erzielt ein ${s.frontierType === 'OLD' ? 'alter' : 'neuer'} Grenzgänger netto ca. EUR ${fmtEUR(r.itResident.netIncomeMonthly * r.exchangeRate)}/Monat. Simulation 2026.`,
  h1: (s) => {
    const parts = [`Nettogehalt CHF ${fmtCHF(s.salary)}`];
    if (s.maritalStatus === 'MARRIED') parts.push('Verheiratet');
    if (s.children > 0) parts.push(s.children === 1 ? '1 Kind' : `${s.children} Kinder`);
    if (s.frontierType === 'OLD') parts.push('Alter Grenzgänger');
    if (s.distanceZone === 'OVER_20KM') parts.push('Über 20 km');
    return parts.join(' — ');
  },
  subtitle: (s, _r) => `Vollständige Nettogehalt-Simulation für einen Grenzgänger mit CHF ${fmtCHF(s.salary)} brutto — Vergleich CH-Wohnsitz vs. IT-Grenzgänger.`,
  faqItems: (s, r) => [
    {
      q: `Wie viel netto bei CHF ${fmtCHF(s.salary)} brutto als Grenzgänger?`,
      a: `Ein ${s.frontierType === 'OLD' ? 'alter' : 'neuer'} Grenzgänger mit CHF ${fmtCHF(s.salary)} brutto erzielt netto ca. CHF ${fmtCHF(r.itResident.netIncomeAnnual)} jährlich (CHF ${fmtCHF(r.itResident.netIncomeMonthly)}/Monat).`,
    },
    {
      q: `Welche Steuertabelle gilt für CHF ${fmtCHF(s.salary)} ${s.maritalStatus === 'MARRIED' ? 'verheiratet' : 'ledig'}?`,
      a: `Es gilt Tabelle ${taxTableCode(r.chResident.details.source)} mit einem effektiven Satz von ${fmtPct(r.chResident.details.effectiveRate / 100)}%.`,
    },
    {
      q: `Lohnt sich bei CHF ${fmtCHF(s.salary)} der Wohnsitz in der Schweiz oder das Grenzgängerdasein?`,
      a: verdictText(r, {
        frontier: (gap, gapEUR) => `Beim Nettolohn liegt der Grenzgänger rund CHF ${gap} pro Jahr (EUR ${gapEUR}) vor dem Schweizer Einwohner. Miete und Lebenshaltungskosten sind nicht berücksichtigt.`,
        resident: (gap, gapEUR) => `Beim Nettolohn liegt der Schweizer Einwohner rund CHF ${gap} pro Jahr (EUR ${gapEUR}) vor dem Grenzgänger. Miete und Lebenshaltungskosten sind nicht berücksichtigt.`,
        tie: () => 'Bei diesem Profil ist der Nettolohn praktisch gleich. Miete und Lebenshaltungskosten sind nicht berücksichtigt.',
      }),
    },
  ],
};

const FR: Labels = {
  ...EN,
  taxTable: 'Barème fiscal',
  effectiveRate: 'Taux effectif',
  familyAllowance: 'Allocations familiales',
  howToCalc: (salary, _s, r) =>
    `Avec un revenu brut annuel de CHF ${fmtCHF(salary)}, l'employeur suisse retient des cotisations sociales obligatoires d'environ CHF ${fmtCHF(r.chResident.socialContributions)} : AVS/AI/APG (5,3 %), assurance-chômage (1,1 %), assurance-accidents (0,7 %), indemnité journalière maladie (0,8 %) et prévoyance professionnelle LPP (5 % à 35 ans). S'y ajoute l'impôt à la source tessinois selon le barème ${taxTableCode(r.chResident.details.source)}, soit un taux effectif de ${fmtPct(r.chResident.details.effectiveRate / 100)} %.`,
  regimeExplain: (s, r) => {
    if (s.frontierType === 'OLD') return `En tant qu'ancien frontalier (art. 9 de l'accord Italie-Suisse), votre salaire est imposable uniquement en Suisse par l'impôt à la source : il n'y a pas d'IRPEF italienne sur ce salaire. Le taux effectif global est de ${fmtPct(r.itResident.details.effectiveRate / 100)} %.`;
    const ch = s.distanceZone === 'WITHIN_20KM'
      ? 'En tant que nouveau frontalier (accord appliqué depuis le 1er janvier 2024), la Suisse prélève 80 % de l\'impôt à la source ordinaire.'
      : 'Au-delà de la zone des 20 km, vous n\'êtes pas frontalier au sens de l\'accord : la Suisse applique l\'impôt à la source ordinaire.';
    return `${ch} L'Italie impose le revenu avec une franchise de 10 000 €, si les conditions sont remplies, et accorde un crédit pour l'impôt suisse dans la limite de la part d'IRPEF proportionnelle au revenu étranger. Le solde net d'IRPEF est d'environ EUR ${fmtEUR(r.itResident.details.irpefDetails?.finalNetTaxEUR ?? 0)}.`;
  },
  familyExplain: (s, r) => {
    const kids = s.children > 0 ? ` avec ${s.children} ${s.children === 1 ? 'enfant' : 'enfants'}` : '';
    const allowance = s.children > 0 ? ` Allocations familiales suisses : CHF ${fmtCHF(r.chResident.familyAllowance)}/an.` : '';
    return s.maritalStatus === 'MARRIED'
      ? `Pour une personne mariée${kids}, le barème ${r.chResident.details.source?.includes('B') ? 'B' : 'C'} s'applique avec des taux réduits.${allowance}`
      : `Pour une personne célibataire${kids}, le barème ${s.children > 0 ? 'H' : 'A'} s'applique.${allowance}`;
  },
  distanceExplain: (s, _r) => {
    if (s.distanceZone !== 'WITHIN_20KM') return `Qui réside au-delà de la zone des 20 km n'est pas frontalier au sens de l'accord : impôt à la source ordinaire en Suisse et imposition en Italie avec crédit pour l'impôt suisse. La franchise de 10 000 € n'est pas exclue par la seule distance, si ses conditions sont remplies.`;
    if (s.frontierType === 'OLD') return `Le statut exige la résidence dans une commune de la liste officielle, dont le territoire se situe au moins en partie dans la zone des 20 km, et un retour en principe quotidien. Les cantons du Tessin, des Grisons et du Valais versent à l'Italie une compensation de 40 % jusqu'à l'année fiscale 2033 : elle ne change pas votre net.`;
    return `Si toutes les conditions de l'accord sont remplies (commune de la liste officielle, travail au Tessin, aux Grisons ou en Valais, retour en principe quotidien), la retenue suisse correspond à 80 % de la retenue ordinaire. Les 20 % restants ne sont pas prélevés. Le crédit italien porte sur l'impôt suisse effectivement dû.`;
  },
  budgetExplain: (s, r) =>
    `Par mois, un résident suisse perçoit environ CHF ${fmtCHF(r.chResident.netIncomeMonthly)} nets, un frontalier italien environ EUR ${fmtEUR(r.itResident.netIncomeMonthly * r.exchangeRate)} (taux CHF/EUR ${r.exchangeRate.toFixed(3)}). ${verdictText(r, {
      frontier: () => `L'écart mensuel est d'environ CHF ${fmtCHF(compareNet(r).gapCHF / 12)} en faveur du frontalier.`,
      resident: () => `L'écart mensuel est d'environ CHF ${fmtCHF(compareNet(r).gapCHF / 12)} en faveur du résident.`,
      tie: () => 'Le net mensuel est pratiquement identique.',
    })}`,
  tipsExplain: (_s, _r) =>
    `Pour convertir vos CHF en EUR, des services comme <a href="/go/wise/" rel="sponsored">Wise</a> ou <a href="/go/fineco/" rel="sponsored">Fineco</a> offrent de meilleurs taux que les banques traditionnelles.`,
  home: 'Accueil',
  calcSection: 'Calculer salaire',
  grossIncome: 'Revenu brut annuel',
  socialDeductions: 'Cotisations sociales (AVS/AC/LAA/IJM/LPP)',
  withholdingTax: 'Impôt à la source tessinois',
  irpefItaly: 'IRPEF Italie (solde)',
  healthInsurance: 'Assurance maladie',
  netAnnual: 'Revenu net annuel',
  netMonthly: 'Revenu net mensuel',
  chResident: 'Résident CH (Permis B)',
  itFrontier: 'Frontalier IT (Permis G)',
  savings: 'Différence',
  annual: 'annuel',
  monthly: 'mensuel',
  personalizeBtn: 'Personnaliser cette simulation',
  relatedTitle: 'Scénarios similaires',
  faqTitle: 'Questions fréquentes',
  breadcrumbCalc: 'Calculer salaire',
  oldFrontier: 'ancien frontalier',
  newFrontier: 'nouveau frontalier',
  single: 'célibataire',
  married: 'marié(e)',
  childrenLabel: (n) => n === 1 ? '1 enfant' : `${n} enfants`,
  within20: 'moins de 20 km',
  over20: 'plus de 20 km',
  howToCalcTitle: 'Comment le salaire net est calculé',
  regimeTitle: 'Régime fiscal appliqué',
  familyTitle: 'Impact de la situation familiale',
  distanceTitle: 'Zone de distance frontalière',
  budgetTitle: 'Budget mensuel indicatif',
  tipsTitle: 'Conseils pratiques',
  metaTitle: (s) => {
    // Compact format — see the IT metaTitle for the rationale.
    const parts = [`Net ${fmtCHF(s.salary)} CHF`];
    parts.push(s.frontierType === 'NEW' ? 'nouveau' : 'ancien');
    if (s.maritalStatus === 'MARRIED') parts.push('marié');
    if (s.children > 0) parts.push(`${s.children}e`);
    if (s.distanceZone === 'WITHIN_20KM') parts.push('≤20km');
    else if (s.distanceZone === 'OVER_20KM') parts.push('>20km');
    return parts.join(' ');
  },
  metaDesc: (s, r) => `Avec CHF ${fmtCHF(s.salary)} brut, un ${s.frontierType === 'OLD' ? 'ancien' : 'nouveau'} frontalier perçoit environ EUR ${fmtEUR(r.itResident.netIncomeMonthly * r.exchangeRate)}/mois. Simulation 2026.`,
  h1: (s) => {
    const parts = [`Salaire Net CHF ${fmtCHF(s.salary)}`];
    if (s.maritalStatus === 'MARRIED') parts.push('Marié');
    if (s.children > 0) parts.push(s.children === 1 ? '1 Enfant' : `${s.children} Enfants`);
    if (s.frontierType === 'OLD') parts.push('Ancien Frontalier');
    if (s.distanceZone === 'OVER_20KM') parts.push('Plus de 20 km');
    return parts.join(' — ');
  },
  subtitle: (s, _r) => `Simulation complète du salaire net pour un frontalier gagnant CHF ${fmtCHF(s.salary)} brut — comparaison résident CH vs frontalier IT.`,
  faqItems: (s, r) => [
    {
      q: `Quel est le salaire net avec CHF ${fmtCHF(s.salary)} brut en tant que frontalier?`,
      a: `Un ${s.frontierType === 'OLD' ? 'ancien' : 'nouveau'} frontalier avec CHF ${fmtCHF(s.salary)} brut perçoit environ CHF ${fmtCHF(r.itResident.netIncomeAnnual)} net par an (CHF ${fmtCHF(r.itResident.netIncomeMonthly)}/mois).`,
    },
    {
      q: `Quel barème fiscal s'applique pour CHF ${fmtCHF(s.salary)} ${s.maritalStatus === 'MARRIED' ? 'marié' : 'célibataire'}?`,
      a: `Le barème ${taxTableCode(r.chResident.details.source)} s'applique avec un taux effectif de ${fmtPct(r.chResident.details.effectiveRate / 100)}%.`,
    },
    {
      q: `Vaut-il mieux résider en Suisse ou être frontalier avec CHF ${fmtCHF(s.salary)} ?`,
      a: verdictText(r, {
        frontier: (gap, gapEUR) => `Sur le salaire net, le frontalier a un avantage d'environ CHF ${gap} par an (EUR ${gapEUR}) sur le résident suisse. Le loyer et le coût de la vie ne sont pas inclus.`,
        resident: (gap, gapEUR) => `Sur le salaire net, le résident suisse a un avantage d'environ CHF ${gap} par an (EUR ${gapEUR}) sur le frontalier. Le loyer et le coût de la vie ne sont pas inclus.`,
        tie: () => 'Avec ce profil, le salaire net est pratiquement identique. Le loyer et le coût de la vie ne sont pas inclus.',
      }),
    },
  ],
};

const LABELS: Record<Locale, Labels> = { it: IT, en: EN, de: DE, fr: FR };

// ── HTML generation ─────────────────────────────────────────────

function resultsTableHtml(result: SimulationResult, l: Labels): string {
  const ch = result.chResident;
  const it = result.itResident;
  const row = (label: string, chVal: number, itVal: number, isCHF = true) => {
    const fmt = isCHF ? fmtCHF : fmtEUR;
    const cur = isCHF ? 'CHF' : 'EUR';
    return `<tr><td>${label}</td><td class="num">${cur} ${fmt(chVal)}</td><td class="num">${cur} ${fmt(itVal)}</td></tr>`;
  };
  return `
    <div class="results-table-wrap">
      <table class="results-table">
        <thead><tr><th></th><th>${l.chResident}</th><th>${l.itFrontier}</th></tr></thead>
        <tbody>
          ${row(l.grossIncome, ch.grossIncome, it.grossIncome)}
          ${row(l.familyAllowance, ch.familyAllowance, it.familyAllowance)}
          ${row(l.socialDeductions, -ch.socialContributions, -it.socialContributions)}
          ${row(l.withholdingTax, -ch.taxes, -(it.taxes - (it.details.irpefDetails?.finalNetTaxEUR ?? 0) / result.exchangeRate))}
          ${it.details.irpefDetails ? row(l.irpefItaly, 0, -(it.details.irpefDetails.finalNetTaxEUR / result.exchangeRate)) : ''}
          ${row(l.healthInsurance, -ch.healthInsurance, 0)}
          <tr class="net-row"><td><strong>${l.netAnnual}</strong></td><td class="num highlight"><strong>CHF ${fmtCHF(ch.netIncomeAnnual)}</strong></td><td class="num highlight"><strong>CHF ${fmtCHF(it.netIncomeAnnual)}</strong></td></tr>
          <tr class="net-row"><td><strong>${l.netMonthly}</strong></td><td class="num highlight"><strong>CHF ${fmtCHF(ch.netIncomeMonthly)}</strong></td><td class="num highlight"><strong>CHF ${fmtCHF(it.netIncomeMonthly)}</strong></td></tr>
        </tbody>
      </table>
      <div class="savings-badge ${{ frontier: 'positive', resident: 'negative', tie: 'neutral' }[compareNet(result).winner]}">
        ${l.savings}: <strong>CHF ${fmtCHF(compareNet(result).gapCHF)}</strong> ${l.annual}
        (EUR ${fmtEUR(compareNet(result).gapEUR)})
        ${compareNet(result).winner === 'tie' ? '' : `&#x2191; ${compareNet(result).winner === 'frontier' ? l.itFrontier : l.chResident}`}
      </div>
    </div>`;
}

// Per-locale strings the new mobile-first SEO-landing shell needs that aren't
// already in `Labels`. Kept tight on purpose — only the bits that the shell
// renders (eyebrow, 4 tile labels, advice template, secondary CTA copy).
//
// Note: These are intentionally NOT moved into `shared/salaryLandingShell`
// `LOCALE_PACKS`. SHELL_PACK is salaryHub-scoped:
//   - `eyebrow` and `advice` are functions of `SalaryHubScenario` /
//     `SimulationResult` — they can't be flat strings.
//   - The 4 tile labels describe the Permesso B vs G comparison that's
//     unique to per-scenario salary-hub pages. Other landings (net-comparison,
//     orphan hubs) use entirely different tile sets.
//   - `ctaSecondary` differs in semantics from `LOCALE_PACKS.ctaSecondary`
//     ("Compare similar scenarios" vs "Open what-if simulator") — same field
//     name, different intent.
//
// Promoting these to LOCALE_PACKS would couple two unrelated scopes and
// force every other consumer to ignore fields they don't need. Local pack
// is the right scope.
interface ShellPack {
  readonly eyebrow: (scenario: SalaryHubScenario) => string;
  readonly tileNetCh: string;
  readonly tileNetIt: string;
  readonly tileSavings: string;
  readonly tileExchange: string;
  readonly advice: Record<NetComparison['winner'], (gapCHF: string) => string>;
  readonly tileWinner: Record<NetComparison['winner'], string>;
  readonly perYear: string;
  readonly ctaSecondary: string;
}

const SHELL_PACK: Record<Locale, ShellPack> = {
  it: {
    eyebrow: (s) => `Simulazione netto · ${s.frontierType === 'NEW' ? 'Nuovo' : 'Vecchio'} frontaliere · ${s.distanceZone === 'WITHIN_20KM' ? 'Entro 20 km' : 'Oltre 20 km'}`,
    tileNetCh: 'Netto Permesso B',
    tileNetIt: 'Netto Permesso G',
    tileSavings: 'Netto più alto',
    tileExchange: 'Cambio CHF/EUR',
    perYear: '/anno',
    tileWinner: { frontier: 'Permesso G', resident: 'Permesso B', tie: 'Pari' },
    advice: {
      frontier: (gap) => `Il permesso G (frontaliere) rende ~CHF ${gap} netti in più all'anno rispetto al permesso B. Il confronto riguarda solo il netto: affitto e costo della vita sono esclusi.`,
      resident: (gap) => `Il permesso B (residente CH) rende ~CHF ${gap} netti in più all'anno rispetto al permesso G. Prima di cambiare residenza, confronta questa cifra con affitto e costo della vita in Ticino.`,
      tie: () => 'Permesso B e permesso G danno praticamente lo stesso netto: a decidere sono affitto e costo della vita.',
    },
    ctaSecondary: 'Confronta scenari simili',
  },
  en: {
    eyebrow: (s) => `Net simulation · ${s.frontierType === 'NEW' ? 'New' : 'Existing'} cross-border worker · ${s.distanceZone === 'WITHIN_20KM' ? 'Within 20 km' : 'Over 20 km'}`,
    tileNetCh: 'Net Permit B',
    tileNetIt: 'Net Permit G',
    tileSavings: 'Higher net',
    tileExchange: 'CHF/EUR rate',
    perYear: '/year',
    tileWinner: { frontier: 'Permit G', resident: 'Permit B', tie: 'Even' },
    advice: {
      frontier: (gap) => `Permit G (cross-border) takes home ~CHF ${gap} more per year than Permit B. This compares net pay only: rent and cost of living are excluded.`,
      resident: (gap) => `Permit B (Swiss resident) takes home ~CHF ${gap} more per year than Permit G. Before moving, weigh this figure against rent and cost of living in Ticino.`,
      tie: () => 'Permit B and Permit G give practically the same net pay: rent and cost of living decide.',
    },
    ctaSecondary: 'Compare similar scenarios',
  },
  de: {
    eyebrow: (s) => `Netto-Simulation · ${s.frontierType === 'NEW' ? 'Neuer' : 'Alter'} Grenzgänger · ${s.distanceZone === 'WITHIN_20KM' ? 'Bis 20 km' : 'Über 20 km'}`,
    tileNetCh: 'Netto B-Bewilligung',
    tileNetIt: 'Netto G-Bewilligung',
    tileSavings: 'Höheres Netto',
    tileExchange: 'CHF/EUR-Kurs',
    perYear: '/Jahr',
    tileWinner: { frontier: 'Bewilligung G', resident: 'Bewilligung B', tie: 'Gleich' },
    advice: {
      frontier: (gap) => `Die G-Bewilligung (Grenzgänger) bringt ~CHF ${gap} netto/Jahr mehr als die B-Bewilligung. Verglichen wird nur der Nettolohn: Miete und Lebenshaltungskosten sind nicht enthalten.`,
      resident: (gap) => `Die B-Bewilligung (CH-Wohnsitz) bringt ~CHF ${gap} netto/Jahr mehr als die G-Bewilligung. Vergleichen Sie diesen Betrag vor einem Umzug mit Miete und Lebenshaltungskosten im Tessin.`,
      tie: () => 'B- und G-Bewilligung ergeben praktisch denselben Nettolohn: Entscheidend sind Miete und Lebenshaltungskosten.',
    },
    ctaSecondary: 'Ähnliche Szenarien vergleichen',
  },
  fr: {
    eyebrow: (s) => `Simulation net · ${s.frontierType === 'NEW' ? 'Nouveau' : 'Ancien'} frontalier · ${s.distanceZone === 'WITHIN_20KM' ? 'Moins 20 km' : 'Plus 20 km'}`,
    tileNetCh: 'Net Permis B',
    tileNetIt: 'Net Permis G',
    tileSavings: 'Net le plus élevé',
    tileExchange: 'Taux CHF/EUR',
    perYear: '/an',
    tileWinner: { frontier: 'Permis G', resident: 'Permis B', tie: 'Égalité' },
    advice: {
      frontier: (gap) => `Le permis G (frontalier) rapporte ~CHF ${gap} nets/an de plus que le permis B. La comparaison porte sur le net seul : le loyer et le coût de la vie sont exclus.`,
      resident: (gap) => `Le permis B (résident CH) rapporte ~CHF ${gap} nets/an de plus que le permis G. Avant de déménager, comparez ce montant au loyer et au coût de la vie au Tessin.`,
      tie: () => 'Le permis B et le permis G donnent pratiquement le même net : le loyer et le coût de la vie décident.',
    },
    ctaSecondary: 'Comparer des scénarios similaires',
  },
};

/**
 * Map `SalaryLocale` (used by shared/salaryLandingShell) to our local
 * `Locale` alias — they share members, just narrowed differently.
 */
function asShellLocale(l: Locale): SalaryLocale {
  return l;
}

function buildHubSalaryLandingData(
  scenario: SalaryHubScenario,
  result: SimulationResult,
  locale: Locale,
  l: Labels,
): SalaryLandingData {
  const pack = SHELL_PACK[locale];
  const ch = result.chResident.netIncomeAnnual;
  const it = result.itResident.netIncomeAnnual;
  const comparison = compareNet(result);
  return {
    eyebrow: pack.eyebrow(scenario),
    tagline: l.subtitle(scenario, result),
    metaHtml: renderFiscalParamsDate(locale),
    tiles: [
      { label: pack.tileNetCh, value: `CHF ${fmtCHF(ch)}`, tone: 'accent' },
      { label: pack.tileNetIt, value: `CHF ${fmtCHF(it)}`, tone: 'success' },
      {
        label: pack.tileSavings,
        value: comparison.winner === 'tie'
          ? pack.tileWinner.tie
          : `${pack.tileWinner[comparison.winner]} +CHF ${fmtCHF(comparison.gapCHF)}${pack.perYear}`,
        tone: ({ frontier: 'success', resident: 'warning', tie: 'neutral' } as const)[comparison.winner],
      },
      { label: pack.tileExchange, value: result.exchangeRate.toFixed(4), tone: 'neutral' },
    ],
    advice: pack.advice[comparison.winner](fmtCHF(comparison.gapCHF)),
    ctaPrimary: {
      label: l.personalizeBtn,
      href: `${LOCALE_CALC_PREFIX[locale]}/?reddito=${scenario.salary}&tipo=${scenario.frontierType}&stato=${scenario.maritalStatus}&figli=${scenario.children}&zona=${scenario.distanceZone}`,
    },
    ctaSecondary: { label: pack.ctaSecondary, href: `${LOCALE_CALC_PREFIX[locale]}/` },
    faqs: l.faqItems(scenario, result),
  };
}

// Cross-link to the static CHF/EUR exchange vertical (epic #4452): each
// scenario page points at the curated amount page nearest to its gross
// salary, closing the salary-hub -> exchange loop required by issue #4454.
const EXCHANGE_SCENARIO_LINK_LABEL: Record<Locale, (chf: string) => string> = {
  it: (chf) => `Quanto valgono ${chf} CHF in euro? Tasso di oggi e storico`,
  en: (chf) => `What are ${chf} CHF worth in euro? Today's rate and history`,
  de: (chf) => `Wie viel sind ${chf} CHF in Euro? Aktueller Kurs und Verlauf`,
  fr: (chf) => `Combien valent ${chf} CHF en euros ? Taux du jour et historique`,
};

export function generatePageHtml(
  scenario: SalaryHubScenario,
  result: SimulationResult,
  locale: Locale,
  allScenarios: SalaryHubScenario[],
  distDir: string,
): string {
  const l = LABELS[locale];
  const related = getRelatedScenarios(scenario, allScenarios);
  const faqs = l.faqItems(scenario, result);
  const canonicalPath = buildFullPath(scenario, locale);
  const canonicalUrl = `${BASE_URL}${canonicalPath}`;

  const hreflangHtml = renderHreflangTags({
    it: buildFullPath(scenario, 'it'),
    en: buildFullPath(scenario, 'en'),
    de: buildFullPath(scenario, 'de'),
    fr: buildFullPath(scenario, 'fr'),
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
      { '@type': 'ListItem', position: 1, name: l.home, item: `${BASE_URL}/` },
      { '@type': 'ListItem', position: 2, name: l.breadcrumbCalc, item: `${BASE_URL}${LOCALE_CALC_PREFIX[locale]}/` },
      { '@type': 'ListItem', position: 3, name: l.h1(scenario) },
    ],
  });

  const relatedHtml = related.map(s => {
    const path = buildFullPath(s, locale);
    return `<a href="${path}" class="related-card"><strong>CHF ${fmtCHF(s.salary)}</strong><br>${scenarioDesc(s, l)}</a>`;
  }).join('\n');

  const title = l.metaTitle(scenario);
  const description = l.metaDesc(scenario, result);

  // 1. The simulation results table (the meat) stays in the data-area slot
  //    of the new SEO-landing shell — instead of below the H1 as before.
  const dataAreaHtmlOverride = `<section class="salary-hub-page">${resultsTableHtml(result, l)}<div class="ad-unit">${adSlotHtml('ARTICLE_INLINE_MOBILE')}</div></section>`;

  // 2. The 5 long-form explanations + related grid + tail AdSense slot
  //    become the "long prose" block rendered at the bottom of the shell
  //    (CLAUDE.md rule 16 — filler below the data area, never above the fold).
  // The one block on the page that its 400+ siblings cannot carry: the weight
  // ORDER of the levers around this exact combination (issue #7385). Everything
  // else here differs from the siblings only in figures, and figures are masked
  // by the information-gain engine by construction — see
  // shared/scenarioLeverComparison.ts.
  const leverHtml = renderScenarioLeverComparison({
    scenario,
    allScenarios,
    chResidentNetAnnual: result.chResident.netIncomeAnnual,
    itResidentNetAnnual: result.itResident.netIncomeAnnual,
    locale,
  });

  const editorialHtml = `<section class="salary-hub-page">
    <h2>${l.howToCalcTitle}</h2><p>${l.howToCalc(scenario.salary, scenario, result)}</p>
    ${leverHtml}
    <h2>${l.regimeTitle}</h2><p>${l.regimeExplain(scenario, result)}</p>
    <h2>${l.familyTitle}</h2><p>${l.familyExplain(scenario, result)}</p>
    <h2>${l.distanceTitle}</h2><p>${l.distanceExplain(scenario, result)}</p>
    <h2>${l.budgetTitle}</h2><p>${l.budgetExplain(scenario, result)}</p>
    <h2>${l.tipsTitle}</h2><p>${l.tipsExplain(scenario, result)}</p>
    ${renderRevenueNoteHtml(locale)}
    <h2>${l.relatedTitle}</h2><div class="related-grid">${relatedHtml}</div>
    <p><a href="${buildNearestExchangeAmountPath(locale, scenario.salary)}">${EXCHANGE_SCENARIO_LINK_LABEL[locale](fmtCHF(scenario.salary))} →</a></p>
    ${renderAuthoritativeSourcesHtml(locale)}
    <div class="ad-unit">${adSlotHtml('ARTICLE_END_MULTIPLEX')}</div>
  </section>`;

  // 3. Render the shell. H1 + tiles + advice + CTA + data table + FAQ (from
  //    landingData) + editorial prose (above). Breadcrumb + navHtml left to
  //    the shell defaults (`buildSeoPageHtml` wraps the body in the SPA shell).
  const landingData = buildHubSalaryLandingData(scenario, result, locale, l);
  const bodyHtml = renderSalaryLandingShell(landingData, asShellLocale(locale), {
    h1Text: l.h1(scenario),
    dataAreaHtmlOverride,
    editorialHtml,
  });

  return buildSeoPageHtml({
    locale,
    title,
    description,
    canonicalUrl,
    hreflangHtml,
    ogType: 'article',
    jsonLdScripts: [
      faqSchema,
      breadcrumbSchema,
      // Dates the parameters behind the figures, not a review of this page.
      JSON.stringify({
        '@context': 'https://schema.org',
        '@type': 'WebPage',
        url: canonicalUrl,
        inLanguage: locale,
        dateModified: FISCAL_PARAMS_UPDATED_AT,
      }),
    ],
    bodyHtml,
    distDir,
  });
}
