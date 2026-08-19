/**
 * jobLocationDisplay — one place that turns `(job.location, job.canton)` into
 * the "City (XX)" string every job surface prints.
 *
 * WHY IT EXISTS. Six surfaces independently wrote the same template —
 * `` `${job.location} (${job.canton})` `` — and none of them asked whether the
 * location ALREADY said which canton it was in. When it did, the reader got the
 * canton twice:
 *
 *   location "Lengnau (BE)"      + canton BE  ->  "Lengnau (BE) (BE)"
 *   location "Stein AG"          + canton AG  ->  "Stein AG (AG)"
 *   location "Möhlin, Aargau"    + canton AG  ->  "Möhlin, Aargau (AG)"
 *   location "Emmenbrücke (CH)"  + canton LU  ->  "Emmenbrücke (CH) (LU)"
 *
 * Measured on `data/jobs/by-crawler/*.json` @ origin/main 2026-08-19:
 * 1,804 of 27,590 jobs (6.5%) carry such a marker — 1,447 a full canton name
 * (coop-ticino 1,011, fust 168, emmi 99), 266 a bare code (clienia-ag 89,
 * migros-ticino 29), 27 a parenthesised code, 64 a country marker
 * (c-and-a-schweiz 58). The live page that started this
 * (`/cerca-lavoro-berna/masterdata-specialista-60-rado-watch-co-ltd-lengnau-be/`)
 * printed "Rado Watch Co. Ltd. · Lengnau (BE) (BE)".
 *
 * IT IS NOT A COSMETIC FIX ONLY. The same string feeds `<h1>`, `<title>`,
 * meta descriptions and JobPosting copy, so the duplication is indexed.
 *
 * NO IMPORTS, ON PURPOSE. `services/cantonList.ts` would be the natural place
 * for the name table, but it imports `data/canton-url-slugs.json`, and a module
 * that reaches into `data/` cannot be imported by a test running in a sparse
 * worktree (where `data/` is not materialised) — see CLAUDE.md, "ogni test che
 * importa un plugin e' rosso in worktree sparse e verde in CI". This file is
 * self-contained so `tests/job-location-display.test.ts` runs everywhere.
 *
 * `.mjs`, not `.ts`, ON PURPOSE too: the crawler parsers under `scripts/lib/`
 * that build `Arbeitsort: <city> (<canton>)` lines into job DESCRIPTIONS are
 * plain Node ESM and cannot import TypeScript, while `build-plugins/**.ts` and
 * `components/**.tsx` both already import `scripts/lib/*.mjs` (37 call sites).
 * One module reachable from all three is the only shape in which this logic
 * cannot be copy-pasted back apart.
 *
 * DISPLAY ONLY. NEVER BACKFILL THE STORED FIELD WITH THIS.
 * The obvious "completion" of this fix — rewrite `job.location` in the slices
 * so the marker is gone at rest — is measurably WRONG, and the measurement is
 * pinned in tests/job-location-display.test.ts so nobody has to rediscover it.
 * Run over the 2,348 marker-carrying locations on origin/main 2026-08-19,
 * against `isKnownSwissMunicipality()`:
 *
 *   BFS could not resolve it -> can after stripping :  1,980
 *   BFS could resolve it     -> CANNOT after        :     50
 *
 * Those 50 are the municipalities whose OFFICIAL name carries the canton
 * precisely because the bare name is ambiguous — Stein AG (vs Stein AR),
 * Kirchberg BE, Muri (AG), Oberwil BL, Rüti ZH, Hauterive (FR). `Stein AG`
 * resolves; `Stein` does not. Stripping at rest destroys their identity and
 * every downstream consumer that looks the city up — `sanitizeLocalityForRegion()`
 * in build-plugins/shared/jobPostingSchema.ts among them, which falls back to
 * the canton capital when the lookup fails. Consumers therefore keep reading
 * the RAW `job.location`; only the rendered string goes through here.
 *
 * KNOWN COLLISION, measured rather than assumed. `bare-code` strips a trailing
 * two-letter uppercase token, and `AG` is also the German company suffix
 * (Aktiengesellschaft). Across all 74 distinct bare-code shapes in the corpus,
 * 73 are the official disambiguating forms above and exactly one is the
 * collision: `XpertCenter AG` (3 jobs) — a company name sitting in the location
 * field, i.e. already-broken data, where the output `XpertCenter (AG)` is no
 * worse than the input `XpertCenter AG (AG)`. It is pinned in the tests so the
 * behaviour is visible rather than surprising, and `audit-job-locations.mjs`
 * reports the underlying junk location through `unknownCity`.
 *
 * THE CONFLICT CASE IS DELIBERATE. When the location's own marker disagrees
 * with `job.canton` — `Reinach (AG)` stamped `BL`, a real pair in the dataset —
 * this does NOT print both and does NOT overwrite one with the other. It prints
 * the location verbatim and reports `conflict`, because which of the two is
 * right is a DATA question no formatter can answer: dedicated crawlers stamp
 * the employer's home canton on every posting they emit (see the header of
 * `scripts/audit-job-locations.mjs`), so the field is often the wrong half.
 * `scripts/audit-job-locations.mjs` reports those; the formatter only refuses
 * to print a contradiction.
 */

