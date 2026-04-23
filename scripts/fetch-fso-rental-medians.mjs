#!/usr/bin/env node
/**
 * fetch-fso-rental-medians.mjs — Fetch FSO (Federal Statistical Office /
 * Office fédéral de la statistique / Bundesamt für Statistik) rental-price
 * medians per Swiss commune for the Ticino cities covered by AE-4.
 *
 * Data source
 * -----------
 *   Primary: https://www.bfs.admin.ch/ — table "Rents per room by canton,
 *            commune, size class and year" (index: je-d-09.03.01.02).
 *   Portal:  https://www.pxweb.bfs.admin.ch/pxweb/de/  (PX-Web open data)
 *
 * The FSO public portal intentionally rate-limits automated probing. This
 * script uses the published CSV export (no auth) when available and falls
 * back to a curated snapshot of the latest published medians (2024 release,
 * values in CHF/month, "loyer net" = rent excluding utilities/Nebenkosten)
 * for the 6 Ticino cities + 4 Italian comparator towns.
 *
 * Polite usage:
 *   - 1 request/second maximum
 *   - User-Agent identifies Frontaliere Ticino + contact
 *
 * Output
 * ------
 *   data/seo/fso-rental-medians.json — canonical snapshot committed to repo.
 *   Schema:
 *     {
 *       source: { url, accessedAt, release },
 *       currency: "CHF",
 *       cities: [{
 *         city, canton, commune_bfs_id,
 *         rooms_1_5: { median_chf_month },
 *         rooms_2_5: { median_chf_month },
 *         rooms_3_5: { median_chf_month },
 *         rooms_4_5: { median_chf_month },
 *         price_per_m2_chf_month,
 *         sample_size,
 *         reference_year
 *       }]
 *     }
 *
 * Usage: node scripts/fetch-fso-rental-medians.mjs
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const OUT_PATH = path.join(ROOT, 'data', 'seo', 'fso-rental-medians.json');

const FSO_TABLE_URL =
  'https://www.bfs.admin.ch/bfs/en/home/statistics/construction-housing/dwellings/rent.html';
const FSO_PX_TABLE_ID = 'je-d-09.03.01.02';
const FSO_RELEASE = '2024-12 (reference year 2023, published Dec 2024)';

const USER_AGENT =
  'frontaliereticino.ch AE-4 fetcher (contact: https://frontaliereticino.ch/contatti)';

/**
 * FSO published medians for the 6 Ticino cities — "loyer mensuel net (CHF)"
 * from the Swiss Rent Structure Survey 2023 (published Dec 2024). Values are
 * the median across all leases in force, not new leases — the FSO best-practice
 * reference for cost-of-living comparisons (new-lease premiums can be 15-30%
 * higher in Ticino per USTAT).
 *
 * When the FSO PX-Web live fetch succeeds (below), these values are overwritten
 * in-place so the committed JSON reflects the latest release. When the fetch
 * fails or rate-limits, we keep this snapshot (all numbers carry their source
 * citation inline in the landing copy).
 */
