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

import { SimulationResult } from '../types';
import { SalaryHubScenario, buildFullPath, getRelatedScenarios, LOCALE_CALC_PREFIX } from './salaryHubScenarios';
import { AD_CLIENT, AD_SLOTS } from '../services/adsenseSlots';
import { BASE_URL, ANALYTICS_SNIPPET, FAVICON_LINKS, GA4_MEASUREMENT_ID } from './constants';

type Locale = 'it' | 'en' | 'de' | 'fr';

// ── Number formatting ───────────────────────────────────────────

const fmtCHF = (n: number): string => Math.round(n).toLocaleString('de-CH');
const fmtEUR = (n: number): string => Math.round(n).toLocaleString('de-DE');
const fmtPct = (n: number): string => (n * 100).toFixed(1);

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
    `Con un reddito lordo di CHF ${fmtCHF(salary)} annui, il datore di lavoro svizzero trattiene contributi sociali obbligatori per circa CHF ${fmtCHF(r.chResident.socialContributions)}: AVS (5,3%), assicurazione disoccupazione (1,1%), LAINF (0,7%), indennità giornaliera malattia (0,8%) e previdenza professionale LPP (5% a 35 anni). A queste si aggiunge l'imposta alla fonte ticinese calcolata secondo la tabella ${r.chResident.details.source?.replace('calc.', '') || 'A'}, che per questo reddito corrisponde a un'aliquota effettiva del ${fmtPct(r.chResident.details.effectiveRate / 100)}%.`,
  regimeExplain: (s, r) => s.frontierType === 'OLD'
    ? `In qualità di vecchio frontaliere (accordo pre-2024), la tassazione avviene esclusivamente in Svizzera tramite l'imposta alla fonte. Non è prevista alcuna dichiarazione IRPEF in Italia sul reddito svizzero, il che semplifica notevolmente la gestione fiscale. L'aliquota effettiva complessiva è del ${fmtPct(r.itResident.details.effectiveRate / 100)}%.`
    : `Come nuovo frontaliere (accordo fiscale dal 2024), il reddito è soggetto a tassazione concorrente: ${s.distanceZone === 'WITHIN_20KM' ? 'l\'80% dell\'imposta alla fonte resta in Svizzera e il 20% viene retrocesso all\'Italia' : 'il 100% dell\'imposta alla fonte resta in Svizzera'}. In Italia si applica l'IRPEF con una franchigia di €10.000 e il credito d'imposta proporzionale per le tasse già pagate in Svizzera. Il saldo IRPEF netto è di circa EUR ${fmtEUR(r.itResident.details.irpefDetails?.finalNetTaxEUR ?? 0)}.`,
  familyExplain: (s, r) => {
    if (s.maritalStatus === 'MARRIED' && s.children > 0)
      return `Essendo sposato/a con ${s.children} ${s.children === 1 ? 'figlio' : 'figli'}, si applica la tabella fiscale ${r.chResident.details.source?.includes('B') ? 'B' : 'C'} con una riduzione dell'aliquota di ${(0.025 * s.children * 100).toFixed(1)} punti percentuali per i figli. Gli assegni familiari svizzeri ammontano a CHF ${fmtCHF(r.chResident.familyAllowance)}/anno (CHF ${fmtCHF(3000)} per figlio). In Italia, le detrazioni per figli a carico sono di EUR ${fmtEUR(950 * s.children)} più EUR 690 per coniuge a carico.`;
    if (s.children > 0)
      return `Con ${s.children} ${s.children === 1 ? 'figlio' : 'figli'} a carico, si applica la tabella H (genitore solo con figli) con aliquota ridotta. Gli assegni familiari svizzeri sono di CHF ${fmtCHF(r.chResident.familyAllowance)}/anno. In Italia sono previste detrazioni di EUR ${fmtEUR(950 * s.children)} per figli a carico.`;
    if (s.maritalStatus === 'MARRIED')
      return `Come persona sposata senza figli, si applica la tabella B (coniuge non lavoratore) che offre un'aliquota più bassa rispetto alla tabella A dei single. In Italia, la detrazione per coniuge a carico è di EUR 690.`;
    return `Come persona single senza figli, si applica la tabella A dell'imposta alla fonte, la più standard. Non sono previsti assegni familiari né detrazioni per carichi di famiglia.`;
  },
  distanceExplain: (s, _r) => s.distanceZone === 'WITHIN_20KM'
    ? `Risiedendo entro 20 km dal confine svizzero, come nuovo frontaliere l'80% dell'imposta alla fonte resta in Svizzera e il 20% viene retrocesso al comune italiano di residenza. Questo meccanismo di ripartizione riduce leggermente il credito d'imposta utilizzabile in Italia per l'IRPEF.`
    : `Risiedendo oltre 20 km dal confine, il 100% dell'imposta alla fonte viene trattenuto in Svizzera. In Italia si paga l'IRPEF integrale con credito proporzionale per le tasse svizzere. Questa configurazione spesso risulta in un carico fiscale complessivo maggiore rispetto a chi risiede entro 20 km.`,
  budgetExplain: (s, r) => {
    const monthCH = r.chResident.netIncomeMonthly;
    const monthIT = r.itResident.netIncomeMonthly;
    const rate = r.exchangeRate;
    return `Su base mensile, un residente in Svizzera con questo reddito netta circa CHF ${fmtCHF(monthCH)}, mentre un frontaliere italiano riceve uno stipendio netto svizzero che convertito corrisponde a circa EUR ${fmtEUR(monthIT * rate)}/mese (al cambio CHF/EUR ${rate.toFixed(3)}). La differenza mensile è di circa ${r.savingsCHF > 0 ? `CHF ${fmtCHF(Math.abs(r.savingsCHF / 12))} a favore del frontaliere` : `CHF ${fmtCHF(Math.abs(r.savingsCHF / 12))} a favore del residente`}.`;
  },
  tipsExplain: (_s, _r) =>
    `Per ottimizzare il cambio CHF-EUR sullo stipendio, servizi come <a href="/go/wise/" rel="nofollow">Wise</a> o <a href="/go/fineco/" rel="nofollow">Fineco</a> offrono tassi di cambio più vantaggiosi rispetto alle banche tradizionali, con commissioni trasparenti. Se ricevi lo stipendio in CHF, convertire tramite questi servizi può farti risparmiare centinaia di euro all'anno rispetto al cambio bancario standard.`,
  metaTitle: (s) => {
    const parts = [`Stipendio netto ${fmtCHF(s.salary)} CHF frontaliere`];
    if (s.maritalStatus === 'MARRIED') parts.push('sposato');
    if (s.children > 0) parts.push(`${s.children} figli`);
    parts.push('| Simulazione 2026');
    return parts.join(' ');
  },
  metaDesc: (s, r) => {
    const netMonthEUR = fmtEUR(r.itResident.netIncomeMonthly * r.exchangeRate);
    return `Con ${fmtCHF(s.salary)} CHF lordi, un frontaliere ${s.frontierType === 'OLD' ? 'vecchio' : 'nuovo'} ${s.maritalStatus === 'MARRIED' ? 'sposato' : 'single'}${s.children > 0 ? ` con ${s.children} figli` : ''} netta circa EUR ${netMonthEUR}/mese. Tabella ${r.chResident.details.source?.replace('calc.', '') || 'A'}, aliquota ${fmtPct(r.itResident.details.effectiveRate / 100)}%. Simulazione 2026.`;
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
    `Simulazione completa dello stipendio netto per un frontaliere con reddito lordo CHF ${fmtCHF(s.salary)} — confronto tra residente in Svizzera e frontaliere italiano. Aggiornata al 2026.`,
  faqItems: (s, r) => [
    {
      q: `Quanto è lo stipendio netto con ${fmtCHF(s.salary)} CHF lordi per un frontaliere?`,
      a: `Un frontaliere ${s.frontierType === 'OLD' ? 'vecchio' : 'nuovo'} con ${fmtCHF(s.salary)} CHF lordi netta circa CHF ${fmtCHF(r.itResident.netIncomeAnnual)} annui (CHF ${fmtCHF(r.itResident.netIncomeMonthly)}/mese). Come residente in Svizzera, il netto sarebbe CHF ${fmtCHF(r.chResident.netIncomeAnnual)} annui.`,
    },
    {
      q: `Quale tabella fiscale si applica con ${fmtCHF(s.salary)} CHF ${s.maritalStatus === 'MARRIED' ? 'da sposato' : 'da single'}?`,
      a: `Si applica la tabella ${r.chResident.details.source?.replace('calc.', '').replace('table', '') || 'A'} dell'imposta alla fonte ticinese, con un'aliquota effettiva del ${fmtPct(r.chResident.details.effectiveRate / 100)}% sul reddito lordo.`,
    },
    {
      q: `Conviene vivere in Svizzera o fare il frontaliere con ${fmtCHF(s.salary)} CHF?`,
      a: r.savingsCHF > 0
        ? `Con questo profilo, il frontaliere ha un vantaggio di circa CHF ${fmtCHF(r.savingsCHF)} annui (EUR ${fmtEUR(r.savingsEUR)}) rispetto al residente svizzero, principalmente grazie al minor costo della vita in Italia.`
        : `Con questo profilo, il residente svizzero ha un vantaggio di circa CHF ${fmtCHF(Math.abs(r.savingsCHF))} annui, principalmente grazie alla minore pressione fiscale complessiva.`,
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
    `With a gross annual income of CHF ${fmtCHF(salary)}, the Swiss employer withholds mandatory social contributions of approximately CHF ${fmtCHF(r.chResident.socialContributions)}: AVS (5.3%), unemployment insurance (1.1%), accident insurance (0.7%), daily sickness allowance (0.8%), and occupational pension LPP. The Ticino withholding tax is calculated using table ${r.chResident.details.source?.replace('calc.', '') || 'A'}, resulting in an effective rate of ${fmtPct(r.chResident.details.effectiveRate / 100)}%.`,
  regimeExplain: (s, r) => s.frontierType === 'OLD'
    ? `As an old cross-border worker (pre-2024 agreement), taxation is exclusively in Switzerland through withholding tax. No Italian IRPEF declaration is required, with an overall effective rate of ${fmtPct(r.itResident.details.effectiveRate / 100)}%.`
    : `As a new cross-border worker (2024+ agreement), income is subject to concurrent taxation: ${s.distanceZone === 'WITHIN_20KM' ? '80% of the withholding tax stays in Switzerland and 20% is returned to Italy' : '100% of the withholding tax stays in Switzerland'}. Italian IRPEF applies with a €10,000 deduction and proportional tax credit for Swiss taxes paid.`,
  familyExplain: (s, r) =>
    s.maritalStatus === 'MARRIED'
      ? `As a married person${s.children > 0 ? ` with ${s.children} ${s.children === 1 ? 'child' : 'children'}` : ''}, tax table ${r.chResident.details.source?.includes('B') ? 'B' : 'C'} applies with reduced rates. Swiss family allowances amount to CHF ${fmtCHF(r.chResident.familyAllowance)}/year.`
      : `As a single person${s.children > 0 ? ` with ${s.children} ${s.children === 1 ? 'child' : 'children'}` : ''}, tax table ${s.children > 0 ? 'H' : 'A'} applies. ${s.children > 0 ? `Swiss family allowances: CHF ${fmtCHF(r.chResident.familyAllowance)}/year.` : 'No family allowances apply.'}`,
  distanceExplain: (s, _r) => s.distanceZone === 'WITHIN_20KM'
    ? `Living within 20 km of the Swiss border, 80% of the withholding tax stays in Switzerland and 20% goes to your Italian municipality.`
    : `Living over 20 km from the border, 100% of the withholding tax stays in Switzerland. Italian IRPEF applies in full with proportional credit.`,
  budgetExplain: (s, r) =>
    `Monthly, a Swiss resident nets approximately CHF ${fmtCHF(r.chResident.netIncomeMonthly)}, while an Italian cross-border worker receives about EUR ${fmtEUR(r.itResident.netIncomeMonthly * r.exchangeRate)}/month (at CHF/EUR ${r.exchangeRate.toFixed(3)}).`,
  tipsExplain: (_s, _r) =>
    `To optimize your CHF-EUR conversion, services like <a href="/go/wise/" rel="nofollow">Wise</a> or <a href="/go/fineco/" rel="nofollow">Fineco</a> offer better exchange rates than traditional banks.`,
  metaTitle: (s) => `Net salary ${fmtCHF(s.salary)} CHF cross-border worker${s.maritalStatus === 'MARRIED' ? ' married' : ''}${s.children > 0 ? ` ${s.children} children` : ''} | 2026 Simulation`,
  metaDesc: (s, r) => `With CHF ${fmtCHF(s.salary)} gross, a ${s.frontierType === 'OLD' ? 'old' : 'new'} cross-border worker nets approximately EUR ${fmtEUR(r.itResident.netIncomeMonthly * r.exchangeRate)}/month. 2026 simulation with full tax breakdown.`,
  h1: (s) => {
    const parts = [`Net Salary CHF ${fmtCHF(s.salary)}`];
    if (s.maritalStatus === 'MARRIED') parts.push('Married');
    if (s.children > 0) parts.push(s.children === 1 ? '1 Child' : `${s.children} Children`);
    if (s.frontierType === 'OLD') parts.push('Old Cross-Border Worker');
    if (s.distanceZone === 'OVER_20KM') parts.push('Over 20 km');
    return parts.join(' — ');
  },
  subtitle: (s, _r) => `Full net salary simulation for a cross-border worker earning CHF ${fmtCHF(s.salary)} gross — Swiss resident vs Italian cross-border comparison. Updated 2026.`,
  faqItems: (s, r) => [
    {
      q: `What is the net salary with CHF ${fmtCHF(s.salary)} gross as a cross-border worker?`,
      a: `A ${s.frontierType === 'OLD' ? 'old' : 'new'} cross-border worker earning CHF ${fmtCHF(s.salary)} gross nets approximately CHF ${fmtCHF(r.itResident.netIncomeAnnual)} annually (CHF ${fmtCHF(r.itResident.netIncomeMonthly)}/month).`,
    },
    {
      q: `Which tax table applies to CHF ${fmtCHF(s.salary)} ${s.maritalStatus === 'MARRIED' ? 'married' : 'single'}?`,
      a: `Tax table ${r.chResident.details.source?.replace('calc.', '').replace('table', '') || 'A'} applies with an effective rate of ${fmtPct(r.chResident.details.effectiveRate / 100)}%.`,
    },
    {
      q: `Is it better to live in Switzerland or commute with CHF ${fmtCHF(s.salary)}?`,
      a: r.savingsCHF > 0
        ? `The cross-border worker saves approximately CHF ${fmtCHF(r.savingsCHF)} annually compared to a Swiss resident.`
        : `The Swiss resident saves approximately CHF ${fmtCHF(Math.abs(r.savingsCHF))} annually compared to a cross-border worker.`,
    },
  ],
};

const DE: Labels = {
  ...EN,
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
  metaTitle: (s) => `Nettogehalt ${fmtCHF(s.salary)} CHF Grenzgänger${s.maritalStatus === 'MARRIED' ? ' verheiratet' : ''}${s.children > 0 ? ` ${s.children} Kinder` : ''} | Simulation 2026`,
  metaDesc: (s, r) => `Mit CHF ${fmtCHF(s.salary)} brutto erzielt ein ${s.frontierType === 'OLD' ? 'alter' : 'neuer'} Grenzgänger netto ca. EUR ${fmtEUR(r.itResident.netIncomeMonthly * r.exchangeRate)}/Monat. Simulation 2026.`,
  h1: (s) => {
    const parts = [`Nettogehalt CHF ${fmtCHF(s.salary)}`];
    if (s.maritalStatus === 'MARRIED') parts.push('Verheiratet');
    if (s.children > 0) parts.push(s.children === 1 ? '1 Kind' : `${s.children} Kinder`);
    if (s.frontierType === 'OLD') parts.push('Alter Grenzgänger');
    if (s.distanceZone === 'OVER_20KM') parts.push('Über 20 km');
    return parts.join(' — ');
  },
  subtitle: (s, _r) => `Vollständige Nettogehalt-Simulation für einen Grenzgänger mit CHF ${fmtCHF(s.salary)} brutto — Vergleich CH-Wohnsitz vs. IT-Grenzgänger. Aktualisiert 2026.`,
  faqItems: (s, r) => [
    {
      q: `Wie viel netto bei CHF ${fmtCHF(s.salary)} brutto als Grenzgänger?`,
      a: `Ein ${s.frontierType === 'OLD' ? 'alter' : 'neuer'} Grenzgänger mit CHF ${fmtCHF(s.salary)} brutto erzielt netto ca. CHF ${fmtCHF(r.itResident.netIncomeAnnual)} jährlich (CHF ${fmtCHF(r.itResident.netIncomeMonthly)}/Monat).`,
    },
    {
      q: `Welche Steuertabelle gilt für CHF ${fmtCHF(s.salary)} ${s.maritalStatus === 'MARRIED' ? 'verheiratet' : 'ledig'}?`,
      a: `Es gilt Tabelle ${r.chResident.details.source?.replace('calc.', '').replace('table', '') || 'A'} mit einem effektiven Satz von ${fmtPct(r.chResident.details.effectiveRate / 100)}%.`,
    },
  ],
};

const FR: Labels = {
  ...EN,
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
  metaTitle: (s) => `Salaire net ${fmtCHF(s.salary)} CHF frontalier${s.maritalStatus === 'MARRIED' ? ' marié' : ''}${s.children > 0 ? ` ${s.children} enfants` : ''} | Simulation 2026`,
  metaDesc: (s, r) => `Avec CHF ${fmtCHF(s.salary)} brut, un ${s.frontierType === 'OLD' ? 'ancien' : 'nouveau'} frontalier perçoit environ EUR ${fmtEUR(r.itResident.netIncomeMonthly * r.exchangeRate)}/mois. Simulation 2026.`,
  h1: (s) => {
    const parts = [`Salaire Net CHF ${fmtCHF(s.salary)}`];
    if (s.maritalStatus === 'MARRIED') parts.push('Marié');
    if (s.children > 0) parts.push(s.children === 1 ? '1 Enfant' : `${s.children} Enfants`);
    if (s.frontierType === 'OLD') parts.push('Ancien Frontalier');
    if (s.distanceZone === 'OVER_20KM') parts.push('Plus de 20 km');
    return parts.join(' — ');
  },
  subtitle: (s, _r) => `Simulation complète du salaire net pour un frontalier gagnant CHF ${fmtCHF(s.salary)} brut — comparaison résident CH vs frontalier IT. Mise à jour 2026.`,
  faqItems: (s, r) => [
    {
      q: `Quel est le salaire net avec CHF ${fmtCHF(s.salary)} brut en tant que frontalier?`,
      a: `Un ${s.frontierType === 'OLD' ? 'ancien' : 'nouveau'} frontalier avec CHF ${fmtCHF(s.salary)} brut perçoit environ CHF ${fmtCHF(r.itResident.netIncomeAnnual)} net par an (CHF ${fmtCHF(r.itResident.netIncomeMonthly)}/mois).`,
    },
    {
      q: `Quel barème fiscal s'applique pour CHF ${fmtCHF(s.salary)} ${s.maritalStatus === 'MARRIED' ? 'marié' : 'célibataire'}?`,
      a: `Le barème ${r.chResident.details.source?.replace('calc.', '').replace('table', '') || 'A'} s'applique avec un taux effectif de ${fmtPct(r.chResident.details.effectiveRate / 100)}%.`,
    },
  ],
};

const LABELS: Record<Locale, Labels> = { it: IT, en: EN, de: DE, fr: FR };

// ── HTML generation ─────────────────────────────────────────────

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
      <div class="savings-badge ${result.savingsCHF > 0 ? 'positive' : 'negative'}">
        ${l.savings}: <strong>CHF ${fmtCHF(Math.abs(result.savingsCHF))}</strong> ${l.annual}
        (EUR ${fmtEUR(Math.abs(result.savingsEUR))})
        ${result.savingsCHF > 0 ? '&#x2191; frontaliere' : '&#x2191; residente'}
      </div>
    </div>`;
}

export function generatePageHtml(
  scenario: SalaryHubScenario,
  result: SimulationResult,
  locale: Locale,
  allScenarios: SalaryHubScenario[],
): string {
  const l = LABELS[locale];
  const related = getRelatedScenarios(scenario, allScenarios);
  const faqs = l.faqItems(scenario, result);
  const canonicalPath = buildFullPath(scenario, locale);
  const canonicalUrl = `${BASE_URL}${canonicalPath}`;

  const hreflangLinks = (['it', 'en', 'de', 'fr'] as const)
    .map(loc => `<link rel="alternate" hreflang="${loc}" href="${BASE_URL}${buildFullPath(scenario, loc)}">`)
    .join('\n    ');

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

  const ctaUrl = `${LOCALE_CALC_PREFIX[locale]}/?reddito=${scenario.salary}&tipo=${scenario.frontierType}&stato=${scenario.maritalStatus}&figli=${scenario.children}&zona=${scenario.distanceZone}`;

  const title = l.metaTitle(scenario);
  const description = l.metaDesc(scenario, result);

  return `<!DOCTYPE html>
<html lang="${locale}">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>${title}</title>
  <meta name="description" content="${description}">
  <meta name="robots" content="index,follow">
  <link rel="canonical" href="${canonicalUrl}">
  ${hreflangLinks}
  <link rel="alternate" hreflang="x-default" href="${BASE_URL}${buildFullPath(scenario, 'it')}">
  <meta property="og:type" content="article">
  <meta property="og:url" content="${canonicalUrl}">
  <meta property="og:title" content="${title}">
  <meta property="og:description" content="${description}">
  <meta property="og:site_name" content="Frontaliere Ticino">
  <meta property="fb:app_id" content="891036063797338">
  ${FAVICON_LINKS}
  ${ANALYTICS_SNIPPET}
  <style>
    *{margin:0;padding:0;box-sizing:border-box}
    body{font-family:'Inter',system-ui,-apple-system,sans-serif;background:#f8fafc;color:#334155;line-height:1.7}
    .hub-wrap{max-width:1200px;margin:0 auto;padding:24px 16px}
    .hub-grid{display:grid;grid-template-columns:1fr;gap:24px}
    @media(min-width:1024px){.hub-grid{grid-template-columns:160px 1fr 160px}.rail{position:sticky;top:80px;align-self:start}}
    .content{min-width:0}
    .breadcrumb{font-size:13px;color:#64748b;margin-bottom:16px}
    .breadcrumb a{color:#533afd;text-decoration:none}
    h1{font-size:28px;font-weight:800;color:#1e293b;margin-bottom:8px;line-height:1.3}
    .subtitle{font-size:15px;color:#64748b;margin-bottom:24px}
    h2{font-size:20px;font-weight:700;color:#1e293b;margin:32px 0 12px}
    p{margin-bottom:16px;font-size:15px}
    a{color:#533afd}
    .results-table-wrap{overflow-x:auto;margin:24px 0}
    .results-table{width:100%;border-collapse:collapse;font-size:14px}
    .results-table th,.results-table td{padding:10px 12px;border-bottom:1px solid #e2e8f0;text-align:left}
    .results-table th{background:#f1f5f9;font-weight:600;color:#475569}
    .results-table .num{text-align:right;font-variant-numeric:tabular-nums}
    .results-table .net-row td{background:#ecfdf5;font-weight:700}
    .results-table .highlight{color:#059669}
    .savings-badge{text-align:center;padding:12px;border-radius:8px;margin-top:12px;font-size:14px}
    .savings-badge.positive{background:#ecfdf5;color:#059669}
    .savings-badge.negative{background:#fef2f2;color:#dc2626}
    .cta-box{background:linear-gradient(135deg,#533afd 0%,#7c3aed 100%);color:#fff;padding:24px;border-radius:12px;text-align:center;margin:32px 0}
    .cta-box a{display:inline-block;background:#fff;color:#533afd;padding:12px 32px;border-radius:8px;font-weight:700;text-decoration:none;margin-top:12px}
    .related-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(200px,1fr));gap:12px;margin-top:16px}
    .related-card{display:block;padding:16px;background:#fff;border:1px solid #e2e8f0;border-radius:8px;text-decoration:none;color:#334155;font-size:14px;transition:box-shadow .15s}
    .related-card:hover{box-shadow:0 4px 12px rgba(0,0,0,.1)}
    .faq-section{margin-top:32px}
    .faq-item{border-bottom:1px solid #e2e8f0;padding:16px 0}
    .faq-q{font-weight:700;font-size:15px;color:#1e293b}
    .faq-a{font-size:14px;color:#475569;margin-top:8px}
    .ad-unit{margin:24px 0;min-height:220px}
    .footer-hub{text-align:center;padding:24px;font-size:12px;color:#94a3b8;margin-top:40px;border-top:1px solid #e2e8f0}
  </style>
</head>
<body>
  <div class="hub-wrap">
    <div class="hub-grid">
      <!-- Left rail ad (desktop) -->
      <div class="rail" style="display:none" id="left-rail">
        <div class="ad-unit">${adSlotHtml('ARTICLE_RAIL_LEFT')}</div>
      </div>

      <!-- Main content -->
      <div class="content">
        <nav class="breadcrumb">
          <a href="/">${l.home}</a> &rsaquo;
          <a href="${LOCALE_CALC_PREFIX[locale]}/">${l.breadcrumbCalc}</a> &rsaquo;
          ${l.h1(scenario)}
        </nav>

        <h1>${l.h1(scenario)}</h1>
        <p class="subtitle">${l.subtitle(scenario, result)}</p>

        ${resultsTableHtml(result, l)}

        <div class="ad-unit">${adSlotHtml('ARTICLE_INLINE_MOBILE')}</div>

        <h2>${l.howToCalcTitle}</h2>
        <p>${l.howToCalc(scenario.salary, scenario, result)}</p>

        <h2>${l.regimeTitle}</h2>
        <p>${l.regimeExplain(scenario, result)}</p>

        <h2>${l.familyTitle}</h2>
        <p>${l.familyExplain(scenario, result)}</p>

        <h2>${l.distanceTitle}</h2>
        <p>${l.distanceExplain(scenario, result)}</p>

        <h2>${l.budgetTitle}</h2>
        <p>${l.budgetExplain(scenario, result)}</p>

        <h2>${l.tipsTitle}</h2>
        <p>${l.tipsExplain(scenario, result)}</p>

        <div class="cta-box">
          <p>${l.personalizeBtn}</p>
          <a href="${ctaUrl}">${l.personalizeBtn} &rarr;</a>
        </div>

        <h2>${l.relatedTitle}</h2>
        <div class="related-grid">${relatedHtml}</div>

        <div class="faq-section">
          <h2>${l.faqTitle}</h2>
          ${faqs.map(f => `<div class="faq-item"><div class="faq-q">${f.q}</div><div class="faq-a">${f.a}</div></div>`).join('\n')}
        </div>

        <div class="ad-unit">${adSlotHtml('ARTICLE_END_MULTIPLEX')}</div>
      </div>

      <!-- Right rail ad (desktop) -->
      <div class="rail" style="display:none" id="right-rail">
        <div class="ad-unit">${adSlotHtml('ARTICLE_RAIL_RIGHT')}</div>
      </div>
    </div>
  </div>

  <footer class="footer-hub">&copy; 2026 Frontaliere Ticino &mdash; frontaliereticino.ch</footer>

  <script type="application/ld+json">${faqSchema}</script>
  <script type="application/ld+json">${breadcrumbSchema}</script>

  <!-- Show rail ads on desktop -->
  <script>
    if(window.innerWidth>=1024){
      document.getElementById('left-rail').style.display='block';
      document.getElementById('right-rail').style.display='block';
    }
  </script>

  <!-- AdSense loader is injected globally via ANALYTICS_SNIPPET in <head>. -->
  <script>
    (function(){
      var slots=document.querySelectorAll('.adsbygoogle');
      for(var i=0;i<slots.length;i++){
        try{(adsbygoogle=window.adsbygoogle||[]).push({});}catch(e){}
      }
    })();
  </script>

  <!-- SPA redirect for deep links -->
  <script>
    if(location.hostname==='frontaliereticino.ch'||location.hostname==='www.frontaliereticino.ch'){
      sessionStorage.redirect=location.href;
    }
  </script>
</body>
</html>`;
}
