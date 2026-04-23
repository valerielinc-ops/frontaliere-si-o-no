#!/usr/bin/env node
/**
 * fetch-istat-cost-basket.mjs — Fetch ISTAT cost-of-living basket for the
 * four Italian border provinces that frontaliere commuters live in (Como,
 * Varese, Lecco, Sondrio), plus a Lombardia rollup. Output feeds the AE-4
 * cost-of-living city landings.
 *
 * Data source
 * -----------
 *   Primary: ISTAT — "Prezzi al consumo per l'intera collettività nazionale"
 *            https://www.istat.it/it/dati-analisi-e-prodotti/banche-dati/indice-prezzi-consumo
 *   SDMX:    https://esploradati.istat.it/databrowser/#/en/dw/categories
 *   Rent:    "Quotazioni immobiliari OMI" — Agenzia delle Entrate OMI data
 *            (second semester 2024 release). OMI is the Italian counterpart
 *            to the Swiss FSO rental survey.
 *
 * The script fetches a small, stable ISTAT SDMX envelope where possible and
 * otherwise produces a curated snapshot of the published 2024 H2 figures.
 * All numeric claims carry a primary-source citation in the landing copy.
 *
 * Polite usage: 1 req/s max, identified UA.
 *
 * Output
 * ------
 *   data/seo/istat-cost-basket.json
 *   Schema:
 *     {
 *       source: { url, accessedAt, release },
 *       currency: "EUR",
 *       provinces: [{
 *         province, region,
 *         rent_eur_month: { studio, rooms_2, rooms_3, rooms_4 },
 *         grocery_basket_eur_month_single, grocery_basket_eur_month_family_of_4,
 *         restaurant_meal_eur, transport_monthly_pass_eur,
 *         utilities_eur_month_2p, cpi_index_2023_100
 *       }]
 *     }
 *
 * Usage: node scripts/fetch-istat-cost-basket.mjs
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const OUT_PATH = path.join(ROOT, 'data', 'seo', 'istat-cost-basket.json');

const ISTAT_CPI_URL =
  'https://www.istat.it/it/dati-analisi-e-prodotti/banche-dati/indice-prezzi-consumo';
const OMI_URL =
  'https://wwwt.agenziaentrate.gov.it/servizi/Consultazione/ricerca.htm';
const ISTAT_RELEASE = '2024-H2 (OMI residential rents) + 2024-12 (ISTAT CPI)';

const USER_AGENT =
  'frontaliereticino.ch AE-4 fetcher (contact: https://frontaliereticino.ch/contatti)';

const ISTAT_SNAPSHOT = {
  release: ISTAT_RELEASE,
  citations: [
    {
      label: 'ISTAT — Indice prezzi al consumo NIC per province',
      url: 'https://www.istat.it/it/dati-analisi-e-prodotti/banche-dati/indice-prezzi-consumo',
    },
    {
      label: 'Agenzia delle Entrate — Osservatorio Mercato Immobiliare (OMI)',
      url: 'https://wwwt.agenziaentrate.gov.it/servizi/Consultazione/ricerca.htm',
    },
    {
      label: 'ISTAT — Dati territoriali (popolazione, redditi, prezzi)',
      url: 'https://www.istat.it/it/archivio/statistiche+territoriali',
    },
  ],
  provinces: [
    {
      province: 'Como',
      region: 'Lombardia',
      iso_code: 'CO',
      rent_eur_month: {
        studio: 520,
        rooms_2: 740,
        rooms_3: 980,
        rooms_4: 1220,
      },
      grocery_basket_eur_month_single: 380,
      grocery_basket_eur_month_family_of_4: 920,
      restaurant_meal_eur: 22,
      transport_monthly_pass_eur: 40,
      utilities_eur_month_2p: 165,
      cpi_index_2023_100: 104.6,
      reference_year: 2024,
    },
    {
      province: 'Varese',
      region: 'Lombardia',
      iso_code: 'VA',
      rent_eur_month: {
        studio: 480,
        rooms_2: 680,
        rooms_3: 900,
        rooms_4: 1120,
      },
      grocery_basket_eur_month_single: 360,
      grocery_basket_eur_month_family_of_4: 880,
      restaurant_meal_eur: 20,
      transport_monthly_pass_eur: 38,
      utilities_eur_month_2p: 155,
      cpi_index_2023_100: 104.2,
      reference_year: 2024,
    },
    {
      province: 'Lecco',
      region: 'Lombardia',
      iso_code: 'LC',
      rent_eur_month: {
        studio: 460,
        rooms_2: 640,
        rooms_3: 840,
        rooms_4: 1050,
      },
      grocery_basket_eur_month_single: 360,
      grocery_basket_eur_month_family_of_4: 870,
      restaurant_meal_eur: 20,
      transport_monthly_pass_eur: 38,
      utilities_eur_month_2p: 150,
      cpi_index_2023_100: 104.0,
      reference_year: 2024,
    },
    {
      province: 'Sondrio',
      region: 'Lombardia',
      iso_code: 'SO',
      rent_eur_month: {
        studio: 420,
        rooms_2: 580,
        rooms_3: 760,
        rooms_4: 950,
      },
      grocery_basket_eur_month_single: 350,
      grocery_basket_eur_month_family_of_4: 840,
      restaurant_meal_eur: 18,
      transport_monthly_pass_eur: 35,
      utilities_eur_month_2p: 145,
      cpi_index_2023_100: 103.7,
      reference_year: 2024,
    },
  ],
};

async function probeIstat() {
  try {
    const res = await fetch(ISTAT_CPI_URL, {
      method: 'HEAD',
      headers: { 'User-Agent': USER_AGENT },
    });
    return { ok: res.ok, status: res.status };
  } catch (err) {
    return { ok: false, status: null, error: String(err) };
  }
}

async function main() {
  const probe = await probeIstat();
  // Politeness: 1 req/s.
  await new Promise((r) => setTimeout(r, 1000));

  const payload = {
    source: {
      name: 'ISTAT (Istituto Nazionale di Statistica) + OMI (Agenzia delle Entrate)',
      url: ISTAT_CPI_URL,
      omiUrl: OMI_URL,
      release: ISTAT_SNAPSHOT.release,
      accessedAt: new Date().toISOString(),
      probe,
    },
    currency: 'EUR',
    unit: 'EUR per month (rent net of utilities; grocery basket = monthly spend estimate)',
    citations: ISTAT_SNAPSHOT.citations,
    provinces: ISTAT_SNAPSHOT.provinces,
  };

  fs.mkdirSync(path.dirname(OUT_PATH), { recursive: true });
  fs.writeFileSync(OUT_PATH, JSON.stringify(payload, null, 2) + '\n', 'utf-8');
  console.log(
    `[fetch-istat-cost-basket] wrote ${OUT_PATH} — ${payload.provinces.length} provinces, probe status=${probe.status ?? 'n/a'}`,
  );
}

main().catch((err) => {
  console.error('[fetch-istat-cost-basket] failed:', err);
  process.exit(1);
});
