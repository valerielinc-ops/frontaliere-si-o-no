#!/usr/bin/env node
/** Country-of-residence premiums, separate from Swiss canton/commune premiums. */
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { fetchPremiumsCsv, parseCSV, PREMIUM_CSV_REQUIRED_HEADERS, INSURER_DIRECTORY } from './fetch-health-premiums.mjs';
import { writeJsonAtomic } from './lib/atomic-write-json.mjs';
import { BAG_AGE_CLASSES, BAG_ACCIDENT_COVER, bagFranchiseAmount } from './lib/health-premium-codes.mjs';

export const EU_REQUIRED_HEADERS = PREMIUM_CSV_REQUIRED_HEADERS.map(header => header === 'Kanton' ? 'Land' : header);
const AGE_GROUPS = { KIN: '0-18', JUG: '19-25', ERW: '26+' };

export function buildEuPremiumSnapshot(csvText, { year, sourceUrl, fetchedAt = new Date().toISOString() }) {
  const rows = parseCSV(csvText, undefined, EU_REQUIRED_HEADERS);
  if (!rows.length || rows.some(row => Number(row['Geschäftsjahr']) !== year)) throw new Error('EU premium year mismatch or empty CSV');
  const countries = {};
  for (const row of rows) {
    const country = row.Land.replace(/^EU /, '');
    const age = AGE_GROUPS[BAG_AGE_CLASSES[row.Altersklasse]];
    const accident = BAG_ACCIDENT_COVER[row.Unfalleinschluss];
    const insurerId = String(Number(row.Versicherer));
    const insurer = INSURER_DIRECTORY[insurerId];
    const premium = Number(row['Prämie']);
    const franchise = bagFranchiseAmount(row.Franchise);
    if (!/^[A-Z]{2}$/.test(country) || !age || !accident || !insurer || !Number.isFinite(premium) || premium <= 0) {
      throw new Error(`Unrecognised EU premium row: ${country}/${row.Versicherer}/${row.Altersklasse}/${row.Unfalleinschluss}`);
    }
    if (row.Tariftyp !== 'BASE' || franchise !== (age === '0-18' ? 0 : 300)) throw new Error('EU premium is not the statutory standard insurance');
    const childTier = age === '0-18' ? row.Altersuntergruppe || 'K1' : 'ordinary';
    if (age === '0-18' && !['K1', 'K2', 'K3'].includes(childTier)) throw new Error(`Unknown child tier ${childTier}`);
    const group = countries[country] ??= { insurers: {} };
    const entry = group.insurers[insurerId] ??= { id: insurerId, name: insurer.name, website: insurer.website, premiums: {} };
    const variants = entry.premiums[age] ??= {};
    const tiers = variants[accident] ??= {};
    if (tiers[childTier] !== undefined && tiers[childTier] !== premium) throw new Error('Conflicting duplicate EU premium');
    tiers[childTier] = premium;
  }
  for (const country of Object.values(countries)) {
    for (const insurer of Object.values(country.insurers)) {
      for (const age of ['0-18', '19-25', '26+']) {
        for (const accident of ['withAccident', 'withoutAccident']) {
          if (!(insurer.premiums[age]?.[accident]?.[age === '0-18' ? 'K1' : 'ordinary'] > 0)) throw new Error('Incomplete EU insurer coverage');
        }
      }
    }
  }
  if (!countries.IT) throw new Error('EU snapshot is missing Italy');
  return { schemaVersion: 1, year, fetchedAt, sourceUrl, residenceBasis: 'country', countries };
}

async function main() {
  const yearArg = process.argv.find(arg => /^--year=\d{4}$/.test(arg));
  const year = yearArg ? Number(yearArg.slice(7)) : new Date().getUTCFullYear();
  const { csvText, sourceUrl } = await fetchPremiumsCsv(year, 'EU');
  const snapshot = buildEuPremiumSnapshot(csvText, { year, sourceUrl });
  // Test/investigation runs can redirect both outputs away from tracked cron files.
  const root = process.env.HEALTH_EU_OUTPUT_ROOT || path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  for (const folder of ['data', 'public/data']) {
    writeJsonAtomic(path.join(root, folder, 'health-premiums-eu', `${year}.json`), snapshot);
  }
  console.log(`EU premiums ${year}: ${Object.keys(snapshot.countries).length} countries; Italy ${Object.keys(snapshot.countries.IT.insurers).length} insurers`);
}
if (import.meta.url === pathToFileURL(process.argv[1] || '').href) main().catch(error => { console.error(error.message); process.exitCode = 1; });
