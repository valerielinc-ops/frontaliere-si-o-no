import { assertDomesticHealthQuotes } from '../scripts/lib/domestic-health-premiums.mjs';

/** Premium selection for people resident outside Switzerland: never use canton prices. */
export type HealthPremiumAgeGroup = '0-18' | '19-25' | '26+';
export type HealthResidence = 'IT' | 'CH';
export interface EuHealthInsurer {
  id: string;
  name: string;
  website: string;
  premiums: Record<HealthPremiumAgeGroup, Record<'withAccident' | 'withoutAccident', Record<string, number>>>;
}
export interface EuHealthPremiums {
  schemaVersion: 1;
  year: number;
  fetchedAt: string;
  sourceUrl: string;
  residenceBasis: 'country';
  countries: Record<string, { insurers: Record<string, EuHealthInsurer> }>;
}
export function statutoryEuFranchise(age: HealthPremiumAgeGroup): number {
  return age === '0-18' ? 0 : 300;
}
export function euMonthlyPremium(insurer: EuHealthInsurer | undefined, age: HealthPremiumAgeGroup, withAccident: boolean): number | null {
  // K3 discounts depend on family composition; never silently apply them to every child.
  const amount = insurer?.premiums?.[age]?.[withAccident ? 'withAccident' : 'withoutAccident']?.[age === '0-18' ? 'K1' : 'ordinary'];
  return typeof amount === 'number' && Number.isFinite(amount) && amount > 0 ? amount : null;
}
export function isCurrentEuPremiumSnapshot(value: unknown, year: number): value is EuHealthPremiums {
  if (!value || typeof value !== 'object') return false;
  const data = value as Partial<EuHealthPremiums>;
  if (data.schemaVersion !== 1 || data.year !== year || data.residenceBasis !== 'country'
    || typeof data.sourceUrl !== 'string' || typeof data.fetchedAt !== 'string'
    || !Number.isFinite(Date.parse(data.fetchedAt))) return false;
  const insurers = data.countries?.IT?.insurers;
  if (!insurers || typeof insurers !== 'object' || Array.isArray(insurers)) return false;
  const values = Object.values(insurers);
  return values.length > 0 && values.every(insurer => insurer && typeof insurer === 'object'
    && typeof insurer.id === 'string' && typeof insurer.name === 'string' && typeof insurer.website === 'string'
    && (['0-18', '19-25', '26+'] as const).every(age =>
      euMonthlyPremium(insurer, age, true) !== null && euMonthlyPremium(insurer, age, false) !== null));
}

export type DomesticAgeClass = 'KIN' | 'JUG' | 'ERW';
export type DomesticModelPremiums = Partial<Record<string, number>>;
export type DomesticProfileQuotes = Partial<Record<DomesticAgeClass,
  Partial<Record<'withAccident' | 'withoutAccident', Record<string, DomesticModelPremiums>>>>>;
export type DomesticHealthQuotes = Record<string, Record<string, Record<string, DomesticProfileQuotes>>>;
export const domesticAgeClass = (age: HealthPremiumAgeGroup): DomesticAgeClass =>
  age === '0-18' ? 'KIN' : age === '19-25' ? 'JUG' : 'ERW';

export function domesticMonthlyPremium(profile: DomesticProfileQuotes | undefined, age: HealthPremiumAgeGroup,
  withAccident: boolean, franchise: number, model: string): number | null {
  const premium = profile?.[domesticAgeClass(age)]?.[withAccident ? 'withAccident' : 'withoutAccident']?.[franchise]?.[model];
  return typeof premium === 'number' && Number.isFinite(premium) && premium > 0 ? premium : null;
}

export interface DomesticHealthPremiumsData {
 quotes?: DomesticHealthQuotes;
 sourceUrl?: string;
 fetchedAt: string;
 year: number;
 insurers: { id: string; name: string; website: string }[];
 communes: Record<string, { name: string; bfsNr: number; plz: string; region: number }[]>;
 premiums: Record<string, {
 type?: 'canton';
 canton: string;
 region: number | null;
 bfsNr?: number;
 insurers: Record<string, Record<string, number>>;
 }>;
 rankings: {
 cheapest: { municipality: string; canton: string; avgPremium: number; numInsurers: number }[];
 mostExpensive: { municipality: string; canton: string; avgPremium: number; numInsurers: number }[];
 };
}


/** Validate all domestic fields dereferenced by the UI before accepting a response. */
export function isCurrentDomesticPremiumSnapshot(value: unknown, year: number): value is DomesticHealthPremiumsData {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const data = value as Partial<DomesticHealthPremiumsData>;
  if (data.year !== year || typeof data.fetchedAt !== 'string' || !Number.isFinite(Date.parse(data.fetchedAt))) return false;
  if (!Array.isArray(data.insurers) || !data.insurers.length || !data.insurers.every(insurer => insurer
    && typeof insurer.id === 'string' && typeof insurer.name === 'string' && typeof insurer.website === 'string')) return false;
  if (!data.communes || typeof data.communes !== 'object' || Array.isArray(data.communes)
    || !Object.values(data.communes).every(communes => Array.isArray(communes) && communes.every(commune => commune
      && typeof commune.name === 'string' && typeof commune.plz === 'string'
      && Number.isInteger(commune.bfsNr) && Number.isInteger(commune.region)))) return false;
  if (!data.rankings || ![data.rankings.cheapest, data.rankings.mostExpensive].every(ranking => Array.isArray(ranking)
    && ranking.every(entry => entry && typeof entry.municipality === 'string' && typeof entry.canton === 'string'
      && Number.isFinite(entry.avgPremium) && Number.isInteger(entry.numInsurers)))) return false;
  try { assertDomesticHealthQuotes(data.quotes); } catch { return false; }
  return true;
}
