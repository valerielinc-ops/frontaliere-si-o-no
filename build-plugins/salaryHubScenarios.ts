/**
 * Salary Hub SEO — Scenario matrix and slug generation.
 *
 * Generates ~500 salary calculation scenarios across 5 dimensions:
 * salary × frontierType × maritalStatus × children × distanceZone.
 *
 * Each scenario maps to a URL slug in 4 locales (it/en/de/fr).
 * The calculation engine (calculationService.ts) runs at build time
 * to pre-compute results for every combination.
 */

import { SimulationInputs } from '../types';
import { DEFAULT_TECH_PARAMS, DEFAULT_EXCHANGE_RATE } from '../constants';

// ── Scenario dimensions ─────────────────────────────────────────

export const SALARY_LEVELS = [
  40_000, 45_000, 50_000, 55_000, 60_000, 65_000, 70_000, 75_000,
  80_000, 85_000, 90_000, 95_000, 100_000, 110_000, 120_000,
  130_000, 140_000, 150_000,
] as const;

export type FrontierType = 'NEW' | 'OLD';
export type MaritalStatus = 'SINGLE' | 'MARRIED';
export type DistanceZone = 'WITHIN_20KM' | 'OVER_20KM';

export interface SalaryHubScenario {
  salary: number;
  frontierType: FrontierType;
  maritalStatus: MaritalStatus;
  children: number;
  distanceZone: DistanceZone;
}

// ── Existing SEO landing slugs to skip (avoid duplicates) ───────
//
// Only slugs that salaryHub itself CAN generate are listed here. After
// PR #215 / #216 the salaryHub pipeline uses the same mobile-first
// SEO-landing shell as staticPagesPlugin, so letting salaryHub take over
// removes a visual divergence between "base tier" and "tier + variant"
// pages of the same salary level (single shell, single data source).
//
// The 9 entries that salaryHub naturally generates (base, sposato+2figli,
// vecchio-frontaliere) were previously listed here to avoid race-overwrite.
// They are now intentionally absent — salaryHub wins the collector dedupe
// (see salaryHubPlugin.ts:35-60 contract) and ships richer simulation data.
//
// The remaining legacy slugs that salaryHub CAN'T match (different naming
// convention: `nuovo-frontaliere-2026`, `residenza-{entro,oltre}-20km`,
// 40k / 120k tiers) keep their staticPagesPlugin parametric rendering.
const EXISTING_IT_SLUGS = new Set<string>([]);

// ── Slug generation ─────────────────────────────────────────────

type Locale = 'it' | 'en' | 'de' | 'fr';

interface SlugParts {
  base: (salary: number) => string;
  married: string;
  children: (n: number) => string;
  newFrontier: string;
  oldFrontier: string;
  within20km: string;
  over20km: string;
}

const SLUG_PARTS: Record<Locale, SlugParts> = {
  it: {
    base: (s) => `stipendio-netto-${s}-chf`,
    married: 'sposato',
    children: (n) => n === 1 ? '1-figlio' : `${n}-figli`,
    newFrontier: 'nuovo-frontaliere',
    oldFrontier: 'vecchio-frontaliere',
    within20km: 'entro-20km',
    over20km: 'oltre-20km',
  },
  en: {
    base: (s) => `net-salary-${s}-chf`,
    married: 'married',
    children: (n) => n === 1 ? '1-child' : `${n}-children`,
    newFrontier: 'new-crossborder',
    oldFrontier: 'old-crossborder',
    within20km: 'within-20km',
    over20km: 'over-20km',
  },
  de: {
    base: (s) => `nettogehalt-${s}-chf`,
    married: 'verheiratet',
    children: (n) => n === 1 ? '1-kind' : `${n}-kinder`,
    newFrontier: 'neuer-grenzgaenger',
    oldFrontier: 'alter-grenzgaenger',
    within20km: 'innerhalb-20km',
    over20km: 'ueber-20km',
  },
  fr: {
    base: (s) => `salaire-net-${s}-chf`,
    married: 'marie',
    children: (n) => n === 1 ? '1-enfant' : `${n}-enfants`,
    newFrontier: 'nouveau-frontalier',
    oldFrontier: 'ancien-frontalier',
    within20km: 'moins-20km',
    over20km: 'plus-20km',
  },
};

/** URL path prefix per locale (IT has no prefix). */
export const LOCALE_CALC_PREFIX: Record<Locale, string> = {
  it: '/calcola-stipendio',
  en: '/en/calculate-salary',
  de: '/de/gehalt-berechnen',
  fr: '/fr/calculer-salaire',
};

