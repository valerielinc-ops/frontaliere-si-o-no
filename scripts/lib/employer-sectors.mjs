// Classificazione settore datori per l'outreach — modulo condiviso (single
// source of truth, evita drift tra enrich-employer-contacts.mjs e
// generate-cold-emails.mjs).
//
// NB: serve solo come ETICHETTA di contesto nelle bozze (es. "pubblico",
// "multinazionale", "pmi") — NON esclude nessuna azienda. Tutti i datori sono
// target validi; il tag aiuta solo a calibrare il messaggio a mano.

export const PUBLIC_SECTOR = [
  /ente ospedaliero|^eoc\b/i, /città di|comune di|municipio/i, /amministrazione cantonale/i,
  /università|^usi\b|supsi/i, /istituti sociali|^lis\b/i, /ferrovie|^ffs\b|officine/i,
  /pro senectute/i, /cantonal|repubblica e cantone/i,
];

export const MULTINATIONAL = [
  /aldi/i, /lidl/i, /\bcoop\b/i, /swisscom/i, /sunrise/i, /mcdonald/i, /marriott/i,
  /heineken/i, /kempinski/i, /capri holdings|michael kors|versace/i, /prada/i,
  /\bvf\b|north face|timberland/i, /manor\b/i, /efg international/i, /galenica|amavita/i,
  /läderach|laderach/i, /volg|fenaco/i,
];

/** Etichetta di contesto (non filtra): 'pubblico' | 'multinazionale' | 'pmi'. */
export function classifySector(name) {
  if (PUBLIC_SECTOR.some((re) => re.test(name || ''))) return 'pubblico';
  if (MULTINATIONAL.some((re) => re.test(name || ''))) return 'multinazionale';
  return 'pmi';
}

export function slugify(s) {
  return String(s || '')
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}
