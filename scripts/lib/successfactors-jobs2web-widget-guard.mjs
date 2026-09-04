/**
 * Shared guard against SAP SuccessFactors jobs2web (j2w) page-chrome text
 * leaking into scraped job fields.
 *
 * WHY THIS MODULE EXISTS
 * ----------------------
 * Every j2w career site renders the same non-job widgets around the actual
 * posting: a keyword-search box, a "create job alert" box, and — since the
 * SF/Qualtrics consent rollout — a cookie-consent manager. Their headings are
 * the only `<h2>` on some tenant skins, so a parser that falls back from
 * `<h1 class="job-title">` to "the first `<h2>`" silently picks up the consent
 * widget instead of the job title.
 *
 * That is not hypothetical. `schindler-job-parser.mjs`,
 * `hirslanden-job-parser.mjs` and `stadler-rail-job-parser.mjs` had each grown
 * their own private, copy-pasted `GARBAGE` array against this exact bleed —
 * three independent discoveries of one defect, already drifted apart from one
 * another (Schindler and Stadler carried the two `Cookie` patterns, Hirslanden
 * did not; Schindler carried `Select how often`, Stadler did not). The other 15
 * j2w parsers in `scripts/lib/*-job-parser.mjs` had no guard at all.
 *
 * Worse, all three applied the filter to `description` ONLY, never to `title`.
 * On 2026-08-24 that gap had put 11 Swiss Schindler apprenticeships live under
 * the title "Manager für Cookie-Einwilligungen" (and its fr/it translations),
 * each with the correct body text of a completely different, real posting.
 *
 * So: one list, one place, applied to BOTH fields, on BOTH the listing and the
 * detail page. Per AGENTS.md Non-Negotiable #6 — a construct duplicated across
 * ≥2 files belongs in a shared module.
 *
 * DESIGN NOTE — why the patterns are anchored the way they are
 * ------------------------------------------------------------
 * Naive substring matching on short tokens is dangerous on this corpus: a
 * bare /sign in/i matches the real Sonova posting "RF De(sign In)gegnere
 * (m/f/d)", and a bare /hr/i matches "Le(hr)stelle". Every pattern below is
 * therefore either a multi-word phrase or explicitly bounded, and the whole set
 * is regression-tested against a sample of genuine titles in
 * `tests/successfactors-jobs2web-widget-guard.test.ts`.
 *
 * Locales: the j2w sites serve de / en / fr / it, so each widget needs all four.
 */

/**
 * Text of SF j2w page-chrome widgets. A job `title` or `description` matching
 * any of these did not come from the posting — it came from the page around it.
 *
 * Frozen so a consumer cannot mutate the shared list for everyone else.
 */
