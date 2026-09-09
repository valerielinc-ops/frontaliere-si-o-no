import pharmacyJson from '../../data/pharmacies-ticino.json';
import type { Pharmacy } from './types';

export const TICINO_PHARMACIES = pharmacyJson.pharmacies as Pharmacy[];

function slugifyCity(value: string): string {
  return String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

export const TICINO_CITIES = [...new Set(TICINO_PHARMACIES.map((pharmacy) => pharmacy.city))]
  .sort((a, b) => a.localeCompare(b, 'it'))
  .map((name) => ({ name, slug: slugifyCity(name) }));

export const TICINO_CITY_BY_SLUG = new Map(TICINO_CITIES.map((city) => [city.slug, city.name]));

export function pharmacyCitySlug(city: string): string {
  return slugifyCity(city);
}

export function pharmaciesForCity(city: string): Pharmacy[] {
  return TICINO_PHARMACIES.filter((pharmacy) => pharmacy.city === city);
}

export function pharmacyById(id: string): Pharmacy | undefined {
  return TICINO_PHARMACIES.find((pharmacy) => pharmacy.id === id);
}
