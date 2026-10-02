/**
 * Dates of a CV, read as the candidate wrote them and printed the Swiss way
 * (MM.YYYY, the official templates of the cantonal career services and SECO).
 * The model never writes a date: the profile keeps them as written, and this
 * module only re-formats what it can read for sure; anything else is printed
 * as written. The idea of reading periods in the CV's own language comes from
 * Reactive Resume's `ats/period.ts` (MIT); the code is ours.
 */

const MONTHS = {
  it: ['gennaio', 'febbraio', 'marzo', 'aprile', 'maggio', 'giugno', 'luglio', 'agosto', 'settembre', 'ottobre', 'novembre', 'dicembre'],
  de: ['januar', 'februar', 'märz', 'april', 'mai', 'juni', 'juli', 'august', 'september', 'oktober', 'november', 'dezember'],
  fr: ['janvier', 'février', 'mars', 'avril', 'mai', 'juin', 'juillet', 'août', 'septembre', 'octobre', 'novembre', 'décembre'],
  en: ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'],
};

const fold = (text) => String(text || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[’]/g, "'").trim();

// Every month name and its usual abbreviations ("mär", "févr", "sett", "sept"), folded.
const MONTH_BY_NAME = new Map();
for (const names of Object.values(MONTHS)) {
  names.forEach((name, index) => {
    const folded = fold(name);
    MONTH_BY_NAME.set(folded, index + 1);
    for (const length of [3, 4]) if (folded.length > length) MONTH_BY_NAME.set(folded.slice(0, length), index + 1);
  });
}
MONTH_BY_NAME.set('sept', 9);
MONTH_BY_NAME.set('juil', 7);

const ONGOING = new Set(['heute', 'aktuell', 'laufend', 'jetzt', 'gegenwartig', 'bis heute', 'oggi', 'ad oggi', 'attuale', 'in corso', 'presente',
  "aujourd'hui", 'actuel', 'en cours', 'a ce jour', 'present', 'current', 'now', 'today']);
const SINCE = /^(?:seit|dal|dall'|da|depuis|des|since|from|ab)\s+/;

export const ONGOING_LABEL = { it: 'oggi', de: 'heute', fr: "aujourd'hui", en: 'present' };

/**
 * One end of a period: {year, month?}, 'ongoing', or null when it cannot be read for sure.
 * @returns {{year:number, month?:number}|'ongoing'|null}
 */
export function parseEndpoint(raw) {
  const text = fold(raw).replace(/\s+/g, ' ').replace(SINCE, '');
  if (!text) return null;
  if (ONGOING.has(text)) return 'ongoing';
  const valid = (year, month) => year >= 1900 && year <= 2100 && (month === undefined || (month >= 1 && month <= 12));
  let match = /^(\d{1,2})\s*[./-]\s*(\d{4})$/.exec(text); // 03/2021, 3.2021
  if (match && valid(+match[2], +match[1])) return { year: +match[2], month: +match[1] };
  match = /^(\d{4})\s*[-/.]\s*(\d{1,2})$/.exec(text); // 2021-03
  if (match && valid(+match[1], +match[2])) return { year: +match[1], month: +match[2] };
  match = /^([a-z]+)\.?\s+(\d{4})$/.exec(text); // März 2021, mars 2021, Mar. 2021
  if (match && MONTH_BY_NAME.has(match[1]) && valid(+match[2])) return { year: +match[2], month: MONTH_BY_NAME.get(match[1]) };
  match = /^(\d{4})$/.exec(text);
  if (match && valid(+match[1])) return { year: +match[1] };
  return null;
}

function formatEndpoint(endpoint, language) {
  if (endpoint === 'ongoing') return ONGOING_LABEL[language] || ONGOING_LABEL.it;
  return endpoint.month ? `${String(endpoint.month).padStart(2, '0')}.${endpoint.year}` : String(endpoint.year);
}

/**
 * A period the Swiss way ("09.2019 – heute", "2015 – 2018"), or as written
 * when either end cannot be read for sure. "seit 2022" with no end reads as
 * ongoing; the same month twice prints once.
 */
export function formatPeriod(start, end, language = 'it') {
  const rawStart = String(start || '').trim();
  const rawEnd = String(end || '').trim();
  const since = SINCE.test(fold(rawStart)) && !rawEnd;
  const from = rawStart ? parseEndpoint(rawStart) : null;
  const to = rawEnd ? parseEndpoint(rawEnd) : since ? 'ongoing' : null;
  if ((rawStart && !from) || (rawEnd && !to) || from === 'ongoing') return [rawStart, rawEnd].filter(Boolean).join(' – ');
  const parts = [from, to].filter(Boolean).map((endpoint) => formatEndpoint(endpoint, language));
  if (parts.length === 2 && parts[0] === parts[1]) return parts[0];
  return parts.join(' – ');
}