export const SF_J2W_WIDGET_PATTERNS = Object.freeze([
  // ── Cookie / consent manager ──────────────────────────────────────────
  // The regression of 2026-08-24: the consent widget's <h2> read as the title.
  /Manager\s+für\s+Cookie/i,
  /Cookie[-\s]?Einwilligung/i,
  /Cookie[-\s]?Zustimmung/i,
  /Cookie[-\s]?Einstellungen/i,
  /Datenschutz[-\s]?Einstellungen/i,
  /Cookie\s+Consent/i,
  /Consent\s+Manager/i,
  /Cookie\s+(?:Preferences|Settings|Policy)/i,
  /Manage\s+(?:Cookie|Consent)/i,
  /Gestionnaire\s+de\s+consentement/i,
  /consentements?\s+pour\s+les\s+cookies/i,
  /Param[èe]tres?\s+(?:des\s+)?cookies/i,
  /Gestore\s+(?:del\s+)?consenso/i,
  /consenso\s+ai\s+cookie/i,
  /autorizzazioni\s+dei\s+cookie/i,
  /Gestisci\s+(?:il\s+)?consenso/i,
  /Preferenze\s+(?:dei\s+)?cookie/i,

  // ── Keyword-search widget ─────────────────────────────────────────────
  /Suche\s+nach\s+Stichwort/i,
  /Search\s+by\s+keyword/i,
  /Recherche\s+par\s+mot[-\s]cl[ée]/i,
  /Ricerca\s+per\s+parola\s+chiave/i,

  // ── Job-alert / talent-community widget ───────────────────────────────
  /Benachrichtigung\s+erstellen/i,
  /Create\s+(?:Job\s+)?Alert/i,
  /Cr[ée]er\s+une\s+alerte/i,
  /Crea(?:re)?\s+(?:un\s+)?avviso/i,
  /Select\s+how\s+often/i,
  /Wählen\s+Sie[\s\S]{0,40}wie\s+oft/i,
  // ── Unrendered SF template scaffolding ───────────────────────────────
  // When a tenant leaves a career-site token unpopulated, j2w ships the raw
  // token to the browser instead of dropping the block: the live dataset on
  // 2026-08-24 carried two Schindler postings titled "[[Title]] à
  // Le Mont-sur-Lausanne". Same family as the widgets — the string did not
  // come from the posting — so it belongs behind the same predicate.
  // Measured over all 151'598 live titles this matches exactly those two.
  // Also swept against every description/descriptionByLocale field this
  // guard is wired to (2'345 records, 31 crawlers, 2026-08-24, issue #6393):
  // zero matches, so the wholesale field wipe below has never fired on a
  // real description. See the corpus-sweep describe block in
  // tests/successfactors-jobs2web-widget-guard.test.ts for the swept set.
  /\[\[[^\]]{1,40}\]?\]/,

  // NOTE: deliberately NO /Talent Community/ pattern. It reads like an obvious
  // addition — the j2w sidebar does carry a "Join our Talent Community" box —
  // but measured against all 151'598 live titles it is a false positive
  // generator: Otis publishes six genuine evergreen reqs literally titled
  // "Talent Community <City> - Aufzug Monteur/Reparateur/Servicetechniker
  // (m/w/d)". None of the three pre-existing GARBAGE arrays contained it.
  // Re-add only with a pattern that cannot match a posting title, and re-run
  // the corpus sweep in the test before doing so.
]);

/**
 * True when `value` is SF j2w page chrome rather than posting content.
 *
 * Non-string / empty input is NOT widget text — an absent field is a separate
 * problem from a contaminated one, and conflating them would make callers
 * discard rows that merely lack a description.
 *
 * @param {unknown} value
 * @returns {boolean}
 */
export function isSuccessFactorsWidgetText(value) {
  if (typeof value !== 'string') return false;
  const text = value.trim();
  if (!text) return false;
  return SF_J2W_WIDGET_PATTERNS.some((re) => re.test(text));
}

/**
 * Return `value` unchanged, or `''` when it is SF j2w page chrome.
 *
 * Use for a field whose absence the caller can recover from — notably a detail
 * page `title`, where every j2w parser falls back to the listing-row title
 * (`detail?.title || listing.title`), which is the authoritative one anyway.
 *
 * @param {unknown} value
 * @returns {string}
 */
export function sanitizeSuccessFactorsField(value) {
  if (typeof value !== 'string') return '';
  return isSuccessFactorsWidgetText(value) ? '' : value;
}

