/**
 * URL State Service — Encode/decode simulation parameters as URL query params.
 *
 * Design:
 *  - Italian param names for canonical, human-readable URLs ("parlanti")
 *  - Delta compression: only non-default values appear in the URL
 *  - Expenses encoded as compact base64url JSON (omitted if URL too long)
 *  - Safe alongside existing params (?debug, ?status, ?lang, ?p, ?q)
 */

import { SimulationInputs, ExpenseItem } from '@/types';
import { DEFAULT_INPUTS, DEFAULT_TECH_PARAMS } from '@/constants';

// ── Param Map: SimulationInputs field → short Italian URL param name ───────

type ParamEntry = {
  param: string;
  type: 'number' | 'string' | 'boolean';
};

const PARAM_MAP: Record<string, ParamEntry> = {
  // User-facing fields
  annualIncomeCHF:    { param: 'reddito',        type: 'number' },
  age:                { param: 'eta',             type: 'number' },
  children:           { param: 'figli',           type: 'number' },
  familyMembers:      { param: 'famiglia',        type: 'number' },
  frontierWorkerType: { param: 'tipo',            type: 'string' },
  distanceZone:       { param: 'zona',            type: 'string' },
  maritalStatus:      { param: 'stato',           type: 'string' },
  healthInsuranceCHF: { param: 'cassa',           type: 'number' },
  customExchangeRate: { param: 'cambio',          type: 'number' },
  monthsBasis:        { param: 'mesi',            type: 'number' },

  spouseWorks:        { param: 'coniuge-lavora',  type: 'boolean' },
  netWealthCHF:       { param: 'patrimonio',      type: 'number' },
  // Experimental features
  enableOldFrontierHealthTax: { param: 'tassa-ssn',    type: 'boolean' },
  ssnHealthTaxPercentage:     { param: 'aliquota-ssn', type: 'number' },
  // Technical params (included only when changed from defaults)
  avsRate:          { param: 'avs',              type: 'number' },
  acRate:           { param: 'ac',               type: 'number' },
  laaRate:          { param: 'laa',              type: 'number' },
  ijmRate:          { param: 'ijm',              type: 'number' },
  lppRate25_34:     { param: 'lpp-25',           type: 'number' },
  lppRate35_44:     { param: 'lpp-35',           type: 'number' },
  lppRate45_54:     { param: 'lpp-45',           type: 'number' },
  lppRate55_plus:   { param: 'lpp-55',           type: 'number' },
  itAddizionaleRate: { param: 'addizionale',     type: 'number' },
  itWorkDeduction:  { param: 'deduzione-lavoro', type: 'number' },
};

// Reverse map: Italian param name → field name
const REVERSE_MAP: Record<string, { field: string; type: ParamEntry['type'] }> = {};
for (const [field, entry] of Object.entries(PARAM_MAP)) {
  REVERSE_MAP[entry.param] = { field, type: entry.type };
}

// ── Encoding ────────────────────────────────────────────────────────────────

/**
 * Encode simulation inputs as URL query params (delta vs defaults).
 * Returns only the search string, e.g. "?reddito=85000&eta=42&figli=2"
 * Returns "" if inputs match all defaults.
 */
export function encodeSimulationParams(inputs: SimulationInputs): string {
  const params = new URLSearchParams();

  for (const [field, entry] of Object.entries(PARAM_MAP)) {
    const value = (inputs as unknown as Record<string, unknown>)[field];
    const defaultValue = (DEFAULT_INPUTS as unknown as Record<string, unknown>)[field];

    // Skip if value matches default
    if (value === defaultValue) continue;
    // Skip undefined/null
    if (value === undefined || value === null) continue;

    if (entry.type === 'boolean') {
      params.set(entry.param, value ? '1' : '0');
    } else if (entry.type === 'number') {
      // Use plain number, no trailing zeros
      params.set(entry.param, String(value));
    } else {
      params.set(entry.param, String(value));
    }
  }

  // Encode custom expenses (only if non-empty)
  if (inputs.expensesCH.length > 0) {
    const encoded = encodeExpenses(inputs.expensesCH);
    if (encoded) params.set('spese-ch', encoded);
  }
  if (inputs.expensesIT.length > 0) {
    const encoded = encodeExpenses(inputs.expensesIT);
    if (encoded) params.set('spese-it', encoded);
  }

  const search = params.toString();
  return search ? `?${search}` : '';
}

/** Canonical site origin — always non-www. */
const CANONICAL_ORIGIN = 'https://frontaliereticino.ch';