/** Canonical ISO code → every spelling of the canton name we have seen in crawled locations. */
const CANTON_NAMES = Object.freeze(/** @type {Readonly<Record<string, readonly string[]>>} */ ({
  AG: ['Aargau', 'Argovie', 'Argovia'],
  AI: ['Appenzell Innerrhoden', 'Appenzell Rhodes-Intérieures', 'Appenzello Interno'],
  AR: ['Appenzell Ausserrhoden', 'Appenzell Rhodes-Extérieures', 'Appenzello Esterno'],
  BE: ['Bern', 'Berne', 'Berna'],
  BL: ['Basel-Landschaft', 'Basel-Land', 'Baselland', 'Bâle-Campagne', 'Basilea Campagna'],
  BS: ['Basel-Stadt', 'Bâle-Ville', 'Basilea Città', 'Basel City'],
  FR: ['Fribourg', 'Freiburg', 'Friburgo'],
  GE: ['Genève', 'Geneve', 'Genf', 'Ginevra', 'Geneva'],
  GL: ['Glarus', 'Glaris', 'Glarona'],
  GR: ['Graubünden', 'Graubunden', 'Grisons', 'Grigioni'],
  JU: ['Jura', 'Giura'],
  LU: ['Luzern', 'Lucerne', 'Lucerna'],
  NE: ['Neuchâtel', 'Neuchatel', 'Neuenburg'],
  NW: ['Nidwalden', 'Nidwald', 'Nidvaldo'],
  OW: ['Obwalden', 'Obwald', 'Obvaldo'],
  SG: ['St. Gallen', 'St.Gallen', 'Sankt Gallen', 'Saint-Gall', 'San Gallo'],
  SH: ['Schaffhausen', 'Schaffhouse', 'Sciaffusa'],
  SO: ['Solothurn', 'Soleure', 'Soletta'],
  SZ: ['Schwyz', 'Svitto'],
  TG: ['Thurgau', 'Thurgovie', 'Turgovia'],
  TI: ['Ticino', 'Tessin'],
  UR: ['Uri'],
  VD: ['Vaud', 'Waadt'],
  VS: ['Valais', 'Wallis', 'Vallese'],
  ZG: ['Zug', 'Zoug', 'Zugo'],
  ZH: ['Zürich', 'Zurich', 'Zurigo', 'Zuerich'],
}));

const CANTON_CODES = new Set(Object.keys(CANTON_NAMES));

/** Country markers that say "Switzerland" and therefore never add information to a canton line. */
const COUNTRY_NAMES = [
  'Switzerland', 'Schweiz', 'Suisse', 'Svizzera', 'Svizra', 'Helvetia',
];
const COUNTRY_CODES = new Set(['CH', 'CHE', 'SUI']);

/** Name (folded) → canton code. Built once. */
const NAME_TO_CODE = (() => {
  /** @type {Map<string, string>} */
  const map = new Map();
  for (const [code, names] of Object.entries(CANTON_NAMES)) {
    for (const name of names) map.set(fold(name), code);
  }
  return map;
})();

/**
 * Case- and diacritic-insensitive key. `Zürich`, `Zurich` and `ZÜRICH` are the
 * same token to a crawler that scraped three different pages.
 */
/**
 * @param {string} s
 * @returns {string}
 */