/**
 * The j2w multi-location marker: a results row whose posting is open in more
 * than one office renders the extra offices as a `<small class="nobr">+N
 * more&hellip;</small>` suffix INSIDE the `<span class="jobLocation">` cell.
 *
 * WHY THIS BELONGS HERE, next to the widget guard: it is the same defect
 * family — tenant page chrome bleeding into a scraped field — and the same
 * duplication history. `benteler-job-parser.mjs` grew a private
 * `/\+\s*\d+\s*more/i` (after an ad-hoc `&hellip;` unescape) to flag those
 * rows, `constellium-job-parser.mjs` dodges the suffix by stopping its
 * location match at the first `<` instead of at `</span>`, and the seven
 * parsers that DO read the whole cell — `zurich-insurance-job-parser.mjs`,
 * `clariant-job-parser.mjs`, `damiani-job-parser.mjs`,
 * `skyguide-job-parser.mjs`, `patek-philippe-job-parser.mjs`,
 * `prada-job-parser.mjs` and the shared
 * `successfactors-shared-job-parser-common.mjs` (CSB tenants) — carried no
 * guard at all, so their location field read literally "Zürich, CH +1
 * more&hellip;".
 * That is not cosmetic: Zurich Insurance fails closed on unresolvable Swiss
 * geography, and until #7259 it did so per ROW, so ONE multi-location row
 * aborted the whole crawler run ("Zurich listing has an unresolved Swiss
 * location", run 33694169583). The gate is now aggregated over the run, but a
 * guard-less cell still turns every affected row into a counted reject.
 *
 * The marker is anchored on `+<digits>` followed by the locale word j2w uses
 * for "more" (the tenants crawled here serve de/en/fr/it). Anchoring on the
 * word, not on the bare `+N`, keeps a genuine location containing a digit
 * from being truncated.
 */
export const SF_J2W_MORE_LOCATIONS_RE =
  /\s*[,;]?\s*\+\s*\d+\s*(?:more|weitere[nrs]?|mehr|autres?|de\s+plus|altr[oiae])\b[\s\S]*$/i;

/**
 * The marker WITHOUT the "everything after it" tail, used as a fallback when
 * cutting the tail would eat the location itself (see below).
 */
const SF_J2W_MORE_LOCATIONS_TOKEN_RE =
  /\s*[,;]?\s*\+\s*\d+\s*(?:more|weitere[nrs]?|mehr|autres?|de\s+plus|altr[oiae])\b\s*(?:…|\.{3})?/gi;

/**
 * Same marker, non-global, used to LOCATE the token so the text after it can
 * be inspected. A `g` regex carries `lastIndex` between calls and would make
 * the inspection depend on the previous cell.
 */
const SF_J2W_MORE_LOCATIONS_TOKEN_ONCE_RE = new RegExp(
  SF_J2W_MORE_LOCATIONS_TOKEN_RE.source,
  SF_J2W_MORE_LOCATIONS_TOKEN_RE.flags.replace('g', ''),
);

/**
 * What a further office segment looks like once the marker has been cut off:
 * a separator, then actual content. Requiring the separator is deliberate —
 * "Zurich, CH +2 more… Apply now" is page chrome, not a second office, and
 * must stay indistinguishable from a plain trailing cut, while
 * "Lugano, CH +1 more… , Bern, CH" carries a real second segment.
 *
 * The token regex above already eats `\s*(?:…|\.{3})?`, so the slice tested
 * here always starts past the ellipsis: no ellipsis alternative needed.
 */
const SF_J2W_TRAILING_SEGMENT_RE = /^\s*[,;]\s*\S/;

/**
 * Normalize the two characters the marker is anchored on, so callers may pass
 * raw HTML as well as decoded text: the ellipsis (`&hellip;`) and the `+`
 * itself (`&#43;`/`&plus;`, plus the fullwidth `＋` some tenant CMSes emit).
 * Without this a caller handing over undecoded markup would see `&#43;2 more…`
 * survive into the `location` field.
 */
