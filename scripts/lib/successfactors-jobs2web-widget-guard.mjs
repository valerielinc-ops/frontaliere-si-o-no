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
 * That is not cosmetic: Zurich Insurance fails closed on an unresolvable
 * Swiss location, so ONE multi-location row aborted the whole crawler run
 * ("Zurich listing has an unresolved Swiss location", run 33694169583).
 *
 * The marker is anchored on `+<digits>` followed by the locale word j2w uses
 * for "more" (the tenants crawled here serve de/en/fr/it). Anchoring on the
 * word, not on the bare `+N`, keeps a genuine location containing a digit
 * from being truncated.
 */
export const SF_J2W_MORE_LOCATIONS_RE =
  /\s*[,;]?\s*\+\s*\d+\s*(?:more|weitere[nrs]?|mehr|autres?|de\s+plus|altr[oiae])\b[\s\S]*$/i;

/** Text form of `&hellip;` so callers need not unescape it themselves. */
function unescapeHellip(value) {
  return String(value).replace(/&hellip;|&#8230;|&#x2026;/gi, '…');
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
  return SF_J2W_MORE_LOCATIONS_RE.test(unescapeHellip(value));
}

/**
 * Return the visible (primary) location of a j2w `jobLocation` cell, i.e.
 * `value` without the "+N more…" suffix.
 *
 * Non-string input yields `''` — an absent cell and a contaminated one are
 * different problems, and callers already treat `''` as "no location".
 *
 * @param {unknown} value
 * @returns {string}
 */
export function stripSuccessFactorsMoreLocations(value) {
  if (typeof value !== 'string') return '';
  return unescapeHellip(value).replace(SF_J2W_MORE_LOCATIONS_RE, '').trim();
}
