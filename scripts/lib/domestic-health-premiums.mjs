import { BAG_AGE_CLASSES, BAG_ACCIDENT_COVER, BAG_MODELS, bagFranchiseAmount, bagSwissRegion, isOrdinaryBagChildTier } from './health-premium-codes.mjs';

/** Exact published Swiss quotes, grouped by premium region (never regional averages). */
export function buildDomesticHealthQuotes(rows) {
  const quotes = {};
  for (const row of rows) {
    if (!['CH', 'P_OKPCH'].includes(row.Hoheitsgebiet)) continue;
    const age = BAG_AGE_CLASSES[row.Altersklasse];
    const accident = BAG_ACCIDENT_COVER[row.Unfalleinschluss];
    const model = BAG_MODELS[row.Tariftyp];
    const region = bagSwissRegion(row.Region)?.replace('PR-REG CH', '');
    const franchise = bagFranchiseAmount(row.Franchise);
    const premium = Number(row['Prämie']);
    // Additional-child discounts require family eligibility; quote ordinary K1 only.
    if (!isOrdinaryBagChildTier(row)) continue;
    if (!model) continue; // Unsupported product categories are not quoted.
    if (!age || !accident || region === undefined || !Number.isFinite(franchise) || !Number.isFinite(premium) || premium <= 0) {
      throw new Error('Invalid domestic health premium profile');
    }
    const canton = quotes[row.Kanton] ??= {};
    const regional = canton[region] ??= {};
    const insurer = regional[String(Number(row.Versicherer))] ??= {};
    const ageQuotes = insurer[age] ??= {};
    const accidentQuotes = ageQuotes[accident] ??= {};
    const models = accidentQuotes[franchise] ??= {};
    // Several named products may share a category. Keep its lowest published quote.
    if (models[model] === undefined || premium < models[model]) models[model] = premium;
  }
  if (!Object.keys(quotes).length) throw new Error('No domestic health premium quotes');
  return quotes;
}

export function assertDomesticHealthQuotes(quotes) {
  const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
  const requireEntries = value => {
    if (!object(value) || !Object.keys(value).length) throw new Error('Empty or invalid domestic quote block');
    return Object.entries(value);
  };
  const knownModels = new Set(Object.values(BAG_MODELS));
  for (const [canton, regions] of requireEntries(quotes)) {
    if (!/^[A-Z]{2}$/.test(canton)) throw new Error('Invalid domestic quote canton');
    for (const [region, insurers] of requireEntries(regions)) {
      if (!/^[0-3]$/.test(region)) throw new Error('Invalid domestic quote region');
      for (const [insurerId, ages] of requireEntries(insurers)) {
        if (!/^\d+$/.test(insurerId)) throw new Error('Invalid domestic quote insurer');
        for (const [age, accidents] of requireEntries(ages)) {
          if (!['KIN', 'JUG', 'ERW'].includes(age)) throw new Error('Invalid domestic quote age');
          const deductibles = age === 'KIN' ? [0, 100, 200, 300, 400, 500, 600] : [300, 500, 1000, 1500, 2000, 2500];
          for (const [accident, franchises] of requireEntries(accidents)) {
            if (!['withAccident', 'withoutAccident'].includes(accident)) throw new Error('Invalid domestic quote accident coverage');
            for (const [franchise, models] of requireEntries(franchises)) {
              if (!deductibles.includes(Number(franchise))) throw new Error('Invalid domestic quote deductible');
              for (const [model, premium] of requireEntries(models)) {
                if (!knownModels.has(model) || typeof premium !== 'number' || !Number.isFinite(premium) || premium <= 0) throw new Error('Invalid domestic quote amount/model');
              }
            }
          }
        }
      }
    }
  }
  return quotes;
}