function normalizeMarkerChars(value) {
  return String(value)
    .replace(/&hellip;|&#8230;|&#x2026;/gi, '…')
    .replace(/&plus;|&#43;|&#x2b;/gi, '+')
    .replace(/＋/g, '+');
}

/**
 * True when `value` carries the j2w "+N more…" multi-location marker.
 *
 * Accepts either the extracted cell text or the raw row HTML — callers that
 * only need to KNOW a row hides extra locations (to keep it for a detail-page
 * country check) use this; callers that need the visible location use
 * `stripSuccessFactorsMoreLocations()`.
 *
 * @param {unknown} value
 * @returns {boolean}
 */
export function hasSuccessFactorsMoreLocations(value) {
  if (typeof value !== 'string') return false;
  return SF_J2W_MORE_LOCATIONS_RE.test(normalizeMarkerChars(value));
}

/**
 * Fragments of a j2w results row that can legitimately carry the marker: the
 * location cell(s), the `jobLocation` span(s), and the `<small>` node the
 * marker itself is rendered in.
 *
 * Deliberately NOT anchored on `colLocation` alone — see
 * `hasSuccessFactorsMoreLocationsInRow()` for why the probe must not fail
 * closed on a skin that renders the `<small>` outside that cell.
 */
/**
 * Sources, not RegExp objects: `matchAll` needs the `g` flag, and a shared `g`
 * regex carries `lastIndex` between calls — an early `return true` below would
 * leave it dirty for the next row. Compiling per call keeps the probe
 * stateless.
 */
const SF_J2W_LOCATION_LIKE_NODE_SOURCES = Object.freeze([
  '<td[^>]*class="[^"]*location[^"]*"[^>]*>([\\s\\S]*?)</td>',
  '<span[^>]*class="[^"]*jobLocation[^"]*"[^>]*>([\\s\\S]*?)</span>',
  '<small[^>]*>([\\s\\S]*?)</small>',
]);

/**
 * True when a j2w results ROW hides extra offices behind the "+N more…"
 * marker, probing only the parts of the row where that marker can live.
 *
 * WHY NOT just `hasSuccessFactorsMoreLocations(row)`: the marker matcher spans
 * de/en/fr/it, so a title or href shaped like "+2 altri" would flip the flag
 * for the whole row (cost: a wasted detail fetch).
 *
 * WHY NOT just the `td.colLocation` cell either: that scoping fails CLOSED.
 * A skin that renders the `<small>` outside `colLocation` — while that cell
 * exists — would leave the flag off, and a caller like Benteler's
 * `listSwissJobs()` then DISCARDS a multi-office row whose visible location is
 * not Swiss (cost: a genuine Swiss posting silently lost, which is the worse
 * of the two errors).
 *
 * So: probe every location-like node of the row, and fall back to the whole
 * row only when the skin exposes none of them — narrow enough to keep the
 * title/href out, wide enough never to be the reason a row is dropped.
 *
 * @param {unknown} rowHtml Raw HTML of a single results row.
 * @returns {boolean}
 */
export function hasSuccessFactorsMoreLocationsInRow(rowHtml) {
  if (typeof rowHtml !== 'string') return false;
  let sawLocationLikeNode = false;
  for (const source of SF_J2W_LOCATION_LIKE_NODE_SOURCES) {
    for (const match of rowHtml.matchAll(new RegExp(source, 'gi'))) {
      sawLocationLikeNode = true;
      if (hasSuccessFactorsMoreLocations(match[1])) return true;
    }
  }
  return sawLocationLikeNode ? false : hasSuccessFactorsMoreLocations(rowHtml);
}

/**
 * Return the visible (primary) location of a j2w `jobLocation` cell, i.e.
 * `value` without the "+N more…" suffix.
 *
 * Cutting to end-of-string is right for the skins observed (the `<small>` is
 * the LAST node of the cell), but it must never be the reason a location
 * disappears: if the tail cut leaves nothing — a skin that renders the marker
 * BEFORE the office, or one that appends a country segment after it — fall
 * back to removing the marker token alone and keeping the rest. Losing the
 * location is the very failure this helper exists to prevent (Zurich
 * Insurance fails closed on an unresolvable Swiss location).
 *
 * Non-string input yields `''` — an absent cell and a contaminated one are
 * different problems, and callers already treat `''` as "no location".
 *
 * @param {unknown} value
 * @returns {string}
 */
export function stripSuccessFactorsMoreLocations(value) {
  if (typeof value !== 'string') return '';
  const normalized = normalizeMarkerChars(value);
  const withoutTail = normalized.replace(SF_J2W_MORE_LOCATIONS_RE, '').trim();
  if (withoutTail || !normalized.trim()) {
    if (withoutTail) warnOnDiscardedOffices(normalized, withoutTail);
    return withoutTail;
  }
  return normalized
    .replace(SF_J2W_MORE_LOCATIONS_TOKEN_RE, ' ')
    .replace(/\s+/g, ' ')
    .replace(/^[\s,;]+|[\s,;]+$/g, '')
    .trim();
}

/**
 * The office segments a cell renders AFTER the "+N more…" marker, i.e. exactly
 * what the tail cut of `stripSuccessFactorsMoreLocations()` throws away.
 *
 * `''` for the observed skins, where the `<small>` is the LAST node of the
 * cell, and `''` for page chrome after the marker ("+2 more… Apply now"): a
 * further OFFICE is separator-delimited, a call to action is not.
 *
 * WHY THIS IS A SEPARATE ACCESSOR and not folded into the strip result: every
 * one of the eight consumers treats the returned string as ONE office and
 * feeds it to `splitJobLocation`/`inferSwissTargetCanton`. Returning
 * "Lugano, CH, Bern, CH" makes that chain infer canton BE for a Lugano
 * posting — it resolves the first STRONG canton signal, and `Bern` is one —
 * so the row leaves the Ticino index and ships structured data with the wrong
 * `addressRegion`. Corrupting the primary office is a worse failure than the
 * one this accessor exists to surface, so the strip keeps returning the
 * primary office alone and the extra segments are offered here, opt-in.
 *
 * @param {unknown} value
 * @returns {string} The text after the marker, separators trimmed, or `''`.
 */
export function successFactorsMoreLocationsTail(value) {
  if (typeof value !== 'string') return '';
  const normalized = normalizeMarkerChars(value);
  const match = normalized.match(SF_J2W_MORE_LOCATIONS_TOKEN_ONCE_RE);
  if (!match || typeof match.index !== 'number') return '';
  const tail = normalized.slice(match.index + match[0].length);
  if (!SF_J2W_TRAILING_SEGMENT_RE.test(tail)) return '';
  return tail.replace(/^[\s,;]+|[\s,;]+$/g, '').trim();
}

/**
 * Cells already reported, so a results page of N rows sharing one skin quirk
 * logs once per distinct cell instead of once per row.
 */
const warnedDiscardedCells = new Set();

/**
 * Make the tail cut audible when it discards a real office.
 *
 * The reviewer note this answers (#7264, item 3): on a skin rendering
 * "Lugano, CH +1 more… , Bern, CH" the cut keeps "Lugano, CH" and drops
 * ", Bern, CH" — consistent with "keep the primary office", but if such a
 * skin exists the discarded segment may be the row's only Swiss office and
 * the choice is INDISTINGUISHABLE from the correct case. No fixture of that
 * skin exists, so the branch stays unobserved until something says so: this
 * warning is that observer. It cannot fire on the observed skins (nothing
 * follows the marker there), so it costs nothing on the live corpus and turns
 * a silent loss into a grep-able line the day a tenant changes layout.
 *
 * @param {string} normalized Marker-normalized cell text.
 * @param {string} kept The primary office the cut kept.
 * @returns {void}
 */
function warnOnDiscardedOffices(normalized, kept) {
  const tail = successFactorsMoreLocationsTail(normalized);
  if (!tail || warnedDiscardedCells.has(normalized)) return;
  warnedDiscardedCells.add(normalized);
  console.warn(
    `\u{1F9ED} j2w multi-segment location cell: kept "${kept}", dropped "${tail}" (from "${normalized.trim()}")`,
  );
}

