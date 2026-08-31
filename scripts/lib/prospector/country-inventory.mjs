/**
 * Versioned country inventory used by Prospector location evidence.
 *
 * Codes: ISO 3166-1 alpha-2, ISO/TC 46 N1108 snapshot 2023-04-05 (249
 * assigned codes). Names are expanded through the four product locales using
 * the Unicode CLDR data bundled with Node; explicit historic/common aliases
 * below make the matching stable where CLDR intentionally prefers a newer
 * short name (for example Czechia vs Czech Republic).
 */
export const COUNTRY_INVENTORY_VERSION = 'ISO-3166-1:2023-04-05; locales=en,de,fr,it; aliases=2026-08-31';

const ISO_ALPHA2_SNAPSHOT = `
AD AE AF AG AI AL AM AO AQ AR AS AT AU AW AX AZ BA BB BD BE BF BG BH BI BJ BL BM BN BO BQ BR BS BT BV BW BY BZ
CA CC CD CF CG CH CI CK CL CM CN CO CR CU CV CW CX CY CZ DE DJ DK DM DO DZ EC EE EG EH ER ES ET FI FJ FK FM FO FR
GA GB GD GE GF GG GH GI GL GM GN GP GQ GR GS GT GU GW GY HK HM HN HR HT HU ID IE IL IM IN IO IQ IR IS IT JE JM JO JP
KE KG KH KI KM KN KP KR KW KY KZ LA LB LC LI LK LR LS LT LU LV LY MA MC MD ME MF MG MH MK ML MM MN MO MP MQ MR MS MT
MU MV MW MX MY MZ NA NC NE NF NG NI NL NO NP NR NU NZ OM PA PE PF PG PH PK PL PM PN PR PS PT PW PY QA RE RO RS RU RW
SA SB SC SD SE SG SH SI SJ SK SL SM SN SO SR SS ST SV SX SY SZ TC TD TF TG TH TJ TK TL TM TN TO TR TT TV TW TZ UA UG
UM US UY UZ VA VC VE VG VI VN VU WF WS YE YT ZA ZM ZW
`.trim().split(/\s+/);

export const ISO_ALPHA2_COUNTRY_CODES = new Set(ISO_ALPHA2_SNAPSHOT);

const normalize = (value) => String(value || '')
  .toLowerCase()
  .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
  .replace(/[^a-z0-9]+/g, ' ')
  .replace(/\s+/g, ' ')
  .trim();

/** @type {Record<string, string[]>} */
const COMMON_MULTILINGUAL_ALIASES = {
  AE: ['UAE', 'U.A.E.', 'United Arab Emirates', 'Emirati Arabi Uniti', 'Vereinigte Arabische Emirate', 'Émirats arabes unis'],
  BO: ['Bolivia', 'Bolivie', 'Bolivien', 'Bolivia Plurinational State of'],
  BN: ['Brunei', 'Brunei Darussalam'],
  CD: ['Democratic Republic of the Congo', 'DR Congo', 'Congo Kinshasa', 'Repubblica Democratica del Congo', 'République démocratique du Congo', 'Demokratische Republik Kongo'],
  CG: ['Republic of the Congo', 'Congo Brazzaville', 'Repubblica del Congo', 'République du Congo', 'Republik Kongo'],
  CH: ['CH', 'CHE', 'Switzerland', 'Swiss', 'Schweiz', 'Suisse', 'Svizzera', 'Svizra', 'Confederazione Svizzera', 'Confédération suisse', 'Schweizerische Eidgenossenschaft'],
  CI: ["Cote d'Ivoire", 'Ivory Coast', "Côte d’Ivoire", 'Costa d’Avorio', 'Elfenbeinküste'],
  CZ: ['Czechia', 'Czech Republic', 'Repubblica Ceca', 'Cechia', 'Tschechien', 'Tschechische Republik', 'Tchéquie', 'République tchèque'],
  GB: ['UK', 'U.K.', 'United Kingdom', 'Great Britain', 'Britain', 'Regno Unito', 'Gran Bretagna', 'Vereinigtes Königreich', 'Grossbritannien', 'Royaume-Uni', 'Grande-Bretagne'],
  HK: ['Hong Kong', 'Hongkong'],
  IR: ['Iran', 'Islamic Republic of Iran'],
  KP: ['North Korea', 'Corea del Nord', 'Nordkorea', 'Corée du Nord'],
  KR: ['South Korea', 'Republic of Korea', 'Corea del Sud', 'Südkorea', 'Corée du Sud'],
  LA: ['Laos', "Lao People's Democratic Republic"],
  LI: ['Liechtenstein', 'Principato del Liechtenstein', 'Fürstentum Liechtenstein', 'Principauté du Liechtenstein'],
  LU: ['Luxembourg', 'Lussemburgo', 'Luxemburg'],
  MD: ['Moldova', 'Republic of Moldova', 'Moldavia', 'Moldavie', 'Moldau'],
  NL: ['Netherlands', 'The Netherlands', 'Paesi Bassi', 'Olanda', 'Niederlande', 'Holland', 'Pays-Bas'],
  PS: ['Palestine', 'State of Palestine', 'Stato di Palestina', 'État de Palestine', 'Staat Palästina'],
  RU: ['Russia', 'Russian Federation', 'Federazione Russa', 'Russische Föderation', 'Fédération de Russie'],
  SY: ['Syria', 'Syrian Arab Republic'],
  TW: ['Taiwan', 'Taiwan Province of China'],
  TZ: ['Tanzania', 'United Republic of Tanzania'],
  US: ['US', 'U.S.', 'USA', 'U.S.A.', 'United States', 'United States of America', 'Stati Uniti', "Stati Uniti d'America", 'Vereinigte Staaten', 'Vereinigte Staaten von Amerika', 'États-Unis', "États-Unis d'Amérique"],
  VA: ['Vatican City', 'Holy See', 'Città del Vaticano', 'Santa Sede', 'Vatikanstadt', 'Heiliger Stuhl', 'Cité du Vatican', 'Saint-Siège'],
  VE: ['Venezuela', 'Bolivarian Republic of Venezuela'],
  VN: ['Vietnam', 'Viet Nam'],
};

const labelsByCode = new Map();
for (const code of ISO_ALPHA2_SNAPSHOT) labelsByCode.set(code, new Set());
for (const locale of ['en', 'de', 'fr', 'it']) {
  const names = new Intl.DisplayNames([locale], { type: 'region' });
  for (const code of ISO_ALPHA2_SNAPSHOT) {
    const label = normalize(names.of(code));
    if (label && label !== normalize(code)) labelsByCode.get(code).add(label);
  }
}
for (const [code, aliases] of Object.entries(COMMON_MULTILINGUAL_ALIASES)) {
  for (const alias of aliases) {
    const label = normalize(alias);
    if (label && label !== normalize(code)) labelsByCode.get(code)?.add(label);
  }
}

export const SWISS_COUNTRY_LABELS = new Set([...labelsByCode.get('CH'), 'ch', 'che']);
export const FOREIGN_COUNTRY_NAME_LABELS = new Set(
  [...labelsByCode.entries()]
    .filter(([code]) => code !== 'CH')
    .flatMap(([, labels]) => [...labels]),
);