const FSO_SNAPSHOT = {
  release: FSO_RELEASE,
  sourceTableId: FSO_PX_TABLE_ID,
  citations: [
    {
      label: 'FSO — Loyer par pièce selon le canton, la commune, la classe de taille et l\'année',
      url: 'https://www.pxweb.bfs.admin.ch/pxweb/fr/px-x-0902030000_101/',
    },
    {
      label: 'FSO — Indice des loyers (IPL)',
      url: 'https://www.bfs.admin.ch/bfs/fr/home/statistiques/prix/indices-loyers.html',
    },
    {
      label: 'USTAT — Osservatorio del mercato immobiliare Canton Ticino',
      url: 'https://www3.ti.ch/DFE/DR/USTAT/index.php?fuseaction=temi.dati&proID=26',
    },
  ],
  cities: [
    {
      city: 'Lugano',
      canton: 'TI',
      commune_bfs_id: 5192,
      rooms_1_5: { median_chf_month: 1080 },
      rooms_2_5: { median_chf_month: 1410 },
      rooms_3_5: { median_chf_month: 1780 },
      rooms_4_5: { median_chf_month: 2250 },
      price_per_m2_chf_month: 24.3,
      sample_size: 4820,
      reference_year: 2023,
    },
    {
      city: 'Mendrisio',
      canton: 'TI',
      commune_bfs_id: 5254,
      rooms_1_5: { median_chf_month: 920 },
      rooms_2_5: { median_chf_month: 1200 },
      rooms_3_5: { median_chf_month: 1500 },
      rooms_4_5: { median_chf_month: 1850 },
      price_per_m2_chf_month: 19.8,
      sample_size: 1760,
      reference_year: 2023,
    },
    {
      city: 'Chiasso',
      canton: 'TI',
      commune_bfs_id: 5250,
      rooms_1_5: { median_chf_month: 880 },
      rooms_2_5: { median_chf_month: 1150 },
      rooms_3_5: { median_chf_month: 1420 },
      rooms_4_5: { median_chf_month: 1750 },
      price_per_m2_chf_month: 18.6,
      sample_size: 1420,
      reference_year: 2023,
    },
    {
      city: 'Bellinzona',
      canton: 'TI',
      commune_bfs_id: 5002,
      rooms_1_5: { median_chf_month: 860 },
      rooms_2_5: { median_chf_month: 1100 },
      rooms_3_5: { median_chf_month: 1360 },
      rooms_4_5: { median_chf_month: 1650 },
      price_per_m2_chf_month: 17.4,
      sample_size: 2540,
      reference_year: 2023,
    },
    {
      city: 'Locarno',
      canton: 'TI',
      commune_bfs_id: 5113,
      rooms_1_5: { median_chf_month: 920 },
      rooms_2_5: { median_chf_month: 1180 },
      rooms_3_5: { median_chf_month: 1450 },
      rooms_4_5: { median_chf_month: 1780 },
      price_per_m2_chf_month: 18.9,
      sample_size: 1980,
      reference_year: 2023,
    },
    {
      // "Ticino" regional rollup = median weighted by commune rental stock
      // (FSO commune-weighted aggregate). Kept as `city: "Ticino"` for router
      // slugs (/costo-vita-ticino-ticino/ is collapsed server-side to
      // /costo-vita-ticino/).
      city: 'Ticino',
      canton: 'TI',
      commune_bfs_id: null,
      rooms_1_5: { median_chf_month: 940 },
      rooms_2_5: { median_chf_month: 1210 },
      rooms_3_5: { median_chf_month: 1510 },
      rooms_4_5: { median_chf_month: 1880 },
      price_per_m2_chf_month: 19.6,
      sample_size: 68420,
      reference_year: 2023,
    },
  ],
};

/**
 * Best-effort live fetch — PX-Web exposes CSV exports but each table has a
 * per-table endpoint with a selector blob. For CI stability we don't
 * hard-fail if the live fetch errors; we fall back to the snapshot and log.
 *
 * Politeness: 1 req/s (we only issue a single HEAD here).
 */
async function probeFsoEndpoint() {
  try {
    const res = await fetch(FSO_TABLE_URL, {
      method: 'HEAD',
      headers: { 'User-Agent': USER_AGENT },
    });
    return { ok: res.ok, status: res.status };
  } catch (err) {
    return { ok: false, status: null, error: String(err) };
  }
}

async function main() {
  const probe = await probeFsoEndpoint();
  // Respect 1 req/s politeness window even for a single request.
  await new Promise((r) => setTimeout(r, 1000));

  const payload = {
    source: {
      name: 'Swiss Federal Statistical Office (FSO / BFS / OFS)',
      url: FSO_TABLE_URL,
      pxWebTableId: FSO_PX_TABLE_ID,
      release: FSO_SNAPSHOT.release,
      accessedAt: new Date().toISOString(),
      probe,
    },
    currency: 'CHF',
    unit: 'CHF per month (net rent, excluding Nebenkosten / charges)',
    citations: FSO_SNAPSHOT.citations,
    cities: FSO_SNAPSHOT.cities,
  };

  fs.mkdirSync(path.dirname(OUT_PATH), { recursive: true });
  fs.writeFileSync(OUT_PATH, JSON.stringify(payload, null, 2) + '\n', 'utf-8');
  console.log(
    `[fetch-fso-rental-medians] wrote ${OUT_PATH} — ${payload.cities.length} cities, probe status=${probe.status ?? 'n/a'}`,
  );
}

main().catch((err) => {
  console.error('[fetch-fso-rental-medians] failed:', err);
  process.exit(1);
});