function fold(s) {
  return s
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/\./g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * What kind of redundant marker the location carried.
 *   · `paren-code`  — `Lengnau (BE)`, a parenthesised canton code
 *   · `bare-code`   — `Stein AG`, a bare trailing canton code
 *   · `canton-name` — `Möhlin, Aargau`, the canton spelled out
 *   · `country`     — `Emmenbrücke (CH)`, `Geneva, Switzerland`
 * @typedef {'paren-code' | 'bare-code' | 'canton-name' | 'country'} LocationRedundancy
 */

/**
 * @typedef {object} JobLocationParts
 * @property {string} city The location with every redundant marker removed. Never empty when the input was not.
 * @property {string | null} canton The canton code to show in parentheses, or `null` when nothing should be
 *   appended — either there is no canton, or the location contradicts it.
 * @property {LocationRedundancy[]} stripped Markers found and stripped, outermost first. Empty when already clean.
 * @property {boolean} conflict True when the location named a canton that is NOT `job.canton`. The city is
 *   returned verbatim and `canton` is `null`: two contradicting codes on one line help nobody, and picking a
 *   winner is a data decision, not a display one.
 */

/** Trailing `(XXX)` group, e.g. `Lengnau (BE)` → `BE`. */
const PAREN_TAIL = /^(.*?)[\s,]*\(\s*([^()]{1,40}?)\s*\)\s*$/;
/** Trailing token after a comma / slash / dash / space, e.g. `Möhlin, Aargau` → `Aargau`. */
const SEP_TAIL = /^(.*?)\s*[,/–—-]\s*([^,/–—-]{1,30})\s*$/;
/** Trailing bare uppercase code, e.g. `Stein AG` → `AG`. Uppercase only: `Stein Am` must not match. */
const BARE_CODE_TAIL = /^(.*\S)\s+([A-Z]{2,3})\s*$/;

/** Classify a candidate tail token. `null` when it carries information we must keep. */
/**
 * @param {string} token
 * @returns {{ kind: LocationRedundancy, code: string | null } | null}
 */
function classifyTail(token) {
  const raw = token.trim();
  if (!raw) return null;
  const folded = fold(raw);
  const upper = raw.toUpperCase();

  if (COUNTRY_CODES.has(upper) || COUNTRY_NAMES.some((n) => fold(n) === folded)) {
    return { kind: 'country', code: null };
  }
  if (raw.length <= 3 && CANTON_CODES.has(upper)) {
    return { kind: 'paren-code', code: upper };
  }
  const named = NAME_TO_CODE.get(folded);
  if (named) return { kind: 'canton-name', code: named };
  return null;
}

/**
 * Split a job location into the parts a UI should print.
 *
 * Pure, allocation-light and safe on anything: an empty location yields an
 * empty city, and a location that is nothing BUT a marker is returned unchanged
 * (`Ticino` stays `Ticino`; stripping it would leave the reader with no place).
 */
/**
 * @param {string | null | undefined} location
 * @param {string | null | undefined} canton
 * @returns {JobLocationParts}
 */
export function splitJobLocation(location, canton) {
  const cantonCode = String(canton || '').trim().toUpperCase();
  const validCanton = CANTON_CODES.has(cantonCode) ? cantonCode : null;
  let city = String(location || '').trim();
  /** @type {LocationRedundancy[]} */
  const stripped = [];
  let conflict = false;

  // Peel markers off the tail, outermost first. Bounded: a location cannot
  // carry more markers than it has separators, and 4 is far past anything
  // observed ("Geneva, GENEVA, Switzerland" peels twice).
  for (let pass = 0; pass < 4; pass += 1) {
    /** @type {string | null} */
    let head = null;
    /** @type {string | null} */
    let tail = null;
    /** @type {LocationRedundancy | null} */
    let kindHint = null;

    const paren = PAREN_TAIL.exec(city);
    if (paren) {
      [, head, tail] = paren;
    } else {
      const sep = SEP_TAIL.exec(city);
      if (sep) {
        [, head, tail] = sep;
      } else {
        const bare = BARE_CODE_TAIL.exec(city);
        if (bare) {
          [, head, tail] = bare;
          kindHint = 'bare-code';
        }
      }
    }
    if (head === null || tail === null) break;
    // A marker is only redundant when something is left to name the place.
    if (!head.trim()) break;

    const classified = classifyTail(tail);
    if (!classified) break;

    if (classified.code && validCanton && classified.code !== validCanton) {
      // The location names a different canton than the field. Stop here and
      // report it; do not strip, do not append.
      conflict = true;
      break;
    }
    if (classified.code && !validCanton) {
      // No usable canton field, but the location carries one — keep it as the
      // canton and drop it from the city so the caller prints it once.
      stripped.push(kindHint ?? classified.kind);
      city = head.trim();
      return { city, canton: classified.code, stripped, conflict: false };
    }

    stripped.push(kindHint ?? classified.kind);
    city = head.trim();
  }

  return { city, canton: conflict ? null : validCanton, stripped, conflict };
}

/**
 * The display string: `"Lengnau (BE)"`, never `"Lengnau (BE) (BE)"`.
 *
 * Falls back gracefully: no canton → just the city; no city → just the canton
 * in parentheses is meaningless, so the empty string.
 */
/**
 * @param {string | null | undefined} location
 * @param {string | null | undefined} canton
 * @returns {string}
 */
export function formatJobLocation(location, canton) {
  const { city, canton: code } = splitJobLocation(location, canton);
  if (!city) return code ? code : '';
  return code ? `${city} (${code})` : city;
}

/**
 * Audit hook: what (if anything) is wrong with this pair, without formatting it.
 * `null` when the location is already clean.
 */
/**
 * @param {string | null | undefined} location
 * @param {string | null | undefined} canton
 * @returns {{ redundancy: LocationRedundancy[], conflict: boolean } | null}
 */
export function jobLocationRedundancy(location, canton) {
  const parts = splitJobLocation(location, canton);
  if (!parts.stripped.length && !parts.conflict) return null;
  return { redundancy: parts.stripped, conflict: parts.conflict };
}

/** The 26 codes this module recognises. Exported so audits cannot drift onto a different list. */
export const KNOWN_CANTON_CODES = CANTON_CODES;