/**
 * Build a full shareable URL with simulation params.
 * Always uses the canonical non-www domain, regardless of the current window.location.
 */
export function buildShareURL(inputs: SimulationInputs, basePath?: string): string {
  const path = basePath || window.location.pathname;
  const search = encodeSimulationParams(inputs);
  return `${CANONICAL_ORIGIN}${path}${search}`;
}

// ── Decoding ────────────────────────────────────────────────────────────────

/**
 * Decode simulation params from a URL search string.
 * Returns a partial SimulationInputs (only the fields present in URL).
 * Returns null if no simulation params found.
 */
export function decodeSimulationParams(search: string): Partial<SimulationInputs> | null {
  const params = new URLSearchParams(search);
  const result: Record<string, unknown> = {};
  let found = false;

  for (const [paramName, rawValue] of params.entries()) {
    const mapping = REVERSE_MAP[paramName];
    if (!mapping) continue; // Skip non-simulation params (debug, status, lang, etc.)

    found = true;
    const { field, type } = mapping;

    if (type === 'number') {
      const num = Number(rawValue);
      if (!isNaN(num) && isFinite(num)) {
        result[field] = num;
      }
    } else if (type === 'boolean') {
      result[field] = rawValue === '1' || rawValue === 'true';
    } else {
      // Validate enum values
      if (field === 'frontierWorkerType' && !['NEW', 'OLD'].includes(rawValue)) continue;
      if (field === 'distanceZone' && !['WITHIN_20KM', 'OVER_20KM'].includes(rawValue)) continue;
      if (field === 'maritalStatus' && !['SINGLE', 'MARRIED', 'DIVORCED', 'WIDOWED'].includes(rawValue)) continue;

      result[field] = rawValue;
    }
  }

  // Decode expenses
  const speseCH = params.get('spese-ch');
  if (speseCH) {
    const decoded = decodeExpenses(speseCH);
    if (decoded) {
      result.expensesCH = decoded;
      found = true;
    }
  }
  const speseIT = params.get('spese-it');
  if (speseIT) {
    const decoded = decodeExpenses(speseIT);
    if (decoded) {
      result.expensesIT = decoded;
      found = true;
    }
  }

  return found ? (result as Partial<SimulationInputs>) : null;
}

/**
 * Check whether the current URL has simulation params.
 */
export function hasSimulationParams(search?: string): boolean {
  const s = search || window.location.search;
  const params = new URLSearchParams(s);
  for (const [paramName] of params.entries()) {
    if (REVERSE_MAP[paramName] || paramName === 'spese-ch' || paramName === 'spese-it') {
      return true;
    }
  }
  return false;
}

/**
 * Strip simulation params from URL (after hydrating).
 * Preserves non-simulation params like ?debug, ?status.
 */
export function cleanSimulationParams(): void {
  const params = new URLSearchParams(window.location.search);
  const simParams = [...params.keys()].filter(
    k => REVERSE_MAP[k] || k === 'spese-ch' || k === 'spese-it'
  );
  if (simParams.length === 0) return;

  for (const p of simParams) params.delete(p);
  const remaining = params.toString();
  const newUrl = window.location.pathname + (remaining ? `?${remaining}` : '') + window.location.hash;
  window.history.replaceState(null, '', newUrl);
}

// ── Expense Encoding (compact base64url JSON) ───────────────────────────────

function encodeExpenses(items: ExpenseItem[]): string | null {
  try {
    // Compact representation: only essential fields
    const compact = items.map(e => ({
      l: e.label,
      a: e.amount,
      f: e.frequency === 'ANNUAL' ? 'A' : 'M',
    }));
    const json = JSON.stringify(compact);
    // base64url encode
    const b64 = btoa(unescape(encodeURIComponent(json)))
      .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    // Skip if encoding would make URL too long (>800 chars for expenses alone)
    if (b64.length > 800) return null;
    return b64;
  } catch {
    return null;
  }
}

function decodeExpenses(encoded: string): ExpenseItem[] | null {
  try {
    // Restore base64 padding
    const b64 = encoded.replace(/-/g, '+').replace(/_/g, '/');
    const padded = b64 + '==='.slice(0, (4 - (b64.length % 4)) % 4);
    const json = decodeURIComponent(escape(atob(padded)));
    const compact = JSON.parse(json) as Array<{ l: string; a: number; f: string }>;
    return compact.map((e, i) => ({
      id: `url_${i}`,
      label: e.l,
      amount: e.a,
      frequency: (e.f === 'A' ? 'ANNUAL' : 'MONTHLY') as ExpenseItem['frequency'],
    }));
  } catch {
    return null;
  }
}
