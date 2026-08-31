#!/usr/bin/env node
/**
 * Parser for the Ticino pharmacy directory published per-region on
 * `ofct.ch` (Ordine dei Farmacisti del Cantone Ticino), verified in #6398
 * (see `docs/data-sources/farmacie-turno-ticino.md`).
 *
 * Each region page embeds a static `#tabella_lista_farmacie` HTML table
 * (no JS needed, confirmed via plain `curl`) with a fixed column order:
 * Farmacia / Indirizzo / Località (`{postalCode}  {city}`, double-space
 * separator) / Telefono. Locarnese is excluded — it lives on a separate
 * domain (`farmacielocarnese.ch`) with a different template: network access
 * is verified (#6740, see `docs/data-sources/farmacie-turno-ticino.md`) but
 * no dedicated parser exists yet (no anagraphic table, duty table has no
 * address/postal code).
 */
import { slugify } from './crawler-template.mjs';

export const OFCT_REGIONS = [
  { key: 'mendrisiotto', name: 'Mendrisiotto', url: 'https://www.ofct.ch/mendrisiotto/' },
  { key: 'luganese', name: 'Luganese', url: 'https://www.ofct.ch/luganese/' },
  { key: 'bellinzonese', name: 'Bellinzonese', url: 'https://www.ofct.ch/bellinzonese/' },
  { key: 'biasca-e-valli', name: 'Biasca e Valli', url: 'https://www.ofct.ch/biasca-e-valli/' },
];

function decodeEntities(str = '') {
  return String(str || '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;|&apos;/g, "'")
    .replace(/&nbsp;/g, ' ');
}

function textify(html = '') {
  return decodeEntities(String(html || '').replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
}

/**
 * Extracts raw rows from `#tabella_lista_farmacie`: { name, address,
 * postalCode, city, phone }. Skips the header row. Returns `[]` if the
 * table isn't found (structure drift — caller decides how to react).
 */
export function parsePharmacyListTable(html) {
  if (!html) return [];

  const tableMatch = html.match(
    /id=["']tabella_lista_farmacie["'][^>]*>([\s\S]*?)<\/table>/i,
  );
  if (!tableMatch) return [];

  const rows = [];
  const rowRe = /<tr[^>]*>([\s\S]*?)<\/tr>/gi;
  let rowMatch;
  let isHeader = true;
  while ((rowMatch = rowRe.exec(tableMatch[1])) !== null) {
    if (isHeader) {
      isHeader = false;
      continue; // first row is the "Farmacia/Indirizzo/Località/Telefono" header
    }
    const cells = [...rowMatch[1].matchAll(/<td[^>]*>([\s\S]*?)<\/td>/gi)].map((m) => textify(m[1]));
    if (cells.length < 4) continue;

    const [name, address, localita, phone] = cells;
    const localitaMatch = localita.match(/^(\d{4})\s+(.+)$/);
    if (!name || !address || !localitaMatch) continue;

    rows.push({
      name,
      address,
      postalCode: localitaMatch[1],
      city: localitaMatch[2].trim(),
      phone: phone || undefined,
    });
  }

  return rows;
}

/**
 * Builds `Pharmacy`-shaped records (see `services/pharmacies/types.ts`)
 * from a raw parsed table for one region.
 */
export function buildPharmacyRecords(html, region, fetchedAt) {
  const rows = parsePharmacyListTable(html);
  return rows.map((row) => {
    const slug = slugify(`${row.name} ${row.city}`);
    return {
      id: `ti-${slug}`,
      name: row.name,
      slug,
      address: row.address,
      postalCode: row.postalCode,
      city: row.city,
      canton: 'Ticino',
      country: 'CH',
      phone: row.phone,
      sourceUrl: region.url,
      sourceType: 'official',
      lastVerifiedAt: fetchedAt,
    };
  });
}
