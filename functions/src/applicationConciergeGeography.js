/** Bounded city/postcode ranking hints; never qualifications or permission to work. */
// ISO country/territory codes in the residence catalogue; translated labels come from CLDR.
const COUNTRY_CODES = new Set('AD AE AF AG AI AL AM AO AQ AR AS AT AU AW AX AZ BA BB BD BE BF BG BH BI BJ BL BM BN BO BQ BR BS BT BV BW BY BZ CA CC CD CF CG CH CI CK CL CM CN CO CR CU CV CW CX CY CZ DE DJ DK DM DO DZ EC EE EG EH ER ES ET FI FJ FK FM FO FR GA GB GD GE GF GG GH GI GL GM GN GP GQ GR GS GT GU GW GY HK HM HN HR HT HU ID IE IL IM IN IO IQ IR IS IT JE JM JO JP KE KG KH KI KM KN KP KR XK KW KY KZ LA LB LC LI LK LR LS LT LU LV LY MA MC MD ME MF MG MH MK ML MM MN MO MP MQ MR MS MT MU MV MW MX MY MZ NA NC NE NF NG NI NL NO NP NR NU NZ OM PA PE PF PG PH PK PL PM PN PR PS PT PW PY QA RE RO RS RU RW SA SB SC SD SS SE SG SH SI SJ SK SL SM SN SO SR ST SV SX SY SZ TC TD TF TG TH TJ TK TL TM TN TO TR TT TV TW TZ UA UG UM US UY UZ VA VC VE VG VI VN VU WF WS YE YT ZA ZM ZW'.split(' '));
const POINTS = Object.freeze({ sameLocality: 8, sameThreeDigitPostcode: 6, sameTwoDigitPostcode: 4, adjacentTwoDigitPostcode: 2 });
const CANTON_CODES = new Set('ag ai ar be bl bs fr ge gl gr ju lu ne nw ow sg sh so sz tg ti ur vd vs zg zh'.split(' '));
const NON_LOCALITY_WORDS = new Set('ch switzerland svizzera schweiz suisse italia italy italien canton cantone kanton ticino tessin grigioni graubunden graubuenden grisons'.split(' '));
const fold = value => String(value || '').normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/ß/g, 'ss').replace(/[^a-z0-9]+/g, ' ').trim();
const CANTON_NAMES = new Map(Object.entries({
  ag: 'Aargau|Argovia|Argovie', ai: 'Appenzell Innerrhoden|Appenzello Interno|Appenzell Rhodes Intérieures',
  ar: 'Appenzell Ausserrhoden|Appenzello Esterno|Appenzell Rhodes Extérieures', be: 'Bern|Berne|Berna',
  bl: 'Basel Landschaft|Basilea Campagna|Bâle Campagne', bs: 'Basel Stadt|Basel City|Basilea Città|Bâle Ville',
  fr: 'Fribourg|Freiburg|Friburgo', ge: 'Geneva|Genève|Genf|Ginevra', gl: 'Glarus|Glarona|Glaris',
  gr: 'Grisons|Graubünden|Graubuenden|Grigioni', ju: 'Jura|Giura', lu: 'Lucerne|Luzern|Lucerna',
  ne: 'Neuchâtel|Neuenburg', nw: 'Nidwalden|Nidvaldo|Nidwald', ow: 'Obwalden|Obvaldo|Obwald',
  sg: 'Sankt Gallen|Saint Gallen|St Gallen|San Gallo|Saint Gall', sh: 'Schaffhausen|Sciaffusa|Schaffhouse',
  so: 'Solothurn|Soletta|Soleure', sz: 'Schwyz|Svitto|Schwytz', tg: 'Thurgau|Turgovia|Thurgovie',
  ti: 'Ticino|Tessin', ur: 'Uri', vd: 'Vaud|Waadt', vs: 'Valais|Wallis|Vallese', zg: 'Zug|Zugo|Zoug', zh: 'Zurich|Zürich|Zurigo',
}).flatMap(([code, names]) => names.split('|').map(name => [fold(name), code])));