export function buildSlug(scenario: SalaryHubScenario, locale: Locale): string {
  const p = SLUG_PARTS[locale];
  const parts = [p.base(scenario.salary)];

  if (scenario.maritalStatus === 'MARRIED') parts.push(p.married);
  if (scenario.children > 0) parts.push(p.children(scenario.children));
  if (scenario.frontierType === 'OLD') parts.push(p.oldFrontier);
  else if (scenario.frontierType === 'NEW' && scenario.distanceZone === 'OVER_20KM') parts.push(p.newFrontier);
  if (scenario.distanceZone === 'OVER_20KM') parts.push(p.over20km);
  else if (scenario.frontierType === 'NEW' && scenario.distanceZone === 'WITHIN_20KM'
    && (scenario.maritalStatus === 'MARRIED' || scenario.children > 0)) {
    parts.push(p.within20km);
  }

  return parts.join('-');
}

export function buildFullPath(scenario: SalaryHubScenario, locale: Locale): string {
  return `${LOCALE_CALC_PREFIX[locale]}/${buildSlug(scenario, locale)}/`;
}

// ── Scenario generation ─────────────────────────────────────────

export function generateAllScenarios(): SalaryHubScenario[] {
  const scenarios: SalaryHubScenario[] = [];

  for (const salary of SALARY_LEVELS) {
    for (const frontierType of ['NEW', 'OLD'] as const) {
      for (const maritalStatus of ['SINGLE', 'MARRIED'] as const) {
        for (const children of [0, 1, 2, 3]) {
          for (const distanceZone of ['WITHIN_20KM', 'OVER_20KM'] as const) {
            // Pruning: old frontalieri don't have OVER_20KM
            if (frontierType === 'OLD' && distanceZone === 'OVER_20KM') continue;

            const scenario: SalaryHubScenario = {
              salary, frontierType, maritalStatus, children, distanceZone,
            };

            // Skip if this slug matches an existing SEO landing page
            const itSlug = buildSlug(scenario, 'it');
            if (EXISTING_IT_SLUGS.has(itSlug)) continue;

            scenarios.push(scenario);
          }
        }
      }
    }
  }

  return scenarios;
}

// ── Convert scenario to calculation inputs ──────────────────────

export function scenarioToInputs(scenario: SalaryHubScenario): SimulationInputs {
  const familyMembers = 1 + scenario.children + (scenario.maritalStatus === 'MARRIED' ? 1 : 0);
  return {
    annualIncomeCHF: scenario.salary,
    familyMembers,
    children: scenario.children,
    healthInsuranceCHF: 350,
    frontierWorkerType: scenario.frontierType,
    distanceZone: scenario.distanceZone,
    customExchangeRate: DEFAULT_EXCHANGE_RATE,
    monthsBasis: 12,
    age: 35,
    maritalStatus: scenario.maritalStatus,
    spouseWorks: false,
    expensesCH: [],
    expensesIT: [],
    ...DEFAULT_TECH_PARAMS,
    enableOldFrontierHealthTax: false,
    ssnHealthTaxPercentage: 3,
    netWealthCHF: 0,
  };
}

// ── Related scenarios (for internal linking) ────────────────────

export function getRelatedScenarios(
  current: SalaryHubScenario,
  allScenarios: SalaryHubScenario[],
): SalaryHubScenario[] {
  const related: SalaryHubScenario[] = [];
  const salaryIdx = SALARY_LEVELS.indexOf(current.salary as typeof SALARY_LEVELS[number]);

  // Adjacent salaries (same config)
  for (const offset of [-1, 1]) {
    const idx = salaryIdx + offset;
    if (idx >= 0 && idx < SALARY_LEVELS.length) {
      const match = allScenarios.find(s =>
        s.salary === SALARY_LEVELS[idx] &&
        s.frontierType === current.frontierType &&
        s.maritalStatus === current.maritalStatus &&
        s.children === current.children &&
        s.distanceZone === current.distanceZone
      );
      if (match) related.push(match);
    }
  }

  // Same salary, opposite marital status
  const altMarital = allScenarios.find(s =>
    s.salary === current.salary &&
    s.frontierType === current.frontierType &&
    s.maritalStatus !== current.maritalStatus &&
    s.children === current.children &&
    s.distanceZone === current.distanceZone
  );
  if (altMarital) related.push(altMarital);

  // Same salary, different children count
  for (const kids of [0, 1, 2, 3]) {
    if (kids === current.children) continue;
    const match = allScenarios.find(s =>
      s.salary === current.salary &&
      s.frontierType === current.frontierType &&
      s.maritalStatus === current.maritalStatus &&
      s.children === kids &&
      s.distanceZone === current.distanceZone
    );
    if (match) { related.push(match); break; } // Just one variant
  }

  // Same salary, opposite frontier type (if exists)
  const altFrontier = allScenarios.find(s =>
    s.salary === current.salary &&
    s.frontierType !== current.frontierType &&
    s.maritalStatus === current.maritalStatus &&
    s.children === current.children
  );
  if (altFrontier) related.push(altFrontier);

  // Same salary, opposite distance zone (if exists)
  const altZone = allScenarios.find(s =>
    s.salary === current.salary &&
    s.frontierType === current.frontierType &&
    s.maritalStatus === current.maritalStatus &&
    s.children === current.children &&
    s.distanceZone !== current.distanceZone
  );
  if (altZone) related.push(altZone);

  return related.slice(0, 8);
}
