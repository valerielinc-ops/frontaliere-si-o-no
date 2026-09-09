/**
 * Controlled inputs for the independent CompanyAlert oracle (scope E).
 *
 * This fixture is deliberately separate from the sender worker's probes. Its
 * expected company identities and state transitions come from the E expected
 * artifact, not from the implementation under test.
 */

export const CONTROLLED_EMAIL = 'company-alert-oracle@example.test';
export const CONTROLLED_USER_ID = 'user-company-alert-oracle';
export const CONTROLLED_LOCALE = 'it' as const;
export const WINDOW_MS = 6 * 60 * 60 * 1000;

export const EXPECTED_CANONICAL_KEYS = {
  acme: 'acme',
  migros: 'migros',
  guess: 'guess-europe-sagl',
} as const;

export const MATCHING_EXPECTATIONS = [
  { alert: 'Acme', job: 'Acme', expected: true, label: 'acme-exact' },
  { alert: 'Acme', job: 'ACME', expected: true, label: 'acme-casing' },
  { alert: 'Acme', job: 'Acme Holdings', expected: false, label: 'acme-suffix' },
  { alert: 'Acme', job: 'Mega Acme', expected: false, label: 'acme-prefix' },
  { alert: 'Acme Holdings', job: 'Acme', expected: false, label: 'acme-reverse-prefix' },
  { alert: 'Migros Ticino', job: 'Migros', expected: true, label: 'migros-alias' },
  { alert: 'Guess Ticino', job: 'Guess Europe Sagl', expected: true, label: 'guess-legal-alias' },
  { alert: 'Guess Ticino', job: 'Medacta International SA', expected: false, label: 'guess-unrelated' },
] as const;

export interface OracleJobOptions {
  status?: string;
  active?: boolean;
  expiresAt?: string | null;
  companyKey?: string | null;
  url?: string;
}

export interface OracleAlertOptions {
  frequency?: 'immediate' | 'daily' | 'weekly';
  active?: boolean;
  paused?: boolean;
  specificCompanyKey?: string | null;
  sentJobIds?: Record<string, number>;
  deliveryLedger?: Record<string, Record<string, unknown>>;
  refId?: string;
}

export function hoursAgo(nowMs: number, hours: number): string {
  return new Date(nowMs - hours * 60 * 60 * 1000).toISOString();
}

export function hoursAhead(nowMs: number, hours: number): string {
  return new Date(nowMs + hours * 60 * 60 * 1000).toISOString();
}

export function makeJob(
  id: string | null,
  company: string,
  nowMs: number,
  firstSeenHoursAgo = 1,
  options: OracleJobOptions = {},
): Record<string, unknown> {
  const stablePart = id || 'idless';
  return {
    ...(id ? { id } : {}),
    title: 'Ruolo controllato ' + stablePart,
    company,
    companyKey: options.companyKey ?? null,
    location: 'Lugano',
    canton: 'TI',
    firstSeenAt: hoursAgo(nowMs, firstSeenHoursAgo),
    url: options.url || 'https://frontaliereticino.ch/lavoro/company-alert-oracle-' + stablePart + '/',
    ...(options.status === undefined ? {} : { status: options.status }),
    ...(options.active === undefined ? {} : { active: options.active }),
    ...(options.expiresAt === undefined ? {} : { expiresAt: options.expiresAt }),
  };
}

export function makeAlert(
  id: string,
  displayCompany: string,
  specificCompanyKey: string | null,
  options: OracleAlertOptions = {},
): Record<string, unknown> {
  return {
    id,
    ref: { id: options.refId || 'alert-ref-' + id },
    userId: CONTROLLED_USER_ID,
    email: CONTROLLED_EMAIL,
    locale: CONTROLLED_LOCALE,
    keywords: [],
    locations: [],
    sectors: [],
    contractTypes: [],
    cantonFilter: null,
    frequency: options.frequency || 'immediate',
    frequencyOverride: true,
    specificCompanyKey,
    active: options.active !== false,
    paused: options.paused === true,
    sourceJobSlug: 'company-alert-oracle-' + displayCompany.toLowerCase().replace(/\s+/g, '-'),
    sourceJobUrl: 'https://frontaliereticino.ch/aziende/' + (specificCompanyKey || 'unresolved') + '/',
    sourceJobTitle: displayCompany,
    sentJobIds: options.sentJobIds || {},
    deliveryLedger: options.deliveryLedger || {},
  };
}