let countries;
function countryNames() {
  if (countries) return countries;
  countries = new Map();
  const add = (name, code) => {
    const key = fold(name);
    countries.set(key, countries.has(key) && countries.get(key) !== code ? null : code);
  };
  // CLDR supplies the same four translated country suffixes as the residence
  // control. Never infer a country from a town, postcode, province or language.
  for (const locale of ['it', 'en', 'de', 'fr']) {
    const names = new Intl.DisplayNames([locale], { type: 'region' });
    for (const code of COUNTRY_CODES) add(names.of(code), code);
  }
  add('Saint Helena, Ascension and Tristan da Cunha', 'SH');
  return countries;
}

function namedCountry(value) {
  return countryNames().get(fold(value)) || '';
}

function structuredCountry(value) {
  const name = typeof value === 'object' && value ? value.name : value;
  if (/^[a-z]{2}$/i.test(String(name || ''))) {
    const code = String(name).toUpperCase();
    return COUNTRY_CODES.has(code) ? code : '';
  }
  return namedCountry(name);
}

function locationParts(value) {
  const text = String(value || '');
  for (let split = text.indexOf(','); split >= 0; split = text.indexOf(',', split + 1)) {
    const suffix = text.slice(split + 1).trim();
    const encoded = suffix.match(/^(.+) \(([A-Z]{2})\)$/);
    const country = namedCountry(encoded?.[1] || suffix);
    // Georgia can mean a US state. The residence control marks the country GE.
    if (country && (encoded ? country === encoded[2] : country !== 'GE')) return { town: text.slice(0, split), country };
  }
  return { town: text, country: '' };
}

function locality(value, country) {
  const text = String(value || '').replace(/\b\d{4,5}\b/g, ' ');
  const part = text.split(/[;,|/]+/).find(part => fold(part).split(' ').some(token => !CANTON_CODES.has(token) && !NON_LOCALITY_WORDS.has(token))) || '';
  const annotation = part.match(/\s+\(([^()]*)\)\s*$/);
  const key = value => fold(value).split(' ').filter(token => !CANTON_CODES.has(token) && !NON_LOCALITY_WORDS.has(token)).join(' ');
  const qualifier = annotation ? fold(annotation[1]) : '';
  return { key: key(annotation ? part.slice(0, annotation.index) : part), qualifier: country === 'CH' ? CANTON_NAMES.get(qualifier) || qualifier : qualifier };
}

function postcode(value) {
  return String(value || '').match(/\b(\d{4,5})\b/)?.[1] || '';
}

export function locationMatchPoints(candidateLocation, job) {
  if (!candidateLocation) return 0;
  const jobLocation = [job?.postalCode, job?.addressLocality || job?.location].filter(Boolean).join(' ');
  if (!jobLocation) return 0;
  const candidate = locationParts(candidateLocation);
  const posting = locationParts(jobLocation);
  const country = structuredCountry(job?.addressCountry);
  if (job?.addressCountry && !country) return 0;
  if (country && posting.country && country !== posting.country) return 0;
  const jobCountry = country || posting.country;
  // One explicit country cannot establish that an unqualified homonym is near.
  // Preserve the old bounded hint only when both legacy values omit a country.
  if ((candidate.country || jobCountry) && candidate.country !== jobCountry) return 0;
  const candidateLocality = locality(candidate.town, candidate.country);
  const jobLocality = locality(posting.town, jobCountry);
  if (candidateLocality.qualifier && jobLocality.qualifier && candidateLocality.qualifier !== jobLocality.qualifier) return 0;
  if (candidateLocality.key && candidateLocality.key === jobLocality.key) return POINTS.sameLocality;
  const candidatePostcode = postcode(candidate.town);
  const jobPostcode = postcode(posting.town);
  if (!candidatePostcode || !jobPostcode || candidatePostcode.length !== jobPostcode.length) return 0;
  if (candidatePostcode === jobPostcode) return POINTS.sameLocality;
  if (candidatePostcode.slice(0, 3) === jobPostcode.slice(0, 3)) return POINTS.sameThreeDigitPostcode;
  if (candidatePostcode.slice(0, 2) === jobPostcode.slice(0, 2)) return POINTS.sameTwoDigitPostcode;
  if (Math.abs(Number(candidatePostcode.slice(0, 2)) - Number(jobPostcode.slice(0, 2))) === 1) return POINTS.adjacentTwoDigitPostcode;
  return 0;
}
