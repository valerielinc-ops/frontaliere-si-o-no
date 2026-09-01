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
 * postalCode, city, phone }. Skips the header row. Returns
 * `{ rows: [], skipped: 0 }` if the table isn't found (structure drift —
 * caller decides how to react).
 *
 * `skipped` counts malformed data rows dropped in-place (too few cells, or
 * missing name/address/postal-code match) so a region that parses *some*
 * rows successfully doesn't silently lose the rest without a signal (#6800
 * — before this, only a whole-region zero-match was observable).
 */
export function parsePharmacyListTable(html) {
  if (!html) return { rows: [], skipped: 0 };

  const tableMatch = html.match(
    /id=["']tabella_lista_farmacie["'][^>]*>([\s\S]*?)<\/table>/i,
  );
  if (!tableMatch) return { rows: [], skipped: 0 };

  const rows = [];
  let skipped = 0;
  const rowRe = /<tr[^>]*>([\s\S]*?)<\/tr>/gi;
  let rowMatch;
  let isHeader = true;
  while ((rowMatch = rowRe.exec(tableMatch[1])) !== null) {
    if (isHeader) {
      isHeader = false;
      continue; // first row is the "Farmacia/Indirizzo/Località/Telefono" header
    }
    const cells = [...rowMatch[1].matchAll(/<td[^>]*>([\s\S]*?)<\/td>/gi)].map((m) => textify(m[1]));
    if (cells.length < 4) {
      skipped += 1;
      continue;
    }

    const [name, address, localita, phone] = cells;
    const localitaMatch = localita.match(/^(\d{4})\s+(.+)$/);
    if (!name || !address || !localitaMatch) {
      skipped += 1;
      continue;
    }

    rows.push({
      name,
      address,
      postalCode: localitaMatch[1],
      city: localitaMatch[2].trim(),
      phone: phone || undefined,
    });
  }

  return { rows, skipped };
}

/**
 * Builds `Pharmacy`-shaped records (see `services/pharmacies/types.ts`)
 * from a raw parsed table for one region. Returns `{ records, skipped }` —
 * `skipped` is the malformed-row count from `parsePharmacyListTable`,
 * forwarded so the caller can log/report it per region (#6800).
 */
export function buildPharmacyRecords(html, region, fetchedAt) {
  const { rows, skipped } = parsePharmacyListTable(html);
  const records = rows.map((row) => {
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
  return { records, skipped };
}

/**
 * Dedupe pharmacy records by `id` (a slug of name+city, see
 * `buildPharmacyRecords`), first-wins. Two distinct pharmacies sharing
 * name+city (e.g. same chain brand, different address) collide on `id` and
 * are indistinguishable with the current id scheme — this only makes the
 * drop observable (#6799), it does not fix the underlying id scheme.
 */
export function dedupePharmaciesById(pharmacies) {
  const byId = new Map();
  let collisions = 0;
  for (const p of pharmacies) {
    if (byId.has(p.id)) {
      collisions += 1;
      console.warn(
        `[import-pharmacies-ticino] id collision: "${p.id}" (name="${p.name}", city="${p.city}") ` +
          `collides with an already-seen record — dropping this one (first wins)`,
      );
      continue;
    }
    byId.set(p.id, p);
  }
  return { deduped: [...byId.values()], collisions };
}
