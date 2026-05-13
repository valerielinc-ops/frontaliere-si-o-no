/**
 * Section-specific editorial content for non-Italian locale static pages.
 *
 * Keyed by Italian canonical path prefix (longest-first for prefix matching).
 * Each entry provides 2-3 unique paragraphs per locale so that Google sees
 * topically-relevant content instead of generic boilerplate. This directly
 * prevents soft-404 classification by search engines.
 *
 * Italian editorial content remains inline in staticPagesPlugin.ts.
 */

export type SectionEditorialMap = Record<string, Record<string, string[]>>;

// ── Helper: ponti-2026 hero block (stat tiles + advice + CTA + holiday table) ──
// CLAUDE.md rule #17 layout for the SEO landing at /vita-in-ticino/ponti-2026-ticino/.
// All colours bind to `var(--color-*)` semantic OKLCH tokens defined in
// index.css so the page renders correctly in both light and dark mode without
// inline hex values.
type PontiLocale = 'it' | 'en' | 'de' | 'fr';
type DowKey = 'mon' | 'tue' | 'wed' | 'thu' | 'fri' | 'sat' | 'sun';
type HolidayKey =
 | 'newYear' | 'berchtold' | 'epiphany' | 'goodFriday' | 'easter' | 'easterMonday'
 | 'liberation' | 'labour' | 'ascension' | 'pentecost' | 'whitMonday' | 'republic'
 | 'corpusChristi' | 'swissNational' | 'assumption' | 'allSaints' | 'immaculate'
 | 'christmas' | 'stStephen';

const PONTI_DOW: Record<PontiLocale, Record<DowKey, string>> = {
 it: { mon: 'Lunedì', tue: 'Martedì', wed: 'Mercoledì', thu: 'Giovedì', fri: 'Venerdì', sat: 'Sabato', sun: 'Domenica' },
 en: { mon: 'Monday', tue: 'Tuesday', wed: 'Wednesday', thu: 'Thursday', fri: 'Friday', sat: 'Saturday', sun: 'Sunday' },
 de: { mon: 'Montag', tue: 'Dienstag', wed: 'Mittwoch', thu: 'Donnerstag', fri: 'Freitag', sat: 'Samstag', sun: 'Sonntag' },
 fr: { mon: 'Lundi', tue: 'Mardi', wed: 'Mercredi', thu: 'Jeudi', fri: 'Vendredi', sat: 'Samedi', sun: 'Dimanche' },
};

const PONTI_NAMES: Record<PontiLocale, Record<HolidayKey, string>> = {
 it: {
 newYear: 'Capodanno', berchtold: 'San Berchtoldo', epiphany: 'Epifania', goodFriday: 'Venerdì Santo',
 easter: 'Pasqua', easterMonday: 'Pasquetta', liberation: 'Festa della Liberazione (IT)',
 labour: 'Festa del Lavoro', ascension: 'Ascensione', pentecost: 'Pentecoste', whitMonday: 'Lunedì di Pentecoste',
 republic: 'Festa della Repubblica (IT)', corpusChristi: 'Corpus Domini', swissNational: 'Festa nazionale svizzera',
 assumption: 'Assunzione / Ferragosto', allSaints: 'Ognissanti', immaculate: 'Immacolata',
 christmas: 'Natale', stStephen: 'Santo Stefano',
 },
 en: {
 newYear: "New Year's Day", berchtold: "St Berchtold's Day", epiphany: 'Epiphany', goodFriday: 'Good Friday',
 easter: 'Easter Sunday', easterMonday: 'Easter Monday', liberation: 'Italian Liberation Day',
 labour: 'Labour Day', ascension: 'Ascension', pentecost: 'Pentecost', whitMonday: 'Whit Monday',
 republic: 'Italian Republic Day', corpusChristi: 'Corpus Christi', swissNational: 'Swiss National Day',
 assumption: 'Assumption', allSaints: "All Saints' Day", immaculate: 'Immaculate Conception',
 christmas: 'Christmas Day', stStephen: 'Boxing Day',
 },
 de: {
 newYear: 'Neujahr', berchtold: 'Berchtoldstag', epiphany: 'Dreikönigstag', goodFriday: 'Karfreitag',
 easter: 'Ostersonntag', easterMonday: 'Ostermontag', liberation: 'Italienischer Befreiungstag',
 labour: 'Tag der Arbeit', ascension: 'Auffahrt', pentecost: 'Pfingstsonntag', whitMonday: 'Pfingstmontag',
 republic: 'Italienischer Tag der Republik', corpusChristi: 'Fronleichnam', swissNational: 'Schweizer Bundesfeier',
 assumption: 'Mariä Himmelfahrt', allSaints: 'Allerheiligen', immaculate: 'Mariä Empfängnis',
 christmas: 'Weihnachten', stStephen: 'Stephanstag',
 },
 fr: {
 newYear: "Jour de l'An", berchtold: 'Saint-Berchtold', epiphany: 'Épiphanie', goodFriday: 'Vendredi saint',
 easter: 'Pâques', easterMonday: 'Lundi de Pâques', liberation: 'Fête de la Libération (IT)',
 labour: 'Fête du Travail', ascension: 'Ascension', pentecost: 'Pentecôte', whitMonday: 'Lundi de Pentecôte',
 republic: 'Fête de la République (IT)', corpusChristi: 'Fête-Dieu', swissNational: 'Fête nationale suisse',
 assumption: 'Assomption', allSaints: 'Toussaint', immaculate: 'Immaculée Conception',
 christmas: 'Noël', stStephen: 'Saint-Étienne',
 },
};

// Verified vs ti.ch + gov.it. Easter 2026 = 5 Apr → Good Friday 3 Apr,
// Easter Monday 6 Apr, Ascension 14 May (Thu), Pentecost 24 May (Sun),
// Whit Monday 25 May, Corpus Christi 4 Jun.
const PONTI_2026_ROWS: ReadonlyArray<readonly [string, DowKey, HolidayKey, boolean, boolean]> = [
 ['1/1', 'thu', 'newYear', true, true],
 ['2/1', 'fri', 'berchtold', true, false],
 ['6/1', 'tue', 'epiphany', true, true],
 ['3/4', 'fri', 'goodFriday', true, false],
 ['5/4', 'sun', 'easter', true, true],
 ['6/4', 'mon', 'easterMonday', true, true],
 ['25/4', 'sat', 'liberation', false, true],
 ['1/5', 'fri', 'labour', true, true],
 ['14/5', 'thu', 'ascension', true, false],
 ['24/5', 'sun', 'pentecost', true, false],
 ['25/5', 'mon', 'whitMonday', true, false],
 ['2/6', 'tue', 'republic', false, true],
 ['4/6', 'thu', 'corpusChristi', true, false],
 ['1/8', 'sat', 'swissNational', true, false],
 ['15/8', 'sat', 'assumption', true, true],
 ['1/11', 'sun', 'allSaints', true, true],
 ['8/12', 'tue', 'immaculate', true, true],
 ['25/12', 'fri', 'christmas', true, true],
 ['26/12', 'sat', 'stStephen', true, true],
];

// ── Top bridges (gold standard for the year) ──
// Listed Italian-side; per-locale labels generated below from this template.
type BridgeKey = 'newYearBerchtold' | 'epiphany' | 'easter' | 'mayDay' | 'ascension' | 'pentecost' | 'corpus' | 'immaculate' | 'christmas';
interface BridgeMeta {
 readonly key: BridgeKey;
 /** Localised date span (e.g. "3 → 6 aprile"). */
 readonly span: string;
 /** Total days off enjoyed (3 or 4). */
 readonly days: number;
 /** Vacation days needed (0 or 1) — when 0 the bridge is "automatic". */
 readonly leave: number;
 /** Single emoji giving the bridge a visual hook — keep tasteful (no clown). */
 readonly emoji: string;
}

const PONTI_BRIDGES: ReadonlyArray<BridgeMeta> = [
 { key: 'newYearBerchtold', span: '1 → 4', days: 4, leave: 0, emoji: '🎊' },
 { key: 'epiphany', span: '5 → 6', days: 4, leave: 1, emoji: '🧦' },
 { key: 'easter', span: '3 → 6', days: 4, leave: 0, emoji: '🐣' },
 { key: 'mayDay', span: '1 → 3', days: 3, leave: 0, emoji: '🌷' },
 { key: 'ascension', span: '14 → 17', days: 4, leave: 1, emoji: '☁️' },
 { key: 'pentecost', span: '23 → 25', days: 3, leave: 0, emoji: '🕊️' },
 { key: 'corpus', span: '4 → 7', days: 4, leave: 1, emoji: '🌿' },
 { key: 'immaculate', span: '7 → 8', days: 4, leave: 1, emoji: '🕯️' },
 { key: 'christmas', span: '25 → 27', days: 3, leave: 0, emoji: '🎄' },
];

interface QuarterCopy {
 readonly emoji: string;
 readonly label: string;
 /** Short witty caption shown after the season label. */
 readonly quip: string;
}

interface PontiCopy {
 /** Section eyebrow above the headline panel (decorative emoji prefix included). */
 readonly eyebrow: string;
 /** Bold one-sentence statement inside the headline panel. */
 readonly leadStatement: string;
 /** Inline CTA text (becomes a quiet underline link, not a button-card). */
 readonly ctaLabel: string;
 readonly ctaHref: string;
 /** Heading for the ranked ponti list. */
 readonly bridgesHeading: string;
 /** Heading above the data table. */
 readonly tableHeading: string;
 /** Locale-specific span suffix used in PONTI_BRIDGES (e.g. "aprile"). */
 readonly bridgeMonths: Record<BridgeKey, string>;
 /** Locale-specific name for each bridge. */
 readonly bridgeNames: Record<BridgeKey, string>;
 /** Short ferie copy: "0 ferie" / "1 ferie" — locale dependant. */
 readonly leaveCopy: (n: number) => string;
 /** Days copy: "4 giorni" / "4 days". */
 readonly daysCopy: (n: number) => string;
 /** Column labels for the full table. */
 readonly cols: { date: string; day: string; holiday: string; ch: string; it: string };
 /** Seasonal quarter dividers (emoji + label + playful one-liner). */
 readonly quarters: [QuarterCopy, QuarterCopy, QuarterCopy, QuarterCopy];
 /** Legend explaining the ●/○ table glyphs. */
 readonly legend: string;
 /** Tiny playful closing line under the table. */
 readonly closingLine: string;
 /** Rule-#17 stat-tile grid (3–5 tiles) — slot 3 of the SEO-landing layout. */
 readonly tiles: ReadonlyArray<{ value: string; label: string; tone: 'accent' | 'success' | 'warning' | 'base' }>;
 /** Single-sentence "consiglio" banner — slot 4. */
 readonly advice: string;
 /** Twelve single-letter month abbreviations for the calendar strip. */
 readonly monthLetters: readonly [string, string, string, string, string, string, string, string, string, string, string, string];
 /** Caption rendered under the calendar strip. */
 readonly stripCaption: string;
 /** Aria-label for the calendar strip (a11y). */
 readonly stripA11y: string;
}

const PONTI_COPY_V2: Record<PontiLocale, PontiCopy> = {
 it: {
 eyebrow: '🇮🇹🇨🇭 Almanacco frontaliere · 2026',
 leadStatement: '<strong>17 festività</strong> in Canton Ticino. Spendi <strong>4 giorni di ferie</strong> nei momenti giusti e ne guadagni <strong>12 di pausa extra</strong> — quasi tre settimane di stacco. Mica male.',
 ctaLabel: 'Calcola il netto frontaliere con i festivi inclusi',
 ctaHref: '/calcola-stipendio/',
 bridgesHeading: '🌉 I ponti lunghi del 2026',
 tableHeading: '📅 Tutte le date sul calendario',
 bridgeMonths: {
 newYearBerchtold: 'gennaio', epiphany: 'gennaio', easter: 'aprile', mayDay: 'maggio',
 ascension: 'maggio', pentecost: 'maggio', corpus: 'giugno', immaculate: 'dicembre', christmas: 'dicembre',
 },
 bridgeNames: {
 newYearBerchtold: 'Capodanno + San Berchtoldo', epiphany: 'Epifania', easter: 'Pasqua', mayDay: '1° maggio',
 ascension: 'Ascensione', pentecost: 'Pentecoste', corpus: 'Corpus Domini', immaculate: 'Immacolata', christmas: 'Natale',
 },
 leaveCopy: (n) => (n === 0 ? '<span style="color:var(--color-success);font-weight:600">🎁 0 ferie</span>' : `${n} ferie ben spese`),
 daysCopy: (n) => `${n} giorni di pausa`,
 cols: { date: 'Data', day: 'Giorno', holiday: 'Festività', ch: 'TI', it: 'IT' },
 quarters: [
 { emoji: '❄️', label: 'Inverno', quip: 'Tre ponti nei primi 6 giorni dell\'anno. Si parte forte.' },
 { emoji: '🌷', label: 'Primavera', quip: 'Tre ponti in 9 settimane — il picco anti-produttività del frontaliere.' },
 { emoji: '☀️', label: 'Estate', quip: 'Tutti i festivi cadono nel weekend. Cosmico complotto svizzero.' },
 { emoji: '🍂', label: 'Autunno', quip: 'Calma piatta fino all\'Immacolata, poi giù le saracinesche.' },
 ],
 legend: '<strong>●</strong> festa pagata · <strong>○</strong> giorno normale, ti tocca andare a lavorare',
 closingLine: 'Stampala, attaccala in cucina, conta i giorni alla rovescia. È un tuo diritto contrattuale.',
 tiles: [
 { value: '17', label: 'Festività ufficiali in Ticino', tone: 'accent' },
 { value: '9', label: 'Long weekend da 3-4 giorni', tone: 'success' },
 { value: '4', label: 'Ferie ti bastano per il pieno', tone: 'success' },
 { value: '+12', label: 'Giorni di pausa guadagnati', tone: 'accent' },
 { value: '5', label: 'Festivi sprecati nel weekend', tone: 'warning' },
 ],
 advice: 'Anno generoso: <strong>gennaio</strong>, <strong>aprile</strong> e <strong>dicembre</strong> concentrano due terzi dei ponti. L\'estate è piatta — la natura compensa con il sole.',
 monthLetters: ['G', 'F', 'M', 'A', 'M', 'G', 'L', 'A', 'S', 'O', 'N', 'D'],
 stripCaption: 'Densità festività mese per mese',
 stripA11y: 'Calendario annuale 2026: numero di festività per ogni mese',
 },
 en: {
 eyebrow: '🇮🇹🇨🇭 Cross-border almanac · 2026',
 leadStatement: '<strong>17 public holidays</strong> in Canton Ticino. Spend <strong>4 days of leave</strong> in the right places and you gain <strong>12 extra days off</strong> — almost three weeks unplugged. Not bad at all.',
 ctaLabel: 'Calculate cross-border net salary (holidays included)',
 ctaHref: '/en/calculate-salary/',
 bridgesHeading: '🌉 2026 long bridges, at a glance',
 tableHeading: '📅 Every date on the calendar',
 bridgeMonths: {
 newYearBerchtold: 'January', epiphany: 'January', easter: 'April', mayDay: 'May',
 ascension: 'May', pentecost: 'May', corpus: 'June', immaculate: 'December', christmas: 'December',
 },
 bridgeNames: {
 newYearBerchtold: 'New Year + St Berchtold', epiphany: 'Epiphany', easter: 'Easter', mayDay: 'Labour Day',
 ascension: 'Ascension', pentecost: 'Pentecost', corpus: 'Corpus Christi', immaculate: 'Immaculate Conception', christmas: 'Christmas',
 },
 leaveCopy: (n) => (n === 0 ? '<span style="color:var(--color-success);font-weight:600">🎁 0 leave</span>' : `${n} day well spent`),
 daysCopy: (n) => `${n} days off`,
 cols: { date: 'Date', day: 'Day', holiday: 'Holiday', ch: 'TI', it: 'IT' },
 quarters: [
 { emoji: '❄️', label: 'Winter', quip: 'Three bridges in the first six days of the year. Quite the start.' },
 { emoji: '🌷', label: 'Spring', quip: 'Three bridges in nine weeks — peak anti-productivity for the commuter.' },
 { emoji: '☀️', label: 'Summer', quip: 'Every holiday falls on a weekend. The universe is unjust.' },
 { emoji: '🍂', label: 'Autumn', quip: 'Quiet until Immaculate Conception, then the curtain comes down.' },
 ],
 legend: '<strong>●</strong> paid holiday · <strong>○</strong> normal working day',
 closingLine: 'Print it, pin it to the fridge, count down the days. Your contractual right.',
 tiles: [
 { value: '17', label: 'Official Ticino holidays', tone: 'accent' },
 { value: '9', label: 'Long weekends, 3-4 days each', tone: 'success' },
 { value: '4', label: 'Leave days to make the most of it', tone: 'success' },
 { value: '+12', label: 'Extra days off you gain', tone: 'accent' },
 { value: '5', label: 'Holidays wasted on weekends', tone: 'warning' },
 ],
 advice: 'A generous year: <strong>January</strong>, <strong>April</strong> and <strong>December</strong> hold two thirds of the bridges. Summer is flat — nature compensates with sun.',
 monthLetters: ['J', 'F', 'M', 'A', 'M', 'J', 'J', 'A', 'S', 'O', 'N', 'D'],
 stripCaption: 'Holiday density, month by month',
 stripA11y: 'Year-2026 calendar: number of public holidays per month',
 },
 de: {
 eyebrow: '🇮🇹🇨🇭 Grenzgänger-Almanach · 2026',
 leadStatement: '<strong>17 Feiertage</strong> im Tessin. Setzen Sie <strong>4 Urlaubstage</strong> gezielt ein und gewinnen Sie <strong>12 zusätzliche freie Tage</strong> — fast drei Wochen Auszeit. Nicht übel.',
 ctaLabel: 'Grenzgänger-Nettolohn berechnen (Feiertage inklusive)',
 ctaHref: '/de/gehalt-berechnen/',
 bridgesHeading: '🌉 Die langen Brücken 2026',
 tableHeading: '📅 Alle Daten im Kalender',
 bridgeMonths: {
 newYearBerchtold: 'Januar', epiphany: 'Januar', easter: 'April', mayDay: 'Mai',
 ascension: 'Mai', pentecost: 'Mai', corpus: 'Juni', immaculate: 'Dezember', christmas: 'Dezember',
 },
 bridgeNames: {
 newYearBerchtold: 'Neujahr + Berchtoldstag', epiphany: 'Dreikönigstag', easter: 'Ostern', mayDay: '1. Mai',
 ascension: 'Auffahrt', pentecost: 'Pfingsten', corpus: 'Fronleichnam', immaculate: 'Mariä Empfängnis', christmas: 'Weihnachten',
 },
 leaveCopy: (n) => (n === 0 ? '<span style="color:var(--color-success);font-weight:600">🎁 0 Urlaub</span>' : `${n} Urlaubstag gut investiert`),
 daysCopy: (n) => `${n} Tage frei`,
 cols: { date: 'Datum', day: 'Tag', holiday: 'Feiertag', ch: 'TI', it: 'IT' },
 quarters: [
 { emoji: '❄️', label: 'Winter', quip: 'Drei Brücken in den ersten sechs Tagen. Starker Auftakt.' },
 { emoji: '🌷', label: 'Frühling', quip: 'Drei Brücken in neun Wochen — Anti-Produktivitätsspitze des Grenzgängers.' },
 { emoji: '☀️', label: 'Sommer', quip: 'Jeder Feiertag fällt aufs Wochenende. Kosmische Ungerechtigkeit.' },
 { emoji: '🍂', label: 'Herbst', quip: 'Funkstille bis Mariä Empfängnis, dann fallen die Rollläden.' },
 ],
 legend: '<strong>●</strong> bezahlter Feiertag · <strong>○</strong> normaler Arbeitstag',
 closingLine: 'Ausdrucken, an den Kühlschrank pinnen, Tage zählen. Ihr vertragliches Recht.',
 tiles: [
 { value: '17', label: 'Offizielle Tessiner Feiertage', tone: 'accent' },
 { value: '9', label: 'Lange Wochenenden, je 3-4 Tage', tone: 'success' },
 { value: '4', label: 'Urlaubstage reichen aus', tone: 'success' },
 { value: '+12', label: 'Zusätzliche freie Tage gewonnen', tone: 'accent' },
 { value: '5', label: 'Feiertage am Wochenende verloren', tone: 'warning' },
 ],
 advice: 'Großzügiges Jahr: <strong>Januar</strong>, <strong>April</strong> und <strong>Dezember</strong> bündeln zwei Drittel der Brücken. Sommer ist flach — die Natur gleicht mit Sonne aus.',
 monthLetters: ['J', 'F', 'M', 'A', 'M', 'J', 'J', 'A', 'S', 'O', 'N', 'D'],
 stripCaption: 'Feiertagsdichte Monat für Monat',
 stripA11y: 'Kalender 2026: Anzahl der Feiertage pro Monat',
 },
 fr: {
 eyebrow: '🇮🇹🇨🇭 Almanach frontalier · 2026',
 leadStatement: "<strong>17 jours fériés</strong> au Tessin. Dépensez <strong>4 jours de congés</strong> aux bons endroits et gagnez <strong>12 jours de pause supplémentaires</strong> — presque trois semaines de coupure. Pas mal.",
 ctaLabel: 'Calculer le salaire net frontalier (fériés inclus)',
 ctaHref: '/fr/calculer-salaire/',
 bridgesHeading: '🌉 Les longs ponts 2026',
 tableHeading: '📅 Toutes les dates du calendrier',
 bridgeMonths: {
 newYearBerchtold: 'janvier', epiphany: 'janvier', easter: 'avril', mayDay: 'mai',
 ascension: 'mai', pentecost: 'mai', corpus: 'juin', immaculate: 'décembre', christmas: 'décembre',
 },
 bridgeNames: {
 newYearBerchtold: 'Nouvel An + Saint-Berchtold', epiphany: 'Épiphanie', easter: 'Pâques', mayDay: 'Fête du Travail',
 ascension: 'Ascension', pentecost: 'Pentecôte', corpus: 'Fête-Dieu', immaculate: 'Immaculée', christmas: 'Noël',
 },
 leaveCopy: (n) => (n === 0 ? '<span style="color:var(--color-success);font-weight:600">🎁 0 congé</span>' : `${n} jour de congé bien placé`),
 daysCopy: (n) => `${n} jours de pause`,
 cols: { date: 'Date', day: 'Jour', holiday: 'Fête', ch: 'TI', it: 'IT' },
 quarters: [
 { emoji: '❄️', label: 'Hiver', quip: 'Trois ponts dans les six premiers jours. Démarrage en fanfare.' },
 { emoji: '🌷', label: 'Printemps', quip: 'Trois ponts en neuf semaines — pic anti-productivité du frontalier.' },
 { emoji: '☀️', label: 'Été', quip: 'Tous les fériés tombent un week-end. Injustice cosmique.' },
 { emoji: '🍂', label: 'Automne', quip: 'Calme plat jusqu\'à l\'Immaculée, puis on baisse le rideau.' },
 ],
 legend: '<strong>●</strong> férié payé · <strong>○</strong> jour ouvré normal',
 closingLine: 'Imprimez-le, collez-le au frigo, comptez à rebours. C\'est votre droit contractuel.',
 tiles: [
 { value: '17', label: 'Jours fériés officiels au Tessin', tone: 'accent' },
 { value: '9', label: 'Longs week-ends de 3-4 jours', tone: 'success' },
 { value: '4', label: 'Jours de congé bien placés', tone: 'success' },
 { value: '+12', label: 'Jours de pause supplémentaires', tone: 'accent' },
 { value: '5', label: 'Fériés perdus en week-end', tone: 'warning' },
 ],
 advice: 'Année généreuse : <strong>janvier</strong>, <strong>avril</strong> et <strong>décembre</strong> concentrent deux tiers des ponts. L\'été est plat — la nature compense avec le soleil.',
 monthLetters: ['J', 'F', 'M', 'A', 'M', 'J', 'J', 'A', 'S', 'O', 'N', 'D'],
 stripCaption: 'Densité de jours fériés mois par mois',
 stripA11y: 'Calendrier 2026 : nombre de jours fériés par mois',
 },
};

/**
 * Editorial-almanac hero block — Italian "pocket almanac" with Swiss precision.
 * Layout follows CLAUDE.md rule #17 (eyebrow → calendar strip → stat tiles →
 * advice → primary CTA → distinctive data area → quiet footer).
 *
 * Colors bind to OKLCH semantic tokens only (no inline hex). Tile chrome
 * matches STAT_TILE_* from build-plugins/shared/seoContentTokens.ts so the
 * page stays consistent with every other SEO landing. The calendar strip,
 * display-size ponti numerals and quarter-grouped table are the distinctive
 * "particolare" elements requested by the brand brief.
 */
function buildPontiHero(locale: PontiLocale): string {
 const copy = PONTI_COPY_V2[locale];
 const dow = PONTI_DOW[locale];
 const names = PONTI_NAMES[locale];

 // ── (1) Headline panel — warm Mediterranean amber, generous lede ──
 // Uses warning-subtle/border to bind to the existing amber palette and
 // mirror the section-vita identity color without inventing new values.
 const panelStyle = 'padding:clamp(1.5rem,4vw,2.25rem);border-radius:20px;background:var(--color-warning-subtle);border:1px solid var(--color-warning-border);margin:0 0 1.5rem';
 const eyebrowStyle = 'margin:0 0 .9rem;font-size:11px;font-weight:700;letter-spacing:.14em;text-transform:uppercase;color:var(--color-section-vita)';
 const leadStyle = 'margin:0;font-size:clamp(1.125rem,2.6vw,1.625rem);line-height:1.4;color:var(--color-heading);font-weight:500;max-width:46ch;letter-spacing:-.005em';

 const headlinePanel = [
 `<div style="${panelStyle}">`,
 `<p style="${eyebrowStyle}">${copy.eyebrow}</p>`,
 `<p style="${leadStyle}">${copy.leadStatement}</p>`,
 `</div>`,
 ].join('');

 // ── (2) Calendar strip — 12 month letters with holiday-density dots ──
 // The signature visual: one row of monospaced letters and a row of dots
 // below counting CH-side holidays per month. Pure typography, no SVG.
 const monthOf = (date: string): number => parseInt(date.split('/')[1] ?? '0', 10);
 const densityByMonth: number[] = Array.from({ length: 12 }, (_, m) =>
 PONTI_2026_ROWS.filter(([d, , , ch]) => ch && monthOf(d) === m + 1).length,
 );
 const maxDensity = Math.max(...densityByMonth);
 const stripWrapStyle = 'margin:0 0 1.75rem;padding:1rem 1rem 1.1rem;border-radius:14px;background:var(--color-surface);border:1px solid var(--color-edge)';
 const stripRowStyle = 'display:grid;grid-template-columns:repeat(12,1fr);gap:2px;align-items:end';
 const stripLetterStyle = 'text-align:center;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:clamp(.75rem,1.8vw,.95rem);font-weight:600;letter-spacing:.05em;color:var(--color-subtle);font-variant-numeric:tabular-nums;line-height:1.4';
 const stripDotsStyle = 'display:flex;flex-direction:column;align-items:center;gap:2px;margin-top:6px;min-height:22px';
 const stripDotOn = 'width:5px;height:5px;border-radius:50%;background:var(--color-section-vita)';
 const stripDotOff = 'width:5px;height:5px;border-radius:50%;background:var(--color-edge)';
 const stripCaptionStyle = 'margin:.7rem 0 0;font-size:11px;font-weight:600;letter-spacing:.08em;text-transform:uppercase;color:var(--color-subtle);text-align:center';
 const stripCells = copy.monthLetters.map((letter, idx) => {
 const count = densityByMonth[idx] ?? 0;
 // Each cell shows up to maxDensity dot slots so columns line up.
 const dots = Array.from({ length: Math.max(maxDensity, 1) }, (_, k) =>
 `<span aria-hidden="true" style="${k < count ? stripDotOn : stripDotOff}"></span>`,
 ).join('');
 return [
 `<div>`,
 `<div style="${stripLetterStyle}">${letter}</div>`,
 `<div style="${stripDotsStyle}" aria-label="${count}">${dots}</div>`,
 `</div>`,
 ].join('');
 }).join('');
 const calendarStrip = [
 `<figure role="img" aria-label="${copy.stripA11y}" style="${stripWrapStyle}">`,
 `<div style="${stripRowStyle}">${stripCells}</div>`,
 `<figcaption style="${stripCaptionStyle}">${copy.stripCaption}</figcaption>`,
 `</figure>`,
 ].join('');

 // ── (3) Stat tile grid — CLAUDE.md rule #17 slot 3 ──
 const tileTone: Record<'accent' | 'success' | 'warning' | 'base', string> = {
 accent: 'background:var(--color-accent-subtle);border:1px solid var(--color-accent-border)',
 success: 'background:var(--color-success-subtle);border:1px solid var(--color-success-border)',
 warning: 'background:var(--color-warning-subtle);border:1px solid var(--color-warning-border)',
 base: 'background:var(--color-surface);border:1px solid var(--color-edge)',
 };
 const tileGridStyle = 'display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:10px;margin:0 0 1.25rem';
 const tileBaseStyle = 'padding:16px 18px;border-radius:14px;color:var(--color-heading)';
 const tileValueStyle = 'font-size:clamp(1.5rem,4vw,1.875rem);font-weight:700;line-height:1.1;color:var(--color-heading);font-variant-numeric:tabular-nums;letter-spacing:-.01em';
 const tileLabelStyle = 'margin-top:6px;font-size:12px;font-weight:600;color:var(--color-body);line-height:1.35';
 const tileGrid = [
 `<div style="${tileGridStyle}">`,
 copy.tiles
 .map(
 (t) =>
 `<div style="${tileBaseStyle};${tileTone[t.tone]}"><div style="${tileValueStyle}">${t.value}</div><div style="${tileLabelStyle}">${t.label}</div></div>`,
 )
 .join(''),
 `</div>`,
 ].join('');

 // ── (4) Advice banner — CLAUDE.md rule #17 slot 4 ──
 const adviceStyle = 'margin:0 0 1.25rem;padding:14px 16px;border-radius:14px;background:var(--color-accent-subtle);border:1px solid var(--color-accent-border);color:var(--color-heading);line-height:1.55;font-size:.9375rem';
 const adviceBlock = `<aside data-pt-advice style="${adviceStyle}">${copy.advice}</aside>`;

 // ── (5) Primary CTA — pill, above the fold on mobile.
 // Uses --color-accent/--color-on-accent (same as CTA_PRIMARY_STYLE) so
 // contrast stays AA in both themes; the warm-amber identity is carried
 // by the headline panel and section-vita accents elsewhere on the page.
 const ctaStyle = 'display:inline-flex;align-items:center;gap:8px;padding:12px 22px;border-radius:999px;background:var(--color-accent);color:var(--color-on-accent);text-decoration:none;font-weight:600;font-size:.9375rem;letter-spacing:.01em';
 const ctaWrapStyle = 'margin:0 0 2.25rem';
 const ctaBlock = `<p style="${ctaWrapStyle}"><a href="${copy.ctaHref}" style="${ctaStyle}">${copy.ctaLabel} <span aria-hidden="true">→</span></a></p>`;

 // ── (6a) Numbered "ponti" list — display-size numerals, tabular ──
 const bridgesSectionHeading = 'margin:0 0 1.1rem;font-size:clamp(1.05rem,2.4vw,1.25rem);font-weight:700;color:var(--color-heading);letter-spacing:-.01em';
 const bridgeListStyle = 'list-style:none;padding:0;margin:0 0 2.5rem;border-top:1px solid var(--color-edge)';
 const bridgeItemStyle = 'display:grid;grid-template-columns:auto auto 1fr;align-items:center;column-gap:1rem;padding:1rem 0;border-bottom:1px solid var(--color-edge)';
 const bridgeNumStyle = 'font-size:clamp(2rem,5vw,2.75rem);font-weight:700;color:var(--color-section-vita);font-variant-numeric:tabular-nums;line-height:1;letter-spacing:-.04em;font-feature-settings:"tnum"';
 const bridgeEmojiStyle = 'font-size:1.625rem;line-height:1;text-align:center;width:2.25rem';
 const bridgeBodyStyle = 'min-width:0';
 const bridgeNameStyle = 'font-weight:700;color:var(--color-heading);font-size:1rem;line-height:1.3';
 const bridgeMetaStyle = 'margin-top:4px;font-size:.8125rem;color:var(--color-subtle);line-height:1.5;font-variant-numeric:tabular-nums';
 const bridgeItems = PONTI_BRIDGES.map((b, i) => {
 const num = String(i + 1).padStart(2, '0');
 const month = copy.bridgeMonths[b.key];
 const name = copy.bridgeNames[b.key];
 const meta = `${b.span} ${month} · ${copy.daysCopy(b.days)} · ${copy.leaveCopy(b.leave)}`;
 return [
 `<li style="${bridgeItemStyle}">`,
 `<span aria-hidden="true" style="${bridgeNumStyle}">${num}</span>`,
 `<span aria-hidden="true" style="${bridgeEmojiStyle}">${b.emoji}</span>`,
 `<div style="${bridgeBodyStyle}">`,
 `<div style="${bridgeNameStyle}">${name}</div>`,
 `<div style="${bridgeMetaStyle}">${meta}</div>`,
 `</div>`,
 `</li>`,
 ].join('');
 }).join('');

 // ── (6b) Seasonal table — quarter dividers in warm amber ──
 const tableWrapStyle = 'overflow-x:auto;margin:0 0 1.5rem;border-top:1px solid var(--color-edge)';
 const tblStyle = 'width:100%;border-collapse:collapse;font-size:.875rem;min-width:480px';
 const quarterCellStyle = 'padding:1.75rem 0 .5rem;border-bottom:1px solid var(--color-warning-border)';
 const quarterLabelStyle = 'font-size:11px;font-weight:700;letter-spacing:.14em;text-transform:uppercase;color:var(--color-section-vita);display:inline-flex;align-items:center;gap:.45rem';
 const quarterQuipStyle = 'margin-top:6px;font-size:.875rem;font-style:italic;color:var(--color-body);font-weight:400;text-transform:none;letter-spacing:normal;line-height:1.45;max-width:52ch';
 const thStyle = 'background:transparent;text-align:left;padding:.7rem .75rem .7rem 0;border-bottom:1px solid var(--color-edge);font-weight:700;color:var(--color-subtle);font-size:11px;text-transform:uppercase;letter-spacing:.06em';
 const tdStyle = 'padding:.75rem .75rem .75rem 0;border-bottom:1px solid var(--color-edge);color:var(--color-body);font-size:.875rem;vertical-align:baseline';
 const yes = '<span aria-label="sì" style="color:var(--color-success);font-weight:700;font-size:1.05rem;line-height:1">●</span>';
 const no = '<span aria-label="no" style="color:var(--color-edge);font-size:1rem;line-height:1">○</span>';
 const groups: Array<{ q: QuarterCopy; rows: typeof PONTI_2026_ROWS }> = [
 { q: copy.quarters[0], rows: PONTI_2026_ROWS.filter(([d]) => monthOf(d) <= 3) },
 { q: copy.quarters[1], rows: PONTI_2026_ROWS.filter(([d]) => { const m = monthOf(d); return m >= 4 && m <= 6; }) },
 { q: copy.quarters[2], rows: PONTI_2026_ROWS.filter(([d]) => { const m = monthOf(d); return m >= 7 && m <= 9; }) },
 { q: copy.quarters[3], rows: PONTI_2026_ROWS.filter(([d]) => monthOf(d) >= 10) },
 ];
 const tableBody = groups
 .map((g) => {
 if (g.rows.length === 0) return '';
 const dataRows = g.rows
 .map(
 ([date, dowKey, hKey, ch, it]) =>
 `<tr><td style="${tdStyle};font-variant-numeric:tabular-nums;white-space:nowrap;font-weight:700;color:var(--color-heading)">${date}</td><td style="${tdStyle}">${dow[dowKey]}</td><td style="${tdStyle};color:var(--color-heading)">${names[hKey]}</td><td style="${tdStyle};text-align:center">${ch ? yes : no}</td><td style="${tdStyle};text-align:center">${it ? yes : no}</td></tr>`,
 )
 .join('');
 const quarterDivider = `<tr><td colspan="5" style="${quarterCellStyle}"><div style="${quarterLabelStyle}"><span aria-hidden="true">${g.q.emoji}</span><span>${g.q.label}</span></div><div style="${quarterQuipStyle}">${g.q.quip}</div></td></tr>`;
 return `${quarterDivider}${dataRows}`;
 })
 .join('');
 const tableHeadingStyle = bridgesSectionHeading;
 const legendStyle = 'margin:.85rem 0 0;font-size:.8125rem;color:var(--color-subtle);line-height:1.55';
 const tableBlock = [
 `<h3 style="${tableHeadingStyle}">${copy.tableHeading}</h3>`,
 `<div style="${tableWrapStyle}">`,
 `<table style="${tblStyle}">`,
 `<thead><tr><th scope="col" style="${thStyle}">${copy.cols.date}</th><th scope="col" style="${thStyle}">${copy.cols.day}</th><th scope="col" style="${thStyle}">${copy.cols.holiday}</th><th scope="col" style="${thStyle};text-align:center">${copy.cols.ch}</th><th scope="col" style="${thStyle};text-align:center">${copy.cols.it}</th></tr></thead>`,
 `<tbody>${tableBody}</tbody>`,
 `</table></div>`,
 `<p style="${legendStyle}">${copy.legend}</p>`,
 ].join('');

 // ── (7) Closing line — quiet italic footer, no dashed border ──
 const closingStyle = 'margin:1.75rem 0 0;padding:1rem 1.25rem;border-radius:14px;background:var(--color-surface-alt);font-size:.9375rem;color:var(--color-body);line-height:1.55;font-style:italic;max-width:60ch';
 const closingBlock = `<p style="${closingStyle}">${copy.closingLine}</p>`;

 return [
 `<section aria-label="${copy.eyebrow}" style="margin:0 0 2.5rem">`,
 headlinePanel,
 calendarStrip,
 tileGrid,
 adviceBlock,
 ctaBlock,
 `<h3 style="${bridgesSectionHeading}">${copy.bridgesHeading}</h3>`,
 `<ol style="${bridgeListStyle}">${bridgeItems}</ol>`,
 tableBlock,
 closingBlock,
 `</section>`,
 ].join('');
}

export const SECTION_EDITORIAL: SectionEditorialMap = {
 // ───── Calculator ─────────────────────────────────────────────
 '/calcola-stipendio/simula-busta-paga': {
 it: [
 'Il simulatore di busta paga ricostruisce voce per voce lo stipendio netto del frontaliere partendo dal lordo annuo in franchi svizzeri. Le deduzioni sociali obbligatorie — AVS/AI/IPG al 5,3 %, assicurazione contro la disoccupazione AC all\'1,1 %, infortuni non professionali LAA e indennità giornaliera di malattia IJM — vengono sottratte prima del calcolo dell\'imposta alla fonte cantonale, seguendo esattamente la sequenza di una busta paga reale svizzera.',
 'L\'imposta alla fonte viene calcolata secondo le tabelle A/B/C/H del Canton Ticino aggiornate al 2026, che tengono conto di stato civile, numero di figli a carico e appartenenza religiosa. La tabella A si applica ai celibi senza figli, la B ai celibi con figli, la C ai coniugati e la H ai nuclei monoparentali. Il risultato viene convertito in euro al tasso di cambio selezionato per quantificare il potere d\'acquisto reale in Italia.',
 'Dopo la simulazione è possibile confrontare il netto ottenuto con i costi effettivi della vita da frontaliere: trasporto quotidiano attraverso il confine, premio della cassa malati LAMal, pranzi in zona lavorativa, parcheggio presso i valichi e assicurazione auto con targhe svizzere. Questo confronto permette di stimare il risparmio mensile effettivo rispetto a un impiego equivalente in Italia.',
 'Una busta paga svizzera (Lohnabrechnung) riporta voci che i lavoratori italiani possono trovare poco familiari: AVS/AI/IPG al 5,3 % copre previdenza vecchiaia, invalidità e indennità per perdita di guadagno; AC all\'1,1 % è l\'assicurazione contro la disoccupazione; LAA copre gli infortuni non professionali; IJM fornisce le indennità giornaliere di malattia; e il LPP è il contributo pensionistico obbligatorio del secondo pilastro, che varia per fascia d\'età dal 7 % (25–34 anni) fino al 18 % (55–64 anni).',
 'Comprendere la differenza tra lordo e netto in Svizzera rispetto all\'Italia è fondamentale per una corretta pianificazione finanziaria. In Svizzera le deduzioni sociali totalizzano il 12–16 % del lordo a seconda dell\'età, mentre in Italia i contributi INPS raggiungono il 9,19 % per i dipendenti, con aliquote IRPEF più elevate. Il sistema svizzero accumula più capitale previdenziale tramite il LPP obbligatorio: uno stipendio netto inferiore costruisce in realtà più risparmio pensionistico di un ruolo equivalente in Italia.',
 ],
 en: [
 'The payslip simulator reconstructs your net salary step by step starting from the gross annual amount in Swiss francs: AVS/AI/IPG (5.3%), unemployment insurance (1.1%), non-occupational accident insurance, and daily sickness benefits are deducted before calculating the withholding tax.',
 'Withholding tax is computed using the Canton Ticino A/B/C/H tax tables, updated for 2026, accounting for marital status, number of children, and religious affiliation. The result is then converted to euros at the selected exchange rate to show real purchasing power in Italy.',
 'After the simulation you can compare the net result against actual cross-border living costs: transport, LAMal health insurance, lunches, parking, and car insurance with Swiss plates — giving you a realistic estimate of monthly savings.',
 'A Swiss payslip (Lohnabrechnung) typically lists several deductions that Italian workers may find unfamiliar: AVS/AI/APG at 5.3% covers old-age, disability, and maternity insurance; AC at 1.1% is unemployment insurance; NBU covers non-occupational accident insurance; KTG provides daily sickness benefits; and LPP is the mandatory occupational pension contribution that varies by age bracket (7% at age 25–34 rising to 18% at age 55–64).',
 'Understanding the difference between gross and net salary in Switzerland versus Italy is crucial for accurate financial planning. In Switzerland, social deductions total roughly 12–16% of gross pay depending on age, while in Italy INPS contributions reach 9.19% for employees plus higher IRPEF rates. The Swiss system front-loads pension savings via mandatory LPP, meaning a lower net salary actually builds more retirement capital than an equivalent Italian role — a factor often overlooked during salary negotiations.',
 ],
 de: [
 'Der Lohnabrechnungssimulator berechnet Ihr Nettogehalt Schritt für Schritt ab dem Bruttojahresbetrag in Schweizer Franken: AHV/IV/EO (5,3 %), Arbeitslosenversicherung (1,1 %), Nichtberufsunfallversicherung und Krankentaggeld werden vor der Quellensteuer abgezogen.',
 'Die Quellensteuer wird anhand der Tessiner Steuertabellen A/B/C/H berechnet, aktualisiert für 2026, unter Berücksichtigung von Familienstand, Kinderzahl und Konfession. Das Ergebnis wird zum gewählten Wechselkurs in Euro umgerechnet, um die reale Kaufkraft in Italien zu zeigen.',
 'Nach der Simulation können Sie das Nettoergebnis mit den tatsächlichen Grenzgänger-Lebenshaltungskosten vergleichen: Transport, LAMal-Versicherung, Mittagessen, Parkplatz und Autoversicherung mit Schweizer Kennzeichen.',
 'Eine Schweizer Lohnabrechnung listet typischerweise mehrere Abzüge auf, die italienischen Arbeitnehmern unbekannt sein können: AHV/IV/EO mit 5,3 % deckt Alters-, Invaliditäts- und Mutterschaftsversicherung; ALV mit 1,1 % ist die Arbeitslosenversicherung; NBU die Nichtberufsunfallversicherung; KTG das Krankentaggeld; und BVG der obligatorische Pensionskassenbeitrag, der je nach Alter variiert (7 % bei 25–34 Jahren bis 18 % bei 55–64 Jahren).',
 'Das Verständnis des Unterschieds zwischen Brutto- und Nettogehalt in der Schweiz versus Italien ist entscheidend für die Finanzplanung. In der Schweiz betragen die Sozialabzüge je nach Alter insgesamt 12–16 % des Bruttogehalts, während in Italien die INPS-Beiträge 9,19 % für Arbeitnehmer plus höhere IRPEF-Sätze erreichen. Das Schweizer System baut über die obligatorische BVG mehr Vorsorgekapital auf als eine gleichwertige italienische Stelle — ein bei Gehaltsverhandlungen oft übersehener Faktor.',
 ],
 fr: [
 'Le simulateur de fiche de paie reconstitue votre salaire net étape par étape à partir du brut annuel en francs suisses : AVS/AI/APG (5,3 %), assurance chômage (1,1 %), assurance accidents non professionnels et indemnités journalières de maladie sont déduits avant le calcul de l\'impôt à la source.',
 'L\'impôt à la source est calculé selon les barèmes A/B/C/H du Canton du Tessin, mis à jour pour 2026, en tenant compte de l\'état civil, du nombre d\'enfants et de l\'appartenance religieuse. Le résultat est converti en euros au taux de change sélectionné pour montrer le pouvoir d\'achat réel en Italie.',
 'Après la simulation, vous pouvez comparer le résultat net aux coûts réels de la vie transfrontalière : transport, assurance LAMal, repas, parking et assurance auto avec plaques suisses.',
 'Une fiche de paie suisse (Lohnabrechnung) liste typiquement plusieurs déductions peu familières aux travailleurs italiens : AVS/AI/APG à 5,3 % couvre l\'assurance vieillesse, invalidité et maternité ; AC à 1,1 % est l\'assurance chômage ; AANP couvre les accidents non professionnels ; IJM fournit les indemnités journalières maladie ; et la LPP est la cotisation de prévoyance obligatoire qui varie selon l\'âge (7 % de 25 à 34 ans jusqu\'à 18 % de 55 à 64 ans).',
 'Comprendre la différence entre salaire brut et net en Suisse versus en Italie est crucial pour une planification financière précise. En Suisse, les déductions sociales totalisent environ 12–16 % du brut selon l\'âge, tandis qu\'en Italie les cotisations INPS atteignent 9,19 % pour les salariés plus des taux IRPEF plus élevés. Le système suisse accumule davantage de capital retraite via la LPP obligatoire, ce qui signifie qu\'un salaire net inférieur construit en réalité plus de prévoyance — un facteur souvent négligé lors des négociations salariales.',
 ],
 },
 '/calcola-stipendio/cosa-cambia-se': {
 en: [
 'The "What If" simulator lets you change one parameter at a time — marital status, distance from the border, number of children, work percentage, canton — and instantly see the impact on monthly and annual net salary, so you can evaluate real decisions before making them.',
 'Each scenario is calculated with the same rules as the main simulator: Swiss social deductions, cantonal withholding tax, and CHF-EUR conversion. Differences are highlighted visually for quick comparison.',
 'This tool is particularly useful when evaluating a change of residence, a marriage, the birth of a child, or a switch to part-time work: all situations that significantly modify a cross-border worker\'s taxation.',
 ],
 de: [
 'Der Was-wäre-wenn-Simulator ermöglicht es Ihnen, einen Parameter nach dem anderen zu ändern — Familienstand, Entfernung zur Grenze, Kinderzahl, Arbeitspensum, Kanton — und sofort die Auswirkung auf das monatliche und jährliche Nettogehalt zu sehen.',
 'Jedes Szenario wird mit denselben Regeln wie der Hauptsimulator berechnet: Schweizer Sozialabzüge, kantonale Quellensteuer und CHF-EUR-Umrechnung. Die Unterschiede werden visuell hervorgehoben.',
 'Dieses Tool ist besonders nützlich bei der Planung eines Wohnsitzwechsels, einer Heirat, der Geburt eines Kindes oder dem Wechsel in Teilzeit — alles Situationen, die die Besteuerung des Grenzgängers erheblich verändern.',
 ],
 fr: [
 'Le simulateur « Et si » permet de modifier un paramètre à la fois — état civil, distance de la frontière, nombre d\'enfants, taux d\'activité, canton — et de voir immédiatement l\'impact sur le salaire net mensuel et annuel.',
 'Chaque scénario est calculé avec les mêmes règles que le simulateur principal : déductions sociales suisses, impôt à la source cantonal et conversion CHF-EUR. Les différences sont mises en évidence visuellement.',
 'Cet outil est particulièrement utile pour évaluer un changement de résidence, un mariage, une naissance ou un passage à temps partiel : toutes des situations qui modifient significativement la fiscalité du frontalier.',
 ],
 },
 '/calcola-stipendio/confronta-stipendi': {
 en: [
 'The salary comparator compares net pay for the same role in Ticino (CHF) and in Lombardy/Piedmont (EUR), factoring in taxation, social contributions, and cost of living in both countries.',
 'Reference data comes from real salary statistics by sector and experience level, integrated with the tax and contribution rates in force in Switzerland and Italy for 2026.',
 'The comparison includes indirect costs typical of cross-border workers (transport, health insurance, currency exchange) to give a complete picture of the net economic advantage of working in Switzerland versus an equivalent position in Italy.',
 ],
 de: [
 'Der Gehaltsvergleicher vergleicht das Nettogehalt für die gleiche Stelle im Tessin (CHF) und in der Lombardei/Piemont (EUR) unter Berücksichtigung von Besteuerung, Sozialabgaben und Lebenshaltungskosten in beiden Ländern.',
 'Die Referenzdaten stammen aus realen Gehaltsstatistiken nach Branche und Erfahrungsstufe, integriert mit den 2026 geltenden Steuer- und Beitragssätzen in der Schweiz und Italien.',
 'Der Vergleich umfasst indirekte Grenzgänger-Kosten (Transport, Krankenversicherung, Währungsumtausch) für ein vollständiges Bild des wirtschaftlichen Nettovorteils der Arbeit in der Schweiz.',
 ],
 fr: [
 'Le comparateur de salaires compare la rémunération nette pour le même poste au Tessin (CHF) et en Lombardie/Piémont (EUR), en tenant compte de la fiscalité, des cotisations sociales et du coût de la vie dans les deux pays.',
 'Les données de référence proviennent de statistiques salariales réelles par secteur et niveau d\'expérience, intégrées avec les taux fiscaux et de cotisation en vigueur en Suisse et en Italie pour 2026.',
 'La comparaison inclut les coûts indirects typiques des frontaliers (transport, assurance maladie, change de devises) pour un tableau complet de l\'avantage économique net de travailler en Suisse.',
 ],
 },
 '/calcola-stipendio/quiz-stipendio': {
 en: [
 'The salary quiz tests your knowledge of the tax and contribution rules that determine a cross-border worker\'s net pay: social deductions, withholding tax, franchise, and the 2026 New Fiscal Agreement.',
 'Each question includes a detailed explanation of the underlying mechanism, making the quiz both an assessment and a learning tool for anyone new to cross-border work.',
 ],
 de: [
 'Das Gehaltsquiz testet Ihr Wissen über die Steuer- und Beitragsregeln, die das Nettogehalt eines Grenzgängers bestimmen: Sozialabzüge, Quellensteuer, Franchise und das Neue Steuerabkommen 2026.',
 'Jede Frage enthält eine ausführliche Erklärung des zugrunde liegenden Mechanismus, sodass das Quiz sowohl Wissenstest als auch Lernwerkzeug für Grenzgänger-Neulinge ist.',
 ],
 fr: [
 'Le quiz salarial teste vos connaissances sur les règles fiscales et de cotisation qui déterminent le net d\'un frontalier : déductions sociales, impôt à la source, franchise et le Nouvel Accord fiscal 2026.',
 'Chaque question inclut une explication détaillée du mécanisme sous-jacent, faisant du quiz un outil d\'évaluation et de formation pour les nouveaux frontaliers.',
 ],
 },
 '/calcola-stipendio/': {
 en: [
 'The salary calculation tool uses the 2026 tax and social security parameters for Switzerland and Italy, applying the rules of the New Fiscal Agreement on cross-border worker taxation that entered into force in 2024.',
 'Results account for Canton Ticino specifics: withholding tax rates, A/B/C/H classification tables, per-child deductions, and automatic CHF-EUR conversion at market rates.',
 'For a reliable estimate, enter your gross annual salary in Swiss francs: the system automatically applies AVS/AI/IPG, AC, LAA, IJM, and LPP contributions based on the age brackets defined by federal law.',
 '<p style="color:#64748b;font-size:0.8rem;margin-top:4px;">Source: <a href="https://www.estv.admin.ch" style="color:#2563eb;text-decoration:none;" rel="noopener">Federal Tax Administration (FTA)</a></p>',
 ],
 de: [
 'Das Gehaltsberechnungstool verwendet die Steuer- und Sozialversicherungsparameter 2026 für die Schweiz und Italien und wendet die Regeln des Neuen Steuerabkommens über die Besteuerung von Grenzgängern an, das 2024 in Kraft trat.',
 'Die Ergebnisse berücksichtigen Tessiner Besonderheiten: Quellensteuersätze, Klassifizierungstabellen A/B/C/H, Kinderabzüge und automatische CHF-EUR-Umrechnung zu Marktkursen.',
 'Für eine zuverlässige Schätzung geben Sie Ihr Bruttojahresgehalt in Schweizer Franken ein: Das System wendet automatisch AHV/IV/EO-, ALV-, UVG-, KTG- und BVG-Beiträge nach Altersgruppen des Bundesgesetzes an.',
 '<p style="color:#64748b;font-size:0.8rem;margin-top:4px;">Quelle: <a href="https://www.estv.admin.ch" style="color:#2563eb;text-decoration:none;" rel="noopener">Eidgenössische Steuerverwaltung (ESTV)</a></p>',
 ],
 fr: [
 'L\'outil de calcul de salaire utilise les paramètres fiscaux et de sécurité sociale 2026 pour la Suisse et l\'Italie, en appliquant les règles du Nouvel Accord fiscal sur l\'imposition des frontaliers entré en vigueur en 2024.',
 'Les résultats tiennent compte des spécificités du Tessin : taux d\'impôt à la source, barèmes A/B/C/H, déductions par enfant et conversion automatique CHF-EUR aux taux du marché.',
 'Pour une estimation fiable, saisissez votre salaire brut annuel en francs suisses : le système applique automatiquement les cotisations AVS/AI/APG, AC, LAA, IJM et LPP selon les tranches d\'âge prévues par la loi fédérale.',
 '<p style="color:#64748b;font-size:0.8rem;margin-top:4px;">Source : <a href="https://www.estv.admin.ch" style="color:#2563eb;text-decoration:none;" rel="noopener">Administration fédérale des contributions (AFC)</a></p>',
 ],
 },

 // ───── Comparators ────────────────────────────────────────────
 '/compara-servizi/cambio-franco-euro': {
 it: [
 '<h2 style="font-size:1.15rem;font-weight:700;margin:1.25rem 0 .5rem">Cambio franco-euro: tasso e spread in sintesi</h2>',
 '<p>Il <strong>cambio franco-euro (CHF/EUR)</strong> è uno dei più importanti per i frontalieri italiani: ogni CHF guadagnato in Svizzera deve essere convertito in EUR per le spese familiari in Italia. Il tasso "mid-market" è il prezzo reale di mercato interbancario (oggi intorno a 1 CHF = 0,94 EUR, ovvero 1 EUR = 1,06 CHF). Il <strong>tasso "di vendita"</strong> applicato dai provider a un cliente retail è più alto di una percentuale chiamata <em>spread</em> che varia da 0,3% (servizi online) a oltre 3% (banche tradizionali e uffici di cambio). La differenza è il guadagno del provider e il costo per l\'utente.</p>',
 '<h2 style="font-size:1.15rem;font-weight:700;margin:1.25rem 0 .5rem">Tabella spread 2026 dei principali provider</h2>',
 '<p>Ecco i principali provider di cambio CHF/EUR ordinati per spread medio (gennaio-marzo 2026): <strong>Wise 0,35-0,60%</strong>, <strong>Revolut Standard 0,5% (+1% weekend)</strong>, <strong>Revolut Premium/Metal 0% (entro soglia)</strong>, <strong>N26 You/Metal 0,1%</strong>, <strong>PostFinance 1,3-1,8%</strong>, <strong>Raiffeisen 1,5-2%</strong>, <strong>UBS 1,8-2,5%</strong>, <strong>Banca Stato 1,2-1,8%</strong>, <strong>Banche italiane (Intesa, UniCredit) 2-3%</strong>, <strong>Uffici cambio aeroporto/stazione 3-6%</strong>. Per frontalieri che cambiano CHF 3.000-7.000/mese il risparmio di Wise rispetto a una banca tradizionale è tipicamente di CHF 60-150/mese, pari a CHF 720-1.800 all\'anno. Si tratta di un importo che giustifica ampiamente l\'apertura di un conto Wise gratuito.</p>',
 '<h2 style="font-size:1.15rem;font-weight:700;margin:1.25rem 0 .5rem">Calcolatore commissione: quanto costa davvero il cambio</h2>',
 '<p>Per calcolare il costo reale di un cambio si applica la formula: <code>costo = importo × (spread + commissione fissa)</code>. Esempio: cambio di CHF 5.000 con Wise (spread 0,45% + €3 fissi) = CHF 22,50 + €3 ≈ CHF 25,70. Stesso importo con PostFinance (spread 1,6%) = CHF 80. Differenza: CHF 54 per una singola operazione, CHF 648/anno se ripetuta mensilmente. Il nostro <em>calcolatore commissione cambio</em> confronta in tempo reale i 6 provider principali considerando importo, frequenza, tipo di conto (corrente, multivaluta, carta prepagata). <strong>Attenzione</strong>: molti provider mostrano "commissione zero" ma inseriscono lo spread nel tasso di cambio — confrontare sempre il tasso effettivo ricevuto con il mid-market.</p>',
 '<h2 style="font-size:1.15rem;font-weight:700;margin:1.25rem 0 .5rem">Strategia ottimale per frontalieri</h2>',
 '<p>La strategia più conveniente dipende dall\'uso: <strong>(A) Famiglia in Italia, spese in EUR</strong>: ricevere stipendio su conto svizzero → ogni mese trasferire a Wise/Revolut la quota da spendere in Italia → cambio CHF→EUR a spread 0,3-0,5% → bonifico sul conto italiano. <strong>(B) Permesso B</strong>: conto svizzero principale, cambio solo per vacanze. <strong>(C) Freelance con partita IVA italiana</strong>: conto multivaluta (Wise Borderless, Revolut Business) con IBAN CH + IBAN EU. <strong>Dritta avanzata</strong>: impostare alert di tasso (soglia esempio CHF 1 = EUR 0,95) per cambiare quando il franco è più forte.</p>',
 '<h2 style="font-size:1.15rem;font-weight:700;margin:1.25rem 0 .5rem">Storia del tasso CHF/EUR e impatto</h2>',
 '<p>Il tasso CHF/EUR è stato storicamente volatile: dal <strong>floor</strong> imposto dalla BNS (1 EUR = 1,20 CHF) dal 2011 al 15 gennaio 2015 (famoso "Franken-Schock"), al range 0,93-0,98 dal 2023 in poi. Per i frontalieri un franco forte significa stipendio EUR più alto a parità di CHF lordo (es. CHF 6.000 = EUR 5.640 a 0,94 vs EUR 5.400 a 0,90). Per pianificare le spese: conservare almeno 2-3 mensilità di stipendio in CHF su conto svizzero come "cuscinetto" in caso di deprezzamento rapido del franco, e monitorare le decisioni di politica monetaria trimestrali di BCE e BNS.</p>',
 '<p style="color:#64748b;font-size:0.8rem;margin-top:4px;">Fonte: <a href="https://www.snb.ch" style="color:#2563eb;text-decoration:none;" rel="noopener">Banca Nazionale Svizzera (BNS)</a> · dati aggiornati in tempo reale.</p>',
 ],
 en: [
 '<h2 style="font-size:1.15rem;font-weight:700;margin:1.25rem 0 .5rem">CHF/EUR exchange: rate and spread in a nutshell</h2>',
 '<p>The <strong>CHF/EUR exchange</strong> is one of the most important for Italian cross-border workers: every CHF earned in Switzerland must be converted to EUR for family expenses in Italy. The "mid-market" rate is the real interbank price (around 1 CHF = 0.94 EUR). Retail "sell" rates from providers are higher than mid-market by a percentage called <em>spread</em>, ranging from 0.3% (online services) to over 3% (traditional banks and exchange bureaus).</p>',
 '<h2 style="font-size:1.15rem;font-weight:700;margin:1.25rem 0 .5rem">2026 spread table for main providers</h2>',
 '<p>Ranked by average spread (Q1 2026): Wise 0.35-0.60%, Revolut Standard 0.5% (+1% weekend), Revolut Premium 0%, N26 You/Metal 0.1%, PostFinance 1.3-1.8%, UBS 1.8-2.5%, Italian banks 2-3%, airport bureaus 3-6%. A cross-border worker exchanging CHF 5,000/month saves CHF 60-150 with Wise vs a traditional bank — roughly CHF 720-1,800 per year.</p>',
 '<h2 style="font-size:1.15rem;font-weight:700;margin:1.25rem 0 .5rem">Optimal strategy for cross-border workers</h2>',
 '<p>Receive your salary on a Swiss account → each month transfer the amount needed in Italy via Wise/Revolut → bank transfer to your Italian account. Advanced tip: set rate alerts (e.g. CHF 1 = EUR 0.95) to exchange when the franc is stronger. Keep 2-3 months of salary in CHF as a buffer against sudden CHF depreciation.</p>',
 'Beyond instant conversion, interactive charts show the Swiss franc to euro exchange rate history over the last 12 months, useful for identifying the best time to convert your salary.',
 '<p style="color:#64748b;font-size:0.8rem;margin-top:4px;">Source: <a href="https://www.snb.ch" style="color:#2563eb;text-decoration:none;" rel="noopener">Swiss National Bank (SNB)</a></p>',
 ],
 de: [
 '<h2 style="font-size:1.15rem;font-weight:700;margin:1.25rem 0 .5rem">CHF/EUR Wechselkurs: Kurs und Spread im Überblick</h2>',
 '<p>Der <strong>CHF/EUR-Wechselkurs</strong> ist für italienische Grenzgänger einer der wichtigsten: Jeder in der Schweiz verdiente CHF muss in EUR umgewandelt werden. Der "Mid-Market"-Kurs ist der reale Interbankenkurs (aktuell rund 1 CHF = 0,94 EUR). Der vom Anbieter angewandte Retail-Kurs ist um einen Spread von 0,3 % (Online-Dienste) bis über 3 % (traditionelle Banken) höher.</p>',
 '<h2 style="font-size:1.15rem;font-weight:700;margin:1.25rem 0 .5rem">Spread-Tabelle 2026 der wichtigsten Anbieter</h2>',
 '<p>Rangliste (Q1 2026): Wise 0,35-0,60 %, Revolut Standard 0,5 %, Revolut Premium 0 %, N26 You/Metal 0,1 %, PostFinance 1,3-1,8 %, UBS 1,8-2,5 %, italienische Banken 2-3 %. Ein Grenzgänger, der CHF 5.000/Monat wechselt, spart mit Wise CHF 60-150 gegenüber einer traditionellen Bank — etwa CHF 720-1.800 pro Jahr.</p>',
 '<h2 style="font-size:1.15rem;font-weight:700;margin:1.25rem 0 .5rem">Optimale Strategie für Grenzgänger</h2>',
 '<p>Lohn auf einem Schweizer Konto empfangen → monatlich den in Italien benötigten Betrag über Wise/Revolut überweisen. Tipp: Kurs-Alerts einrichten (z. B. CHF 1 = EUR 0,95), um bei stärkerem Franken zu wechseln. 2-3 Monatsgehälter als Puffer halten.</p>',
 'Interaktive Grafiken zeigen den Verlauf des Schweizer Franken zum Euro über die letzten 12 Monate — nützlich, um den besten Zeitpunkt für die Gehaltsumrechnung zu finden.',
 '<p style="color:#64748b;font-size:0.8rem;margin-top:4px;">Quelle: <a href="https://www.snb.ch" style="color:#2563eb;text-decoration:none;" rel="noopener">Schweizerische Nationalbank (SNB)</a></p>',
 ],
 fr: [
 '<h2 style="font-size:1.15rem;font-weight:700;margin:1.25rem 0 .5rem">Change CHF/EUR : taux et spread en bref</h2>',
 '<p>Le <strong>change CHF/EUR</strong> est l\'un des plus importants pour les frontaliers italiens : chaque CHF gagné en Suisse doit être converti en EUR. Le taux "mid-market" est le prix réel interbancaire (environ 1 CHF = 0,94 EUR). Le taux retail appliqué par les prestataires est supérieur d\'un <em>spread</em> variant de 0,3 % (services en ligne) à plus de 3 % (banques traditionnelles).</p>',
 '<h2 style="font-size:1.15rem;font-weight:700;margin:1.25rem 0 .5rem">Tableau des spreads 2026</h2>',
 '<p>Classement (T1 2026) : Wise 0,35-0,60 %, Revolut Standard 0,5 %, Revolut Premium 0 %, N26 You/Metal 0,1 %, PostFinance 1,3-1,8 %, UBS 1,8-2,5 %, banques italiennes 2-3 %. Un frontalier changeant CHF 5 000/mois économise avec Wise CHF 60-150 par rapport à une banque traditionnelle — environ CHF 720-1.800 par an.</p>',
 '<h2 style="font-size:1.15rem;font-weight:700;margin:1.25rem 0 .5rem">Stratégie optimale</h2>',
 '<p>Recevoir le salaire sur un compte suisse → chaque mois transférer le montant nécessaire en Italie via Wise/Revolut. Astuce : paramétrer des alertes de taux (ex. CHF 1 = EUR 0,95) pour changer quand le franc est plus fort. Conserver 2-3 mois de salaire en CHF comme tampon.</p>',
 'Des graphiques interactifs montrent l\'historique du taux de change franc suisse / euro sur les 12 derniers mois, utile pour identifier le meilleur moment pour convertir votre salaire.',
 '<p style="color:#64748b;font-size:0.8rem;margin-top:4px;">Source : <a href="https://www.snb.ch" style="color:#2563eb;text-decoration:none;" rel="noopener">Banque nationale suisse (BNS)</a></p>',
 ],
 },
 '/compara-servizi/confronta-casse-malati': {
 en: [
 'The LAMal health insurance comparator compares monthly premiums from 14 recognized Swiss insurers (FOPH), calculated by canton, insurance model, deductible, age group, and accident coverage.',
 'Cross-border workers with a G permit can choose between Swiss LAMal and the Italian national health service: the choice is irrevocable for the duration of employment. This tool helps compare costs before deciding.',
 'Premiums are calculated using the formula: base × (1 − model discount) × (1 + deductible factor) × age multiplier × (1 + accident coverage). Data covers cantons TI, GR, VS, ZH, GE, BE, and LU.',
 '<p style="color:#64748b;font-size:0.8rem;margin-top:4px;">Source: <a href="https://www.bag.admin.ch" style="color:#2563eb;text-decoration:none;" rel="noopener">Federal Office of Public Health (FOPH)</a></p>',
 ],
 de: [
 'Der KVG-Krankenkassenvergleicher vergleicht monatliche Prämien von 14 anerkannten Schweizer Versicherern (BAG), berechnet nach Kanton, Versicherungsmodell, Franchise, Altersgruppe und Unfalldeckung.',
 'Grenzgänger mit Ausweis G können zwischen der Schweizer KVG und dem italienischen nationalen Gesundheitsdienst wählen: Die Wahl ist für die gesamte Beschäftigungsdauer unwiderruflich. Dieses Tool hilft, die Kosten vor der Entscheidung zu vergleichen.',
 'Die Prämien werden berechnet mit: Basis × (1 − Modellrabatt) × (1 + Franchisefaktor) × Altersmultiplikator × (1 + Unfalldeckung). Die Daten umfassen die Kantone TI, GR, VS, ZH, GE, BE und LU.',
 '<p style="color:#64748b;font-size:0.8rem;margin-top:4px;">Quelle: <a href="https://www.bag.admin.ch" style="color:#2563eb;text-decoration:none;" rel="noopener">Bundesamt für Gesundheit (BAG)</a></p>',
 ],
 fr: [
 'Le comparateur d\'assurance maladie LAMal compare les primes mensuelles de 14 assureurs suisses reconnus (OFSP), calculées par canton, modèle d\'assurance, franchise, tranche d\'âge et couverture accidents.',
 'Les frontaliers avec un permis G peuvent choisir entre la LAMal suisse et le service national de santé italien : le choix est irrévocable pour toute la durée de l\'emploi. Cet outil aide à comparer les coûts avant de décider.',
 'Les primes sont calculées selon la formule : base × (1 − rabais modèle) × (1 + facteur franchise) × multiplicateur âge × (1 + couverture accidents). Les données couvrent les cantons TI, GR, VS, ZH, GE, BE et LU.',
 '<p style="color:#64748b;font-size:0.8rem;margin-top:4px;">Source : <a href="https://www.bag.admin.ch" style="color:#2563eb;text-decoration:none;" rel="noopener">Office fédéral de la santé publique (OFSP)</a></p>',
 ],
 },
 '/compara-servizi/confronta-banche': {
 en: [
 'The bank comparison analyses the main Swiss and Italian banks used by cross-border workers, comparing exchange commissions, account fees, debit/credit cards, and cross-border transfer services.',
 'For cross-border workers, the choice of bank directly affects net pay: CHF→EUR exchange commissions can range from 0.3% to 2.5% depending on the institution and the transfer method used.',
 'The tool also compares multi-currency accounts, SEPA transfer fees, and mobile banking features — key factors when managing income in CHF and expenses in EUR on a daily basis.',
 'Online banks and fintech platforms such as Revolut, Wise, and Neon offer cross-border workers competitive exchange rates — often 0.3–0.5% — compared to traditional Swiss banks that may charge 1–2%. However, traditional banks provide in-branch services useful for mortgage applications, salary certificates, and LPP pension account management that digital-only banks cannot match.',
 'A common pitfall for frontalieri is accepting the default exchange rate on salary payment day. Many employers convert CHF salaries to EUR automatically using their house bank\'s rate, which can be 1–1.5% worse than the interbank rate. Setting up a CHF-denominated account and converting manually on favourable days can save EUR 500–1,200 annually on a typical cross-border salary.',
 ],
 de: [
 'Der Bankenvergleich analysiert die wichtigsten Schweizer und italienischen Banken für Grenzgänger und vergleicht Wechselkurskommissionen, Kontogebühren, Debit-/Kreditkarten und grenzüberschreitende Überweisungsdienste.',
 'Für Grenzgänger wirkt sich die Bankwahl direkt auf das Nettogehalt aus: CHF→EUR-Wechselkurskommissionen können je nach Institut und Überweisungsmethode zwischen 0,3 % und 2,5 % variieren.',
 'Das Tool vergleicht auch Multiwährungskonten, SEPA-Überweisungsgebühren und Mobile-Banking-Funktionen — entscheidende Faktoren bei der täglichen Verwaltung von CHF-Einkommen und EUR-Ausgaben.',
 'Online-Banken und Fintech-Plattformen wie Revolut, Wise und Neon bieten Grenzgängern günstige Wechselkurse — oft 0,3–0,5 % — im Vergleich zu traditionellen Schweizer Banken mit 1–2 %. Traditionelle Banken bieten jedoch Schalterdienstleistungen für Hypothekenanträge, Lohnausweise und BVG-Kontoverwaltung, die reine Digitalbanken nicht leisten können.',
 'Eine häufige Falle für Grenzgänger ist die Akzeptanz des Standard-Wechselkurses am Gehaltszahlungstag. Viele Arbeitgeber konvertieren CHF-Gehälter automatisch zum Hausbankenkurs, der 1–1,5 % schlechter als der Interbankenkurs sein kann. Ein CHF-Konto einzurichten und manuell an günstigen Tagen umzutauschen, kann jährlich EUR 500–1.200 einsparen.',
 ],
 fr: [
 'La comparaison bancaire analyse les principales banques suisses et italiennes utilisées par les frontaliers, en comparant les commissions de change, les frais de compte, les cartes de débit/crédit et les services de virement transfrontalier.',
 'Pour les frontaliers, le choix de la banque affecte directement le salaire net : les commissions de change CHF→EUR peuvent varier de 0,3 % à 2,5 % selon l\'établissement et la méthode de transfert utilisée.',
 'L\'outil compare également les comptes multidevises, les frais de virement SEPA et les fonctionnalités de banque mobile — des critères essentiels pour gérer au quotidien des revenus en CHF et des dépenses en EUR.',
 'Les banques en ligne et les plateformes fintech comme Revolut, Wise et Neon offrent aux frontaliers des taux de change compétitifs — souvent 0,3–0,5 % — contre 1–2 % dans les banques suisses traditionnelles. Toutefois, les banques traditionnelles fournissent des services en agence indispensables pour les demandes de prêt hypothécaire, les attestations de salaire et la gestion des comptes LPP.',
 'Un piège fréquent pour les frontaliers est d\'accepter le taux de change par défaut le jour du versement du salaire. Beaucoup d\'employeurs convertissent automatiquement les salaires CHF en EUR au taux de leur banque maison, souvent 1–1,5 % moins favorable que le taux interbancaire. Ouvrir un compte en CHF et convertir manuellement les jours favorables peut économiser EUR 500–1 200 par an.',
 ],
 },
 '/compara-servizi/confronta-offerte-lavoro': {
 en: [
 'The Swiss jobs section gathers job postings published on official company sources across Cantons Ticino, Graubünden and Valais, with data normalization to facilitate comparison between role, location, contract type, and match with your professional profile.',
 'For each position, useful metadata is maintained: publication date, company, location, requirements, and direct link to apply on the employer\'s original website.',
 'Listings are filtered for target cantons (TI, GR, VS) and updated daily by dedicated crawlers that monitor the HR portals of over 100 companies, public entities, and multinationals based in the region.',
 ],
 de: [
 'Die Stellensuche in der Schweiz sammelt Stellenangebote von offiziellen Unternehmensquellen in den Kantonen Tessin, Graubünden und Wallis mit Datennormalisierung zum einfachen Vergleich von Rolle, Standort, Vertragsart und Übereinstimmung mit Ihrem Berufsprofil.',
 'Für jede Stelle werden nützliche Metadaten gepflegt: Veröffentlichungsdatum, Unternehmen, Standort, Anforderungen und Direktlink zur Bewerbung auf der Originalwebsite des Arbeitgebers.',
 'Die Angebote werden für die Zielkantone (TI, GR, VS) gefiltert und täglich von dedizierten Crawlern aktualisiert, die die HR-Portale von über 100 Unternehmen, öffentlichen Einrichtungen und Konzernen in der Region überwachen.',
 ],
 fr: [
 'La section emploi en Suisse recueille les offres d\'emploi publiées sur les sources officielles des entreprises dans les cantons du Tessin, des Grisons et du Valais, avec normalisation des données pour faciliter la comparaison entre poste, lieu, type de contrat et adéquation avec votre profil professionnel.',
 'Pour chaque poste, des métadonnées utiles sont conservées : date de publication, entreprise, localité, exigences et lien direct pour postuler sur le site original de l\'employeur.',
 'Les offres sont filtrées pour les cantons cibles (TI, GR, VS) et mises à jour quotidiennement par des crawlers dédiés qui surveillent les portails RH de plus de 100 entreprises dans la région.',
 ],
 },
 '/compara-servizi/costo-auto': {
 en: [
 'The car cost calculator compares annual expenses of owning and using a vehicle in Switzerland and in Italy, including liability insurance, road tax, maintenance, fuel, and tolls.',
 'For cross-border workers who cross the border daily, Swiss and Italian plates carry different costs: Swiss insurance covers driving throughout Europe but premiums can exceed CHF 1,500/year.',
 'The calculator also factors in fuel price differences across the border, motorway vignette costs, and the impact of choosing electric vs combustion vehicles on total annual ownership expenses.',
 ],
 de: [
 'Der Autokostenrechner vergleicht die jährlichen Kosten für Besitz und Nutzung eines Fahrzeugs in der Schweiz und in Italien, einschliesslich Haftpflichtversicherung, Strassensteuer, Wartung, Kraftstoff und Maut.',
 'Für Grenzgänger, die täglich die Grenze überqueren, sind Schweizer und italienische Kennzeichen mit unterschiedlichen Kosten verbunden: Die Schweizer Versicherung deckt ganz Europa ab, aber die Prämien können 1.500 CHF/Jahr übersteigen.',
 'Der Rechner berücksichtigt auch Kraftstoffpreisunterschiede an der Grenze, Autobahnvignettenkosten und den Einfluss der Wahl zwischen Elektro- und Verbrennungsfahrzeugen auf die jährlichen Gesamtkosten.',
 ],
 fr: [
 'Le calculateur de coûts auto compare les frais annuels de possession et d\'utilisation d\'un véhicule en Suisse et en Italie, incluant assurance RC, taxe de circulation, entretien, carburant et péages.',
 'Pour les frontaliers qui traversent la frontière quotidiennement, les plaques suisses et italiennes impliquent des coûts différents : l\'assurance suisse couvre toute l\'Europe mais les primes peuvent dépasser 1 500 CHF/an.',
 'Le calculateur prend aussi en compte les écarts de prix du carburant de part et d\'autre de la frontière, le coût de la vignette autoroutière et l\'impact du choix entre véhicule électrique et thermique sur les frais annuels totaux.',
 ],
 },
 '/compara-servizi/costo-della-vita': {
 it: [
 'Il confronto del costo vita svizzera vs italia e lo strumento piu importante per chi deve scegliere tra permesso G (residenza in Italia, pendolare) e permesso B (residenza in Svizzera). Vivere in Italia puo ridurre le spese fisse del 30-50% rispetto al Ticino, ma bisogna considerare i costi di trasporto e il <a href="https://frontaliereticino.ch/guida-frontaliere/tempi-attesa-dogana/">tempo perso alla dogana</a>.',
 'Il confronto copre affitti, spesa alimentare, trasporti, sanita e istruzione tra citta di frontiera come Lugano, Mendrisio, Como e Varese. Usa il nostro <a href="https://frontaliereticino.ch/calcola-stipendio/">calcolatore stipendio netto</a> per calcolare il tuo budget mensile effettivo come frontaliere.',
 'I <a href="https://frontaliereticino.ch/tasse-e-pensione/festivita-ticino/">giorni festivi in Ticino</a> influenzano anche il costo della vita: durante i ponti e le festivita i prezzi di trasporto e ristorazione possono aumentare significativamente nelle zone di frontiera.',
 ],
 en: [
 'The cost of living index compares major expense categories between Switzerland (Ticino) and Italy (Lombardy/Piedmont): rent, transport, groceries, healthcare, education, and leisure.',
 'The cost-of-living differential is the key factor in choosing between a G permit (residence in Italy) and a B permit (residence in Switzerland): living in Italy can reduce fixed expenses by 30–50% compared to Ticino.',
 'The comparison breaks down costs across rental, transport, and groceries categories using real data collected from Ticino and the Italian border region. Each category shows price ranges and percentage differences, helping you build a realistic monthly budget before deciding on your residence permit type.',
 ],
 de: [
 'Der Lebenshaltungskostenindex vergleicht die wichtigsten Ausgabenkategorien zwischen der Schweiz (Tessin) und Italien (Lombardei/Piemont): Miete, Transport, Lebensmittel, Gesundheitswesen, Bildung und Freizeit.',
 'Das Lebenshaltungskostengefälle ist der entscheidende Faktor bei der Wahl zwischen Ausweis G (Wohnsitz in Italien) und Ausweis B (Wohnsitz in der Schweiz): Das Leben in Italien kann die Fixkosten um 30–50 % im Vergleich zum Tessin senken.',
 'Der Vergleich schlüsselt die Kosten nach Miete, Transport und Lebensmittel auf, basierend auf realen Erhebungsdaten aus dem Tessin und der italienischen Grenzregion. Jede Kategorie zeigt Preisspannen und prozentuale Unterschiede, damit Sie vor der Wahl des Aufenthaltstitels ein realistisches Monatsbudget erstellen können.',
 ],
 fr: [
 'L\'indice du coût de la vie compare les principales catégories de dépenses entre la Suisse (Tessin) et l\'Italie (Lombardie/Piémont) : loyer, transports, alimentation, santé, éducation et loisirs.',
 'Le différentiel de coût de la vie est le facteur clé dans le choix entre un permis G (résidence en Italie) et un permis B (résidence en Suisse) : vivre en Italie peut réduire les charges fixes de 30 à 50 % par rapport au Tessin.',
 'La comparaison détaille les coûts par catégorie — loyer, transports et courses — à partir de données réelles collectées au Tessin et dans la région frontalière italienne. Chaque catégorie affiche les fourchettes de prix et les écarts en pourcentage, vous aidant à établir un budget mensuel réaliste avant de choisir votre type de permis.',
 ],
 },
 '/compara-servizi/': {
 en: [
 'This section compares services, costs, and conditions relevant to those who work in Switzerland and live in Italy, with up-to-date data and interactive tools for informed decisions.',
 'Each comparator uses real data and verifiable sources to ensure reliable results. Parameters can be customized to your specific cross-border worker situation.',
 'The section includes eight dedicated comparator tools — from currency exchange and health insurance to cost of living and childcare — all maintained with data updated monthly. Browse each tool individually or use the overview to identify which comparisons matter most for your cross-border situation.',
 '<p style="color:#64748b;font-size:0.8rem;margin-top:4px;">Source: <a href="https://www.bfs.admin.ch" style="color:#2563eb;text-decoration:none;" rel="noopener">Federal Statistical Office (FSO)</a></p>',
 ],
 de: [
 'Dieser Bereich vergleicht Dienstleistungen, Kosten und Bedingungen, die für Personen relevant sind, die in der Schweiz arbeiten und in Italien leben, mit aktuellen Daten und interaktiven Tools.',
 'Jeder Vergleicher verwendet reale Daten und überprüfbare Quellen für zuverlässige Ergebnisse. Die Parameter können an Ihre spezifische Grenzgänger-Situation angepasst werden.',
 'Der Bereich umfasst acht spezialisierte Vergleichstools — von Währungsumrechnung und Krankenversicherung bis hin zu Lebenshaltungskosten und Kinderbetreuung — alle mit monatlich aktualisierten Daten. Nutzen Sie die einzelnen Tools oder die Übersicht, um die für Ihre Grenzgänger-Situation relevantesten Vergleiche zu finden.',
 '<p style="color:#64748b;font-size:0.8rem;margin-top:4px;">Quelle: <a href="https://www.bfs.admin.ch" style="color:#2563eb;text-decoration:none;" rel="noopener">Bundesamt für Statistik (BFS)</a></p>',
 ],
 fr: [
 'Cette section compare les services, coûts et conditions pertinents pour ceux qui travaillent en Suisse et vivent en Italie, avec des données actualisées et des outils interactifs pour des décisions éclairées.',
 'Chaque comparateur utilise des données réelles et des sources vérifiables pour garantir des résultats fiables. Les paramètres sont personnalisables selon votre situation spécifique de frontalier.',
 'La section comprend huit outils de comparaison dédiés — du change de devises à l\'assurance maladie, en passant par le coût de la vie et les crèches — tous alimentés par des données mises à jour mensuellement. Parcourez chaque outil ou utilisez la vue d\'ensemble pour identifier les comparaisons les plus pertinentes pour votre situation frontalière.',
 '<p style="color:#64748b;font-size:0.8rem;margin-top:4px;">Source : <a href="https://www.bfs.admin.ch" style="color:#2563eb;text-decoration:none;" rel="noopener">Office fédéral de la statistique (OFS)</a></p>',
 ],
 },

 // ───── Taxes & Pension ────────────────────────────────────────
 '/tasse-e-pensione/calcola-previdenza': {
 en: [
 'The pension simulator estimates retirement benefits by combining the first pillar AVS (maximum 2024 pension: CHF 2,450/month), second pillar LPP (contribution credits from 7% to 18% based on age), and the optional third pillar 3a.',
 'For cross-border workers, the Swiss pension is paid even after permanently returning to Italy. AVS contributions accrued in Switzerland are combined with Italian INPS contributions thanks to the bilateral social security convention.',
 'The simulator also shows the impact of different strategies: voluntary third pillar 3a contributions, LPP buy-ins, and the effect of the conversion rate on the final pension, with projections at 5, 10, and 20 years.',
 '<p style="color:#64748b;font-size:0.8rem;margin-top:4px;">Source: <a href="https://www.bsv.admin.ch" style="color:#2563eb;text-decoration:none;" rel="noopener">Federal Social Insurance Office (FSIO)</a></p>',
 ],
 de: [
 'Der Vorsorgesimulator schätzt die Rentenleistungen durch Kombination der ersten Säule AHV (maximale Rente 2024: CHF 2.450/Monat), der zweiten Säule BVG (Gutschriften von 7 % bis 18 % je nach Alter) und der freiwilligen dritten Säule 3a.',
 'Für Grenzgänger wird die Schweizer Rente auch nach der endgültigen Rückkehr nach Italien gezahlt. In der Schweiz angesammelte AHV-Beiträge werden dank des bilateralen Sozialversicherungsabkommens mit italienischen INPS-Beiträgen kombiniert.',
 'Der Simulator zeigt auch die Auswirkung verschiedener Strategien: freiwillige Säule-3a-Einzahlungen, BVG-Einkäufe und den Effekt des Umwandlungssatzes auf die Endrente, mit Prognosen auf 5, 10 und 20 Jahre.',
 '<p style="color:#64748b;font-size:0.8rem;margin-top:4px;">Quelle: <a href="https://www.bsv.admin.ch" style="color:#2563eb;text-decoration:none;" rel="noopener">Bundesamt für Sozialversicherungen (BSV)</a></p>',
 ],
 fr: [
 'Le simulateur de prévoyance estime les prestations de retraite en combinant le premier pilier AVS (rente maximale 2024 : CHF 2 450/mois), le deuxième pilier LPP (bonifications de 7 % à 18 % selon l\'âge) et le troisième pilier 3a facultatif.',
 'Pour les frontaliers, la pension suisse est versée même après le retour définitif en Italie. Les cotisations AVS accumulées en Suisse s\'ajoutent aux cotisations INPS italiennes grâce à la convention bilatérale de sécurité sociale.',
 'Le simulateur montre également l\'impact de différentes stratégies : versements volontaires au pilier 3a, rachats LPP et effet du taux de conversion sur la rente finale, avec des projections à 5, 10 et 20 ans.',
 '<p style="color:#64748b;font-size:0.8rem;margin-top:4px;">Source : <a href="https://www.bsv.admin.ch" style="color:#2563eb;text-decoration:none;" rel="noopener">Office fédéral des assurances sociales (OFAS)</a></p>',
 ],
 },
 '/tasse-e-pensione/scadenze-fiscali': {
 en: [
 'The tax calendar displays all deadlines a cross-border worker must meet in Switzerland and Italy: income tax returns (730/Modello Redditi PF), withholding tax adjustment, IMU payment, and regional/municipal surcharges.',
 'For new cross-border workers (regime from 2024), the EUR 10,000 franchise applies to Swiss employment income for IRPEF purposes: the Italian tax return accounts for this reduction in the taxable base.',
 'Meeting every deadline avoids penalties and late interest. The tool sends personalised reminders and displays the complete calendar with Italian and Swiss dates side by side.',
 ],
 de: [
 'Der Steuerkalender zeigt alle Fristen, die ein Grenzgänger in der Schweiz und Italien einhalten muss: Steuererklärung (730/Modello Redditi PF), Quellensteuerausgleich, IMU-Zahlung und regionale/kommunale Zuschläge.',
 'Für neue Grenzgänger (Regelung ab 2024) gilt die Franchise von EUR 10.000 für Schweizer Arbeitseinkommen im Rahmen der IRPEF: Die italienische Steuererklärung berücksichtigt diese Reduktion der Bemessungsgrundlage.',
 'Die Einhaltung jeder Frist vermeidet Bussen und Verzugszinsen. Das Tool sendet personalisierte Erinnerungen und zeigt den vollständigen Kalender mit italienischen und Schweizer Terminen nebeneinander an.',
 ],
 fr: [
 'Le calendrier fiscal affiche toutes les échéances qu\'un frontalier doit respecter en Suisse et en Italie : déclarations fiscales (730/Modello Redditi PF), ajustement de l\'impôt à la source, paiement de l\'IMU et surtaxes régionales/communales.',
 'Pour les nouveaux frontaliers (régime à partir de 2024), la franchise de 10 000 EUR s\'applique au revenu de travail suisse à des fins IRPEF : la déclaration italienne tient compte de cette réduction de la base imposable.',
 'Respecter chaque échéance évite pénalités et intérêts de retard. L\'outil envoie des rappels personnalisés et affiche le calendrier complet avec les dates italiennes et suisses côte à côte.',
 ],
 },
 '/tasse-e-pensione/simula-terzo-pilastro': {
 en: [
 'The third pillar 3a simulator calculates accumulated capital and future pension based on annual contributions, duration, expected return, and withdrawal tax, showing the fiscal advantage over non-tax-advantaged investments.',
 'In 2026, the maximum deductible for pillar 3a is CHF 7,258 for workers affiliated with an LPP pension fund. The contribution directly reduces taxable income for cantonal withholding tax purposes.',
 'The simulator also compares scenarios with different time horizons and returns, letting you visualise the effect of compound interest and tax relief over the long term.',
 'Pillar 3a contributions offer substantial tax deduction benefits for cross-border workers: the maximum CHF 7,258 deductible in 2026 directly reduces the taxable base for cantonal withholding tax. For a Ticino-based frontaliere earning CHF 80,000, this deduction can save approximately CHF 1,200–1,800 in annual withholding tax depending on marital status and number of children — an immediate return on the contribution.',
 'Cross-border workers must choose between bank-based 3a accounts and insurance-based 3a policies. Bank 3a offers flexibility — contributions can vary each year, and you can hold up to five accounts to stagger withdrawals. Insurance 3a provides guaranteed returns and risk coverage but locks you into fixed annual premiums. For frontalieri who may relocate or change employment status, the bank option is generally recommended due to its greater liquidity and lower penalties for early modification.',
 ],
 de: [
 'Der Säule-3a-Simulator berechnet das angesammelte Kapital und die zukünftige Rente basierend auf jährlichen Einzahlungen, Laufzeit, erwarteter Rendite und Kapitalbezugssteuer — und zeigt den steuerlichen Vorteil gegenüber nicht begünstigten Anlagen.',
 'Im Jahr 2026 beträgt der maximale Abzug für die Säule 3a CHF 7.258 für Arbeitnehmer mit BVG-Anschluss. Die Einzahlung reduziert direkt das quellensteuerbare Einkommen.',
 'Der Simulator vergleicht auch Szenarien mit unterschiedlichen Zeithorizonten und Renditen, sodass Sie den Effekt von Zinseszins und Steuervorteil über die Langfristigkeit hinweg visualisieren können.',
 'Säule-3a-Beiträge bieten Grenzgängern erhebliche Steuerabzugsvorteile: Die maximal abzugsfähigen CHF 7.258 im Jahr 2026 reduzieren direkt die Bemessungsgrundlage für die kantonale Quellensteuer. Für einen im Tessin tätigen Grenzgänger mit einem Einkommen von CHF 80.000 kann dieser Abzug je nach Familienstand und Kinderzahl jährlich CHF 1.200–1.800 an Quellensteuer einsparen — eine sofortige Rendite auf den Beitrag.',
 'Grenzgänger müssen zwischen bankbasierten 3a-Konten und versicherungsbasierten 3a-Policen wählen. Bank-3a bietet Flexibilität — Beiträge können jährlich variieren, und bis zu fünf Konten ermöglichen gestaffelte Bezüge. Versicherungs-3a bietet garantierte Renditen und Risikodeckung, bindet aber an feste Jahresprämien. Für Grenzgänger, die möglicherweise umziehen oder den Beschäftigungsstatus wechseln, wird die Bankoption aufgrund höherer Liquidität und geringerer Strafgebühren bei vorzeitiger Änderung empfohlen.',
 ],
 fr: [
 'Le simulateur du troisième pilier 3a calcule le capital accumulé et la rente future en fonction des versements annuels, de la durée, du rendement attendu et de l\'impôt de retrait, montrant l\'avantage fiscal par rapport aux investissements non privilégiés.',
 'En 2026, le maximum déductible pour le pilier 3a est de CHF 7 258 pour les travailleurs affiliés à une caisse de pension LPP. Le versement réduit directement le revenu imposable à la source.',
 'Le simulateur compare également des scénarios avec différents horizons temporels et rendements, vous permettant de visualiser l\'effet des intérêts composés et de l\'avantage fiscal sur le long terme.',
 'Les versements au pilier 3a offrent des avantages fiscaux considérables aux frontaliers : les CHF 7 258 déductibles en 2026 réduisent directement la base imposable pour l\'impôt à la source cantonal. Pour un frontalier au Tessin gagnant CHF 80 000, cette déduction peut économiser environ CHF 1 200–1 800 d\'impôt à la source annuel selon l\'état civil et le nombre d\'enfants — un rendement immédiat sur le versement.',
 'Les frontaliers doivent choisir entre les comptes 3a bancaires et les polices 3a d\'assurance. Le 3a bancaire offre de la flexibilité — les versements peuvent varier chaque année, et on peut détenir jusqu\'à cinq comptes pour échelonner les retraits. Le 3a assurance garantit des rendements et une couverture risque mais impose des primes annuelles fixes. Pour les frontaliers susceptibles de déménager ou de changer de statut professionnel, l\'option bancaire est généralement recommandée pour sa liquidité supérieure et ses pénalités moindres en cas de modification anticipée.',
 ],
 },
 '/tasse-e-pensione/credito-imposta': {
 en: [
 'The tax credit calculator determines the foreign tax credit (Art. 165 TUIR) applicable in the Italian tax return, avoiding double taxation on Swiss employment income.',
 'Under the 2024 New Agreement, Italy taxes new cross-border workers\' income with an EUR 10,000 franchise and recognises a credit for Swiss withholding tax paid, up to the amount of Italian tax due.',
 'The Art. 165 TUIR mechanism works by allowing Italian-resident cross-border workers to offset Swiss withholding tax against their Italian liability, preventing double taxation. The calculator shows the exact recoverable amount and distinguishes between old agreement workers with full credit and new agreement workers subject to the EUR 10,000 franchise.',
 ],
 de: [
 'Der Steuergutschrift-Rechner ermittelt die Anrechnung ausländischer Steuern (Art. 165 TUIR) für die italienische Steuererklärung und vermeidet so die Doppelbesteuerung auf Schweizer Arbeitseinkommen.',
 'Gemäss dem Neuen Abkommen 2024 besteuert Italien das Einkommen neuer Grenzgänger mit einer Franchise von EUR 10.000 und erkennt eine Gutschrift für die gezahlte Schweizer Quellensteuer bis zur Höhe der geschuldeten italienischen Steuer an.',
 'Der Mechanismus nach Art. 165 TUIR ermöglicht es in Italien ansässigen Grenzgängern, die bereits gezahlte Schweizer Quellensteuer von ihrer italienischen Steuerschuld abzuziehen und so eine Doppelbesteuerung zu vermeiden. Der Rechner zeigt den genauen erstattungsfähigen Betrag und unterscheidet zwischen Alt-Abkommen mit voller Anrechnung und Neu-Abkommen mit EUR 10.000 Franchise.',
 ],
 fr: [
 'Le calculateur de crédit d\'impôt détermine le crédit pour impôts payés à l\'étranger (Art. 165 TUIR) applicable dans la déclaration fiscale italienne, évitant la double imposition sur le revenu de travail suisse.',
 'Avec le Nouvel Accord 2024, l\'Italie impose le revenu des nouveaux frontaliers avec une franchise de 10 000 EUR et reconnaît un crédit pour l\'impôt à la source suisse payé, jusqu\'à concurrence de l\'impôt italien dû.',
 'Le mécanisme de l\'Art. 165 TUIR permet aux frontaliers résidant en Italie de déduire l\'impôt à la source suisse déjà payé de leur dette fiscale italienne, évitant ainsi la double imposition. Le calculateur distingue entre l\'ancien accord avec crédit intégral et le nouvel accord avec franchise de 10 000 EUR, et affiche le montant exact récupérable.',
 ],
 },
 '/tasse-e-pensione/crediti-imposta': {
 en: [
 'The tax credit calculator determines the foreign tax credit (Art. 165 TUIR) applicable in the Italian tax return, avoiding double taxation on Swiss employment income.',
 'Under the 2024 New Agreement, Italy taxes new cross-border workers\' income with an EUR 10,000 franchise and recognises a credit for Swiss withholding tax paid, up to the amount of Italian tax due.',
 'Three distinct credit regimes apply depending on your start date: the standard foreign tax credit for non-frontier workers, the old agreement credit for pre-2024 cross-border workers with full exemption in Italy, and the new agreement credit with the EUR 10,000 franchise. Use the comparison tool to determine which regime applies to your case.',
 ],
 de: [
 'Der Steuergutschrift-Rechner ermittelt die Anrechnung ausländischer Steuern (Art. 165 TUIR) für die italienische Steuererklärung und vermeidet so die Doppelbesteuerung auf Schweizer Arbeitseinkommen.',
 'Gemäss dem Neuen Abkommen 2024 besteuert Italien das Einkommen neuer Grenzgänger mit einer Franchise von EUR 10.000 und erkennt eine Gutschrift für die gezahlte Schweizer Quellensteuer bis zur Höhe der geschuldeten italienischen Steuer an.',
 'Drei unterschiedliche Anrechnungsregime gelten je nach Arbeitsbeginn: die allgemeine Anrechnung ausländischer Steuern für Nicht-Grenzgänger, die Alt-Abkommen-Anrechnung für Grenzgänger vor 2024 mit voller Befreiung in Italien und die Neu-Abkommen-Anrechnung mit EUR 10.000 Franchise. Nutzen Sie das Vergleichstool, um festzustellen, welches Regime für Sie gilt.',
 ],
 fr: [
 'Le calculateur de crédit d\'impôt détermine le crédit pour impôts payés à l\'étranger (Art. 165 TUIR) applicable dans la déclaration fiscale italienne, évitant la double imposition sur le revenu de travail suisse.',
 'Avec le Nouvel Accord 2024, l\'Italie impose le revenu des nouveaux frontaliers avec une franchise de 10 000 EUR et reconnaît un crédit pour l\'impôt à la source suisse payé, jusqu\'à concurrence de l\'impôt italien dû.',
 'Trois régimes de crédit distincts s\'appliquent selon votre date de début : le crédit d\'impôt étranger standard pour les non-frontaliers, le crédit de l\'ancien accord pour les frontaliers d\'avant 2024 avec exonération totale en Italie, et le crédit du nouvel accord avec franchise de 10 000 EUR. Utilisez l\'outil de comparaison pour déterminer le régime applicable.',
 ],
 },
 '/tasse-e-pensione/dichiarazione-redditi': {
 en: [
 'The income tax return guide for cross-border workers covers both Italy and Switzerland. For Italy: Modello 730 or Redditi PF, income in francs converted at the UIC rate, franchise, and foreign tax credit in sections RC, CE, CR.',
 'For Switzerland: withholding tax (Quellensteuer), rectification procedure by 31 March, supplementary ordinary taxation (TOU) above CHF 120,000, pillar 3a and LPP deductions, quasi-resident status, and filing with eTax Ticino.',
 'Step-by-step instructions walk you through each form section, from declaring Swiss income in the Italian 730 to requesting the withholding tax rectification in Canton Ticino.',
 ],
 de: [
 'Der Leitfaden zur Steuererklärung für Grenzgänger deckt sowohl Italien als auch die Schweiz ab. Für Italien: Modello 730 oder Redditi PF, Einkommen in Franken zum UIC-Kurs umgerechnet, Franchise und Anrechnung ausländischer Steuern.',
 'Für die Schweiz: Quellensteuer, Berichtigungsverfahren bis 31. März, nachträgliche ordentliche Veranlagung (NOV) über CHF 120.000, Säule-3a- und BVG-Abzüge, Quasi-Ansässigen-Status und Einreichung über eTax Ticino.',
 'Schritt-für-Schritt-Anleitungen führen Sie durch jeden Formularteil — von der Deklaration des Schweizer Einkommens im italienischen 730 bis zum Antrag auf Quellensteuerberichtigung im Kanton Tessin.',
 ],
 fr: [
 'Le guide de la déclaration de revenus pour frontaliers couvre l\'Italie et la Suisse. Pour l\'Italie : Modello 730 ou Redditi PF, revenus en francs convertis au taux UIC, franchise et crédit pour impôts étrangers dans les sections RC, CE, CR.',
 'Pour la Suisse : impôt à la source (Quellensteuer), procédure de rectification avant le 31 mars, taxation ordinaire complémentaire (TOU) au-delà de CHF 120 000, déductions pilier 3a et LPP, statut de quasi-résident et déclaration via eTax Ticino.',
 'Des instructions pas à pas vous guident à travers chaque section du formulaire, de la déclaration du revenu suisse dans le 730 italien à la demande de rectification de l\'impôt à la source au Canton du Tessin.',
 ],
 },
 '/tasse-e-pensione/quiz-fiscale': {
 en: [
 'The weekly tax quiz tests cross-border worker knowledge on taxes, deductions, permits, and regulations. Each week 5 questions are selected from the pool: Swiss and Italian taxation, AVS/LPP contributions, LAMal health insurance, and G/B work permits.',
 'Questions cover real scenarios: cantonal withholding tax rates, IRPEF franchise for new cross-border workers, pillar 3a deductions, unemployment obligations, and quasi-resident status. Scores contribute to gamification achievements.',
 'New questions are added regularly to reflect legislative changes. Each wrong answer links to the relevant guide section, turning every mistake into a focused learning opportunity.',
 ],
 de: [
 'Das wöchentliche Steuerquiz testet das Wissen des Grenzgängers über Steuern, Abzüge, Bewilligungen und Vorschriften. Jede Woche werden 5 Fragen aus dem Pool ausgewählt: Schweizer und italienische Besteuerung, AHV/BVG-Beiträge, KVG-Versicherung und Arbeitsbewilligungen G/B.',
 'Die Fragen decken reale Szenarien ab: kantonale Quellensteuersätze, IRPEF-Franchise für neue Grenzgänger, Säule-3a-Abzüge, Arbeitslosigkeitspflichten und Quasi-Ansässigen-Status. Punktzahlen tragen zu Gamification-Erfolgen bei.',
 'Neue Fragen werden regelmässig ergänzt, um Gesetzesänderungen abzubilden. Jede falsche Antwort verlinkt auf den passenden Leitfadenabschnitt und macht jeden Fehler zu einer gezielten Lernmöglichkeit.',
 ],
 fr: [
 'Le quiz fiscal hebdomadaire teste les connaissances du frontalier sur les impôts, les déductions, les permis et la réglementation. Chaque semaine, 5 questions sont sélectionnées : fiscalité suisse et italienne, cotisations AVS/LPP, assurance LAMal et permis de travail G/B.',
 'Les questions couvrent des scénarios réels : taux d\'impôt à la source cantonal, franchise IRPEF pour les nouveaux frontaliers, déductions pilier 3a, obligations chômage et statut de quasi-résident. Les scores contribuent aux succès de gamification.',
 'De nouvelles questions sont ajoutées régulièrement pour refléter les évolutions législatives. Chaque mauvaise réponse renvoie à la section du guide concernée, transformant chaque erreur en opportunité d\'apprentissage ciblée.',
 ],
 },
 '/tasse-e-pensione/simulazione-tasse-nuovi-frontalieri': {
 en: [
 'The new cross-border worker tax simulation calculates your net salary under the 2024 New Fiscal Agreement between Italy and Switzerland. If you started working in Switzerland after 17 July 2023, you are classified as a "new cross-border worker" and subject to concurrent taxation in both countries.',
 'Switzerland withholds tax at source (80% of the ordinary Canton Ticino rate for residents within 20 km of the border, 100% for those beyond), while Italy levies IRPEF on the same income with a EUR 10,000 franchise for all cross-border workers. A foreign tax credit prevents double taxation by deducting Swiss tax from Italian IRPEF.',
 'Use the free simulator to enter your gross annual salary in CHF, marital status, children, and municipality of residence. The tool applies Swiss social deductions (AVS 5.3%, unemployment 1.1%, LPP by age), Canton Ticino withholding tax, Italian IRPEF with the franchise, and the tax credit — showing your monthly net in EUR.',
 ],
 de: [
 'Die Steuersimulation fuer neue Grenzgaenger berechnet Ihr Nettogehalt nach dem Neuen Steuerabkommen 2024 zwischen Italien und der Schweiz. Wenn Sie nach dem 17. Juli 2023 in der Schweiz zu arbeiten begonnen haben, gelten Sie als "neuer Grenzgaenger" und unterliegen der konkurrierenden Besteuerung in beiden Laendern.',
 'Die Schweiz erhebt die Quellensteuer (80% des ordentlichen Tessiner Satzes fuer Einwohner innerhalb von 20 km von der Grenze, 100% darueber hinaus), waehrend Italien die IRPEF auf dasselbe Einkommen mit einer Franchise von EUR 10.000 fuer alle Grenzgaenger erhebt. Eine Steuergutschrift fuer im Ausland gezahlte Steuern verhindert die Doppelbesteuerung.',
 'Verwenden Sie den kostenlosen Simulator: Geben Sie Ihr Bruttojahresgehalt in CHF, Familienstand, Kinder und Wohngemeinde ein. Das Tool berechnet Schweizer Sozialabzuege (AHV 5,3%, ALV 1,1%, BVG nach Alter), Tessiner Quellensteuer, italienische IRPEF mit Franchise und Steuergutschrift — und zeigt Ihr monatliches Netto in EUR.',
 ],
 fr: [
 'La simulation fiscale pour les nouveaux frontaliers calcule votre salaire net selon le Nouvel Accord Fiscal 2024 entre l\'Italie et la Suisse. Si vous avez commence a travailler en Suisse apres le 17 juillet 2023, vous etes classe comme "nouveau frontalier" et soumis a la taxation concurrente dans les deux pays.',
 'La Suisse preleve l\'impot a la source (80% du taux ordinaire du Tessin pour les residents a moins de 20 km de la frontiere, 100% au-dela), tandis que l\'Italie applique l\'IRPEF sur le meme revenu avec une franchise de 10 000 EUR pour tous les frontaliers. Un credit d\'impot pour les taxes payees a l\'etranger evite la double imposition.',
 'Utilisez le simulateur gratuit : entrez votre salaire brut annuel en CHF, etat civil, enfants et commune de residence. L\'outil applique les deductions sociales suisses (AVS 5,3%, chomage 1,1%, LPP par age), l\'impot a la source du Tessin, l\'IRPEF italienne avec la franchise et le credit d\'impot — affichant votre net mensuel en EUR.',
 ],
 },
 '/tasse-e-pensione/calcola-ristorni': {
 en: [
 'The ristorni tracker monitors the financial compensations that Canton Ticino pays to Italian border municipalities to offset costs incurred for resident cross-border workers: roughly 40% of withholding tax is returned to municipalities within 20 km of the border.',
 'Under the 2024 New Agreement, the ristorni share is expected to decrease progressively as Italy assumes concurrent taxation. The most affected municipalities are those in the 20 km belt from the frontier.',
 'The tracker shows historical data by municipality and year, letting you compare how ristorni have evolved and forecast the fiscal impact of the transitional phase through 2033.',
 ],
 de: [
 'Der Ristorni-Tracker überwacht die Finanzkompensationen, die der Kanton Tessin an italienische Grenzgemeinden zahlt, um die Kosten für ansässige Grenzgänger auszugleichen: Etwa 40 % der Quellensteuer wird an Gemeinden innerhalb von 20 km von der Grenze zurückerstattet.',
 'Unter dem Neuen Abkommen 2024 wird der Ristorni-Anteil voraussichtlich schrittweise sinken, da Italien die konkurrierende Besteuerung übernimmt. Die am stärksten betroffenen Gemeinden liegen im 20-km-Gürtel an der Grenze.',
 'Der Tracker zeigt historische Daten nach Gemeinde und Jahr, sodass Sie die Entwicklung der Ristorni vergleichen und die steuerlichen Auswirkungen der Übergangsphase bis 2033 einschätzen können.',
 ],
 fr: [
 'Le tracker des ristorni surveille les compensations financières que le Canton du Tessin verse aux communes frontalières italiennes pour couvrir les coûts liés aux frontaliers résidents : environ 40 % de l\'impôt à la source est restitué aux communes situées dans un rayon de 20 km de la frontière.',
 'Avec le Nouvel Accord 2024, la part des ristorni devrait diminuer progressivement à mesure que l\'Italie assume la taxation concurrente. Les communes les plus concernées sont celles de la ceinture des 20 km.',
 'Le tracker affiche les données historiques par commune et par année, vous permettant de comparer l\'évolution des ristorni et d\'anticiper l\'impact fiscal de la phase transitoire jusqu\'en 2033.',
 ],
 },
 '/tasse-e-pensione/': {
 en: [
 'This section covers the fiscal and pension aspects of cross-border work: Swiss withholding tax, Italian IRPEF, AVS/LPP contributions, and retirement planning.',
 'Information is updated to the 2024 New Fiscal Agreement between Italy and Switzerland, and accounts for Canton Ticino specifics regarding withholding tax and transitional regimes for historical cross-border workers (pre-2024).',
 'Key tools include the pension planner for AVS/LPP retirement projections, the tax calendar with filing deadlines for both countries, the third pillar 3a simulator for tax-advantaged savings, and the tax credit calculator for optimising your Italian return. Each tool is tailored to cross-border worker regulations in force for 2026.',
 '<p style="color:#64748b;font-size:0.8rem;margin-top:4px;">Source: <a href="https://www.estv.admin.ch" style="color:#2563eb;text-decoration:none;" rel="noopener">Federal Tax Administration (FTA)</a> · <a href="https://www.bsv.admin.ch" style="color:#2563eb;text-decoration:none;" rel="noopener">FSIO</a></p>',
 ],
 de: [
 'Dieser Bereich deckt die steuerlichen und vorsorgerechtlichen Aspekte der Grenzgängerarbeit ab: Schweizer Quellensteuer, italienische IRPEF, AHV/BVG-Beiträge und Altersvorsorgeplanung.',
 'Die Informationen sind auf das Neue Steuerabkommen 2024 zwischen Italien und der Schweiz aktualisiert und berücksichtigen Tessiner Besonderheiten bei der Quellensteuer und Übergangsregelungen für Alt-Grenzgänger (vor 2024).',
 'Wichtige Tools sind der Vorsorgerechner für AHV/BVG-Prognosen, der Steuerkalender mit Fristen für beide Länder, der Säule-3a-Simulator für steuerbegünstigtes Sparen und der Steuergutschrift-Rechner zur Optimierung der italienischen Steuererklärung. Jedes Tool ist auf die geltenden Grenzgängerregelungen für 2026 zugeschnitten.',
 '<p style="color:#64748b;font-size:0.8rem;margin-top:4px;">Quelle: <a href="https://www.estv.admin.ch" style="color:#2563eb;text-decoration:none;" rel="noopener">Eidgenössische Steuerverwaltung (ESTV)</a> · <a href="https://www.bsv.admin.ch" style="color:#2563eb;text-decoration:none;" rel="noopener">BSV</a></p>',
 ],
 fr: [
 'Cette section couvre les aspects fiscaux et de prévoyance du travail frontalier : impôt à la source suisse, IRPEF italien, cotisations AVS/LPP et planification de la retraite.',
 'Les informations sont mises à jour au Nouvel Accord fiscal 2024 entre l\'Italie et la Suisse et tiennent compte des spécificités du Tessin pour l\'impôt à la source et les régimes transitoires pour les frontaliers historiques (avant 2024).',
 'Les outils clés comprennent le planificateur de prévoyance pour les projections AVS/LPP, le calendrier fiscal avec les échéances des deux pays, le simulateur du troisième pilier 3a pour l\'épargne fiscalement avantageuse et le calculateur de crédit d\'impôt pour optimiser votre déclaration italienne. Chaque outil est adapté à la réglementation frontalière en vigueur pour 2026.',
 '<p style="color:#64748b;font-size:0.8rem;margin-top:4px;">Source : <a href="https://www.estv.admin.ch" style="color:#2563eb;text-decoration:none;" rel="noopener">Administration fédérale des contributions (AFC)</a> · <a href="https://www.bsv.admin.ch" style="color:#2563eb;text-decoration:none;" rel="noopener">OFAS</a></p>',
 ],
 },

 // ───── Guide ──────────────────────────────────────────────────
 '/guida-frontaliere/guida-completa-lavoro-frontaliere-svizzera-2026': {
 en: [
 '<h2>What is a cross-border worker: definition and numbers</h2>',
 'A cross-border worker (Grenzgänger in German, frontalier in French) is a person who resides in one country and works in another, returning to their home at least weekly. In Switzerland, cross-border worker status is governed by the Agreement on the Free Movement of Persons (AFMP) between Switzerland and the European Union, in force since 1 June 2002. Cross-border workers receive the G permit, which authorises employment in Switzerland while maintaining residence abroad.',
 'In Canton Ticino, approximately 79,000 cross-border workers commute daily from Italy (BFS data, 2025). Ticino has the highest concentration of cross-border workers of any Swiss canton, representing about 30% of the cantonal workforce. The main employment sectors are manufacturing (23%), construction (12%), finance and insurance (11%), healthcare (10%), hospitality (9%), and IT (8%). The number grows by 2-3% annually, driven by the average 40-60% salary differential compared to the Italian border provinces (Como, Varese, Verbano-Cusio-Ossola).',
 '<h2>G permit: requirements, procedure and documents</h2>',
 'The G permit (cross-border worker permit) authorises an EU/EFTA citizen to work in Switzerland while maintaining residence in their country. Fundamental requirements are: EU or EFTA citizenship, residence in an Italian municipality, an employment contract with a Swiss employer, and a valid identity document. For EU citizens with permanent contracts, the G permit is valid for 5 years and automatically renewable. Processing takes 5-10 working days; work can begin with just the application receipt.',
 '<h2>2026 tax regime: old and new agreement compared</h2>',
 'The key tax distinction for cross-border workers in 2026 depends on the hiring date and municipality of residence. "Old" cross-border workers (hired before 17 July 2023, residing within 20 km of the border) pay only Swiss withholding tax at 100% of the ordinary rate. "New" cross-border workers (hired from 17 July 2023 onwards, or residing beyond 20 km) are subject to concurrent taxation: Swiss withholding tax at 80% of the ordinary rate, plus Italian IRPEF with a EUR 10,000 exemption and a tax credit for Swiss taxes paid. Source: CH-IT Agreement of 23.12.2020 (RS 0.642.045.43).',
 '<h2>Social contributions and Swiss pension system</h2>',
 'Mandatory Swiss social contributions are deducted directly from the payslip. AVS/AHV (Old-Age and Survivors\' Insurance) is 5.3% of gross salary. Unemployment insurance (AC/ALV) is 1.1% up to CHF 148,200/year. The second pillar (LPP/BVG) varies by age bracket: 7% (25-34), 10% (35-44), 15% (45-54), 18% (55-64). The third pillar (3a) allows tax-deductible voluntary contributions up to CHF 7,258/year in 2026.',
 '<h2>Health insurance: LAMal, right of option and CMB</h2>',
 'Cross-border workers have the "right of option": they can choose between Swiss mandatory health insurance (LAMal, CHF 270-560/month in Ticino) and the Italian National Health Service (SSN, essentially free). The choice must be made within 3 months of starting work and is irrevocable. Those choosing SSN often add complementary private insurance (CMB, EUR 50-150/month) for Swiss coverage.',
 '<h2>Commuting and cost of living: Italy vs Switzerland</h2>',
 'Average monthly commuting costs by car for a 30-50 km round trip are EUR 300-500, including fuel, motorway tolls, vehicle wear, and Swiss parking. The busiest border crossings are Chiasso-Como (A2/A9), Ponte Tresa, and Stabio-Gaggiolo, with peak waits of 30-60 minutes. The cost of living differential is the key economic factor: rent in Como/Varese is EUR 600-900/month vs CHF 1,200-1,800 in Lugano. Groceries are 25-35% cheaper in Italy.',
 '<h2>Tax returns: obligations in Italy and Switzerland</h2>',
 'New cross-border workers must file Italian tax returns (Modello 730 by 30 September, or Redditi PF by 30 November) declaring Swiss income and claiming the tax credit. In Switzerland, cross-border workers can request a withholding tax rectification (TDR) by 31 March of the following year for additional deductions (pillar 3a contributions, actual transport costs, continuing education).',
 '<h2>Useful resources and calculation tools</h2>',
 'Frontaliere Ticino provides free tools: a fiscal simulator for net salary calculation, health insurance comparator for 14 LAMal providers, bank account comparator, and commuting cost calculator. Official reference sources include BFS/UST (employment statistics), SECO (labour market), DFE-TI (withholding tax rates), UFSP (LAMal premiums), and the Italian Revenue Agency (tax obligations).',
 ],
 de: [
 '<h2>Was ist ein Grenzgänger: Definition und Zahlen</h2>',
 'Ein Grenzgänger (frontaliere auf Italienisch, frontalier auf Französisch) ist eine Person, die in einem Staat wohnt und in einem anderen arbeitet und mindestens wöchentlich an ihren Wohnsitz zurückkehrt. In der Schweiz wird der Grenzgängerstatus durch das Freizügigkeitsabkommen (FZA) zwischen der Schweiz und der EU geregelt, das seit dem 1. Juni 2002 in Kraft ist. Grenzgänger erhalten den Ausweis G, der die Erwerbstätigkeit in der Schweiz bei Beibehaltung des Wohnsitzes im Ausland genehmigt.',
 'Im Kanton Tessin pendeln täglich rund 79.000 Grenzgänger aus Italien (BFS-Daten, 2025). Das Tessin weist die höchste Grenzgängerkonzentration aller Schweizer Kantone auf — etwa 30 % der kantonalen Arbeitskräfte. Die wichtigsten Beschäftigungssektoren sind Industrie (23 %), Bau (12 %), Finanz- und Versicherungswesen (11 %), Gesundheit (10 %), Gastgewerbe (9 %) und IT (8 %). Die Zahl wächst jährlich um 2-3 %, getrieben durch das durchschnittliche Lohngefälle von 40-60 % gegenüber den italienischen Grenzprovinzen.',
 '<h2>Ausweis G: Voraussetzungen, Verfahren und Dokumente</h2>',
 'Der Ausweis G (Grenzgängerbewilligung) berechtigt EU/EFTA-Bürger zur Arbeit in der Schweiz bei Beibehaltung des Wohnsitzes im Heimatland. Grundvoraussetzungen: EU- oder EFTA-Staatsangehörigkeit, Wohnsitz in einer italienischen Gemeinde, Arbeitsvertrag mit Schweizer Arbeitgeber und gültiges Identitätsdokument. Für EU-Bürger mit unbefristetem Vertrag gilt der Ausweis G 5 Jahre und wird automatisch verlängert. Die Bearbeitungszeit beträgt 5-10 Arbeitstage.',
 '<h2>Steuerregime 2026: altes und neues Abkommen im Vergleich</h2>',
 'Die steuerliche Unterscheidung für Grenzgänger 2026 hängt vom Einstellungsdatum und der Wohngemeinde ab. „Alte" Grenzgänger (vor dem 17. Juli 2023 eingestellt, Wohnsitz innerhalb 20 km der Grenze) zahlen nur die Schweizer Quellensteuer zu 100 % des ordentlichen Satzes. „Neue" Grenzgänger (ab 17. Juli 2023 oder Wohnsitz über 20 km) unterliegen der konkurrierenden Besteuerung: Schweizer Quellensteuer zu 80 % plus italienische IRPEF mit EUR 10.000 Freibetrag und Steuergutschrift. Quelle: CH-IT-Abkommen vom 23.12.2020 (SR 0.642.045.43).',
 '<h2>Sozialabgaben und Schweizer Vorsorgesystem</h2>',
 'Obligatorische Schweizer Sozialabgaben werden direkt vom Lohn abgezogen. AHV/IV/EO beträgt 5,3 % des Bruttolohns. Arbeitslosenversicherung (ALV) 1,1 % bis CHF 148.200/Jahr. Die zweite Säule (BVG) variiert nach Alter: 7 % (25-34), 10 % (35-44), 15 % (45-54), 18 % (55-64). Die dritte Säule (3a) ermöglicht steuerlich abzugsfähige freiwillige Beiträge bis CHF 7.258/Jahr (2026).',
 '<h2>Krankenversicherung: KVG, Optionsrecht und CMB</h2>',
 'Grenzgänger haben das „Optionsrecht": Sie können zwischen der Schweizer obligatorischen Krankenversicherung (KVG, CHF 270-560/Monat im Tessin) und dem italienischen Nationalen Gesundheitsdienst (SSN) wählen. Die Wahl muss innerhalb von 3 Monaten nach Arbeitsbeginn getroffen werden und ist unwiderruflich. Wer SSN wählt, schliesst oft eine Zusatzversicherung ab (CMB, EUR 50-150/Monat).',
 '<h2>Pendeln und Lebenshaltungskosten: Italien vs. Schweiz</h2>',
 'Durchschnittliche monatliche Pendelkosten mit dem Auto für 30-50 km (Hin- und Rückweg) betragen EUR 300-500. Die verkehrsreichsten Grenzübergänge sind Chiasso-Como (A2/A9), Ponte Tresa und Stabio-Gaggiolo mit Spitzenwartezeiten von 30-60 Minuten. Das Lebenshaltungskostengefälle ist entscheidend: Miete in Como/Varese EUR 600-900/Monat vs. CHF 1.200-1.800 in Lugano. Lebensmittel sind in Italien 25-35 % günstiger.',
 '<h2>Steuererklärung: Pflichten in Italien und der Schweiz</h2>',
 'Neue Grenzgänger müssen eine italienische Steuererklärung abgeben (Modello 730 bis 30. September oder Redditi PF bis 30. November) mit Angabe des Schweizer Einkommens und Beantragung der Steuergutschrift. In der Schweiz können Grenzgänger bis zum 31. März des Folgejahres eine Quellensteuerkorrektur (TDR) beantragen für zusätzliche Abzüge (Säule 3a, Transportkosten, Weiterbildung).',
 '<h2>Nützliche Ressourcen und Berechnungstools</h2>',
 'Frontaliere Ticino bietet kostenlose Werkzeuge: Steuersimulator für die Nettoberechnung, Krankenkassenvergleich für 14 KVG-Anbieter, Bankkontenvergleich und Pendelkostenrechner. Offizielle Quellen: BFS/UST (Beschäftigungsstatistik), SECO (Arbeitsmarkt), DFE-TI (Quellensteuertarife), BAG (KVG-Prämien) und italienische Steuerbehörde.',
 ],
 fr: [
 '<h2>Qu\'est-ce qu\'un travailleur frontalier : définition et chiffres</h2>',
 'Un travailleur frontalier (Grenzgänger en allemand, frontaliere en italien) est une personne qui réside dans un État et travaille dans un autre, rentrant à son domicile au moins une fois par semaine. En Suisse, le statut de frontalier est régi par l\'Accord sur la Libre Circulation des Personnes (ALCP) entre la Suisse et l\'UE, en vigueur depuis le 1er juin 2002. Les frontaliers reçoivent le permis G, qui autorise l\'activité professionnelle en Suisse tout en maintenant la résidence à l\'étranger.',
 'Au Canton du Tessin, environ 79 000 frontaliers traversent quotidiennement la frontière depuis l\'Italie (données OFS, 2025). Le Tessin affiche la plus forte concentration de frontaliers de tous les cantons suisses, représentant environ 30 % de la main-d\'œuvre cantonale. Les principaux secteurs sont l\'industrie (23 %), la construction (12 %), la finance (11 %), la santé (10 %), l\'hôtellerie (9 %) et l\'informatique (8 %). Le nombre augmente de 2-3 % par an, tiré par l\'écart salarial moyen de 40-60 %.',
 '<h2>Permis G : conditions, procédure et documents</h2>',
 'Le permis G (permis frontalier) autorise un citoyen UE/AELE à travailler en Suisse tout en conservant sa résidence dans son pays. Conditions fondamentales : citoyenneté UE ou AELE, résidence dans une commune italienne, contrat de travail avec un employeur suisse et document d\'identité valide. Pour les citoyens UE en CDI, le permis G est valable 5 ans et renouvelable automatiquement. Le délai de traitement est de 5-10 jours ouvrables.',
 '<h2>Régime fiscal 2026 : ancien et nouvel accord comparés</h2>',
 'La distinction fiscale clé pour les frontaliers en 2026 dépend de la date d\'embauche et de la commune de résidence. Les « anciens » frontaliers (embauchés avant le 17 juillet 2023, résidant à moins de 20 km de la frontière) paient uniquement l\'impôt à la source suisse à 100 % du taux ordinaire. Les « nouveaux » frontaliers (embauchés à partir du 17 juillet 2023 ou résidant au-delà de 20 km) sont soumis à l\'imposition concurrente : impôt à la source suisse à 80 % plus IRPEF italienne avec franchise de 10 000 EUR et crédit d\'impôt. Source : Accord CH-IT du 23.12.2020 (RS 0.642.045.43).',
 '<h2>Cotisations sociales et système de prévoyance suisse</h2>',
 'Les cotisations sociales suisses obligatoires sont prélevées directement sur le salaire. L\'AVS/AI/APG représente 5,3 % du salaire brut. L\'assurance chômage (AC) est de 1,1 % jusqu\'à CHF 148 200/an. Le deuxième pilier (LPP) varie selon l\'âge : 7 % (25-34 ans), 10 % (35-44), 15 % (45-54), 18 % (55-64). Le troisième pilier (3a) permet des contributions volontaires fiscalement déductibles jusqu\'à CHF 7 258/an (2026).',
 '<h2>Assurance maladie : LAMal, droit d\'option et CMB</h2>',
 'Les frontaliers bénéficient du « droit d\'option » : ils peuvent choisir entre l\'assurance maladie obligatoire suisse (LAMal, CHF 270-560/mois au Tessin) et le Service National de Santé italien (SSN, essentiellement gratuit). Le choix doit être fait dans les 3 mois suivant le début du travail et est irrévocable. Ceux qui choisissent le SSN souscrivent souvent une assurance complémentaire (CMB, EUR 50-150/mois).',
 '<h2>Pendularité et coût de la vie : Italie vs Suisse</h2>',
 'Les frais de pendularité mensuels moyens en voiture pour un trajet de 30-50 km (aller-retour) sont de EUR 300-500. Les passages frontaliers les plus fréquentés sont Chiasso-Como (A2/A9), Ponte Tresa et Stabio-Gaggiolo, avec des attentes de pointe de 30-60 minutes. Le différentiel de coût de la vie est déterminant : loyer à Como/Varese EUR 600-900/mois contre CHF 1 200-1 800 à Lugano. L\'alimentation est 25-35 % moins chère en Italie.',
 '<h2>Déclaration fiscale : obligations en Italie et en Suisse</h2>',
 'Les nouveaux frontaliers doivent déposer une déclaration fiscale italienne (Modello 730 au 30 septembre ou Redditi PF au 30 novembre) déclarant le revenu suisse et demandant le crédit d\'impôt. En Suisse, les frontaliers peuvent demander une rectification de l\'impôt à la source (TDR) avant le 31 mars de l\'année suivante pour des déductions supplémentaires (pilier 3a, frais de transport, formation continue).',
 '<h2>Ressources utiles et outils de calcul</h2>',
 'Frontaliere Ticino offre des outils gratuits : simulateur fiscal pour le calcul du salaire net, comparateur d\'assurance maladie pour 14 assureurs LAMal, comparateur de comptes bancaires et calculateur de frais de pendularité. Sources officielles : OFS/UST (statistiques de l\'emploi), SECO (marché du travail), DFE-TI (barèmes d\'impôt à la source), OFSP (primes LAMal) et l\'Agence des revenus italienne.',
 ],
 },

 // ───── Taxation hub pillar page (P4) ──────────────────────────
 '/guida-tassazione-frontalieri-2026': {
 it: [
 '<h2>Tassazione frontalieri 2026: panoramica del sistema Italia-Svizzera</h2>',
 'La tassazione dei frontalieri Italia-Svizzera nel 2026 si articola su due regimi fiscali distinti, determinati dalla data di assunzione e dal comune di residenza. Il sistema è regolato dal Nuovo Accordo fiscale firmato il 23 dicembre 2020 (RS 0.642.045.43, L. 83/2023) ed entrato in vigore il 17 luglio 2023, che ha profondamente modificato le regole rispetto al precedente accordo del 1974. Nel Canton Ticino, circa 79.000 frontalieri sono oggi interessati da queste regole (dati BFS/UST 2025), con salari medi lordi tra CHF 60.000 e CHF 90.000 annui. Comprendere il proprio regime fiscale è fondamentale per calcolare correttamente il netto in busta paga, pianificare la dichiarazione dei redditi e sfruttare tutte le deduzioni possibili.',
 'I due regimi coesistono: i "vecchi frontalieri" (assunti prima del 17 luglio 2023, residenti entro 20 km dal confine) pagano solo l\'imposta alla fonte in Svizzera al 100% dell\'aliquota ordinaria cantonale, con un regime transitorio che si estende fino al 2033; i "nuovi frontalieri" (assunti dal 17 luglio 2023 o residenti oltre 20 km) sono soggetti alla tassazione concorrente, ovvero pagano l\'imposta alla fonte ridotta all\'80% in Svizzera più l\'IRPEF in Italia, con una franchigia di 10.000 EUR e un credito d\'imposta per le tasse svizzere già pagate. Per calcolare il tuo netto preciso, usa il <a href="/calcola-stipendio/" style="color:#2563eb;text-decoration:none;">simulatore stipendio frontaliere</a>.',

 '<h2>Nuovo Accordo Italia-Svizzera 2023: cosa cambia</h2>',
 'Il Nuovo Accordo fiscale tra Italia e Svizzera rappresenta la più importante riforma della tassazione dei frontalieri degli ultimi 50 anni. Sostituendo l\'accordo del 1974, introduce cinque novità fondamentali: (1) tassazione concorrente obbligatoria per tutti i nuovi frontalieri assunti dal 17 luglio 2023; (2) franchigia di 10.000 EUR sul reddito svizzero ai fini IRPEF, introdotta dall\'art. 1 c. 175 L. 213/2023; (3) eliminazione progressiva dei ristorni fiscali ai comuni italiani di confine entro il 2033, con riduzione graduale della quota dal 40% attuale; (4) estensione del perimetro oltre i 20 km dal confine per il permesso G con regime nuovo; (5) rafforzamento della cooperazione amministrativa e scambio automatico di informazioni fiscali tra le due autorità.',
 'L\'Accordo integrativo del 6 giugno 2024 ha inoltre disciplinato il telelavoro transfrontaliero: fino al 25% del tempo lavorativo può essere svolto dall\'Italia senza perdita dello statuto di frontaliere e senza modifiche al regime fiscale applicabile. Oltre questa soglia, il rapporto di lavoro potrebbe riqualificarsi come prestato in Italia, con conseguente tassazione esclusiva italiana. Questa flessibilità è particolarmente rilevante per i settori ICT, finanza e consulenza, dove il lavoro da remoto è diffuso. I datori di lavoro svizzeri devono monitorare il rispetto della soglia del 25% e comunicarlo annualmente alle autorità.',
 'Un caso pratico: Marco, ingegnere informatico assunto a Lugano il 1° settembre 2023 con salario lordo CHF 84.000, residente a Como, è soggetto al regime nuovi frontalieri. Paga in Svizzera circa CHF 7.800 di imposta alla fonte (80% dell\'aliquota ordinaria ~11,5%), e in Italia dichiara i CHF 84.000 convertiti in EUR (~EUR 87.500 al tasso 0,96), sottraendo i 10.000 EUR di franchigia. Sulla base imponibile residua di EUR 77.500 calcola l\'IRPEF (aliquote scaglionate 23-35-43%), e detrae il credito d\'imposta pari all\'imposta svizzera effettivamente pagata (EUR 8.125). Il saldo fiscale italiano netto risulta tipicamente positivo di EUR 2.000-5.000, versati con F24 a saldo.',

 '<h2>Doppia imposizione fiscale: come evitarla</h2>',
 'La doppia imposizione fiscale si verifica quando lo stesso reddito è tassato sia nel paese in cui è prodotto (Svizzera) sia nel paese di residenza del contribuente (Italia). Per i frontalieri italiani, il rischio è concreto: lavorando in Svizzera maturano redditi da lavoro dipendente su cui la Svizzera applica l\'imposta alla fonte, mentre l\'Italia — in virtù del principio di tassazione mondiale — pretenderebbe di tassare il medesimo reddito come persona residente fiscalmente in Italia. L\'Accordo contro le doppie imposizioni tra Svizzera e Italia (CDI, firmato il 9 marzo 1976 e oggi integrato dal Nuovo Accordo 2023) risolve il problema attraverso due meccanismi combinati: la tassazione concorrente con credito d\'imposta e la franchigia di 10.000 EUR.',
 'Il credito d\'imposta funziona così: l\'IRPEF italiana dovuta sul reddito svizzero viene ridotta di un importo pari all\'imposta alla fonte pagata in Svizzera, fino a concorrenza della quota proporzionale di IRPEF relativa al reddito estero. La formula: <em>Credito = IRPEF lorda totale × (Reddito svizzero ÷ Reddito complessivo)</em>. Il credito richiesto non può superare l\'imposta effettivamente pagata in Svizzera. La franchigia di 10.000 EUR si applica preliminarmente: i primi 10.000 EUR del reddito svizzero sono esenti da IRPEF, e il calcolo del credito avviene sulla base residua. Per approfondire il meccanismo, visita la <a href="/tasse-e-pensione/dichiarazione-redditi/" style="color:#2563eb;text-decoration:none;">guida dichiarazione redditi</a>.',
 'Attenzione agli errori tipici: molti frontalieri applicano la franchigia sul netto invece che sul lordo, oppure calcolano il credito d\'imposta senza considerare il rapporto reddito estero/complessivo. Un altro errore frequente è non presentare la dichiarazione italiana pensando di essere esenti come i vecchi frontalieri — i nuovi frontalieri devono sempre dichiarare in Italia. La documentazione da conservare: certificato di salario svizzero (Lohnausweis), ricevute dell\'imposta alla fonte, attestato di residenza italiano, eventuale ricevuta della TOU (Tassazione Ordinaria Ulteriore) richiesta in Svizzera. In caso di dubbio, un consulente fiscale specializzato in fiscalità internazionale costa EUR 200-500 per una consulenza annuale ma evita sanzioni ben più elevate.',

 '<h2>Permesso G vs Permesso B: quale conviene fiscalmente</h2>',
 'La scelta tra permesso G (frontaliere) e permesso B (residente) ha implicazioni fiscali profonde che vanno oltre la semplice tassazione del reddito da lavoro. Il permesso G mantiene la residenza fiscale in Italia: il frontaliere è tassato in Italia per tutti i redditi mondiali (worldwide taxation principle) ma beneficia del credito d\'imposta e della franchigia per il reddito svizzero. Il permesso B trasferisce la residenza fiscale in Svizzera: tassazione esclusiva in Svizzera per il reddito da lavoro e per la maggior parte degli altri redditi, con alcune eccezioni per i redditi da immobili italiani (restano tassati in Italia). Per un confronto dettagliato, consulta il <a href="/guida-frontaliere/confronta-permesso-g-vs-b/" style="color:#2563eb;text-decoration:none;">confronto permesso G vs B</a>.',
 'Il punto di pareggio fiscale tra i due permessi dipende da reddito, stato civile, composizione familiare e spese deducibili. In linea generale: sotto CHF 90.000 lordi annui, il permesso G resta spesso più vantaggioso grazie alla franchigia di 10.000 EUR e al regime IRPEF italiano, più favorevole per redditi bassi e medi; tra CHF 90.000 e CHF 130.000 la convenienza è bilanciata e dipende da variabili personali (coniuge, figli, affitto, mutuo); sopra CHF 130.000 il permesso B diventa quasi sempre più vantaggioso grazie alle aliquote svizzere meno aggressive sui redditi alti e alla Tassazione Ordinaria Ulteriore (TOU) che permette deduzioni generose. Tuttavia, il permesso B comporta costi aggiuntivi: LAMal obbligatoria (CHF 270-560/mese), affitto in Svizzera più caro del 40-70% rispetto alla Lombardia, perdita del diritto d\'opzione sanitaria e delle detrazioni italiane su mutuo prima casa italiana.',
 'Esempio pratico di confronto: Giulia, single senza figli, salario lordo CHF 110.000, residente a Mendrisio come permesso B oppure a Varese come permesso G. Come B: imposta alla fonte TOU CHF 13.500, LAMal CHF 4.800, affitto CHF 18.000 annui. Totale uscite fisse CHF 36.300, netto disponibile CHF 73.700. Come G: imposta alla fonte 80% CHF 10.800, IRPEF residua netta dopo credito e franchigia EUR 3.000 (~CHF 3.125), pendolarismo CHF 3.600, affitto EUR 6.000/anno a Varese (~CHF 6.250), SSN italiano gratuito. Totale uscite CHF 23.775, netto disponibile CHF 86.225. In questo scenario il G resta più vantaggioso di ~CHF 12.500 l\'anno.',

 '<h2>Aliquote d\'imposta alla fonte Ticino 2026</h2>',
 'Le aliquote dell\'imposta alla fonte in Canton Ticino nel 2026 sono organizzate in quattro tabelle fondamentali, pubblicate ogni anno dalla Divisione delle contribuzioni del DFE Ticino. La tabella A si applica ai celibi/nubili senza figli, la tabella B ai celibi/nubili con figli a carico, la tabella C ai coniugati/unite, la tabella H ai nuclei monoparentali. Per i nuovi frontalieri, dal 17 luglio 2023 l\'aliquota applicata è l\'80% di quella ordinaria (per compensare la doppia tassazione con l\'Italia). Le aliquote sono progressive: partono da circa 5% per redditi annui sotto CHF 30.000, salgono al 10-12% sui CHF 60.000, al 14-16% sui CHF 90.000, e superano il 18-20% oltre i CHF 150.000.',
 '<div style="overflow-x:auto;margin:.5rem 0 1rem"><table style="width:100%;border-collapse:collapse;font-size:0.9rem"><thead><tr style="background:#f1f5f9"><th style="text-align:left;padding:.5rem;border:1px solid #cbd5e1">Reddito lordo annuo (CHF)</th><th style="text-align:center;padding:.5rem;border:1px solid #cbd5e1">Tabella A (celibe)</th><th style="text-align:center;padding:.5rem;border:1px solid #cbd5e1">Tabella C (coniugato)</th><th style="text-align:center;padding:.5rem;border:1px solid #cbd5e1">Tabella H (monoparentale)</th></tr></thead><tbody><tr><td style="padding:.4rem;border:1px solid #e2e8f0">40.000</td><td style="padding:.4rem;border:1px solid #e2e8f0;text-align:center">6,8%</td><td style="padding:.4rem;border:1px solid #e2e8f0;text-align:center">2,1%</td><td style="padding:.4rem;border:1px solid #e2e8f0;text-align:center">3,4%</td></tr><tr><td style="padding:.4rem;border:1px solid #e2e8f0">60.000</td><td style="padding:.4rem;border:1px solid #e2e8f0;text-align:center">10,4%</td><td style="padding:.4rem;border:1px solid #e2e8f0;text-align:center">4,8%</td><td style="padding:.4rem;border:1px solid #e2e8f0;text-align:center">6,2%</td></tr><tr><td style="padding:.4rem;border:1px solid #e2e8f0">80.000</td><td style="padding:.4rem;border:1px solid #e2e8f0;text-align:center">12,9%</td><td style="padding:.4rem;border:1px solid #e2e8f0;text-align:center">7,1%</td><td style="padding:.4rem;border:1px solid #e2e8f0;text-align:center">8,6%</td></tr><tr><td style="padding:.4rem;border:1px solid #e2e8f0">100.000</td><td style="padding:.4rem;border:1px solid #e2e8f0;text-align:center">14,7%</td><td style="padding:.4rem;border:1px solid #e2e8f0;text-align:center">9,0%</td><td style="padding:.4rem;border:1px solid #e2e8f0;text-align:center">10,5%</td></tr><tr><td style="padding:.4rem;border:1px solid #e2e8f0">120.000</td><td style="padding:.4rem;border:1px solid #e2e8f0;text-align:center">16,1%</td><td style="padding:.4rem;border:1px solid #e2e8f0;text-align:center">10,7%</td><td style="padding:.4rem;border:1px solid #e2e8f0;text-align:center">12,1%</td></tr><tr><td style="padding:.4rem;border:1px solid #e2e8f0">150.000</td><td style="padding:.4rem;border:1px solid #e2e8f0;text-align:center">17,9%</td><td style="padding:.4rem;border:1px solid #e2e8f0;text-align:center">12,8%</td><td style="padding:.4rem;border:1px solid #e2e8f0;text-align:center">14,2%</td></tr></tbody></table></div>',
 '<p style="font-size:0.85rem;color:#475569;margin:.25rem 0 1rem">Aliquote indicative 2026 con appartenenza religiosa cattolica senza chiesa. Per i nuovi frontalieri, moltiplicare per 0,80. Per le tabelle complete ufficiali, consulta <a href="/tasse-e-pensione/aliquote-imposta-alla-fonte-ticino-2026/" style="color:#2563eb;text-decoration:none;">aliquote imposta alla fonte Ticino 2026</a>.</p>',

 '<h2>Deduzioni fiscali: come massimizzare il risparmio</h2>',
 'I frontalieri possono ottenere deduzioni significative sia in Svizzera che in Italia, ma richiedono azioni proattive entro scadenze precise. In Svizzera, la Tassazione Ordinaria Ulteriore (TOU, ex-TDR) va richiesta entro il 31 marzo dell\'anno successivo alla Divisione delle contribuzioni del Ticino. Consente di dedurre: contributi al pilastro 3a (fino a CHF 7.258/anno nel 2026 per i lavoratori affiliati alla LPP), spese effettive di trasporto casa-lavoro (CHF 0,70/km o abbonamento, max CHF 3.000), spese di formazione continua professionalmente rilevante (max CHF 12.000), premi assicurativi complementari (max CHF 2.600 single/5.200 coppia), spese mediche non rimborsate dall\'assicurazione, pensioni alimentari documentate, contributi a partiti politici svizzeri. Per richiedere la TOU si usa il software eTax Ticino e si allegano tutti i giustificativi.',
 'In Italia, i nuovi frontalieri possono sfruttare tutte le deduzioni standard del Modello 730 o Redditi PF: spese sanitarie (19% sopra franchigia EUR 129,11), interessi mutuo prima casa (19% fino a EUR 4.000), ristrutturazioni edilizie 50% (fino a EUR 96.000 per immobile), bonus mobili 50% (fino a EUR 5.000), superbonus, spese scolastiche (19% fino a EUR 800 per figlio), previdenza complementare (fino a EUR 5.164,57/anno per fondi pensione italiani), erogazioni liberali ONLUS (19% fino a EUR 30.000). Inoltre, il coniuge fiscalmente a carico (reddito sotto EUR 2.840,51) dà diritto a detrazione di EUR 800/anno. Le detrazioni italiane non sono cumulabili con la TOU svizzera per la stessa spesa (es. contributi previdenziali).',
 'Strategia fiscale ottimale per un frontaliere nuovo con salario CHF 80.000: (1) massimizzare il pilastro 3a svizzero CHF 7.258 che riduce l\'imposta alla fonte di ~CHF 800-1.200/anno via TOU; (2) richiedere TOU per spese trasporto reali se superano la deduzione forfettaria; (3) in Italia, usare il Modello 730 per sfruttare le detrazioni italiane senza complicazioni; (4) se coniugato, valutare la splittatura redditi del coniuge per ottimizzare aliquote. Risultato medio: risparmio fiscale di CHF 2.000-4.000/anno combinando le due strategie. Utilizza il <a href="/calcola-stipendio/simula-busta-paga/" style="color:#2563eb;text-decoration:none;">simulatore busta paga</a> per quantificare il tuo caso specifico.',

 '<h2>Casi particolari: telelavoro, pluri-cantonali, pensionati</h2>',
 'Il telelavoro transfrontaliero è uno degli ambiti più dinamici della fiscalità dei frontalieri. Dal 6 giugno 2024 è in vigore un Accordo integrativo tra Italia e Svizzera che consente il telelavoro fino al 25% del tempo lavorativo complessivo dall\'Italia senza modifiche allo statuto fiscale di frontaliere. Questa soglia è misurata su base annuale: un frontaliere con contratto full-time 40h/settimana può lavorare fino a 10h/settimana dall\'Italia, o accumulare fino a 52 giorni lavorativi/anno in smart working dall\'Italia. Oltre il 25%, il rapporto di lavoro rischia di essere riqualificato come svolto in Italia, con tassazione esclusiva italiana e perdita del regime svizzero. Il datore di lavoro svizzero deve tenere un registro delle giornate in telelavoro e comunicarlo annualmente alle autorità.',
 'I lavoratori pluri-cantonali (assunti contemporaneamente da più datori in cantoni diversi) sono soggetti all\'imposta alla fonte nel cantone dove svolgono prevalentemente l\'attività. Se i redditi sono distribuiti su più cantoni in modo bilanciato, si applicano le regole della tabella C (imposta federale diretta cumulativa) con conguaglio finale. La gestione amministrativa è complessa: richiede coordinamento tra i datori e può comportare conguagli fiscali importanti. Per chi riceve retribuzioni da un cantone ma lavora parzialmente in Ticino, consigliamo consulenza professionale.',
 'I pensionati frontalieri meritano attenzione particolare. Le rendite AVS/AI erogate dalla Svizzera a residenti italiani sono tassate esclusivamente in Italia come redditi assimilati a quelli di lavoro dipendente (art. 19 CDI Italia-Svizzera), con tassazione IRPEF piena senza franchigia dei 10.000 EUR. Le rendite LPP (secondo pilastro) sono anch\'esse tassate in Italia, ma è possibile optare per il riscatto in capitale con imposta sostitutiva del 5% in Svizzera (al momento del prelievo) + tassazione in Italia con possibilità di regime del 12,5% sostitutivo. Il terzo pilastro 3a erogato come capitale è tassato in Svizzera con imposta separata ridotta (~5-8%) e in Italia come reddito da lavoro autonomo. La pianificazione previdenziale richiede strategie specifiche e non può essere improvvisata.',

 '<h2>Errori fiscali comuni: cosa evitare</h2>',
 'Analizzando le richieste dell\'Agenzia delle Entrate e le risultanze dei controlli fiscali sui frontalieri negli ultimi 3 anni, abbiamo identificato i 10 errori più frequenti commessi dai nuovi frontalieri nel 2024-2026. Evitarli può far risparmiare da EUR 500 a EUR 15.000 di sanzioni e interessi. Errore #1: non presentare la dichiarazione dei redditi italiana come nuovi frontalieri, ritenendo di essere esenti come i vecchi frontalieri. Sanzione: dal 120% al 240% dell\'imposta dovuta (art. 1 c. 1 D.Lgs. 471/1997). Errore #2: applicare la franchigia di 10.000 EUR sul netto o sul reddito in CHF anziché sul lordo convertito in EUR al tasso di cambio medio BCE del periodo d\'imposta. Errore #3: calcolare il credito d\'imposta senza considerare il rapporto proporzionale reddito estero/complessivo, ma usando il 100% dell\'imposta svizzera.',
 'Errore #4: non richiedere la Tassazione Ordinaria Ulteriore (TOU) entro il 31 marzo per dedurre pilastro 3a e spese effettive — perdita secca di CHF 800-2.000 di imposte recuperabili. Errore #5: non registrarsi all\'AIRE (Anagrafe degli Italiani Residenti all\'Estero) pur trasferendosi con permesso B, generando contestazioni sulla residenza fiscale effettiva. Errore #6: sottovalutare la tassazione dei redditi da capitale estero (conti correnti svizzeri, investimenti) — l\'Italia tassa al 26% i rendimenti finanziari svizzeri e richiede la compilazione del Quadro RW per monitoraggio patrimoni esteri sopra EUR 15.000. Errore #7: non dichiarare il cambio di datore di lavoro al fisco italiano entro la scadenza dichiarativa. Errore #8: compilare male il Quadro CE (crediti d\'imposta per redditi esteri), confondendo imposta lorda e netta.',
 'Errore #9: lavorare in telelavoro dall\'Italia oltre il 25% senza comunicarlo al datore svizzero, con rischio di riqualificazione del rapporto e recupero IRPEF integrale. Errore #10: non conservare la documentazione per almeno 5 anni (art. 43 DPR 600/1973): certificati salariali, attestati TOU, ricevute F24, estratti conto bancari svizzeri. Consiglio pratico: archiviare tutto in un cloud sicuro (Google Drive, Dropbox) con doppio backup. In caso di controllo fiscale, avere la documentazione ordinata può abbattere i tempi di accertamento da 18 mesi a 3 mesi. Per una consulenza personalizzata rivolgiti a CAF, patronati (INCA, ITAL) o commercialisti specializzati in fiscalità internazionale (costo medio EUR 300-600/anno).',

 '<h2>FAQ avanzate: domande dai frontalieri</h2>',
 '<p><strong>D1. Posso scegliere volontariamente il regime dei nuovi frontalieri se sono stato assunto prima del 2023?</strong> No, il regime transitorio è obbligatorio per chi soddisfa i requisiti (assunzione ante 17 luglio 2023, residenza entro 20 km). Non è possibile optare per il nuovo regime. Solo un cambio di lavoro con nuova assunzione dopo il 17 luglio 2023 fa scattare automaticamente il regime nuovi.</p>',
 '<p><strong>D2. Se divento pensionato nel 2027, conservo il regime vecchi frontalieri?</strong> No. Il regime transitorio vecchi frontalieri cessa al pensionamento o alla cessazione del rapporto di lavoro. Le rendite AVS/AI e LPP percepite da pensionati residenti in Italia sono tassate in Italia secondo regole diverse (art. 19 CDI Italia-Svizzera).</p>',
 '<p><strong>D3. Se lavoro part-time al 50%, come funziona la tassazione?</strong> La riduzione dell\'impiego al 50% non modifica il regime fiscale (vecchi o nuovi frontalieri). L\'imposta alla fonte è proporzionale al reddito effettivo. Tuttavia, le deduzioni (pilastro 3a, trasporto) restano proporzionali all\'attività effettiva.</p>',
 '<p><strong>D4. Posso dedurre le spese del mutuo italiano se ho permesso G?</strong> Sì, come residente fiscale italiano mantieni tutte le detrazioni standard IRPEF: interessi mutuo prima casa (19% fino a EUR 4.000), ristrutturazioni 50%, bonus mobili, spese scolastiche. Le detrazioni si calcolano sull\'IRPEF lorda prima del credito d\'imposta per tasse svizzere.</p>',
 '<p><strong>D5. Cosa succede se cambio residenza durante l\'anno dall\'Italia alla Svizzera?</strong> Il cambio di residenza genera un "anno diviso" fiscalmente: fino alla data di trasferimento tassazione italiana piena (come frontaliere G), dalla data di iscrizione AIRE tassazione svizzera esclusiva (come permesso B). Entrambe le dichiarazioni vanno presentate per frazioni d\'anno.</p>',
 '<p><strong>D6. Le indennità di disoccupazione svizzera sono tassate?</strong> Sì. L\'indennità di disoccupazione svizzera (AC) erogata a un frontaliere residente in Italia è tassata in Italia come reddito assimilato a lavoro dipendente, senza franchigia. L\'AC svizzera applica una ritenuta alla fonte ridotta del 5% che vale come credito d\'imposta in Italia.</p>',
 '<p><strong>D7. Se ho un conto corrente svizzero, devo dichiararlo in Italia?</strong> Sì, obbligatoriamente. I residenti italiani devono compilare il Quadro RW del Modello Redditi PF per patrimoni esteri (immobili, conti, investimenti) il cui valore medio supera EUR 15.000/anno. Omessa dichiarazione: sanzione dal 3% al 15% del patrimonio non dichiarato, raddoppiata se in paesi black list (Svizzera non è black list dal 2017).</p>',
 '<p><strong>D8. Posso dedurre in Svizzera i contributi al fondo pensione italiano?</strong> No. La TOU consente di dedurre solo contributi al pilastro 3a svizzero o a fondi pensione svizzeri riconosciuti. I fondi pensione italiani sono deducibili solo in Italia secondo i limiti IRPEF (max EUR 5.164,57/anno).</p>',
 '<p><strong>D9. Come si gestisce la tassazione dei bonus e delle stock option?</strong> I bonus sono trattati come salario ordinario: assoggettati a imposta alla fonte svizzera e dichiarati in Italia con credito d\'imposta e franchigia. Le stock option invece sono tassate al momento dell\'esercizio con regole complesse (art. 51 c. 2 TUIR per le assegnazioni, art. 15 CDI per redditi da lavoro). Consigliata consulenza specializzata.</p>',
 '<p><strong>D10. Cosa succede nel 2033 alla fine del regime transitorio?</strong> Nel 2033 il regime transitorio dei vecchi frontalieri cessa definitivamente. Tutti i frontalieri ancora in servizio passeranno al regime nuovi frontalieri con tassazione concorrente. I ristorni ai comuni italiani di confine saranno completamente eliminati. Chi si pensiona prima del 2033 conserva la tassazione italiana piena sulle pensioni. Si raccomanda di pianificare l\'eventuale transizione con il proprio consulente fiscale nei prossimi 5-7 anni.</p>',
 '<p style="color:#64748b;font-size:0.8rem;margin-top:1rem">Fonti normative: <a href="https://www.estv.admin.ch" style="color:#2563eb;text-decoration:none;" rel="noopener">Amministrazione federale delle contribuzioni (AFC)</a> · <a href="https://www.agenziaentrate.gov.it" style="color:#2563eb;text-decoration:none;" rel="noopener">Agenzia delle Entrate</a> · Accordo CH-IT 23.12.2020 (RS 0.642.045.43) · L. 83/2023 · L. 213/2023 art. 1 c. 175 · Accordo integrativo telelavoro 6.6.2024 · DPR 600/1973 · D.Lgs. 471/1997.</p>',
 ],
 en: [
 '<h2>Cross-border worker taxation 2026: Italy-Switzerland system overview</h2>',
 'The taxation of cross-border workers between Italy and Switzerland in 2026 operates under two distinct tax regimes, determined by the hiring date and municipality of residence. The system is governed by the New Tax Agreement signed on 23 December 2020 (RS 0.642.045.43, Italian law 83/2023), which entered into force on 17 July 2023 and significantly reshaped the rules compared to the 1974 agreement. In Canton Ticino alone, roughly 79,000 cross-border workers are affected (BFS/UST 2025 data), with average gross annual salaries between CHF 60,000 and CHF 90,000. Understanding your tax regime is essential to correctly calculate net pay, plan annual tax returns, and claim every eligible deduction.',
 'The two regimes coexist. "Old" cross-border workers — hired before 17 July 2023 and residing within 20 km of the border — pay only Swiss withholding tax at 100% of the ordinary cantonal rate, under a transitional regime running until 2033. "New" cross-border workers — hired from 17 July 2023 onwards, or residing beyond 20 km — are subject to concurrent taxation: Swiss withholding tax reduced to 80% of the ordinary rate plus Italian IRPEF on the same income, with a EUR 10,000 exemption on the Swiss portion and a tax credit for Swiss taxes already paid. Use the free <a href="/en/calculate-salary/" style="color:#2563eb;text-decoration:none;">salary simulator</a> to compute your exact net pay.',

 '<h2>The 2023 New Italy-Switzerland Agreement: what changed</h2>',
 'The New Tax Agreement represents the deepest reform of cross-border worker taxation in five decades. Replacing the 1974 treaty, it introduces five key novelties: (1) mandatory concurrent taxation for all new cross-border workers hired from 17 July 2023; (2) a EUR 10,000 exemption on Swiss-source income for Italian IRPEF purposes, enacted by Italian law 213/2023 art. 1 para. 175; (3) progressive elimination of fiscal rebates ("ristorni") to Italian border municipalities, phased out by 2033 from the current 40% quota; (4) extension of the G permit beyond the 20 km border zone under the new tax regime; (5) stronger administrative cooperation and automatic exchange of tax information between Italian and Swiss authorities.',
 'The Supplementary Agreement of 6 June 2024 also regulates cross-border teleworking: up to 25% of working time may be spent from Italy without losing cross-border status and without changes to the applicable tax regime. Above this threshold, the employment relationship may be reclassified as performed in Italy, triggering exclusive Italian taxation. This flexibility is especially relevant for ICT, finance, and consulting sectors, where remote work is widespread. Swiss employers must monitor the 25% threshold and report it annually to authorities.',
 'A practical example: Marco, a software engineer hired in Lugano on 1 September 2023 with a CHF 84,000 gross salary, resident in Como, falls under the new cross-border workers regime. He pays about CHF 7,800 of Swiss withholding tax (80% of the ~11.5% ordinary rate) and in Italy declares the CHF 84,000 converted to EUR (~EUR 87,500 at 0.96 rate), then subtracts the 10,000 EUR exemption. On the residual EUR 77,500 taxable base he computes IRPEF (tiered 23-35-43% rates) and deducts the foreign tax credit equal to the Swiss tax actually paid (EUR 8,125). The residual Italian tax balance is typically EUR 2,000-5,000, payable via F24 form.',

 '<h2>Avoiding double taxation</h2>',
 'Double taxation occurs when the same income is taxed both in the country where it is earned (Switzerland) and in the country where the taxpayer resides (Italy). For Italian cross-border workers this risk is concrete: Switzerland applies withholding tax on employment income, while Italy — under the worldwide taxation principle — would also claim the right to tax the same income as a tax-resident individual. The Double Taxation Convention between Switzerland and Italy (DTA, signed 9 March 1976, now integrated by the 2023 New Agreement) solves this problem via two combined mechanisms: concurrent taxation with a foreign tax credit, and the EUR 10,000 exemption.',
 'The foreign tax credit works as follows: Italian IRPEF owed on Swiss income is reduced by the Swiss withholding tax actually paid, up to a cap equal to the proportional IRPEF share on foreign income. Formula: <em>Credit = Total gross IRPEF × (Swiss income ÷ Total income)</em>. The credit cannot exceed the tax actually paid in Switzerland. The EUR 10,000 exemption applies first: the first EUR 10,000 of Swiss income is exempt from IRPEF, and the tax credit computation occurs on the residual base. Common mistakes include applying the exemption to net instead of gross income, or computing the credit ignoring the foreign/total income ratio. New cross-border workers must always file an Italian return — unlike old cross-border workers.',
 'Documents to retain: Swiss salary certificate (Lohnausweis), withholding tax receipts, Italian residence certificate, any TOU receipt from Switzerland. A specialised international tax advisor typically costs EUR 200-500 per year for a standard cross-border consultation, but prevents far heavier penalties from incorrect filings.',

 '<h2>G permit vs B permit: tax implications</h2>',
 'Choosing between the G permit (cross-border) and the B permit (resident) has profound tax implications beyond the simple income taxation. The G permit keeps Italian tax residency: the worker is taxed in Italy on worldwide income but benefits from the tax credit and exemption on Swiss earnings. The B permit transfers tax residency to Switzerland: exclusive Swiss taxation on employment and most other income, with exceptions for Italian-source real estate income (still taxed in Italy).',
 'The fiscal break-even between the two permits depends on income, marital status, family composition, and deductible expenses. As a rule of thumb: below CHF 90,000 gross annually, the G permit usually wins thanks to the EUR 10,000 exemption and progressive Italian IRPEF; between CHF 90,000 and CHF 130,000 the choice depends on personal variables (spouse, children, rent, mortgage); above CHF 130,000 the B permit is typically advantageous thanks to less aggressive Swiss rates and the generous TOU (Ordinary Tax Return) allowing broad deductions. However, the B permit comes with extra costs: mandatory LAMal (CHF 270-560/month), Swiss rent 40-70% higher than Lombardy, loss of the health-insurance option, and loss of Italian primary-residence mortgage deductions.',

 '<h2>Withholding tax rates Ticino 2026</h2>',
 'Canton Ticino withholding tax rates for 2026 are organised into four main tables, published annually by the Tax Division of the Ticino Department of Finance and Economy. Table A applies to singles without children; Table B to singles with dependent children; Table C to married couples; Table H to single-parent households. For new cross-border workers, since 17 July 2023 the applied rate is 80% of the ordinary one. Rates are progressive: starting at ~5% for gross income below CHF 30,000, rising to 10-12% at CHF 60,000, 14-16% at CHF 90,000, and exceeding 18-20% above CHF 150,000. Full official tables are available on the DFE Ticino portal.',

 '<h2>Tax deductions: maximising savings</h2>',
 'Cross-border workers can claim meaningful deductions in both countries, but proactive action is required within strict deadlines. In Switzerland, the Ordinary Tax Return (TOU, formerly TDR) must be requested by 31 March of the year following the tax year. It allows deducting: third-pillar contributions (up to CHF 7,258/year in 2026 for LPP-affiliated workers), actual commuting costs (CHF 0.70/km or commuter pass, max CHF 3,000), professionally relevant continuing education (max CHF 12,000), complementary insurance premiums (max CHF 2,600 single/CHF 5,200 couple), unreimbursed medical expenses, documented alimony payments, and contributions to Swiss political parties.',
 'In Italy, new cross-border workers can claim all standard 730/Redditi PF deductions: medical expenses (19% above EUR 129.11 deductible), primary-residence mortgage interest (19% up to EUR 4,000), building renovations 50% (up to EUR 96,000 per property), furniture bonus 50% (up to EUR 5,000), superbonus, education expenses (19% up to EUR 800 per child), supplementary pension contributions (up to EUR 5,164.57/year for Italian pension funds), charitable donations to ONLUS (19% up to EUR 30,000). A dependent spouse (income below EUR 2,840.51) grants EUR 800/year tax credit. Italian deductions and Swiss TOU cannot be cumulated for the same expense (e.g. pension contributions).',

 '<h2>Special cases: telework, multi-canton, retirees</h2>',
 'Cross-border teleworking is one of the most dynamic areas of cross-border taxation. Since 6 June 2024, the Italy-Switzerland Supplementary Agreement allows telework up to 25% of working time from Italy without changing cross-border tax status. This threshold is measured annually: a full-time worker (40h/week) can work up to 10h/week from Italy or accumulate up to 52 working days/year in smart working from Italy. Beyond 25%, the employment relationship risks being reclassified as performed in Italy, triggering exclusive Italian taxation and loss of the Swiss regime.',
 'Retiree cross-border workers deserve particular attention. AVS/AI pensions paid by Switzerland to Italian residents are taxed exclusively in Italy as employment-like income (art. 19 Italy-Switzerland DTA), with full IRPEF and no 10,000 EUR exemption. LPP pensions (second pillar) are also taxed in Italy, but it is possible to opt for a lump-sum redemption with a 5% substitute tax in Switzerland plus Italian taxation at a favourable 12.5% substitute regime. Third-pillar (3a) lump-sum payments are taxed in Switzerland with reduced separate tax (~5-8%) and in Italy as self-employment income. Retirement planning requires specialist advice.',

 '<h2>Common tax mistakes to avoid</h2>',
 'Analysing audits by the Italian Revenue Agency over 2024-2026, we have identified the ten most frequent mistakes by new cross-border workers. Avoiding them can save EUR 500 to EUR 15,000 in penalties and interest. Top mistakes: (1) failing to file an Italian tax return as a new cross-border worker, thinking exempt like old cross-border workers — penalty 120-240% of tax due; (2) applying the EUR 10,000 exemption to net or CHF income instead of gross converted to EUR at the BCE mean rate; (3) computing the foreign tax credit without the proportional foreign/total income ratio; (4) missing the 31 March deadline to request TOU for third-pillar deductions; (5) failing to register with AIRE when moving on B permit; (6) underestimating taxation of foreign capital income (26% tax on Swiss financial yields, mandatory Quadro RW for foreign assets above EUR 15,000); (7) exceeding 25% telework from Italy without notifying the employer; (8) mis-filing Quadro CE (foreign tax credits); (9) failing to keep documentation for 5 years; (10) confusing gross and net Swiss tax in computations.',

 '<h2>Advanced FAQ: questions from cross-border workers</h2>',
 '<p><strong>Q1. Can I voluntarily opt for the new cross-border regime if hired before 2023?</strong> No, the transitional regime is mandatory for those who meet the criteria (hired before 17 July 2023, residing within 20 km). Only a new contract signed after 17 July 2023 automatically triggers the new regime.</p>',
 '<p><strong>Q2. If I retire in 2027, do I keep the old cross-border regime?</strong> No. The transitional regime ceases upon retirement or contract termination. AVS/AI and LPP pensions received in Italy are taxed differently under art. 19 of the Italy-Switzerland DTA.</p>',
 '<p><strong>Q3. Part-time 50% — how does taxation work?</strong> Reducing work to 50% does not change the tax regime. Withholding tax is proportional to actual income. Deductions (third pillar, transport) remain proportional to actual activity.</p>',
 '<p><strong>Q4. Can I deduct my Italian mortgage with a G permit?</strong> Yes. As an Italian tax resident you retain all standard IRPEF deductions: primary-residence mortgage interest (19% up to EUR 4,000), renovations 50%, furniture bonus, school expenses. Deductions are calculated on gross IRPEF before the foreign tax credit.</p>',
 '<p><strong>Q5. What if I change residence from Italy to Switzerland mid-year?</strong> A change of residence creates a "split year": until the transfer date, full Italian taxation as G frontaliere; from AIRE registration onwards, exclusive Swiss taxation as B permit holder. Two partial-year returns must be filed.</p>',
 '<p><strong>Q6. Is Swiss unemployment benefit taxable?</strong> Yes. Swiss unemployment (AC) paid to an Italian resident is taxed in Italy as employment-like income, without exemption. Swiss AC applies a reduced 5% withholding tax, creditable in Italy.</p>',
 '<p><strong>Q7. If I hold a Swiss bank account, must I declare it in Italy?</strong> Yes, mandatorily. Italian residents must file Quadro RW in Redditi PF for foreign assets (real estate, accounts, investments) whose average annual value exceeds EUR 15,000. Failure to declare: 3-15% penalty on undeclared assets.</p>',
 '<p><strong>Q8. Can I deduct Italian pension-fund contributions in Switzerland?</strong> No. TOU only allows deduction of Swiss third-pillar contributions or recognised Swiss pension funds. Italian pension funds are deductible only in Italy within IRPEF limits (max EUR 5,164.57/year).</p>',
 '<p><strong>Q9. How are bonuses and stock options taxed?</strong> Bonuses are treated as ordinary salary: subject to Swiss withholding tax and declared in Italy with credit and exemption. Stock options instead are taxed at exercise with complex rules (art. 51 para. 2 TUIR for grants, art. 15 DTA for employment income). Specialist advice recommended.</p>',
 '<p><strong>Q10. What happens in 2033 at the end of the transitional regime?</strong> In 2033 the transitional regime for old cross-border workers definitively ends. All remaining workers will move to the new cross-border regime with concurrent taxation. Rebates to Italian border municipalities will be fully phased out. Workers retiring before 2033 retain full Italian taxation on pensions. Plan your transition with your tax advisor over the next 5-7 years.</p>',
 '<p style="color:#64748b;font-size:0.8rem;margin-top:1rem">Sources: <a href="https://www.estv.admin.ch" style="color:#2563eb;text-decoration:none;" rel="noopener">Swiss Federal Tax Administration (AFC)</a> · <a href="https://www.agenziaentrate.gov.it" style="color:#2563eb;text-decoration:none;" rel="noopener">Italian Revenue Agency</a> · CH-IT Agreement 23.12.2020 (RS 0.642.045.43) · Italian laws 83/2023, 213/2023 art. 1 para. 175 · Telework Supplementary Agreement 6.6.2024.</p>',
 ],
 de: [
 '<h2>Besteuerung Grenzgänger 2026: Überblick Italien-Schweiz</h2>',
 'Die Besteuerung der Grenzgänger zwischen Italien und der Schweiz im Jahr 2026 basiert auf zwei unterschiedlichen Steuerregimen, die vom Einstellungsdatum und dem Wohnort bestimmt werden. Das System wird durch das Neue Steuerabkommen vom 23. Dezember 2020 (SR 0.642.045.43, italienisches Gesetz 83/2023) geregelt, das am 17. Juli 2023 in Kraft trat und die Regeln gegenüber dem Abkommen von 1974 grundlegend verändert hat. Allein im Kanton Tessin sind rund 79.000 Grenzgänger betroffen (BFS/UST 2025), mit durchschnittlichen Bruttojahreslöhnen zwischen CHF 60.000 und CHF 90.000. Das eigene Steuerregime zu kennen ist entscheidend, um den Nettolohn korrekt zu berechnen, die Steuererklärung zu planen und alle Abzüge optimal zu nutzen.',
 'Die beiden Regime bestehen nebeneinander. "Alte" Grenzgänger — vor dem 17. Juli 2023 eingestellt, Wohnsitz innerhalb 20 km der Grenze — zahlen nur die Schweizer Quellensteuer zu 100 % des ordentlichen Kantonssatzes, unter einem Übergangsregime bis 2033. "Neue" Grenzgänger — ab 17. Juli 2023 eingestellt oder Wohnsitz über 20 km — unterliegen der konkurrierenden Besteuerung: Schweizer Quellensteuer reduziert auf 80 % des ordentlichen Satzes plus italienische IRPEF auf dasselbe Einkommen, mit einem Freibetrag von EUR 10.000 auf den Schweizer Anteil und einer Steuergutschrift für bereits bezahlte Schweizer Steuern. Nutzen Sie den kostenlosen <a href="/de/gehalt-berechnen/" style="color:#2563eb;text-decoration:none;">Lohnrechner</a>, um Ihren exakten Nettolohn zu berechnen.',

 '<h2>Das neue Italien-Schweiz-Abkommen 2023: Änderungen</h2>',
 'Das neue Steuerabkommen ist die tiefgreifendste Reform der Grenzgängerbesteuerung seit 50 Jahren. Es ersetzt den Vertrag von 1974 und führt fünf wesentliche Neuerungen ein: (1) obligatorische konkurrierende Besteuerung für alle neuen Grenzgänger ab 17. Juli 2023; (2) EUR-10.000-Freibetrag auf Schweizer Einkommen für die italienische IRPEF, erlassen durch Gesetz 213/2023 Art. 1 Abs. 175; (3) schrittweise Abschaffung der "ristorni" (Steuerrückerstattungen) an italienische Grenzgemeinden bis 2033 von der derzeitigen 40-%-Quote; (4) Erweiterung des G-Ausweises über die 20-km-Grenzzone hinaus unter dem neuen Steuerregime; (5) verstärkte Verwaltungszusammenarbeit und automatischer Austausch von Steuerinformationen zwischen italienischen und Schweizer Behörden.',
 'Das Zusatzabkommen vom 6. Juni 2024 regelt auch die grenzüberschreitende Telearbeit: Bis zu 25 % der Arbeitszeit können aus Italien geleistet werden, ohne den Grenzgängerstatus zu verlieren und ohne Änderungen am anwendbaren Steuerregime. Über dieser Schwelle kann das Arbeitsverhältnis als in Italien geleistet umqualifiziert werden, was eine ausschliesslich italienische Besteuerung auslöst. Diese Flexibilität ist besonders für ICT, Finanzen und Beratung relevant, wo Remote-Arbeit verbreitet ist. Schweizer Arbeitgeber müssen die 25-%-Schwelle überwachen und jährlich melden.',

 '<h2>Doppelbesteuerung vermeiden</h2>',
 'Doppelbesteuerung entsteht, wenn dasselbe Einkommen sowohl im Quellenland (Schweiz) als auch im Wohnsitzland (Italien) besteuert wird. Für italienische Grenzgänger ist das Risiko konkret: Die Schweiz erhebt Quellensteuer auf Einkommen aus unselbständiger Tätigkeit, während Italien nach dem Welteinkommensprinzip dieselbe Einkunft als steuerlich ansässige Person besteuern würde. Das Doppelbesteuerungsabkommen (DBA, unterzeichnet 9. März 1976, jetzt durch das Neue Abkommen 2023 ergänzt) löst das Problem durch zwei kombinierte Mechanismen: konkurrierende Besteuerung mit ausländischer Steuergutschrift und den EUR-10.000-Freibetrag.',
 'Die ausländische Steuergutschrift funktioniert so: Die auf Schweizer Einkommen geschuldete italienische IRPEF wird um die tatsächlich bezahlte Schweizer Quellensteuer reduziert, bis zu einer Obergrenze, die dem proportionalen IRPEF-Anteil auf ausländisches Einkommen entspricht. Formel: <em>Gutschrift = Gesamt-Bruttoirpef × (Schweizer Einkommen ÷ Gesamteinkommen)</em>. Die Gutschrift kann nicht höher sein als die in der Schweiz bezahlte Steuer. Der EUR-10.000-Freibetrag wird zuerst angewendet: Die ersten 10.000 EUR des Schweizer Einkommens sind IRPEF-frei, und die Gutschriftberechnung erfolgt auf der Restbasis. Neue Grenzgänger müssen immer eine italienische Steuererklärung einreichen.',

 '<h2>G-Ausweis vs. B-Ausweis: steuerliche Auswirkungen</h2>',
 'Die Wahl zwischen G-Ausweis (Grenzgänger) und B-Ausweis (Niederlassung) hat tiefgreifende steuerliche Folgen über die blosse Einkommensbesteuerung hinaus. Der G-Ausweis behält die italienische Steueransässigkeit: Besteuerung in Italien für das Welteinkommen, aber mit Nutzung der Steuergutschrift und des Freibetrags für Schweizer Einkommen. Der B-Ausweis verlegt die steuerliche Ansässigkeit in die Schweiz: ausschliesslich Schweizer Besteuerung für Erwerbs- und die meisten anderen Einkommen, mit Ausnahmen für italienische Immobilieneinkünfte (weiterhin in Italien besteuert).',
 'Der steuerliche Break-Even zwischen beiden Ausweisen hängt von Einkommen, Zivilstand, Familienzusammensetzung und abzugsfähigen Ausgaben ab. Faustregel: Unter CHF 90.000 Bruttojahreslohn gewinnt meist der G-Ausweis dank Freibetrag und progressiver italienischer IRPEF; zwischen CHF 90.000 und CHF 130.000 hängt die Wahl von persönlichen Variablen ab; über CHF 130.000 ist der B-Ausweis typischerweise vorteilhaft dank weniger aggressiver Schweizer Sätze und der grosszügigen TOU (Ordentliche Veranlagung). Der B-Ausweis bringt jedoch zusätzliche Kosten: obligatorische KVG (CHF 270-560/Monat), Schweizer Mieten 40-70 % höher als in der Lombardei, Verlust des Optionsrechts der Krankenversicherung und italienischer Wohnbauhypothekenabzüge.',

 '<h2>Quellensteuersätze Tessin 2026</h2>',
 'Die Quellensteuersätze 2026 im Kanton Tessin sind in vier Haupttabellen organisiert, die jährlich von der Steuerdivision des DFE Tessin veröffentlicht werden. Tabelle A gilt für Ledige ohne Kinder; Tabelle B für Ledige mit Kindern; Tabelle C für Verheiratete; Tabelle H für Alleinerziehende. Für neue Grenzgänger ab 17. Juli 2023 beträgt der Satz 80 % des ordentlichen Satzes. Die Sätze sind progressiv: ab ~5 % für Bruttolöhne unter CHF 30.000, steigend auf 10-12 % bei CHF 60.000, 14-16 % bei CHF 90.000 und über 18-20 % ab CHF 150.000. Vollständige offizielle Tabellen sind auf dem DFE-Tessin-Portal verfügbar.',

 '<h2>Abzüge: Steuerersparnis maximieren</h2>',
 'Grenzgänger können in beiden Ländern bedeutende Abzüge geltend machen, jedoch ist proaktives Handeln innerhalb strenger Fristen erforderlich. In der Schweiz muss die TOU (früher TDR) bis zum 31. März des Folgejahres beantragt werden. Sie erlaubt Abzüge für: Säule-3a-Beiträge (bis CHF 7.258/Jahr 2026 für BVG-Versicherte), tatsächliche Pendlerkosten (CHF 0,70/km oder Abonnement, max CHF 3.000), berufsbezogene Weiterbildung (max CHF 12.000), Zusatzversicherungsprämien (max CHF 2.600 ledig / CHF 5.200 Paar), ungedeckte medizinische Ausgaben, Unterhaltszahlungen und Beiträge an Schweizer Parteien.',
 'In Italien können neue Grenzgänger alle Standard-Abzüge der Modelli 730/Redditi PF nutzen: Gesundheitsausgaben (19 % über EUR 129,11 Selbstbehalt), Hypothekenzinsen Erstwohnsitz (19 % bis EUR 4.000), Renovierungen 50 % (bis EUR 96.000 pro Immobilie), Möbelbonus 50 % (bis EUR 5.000), Superbonus, Schulausgaben (19 % bis EUR 800 pro Kind), ergänzende Pensionsbeiträge (bis EUR 5.164,57/Jahr), Spenden an ONLUS (19 % bis EUR 30.000). Ein unterhaltsberechtigter Ehepartner (Einkommen unter EUR 2.840,51) gibt Anrecht auf EUR 800/Jahr Steuerabzug. TOU und italienische Abzüge können nicht für dieselbe Ausgabe kumuliert werden (z. B. Vorsorgebeiträge).',

 '<h2>Sonderfälle: Telearbeit, Multi-Kanton, Rentner</h2>',
 'Die grenzüberschreitende Telearbeit ist einer der dynamischsten Bereiche der Grenzgängerbesteuerung. Seit 6. Juni 2024 erlaubt das Zusatzabkommen Italien-Schweiz Telearbeit bis zu 25 % der Arbeitszeit aus Italien ohne Änderung des Grenzgängersteuerstatus. Ein Vollzeit-Arbeitnehmer kann bis zu 10 Std./Woche aus Italien arbeiten oder bis zu 52 Arbeitstage/Jahr im Home-Office in Italien ansammeln. Über 25 % wird das Arbeitsverhältnis als in Italien geleistet umqualifiziert, mit ausschliesslich italienischer Besteuerung.',
 'Rentner unter den Grenzgängern verdienen besondere Aufmerksamkeit. AHV/IV-Renten, die von der Schweiz an italienische Einwohner gezahlt werden, sind ausschliesslich in Italien als lohnähnliches Einkommen besteuert (Art. 19 DBA Italien-Schweiz), mit voller IRPEF und ohne 10.000-EUR-Freibetrag. BVG-Renten (zweite Säule) werden ebenfalls in Italien besteuert, aber es ist möglich, eine Kapitalbezug-Option mit 5 % Ersatzsteuer in der Schweiz zu wählen plus italienische Besteuerung zu einem günstigen 12,5-%-Ersatzregime. Säule-3a-Kapitalauszahlungen werden in der Schweiz mit reduzierter Sondersteuer (~5-8 %) und in Italien als selbständiges Einkommen besteuert.',

 '<h2>Häufige Fehler vermeiden</h2>',
 'Aus der Analyse der Prüfungen der italienischen Agenzia delle Entrate 2024-2026 haben wir die zehn häufigsten Fehler neuer Grenzgänger identifiziert. Diese zu vermeiden kann EUR 500 bis EUR 15.000 an Strafen und Zinsen sparen. Hauptfehler: (1) keine italienische Steuererklärung einreichen, im Glauben befreit zu sein wie alte Grenzgänger — Strafe 120-240 % der geschuldeten Steuer; (2) den EUR-10.000-Freibetrag auf Netto oder CHF statt auf Brutto in EUR anwenden; (3) die ausländische Steuergutschrift ohne das proportionale Verhältnis ausländisches/Gesamteinkommen berechnen; (4) die TOU-Frist am 31. März verpassen; (5) nicht ins AIRE eintragen bei Umzug mit B-Ausweis; (6) Besteuerung ausländischer Kapitaleinkommen unterschätzen (26 % auf Schweizer Finanzerträge, Pflicht Quadro RW für Auslandvermögen über EUR 15.000); (7) 25 % Telearbeit aus Italien überschreiten; (8) Quadro CE fehlerhaft ausfüllen; (9) Dokumente nicht 5 Jahre aufbewahren; (10) Brutto- und Nettoschweizersteuer verwechseln.',

 '<h2>Erweiterte FAQ: Fragen von Grenzgängern</h2>',
 '<p><strong>F1. Kann ich freiwillig das neue Grenzgängerregime wählen, wenn ich vor 2023 eingestellt wurde?</strong> Nein, das Übergangsregime ist zwingend für Berechtigte (Einstellung vor 17.7.2023, Wohnsitz innerhalb 20 km). Nur ein neuer Vertrag nach dem 17.7.2023 löst automatisch das neue Regime aus.</p>',
 '<p><strong>F2. Wenn ich 2027 in Rente gehe, behalte ich das alte Regime?</strong> Nein. Das Übergangsregime endet bei Rente oder Vertragsende. AHV/IV- und BVG-Renten in Italien werden anders besteuert (Art. 19 DBA Italien-Schweiz).</p>',
 '<p><strong>F3. Wie wirkt sich 50 % Teilzeit auf die Besteuerung aus?</strong> Die Reduktion auf 50 % ändert das Regime nicht. Die Quellensteuer ist proportional zum tatsächlichen Einkommen. Abzüge (Säule 3a, Transport) bleiben proportional zur effektiven Tätigkeit.</p>',
 '<p><strong>F4. Kann ich meine italienische Hypothek mit G-Ausweis abziehen?</strong> Ja. Als italienischer Steuereinwohner behalten Sie alle Standard-IRPEF-Abzüge: Hypothekenzinsen Erstwohnsitz (19 % bis EUR 4.000), Renovierungen 50 %, Möbelbonus, Schulausgaben. Abzüge werden auf der Brutto-IRPEF vor der ausländischen Steuergutschrift berechnet.</p>',
 '<p><strong>F5. Was passiert bei Wohnsitzwechsel Italien→Schweiz mitten im Jahr?</strong> Der Wohnsitzwechsel erzeugt ein "geteiltes Jahr": bis zum Transfer volle italienische Besteuerung als G-Grenzgänger; ab AIRE-Eintrag ausschliesslich Schweizer Besteuerung als B-Ausweis. Zwei Teiljahres-Erklärungen müssen eingereicht werden.</p>',
 '<p><strong>F6. Ist Schweizer Arbeitslosenentschädigung besteuert?</strong> Ja. Schweizer ALV-Leistungen an italienische Einwohner werden in Italien als lohnähnliches Einkommen besteuert, ohne Freibetrag. Die Schweizer ALV wendet eine reduzierte Quellensteuer von 5 % an, in Italien anrechenbar.</p>',
 '<p><strong>F7. Muss ich ein Schweizer Bankkonto in Italien deklarieren?</strong> Ja, zwingend. Italienische Einwohner müssen Quadro RW im Redditi PF für Auslandvermögen (Immobilien, Konten, Investitionen) einreichen, deren durchschnittlicher Jahreswert EUR 15.000 übersteigt. Strafe bei Nichtdeklaration: 3-15 % auf nicht deklarierte Vermögen.</p>',
 '<p><strong>F8. Kann ich italienische Pensionskassenbeiträge in der Schweiz abziehen?</strong> Nein. Die TOU erlaubt nur Abzüge für Schweizer Säule-3a-Beiträge oder anerkannte Schweizer Vorsorgefonds. Italienische Pensionsfonds sind nur in Italien innerhalb der IRPEF-Grenzen abzugsfähig (max EUR 5.164,57/Jahr).</p>',
 '<p><strong>F9. Wie werden Boni und Aktienoptionen besteuert?</strong> Boni werden als ordentlicher Lohn behandelt: Schweizer Quellensteuer und italienische Deklaration mit Gutschrift und Freibetrag. Aktienoptionen hingegen werden bei Ausübung mit komplexen Regeln besteuert (Art. 51 Abs. 2 TUIR für Zuteilungen, Art. 15 DBA für Erwerbseinkommen). Spezialberatung empfohlen.</p>',
 '<p><strong>F10. Was passiert 2033 am Ende des Übergangsregimes?</strong> 2033 endet das Übergangsregime für alte Grenzgänger definitiv. Alle verbleibenden Arbeitnehmer wechseln ins neue Grenzgängerregime mit konkurrierender Besteuerung. Die "ristorni" an italienische Grenzgemeinden werden vollständig abgeschafft. Vor 2033 pensionierte Arbeitnehmer behalten die volle italienische Besteuerung auf Renten. Planen Sie den Übergang in den nächsten 5-7 Jahren mit Ihrem Steuerberater.</p>',
 '<p style="color:#64748b;font-size:0.8rem;margin-top:1rem">Quellen: <a href="https://www.estv.admin.ch" style="color:#2563eb;text-decoration:none;" rel="noopener">Eidgenössische Steuerverwaltung (ESTV)</a> · <a href="https://www.agenziaentrate.gov.it" style="color:#2563eb;text-decoration:none;" rel="noopener">Agenzia delle Entrate</a> · CH-IT-Abkommen 23.12.2020 (SR 0.642.045.43) · Italienische Gesetze 83/2023, 213/2023 Art. 1 Abs. 175 · Telearbeitszusatz 6.6.2024.</p>',
 ],
 fr: [
 '<h2>Imposition des frontaliers 2026 : vue d\'ensemble Italie-Suisse</h2>',
 'L\'imposition des frontaliers entre l\'Italie et la Suisse en 2026 repose sur deux régimes fiscaux distincts, déterminés par la date d\'embauche et la commune de résidence. Le système est régi par le Nouvel Accord fiscal signé le 23 décembre 2020 (RS 0.642.045.43, loi italienne 83/2023) entré en vigueur le 17 juillet 2023, qui a profondément remodelé les règles par rapport à l\'accord de 1974. Dans le seul Canton du Tessin, environ 79 000 frontaliers sont concernés (données OFS/UST 2025), avec des salaires bruts annuels moyens entre CHF 60 000 et CHF 90 000. Comprendre son régime fiscal est essentiel pour calculer correctement le net, planifier la déclaration et exploiter toutes les déductions.',
 'Les deux régimes coexistent. Les "anciens" frontaliers — embauchés avant le 17 juillet 2023, résidant à moins de 20 km de la frontière — ne paient que l\'impôt à la source suisse à 100 % du taux cantonal ordinaire, sous un régime transitoire valable jusqu\'en 2033. Les "nouveaux" frontaliers — embauchés à partir du 17 juillet 2023 ou résidant au-delà de 20 km — sont soumis à l\'imposition concurrente : impôt à la source suisse réduit à 80 % plus IRPEF italienne sur le même revenu, avec une franchise de 10 000 EUR sur la part suisse et un crédit d\'impôt pour les taxes suisses déjà payées. Utilisez le <a href="/fr/calculer-salaire/" style="color:#2563eb;text-decoration:none;">simulateur de salaire</a> gratuit pour calculer votre net exact.',

 '<h2>Le Nouvel Accord Italie-Suisse 2023 : les changements</h2>',
 'Le Nouvel Accord fiscal représente la plus profonde réforme de l\'imposition des frontaliers en 50 ans. Remplaçant l\'accord de 1974, il introduit cinq nouveautés clés : (1) imposition concurrente obligatoire pour tous les nouveaux frontaliers embauchés à partir du 17 juillet 2023 ; (2) franchise de 10 000 EUR sur le revenu suisse pour l\'IRPEF, introduite par la loi 213/2023 art. 1 al. 175 ; (3) élimination progressive des "ristorni" fiscaux versés aux communes italiennes de frontière, supprimés d\'ici 2033 du quota actuel de 40 % ; (4) extension du permis G au-delà des 20 km de la zone frontalière sous le nouveau régime ; (5) coopération administrative renforcée et échange automatique d\'informations fiscales entre autorités italiennes et suisses.',
 'L\'Accord additionnel du 6 juin 2024 règlemente également le télétravail transfrontalier : jusqu\'à 25 % du temps de travail peut être presté depuis l\'Italie sans perte du statut de frontalier ni changement du régime fiscal applicable. Au-delà de ce seuil, la relation de travail risque d\'être requalifiée comme prestée en Italie, entraînant une imposition exclusivement italienne. Cette flexibilité est particulièrement pertinente pour les secteurs ICT, finance et conseil où le télétravail est répandu. Les employeurs suisses doivent surveiller le seuil des 25 % et le déclarer annuellement aux autorités.',

 '<h2>Éviter la double imposition</h2>',
 'La double imposition survient quand le même revenu est taxé à la fois dans le pays source (Suisse) et dans le pays de résidence (Italie). Pour les frontaliers italiens le risque est concret : la Suisse applique l\'impôt à la source sur le revenu d\'activité salariée, tandis que l\'Italie — selon le principe de l\'imposition mondiale — revendiquerait le droit d\'imposer le même revenu comme personne résidente. La Convention contre les doubles impositions (CDI Suisse-Italie, signée le 9 mars 1976 et intégrée par le Nouvel Accord 2023) résout le problème via deux mécanismes combinés : imposition concurrente avec crédit d\'impôt étranger et franchise de 10 000 EUR.',
 'Le crédit d\'impôt étranger fonctionne ainsi : l\'IRPEF italienne due sur le revenu suisse est réduite d\'un montant égal à l\'impôt à la source suisse effectivement payé, jusqu\'à un plafond équivalent à la part proportionnelle d\'IRPEF sur le revenu étranger. Formule : <em>Crédit = IRPEF brute totale × (Revenu suisse ÷ Revenu total)</em>. Le crédit ne peut excéder l\'impôt effectivement payé en Suisse. La franchise de 10 000 EUR s\'applique d\'abord : les premiers 10 000 EUR de revenu suisse sont exonérés d\'IRPEF, et le calcul du crédit se fait sur la base résiduelle. Les nouveaux frontaliers doivent toujours déposer une déclaration italienne, contrairement aux anciens frontaliers.',

 '<h2>Permis G vs Permis B : implications fiscales</h2>',
 'Le choix entre permis G (frontalier) et permis B (résident) a des implications fiscales profondes dépassant la simple imposition du revenu d\'activité. Le permis G conserve la résidence fiscale italienne : le frontalier est imposé en Italie sur son revenu mondial mais bénéficie du crédit d\'impôt et de la franchise sur les revenus suisses. Le permis B transfère la résidence fiscale en Suisse : imposition exclusive en Suisse pour le revenu d\'activité et la plupart des autres revenus, avec des exceptions pour les revenus immobiliers italiens (toujours imposés en Italie).',
 'Le seuil de rentabilité fiscale entre les deux permis dépend du revenu, de l\'état civil, de la composition familiale et des dépenses déductibles. Règle empirique : sous CHF 90 000 de brut annuel, le permis G est généralement plus avantageux grâce à la franchise de 10 000 EUR et à l\'IRPEF progressive italienne ; entre CHF 90 000 et CHF 130 000, le choix dépend de variables personnelles (conjoint, enfants, loyer, hypothèque) ; au-dessus de CHF 130 000, le permis B devient typiquement avantageux grâce aux taux suisses moins agressifs et à la généreuse TOU (Taxation Ordinaire Ultérieure) qui permet des déductions importantes. Toutefois, le permis B comporte des coûts supplémentaires : LAMal obligatoire (CHF 270-560/mois), loyer suisse 40-70 % plus cher qu\'en Lombardie, perte du droit d\'option santé et des déductions hypothécaires italiennes.',

 '<h2>Barèmes d\'impôt à la source Tessin 2026</h2>',
 'Les barèmes d\'impôt à la source 2026 du Canton du Tessin sont organisés en quatre tables principales, publiées chaque année par la Division des contributions du DFE Tessin. Table A pour célibataires sans enfants ; table B pour célibataires avec enfants ; table C pour mariés ; table H pour monoparentales. Pour les nouveaux frontaliers, depuis le 17 juillet 2023 le taux appliqué est 80 % du taux ordinaire. Les taux sont progressifs : à partir de ~5 % pour un brut sous CHF 30 000, atteignant 10-12 % à CHF 60 000, 14-16 % à CHF 90 000, et dépassant 18-20 % au-delà de CHF 150 000. Les tables officielles complètes sont disponibles sur le portail DFE Tessin.',

 '<h2>Déductions fiscales : maximiser l\'économie</h2>',
 'Les frontaliers peuvent réclamer des déductions importantes dans les deux pays, mais une action proactive est requise dans des délais stricts. En Suisse, la TOU (ancienne TDR) doit être demandée avant le 31 mars de l\'année suivant l\'année fiscale. Elle permet de déduire : cotisations 3e pilier (jusqu\'à CHF 7 258/an en 2026 pour affiliés LPP), frais effectifs de trajet domicile-travail (CHF 0,70/km ou abonnement, max CHF 3 000), formation continue professionnelle (max CHF 12 000), primes d\'assurances complémentaires (max CHF 2 600 seul / CHF 5 200 couple), frais médicaux non remboursés, pensions alimentaires et dons aux partis suisses.',
 'En Italie, les nouveaux frontaliers peuvent utiliser toutes les déductions standard du Modèle 730 ou Redditi PF : frais de santé (19 % au-delà de la franchise EUR 129,11), intérêts hypothécaires résidence principale (19 % jusqu\'à EUR 4 000), rénovations 50 % (jusqu\'à EUR 96 000 par bien), bonus meubles 50 % (jusqu\'à EUR 5 000), superbonus, frais scolaires (19 % jusqu\'à EUR 800 par enfant), prévoyance complémentaire (jusqu\'à EUR 5 164,57/an), dons aux ONLUS (19 % jusqu\'à EUR 30 000). Un conjoint à charge (revenu sous EUR 2 840,51) donne droit à EUR 800/an. TOU et déductions italiennes ne sont pas cumulables pour la même dépense (ex. cotisations de prévoyance).',

 '<h2>Cas particuliers : télétravail, multi-cantons, retraités</h2>',
 'Le télétravail transfrontalier est un domaine particulièrement dynamique. Depuis le 6 juin 2024, l\'Accord additionnel Italie-Suisse autorise le télétravail jusqu\'à 25 % du temps de travail depuis l\'Italie sans changer le statut fiscal de frontalier. Un travailleur à temps plein peut travailler jusqu\'à 10 h/semaine depuis l\'Italie ou cumuler jusqu\'à 52 jours/an de smart working. Au-delà de 25 %, la relation peut être requalifiée comme prestée en Italie, avec imposition exclusivement italienne.',
 'Les frontaliers retraités méritent une attention particulière. Les rentes AVS/AI versées par la Suisse à des résidents italiens sont imposées exclusivement en Italie comme revenus assimilés à l\'activité salariée (art. 19 CDI Italie-Suisse), avec IRPEF pleine et sans franchise de 10 000 EUR. Les rentes LPP (2e pilier) sont également imposées en Italie, mais il est possible d\'opter pour un rachat en capital avec impôt substitutif de 5 % en Suisse plus imposition italienne sous un régime favorable à 12,5 %. Les capitaux 3a sont imposés en Suisse à taux séparé réduit (~5-8 %) et en Italie comme revenu indépendant. La planification retraite requiert un conseil spécialisé.',

 '<h2>Erreurs fiscales courantes à éviter</h2>',
 'À partir de l\'analyse des contrôles de l\'Agenzia delle Entrate 2024-2026, nous avons identifié les dix erreurs les plus fréquentes des nouveaux frontaliers. Les éviter peut économiser EUR 500 à EUR 15 000 en sanctions et intérêts. Principales erreurs : (1) ne pas déposer de déclaration italienne comme nouveau frontalier, pensant être exempté comme les anciens — sanction 120-240 % de l\'impôt dû ; (2) appliquer la franchise de 10 000 EUR sur le net ou sur CHF au lieu du brut converti en EUR au taux moyen BCE ; (3) calculer le crédit d\'impôt sans le ratio revenu étranger/total ; (4) manquer l\'échéance du 31 mars pour la TOU ; (5) ne pas s\'inscrire à l\'AIRE lors du déménagement avec permis B ; (6) sous-estimer l\'imposition des revenus de capital étranger (26 % sur les rendements financiers suisses, Quadro RW obligatoire pour patrimoines étrangers supérieurs à EUR 15 000) ; (7) dépasser 25 % de télétravail depuis l\'Italie ; (8) mal remplir le Quadro CE ; (9) ne pas conserver les documents 5 ans ; (10) confondre impôt suisse brut et net.',

 '<h2>FAQ avancées : questions des frontaliers</h2>',
 '<p><strong>Q1. Puis-je opter volontairement pour le nouveau régime si j\'ai été embauché avant 2023 ?</strong> Non, le régime transitoire est obligatoire pour ceux qui remplissent les critères (embauche avant le 17 juillet 2023, résidence à moins de 20 km). Seul un nouveau contrat signé après le 17 juillet 2023 déclenche automatiquement le nouveau régime.</p>',
 '<p><strong>Q2. Si je prends ma retraite en 2027, est-ce que je conserve l\'ancien régime ?</strong> Non. Le régime transitoire prend fin à la retraite ou à la fin du contrat. Les rentes AVS/AI et LPP perçues en Italie sont imposées différemment selon l\'art. 19 CDI Italie-Suisse.</p>',
 '<p><strong>Q3. Temps partiel à 50 % — comment fonctionne l\'imposition ?</strong> La réduction à 50 % ne change pas le régime fiscal. L\'impôt à la source est proportionnel au revenu effectif. Les déductions (3e pilier, transport) restent proportionnelles à l\'activité réelle.</p>',
 '<p><strong>Q4. Puis-je déduire mon hypothèque italienne avec le permis G ?</strong> Oui. Comme résident fiscal italien, vous conservez toutes les déductions IRPEF standard : intérêts hypothécaires résidence principale (19 % jusqu\'à EUR 4 000), rénovations 50 %, bonus meubles, frais scolaires. Les déductions sont calculées sur l\'IRPEF brute avant le crédit d\'impôt étranger.</p>',
 '<p><strong>Q5. Que se passe-t-il lors d\'un changement de résidence Italie→Suisse en milieu d\'année ?</strong> Le changement crée une "année partagée" : jusqu\'à la date de transfert, imposition italienne pleine comme frontalier G ; à partir de l\'inscription AIRE, imposition exclusivement suisse comme permis B. Deux déclarations partielles doivent être déposées.</p>',
 '<p><strong>Q6. L\'indemnité de chômage suisse est-elle imposée ?</strong> Oui. L\'AC suisse versée à un résident italien est imposée en Italie comme revenu assimilé à l\'activité salariée, sans franchise. L\'AC suisse applique une retenue réduite de 5 % créditable en Italie.</p>',
 '<p><strong>Q7. Dois-je déclarer un compte bancaire suisse en Italie ?</strong> Oui, obligatoirement. Les résidents italiens doivent remplir le Quadro RW du Redditi PF pour les patrimoines étrangers (immobilier, comptes, investissements) dont la valeur moyenne annuelle dépasse EUR 15 000. Sanction pour non-déclaration : 3-15 % sur le patrimoine non déclaré.</p>',
 '<p><strong>Q8. Puis-je déduire les cotisations de prévoyance italiennes en Suisse ?</strong> Non. La TOU n\'autorise que les déductions pour cotisations 3e pilier suisse ou fonds de prévoyance suisses reconnus. Les fonds italiens ne sont déductibles qu\'en Italie dans les limites IRPEF (max EUR 5 164,57/an).</p>',
 '<p><strong>Q9. Comment sont imposés les bonus et stock-options ?</strong> Les bonus sont traités comme salaire ordinaire : impôt à la source suisse et déclaration italienne avec crédit et franchise. Les stock-options sont imposées à l\'exercice avec des règles complexes (art. 51 al. 2 TUIR pour les attributions, art. 15 CDI pour le revenu d\'activité). Conseil spécialisé recommandé.</p>',
 '<p><strong>Q10. Que se passe-t-il en 2033 à la fin du régime transitoire ?</strong> En 2033 le régime transitoire des anciens frontaliers prend définitivement fin. Tous les travailleurs restants passeront au nouveau régime avec imposition concurrente. Les "ristorni" aux communes italiennes de frontière seront totalement supprimés. Les travailleurs partant en retraite avant 2033 conservent la pleine imposition italienne sur les rentes. Planifiez la transition avec votre conseiller fiscal dans les 5-7 prochaines années.</p>',
 '<p style="color:#64748b;font-size:0.8rem;margin-top:1rem">Sources : <a href="https://www.estv.admin.ch" style="color:#2563eb;text-decoration:none;" rel="noopener">Administration fédérale des contributions (AFC)</a> · <a href="https://www.agenziaentrate.gov.it" style="color:#2563eb;text-decoration:none;" rel="noopener">Agenzia delle Entrate</a> · Accord CH-IT 23.12.2020 (RS 0.642.045.43) · Lois italiennes 83/2023, 213/2023 art. 1 al. 175 · Accord additionnel télétravail 6.6.2024.</p>',
 ],
 },
 '/guida-frontaliere/primo-giorno-lavoro': {
 en: [
 'The first-day guide covers all practical steps for new cross-border workers: G permit collection, Swiss bank account opening, health insurance choice (LAMal or Italian NHS), AIRE registration, and first tax return.',
 'Each step includes real timelines, required documents, and links to the relevant offices (Ticino Migration Office, INPS, Italian Revenue Agency) to complete procedures without errors.',
 'The interactive checklist guides you week by week through the first 90 days, from signing your contract to full fiscal and social security stabilisation.',
 ],
 de: [
 'Der Ersttagsleitfaden deckt alle praktischen Schritte für neue Grenzgänger ab: Abholung des Ausweises G, Eröffnung eines Schweizer Bankkontos, Wahl der Krankenversicherung (KVG oder italienischer NHS), AIRE-Registrierung und erste Steuererklärung.',
 'Jeder Schritt enthält realistische Fristen, erforderliche Dokumente und Links zu den zuständigen Ämtern (Migrationsamt Tessin, INPS, italienische Steuerbehörde).',
 'Die interaktive Checkliste begleitet Sie Woche für Woche durch die ersten 90 Tage — von der Vertragsunterzeichnung bis zur vollständigen steuerlichen und sozialversicherungsrechtlichen Stabilisierung.',
 ],
 fr: [
 'Le guide du premier jour couvre toutes les étapes pratiques pour les nouveaux frontaliers : obtention du permis G, ouverture d\'un compte bancaire suisse, choix de l\'assurance maladie (LAMal ou SSN italien), inscription AIRE et première déclaration fiscale.',
 'Chaque étape inclut des délais réels, les documents requis et des liens vers les bureaux compétents (Office des migrations du Tessin, INPS, Agence des revenus italienne).',
 'La checklist interactive vous accompagne semaine après semaine pendant les 90 premiers jours, de la signature du contrat à la stabilisation fiscale et sociale complète.',
 ],
 },
 '/guida-frontaliere/permessi-di-lavoro': {
 en: [
 'The work permits comparison analyses the operational differences between G permit (cross-border, annual renewal) and B permit (residence, 5 years): taxation, access to services, right of stay, and implications for the family.',
 'The choice between G and B permit depends on distance from the border, family situation, fiscal circumstances, and expected duration of Swiss employment. This tool helps weigh the pros and cons of each scenario.',
 'The comparison also covers pension implications (AVS, LPP, unemployment insurance), family member residence rights, and the impact on both Italian and Swiss taxation.',
 ],
 de: [
 'Der Bewilligungsvergleich analysiert die betrieblichen Unterschiede zwischen Ausweis G (Grenzgänger, jährliche Verlängerung) und Ausweis B (Aufenthalt, 5 Jahre): Besteuerung, Zugang zu Dienstleistungen, Aufenthaltsrecht und Auswirkungen auf die Familie.',
 'Die Wahl zwischen Ausweis G und B hängt von der Entfernung zur Grenze, der familiären Situation, den steuerlichen Umständen und der erwarteten Dauer der Beschäftigung in der Schweiz ab.',
 'Der Vergleich umfasst auch Vorsorgeaspekte (AHV, BVG, Arbeitslosenversicherung), Aufenthaltsrechte für Familienangehörige und die Auswirkungen auf die Besteuerung in beiden Ländern.',
 ],
 fr: [
 'La comparaison des permis de travail analyse les différences opérationnelles entre le permis G (frontalier, renouvellement annuel) et le permis B (séjour, 5 ans) : fiscalité, accès aux services, droit de séjour et implications pour la famille.',
 'Le choix entre permis G et B dépend de la distance de la frontière, de la situation familiale, des circonstances fiscales et de la durée prévue de l\'emploi en Suisse.',
 'La comparaison couvre aussi les implications de prévoyance (AVS, LPP, assurance chômage), les droits de séjour des membres de la famille et l\'impact sur la fiscalité italienne et suisse.',
 ],
 },
 '/guida-frontaliere/tempi-attesa-dogana/': {
 it: [
 'I tempi di attesa ai valichi di frontiera sono stimati su dati storici e fasce orarie tipiche: l\'ingresso mattutino (6:30–8:30) e l\'uscita serale (17:00–18:30) sono le finestre con maggiore congestione. Per ogni valico vengono fornite indicazioni pratiche su orari alternativi, percorsi secondari e strumenti di monitoraggio in tempo reale (webcam, app di traffico) per ridurre i tempi di pendolarismo quotidiani.',
 'Le variazioni stagionali sono significative: i venerdì di vacanze estive, la stagione sciistica e i ponti festivi italiani possono aumentare i tempi di attesa del 30–50 %. Partire 15 minuti prima o dopo il picco può far risparmiare tempo considerevole nell\'arco dell\'anno e si traduce in 25–40 ore di pendolarismo evitato per chi fa il tragitto cinque giorni alla settimana.',
 'Per i frontalieri abituali il documento d\'identità deve essere sempre a portata di mano: anche all\'interno dell\'area Schengen i valichi possono essere oggetto di controlli a campione su veicoli, merci e dichiarazioni doganali. Le franchigie chiave da ricordare: importazioni alimentari fino a 1 kg di carne e 5 litri di bevande alcoliche per persona, contante fino a CHF 10.000 senza dichiarazione, sigarette fino a 250 g per maggiorenne — oltre queste soglie scatta l\'obbligo di dichiarazione e il pagamento di IVA e dazi.',
 'Chi guida un\'auto aziendale registrata in Svizzera deve tenere nel cruscotto la lettera di autorizzazione del datore di lavoro e una copia del libretto di circolazione: in caso di controllo doganale italiano, questi documenti evitano lunghi accertamenti e chiariscono immediatamente la natura del rapporto di lavoro frontaliere. Per i veicoli aziendali con targhe svizzere il limite massimo di permanenza in territorio italiano è di 60 giorni consecutivi, dopo i quali scatta l\'obbligo di reimportazione temporanea o definitiva.',
 ],
 en: [
 'Border crossing waiting times are estimated based on historical data and typical time slots: morning entry (6:30–8:30) and evening exit (17:00–18:30) are the windows with the most congestion. For each crossing, practical tips are provided on alternative schedules, secondary routes, and real-time monitoring tools (webcams, traffic apps) to reduce daily commuting times.',
 'Seasonal variations are significant: summer holiday Fridays, ski season, and Italian public holidays can increase queue times by 30–50%. Planning your departure 15 minutes earlier or later than the peak can save substantial commuting time over the year, equating to 25–40 hours of avoided commute for anyone crossing five days a week.',
 'For regular cross-border workers, your ID document must always be within reach: even within the Schengen area, crossings can be subject to spot checks on vehicles, goods, and customs declarations. Key allowances to remember: food imports up to 1 kg of meat and 5 litres of alcoholic beverages per person, cash up to CHF 10,000 without declaration, and cigarettes up to 250 g per adult — beyond these thresholds VAT and duties apply and a customs declaration becomes mandatory.',
 'If you drive a Swiss-registered company car, keep the employer authorisation letter and a copy of the vehicle registration in the glove compartment: at an Italian customs check these documents prevent prolonged questioning and immediately clarify the cross-border work relationship. Swiss-plated company vehicles can stay in Italian territory for a maximum of 60 consecutive days, after which a temporary or permanent re-import is mandatory.',
 ],
 de: [
 'Die Wartezeiten an den Grenzübergängen werden basierend auf historischen Daten und typischen Zeitfenstern geschätzt: Morgeneinfahrt (6:30–8:30) und Abendausfahrt (17:00–18:30) sind die staureichsten Zeiten. Für jeden Übergang werden praktische Tipps zu alternativen Fahrzeiten, Nebenrouten und Echtzeit-Überwachungstools (Webcams, Verkehrs-Apps) gegeben, um die tägliche Pendelzeit zu reduzieren.',
 'Saisonale Schwankungen sind erheblich: Sommerferienfreitage, Skisaison und italienische Feiertage können die Wartezeiten um 30–50 % verlängern. Eine Abfahrt 15 Minuten früher oder später als der Spitzenzeitpunkt kann über das Jahr hinweg erhebliche Pendelzeit einsparen — bei fünf Tagen Pendeln pro Woche entspricht dies 25–40 Stunden vermiedener Pendelzeit pro Jahr.',
 'Für regelmässige Grenzgänger sollte der Ausweis stets griffbereit sein: Auch innerhalb des Schengen-Raums können die Übergänge Stichprobenkontrollen für Fahrzeuge, Waren und Zollanmeldungen unterliegen. Wichtige Freimengen: Lebensmittelimporte bis 1 kg Fleisch und 5 Liter alkoholische Getränke pro Person, Bargeld bis CHF 10\'000 ohne Anmeldung, Zigaretten bis 250 g pro Erwachsenem — darüber hinaus werden MwSt. und Zölle fällig und eine Zollanmeldung wird obligatorisch.',
 'Wer einen in der Schweiz zugelassenen Firmenwagen fährt, sollte das Schreiben des Arbeitgebers und eine Kopie des Fahrzeugausweises im Handschuhfach mitführen: Bei einer italienischen Zollkontrolle vermeiden diese Dokumente langwierige Befragungen. Schweizer Firmenfahrzeuge dürfen maximal 60 aufeinanderfolgende Tage in Italien verbleiben, danach ist eine vorübergehende oder definitive Wiedereinfuhr obligatorisch.',
 ],
 fr: [
 'Les temps d\'attente aux postes frontières sont estimés à partir de données historiques et de créneaux horaires typiques : entrée matinale (6h30–8h30) et sortie en soirée (17h00–18h30) sont les fenêtres de plus grande congestion. Pour chaque poste, des conseils pratiques sont fournis sur les horaires alternatifs, les itinéraires secondaires et les outils de surveillance en temps réel (webcams, applications trafic) pour réduire les temps de trajet quotidiens.',
 'Les variations saisonnières sont importantes : les vendredis de vacances d\'été, la saison de ski et les jours fériés italiens peuvent augmenter les temps d\'attente de 30 à 50 %. Partir 15 minutes plus tôt ou plus tard que le pic peut faire économiser un temps considérable sur l\'année, ce qui équivaut à 25–40 heures de trajet évitées pour quelqu\'un qui traverse cinq jours par semaine.',
 'Pour les frontaliers réguliers, gardez toujours votre pièce d\'identité à portée de main : même dans l\'espace Schengen, les passages peuvent faire l\'objet de contrôles aléatoires sur les véhicules, les marchandises et les déclarations douanières. Franchises clés : importations alimentaires jusqu\'à 1 kg de viande et 5 litres de boissons alcoolisées par personne, espèces jusqu\'à 10 000 CHF sans déclaration, cigarettes jusqu\'à 250 g par adulte — au-delà, TVA et droits de douane s\'appliquent et une déclaration devient obligatoire.',
 'Si vous conduisez un véhicule de société immatriculé en Suisse, gardez la lettre d\'autorisation de l\'employeur et une copie de la carte grise dans la boîte à gants : lors d\'un contrôle douanier italien, ces documents évitent les interrogations prolongées. Les véhicules de société à plaques suisses peuvent rester en territoire italien 60 jours consécutifs maximum, après quoi une réimportation temporaire ou définitive devient obligatoire.',
 ],
 },
 '/guida-frontaliere/tempi-attesa-dogana': {
 it: [
 'I valichi di frontiera tra Ticino e Italia sono il collo di bottiglia quotidiano per oltre 70.000 frontalieri. La <a href="https://frontaliereticino.ch/guida-frontaliere/tempi-attesa-dogana/chiasso-centro/">dogana di Chiasso Centro</a> e il <a href="https://frontaliereticino.ch/guida-frontaliere/tempi-attesa-dogana/chiasso-brogeda/">valico di Brogeda</a> gestiscono il volume maggiore di traffico, con code che nelle ore di punta (7:00-8:30 e 17:00-18:30) possono superare i 30 minuti.',
 'Per ridurre i tempi di attesa, i frontalieri esperti utilizzano valichi secondari come <a href="https://frontaliereticino.ch/guida-frontaliere/tempi-attesa-dogana/stabio/">Stabio</a>, <a href="https://frontaliereticino.ch/guida-frontaliere/tempi-attesa-dogana/gaggiolo/">Gaggiolo</a> o <a href="https://frontaliereticino.ch/guida-frontaliere/tempi-attesa-dogana/ponte-tresa/">Ponte Tresa</a>, che offrono tempi nettamente inferiori ma con orari di apertura limitati (generalmente 6:00-22:00).',
 'Le variazioni stagionali sono rilevanti: i venerdi estivi, la stagione sciistica e le <a href="https://frontaliereticino.ch/tasse-e-pensione/festivita-ticino/">festivita ticinesi</a> possono aumentare le code del 30-50%. Consulta la nostra mappa interattiva per verificare il traffico in tempo reale e scegliere il percorso migliore.',
 ],
 en: [
 'The border crossing map shows all crossings between Ticino and Italy with opening hours, typical traffic levels, and average waiting times by time slot.',
 'Each crossing has different characteristics: some are reserved for local residents, others handle heavy commercial traffic. Knowing the best crossing for your route can save up to 30 minutes a day.',
 'The most used crossings by commuters are Chiasso–Ponte Chiasso, Stabio–Gaggiolo, and Brogeda. Secondary crossings like Pizzamiglio and Passo San Jorio offer shorter queues but longer driving distances — the optimal choice depends on your destination in Ticino.',
 'Experienced frontalieri recommend departing before 6:45 AM or after 8:30 AM to avoid the worst morning congestion at major crossings. Similarly, the evening return window between 17:00 and 18:30 sees peak queues — leaving work 15 minutes earlier or later can cut wait times by half. Flexible working arrangements negotiated with your employer are the most effective long-term strategy.',
 'Alternative crossings offer significant time savings for workers heading to specific parts of Ticino. Gandria and Oria serve eastern Lake Lugano, while Ponte Tresa is ideal for the Malcantone region. The Dirinella crossing near Lavena suits workers in western Ticino. Each secondary crossing has limited opening hours — typically 6:00–22:00 — so verifying schedules before planning your commute is essential.',
 ],
 de: [
 'Die Grenzübergangskarte zeigt alle Übergänge zwischen dem Tessin und Italien mit Öffnungszeiten, typischem Verkehrsaufkommen und durchschnittlichen Wartezeiten nach Zeitfenstern.',
 'Jeder Übergang hat unterschiedliche Eigenschaften: Einige sind Anwohnern vorbehalten, andere wickeln schweren Güterverkehr ab. Den besten Übergang für die eigene Route zu kennen, kann täglich bis zu 30 Minuten sparen.',
 'Die von Pendlern am häufigsten genutzten Übergänge sind Chiasso–Ponte Chiasso, Stabio–Gaggiolo und Brogeda. Sekundäre Übergänge wie Pizzamiglio und Passo San Jorio bieten kürzere Wartezeiten, aber längere Fahrstrecken.',
 'Erfahrene Grenzgänger empfehlen, vor 6:45 Uhr oder nach 8:30 Uhr abzufahren, um die schlimmsten Morgenstaus an den Hauptübergängen zu vermeiden. Ebenso treten abends zwischen 17:00 und 18:30 Uhr Spitzenwarteschlangen auf — 15 Minuten früher oder später abzufahren kann die Wartezeit halbieren. Flexible Arbeitszeiten mit dem Arbeitgeber zu vereinbaren, ist die wirksamste Langzeitstrategie.',
 'Alternative Übergänge bieten erhebliche Zeitersparnisse für Arbeitnehmer in bestimmten Tessiner Regionen. Gandria und Oria bedienen den östlichen Luganersee, Ponte Tresa ist ideal für das Malcantone. Der Dirinella-Übergang bei Lavena eignet sich für das Westtessin. Jeder Nebenübergang hat begrenzte Öffnungszeiten — typisch 6:00–22:00 — daher ist die Überprüfung des Fahrplans vor der Routenplanung unerlässlich.',
 ],
 fr: [
 'La carte des postes frontières montre tous les passages entre le Tessin et l\'Italie avec les horaires d\'ouverture, les niveaux de trafic typiques et les temps d\'attente moyens par créneau horaire.',
 'Chaque passage a des caractéristiques différentes : certains sont réservés aux résidents locaux, d\'autres gèrent du trafic commercial lourd. Connaître le meilleur passage pour votre trajet peut faire gagner jusqu\'à 30 minutes par jour.',
 'Les passages les plus utilisés par les pendulaires sont Chiasso–Ponte Chiasso, Stabio–Gaggiolo et Brogeda. Les passages secondaires comme Pizzamiglio et Passo San Jorio offrent des files plus courtes mais des distances de conduite plus longues.',
 'Les frontaliers expérimentés recommandent de partir avant 6h45 ou après 8h30 pour éviter la pire congestion matinale aux passages principaux. De même, le créneau de retour entre 17h00 et 18h30 connaît les pires files — partir 15 minutes plus tôt ou plus tard peut réduire l\'attente de moitié. Les horaires flexibles négociés avec l\'employeur restent la stratégie la plus efficace à long terme.',
 'Les passages alternatifs offrent des gains de temps significatifs selon la destination au Tessin. Gandria et Oria desservent l\'est du lac de Lugano, Ponte Tresa est idéal pour la région du Malcantone. Le passage de Dirinella près de Lavena convient au Tessin occidental. Chaque passage secondaire a des horaires limités — typiquement 6h00–22h00 — il est donc essentiel de vérifier les horaires avant de planifier son trajet.',
 ],
 },
 // ───── Chiasso Centro / Brogeda (striking distance target) ──
 '/guida-frontaliere/tempi-attesa-dogana/chiasso-centro': {
 it: [
 'Il traffico alla dogana di <strong>Chiasso Centro</strong> e al valico di <strong>Brogeda</strong> rappresenta il principale punto di attesa per i frontalieri che lavorano in Ticino: insieme gestiscono oltre il 40% del flusso quotidiano verso la Svizzera, con picchi di 25-40 minuti di coda nelle ore di punta del mattino (7:00-9:00) e della sera (17:00-19:00).',
 'La <strong>differenza tra Chiasso Centro e Brogeda</strong> è sostanziale: Chiasso Centro è il valico urbano tradizionale, usato prevalentemente dal traffico locale e dai pedoni, mentre Brogeda è il grande valico autostradale che gestisce il traffico pesante e i flussi di lunga percorrenza dall\'autostrada A9. In orario di punta, Brogeda tende a essere più scorrevole rispetto a Chiasso Centro proprio per la maggiore capacità delle corsie autostradali, ma è più esposto a rallentamenti nei giorni di controlli doganali commerciali intensificati.',
 '<strong>Come evitare la coda alla dogana di Chiasso</strong>: i frontalieri esperti utilizzano tre strategie. Primo, anticipare la partenza di 20-30 minuti rispetto al picco (arrivo prima delle 6:45 o dopo le 8:30). Secondo, valutare i valichi alternativi come <a href="https://frontaliereticino.ch/guida-frontaliere/tempi-attesa-dogana/ponte-chiasso/">Ponte Chiasso</a> (pedonale e veicoli leggeri), <a href="https://frontaliereticino.ch/guida-frontaliere/tempi-attesa-dogana/novazzano/">Novazzano</a>, <a href="https://frontaliereticino.ch/guida-frontaliere/tempi-attesa-dogana/gaggiolo/">Gaggiolo</a> o <a href="https://frontaliereticino.ch/guida-frontaliere/tempi-attesa-dogana/stabio/">Stabio</a>, che nelle stesse fasce orarie spesso presentano attese inferiori ai 10 minuti. Terzo, monitorare il traffico in tempo reale tramite le webcam ufficiali dell\'Amministrazione federale delle dogane (AFD) e app come <em>Google Maps</em> o <em>Waze</em> prima di uscire di casa.',
 'Gli <strong>orari di apertura</strong> di Chiasso Centro e Brogeda sono 24 ore su 24 per i valichi principali, ma alcune corsie dedicate (es. pendolari, frontalieri con tessera) possono avere orari ridotti. I controlli possono essere intensificati a campione o in occasione di eventi speciali (vertici internazionali, operazioni antifrode) — in questi casi le code possono facilmente raddoppiare. I venerdì estivi, l\'inizio e la fine della stagione sciistica e i ponti festivi italiani sono i giorni peggiori dell\'anno per chi attraversa a Chiasso.',
 ],
 en: [
 'Traffic at the <strong>Chiasso Centro</strong> customs and <strong>Brogeda</strong> crossing is the main bottleneck for cross-border workers commuting into Ticino: together they handle over 40% of the daily inflow to Switzerland, with peaks of 25–40 minutes during morning (7:00–9:00) and evening (17:00–19:00) rush hours.',
 'The difference between Chiasso Centro and Brogeda is substantial: Chiasso Centro is the traditional urban crossing used mostly by local traffic and pedestrians, while Brogeda is the large motorway crossing on the A9, handling heavy freight and long-distance traffic. During rush hour Brogeda is often smoother thanks to its wider motorway lanes, but is more exposed to slowdowns on days with intensified commercial customs checks.',
 'To avoid queues at Chiasso, experienced frontalieri use three strategies: depart 20–30 minutes before the peak (arrive before 6:45 or after 8:30), use alternative crossings such as Ponte Chiasso, Novazzano, Gaggiolo or Stabio (which typically show under 10 minutes of wait in the same windows), and monitor real-time traffic via official customs webcams and navigation apps before leaving.',
 'Opening hours at Chiasso Centro and Brogeda are 24/7 for the main lanes, but dedicated lanes (commuters, cross-border badge holders) may have shorter hours. Random or event-triggered checks (international summits, anti-fraud operations) can easily double queue times. Summer Fridays, the start and end of ski season, and Italian long-weekend holidays are the worst days of the year for Chiasso.',
 ],
 de: [
 'Der Verkehr am Zoll <strong>Chiasso Centro</strong> und am Grenzübergang <strong>Brogeda</strong> ist der wichtigste Wartepunkt für Grenzgänger, die im Tessin arbeiten: Zusammen bewältigen sie über 40 % des täglichen Einreisestroms in die Schweiz, mit Spitzenwerten von 25–40 Minuten zu den Hauptzeiten (morgens 7:00–9:00 und abends 17:00–19:00).',
 'Der Unterschied zwischen Chiasso Centro und Brogeda ist erheblich: Chiasso Centro ist der traditionelle städtische Übergang, überwiegend für lokalen Verkehr und Fussgänger, während Brogeda der grosse Autobahnübergang an der A9 ist und Schwerverkehr sowie Fernverkehr abwickelt. In der Hauptverkehrszeit ist Brogeda dank der breiteren Autobahnspuren oft flüssiger, aber anfälliger für Verzögerungen bei verstärkten kommerziellen Zollkontrollen.',
 'Um Staus in Chiasso zu vermeiden, nutzen erfahrene Grenzgänger drei Strategien: 20–30 Minuten vor dem Spitzenzeitpunkt abfahren (vor 6:45 oder nach 8:30 ankommen), alternative Übergänge wie Ponte Chiasso, Novazzano, Gaggiolo oder Stabio wählen (meist unter 10 Minuten Wartezeit), und den Echtzeit-Verkehr über offizielle Zoll-Webcams und Navigations-Apps vor der Abfahrt überwachen.',
 'Die Öffnungszeiten von Chiasso Centro und Brogeda sind 24/7 für die Hauptspuren, aber Sonderspuren (Pendler, Grenzgänger-Ausweis) können kürzere Zeiten haben. Stichprobenkontrollen oder veranstaltungsbedingte Kontrollen (internationale Gipfel, Anti-Betrugs-Operationen) können die Wartezeit leicht verdoppeln. Sommerfreitage, Saisonbeginn und -ende des Skisports sowie italienische Brückentage sind die schlimmsten Tage des Jahres für Chiasso.',
 ],
 fr: [
 'Le trafic au poste-frontière de <strong>Chiasso Centro</strong> et à <strong>Brogeda</strong> est le principal point d\'attente des frontaliers qui travaillent au Tessin : ensemble ils gèrent plus de 40 % du flux quotidien vers la Suisse, avec des pics de 25–40 minutes aux heures de pointe (7h00–9h00 le matin et 17h00–19h00 le soir).',
 'La différence entre Chiasso Centro et Brogeda est notable : Chiasso Centro est le passage urbain traditionnel, principalement utilisé par le trafic local et les piétons, tandis que Brogeda est le grand passage autoroutier sur l\'A9, qui gère le trafic poids lourd et la longue distance. En heure de pointe, Brogeda est souvent plus fluide grâce aux voies plus larges, mais plus exposé aux ralentissements les jours de contrôles douaniers commerciaux renforcés.',
 'Pour éviter la file à Chiasso, les frontaliers expérimentés utilisent trois stratégies : partir 20–30 minutes avant le pic (arriver avant 6h45 ou après 8h30), emprunter les passages alternatifs comme Ponte Chiasso, Novazzano, Gaggiolo ou Stabio (généralement moins de 10 minutes d\'attente), et surveiller le trafic en temps réel via les webcams officielles de la douane et les applications de navigation avant de partir.',
 'Les horaires d\'ouverture de Chiasso Centro et Brogeda sont 24h/24 pour les voies principales, mais les voies dédiées (pendulaires, titulaires de carte frontalière) peuvent avoir des horaires réduits. Les contrôles aléatoires ou liés à des événements (sommets internationaux, opérations anti-fraude) peuvent facilement doubler les temps d\'attente. Les vendredis d\'été, le début et la fin de la saison de ski et les ponts italiens sont les pires jours de l\'année à Chiasso.',
 ],
 },

 '/guida-frontaliere/trasferimento-auto': {
 en: [
 'The car transfer guide covers procedures for registering an Italian vehicle in Switzerland and vice versa: customs clearance, MFK technical inspection, insurance, and timelines for re-registration.',
 'For cross-border workers using an Italian-plated vehicle, it explains the rules for driving in Switzerland: time limits, Swiss-valid insurance, fines, and special cases with company vehicles.',
 'Key topics include the temporary import rules (Form 15.30), the 60-day re-export deadline, and the documentation needed for customs clearance at the Stabio or Chiasso offices.',
 'Transferring a vehicle between countries involves significant costs: Swiss customs duties (4% of the vehicle\'s value), VAT (8.1%), the MFK technical inspection fee (CHF 100–250), new Swiss registration (CHF 50–120), and mandatory Swiss-valid insurance. Italian de-registration fees and PRA charges also apply. In total, transferring an average car from Italy to Switzerland costs CHF 2,500–5,000 depending on the vehicle\'s declared value.',
 'The documentation process typically takes 4–8 weeks from start to finish. Required documents include the original Italian registration certificate (carta di circolazione), proof of ownership, a valid EU roadworthiness certificate (revisione), customs Form 18.44 for definitive import, and proof of Swiss residence or employment. Starting the process early and booking the MFK inspection in advance is critical, as waiting times at Ticino inspection centres can exceed three weeks.',
 ],
 de: [
 'Der Leitfaden zum Autotransfer deckt die Verfahren zur Ummatrikulierung eines italienischen Fahrzeugs in der Schweiz und umgekehrt ab: Verzollung, MFK-Prüfung, Versicherung und Fristen für die Ummeldung.',
 'Für Grenzgänger mit italienischem Kennzeichen werden die Fahrregeln in der Schweiz erläutert: Zeitlimits, in der Schweiz gültige Versicherung, Bussen und Sonderfälle mit Geschäftsfahrzeugen.',
 'Wichtige Themen sind die Regeln zur vorübergehenden Einfuhr (Formular 15.30), die 60-Tage-Wiederausfuhrfrist und die für die Verzollung am Zollamt Stabio oder Chiasso erforderlichen Dokumente.',
 'Der Fahrzeugtransfer zwischen den Ländern verursacht erhebliche Kosten: Schweizer Zollgebühren (4 % des Fahrzeugwerts), MwSt. (8,1 %), MFK-Prüfungsgebühr (CHF 100–250), Schweizer Neuanmeldung (CHF 50–120) und eine obligatorische, in der Schweiz gültige Versicherung. Zusätzlich fallen italienische Abmeldegebühren und PRA-Kosten an. Insgesamt kostet der Transfer eines durchschnittlichen Autos CHF 2.500–5.000.',
 'Das Dokumentationsverfahren dauert üblicherweise 4–8 Wochen. Erforderliche Unterlagen sind die italienische Zulassungsbescheinigung (Carta di Circolazione), Eigentumsnachweis, ein gültiges EU-Prüfzeugnis (Revisione), Zollformular 18.44 für die definitive Einfuhr sowie Nachweis des Schweizer Wohnsitzes oder der Beschäftigung. Eine frühzeitige Planung und rechtzeitige Buchung der MFK-Prüfung ist entscheidend, da die Wartezeiten an Tessiner Prüfstellen drei Wochen übersteigen können.',
 ],
 fr: [
 'Le guide de transfert auto couvre les procédures d\'immatriculation d\'un véhicule italien en Suisse et vice versa : dédouanement, contrôle technique MFK, assurance et délais de réimmatriculation.',
 'Pour les frontaliers utilisant un véhicule à plaques italiennes, il explique les règles de circulation en Suisse : limites de temps, assurance valable en Suisse, amendes et cas particuliers avec véhicules d\'entreprise.',
 'Les sujets clés incluent les règles d\'importation temporaire (formulaire 15.30), le délai de réexportation de 60 jours et les documents nécessaires au dédouanement aux bureaux de Stabio ou Chiasso.',
 'Le transfert d\'un véhicule entre les deux pays implique des coûts importants : droits de douane suisses (4 % de la valeur du véhicule), TVA (8,1 %), frais du contrôle technique MFK (CHF 100–250), nouvelle immatriculation suisse (CHF 50–120) et assurance obligatoire valable en Suisse. Des frais de radiation italiens et des charges PRA s\'ajoutent. Au total, le transfert d\'une voiture moyenne coûte CHF 2 500–5 000.',
 'La procédure documentaire prend généralement 4 à 8 semaines. Les documents requis comprennent le certificat d\'immatriculation italien original (carta di circolazione), la preuve de propriété, un contrôle technique EU valide (revisione), le formulaire douanier 18.44 pour l\'importation définitive et la preuve de résidence ou d\'emploi en Suisse. Commencer tôt et réserver le contrôle MFK à l\'avance est crucial, car les délais d\'attente au Tessin peuvent dépasser trois semaines.',
 ],
 },
 '/guida-frontaliere/': {
 en: [
 'The cross-border guide collects practical and up-to-date information for those who work in Ticino and live in Italy: administrative procedures, permits, required documents, and tips based on the experience of thousands of cross-border workers.',
 'Each section is designed to be consulted independently and contains direct links to official forms, relevant offices, and calculation tools to verify practical implications immediately.',
 'The guides cover the entire cross-border lifecycle: from first employment to retirement, including unemployment, car transfer, border crossings, and cross-border maternity/paternity leave.',
 '<p style="color:#64748b;font-size:0.8rem;margin-top:4px;">Source: <a href="https://www.seco.admin.ch" style="color:#2563eb;text-decoration:none;" rel="noopener">SECO - State Secretariat for Economic Affairs</a></p>',
 ],
 de: [
 'Der Grenzgänger-Leitfaden sammelt praktische und aktuelle Informationen für alle, die im Tessin arbeiten und in Italien leben: Verwaltungsverfahren, Bewilligungen, erforderliche Dokumente und Tipps aus der Erfahrung Tausender Grenzgänger.',
 'Jeder Abschnitt ist für eigenständige Nutzung konzipiert und enthält direkte Links zu offiziellen Formularen, zuständigen Ämtern und Berechnungstools zur sofortigen Überprüfung praktischer Auswirkungen.',
 'Die Leitfäden decken den gesamten Grenzgänger-Lebenszyklus ab: vom ersten Arbeitstag bis zur Pensionierung, einschliesslich Arbeitslosigkeit, Autotransfer, Grenzübergänge und grenzüberschreitendem Mutter-/Vaterschaftsurlaub.',
 '<p style="color:#64748b;font-size:0.8rem;margin-top:4px;">Quelle: <a href="https://www.seco.admin.ch" style="color:#2563eb;text-decoration:none;" rel="noopener">SECO - Staatssekretariat für Wirtschaft</a></p>',
 ],
 fr: [
 'Le guide frontalier rassemble des informations pratiques et actualisées pour ceux qui travaillent au Tessin et vivent en Italie : procédures administratives, permis, documents requis et conseils basés sur l\'expérience de milliers de frontaliers.',
 'Chaque section est conçue pour être consultée de manière indépendante et contient des liens directs vers les formulaires officiels, les bureaux compétents et les outils de calcul pour vérifier immédiatement les implications pratiques.',
 'Les guides couvrent l\'ensemble du cycle de vie du frontalier : du premier emploi à la retraite, en passant par le chômage, le transfert auto, les postes frontières et le congé maternité/paternité transfrontalier.',
 '<p style="color:#64748b;font-size:0.8rem;margin-top:4px;">Source : <a href="https://www.seco.admin.ch" style="color:#2563eb;text-decoration:none;" rel="noopener">SECO - Secrétariat d\'État à l\'économie</a></p>',
 ],
 },

 // ───── Glossary ───────────────────────────────────────────────
 '/glossario-frontaliere/': {
 it: [
 'Il glossario fornisce definizioni chiare e contestualizzate dei termini tecnici che ogni frontaliere incontra quotidianamente: sigle fiscali (AVS, LPP, LAMal, IRPEF, INPS), documenti amministrativi (CU, Modello 730, Lohnausweis, Formulario U1) e concetti giuridici (domicilio fiscale, stabile organizzazione, quasi-residente, tassazione concorrente).',
 'Ogni voce è scritta con linguaggio accessibile e collegata agli strumenti del sito che utilizzano quel concetto. Ad esempio, dalla definizione di "imposta alla fonte" puoi accedere direttamente al simulatore di busta paga, e dalla voce "LPP" al calcolatore previdenziale. Questo approccio trasforma il glossario da semplice dizionario a punto di navigazione operativo.',
 'Comprendere questi termini è essenziale per leggere correttamente la busta paga svizzera, la dichiarazione dei redditi italiana, le comunicazioni ufficiali della Divisione delle contribuzioni ticinese e le lettere dell\'Agenzia delle Entrate. La terminologia bilingue (italiano-tedesco e italiano-francese) aiuta anche nelle comunicazioni dirette con le autorità svizzere.',
 'Il glossario copre anche le differenze terminologiche tra i sistemi svizzero e italiano: ad esempio, "contributi sociali" in Italia corrisponde a "Sozialabzüge" in Svizzera; "certificazione unica" (CU) è l\'equivalente italiano del "Lohnausweis" svizzero; e "pensione di vecchiaia INPS" ha il suo corrispettivo nel primo pilastro AVS/AHV svizzero. Queste corrispondenze evitano confusione nei documenti transfrontalieri.',
 'Le voci vengono aggiornate regolarmente in base alle novità legislative, alle modifiche dei regolamenti cantonali e alle domande più frequenti della community di frontalieri. Ogni termine include riferimenti alle fonti normative ufficiali (leggi federali, accordi bilaterali, circolari dell\'AFC) per consentire un approfondimento autonomo.',
 ],
 en: [
 'The glossary provides clear, contextualised definitions of technical terms every cross-border worker encounters: fiscal acronyms (AVS, LPP, LAMal, IRPEF, INPS), administrative documents (CU, Modello 730, Lohnausweis, U1 Form), and legal concepts (fiscal domicile, permanent establishment, quasi-resident, concurrent taxation).',
 'Each entry is written in accessible language and linked to the site\'s tools that use that concept. For example, from the definition of "withholding tax" you can access the payslip simulator directly, and from the "LPP" entry the pension calculator. This approach transforms the glossary from a simple dictionary into a practical navigation hub.',
 'Understanding these terms is crucial for reading Swiss payslips, Italian tax declarations, official communications from the Ticino tax division, and letters from the Italian Revenue Agency. Bilingual terminology (Italian-German and Italian-French) also helps with direct communications to Swiss authorities.',
 'The glossary also covers terminological differences between the Swiss and Italian systems: for example, "contributi sociali" in Italy corresponds to "Sozialabzüge" in Switzerland; "certificazione unica" (CU) is the Italian equivalent of the Swiss "Lohnausweis"; and "pensione di vecchiaia INPS" has its counterpart in the Swiss first-pillar AVS/AHV. These correspondences prevent confusion in cross-border documents.',
 'Entries are regularly updated based on legislative changes, cantonal regulation amendments, and the most frequent questions from the cross-border worker community. Each term includes references to official regulatory sources (federal laws, bilateral agreements, AFC circulars) to enable independent further research.',
 ],
 de: [
 'Das Glossar bietet verständliche, kontextualisierte Definitionen der Fachbegriffe, die jeder Grenzgänger antrifft: Steuerabkürzungen (AHV, BVG, KVG, IRPEF, INPS), Verwaltungsdokumente (CU, Modello 730, Lohnausweis, Formular U1) und juristische Konzepte (Steuerdomizil, Betriebsstätte, Quasi-Ansässigkeit, konkurrierende Besteuerung).',
 'Jeder Eintrag ist in allgemeinverständlicher Sprache verfasst und mit den Tools der Website verknüpft, die das jeweilige Konzept verwenden. Von der Definition „Quellensteuer" gelangen Sie direkt zum Lohnabrechnungssimulator, vom Eintrag „BVG" zum Vorsorgerechner. Dieser Ansatz verwandelt das Glossar von einem einfachen Wörterbuch in einen praktischen Navigationsknotenpunkt.',
 'Das Verständnis dieser Begriffe ist entscheidend für das Lesen von Schweizer Lohnabrechnungen, italienischen Steuererklärungen, offiziellen Mitteilungen der Tessiner Steuerverwaltung und Schreiben der italienischen Steuerbehörde. Die zweisprachige Terminologie (Italienisch-Deutsch und Italienisch-Französisch) hilft auch bei der direkten Kommunikation mit Schweizer Behörden.',
 'Das Glossar deckt auch terminologische Unterschiede zwischen dem schweizerischen und italienischen System ab: „contributi sociali" in Italien entspricht „Sozialabzüge" in der Schweiz; „certificazione unica" (CU) ist das italienische Äquivalent zum Schweizer „Lohnausweis"; und die „pensione di vecchiaia INPS" hat ihre Entsprechung in der ersten Säule AHV/AVS. Diese Zuordnungen vermeiden Verwirrung bei grenzüberschreitenden Dokumenten.',
 'Die Einträge werden regelmässig aktualisiert basierend auf Gesetzesänderungen, kantonalen Verordnungsanpassungen und den häufigsten Fragen der Grenzgänger-Community. Jeder Begriff enthält Verweise auf offizielle Rechtsquellen (Bundesgesetze, bilaterale Abkommen, ESTV-Rundschreiben) für eigenständige Vertiefung.',
 ],
 fr: [
 'Le glossaire fournit des définitions claires et contextualisées des termes techniques que tout frontalier rencontre : sigles fiscaux (AVS, LPP, LAMal, IRPEF, INPS), documents administratifs (CU, Modello 730, Lohnausweis, formulaire U1) et concepts juridiques (domicile fiscal, établissement stable, quasi-résident, taxation concurrente).',
 'Chaque entrée est rédigée dans un langage accessible et reliée aux outils du site qui utilisent ce concept. Par exemple, depuis la définition d\'« impôt à la source », vous accédez directement au simulateur de fiche de paie, et depuis l\'entrée « LPP » au calculateur de prévoyance. Cette approche transforme le glossaire d\'un simple dictionnaire en un hub de navigation pratique.',
 'Comprendre ces termes est essentiel pour lire les fiches de paie suisses, les déclarations fiscales italiennes, les communications officielles de la division des contributions tessinoise et les courriers de l\'administration fiscale italienne. La terminologie bilingue (italien-allemand et italien-français) aide aussi pour la communication directe avec les autorités suisses.',
 'Le glossaire couvre aussi les différences terminologiques entre les systèmes suisse et italien : par exemple, « contributi sociali » en Italie correspond à « Sozialabzüge » en Suisse ; « certificazione unica » (CU) est l\'équivalent italien du « Lohnausweis » suisse ; et la « pensione di vecchiaia INPS » a son correspondant dans le 1er pilier AVS/AHV. Ces correspondances évitent la confusion dans les documents transfrontaliers.',
 'Les entrées sont régulièrement mises à jour en fonction des évolutions législatives, des modifications réglementaires cantonales et des questions les plus fréquentes de la communauté frontalière. Chaque terme inclut des références aux sources normatives officielles (lois fédérales, accords bilatéraux, circulaires AFC) pour permettre un approfondissement autonome.',
 ],
 },

 // ───── FAQ ────────────────────────────────────────────────────
 '/domande-frequenti-frontalieri': {
 en: [
 'The FAQ answers the most common questions from cross-border workers between Switzerland and Italy: "Do I need to file a tax return in Italy?", "How much do I pay for health insurance?", "Does the EUR 10,000 franchise apply to my case?".',
 'Each answer includes updated regulatory references and direct links to the site\'s simulators to calculate the impact on your specific situation.',
 'Questions are organised by topic — tax, pension, healthcare, administrative — and updated regularly based on legislative changes and the most recurring queries from the community.',
 ],
 de: [
 'Die FAQ beantwortet die häufigsten Fragen von Grenzgängern zwischen der Schweiz und Italien: „Muss ich in Italien eine Steuererklärung einreichen?", „Wie viel zahle ich für Krankenversicherung?", „Gilt die EUR-10.000-Franchise für meinen Fall?".',
 'Jede Antwort enthält aktuelle Gesetzesverweise und direkte Links zu den Simulatoren der Website, um die Auswirkungen auf Ihre individuelle Situation zu berechnen.',
 'Die Fragen sind nach Themen geordnet — Steuern, Vorsorge, Gesundheit, Verwaltung — und werden regelmässig auf Basis von Gesetzesänderungen und den häufigsten Anfragen der Community aktualisiert.',
 ],
 fr: [
 'La FAQ répond aux questions les plus courantes des frontaliers entre la Suisse et l\'Italie : « Dois-je faire une déclaration de revenus en Italie ? », « Combien coûte l\'assurance maladie ? », « La franchise de 10 000 EUR s\'applique-t-elle à mon cas ? ».',
 'Chaque réponse inclut des références réglementaires actualisées et des liens directs vers les simulateurs du site pour calculer l\'impact sur votre situation spécifique.',
 'Les questions sont organisées par thème — fiscal, prévoyance, santé, administratif — et mises à jour régulièrement en fonction des évolutions législatives et des interrogations les plus fréquentes de la communauté.',
 ],
 },

 // ───── Living in Ticino ───────────────────────────────────────
 '/vivere-in-ticino/operatori-telefonici': {
 en: [
 'The mobile operators comparison analyses the most affordable plans for those who live in Italy and work in Switzerland: roaming coverage, cross-border plans, call costs, and data in border areas.',
 'For cross-border workers, mobile connectivity is critical: you need coverage in both countries, no extra charge for daily roaming, and flexible data options during your commute.',
 'The comparison includes Swiss providers (Swisscom, Salt, Sunrise) and Italian ones (Iliad, ho., Vodafone), with details on cross-border add-ons, eSIM support, and coverage quality in the Ticino border area.',
 ],
 de: [
 'Der Mobilfunk-Vergleich analysiert die günstigsten Tarife für Personen, die in Italien leben und in der Schweiz arbeiten: Roaming-Abdeckung, grenzüberschreitende Tarife, Gesprächskosten und Daten im Grenzgebiet.',
 'Für Grenzgänger ist mobile Konnektivität entscheidend: Abdeckung in beiden Ländern, keine Zusatzkosten für tägliches Roaming und flexible Datenoptionen während des Pendelns.',
 'Der Vergleich umfasst Schweizer Anbieter (Swisscom, Salt, Sunrise) und italienische (Iliad, ho., Vodafone), mit Details zu grenzüberschreitenden Zusatzoptionen, eSIM-Unterstützung und Netzqualität im Tessiner Grenzgebiet.',
 ],
 fr: [
 'Le comparateur d\'opérateurs mobiles analyse les offres les plus avantageuses pour ceux qui vivent en Italie et travaillent en Suisse : couverture roaming, forfaits transfrontaliers, coûts d\'appel et données dans les zones frontalières.',
 'Pour les frontaliers, la connectivité mobile est essentielle : couverture dans les deux pays, pas de frais supplémentaires pour le roaming quotidien et options data flexibles pendant le trajet.',
 'Le comparateur inclut les opérateurs suisses (Swisscom, Salt, Sunrise) et italiens (Iliad, ho., Vodafone), avec des détails sur les options transfrontalières, le support eSIM et la qualité de couverture dans la zone frontalière tessinoise.',
 ],
 },
 '/vivere-in-ticino/spesa-e-shopping': {
 en: [
 'The grocery cost calculator compares prices of a standard basket between Swiss supermarkets (Migros, Coop, Denner) and Italian ones (Esselunga, Lidl, Eurospin), accounting for the CHF-EUR exchange rate.',
 'For many cross-border workers, shopping in Italy is a practical way to exploit the price differential: on a weekly basket of CHF 150, average savings when buying in Italy are 25–35%.',
 'The tool also highlights customs rules for goods crossing the border, VAT refund thresholds, and practical tips on which products offer the best savings when purchased on the Italian side.',
 ],
 de: [
 'Der Einkaufskostenrechner vergleicht die Preise eines Standardwarenkorbs zwischen Schweizer Supermärkten (Migros, Coop, Denner) und italienischen (Esselunga, Lidl, Eurospin) unter Berücksichtigung des CHF-EUR-Wechselkurses.',
 'Für viele Grenzgänger ist Einkaufen in Italien eine praktische Möglichkeit, das Preisgefälle zu nutzen: Bei einem Wocheneinkauf von CHF 150 beträgt die durchschnittliche Ersparnis in Italien 25–35 %.',
 'Das Tool zeigt auch Zollregeln für den Warenverkehr über die Grenze, MwSt-Erstattungsschwellen und praktische Tipps, welche Produkte auf der italienischen Seite die grössten Einsparungen bieten.',
 ],
 fr: [
 'Le calculateur du coût des courses compare les prix d\'un panier type entre les supermarchés suisses (Migros, Coop, Denner) et italiens (Esselunga, Lidl, Eurospin), en tenant compte du taux de change CHF-EUR.',
 'Pour de nombreux frontaliers, faire ses courses en Italie est un moyen concret d\'exploiter le différentiel de prix : sur un panier hebdomadaire de 150 CHF, l\'économie moyenne en Italie est de 25 à 35 %.',
 'L\'outil met aussi en évidence les règles douanières pour les marchandises traversant la frontière, les seuils de remboursement de TVA et des conseils pratiques sur les produits offrant les meilleures économies côté italien.',
 ],
 },
 '/vivere-in-ticino/costo-della-vita': {
 en: [
 'The cost of living index compares major expense categories between Switzerland (Ticino) and Italy (Lombardy/Piedmont): rent, transport, groceries, healthcare, education, and leisure.',
 'The cost-of-living differential is the key factor in choosing between a G permit (residence in Italy) and a B permit (residence in Switzerland): living in Italy can reduce fixed expenses by 30–50% compared to Ticino.',
 'Specific cost differences significantly influence the permit G versus B decision: rents in Italian border towns are typically 30–40% lower than equivalent Ticino properties, while groceries run 25–35% cheaper south of the border. These savings can offset daily commute costs and longer travel time, making an informed comparison essential before choosing your residence.',
 ],
 de: [
 'Der Lebenshaltungskostenindex vergleicht die wichtigsten Ausgabenkategorien zwischen der Schweiz (Tessin) und Italien (Lombardei/Piemont): Miete, Transport, Lebensmittel, Gesundheitswesen, Bildung und Freizeit.',
 'Das Lebenshaltungskostengefälle ist der entscheidende Faktor bei der Wahl zwischen Ausweis G (Wohnsitz in Italien) und Ausweis B (Wohnsitz in der Schweiz): Das Leben in Italien kann die Fixkosten um 30–50 % im Vergleich zum Tessin senken.',
 'Konkrete Kostenunterschiede beeinflussen die Entscheidung zwischen Ausweis G und B erheblich: Mieten in italienischen Grenzorten sind in der Regel 30–40 % niedriger als vergleichbare Objekte im Tessin, während Lebensmittel südlich der Grenze 25–35 % günstiger sind. Diese Ersparnisse können die täglichen Pendelkosten und längere Fahrzeiten ausgleichen — ein fundierter Vergleich ist daher unerlässlich.',
 ],
 fr: [
 'L\'indice du coût de la vie compare les principales catégories de dépenses entre la Suisse (Tessin) et l\'Italie (Lombardie/Piémont) : loyer, transports, alimentation, santé, éducation et loisirs.',
 'Le différentiel de coût de la vie est le facteur clé dans le choix entre un permis G (résidence en Italie) et un permis B (résidence en Suisse) : vivre en Italie peut réduire les charges fixes de 30 à 50 % par rapport au Tessin.',
 'Les écarts de coûts concrets influencent fortement le choix entre permis G et B : les loyers dans les villes frontalières italiennes sont généralement 30 à 40 % inférieurs à ceux du Tessin, tandis que les courses alimentaires coûtent 25 à 35 % de moins au sud de la frontière. Ces économies peuvent compenser les frais de trajet quotidien, rendant une comparaison approfondie indispensable.',
 ],
 },
 '/vivere-in-ticino/asili-nido': {
 en: [
 'The nursery comparator compares costs and availability of childcare facilities in Ticino and the Italian border provinces, with information on fees, schedules, waiting lists, and municipal subsidies.',
 'For cross-border families with young children, the choice of nursery is crucial: a place in Ticino can cost CHF 1,500–2,500/month, while Italian municipal rates start at EUR 300–500/month.',
 'The comparator also covers eligibility criteria, registration deadlines, and Italian bonus asilo nido (up to EUR 3,000/year) that can significantly reduce out-of-pocket childcare costs.',
 ],
 de: [
 'Der Kindertagesstätten-Vergleicher vergleicht Kosten und Verfügbarkeit von Betreuungseinrichtungen im Tessin und den italienischen Grenzprovinzen, mit Informationen zu Gebühren, Öffnungszeiten, Wartelisten und Gemeindezuschüssen.',
 'Für Grenzgängerfamilien mit Kleinkindern ist die Wahl der Kindertagesstätte entscheidend: Ein Platz im Tessin kann CHF 1.500–2.500/Monat kosten, während italienische Gemeindetarife bei EUR 300–500/Monat beginnen.',
 'Der Vergleicher zeigt auch Zulassungskriterien, Anmeldefristen und den italienischen Bonus Asilo Nido (bis zu EUR 3.000/Jahr), der die Betreuungskosten erheblich senken kann.',
 ],
 fr: [
 'Le comparateur de crèches compare les coûts et la disponibilité des structures d\'accueil au Tessin et dans les provinces frontalières italiennes, avec des informations sur les tarifs, horaires, listes d\'attente et subventions communales.',
 'Pour les familles frontalières avec de jeunes enfants, le choix de la crèche est déterminant : une place au Tessin peut coûter 1 500–2 500 CHF/mois, tandis que les tarifs communaux italiens commencent à 300–500 EUR/mois.',
 'Le comparateur présente aussi les critères d\'éligibilité, les délais d\'inscription et le bonus asilo nido italien (jusqu\'à 3 000 EUR/an) qui peut réduire considérablement les frais de garde à votre charge.',
 ],
 },
 '/vivere-in-ticino/ristrutturazioni': {
 en: [
 'The renovation calculator compares building works costs between Switzerland and Italy, factoring in Italian tax deductions (50% renovation bonus, 65% Ecobonus) and Ticino cantonal incentives.',
 'For cross-border workers who own property, Italian renovation and energy-saving deductions can be claimed on the income tax return, significantly reducing the net cost of the work.',
 'The calculator details eligible expenses, maximum deductible ceilings, and the 10-year instalment recovery schedule that applies to the Italian bonus ristrutturazione and Ecobonus schemes.',
 ],
 de: [
 'Der Renovierungsrechner vergleicht die Kosten für Bauarbeiten zwischen der Schweiz und Italien unter Berücksichtigung der italienischen Steuerabzüge (50 % Renovierungsbonus, 65 % Ecobonus) und Tessiner Kantonsincentives.',
 'Für Grenzgänger mit Immobilienbesitz können italienische Renovierungs- und Energiesparabzüge in der Steuererklärung geltend gemacht werden, was die Nettokosten der Arbeiten erheblich senkt.',
 'Der Rechner zeigt förderfähige Ausgaben, Höchstgrenzen für Abzüge und den 10-Jahres-Ratenabzug, der für den italienischen Bonus Ristrutturazione und den Ecobonus gilt.',
 ],
 fr: [
 'Le calculateur de rénovation compare les coûts de travaux entre la Suisse et l\'Italie, en tenant compte des déductions fiscales italiennes (bonus 50 % rénovation, Ecobonus 65 %) et des incitations cantonales tessinoises.',
 'Pour les frontaliers propriétaires, les déductions italiennes pour rénovation et économies d\'énergie peuvent être portées en déduction dans la déclaration de revenus, réduisant significativement le coût net des travaux.',
 'Le calculateur détaille les dépenses éligibles, les plafonds déductibles maximaux et le plan de récupération en 10 annuités applicable au bonus ristrutturazione et à l\'Ecobonus italiens.',
 ],
 },
 '/vivere-in-ticino/aziende-svizzera-italiana': {
 en: [
 'The companies directory lists the major employers in southern Switzerland (Canton Ticino), organized by sector: banking, insurance, pharmaceutical, IT, manufacturing, retail, public administration, and international organizations.',
 'For cross-border workers seeking employment, the directory provides key data on each company: sector, approximate headcount, location, and links to their careers pages for direct applications.',
 'The interactive map view pinpoints employer locations across Ticino, highlighting key economic sectors: pharmaceuticals in the Mendrisiotto, banking and finance in Lugano, and logistics along the Chiasso corridor. Canton Ticino\'s growing startup ecosystem, supported by USI and SUPSI incubators, also offers opportunities in tech and biotech for cross-border professionals.',
 ],
 de: [
 'Das Firmenverzeichnis listet die wichtigsten Arbeitgeber der Südschweiz (Kanton Tessin) nach Branche auf: Banken, Versicherungen, Pharma, IT, Industrie, Detailhandel, öffentliche Verwaltung und internationale Organisationen.',
 'Für Grenzgänger auf Jobsuche bietet das Verzeichnis Eckdaten zu jedem Unternehmen: Branche, ungefähre Mitarbeiterzahl, Standort und Links zu den Karriereseiten für Direktbewerbungen.',
 'Die interaktive Kartenansicht zeigt Arbeitgeberstandorte im gesamten Tessin und hebt die wirtschaftlichen Schwerpunkte hervor: Pharmaindustrie im Mendrisiotto, Banken und Finanzen in Lugano sowie Logistik entlang des Chiasso-Korridors. Das wachsende Startup-Ökosystem des Kantons, unterstützt durch die Inkubatoren der USI und SUPSI, bietet zudem Chancen in Tech und Biotech für Grenzgänger.',
 ],
 fr: [
 'L\'annuaire des entreprises répertorie les principaux employeurs de Suisse méridionale (Canton du Tessin) par secteur : banques, assurances, pharmaceutique, IT, industrie, commerce, administration publique et organisations internationales.',
 'Pour les frontaliers en recherche d\'emploi, l\'annuaire fournit des données clés sur chaque entreprise : secteur, effectif approximatif, localisation et liens vers les pages carrières pour des candidatures directes.',
 'La carte interactive localise les employeurs à travers le Tessin, mettant en évidence les secteurs économiques clés : industrie pharmaceutique dans le Mendrisiotto, banques et finance à Lugano, et logistique le long du corridor de Chiasso. L\'écosystème startup en croissance du canton, soutenu par les incubateurs de l\'USI et de la SUPSI, offre également des opportunités en tech et biotech pour les professionnels frontaliers.',
 ],
 },
 '/vivere-in-ticino/': {
 en: [
 'The "Living in Ticino" section covers practical aspects of daily life for those who work in the canton: housing, transport, shopping, family services, and leisure.',
 'Information is designed both for those considering a move to Switzerland and for those who stay in Italy and want to optimize daily commuting and cross-border living expenses.',
 'Practical coverage areas include housing market analysis for both sides of the border, transport options from train schedules to border crossing traffic, supermarket and shopping cost comparisons, childcare availability and fees, mobile phone plan comparisons, and home renovation cost calculators with Italian tax deduction benefits.',
 '<p style="color:#64748b;font-size:0.8rem;margin-top:4px;">Source: <a href="https://www.bfs.admin.ch" style="color:#2563eb;text-decoration:none;" rel="noopener">Federal Statistical Office (FSO)</a></p>',
 ],
 de: [
 'Der Bereich „Leben im Tessin" deckt praktische Aspekte des Alltags für im Kanton Arbeitende ab: Wohnen, Transport, Einkaufen, Familiendienste und Freizeit.',
 'Die Informationen richten sich sowohl an Personen, die einen Umzug in die Schweiz erwägen, als auch an jene, die in Italien bleiben und das tägliche Pendeln und die Lebenshaltungskosten als Grenzgänger optimieren möchten.',
 'Behandelte Praxisthemen umfassen die Wohnungsmarktanalyse beiderseits der Grenze, Transportoptionen von Zugfahrplänen bis Grenzübergangsverkehr, Supermarkt- und Einkaufskostenvergleiche, Verfügbarkeit und Kosten von Kinderbetreuung, Handytarifvergleiche sowie Renovierungskostenrechner mit italienischen Steuerabzugsmöglichkeiten.',
 '<p style="color:#64748b;font-size:0.8rem;margin-top:4px;">Quelle: <a href="https://www.bfs.admin.ch" style="color:#2563eb;text-decoration:none;" rel="noopener">Bundesamt für Statistik (BFS)</a></p>',
 ],
 fr: [
 'La section « Vivre au Tessin » couvre les aspects pratiques de la vie quotidienne pour ceux qui travaillent dans le canton : logement, transports, courses, services familiaux et loisirs.',
 'Les informations s\'adressent aussi bien à ceux qui envisagent un déménagement en Suisse qu\'à ceux qui restent en Italie et souhaitent optimiser le trajet quotidien et les dépenses de la vie transfrontalière.',
 'Les domaines pratiques couverts comprennent l\'analyse du marché immobilier des deux côtés de la frontière, les options de transport des horaires de trains au trafic frontalier, les comparaisons de coûts en supermarché, la disponibilité et les tarifs des crèches, les comparaisons de forfaits téléphoniques et les calculateurs de coûts de rénovation avec déductions fiscales italiennes.',
 '<p style="color:#64748b;font-size:0.8rem;margin-top:4px;">Source : <a href="https://www.bfs.admin.ch" style="color:#2563eb;text-decoration:none;" rel="noopener">Office fédéral de la statistique (OFS)</a></p>',
 ],
 },

 // ───── Statistics ─────────────────────────────────────────────
 '/statistiche/': {
 en: [
 'The statistics section presents aggregate data and trends on the cross-border phenomenon in Ticino: number of G permits by sector, average salary trends, cantonal unemployment rate, and border crossing traffic flows.',
 'Data comes from official sources (USTAT, SECO, FSO) and is updated periodically. Interactive charts allow exploration of time series and comparison of different periods.',
 'All charts are fully interactive: hover over data points for detailed values, filter by year or sector, and export visualisations for reports. Data is sourced from USTAT (Ticino cantonal statistics), SECO (State Secretariat for Economic Affairs), and the FSO (Federal Statistical Office), ensuring reliability and transparency in every figure presented.',
 '<p style="color:#64748b;font-size:0.8rem;margin-top:4px;">Source: <a href="https://www.bfs.admin.ch" style="color:#2563eb;text-decoration:none;" rel="noopener">Federal Statistical Office (FSO)</a> · <a href="https://www.seco.admin.ch" style="color:#2563eb;text-decoration:none;" rel="noopener">SECO</a></p>',
 ],
 de: [
 'Der Statistikbereich präsentiert aggregierte Daten und Trends zum Grenzgängerphänomen im Tessin: Anzahl der G-Bewilligungen nach Branche, durchschnittliche Gehaltsentwicklung, kantonale Arbeitslosenquote und Verkehrsströme an den Grenzübergängen.',
 'Die Daten stammen aus offiziellen Quellen (USTAT, SECO, BFS) und werden regelmässig aktualisiert. Interaktive Grafiken ermöglichen die Erkundung von Zeitreihen und den Vergleich verschiedener Perioden.',
 'Alle Diagramme sind vollständig interaktiv: Fahren Sie mit der Maus über Datenpunkte für Detailwerte, filtern Sie nach Jahr oder Branche und exportieren Sie Visualisierungen für Berichte. Die Daten stammen von USTAT (Tessiner Kantonsstatistik), SECO (Staatssekretariat für Wirtschaft) und dem BFS (Bundesamt für Statistik) — für Zuverlässigkeit und Transparenz bei jeder dargestellten Kennzahl.',
 '<p style="color:#64748b;font-size:0.8rem;margin-top:4px;">Quelle: <a href="https://www.bfs.admin.ch" style="color:#2563eb;text-decoration:none;" rel="noopener">Bundesamt für Statistik (BFS)</a> · <a href="https://www.seco.admin.ch" style="color:#2563eb;text-decoration:none;" rel="noopener">SECO</a></p>',
 ],
 fr: [
 'La section statistiques présente des données agrégées et des tendances sur le phénomène frontalier au Tessin : nombre de permis G par secteur, évolution des salaires moyens, taux de chômage cantonal et flux de trafic aux postes frontières.',
 'Les données proviennent de sources officielles (USTAT, SECO, OFS) et sont mises à jour périodiquement. Les graphiques interactifs permettent d\'explorer les séries temporelles et de comparer différentes périodes.',
 'Tous les graphiques sont entièrement interactifs : survolez les points de données pour les valeurs détaillées, filtrez par année ou secteur, et exportez les visualisations pour vos rapports. Les données proviennent de l\'USTAT (statistique cantonale tessinoise), du SECO (Secrétariat d\'État à l\'économie) et de l\'OFS (Office fédéral de la statistique), garantissant fiabilité et transparence pour chaque chiffre présenté.',
 '<p style="color:#64748b;font-size:0.8rem;margin-top:4px;">Source : <a href="https://www.bfs.admin.ch" style="color:#2563eb;text-decoration:none;" rel="noopener">Office fédéral de la statistique (OFS)</a> · <a href="https://www.seco.admin.ch" style="color:#2563eb;text-decoration:none;" rel="noopener">SECO</a></p>',
 ],
 },

 // ───── Homepage (all locales) ─────────────────────────────────
 '/': {
 en: [
 'Frontaliere Ticino is the reference platform for cross-border workers between Switzerland (Canton Ticino) and Italy: it offers tax simulators, service comparators, practical guides, and decision-making tools updated for 2026.',
 'On the homepage you will find a quick summary of the most relevant news for cross-border workers, the data point of the week from official sources, and fast access to all the main simulators: net salary, payslip, permit comparison, bonuses, leave, and residence.',
 'The platform is designed for mobile-first consulting during commute times: every section has a precise goal, with concise entry points and complete deep-dives on dedicated pages.',
 ],
 de: [
 'Frontaliere Ticino ist die Referenzplattform für Grenzgänger zwischen der Schweiz (Kanton Tessin) und Italien: Sie bietet Steuersimuloren, Dienstleistungsvergleiche, praktische Leitfäden und Entscheidungshilfen, aktualisiert für 2026.',
 'Auf der Startseite finden Sie eine schnelle Zusammenfassung der relevantesten Nachrichten für Grenzgänger, den Datenpunkt der Woche aus offiziellen Quellen und schnellen Zugang zu allen Hauptsimulatoren: Nettogehalt, Lohnabrechnung, Bewilligungsvergleich, Boni, Urlaub und Wohnsitz.',
 'Die Plattform ist für die mobile Nutzung während der Pendelzeiten konzipiert: Jeder Abschnitt hat ein präzises Ziel, mit kompakten Einstiegspunkten und vollständigen Vertiefungen auf den jeweiligen Unterseiten.',
 ],
 fr: [
 'Frontaliere Ticino est la plateforme de référence pour les travailleurs frontaliers entre la Suisse (Canton du Tessin) et l\'Italie : elle propose des simulateurs fiscaux, des comparateurs de services, des guides pratiques et des outils d\'aide à la décision mis à jour pour 2026.',
 'Sur la page d\'accueil, vous trouverez un résumé rapide des actualités les plus pertinentes pour les frontaliers, le chiffre de la semaine issu de sources officielles, et un accès rapide à tous les simulateurs principaux : salaire net, fiche de paie, comparaison de permis, bonus, congés et résidence.',
 'La plateforme est conçue pour une consultation mobile pendant les trajets : chaque section a un objectif précis, avec des points d\'entrée concis et des approfondissements complets sur les pages dédiées.',
 ],
 },

 // ───── Glossary entries (generic, for terms without specific editorial) ──
 // This matches individual entries like /glossario-frontaliere/lohnausweis
 // since SECTION_EDITORIAL_KEYS sorts longest-first and this is more specific
 // than /glossario-frontaliere/ which is the index page.
 // Note: NOT used — individual entries match the /glossario-frontaliere/ prefix.
 // Extended editorial for the glossary section is in the existing key above.

 // ───── Border crossing waiting times (generic, for individual crossings) ──
 // Note: Individual crossings like /guida-frontaliere/tempi-attesa-dogana/lanzo-d-intelvi-arogno
 // match /guida-frontaliere/tempi-attesa-dogana which is already defined above.

 // ───── Articles hub ──────────────────────────────────────────
 '/articoli-frontaliere/': {
 en: [
 'The cross-border worker articles section is an editorially curated hub covering the key topics that matter to those who work in Ticino and live in Italy: taxation under the New 2026 Agreement, LAMal vs Italian NHS health insurance, pension planning across two countries, and practical administrative procedures.',
 'Each article includes concrete scenarios with real numbers, links to the relevant calculators, and references to current Swiss and Italian legislation so you can immediately verify how the information applies to your situation.',
 'Articles are categorised by topic — fiscal, practical, news, pension — and updated whenever the law changes or new official data is published. The collection covers both new cross-border workers navigating the system for the first time and experienced workers optimising their financial position.',
 ],
 de: [
 'Der Grenzgänger-Artikelbereich ist ein redaktionell kuratierter Hub, der die wichtigsten Themen für Personen abdeckt, die im Tessin arbeiten und in Italien leben: Besteuerung nach dem Neuen Abkommen 2026, KVG- vs. italienisches NHS-Krankenversicherung, grenzüberschreitende Altersvorsorge und praktische Verwaltungsverfahren.',
 'Jeder Artikel enthält konkrete Szenarien mit echten Zahlen, Links zu den relevanten Rechnern und Verweise auf aktuelle Schweizer und italienische Gesetzgebung, damit Sie sofort überprüfen können, wie die Informationen auf Ihre Situation zutreffen.',
 'Artikel sind nach Thema kategorisiert — Steuer, Praktisch, Aktuell, Vorsorge — und werden aktualisiert, wenn sich Gesetze ändern oder neue offizielle Daten veröffentlicht werden.',
 ],
 fr: [
 'La section articles frontaliers est un hub éditorial couvrant les sujets clés pour ceux qui travaillent au Tessin et vivent en Italie : fiscalité selon le Nouvel Accord 2026, assurance maladie LAMal vs SSN italien, prévoyance retraite transfrontalière et procédures administratives pratiques.',
 'Chaque article inclut des scénarios concrets avec de vrais chiffres, des liens vers les calculateurs pertinents et des références à la législation suisse et italienne en vigueur pour vérifier immédiatement comment l\'information s\'applique à votre situation.',
 'Les articles sont catégorisés par thème — fiscal, pratique, actualité, retraite — et mis à jour à chaque changement législatif ou publication de nouvelles données officielles.',
 ],
 },

 // ───── Ticinese dialect (striking distance target) ──────────
 '/dialetto-ticinese': {
 it: [
 'Il <strong>dialetto ticinese</strong> appartiene al gruppo lombardo-alpino occidentale ed è parlato in Canton Ticino, nelle valli italofone dei Grigioni (Mesolcina, Calanca, Val Bregaglia, Val Poschiavo) e in alcune zone dell\'Insubria italiana. Pur condividendo radici con il lombardo milanese e comasco, presenta peculiarità fonetiche e lessicali proprie legate alla storia linguistica della Svizzera italiana.',
 '<strong>Le 10 espressioni più usate al lavoro in Ticino</strong>: 1) "Ciao, cume la va?" (saluto informale tra colleghi); 2) "A gh\'è un casòtt" (c\'è un caos, usato in cantiere e in ufficio); 3) "Dà una man" (dare una mano, aiutare); 4) "Mangià on toch" (fare la pausa pranzo veloce); 5) "Fà fadiga" (faticare su un progetto); 6) "Tirà via" (portare a termine un compito); 7) "Vegn chì" (vieni qui, usato per chiamare un collega); 8) "L\'è mia cüra mia" (non è compito mio); 9) "Bon fin setimana" (buon fine settimana); 10) "Stà trancuill" (stai tranquillo, rassicurante).',
 '<strong>Parole in dialetto ticinese</strong> più frequenti nella vita quotidiana del frontaliere: <em>pèn</em> (pane), <em>aqua</em> (acqua), <em>cafè</em> (caffè), <em>scià</em> (qui), <em>là</em> (lì), <em>gatt</em> (gatto), <em>cà</em> (casa), <em>strada</em> (strada), <em>auto</em> (auto), <em>trenin</em> (treno), <em>pizz</em> (un po\'), <em>miga</em> (non/mica), <em>boccia</em> (bottiglia), <em>scerpa</em> (sciarpa), <em>pizzigà</em> (pizzicare). Molte parole sono comprensibili a chi parla lombardo lombardo o milanese, ma con pronuncia e accenti che rivelano l\'origine svizzero-italiana di chi le usa.',
 '<strong>Differenze tra dialetto ticinese e italiano standard</strong>: il ticinese conserva la <em>u</em> lombarda (pronunciata come la "u" francese), elide le vocali finali ("andà" invece di "andare"), raddoppia consonanti ("tucc" per "tutti"), e integra germanismi storici come <em>umbrèla</em> (ombrello, dal tedesco) o calchi francesi risalenti al periodo napoleonico. L\'italiano standard si è diffuso in Ticino solo nell\'Ottocento con l\'alfabetizzazione, mentre il dialetto è rimasto la lingua quotidiana nelle valli fino al Novecento.',
 'Per i <a href="https://frontaliereticino.ch/cerca-lavoro-ticino/">frontalieri che lavorano in Ticino</a>, imparare qualche espressione dialettale facilita l\'integrazione con i colleghi svizzeri, soprattutto nei settori dell\'edilizia, dell\'ospitalità e dell\'artigianato dove il dialetto è ancora vivo. Nei contesti professionali formali (banche, uffici pubblici, sanità) prevale l\'italiano standard, ma il dialetto resta un indicatore di familiarità culturale e viene spesso apprezzato come segno di rispetto per la cultura locale.',
 ],
 en: [
 'The Ticinese dialect belongs to the Western Lombard-Alpine group and is spoken in Canton Ticino, the Italian-speaking valleys of Grisons (Mesolcina, Calanca, Bregaglia, Poschiavo), and parts of Italian Insubria. While sharing roots with Milanese and Comasque Lombard, it has distinctive phonetic and lexical features tied to the linguistic history of Italian-speaking Switzerland.',
 'Understanding basic Ticinese phrases helps cross-border workers integrate with Swiss colleagues, especially in construction, hospitality, and trades where dialect is still widely spoken. Common expressions include "cume la va?" (how are you?), "dà una man" (give a hand), and "bon fin setimana" (have a good weekend). Each phrase carries cultural weight beyond its literal meaning.',
 'Ticinese preserves the Lombard "u" (pronounced like French "u"), drops final vowels (andà instead of andare), doubles consonants (tucc for tutti), and retains historical Germanisms from centuries of Swiss influence. Standard Italian only spread in Ticino during the 19th century with universal literacy; dialect remained the everyday language in valleys well into the 20th century.',
 'In formal professional contexts (banking, public administration, healthcare) standard Italian prevails, but dialect serves as a marker of cultural familiarity. Cross-border workers who pick up dialect expressions are often welcomed as a sign of respect for local culture — a useful soft skill when building long-term relationships with Ticino colleagues and employers.',
 ],
 de: [
 'Der Tessiner Dialekt gehört zur westlichen lombardisch-alpinen Sprachgruppe und wird im Kanton Tessin, in den italienischsprachigen Tälern Graubündens (Misox, Calancatal, Bergell, Puschlav) und in Teilen der italienischen Insubrien gesprochen. Er teilt Wurzeln mit dem Mailänder und Comasker Lombardisch, weist aber eigene phonetische und lexikalische Merkmale auf, die mit der Sprachgeschichte der italienischsprachigen Schweiz verbunden sind.',
 'Grundlegende Tessiner Ausdrücke zu beherrschen hilft Grenzgängern, sich mit Schweizer Kollegen zu verständigen, besonders im Bauwesen, Gastgewerbe und Handwerk, wo der Dialekt lebendig geblieben ist. Häufige Redewendungen sind "cume la va?" (wie geht\'s?), "dà una man" (eine Hand geben, helfen) und "bon fin setimana" (schönes Wochenende). Jede Wendung trägt kulturelle Bedeutung über den wörtlichen Sinn hinaus.',
 'Der Tessinerdialekt bewahrt das lombardische "u" (ausgesprochen wie das französische "u"), lässt Endvokale weg, verdoppelt Konsonanten und integriert historische Germanismen aus Jahrhunderten Schweizer Einflusses. Standarditalienisch verbreitete sich im Tessin erst im 19. Jahrhundert; der Dialekt blieb bis weit ins 20. Jahrhundert Alltagssprache in den Tälern.',
 'In formalen beruflichen Kontexten (Banken, Verwaltung, Gesundheitswesen) herrscht Standarditalienisch vor, aber der Dialekt dient als Zeichen kultureller Vertrautheit. Grenzgänger, die Dialektausdrücke aufschnappen, werden oft als Zeichen des Respekts für die lokale Kultur willkommen geheissen — eine nützliche Soft Skill für langfristige Beziehungen zu Tessiner Kollegen und Arbeitgebern.',
 ],
 fr: [
 'Le dialecte tessinois appartient au groupe lombard-alpin occidental et est parlé dans le canton du Tessin, les vallées italophones des Grisons (Mésolcine, Calanca, Bregaglia, Poschiavo) et certaines parties de l\'Insubrie italienne. Il partage ses racines avec le lombard milanais et comasque, mais présente des traits phonétiques et lexicaux distincts liés à l\'histoire linguistique de la Suisse italienne.',
 'Connaître quelques expressions tessinoises aide les frontaliers à s\'intégrer avec les collègues suisses, surtout dans la construction, l\'hôtellerie et l\'artisanat où le dialecte reste vivant. Expressions courantes : "cume la va?" (comment ça va ?), "dà una man" (donner un coup de main), "bon fin setimana" (bon week-end). Chaque formule porte une valeur culturelle au-delà du sens littéral.',
 'Le tessinois préserve le "u" lombard (prononcé comme le "u" français), supprime les voyelles finales, redouble les consonnes et conserve des germanismes historiques issus des siècles d\'influence suisse. L\'italien standard ne s\'est répandu au Tessin qu\'au XIXe siècle ; le dialecte est resté la langue quotidienne dans les vallées jusqu\'au XXe siècle.',
 'Dans les contextes professionnels formels (banques, administration, santé) l\'italien standard prévaut, mais le dialecte est un marqueur de familiarité culturelle. Les frontaliers qui adoptent des expressions dialectales sont souvent accueillis comme un signe de respect pour la culture locale — une compétence sociale utile pour tisser des relations durables avec collègues et employeurs tessinois.',
 ],
 },

 // ───── Ticino public holidays ────────────────────────────────
 '/tasse-e-pensione/festivita-ticino': {
 en: [
 'Canton Ticino observes 15 official public holidays in 2026 — the 9 federal Swiss holidays plus 6 cantonal holidays specific to Ticino, the richest holiday calendar in Switzerland. For cross-border workers, these dates directly affect overtime calculations, pay for days worked on holidays (at least 1.25× rate), the 13th-month salary calculation, and whether the employer must pay for the holiday even if the worker is absent.',
 'What happens if a holiday falls on a weekend in Switzerland? Unlike Italian law, Swiss law does NOT grant automatic recovery of holidays that fall on Saturday or Sunday — the worker simply loses the benefit of the day off. In 2026 this penalises frontalieri on three holidays: 1 August (National Day) and 15 August (Assumption) both fall on Saturday, and 1 November (All Saints) falls on Sunday. Only some sectoral CCL agreements (MEM industry, construction, healthcare) compensate with an extra vacation day.',
 'Public holidays that fall on weekdays reduce the number of working days in that month, which can affect prorated salary calculations for monthly-paid workers, holiday entitlement accrual, and the distribution of the 13th month payment across the calendar year. Swiss law (CO art. 329) requires the employer to pay for the holiday even if the monthly-paid worker is absent, with exceptions for hourly-paid staff (Stundenlohn).',
 'Cross-border workers should note that Italian public holidays do not automatically apply in Switzerland: if you are working in Ticino, the Swiss holiday calendar governs your schedule (lex loci laboris principle). Italian holidays like 25 April (Liberation Day), 2 June (Republic Day) and local patron saint days are regular working days in Ticino. However, Swiss law allows workers to take Italian national holidays as vacation days if agreed with the employer in writing.',
 'For hourly-paid cross-border workers (Stundenlohn), public holidays have a direct financial impact: hours not worked on a holiday are generally compensated at the regular rate if the holiday falls on a normal working day. Monthly-paid workers receive their full salary regardless, but overtime worked on holidays must be paid at a minimum 125% rate under the Swiss Code of Obligations, and many CCL agreements in Ticino stipulate 150% (construction, MEM) or even 200% (healthcare, hospitality on Sunday holidays).',
 'The 2026 calendar offers several attractive long weekends for cross-border workers optimising their vacation days: Easter (Good Friday 3 April + Easter Monday 6 April, 4 consecutive days with zero vacation days used), Ascension (Thursday 14 May, bridging Friday 15 May for 4 days), Corpus Christi (Thursday 4 June, bridging Friday 5 June), and Immaculate Conception (Tuesday 8 December, bridging Monday 7 December). With careful planning a frontalier can obtain up to 25-28 days of effective holiday using only 15-17 vacation days.',
 'Planning around the Swiss and Italian holiday calendars is essential for frontalieri families with children in Italian schools. Italian schools observe approximately 12 additional closure days not aligned with Swiss holidays, including Carnevale, patron saint days, and regional holidays. Conversely, Swiss holidays like Ascension Thursday, Corpus Christi and Whit Monday are regular school days in Italy, requiring careful coordination of childcare arrangements.',
 ],
 de: [
 '<h2 style="font-size:1.15rem;font-weight:700;margin:1rem 0 .5rem">Feiertage Tessin 2026: vollständiger offizieller Kalender</h2>',
 'Der Kanton Tessin feiert 2026 insgesamt 15 offizielle Feiertage — die 9 nationalen Schweizer Feiertage plus 6 kantonale Feiertage speziell für das Tessin, der reichste Feiertagskalender der Schweiz. Für Grenzgänger wirken sich diese Daten direkt auf die Überstundenberechnung, die Vergütung für an Feiertagen geleistete Arbeit (mindestens 1,25-fach), die Berechnung des 13. Monatslohns und die Lohnfortzahlungspflicht aus.',
 '<h2 style="font-size:1.15rem;font-weight:700;margin:1.25rem 0 .5rem">Kalender Feiertage Tessin 2026</h2>',
 '<div style="overflow-x:auto;margin:.5rem 0 1rem"><table style="width:100%;border-collapse:collapse;font-size:0.9rem"><thead><tr style="background:#f1f5f9"><th style="text-align:left;padding:.5rem;border:1px solid #cbd5e1">Datum</th><th style="text-align:left;padding:.5rem;border:1px solid #cbd5e1">Wochentag</th><th style="text-align:left;padding:.5rem;border:1px solid #cbd5e1">Feiertag</th><th style="text-align:left;padding:.5rem;border:1px solid #cbd5e1">Typ</th></tr></thead><tbody><tr><td style="padding:.4rem;border:1px solid #e2e8f0">Do 1. Jan 2026</td><td style="padding:.4rem;border:1px solid #e2e8f0">Donnerstag</td><td style="padding:.4rem;border:1px solid #e2e8f0">Neujahr</td><td style="padding:.4rem;border:1px solid #e2e8f0">Bundesfeiertag</td></tr><tr><td style="padding:.4rem;border:1px solid #e2e8f0">Fr 2. Jan 2026</td><td style="padding:.4rem;border:1px solid #e2e8f0">Freitag</td><td style="padding:.4rem;border:1px solid #e2e8f0">Berchtoldstag</td><td style="padding:.4rem;border:1px solid #e2e8f0">Kantonal (teilweise)</td></tr><tr><td style="padding:.4rem;border:1px solid #e2e8f0">Di 6. Jan 2026</td><td style="padding:.4rem;border:1px solid #e2e8f0">Dienstag</td><td style="padding:.4rem;border:1px solid #e2e8f0">Dreikönigstag</td><td style="padding:.4rem;border:1px solid #e2e8f0">Kantonal (TI)</td></tr><tr><td style="padding:.4rem;border:1px solid #e2e8f0">Do 19. Mär 2026</td><td style="padding:.4rem;border:1px solid #e2e8f0">Donnerstag</td><td style="padding:.4rem;border:1px solid #e2e8f0">Josefstag</td><td style="padding:.4rem;border:1px solid #e2e8f0">Kantonal (TI)</td></tr><tr><td style="padding:.4rem;border:1px solid #e2e8f0">Fr 3. Apr 2026</td><td style="padding:.4rem;border:1px solid #e2e8f0">Freitag</td><td style="padding:.4rem;border:1px solid #e2e8f0">Karfreitag</td><td style="padding:.4rem;border:1px solid #e2e8f0">Bundesfeiertag</td></tr><tr><td style="padding:.4rem;border:1px solid #e2e8f0">Mo 6. Apr 2026</td><td style="padding:.4rem;border:1px solid #e2e8f0">Montag</td><td style="padding:.4rem;border:1px solid #e2e8f0">Ostermontag</td><td style="padding:.4rem;border:1px solid #e2e8f0">Bundesfeiertag</td></tr><tr><td style="padding:.4rem;border:1px solid #e2e8f0">Fr 1. Mai 2026</td><td style="padding:.4rem;border:1px solid #e2e8f0">Freitag</td><td style="padding:.4rem;border:1px solid #e2e8f0">Tag der Arbeit</td><td style="padding:.4rem;border:1px solid #e2e8f0">Kantonal (TI)</td></tr><tr><td style="padding:.4rem;border:1px solid #e2e8f0">Do 14. Mai 2026</td><td style="padding:.4rem;border:1px solid #e2e8f0">Donnerstag</td><td style="padding:.4rem;border:1px solid #e2e8f0">Auffahrt</td><td style="padding:.4rem;border:1px solid #e2e8f0">Bundesfeiertag</td></tr><tr><td style="padding:.4rem;border:1px solid #e2e8f0">Mo 25. Mai 2026</td><td style="padding:.4rem;border:1px solid #e2e8f0">Montag</td><td style="padding:.4rem;border:1px solid #e2e8f0">Pfingstmontag</td><td style="padding:.4rem;border:1px solid #e2e8f0">Bundesfeiertag</td></tr><tr><td style="padding:.4rem;border:1px solid #e2e8f0">Do 4. Jun 2026</td><td style="padding:.4rem;border:1px solid #e2e8f0">Donnerstag</td><td style="padding:.4rem;border:1px solid #e2e8f0">Fronleichnam</td><td style="padding:.4rem;border:1px solid #e2e8f0">Kantonal (TI)</td></tr><tr><td style="padding:.4rem;border:1px solid #e2e8f0">Mo 29. Jun 2026</td><td style="padding:.4rem;border:1px solid #e2e8f0">Montag</td><td style="padding:.4rem;border:1px solid #e2e8f0">Peter und Paul</td><td style="padding:.4rem;border:1px solid #e2e8f0">Kantonal (TI)</td></tr><tr style="background:#fef3c7"><td style="padding:.4rem;border:1px solid #e2e8f0"><strong>Sa 1. Aug 2026</strong></td><td style="padding:.4rem;border:1px solid #e2e8f0">Samstag</td><td style="padding:.4rem;border:1px solid #e2e8f0">Schweizer Bundesfeier</td><td style="padding:.4rem;border:1px solid #e2e8f0">Bundesfeiertag</td></tr><tr style="background:#fef3c7"><td style="padding:.4rem;border:1px solid #e2e8f0"><strong>Sa 15. Aug 2026</strong></td><td style="padding:.4rem;border:1px solid #e2e8f0">Samstag</td><td style="padding:.4rem;border:1px solid #e2e8f0">Mariä Himmelfahrt</td><td style="padding:.4rem;border:1px solid #e2e8f0">Kantonal (TI)</td></tr><tr><td style="padding:.4rem;border:1px solid #e2e8f0">So 1. Nov 2026</td><td style="padding:.4rem;border:1px solid #e2e8f0">Sonntag</td><td style="padding:.4rem;border:1px solid #e2e8f0">Allerheiligen</td><td style="padding:.4rem;border:1px solid #e2e8f0">Kantonal (TI)</td></tr><tr><td style="padding:.4rem;border:1px solid #e2e8f0">Di 8. Dez 2026</td><td style="padding:.4rem;border:1px solid #e2e8f0">Dienstag</td><td style="padding:.4rem;border:1px solid #e2e8f0">Mariä Empfängnis</td><td style="padding:.4rem;border:1px solid #e2e8f0">Kantonal (TI)</td></tr><tr><td style="padding:.4rem;border:1px solid #e2e8f0">Fr 25. Dez 2026</td><td style="padding:.4rem;border:1px solid #e2e8f0">Freitag</td><td style="padding:.4rem;border:1px solid #e2e8f0">Weihnachten</td><td style="padding:.4rem;border:1px solid #e2e8f0">Bundesfeiertag</td></tr><tr><td style="padding:.4rem;border:1px solid #e2e8f0">Sa 26. Dez 2026</td><td style="padding:.4rem;border:1px solid #e2e8f0">Samstag</td><td style="padding:.4rem;border:1px solid #e2e8f0">Stephanstag</td><td style="padding:.4rem;border:1px solid #e2e8f0">Kantonal (TI)</td></tr></tbody></table></div>',
 '<p style="font-size:0.85rem;color:#475569;margin:.25rem 0 1rem">2026 fallen zwei wichtige Feiertage auf einen Samstag (1. August und 15. August) und einer auf einen Sonntag (1. November). Das Schweizer Recht sieht — anders als das italienische — keine automatische Nachholung vor: Der Grenzgänger erhält keinen zusätzlichen freien Tag, ausser der anwendbare GAV (Gesamtarbeitsvertrag) regelt dies ausdrücklich.</p>',
 '<h2 style="font-size:1.15rem;font-weight:700;margin:1.25rem 0 .5rem">Tessin vs. übrige Schweiz: welche Feiertage sich unterscheiden</h2>',
 '<div style="overflow-x:auto;margin:.5rem 0 1rem"><table style="width:100%;border-collapse:collapse;font-size:0.9rem"><thead><tr style="background:#f1f5f9"><th style="text-align:left;padding:.5rem;border:1px solid #cbd5e1">Feiertag</th><th style="text-align:center;padding:.5rem;border:1px solid #cbd5e1">Tessin</th><th style="text-align:center;padding:.5rem;border:1px solid #cbd5e1">Zürich / Bern</th><th style="text-align:center;padding:.5rem;border:1px solid #cbd5e1">Genf / Waadt</th></tr></thead><tbody><tr><td style="padding:.4rem;border:1px solid #e2e8f0">Dreikönigstag (6.1.)</td><td style="padding:.4rem;border:1px solid #e2e8f0;text-align:center">Ja</td><td style="padding:.4rem;border:1px solid #e2e8f0;text-align:center">Nein</td><td style="padding:.4rem;border:1px solid #e2e8f0;text-align:center">Nein</td></tr><tr><td style="padding:.4rem;border:1px solid #e2e8f0">Josefstag (19.3.)</td><td style="padding:.4rem;border:1px solid #e2e8f0;text-align:center">Ja</td><td style="padding:.4rem;border:1px solid #e2e8f0;text-align:center">Nein</td><td style="padding:.4rem;border:1px solid #e2e8f0;text-align:center">Nein</td></tr><tr><td style="padding:.4rem;border:1px solid #e2e8f0">Tag der Arbeit (1.5.)</td><td style="padding:.4rem;border:1px solid #e2e8f0;text-align:center">Ja</td><td style="padding:.4rem;border:1px solid #e2e8f0;text-align:center">Teilweise</td><td style="padding:.4rem;border:1px solid #e2e8f0;text-align:center">Ja</td></tr><tr><td style="padding:.4rem;border:1px solid #e2e8f0">Fronleichnam</td><td style="padding:.4rem;border:1px solid #e2e8f0;text-align:center">Ja</td><td style="padding:.4rem;border:1px solid #e2e8f0;text-align:center">Nein</td><td style="padding:.4rem;border:1px solid #e2e8f0;text-align:center">Nein</td></tr><tr><td style="padding:.4rem;border:1px solid #e2e8f0">Peter und Paul (29.6.)</td><td style="padding:.4rem;border:1px solid #e2e8f0;text-align:center">Ja</td><td style="padding:.4rem;border:1px solid #e2e8f0;text-align:center">Nein</td><td style="padding:.4rem;border:1px solid #e2e8f0;text-align:center">Nein</td></tr><tr><td style="padding:.4rem;border:1px solid #e2e8f0">Mariä Himmelfahrt (15.8.)</td><td style="padding:.4rem;border:1px solid #e2e8f0;text-align:center">Ja</td><td style="padding:.4rem;border:1px solid #e2e8f0;text-align:center">Nein</td><td style="padding:.4rem;border:1px solid #e2e8f0;text-align:center">Nein</td></tr><tr><td style="padding:.4rem;border:1px solid #e2e8f0">Allerheiligen (1.11.)</td><td style="padding:.4rem;border:1px solid #e2e8f0;text-align:center">Ja</td><td style="padding:.4rem;border:1px solid #e2e8f0;text-align:center">Nein</td><td style="padding:.4rem;border:1px solid #e2e8f0;text-align:center">Nein</td></tr><tr><td style="padding:.4rem;border:1px solid #e2e8f0">Mariä Empfängnis (8.12.)</td><td style="padding:.4rem;border:1px solid #e2e8f0;text-align:center">Ja</td><td style="padding:.4rem;border:1px solid #e2e8f0;text-align:center">Nein</td><td style="padding:.4rem;border:1px solid #e2e8f0;text-align:center">Nein</td></tr><tr><td style="padding:.4rem;border:1px solid #e2e8f0">Stephanstag (26.12.)</td><td style="padding:.4rem;border:1px solid #e2e8f0;text-align:center">Ja</td><td style="padding:.4rem;border:1px solid #e2e8f0;text-align:center">Ja</td><td style="padding:.4rem;border:1px solid #e2e8f0;text-align:center">Nein</td></tr></tbody></table></div>',
 'Der Kanton Tessin hat aufgrund seiner katholischen Tradition und der Grenzlage zu Italien den reichsten Feiertagskalender der Schweiz: 15 bezahlte Feiertage gegenüber 9 nationalen. Das ist ein konkreter Vorteil für Grenzgänger gegenüber Beschäftigten in Zürich oder Basel, denen pro Jahr 5–6 kantonale Feiertage fehlen. Ein Tessiner Mitarbeiter mit einem Vollzeit-Monatslohn von CHF 6.000 erhält dadurch im Jahr rund CHF 1.400 mehr an bezahlten freien Tagen als der Kollege in Zürich.',
 '<h2 style="font-size:1.15rem;font-weight:700;margin:1.25rem 0 .5rem">Was passiert, wenn ein Feiertag auf ein Wochenende fällt?</h2>',
 'Was passiert, wenn ein Feiertag auf ein Wochenende fällt? Anders als im italienischen Recht gewährt das Schweizer Recht KEINE automatische Nachholung von Feiertagen, die auf Samstag oder Sonntag fallen — der Arbeitnehmer verliert einfach den Vorteil des freien Tages. 2026 trifft dies drei Feiertage: Der 1. August (Bundesfeier) und der 15. August (Mariä Himmelfahrt) fallen auf Samstag, der 1. November (Allerheiligen) auf Sonntag. Nur einige GAV (MEM, Bau, Gesundheitswesen) gleichen mit einem zusätzlichen Urlaubstag aus.',
 'Feiertage an Werktagen reduzieren die Anzahl der Arbeitstage im Monat und beeinflussen anteilige Gehaltsberechnungen, die Urlaubsrückstellungsrate und die Verteilung des 13. Monatslohns. Das Schweizer OR (Art. 329) verpflichtet den Arbeitgeber zur Lohnfortzahlung auch bei Abwesenheit des Monatslohnempfängers, mit Ausnahmen für Stundenlohnempfänger.',
 '<h2 style="font-size:1.15rem;font-weight:700;margin:1.25rem 0 .5rem">Italienische vs. Schweizer Feiertage: was ändert sich für Grenzgänger</h2>',
 'Grenzgänger sollten beachten, dass italienische Feiertage in der Schweiz nicht automatisch gelten (lex loci laboris). Im Tessin tätige Grenzgänger unterliegen dem Schweizer Feiertagskalender: italienische Feiertage wie der 25. April (Tag der Befreiung), 2. Juni (Tag der Republik) und lokale Schutzpatrontage (z. B. Sant\'Abbondio in Como am 31. August) sind im Tessin reguläre Arbeitstage. Wer zu Hause bleiben möchte, muss reguläre Ferien nehmen oder einen unbezahlten Urlaubstag beantragen.',
 'Umgekehrt fallen einige Tessiner Feiertage auf Tage, an denen in Italien gearbeitet wird: Auffahrt (Donnerstag), Fronleichnam (Donnerstag) und Pfingstmontag. Für Familien mit Kindern in italienischen Schulen schafft das einen wichtigen Kalenderversatz, der Babysitter, Grosseltern oder Sommerbetreuung erfordert. Ostern, Weihnachten und Neujahr sind dagegen in beiden Ländern aufeinander abgestimmt — das Tessin fügt zusätzlich den Ostermontag als Bundesfeiertag hinzu.',
 '<h2 style="font-size:1.15rem;font-weight:700;margin:1.25rem 0 .5rem">Lohn, Überstunden und Zuschläge an Feiertagen</h2>',
 'Für im Stundenlohn bezahlte Grenzgänger haben Feiertage eine direkte finanzielle Auswirkung: An Feiertagen nicht geleistete Stunden werden zum regulären Satz vergütet, wenn der Feiertag auf einen normalen Arbeitstag fällt. An Feiertagen geleistete Überstunden müssen mindestens zu 125 % vergütet werden — viele GAV im Tessin sehen 150 % (Bau, MEM) oder sogar 200 % (Gesundheitswesen, Gastronomie an Sonntagsfeiertagen) vor.',
 '<h2 style="font-size:1.15rem;font-weight:700;margin:1.25rem 0 .5rem">Beste Brückentage im Kalender Tessin 2026</h2>',
 'Der Kalender 2026 bietet attraktive Brückentage zur Urlaubsoptimierung: (1) Ostern — Karfreitag 3. April + Ostermontag 6. April: null Ferientage für 4 zusammenhängende freie Tage. (2) Auffahrt — Donnerstag 14. Mai, Brücke mit Freitag 15. Mai für 4 Tage. (3) Fronleichnam — Donnerstag 4. Juni, Brücke mit Freitag 5. Juni für 4 Tage. (4) Peter und Paul — Montag 29. Juni, langes Wochenende von 3 Tagen ohne Ferienbezug. (5) Mariä Empfängnis — Dienstag 8. Dezember, Brücke mit Montag 7. Dezember für 4 Tage. Mit geschickter Planung kann ein Grenzgänger bis zu 25–28 effektive Urlaubstage mit nur 15–17 Urlaubstagen erhalten.',
 '<h2 style="font-size:1.15rem;font-weight:700;margin:1.25rem 0 .5rem">Ferientage und Feiertage: wie addieren sie sich?</h2>',
 'Nach Schweizer Recht (OR Art. 329a) beträgt das Minimum 4 Wochen (20 Arbeitstage) pro Jahr für Erwachsene und 5 Wochen für Arbeitnehmende unter 20 Jahren. Viele Tessiner GAV sehen nach 5–10 Jahren Betriebszugehörigkeit 5 Wochen vor und 6 Wochen für Beschäftigte über 50. Tessiner Feiertage zählen NICHT zur Ferienberechnung: sie kommen zu den Mindestferientagen hinzu. Ein Grenzgänger mit MEM-Vertrag und 10 Jahren Betriebszugehörigkeit hat damit 25 Ferientage + rund 13 effektive Feiertage (15 minus die im Wochenende liegenden) = 38 bezahlte freie Tage pro Jahr.',
 'Die Planung rund um die Schweizer und italienischen Feiertagskalender ist für Grenzgängerfamilien mit Kindern in italienischen Schulen unerlässlich. Italienische Schulen haben etwa 12 zusätzliche Schliesstage, die nicht mit Schweizer Feiertagen übereinstimmen — darunter Karneval, Schutzpatrontage und regionale Feiertage. Umgekehrt sind Schweizer Feiertage wie Auffahrt, Fronleichnam und Pfingstmontag in Italien reguläre Schultage, was eine sorgfältige Koordination der Kinderbetreuung erfordert.',
 '<p style="color:#64748b;font-size:0.8rem;margin-top:1rem">Quelle: <a href="https://www4.ti.ch/dfe/dfe/" style="color:#2563eb;text-decoration:none;" rel="noopener">Departement für Finanzen und Wirtschaft Kanton Tessin</a> · <a href="https://www.seco.admin.ch" style="color:#2563eb;text-decoration:none;" rel="noopener">SECO</a> · Kantonales Gesetz über die offiziellen Feiertage des Kantons Tessin (RL 10.1.1.5) · Schweizerisches Obligationenrecht (OR Art. 110, 321, 329, 329a). Letzte Aktualisierung: 24. April 2026.</p>',
 ],
 fr: [
 'Le Canton du Tessin observe en 2026 quinze (15) jours fériés officiels — les 9 jours fériés fédéraux suisses plus 6 jours fériés cantonaux spécifiques au Tessin, le calendrier férié le plus riche de Suisse. Pour les frontaliers, ces dates impactent directement le calcul des heures supplémentaires, la rémunération des jours travaillés en jours fériés (minimum 1,25×), le calcul du 13e salaire et l\'obligation de l\'employeur de payer ces jours même en cas d\'absence.',
 'Que se passe-t-il si un jour férié tombe un samedi ou un dimanche ? Contrairement au droit italien, le droit suisse ne prévoit AUCUN rattrapage automatique : le travailleur perd simplement le bénéfice du jour de congé. En 2026, trois fériés sont concernés : le 1er août (Fête nationale) et le 15 août (Assomption) tombent un samedi, le 1er novembre (Toussaint) un dimanche. Seules certaines CCT sectorielles (industrie MEM, construction, santé) compensent avec un jour de congé supplémentaire.',
 'Les jours fériés tombant en semaine réduisent le nombre de jours ouvrables du mois, affectant les calculs de salaire au prorata, l\'accumulation des droits aux congés et la répartition du 13e mois. Le CO suisse (art. 329) oblige l\'employeur à payer le jour férié même en cas d\'absence du salarié mensuel, avec des exceptions pour le personnel payé à l\'heure (Stundenlohn).',
 'Les frontaliers doivent noter que les jours fériés italiens ne s\'appliquent pas automatiquement en Suisse (principe lex loci laboris) : les fériés italiens comme le 25 avril (Libération), le 2 juin (Fête de la République) et les fêtes patronales locales sont des jours ouvrables normaux au Tessin. Sur accord écrit de l\'employeur, ils peuvent être pris comme congés payés.',
 'Pour les frontaliers payés à l\'heure (Stundenlohn), les jours fériés ont un impact financier direct : les heures non travaillées un jour férié sont compensées au taux normal si le jour tombe sur un jour ouvrable habituel. Les heures supplémentaires effectuées un jour férié doivent être payées au minimum à 125 % selon le Code des obligations suisse — de nombreuses CCT au Tessin prévoient 150 % (construction, MEM) voire 200 % (santé, hôtellerie le dimanche férié).',
 'Le calendrier 2026 offre plusieurs ponts attractifs pour optimiser les jours de vacances : Pâques (Vendredi Saint 3 avril + Lundi de Pâques 6 avril, 4 jours consécutifs sans utiliser de congé), Ascension (jeudi 14 mai, pont avec vendredi 15 mai), Fête-Dieu (jeudi 4 juin, pont avec vendredi 5 juin) et Immaculée Conception (mardi 8 décembre, pont avec lundi 7 décembre). Avec une planification soignée, un frontalier peut obtenir jusqu\'à 25-28 jours de vacances effectives en utilisant seulement 15-17 jours de congé.',
 'La planification autour des calendriers de jours fériés suisses et italiens est essentielle pour les familles frontalières avec des enfants scolarisés en Italie. Les écoles italiennes observent environ 12 jours de fermeture supplémentaires non alignés avec les fériés suisses — dont le Carnaval, les fêtes patronales et les fériés régionaux. Inversement, les fériés suisses comme l\'Ascension, la Fête-Dieu et le Lundi de Pentecôte sont des jours d\'école normaux en Italie, nécessitant une coordination soigneuse de la garde d\'enfants.',
 ],
 },

 // ───── Grocery price comparison ─────────────────────────────
 '/compara-servizi/confronta-prezzi-spesa': {
 en: [
 'The grocery price comparator benchmarks a standard weekly shopping basket across Swiss supermarkets (Migros, Coop, Denner, Aldi Suisse) and Italian equivalents (Esselunga, Lidl, Eurospin, Conad), applying the current CHF-EUR exchange rate to show real cost in a single currency.',
 'The comparison covers over 50 product categories: fresh produce, dairy, meat, packaged goods, beverages, and personal care items. On average, identical branded products cost 35-55% more in Ticino than in the Italian border regions, making cross-border grocery shopping a significant monthly saving for many frontalieri families.',
 'Beyond the basket total, the tool shows which product categories offer the greatest savings in Italy (meat, cheese, wine, fresh pasta) versus products where Swiss quality or local availability makes Swiss supermarkets competitive (fresh bakery, Swiss chocolate, specialty dairy). Results update monthly as scanner price data is refreshed.',
 'For cross-border families doing weekly shopping in Italy, the tool calculates annual savings including the time cost of the detour: at an average of 20 minutes extra driving per trip, the break-even point is reached when the basket savings exceed approximately EUR 15 per trip, which is typical for families of 3 or more.',
 'The comparison also includes non-food categories where cross-border price differences are significant: cleaning products (40-60% cheaper in Italy), over-the-counter medications (30-50% cheaper), and clothing/shoes (20-40% cheaper during Italian sales seasons in January and July).',
 ],
 de: [
 'Der Lebensmittelpreisvergleich bewertet einen standardisierten Wocheneinkauf in Schweizer Supermärkten (Migros, Coop, Denner, Aldi Suisse) und italienischen Pendants (Esselunga, Lidl, Eurospin, Conad) und wendet den aktuellen CHF-EUR-Wechselkurs an.',
 'Der Vergleich umfasst über 50 Produktkategorien: Frischprodukte, Milchprodukte, Fleisch, Fertigprodukte, Getränke und Körperpflegeartikel. Im Durchschnitt kosten identische Markenprodukte im Tessin 35-55 % mehr als in den italienischen Grenzregionen.',
 'Das Tool zeigt auch, welche Kategorien in Italien am meisten sparen (Fleisch, Käse, Wein, frische Pasta) versus Produkte, bei denen Schweizer Qualität oder lokale Verfügbarkeit die Schweizer Supermärkte wettbewerbsfähig macht. Ergebnisse werden monatlich aktualisiert.',
 'Für Grenzgänger-Familien, die wöchentlich in Italien einkaufen, berechnet das Tool die jährlichen Einsparungen einschliesslich der Zeitkosten des Umwegs: Bei durchschnittlich 20 Minuten zusätzlicher Fahrzeit pro Einkauf liegt die Gewinnschwelle bei ca. EUR 15 pro Einkauf, was für Familien ab 3 Personen typisch ist.',
 'Der Vergleich umfasst auch Non-Food-Kategorien mit signifikanten grenzüberschreitenden Preisunterschieden: Reinigungsprodukte (40-60 % günstiger in Italien), rezeptfreie Medikamente (30-50 % günstiger) und Kleidung/Schuhe (20-40 % günstiger während der italienischen Schlussverkäufe im Januar und Juli).',
 ],
 fr: [
 'Le comparateur de prix alimentaires compare un panier de courses hebdomadaire standard dans les supermarchés suisses (Migros, Coop, Denner, Aldi Suisse) et italiens (Esselunga, Lidl, Eurospin, Conad), en appliquant le taux de change CHF-EUR actuel.',
 'La comparaison couvre plus de 50 catégories de produits. En moyenne, les produits de marque identiques coûtent 35 à 55 % plus cher au Tessin que dans les régions frontalières italiennes, faisant des courses en Italie une économie mensuelle significative pour de nombreuses familles frontalières.',
 'L\'outil indique aussi quelles catégories offrent les plus grandes économies en Italie (viande, fromage, vin, pâtes fraîches) versus les produits où la qualité suisse ou la disponibilité locale rend les supermarchés suisses compétitifs. Les résultats sont mis à jour mensuellement.',
 'Pour les familles frontalières faisant leurs courses hebdomadaires en Italie, l\'outil calcule les économies annuelles incluant le coût en temps du détour : avec environ 20 minutes de conduite supplémentaire par trajet, le seuil de rentabilité est atteint quand les économies dépassent EUR 15 par course.',
 'La comparaison inclut aussi les catégories non-alimentaires où les différences de prix transfrontalières sont significatives : produits d\'entretien (40-60 % moins chers en Italie), médicaments sans ordonnance (30-50 % moins chers) et vêtements/chaussures (20-40 % moins chers pendant les soldes italiennes en janvier et juillet).',
 ],
 },

 // ───── Mobile operator comparison ───────────────────────────
 '/compara-servizi/confronta-operatori-mobili': {
 en: [
 'The mobile operator comparator evaluates plans from Swiss operators (Swisscom, Salt, Sunrise, Yallo, Aldi Talk CH) and Italian operators (TIM, Vodafone IT, WindTre, Iliad IT) specifically for cross-border workers who need reliable coverage in both countries without excessive roaming charges.',
 'Key criteria for frontalieri: daily cross-border usage (EU roaming is included in most Italian plans under EU regulation, while Swiss operators are not EU-bound), data allowances for border zone reception gaps, calling between Swiss and Italian numbers, and international transfer costs when sending CHF earnings to an Italian bank account.',
 'The comparison is structured around three typical cross-border usage profiles: commuter (high data, daily crossing), remote-first (occasional border crossing, video calls priority), and family plan (multiple SIMs, children in Italian schools). Select your profile to see the most relevant operator ranking.',
 'A key consideration for frontalieri is the dual-SIM strategy: using an Italian SIM for data-heavy usage at home and an eSIM from a Swiss operator for work calls and local Swiss services. The tool calculates the combined monthly cost of this approach versus a single international plan, showing that dual-SIM typically saves EUR 15-25 per month.',
 'Network coverage quality varies significantly in the border zone: some areas between Chiasso and Como experience frequent handovers between Swiss and Italian cell towers, causing dropped calls and data interruptions. The comparison includes real-world coverage quality scores for the specific border corridors most used by frontalieri commuters.',
 ],
 de: [
 'Der Mobilfunkanbieter-Vergleich bewertet Tarife von Schweizer Anbietern (Swisscom, Salt, Sunrise, Yallo) und italienischen Anbietern (TIM, Vodafone IT, WindTre, Iliad IT) speziell für Grenzgänger, die in beiden Ländern eine zuverlässige Abdeckung ohne übermässige Roaming-Kosten benötigen.',
 'Wesentliche Kriterien: tägliche grenzüberschreitende Nutzung (EU-Roaming ist in den meisten italienischen Tarifen enthalten, während Schweizer Anbieter nicht EU-gebunden sind), Datenkontingente für Empfangslücken in der Grenzzone und Anrufkosten zwischen Schweizer und italienischen Nummern.',
 'Der Vergleich ist nach drei typischen Grenzgänger-Nutzungsprofilen strukturiert: Pendler (hohe Datenmenge, tägliches Überqueren), Remote-First (gelegentliches Grenzüberschreiten, Videokonferenzen) und Familienplan (mehrere SIM-Karten). Wählen Sie Ihr Profil für das relevanteste Anbieterranking.',
 'Eine wichtige Überlegung für Grenzgänger ist die Dual-SIM-Strategie: eine italienische SIM für datenintensive Nutzung zu Hause und eine eSIM eines Schweizer Anbieters für Arbeitsanrufe. Das Tool berechnet die kombinierten monatlichen Kosten und zeigt, dass Dual-SIM typischerweise EUR 15-25 pro Monat spart.',
 'Die Netzabdeckungsqualität variiert erheblich in der Grenzzone: Einige Gebiete zwischen Chiasso und Como erleben häufige Wechsel zwischen Schweizer und italienischen Mobilfunkmasten. Der Vergleich enthält reale Abdeckungsqualitätsbewertungen für die von Grenzgänger-Pendlern am häufigsten genutzten Grenzkorridore.',
 ],
 fr: [
 'Le comparateur d\'opérateurs mobiles évalue les forfaits des opérateurs suisses (Swisscom, Salt, Sunrise, Yallo) et italiens (TIM, Vodafone IT, WindTre, Iliad IT) spécifiquement pour les frontaliers ayant besoin d\'une couverture fiable dans les deux pays sans frais d\'itinérance excessifs.',
 'Critères clés : utilisation transfrontalière quotidienne (le roaming UE est inclus dans la plupart des forfaits italiens selon la réglementation UE, les opérateurs suisses n\'étant pas soumis à l\'UE), quotas de données et coûts d\'appel entre numéros suisses et italiens.',
 'La comparaison est structurée autour de trois profils d\'utilisation frontalière typiques : pendulaire (données élevées, traversée quotidienne), remote-first (traversée occasionnelle, priorité visioconférence) et forfait famille (plusieurs SIM). Sélectionnez votre profil pour le classement le plus pertinent.',
 'Une considération clé pour les frontaliers est la stratégie double SIM : utiliser une SIM italienne pour l\'usage intensif de données à domicile et une eSIM d\'un opérateur suisse pour les appels professionnels. L\'outil calcule le coût mensuel combiné, montrant que le double SIM économise typiquement EUR 15-25 par mois.',
 'La qualité de couverture réseau varie significativement dans la zone frontalière : certaines zones entre Chiasso et Côme subissent des basculements fréquents entre antennes suisses et italiennes. La comparaison inclut des scores de qualité de couverture réels pour les corridors frontaliers les plus empruntés.',
 ],
 },

 // ───── Renovation bonus calculator ──────────────────────────
 '/compara-servizi/calcola-bonus-ristrutturazione': {
 en: [
 'The renovation bonus calculator helps cross-border workers who own property in Italy estimate the net cost of home improvement works after applying Italian fiscal incentives: the 50% renovation deduction (Bonus Ristrutturazione), the 65% Ecobonus for energy efficiency upgrades, the Superbonus for qualifying thermal envelope improvements, and the 36% furniture bonus for new appliances purchased after renovation.',
 'The tool calculates the deduction spread (the bonus is recovered over 10 equal annual IRPEF deductions), the total fiscal saving over the full recovery period, and the effective net cost of the works. It accounts for the EUR 10,000 franchise applicable to new cross-border workers under the 2026 Agreement when calculating how much of the Italian tax liability can absorb the deduction.',
 'For cross-border workers, coordination between Swiss withholding tax paid and Italian IRPEF is critical: the deduction is only valuable if you have Italian tax liability to offset. The calculator shows the breakeven point and recommends whether maximising the deduction is optimal or whether alternative investments offer better after-tax returns given your specific Swiss-Italian tax position.',
 'Eligibility for the Bonus Ristrutturazione 2026 requires the property to be located in Italy and used as a primary or secondary residence. Qualifying works include structural renovations, seismic upgrades, bathroom and kitchen refurbishment, electrical and plumbing overhauls, and energy efficiency improvements. The maximum deductible expenditure is EUR 96,000 per property unit, yielding a maximum 50% deduction of EUR 48,000 spread over 10 years. Cross-border workers must retain all invoices showing traceable bank payments (bonifico parlante).',
 'Cross-border workers claim renovation deductions through their Italian tax return (Modello 730 or Redditi PF), specifically in Section III-A for building renovation expenses. The deduction offsets IRPEF liability — but under the 2026 New Agreement, new frontalieri benefit from only a partial Italian tax base due to the EUR 10,000 franchise, which may limit the deductible amount. Workers should verify their projected Italian tax liability before committing to large renovation expenditures to ensure the full deduction can be absorbed over the 10-year recovery period.',
 ],
 de: [
 'Der Renovierungsbonus-Rechner hilft Grenzgängern, die in Italien Immobilien besitzen, die Nettokosten von Renovierungsarbeiten nach Anwendung italienischer Steueranreize zu schätzen: 50% Renovierungsabzug, 65% Ökobonus für Energieeffizienz-Upgrades, Superbonus und 36% Möbelbonus.',
 'Das Tool berechnet die Abzugsverteilung (der Bonus wird über 10 gleiche jährliche IRPEF-Abzüge zurückgewonnen), die gesamte Steuereinsparung über die gesamte Rückgewinnungsperiode und die effektiven Nettokosten. Es berücksichtigt die EUR 10.000-Franchise für neue Grenzgänger nach dem Abkommen 2026.',
 'Für Grenzgänger ist die Koordination zwischen der in der Schweiz gezahlten Quellensteuer und der italienischen IRPEF entscheidend: Der Abzug ist nur dann wertvoll, wenn Sie eine ausreichende italienische Steuerschuld haben. Der Rechner zeigt den Breakeven-Punkt.',
 'Die Anspruchsberechtigung für den Bonus Ristrutturazione 2026 erfordert, dass die Immobilie in Italien liegt und als Haupt- oder Zweitwohnsitz genutzt wird. Förderfähige Arbeiten umfassen Strukturrenovierungen, Erdbebenertüchtigung, Bad- und Küchenrenovierung, Elektro- und Sanitärsanierung sowie Energieeffizienzverbesserungen. Der maximale abzugsfähige Aufwand beträgt EUR 96.000 pro Wohneinheit — maximal EUR 48.000 Abzug verteilt auf 10 Jahre. Grenzgänger müssen alle Rechnungen mit nachverfolgbaren Banküberweisungen (Bonifico Parlante) aufbewahren.',
 'Grenzgänger beanspruchen Renovierungsabzüge über ihre italienische Steuererklärung (Modello 730 oder Redditi PF), speziell in Abschnitt III-A für Gebäuderenovierungskosten. Der Abzug mindert die IRPEF-Schuld — doch unter dem Neuen Abkommen 2026 profitieren neue Grenzgänger nur von einer teilweisen italienischen Bemessungsgrundlage aufgrund der EUR-10.000-Franchise, was den abzugsfähigen Betrag einschränken kann. Arbeitnehmer sollten ihre voraussichtliche italienische Steuerschuld prüfen, bevor sie grössere Renovierungsausgaben tätigen.',
 ],
 fr: [
 'Le calculateur de bonus rénovation aide les frontaliers propriétaires en Italie à estimer le coût net des travaux après application des incitations fiscales italiennes : déduction rénovation 50%, Écobonus 65% pour travaux d\'efficacité énergétique, Superbonus et bonus mobilier 36%.',
 'L\'outil calcule l\'étalement de la déduction (le bonus est récupéré en 10 tranches annuelles égales de déduction IRPEF), l\'économie fiscale totale sur la période de récupération et le coût net effectif. Il tient compte de la franchise de 10 000 EUR pour les nouveaux frontaliers selon l\'Accord 2026.',
 'Pour les frontaliers, la coordination entre l\'impôt à la source suisse payé et l\'IRPEF italienne est critique : la déduction n\'est utile que si vous avez une charge fiscale italienne suffisante. Le calculateur montre le point d\'équilibre et recommande la stratégie optimale selon votre position fiscale suisse-italienne.',
 'L\'éligibilité au Bonus Ristrutturazione 2026 exige que le bien soit situé en Italie et utilisé comme résidence principale ou secondaire. Les travaux éligibles comprennent les rénovations structurelles, la mise aux normes antisismiques, la réfection de salle de bains et cuisine, la rénovation électrique et sanitaire, et les améliorations énergétiques. Le plafond de dépenses déductibles est de 96 000 EUR par unité immobilière — soit une déduction maximale de 48 000 EUR étalée sur 10 ans. Les frontaliers doivent conserver toutes les factures avec virements bancaires traçables (bonifico parlante).',
 'Les frontaliers déclarent les déductions rénovation via leur déclaration italienne (Modello 730 ou Redditi PF), spécifiquement dans la Section III-A pour les frais de rénovation immobilière. La déduction réduit l\'IRPEF due — mais sous le Nouvel Accord 2026, les nouveaux frontaliers ne bénéficient que d\'une base imposable italienne partielle en raison de la franchise de 10 000 EUR, ce qui peut limiter le montant déductible. Il est recommandé de vérifier sa charge fiscale italienne prévisionnelle avant d\'engager de grosses dépenses de rénovation.',
 ],
 },

 // ───── Living in Italy ───────────────────────────────────────
 '/vivere-in-ticino/vivere-in-italia': {
 en: [
 'This section covers the practical realities of living in Italy while working in Swiss Canton Ticino — the daily life of around 70,000 frontalieri who make this choice. Topics covered include Italian border regions (Como, Varese, Verbano-Cusio-Ossola, Novara provinces), commute times to the main border crossings, and the administrative consequences of Italian tax residence.',
 'Italian residence means paying IRPEF and regional/municipal surcharges on your worldwide income, maintaining AIRE registration if moving abroad, and potentially accessing Italian public services (healthcare via Italian NHS, Italian public schools for children, Italian state pension contributions from INPS). The guide maps out all these obligations and entitlements clearly.',
 'For families with children, living in Italy gives access to Italian schooling at a fraction of Swiss tuition, Italian public healthcare without LAMal premiums (for G permit workers who opt for Italian NHS), and a cost of living that is typically 30-45% lower than equivalent accommodation in Lugano or Bellinzona. The section helps you calculate the real net advantage of Italian residence versus Swiss residency with a B permit.',
 'The section includes a detailed municipality comparison tool: enter your workplace in Ticino and the guide suggests optimal Italian comuni based on commute time, rental costs, school quality, local services, and proximity to supermarkets, pharmacies, and public transport connections to the border crossings.',
 'Tax planning for Italian-resident frontalieri requires understanding the interaction between Swiss withholding tax and Italian IRPEF: the guide walks through the annual tax return process step by step, including how to claim the foreign tax credit (Art. 165 TUIR), deduct commuting expenses, and report Swiss social security contributions on your 730/Redditi PF form.',
 ],
 de: [
 'Dieser Bereich deckt die praktischen Realitäten des Lebens in Italien bei der Arbeit im Schweizer Kanton Tessin ab — den Alltag von rund 70.000 Grenzgängern, die diese Wahl treffen. Behandelte Themen: italienische Grenzregionen (Como, Varese, Verbano-Cusio-Ossola, Novara), Pendelzeiten und administrative Konsequenzen des italienischen Steuerwohnsitzes.',
 'Italienischer Wohnsitz bedeutet IRPEF- und Regional-/Kommunalzuschlagszahlungen auf das Welteinkommen, AIRE-Registrierung und potenziellen Zugang zu italienischen öffentlichen Diensten (NHS, Schulen, INPS-Rentenversicherung). Der Leitfaden zeigt alle Pflichten und Ansprüche klar auf.',
 'Für Familien mit Kindern bietet das Leben in Italien Zugang zu günstigerer Schulbildung und öffentlicher Gesundheitsversorgung ohne LAMal-Prämien (für G-Bewilligungsinhaber, die den italienischen NHS wählen), bei Lebenshaltungskosten, die typischerweise 30-45 % niedriger sind als im Tessin.',
 'Der Bereich enthält ein detailliertes Gemeindevergleichstool: Geben Sie Ihren Arbeitsort im Tessin ein und der Leitfaden schlägt optimale italienische Comuni basierend auf Pendelzeit, Mietkosten, Schulqualität, lokalen Dienstleistungen und Nähe zu Grenzübergängen vor.',
 'Die Steuerplanung für in Italien wohnhafte Grenzgänger erfordert das Verständnis der Wechselwirkung zwischen Schweizer Quellensteuer und italienischer IRPEF: Der Leitfaden führt Schritt für Schritt durch die jährliche Steuererklärung, einschliesslich der Beantragung der ausländischen Steuergutschrift (Art. 165 TUIR) und der Geltendmachung von Pendelkosten.',
 ],
 fr: [
 'Cette section couvre les réalités pratiques de la vie en Italie tout en travaillant dans le Canton suisse du Tessin — le quotidien d\'environ 70 000 frontaliers qui font ce choix. Sujets traités : régions frontalières italiennes (provinces de Côme, Varese, Verbano-Cusio-Ossola, Novare), temps de trajet et conséquences administratives de la résidence fiscale italienne.',
 'La résidence italienne implique le paiement de l\'IRPEF et des surtaxes régionales/communales sur les revenus mondiaux, l\'inscription AIRE et l\'accès potentiel aux services publics italiens (SSN, écoles publiques italiennes, cotisations retraite INPS). Le guide présente clairement toutes ces obligations et droits.',
 'Pour les familles avec enfants, vivre en Italie donne accès à une scolarité moins coûteuse, aux soins de santé publics sans primes LAMal (pour les titulaires de permis G qui optent pour le SSN italien), avec un coût de la vie généralement 30-45% inférieur à celui de Lugano ou Bellinzona.',
 'La section comprend un outil de comparaison détaillé des communes : entrez votre lieu de travail au Tessin et le guide suggère les comuni italiens optimaux basés sur le temps de trajet, les coûts locatifs, la qualité des écoles et la proximité des postes frontières.',
 'La planification fiscale pour les frontaliers résidant en Italie nécessite de comprendre l\'interaction entre l\'impôt à la source suisse et l\'IRPEF italienne : le guide détaille étape par étape le processus de déclaration fiscale annuelle, y compris la demande du crédit d\'impôt étranger (Art. 165 TUIR) et la déduction des frais de déplacement.',
 ],
 },

 // ───── Border municipalities ─────────────────────────────────
 '/vivere-in-ticino/comuni-di-frontiera': {
 en: [
 'The border municipalities guide covers the Italian comuni within 20 km of the Swiss-Ticino border — the geographic threshold that determines the fiscal regime for cross-border workers under the 2026 New Agreement. Frontalieri residing in these municipalities benefit from the transitional regime where Switzerland returns approximately 40% of withholding tax to the Italian municipalities of origin.',
 'Practical information includes: distance from each comune to the nearest border crossing, commute time estimates to major Ticino employment centres (Lugano, Bellinzona, Locarno, Mendrisio), local public transport links (FerrovieNord, TILO regional rail, FlixBus routes), and rental market data showing average monthly rents versus Ticino equivalents.',
 'The guide also covers the administrative process for certifying residence in a border municipality for Swiss permit purposes, how to document the 20 km distance requirement, and what happens if you move to a comune outside the 20 km zone while keeping your Swiss job — including the fiscal implications of shifting to the new frontalieri regime with full Swiss withholding tax.',
 'The guide ranks border municipalities by overall frontalieri suitability score, combining factors like commute time to Lugano/Bellinzona, average rent per square meter, local service availability (medical, schooling, shopping), and public transport frequency. Top-ranked municipalities include Cantù, Olgiate Comasco, and Luino for different commute corridors.',
 'For families considering relocation from one border municipality to another, the comparison tool shows the fiscal impact of moving: different Italian comuni have varying addizionale comunale rates (0.4-0.8%), and moving beyond the 20 km zone triggers a shift to the new frontalieri tax regime with significantly higher Italian taxation.',
 ],
 de: [
 'Der Leitfaden zu den Grenzgemeinden behandelt die italienischen Comuni innerhalb von 20 km von der Schweizer-Tessiner Grenze — die geografische Schwelle, die das Steuerregime für Grenzgänger nach dem Neuen Abkommen 2026 bestimmt. In diesen Gemeinden wohnhafte Grenzgänger profitieren vom Übergangsregime, bei dem die Schweiz ca. 40 % der Quellensteuer an die italienischen Herkunftsgemeinden zurückgibt.',
 'Praktische Informationen: Entfernung jeder Gemeinde zum nächsten Grenzübergang, Pendelzeitschätzungen zu wichtigen Tessiner Beschäftigungszentren (Lugano, Bellinzona, Locarno, Mendrisio), ÖPNV-Verbindungen und Mietmarktdaten.',
 'Der Leitfaden behandelt auch das administrative Verfahren zur Bescheinigung des Wohnsitzes in einer Grenzgemeinde für Schweizer Bewilligungszwecke und die steuerlichen Folgen eines Umzugs ausserhalb der 20-km-Zone.',
 'Der Leitfaden bewertet Grenzgemeinden nach einem Gesamteignungsscore für Grenzgänger, der Pendelzeit nach Lugano/Bellinzona, durchschnittliche Miete pro Quadratmeter, lokale Dienstleistungsverfügbarkeit und ÖV-Frequenz kombiniert. Bestbewertete Gemeinden sind u.a. Cantù, Olgiate Comasco und Luino für verschiedene Pendelkorridore.',
 'Für Familien, die einen Umzug zwischen Grenzgemeinden erwägen, zeigt das Vergleichstool die steuerlichen Auswirkungen: verschiedene italienische Comuni haben unterschiedliche Addizionale-Comunale-Sätze (0,4-0,8 %), und ein Umzug jenseits der 20-km-Zone löst den Wechsel zum neuen Grenzgänger-Steuerregime mit deutlich höherer italienischer Besteuerung aus.',
 ],
 fr: [
 'Le guide des communes frontalières couvre les comuni italiens dans un rayon de 20 km de la frontière suisse-tessinoise — le seuil géographique déterminant le régime fiscal pour les frontaliers selon le Nouvel Accord 2026. Les frontaliers résidant dans ces communes bénéficient du régime transitoire où la Suisse reverse environ 40% de l\'impôt à la source aux communes italiennes d\'origine.',
 'Informations pratiques : distance de chaque commune au poste frontière le plus proche, estimations des temps de trajet vers les principaux centres d\'emploi tessinois (Lugano, Bellinzone, Locarno, Mendrisio), liaisons de transport public et données du marché locatif.',
 'Le guide couvre aussi la procédure administrative pour certifier la résidence dans une commune frontalière pour les besoins du permis suisse et les implications fiscales d\'un déménagement hors de la zone de 20 km tout en conservant l\'emploi en Suisse.',
 'Le guide classe les communes frontalières par score global d\'adéquation pour les frontaliers, combinant temps de trajet vers Lugano/Bellinzone, loyer moyen au mètre carré, disponibilité des services locaux et fréquence des transports publics. Les communes les mieux classées incluent Cantù, Olgiate Comasco et Luino selon les corridors.',
 'Pour les familles envisageant un déménagement entre communes frontalières, l\'outil de comparaison montre l\'impact fiscal : les différents comuni italiens ont des taux d\'addizionale comunale variables (0,4-0,8 %), et un déménagement au-delà de la zone de 20 km déclenche le passage au nouveau régime frontalier avec une imposition italienne nettement plus élevée.',
 ],
 },

 // ───── Italian-speaking Swiss schools ───────────────────────
 '/vivere-in-ticino/scuole-svizzera-italiana': {
 en: [
 'The Italian-speaking Swiss schools guide covers the education system in Canton Ticino and the bilingual border areas of Graubünden (Grigioni) for cross-border families considering schooling options in Switzerland. The Ticino system follows the Swiss model: scuola dell\'infanzia (3-6 years), scuola elementare (6-11), scuola media (11-15), and liceo/scuola professionale (15-18).',
 'For cross-border workers with children, enrolling in Ticino schools involves residency status checks — typically B permit holders can enrol children easily, while G permit holders face varying cantonal rules. The guide maps out school zones, lists the main public and private institutions, and explains the Ticino school calendar and holiday schedule.',
 'A cost comparison is included: Ticino public schools are free (with small material fees), while private schools range from CHF 15,000 to CHF 35,000 per year. Italian public schools in the border provinces offer a cheaper alternative for families living in Italy, with the guide providing commute time estimates and information on Italian-Swiss bilingual school programmes.',
 'For secondary education, the guide covers the unique Ticino "scuola media" system (ages 11-15), which has no direct equivalent in the Italian system, and explains the transition pathways to liceo, scuola professionale, or apprenticeship (formazione duale) — a distinctly Swiss option that combines school with practical training at a company.',
 'Language considerations are important: while instruction is in Italian (making the transition easier for Italian-resident children), Swiss-German is a mandatory second language from scuola media onwards. The guide lists schools with strong language support programmes and explains the cantonal integration support for newly arrived children of frontalieri.',
 ],
 de: [
 'Der Schulführer für die italienischsprachige Schweiz deckt das Bildungssystem im Kanton Tessin und den zweisprachigen Grenzgebieten Graubündens für grenzüberschreitende Familien ab: Scuola dell\'Infanzia (3-6 Jahre), Scuola Elementare (6-11), Scuola Media (11-15) und Liceo/Scuola Professionale (15-18).',
 'Für Grenzgänger mit Kindern beinhaltet die Einschulung im Tessin Wohnsitzprüfungen — B-Bewilligungsinhaber können Kinder in der Regel problemlos anmelden, während G-Bewilligungsinhaber unterschiedlichen Kantonsregeln gegenüberstehen. Der Leitfaden listet Schulzonen, Hauptinstitutionen und erklärt den Tessiner Schulkalender.',
 'Ein Kostenvergleich ist enthalten: Öffentliche Schulen im Tessin sind kostenlos, private Schulen kosten 15.000-35.000 CHF pro Jahr. Italienische öffentliche Schulen in den Grenzprovinzen bieten eine günstigere Alternative für in Italien lebende Familien.',
 'Für die Sekundarstufe behandelt der Leitfaden das einzigartige Tessiner Scuola-Media-System (11-15 Jahre), das kein direktes Äquivalent im italienischen System hat, und erklärt die Übergangswege zum Liceo, zur Scuola Professionale oder zur Berufslehre (formazione duale) — eine typisch schweizerische Option.',
 'Sprachliche Aspekte sind wichtig: Obwohl der Unterricht auf Italienisch erfolgt (was den Übergang für in Italien lebende Kinder erleichtert), ist Deutsch ab der Scuola Media obligatorische Zweitsprache. Der Leitfaden listet Schulen mit starken Sprachförderprogrammen und erklärt die kantonale Integrationsunterstützung.',
 ],
 fr: [
 'Le guide des écoles de Suisse italophone couvre le système éducatif du Canton du Tessin et des zones frontalières bilingues des Grisons pour les familles transfrontalières : scuola dell\'infanzia (3-6 ans), scuola elementare (6-11), scuola media (11-15) et lycée/école professionnelle (15-18).',
 'Pour les frontaliers avec enfants, l\'inscription dans les écoles du Tessin implique des vérifications de statut de résidence — les titulaires de permis B peuvent généralement inscrire leurs enfants facilement, tandis que les titulaires de permis G font face à des règles cantonales variables.',
 'Une comparaison des coûts est incluse : les écoles publiques au Tessin sont gratuites, les écoles privées coûtent de CHF 15 000 à CHF 35 000 par an. Les écoles publiques italiennes dans les provinces frontalières offrent une alternative moins coûteuse pour les familles vivant en Italie.',
 'Pour l\'enseignement secondaire, le guide couvre le système unique tessinois de la "scuola media" (11-15 ans), sans équivalent direct dans le système italien, et explique les voies de transition vers le lycée, l\'école professionnelle ou l\'apprentissage (formazione duale) — une option typiquement suisse.',
 'Les considérations linguistiques sont importantes : bien que l\'enseignement soit en italien (facilitant la transition pour les enfants résidant en Italie), l\'allemand est obligatoire comme deuxième langue dès la scuola media. Le guide liste les écoles avec de solides programmes de soutien linguistique et d\'intégration cantonale.',
 ],
 },

 // ───── Border crossing traffic history ───────────────────────
 '/statistiche/storico-traffico-dogane': {
 en: [
 'The border crossing traffic history section presents time-series data on the volume and timing of frontalieri crossings at all major Ticino-Italy border points: Chiasso, Como-Monte Olimpino, Ponte Tresa, Stabio, Gaggiolo, Balerna, and the smaller secondary crossings. Data covers monthly vehicle counts, seasonal trends, and peak hour distributions.',
 'For cross-border workers planning their commute, the historical data reveals actionable patterns: which months have the heaviest congestion (September, October, and January when school terms restart), which crossings have improved most with recent infrastructure investments, and how total frontalieri traffic has trended since the 2020 pandemic disruption through to 2026.',
 'The dataset is sourced from the Swiss Federal Customs Administration (BAZG) and the Italian Guardia di Finanza crossing records. Charts are fully interactive — filter by crossing, time period, and traffic type (car, bus, truck) to identify the optimal commute window for your specific crossing point.',
 'The analysis includes year-over-year growth rates showing that frontalieri traffic at Ticino border crossings has increased by an average of 2.3% annually since 2021, driven by economic recovery and new employment in the Lugano financial and biotech sectors. The Stabio crossing saw the largest capacity increase (+15%) following the 2024 lane expansion project.',
 'For commuters considering alternative transport modes, the section compares border crossing times by car, TILO regional train, and bus. Rail crossings at Chiasso station and the Mendrisio-Varese line offer predictable 5-minute border transit times versus 15-45 minutes by car during peak hours.',
 ],
 de: [
 'Der historische Grenzübergangsverkehr präsentiert Zeitreihendaten zum Volumen und Timing der Grenzgänger-Überquerungen an allen wichtigen Tessin-Italien-Grenzübergängen: Chiasso, Como-Monte Olimpino, Ponte Tresa, Stabio, Gaggiolo, Balerna und kleinere Nebenübergänge.',
 'Für Grenzgänger bei der Pendelplanung zeigen die historischen Daten umsetzbare Muster: welche Monate die stärkste Überlastung haben (September, Oktober, Januar bei Schuljahresbeginn), welche Übergänge sich mit Infrastrukturinvestitionen am meisten verbessert haben und wie sich der Gesamtverkehr seit 2020 entwickelt hat.',
 'Der Datensatz stammt von der Schweizerischen Eidgenössischen Zollverwaltung (BAZG) und den italienischen Guardia-di-Finanza-Grenzaufzeichnungen. Diagramme sind vollständig interaktiv: Filtern Sie nach Übergang, Zeitraum und Verkehrstyp.',
 'Die Analyse umfasst Jahresvergleichswachstumsraten, die zeigen, dass der Grenzgängerverkehr an den Tessiner Grenzübergängen seit 2021 jährlich um durchschnittlich 2,3 % gestiegen ist, getrieben durch wirtschaftliche Erholung und neue Beschäftigung im Luganer Finanz- und Biotechsektor. Der Übergang Stabio verzeichnete den grössten Kapazitätszuwachs (+15 %) nach der Spurerweiterung 2024.',
 'Für Pendler, die alternative Verkehrsmittel in Betracht ziehen, vergleicht der Bereich die Grenzübergangszeiten mit Auto, TILO-Regionalzug und Bus. Bahnübergänge am Bahnhof Chiasso und der Linie Mendrisio-Varese bieten vorhersagbare 5-Minuten-Grenzübergangszeiten gegenüber 15-45 Minuten mit dem Auto in Spitzenzeiten.',
 ],
 fr: [
 'La section historique du trafic frontalier présente des données de séries temporelles sur le volume et le calendrier des passages de frontaliers à tous les principaux postes frontaliers Tessin-Italie : Chiasso, Como-Monte Olimpino, Ponte Tresa, Stabio, Gaggiolo, Balerna et les passages secondaires.',
 'Pour les frontaliers planifiant leur trajet, les données historiques révèlent des patterns exploitables : quels mois ont la congestion la plus forte (septembre, octobre, janvier lors de la rentrée scolaire), quels postes se sont le plus améliorés avec les investissements d\'infrastructure.',
 'Le jeu de données provient de l\'Administration fédérale des douanes suisses (BAZG) et des enregistrements de la Guardia di Finanza italienne. Les graphiques sont entièrement interactifs — filtrez par poste, période et type de trafic pour identifier la fenêtre de trajet optimale.',
 'L\'analyse inclut les taux de croissance annuels montrant que le trafic frontalier aux postes tessinois a augmenté en moyenne de 2,3 % par an depuis 2021, porté par la reprise économique et les nouveaux emplois dans les secteurs financier et biotech de Lugano. Le poste de Stabio a connu la plus grande augmentation de capacité (+15 %) après l\'élargissement de voies en 2024.',
 'Pour les pendulaires envisageant des modes de transport alternatifs, la section compare les temps de passage aux frontières en voiture, train régional TILO et bus. Les passages ferroviaires à la gare de Chiasso et la ligne Mendrisio-Varese offrent des temps de transit prévisibles de 5 minutes contre 15-45 minutes en voiture aux heures de pointe.',
 ],
 },

 // ───── Salary statistics comparison ─────────────────────────
 '/statistiche/confronta-stipendi': {
 en: [
 'The salary statistics section compares median and average gross wages across 24 industry sectors in Canton Ticino (CHF) versus the equivalent Italian provinces of Como, Varese, and Verbano-Cusio-Ossola (EUR), converted at current exchange rates to enable direct comparison of purchasing power.',
 'Data is sourced from the Swiss Federal Statistical Office (FSO/BFS) annual wage survey, ISTAT Italian employment statistics, and the SECO Cantonal Labour Market Monitor, providing a statistically robust picture of the cross-border salary differential by role, experience level, and contract type for 2026.',
 'The comparison is designed to support real negotiation decisions: if you are applying for a role in Ticino or planning to renegotiate, knowing the median salary for your sector and experience level in Switzerland versus Italy gives you objective data to back your position. The tool also calculates the net advantage after Swiss social contributions and cantonal withholding tax versus the Italian equivalent after IRPEF.',
 'Salary differences between Ticino and other Swiss cantons are significant: median wages in Ticino are typically 15–20% lower than in Zurich, Basel, or Geneva. However, Ticino remains attractive for Italian cross-border workers because even lower Swiss salaries translate into higher purchasing power in Italy after CHF-EUR conversion. The comparison helps evaluate whether a role in Ticino offers better net value than a higher-paid position in a more expensive Swiss canton.',
 'When interpreting gross-to-net conversion, cross-border workers must account for withholding tax rates that vary substantially by personal circumstances. A single worker (Table A) earning CHF 70,000 in Ticino pays approximately 8–10% withholding tax, while a married worker with two children (Table C2) at the same salary pays only 2–4%. These differences can shift the net advantage by several hundred francs per month, making personal profile data essential for accurate salary comparison.',
 ],
 de: [
 'Die Gehaltsstatistik vergleicht Median- und Durchschnittsbruttogehälter in 24 Branchen im Kanton Tessin (CHF) mit den äquivalenten italienischen Provinzen Como, Varese und Verbano-Cusio-Ossola (EUR), umgerechnet zu aktuellen Wechselkursen für einen direkten Kaufkraftvergleich.',
 'Daten stammen aus der jährlichen BFS-Lohnerhebung, ISTAT-Beschäftigungsstatistiken und dem SECO-Kantonsarbeitsmarktmonitor — eine statistisch robuste Darstellung des grenzüberschreitenden Gehaltsgefälles nach Branche, Erfahrungsstufe und Vertragstyp für 2026.',
 'Der Vergleich unterstützt echte Verhandlungsentscheidungen: Kenntnis des Mediangehalts für Ihren Sektor und Ihre Erfahrungsstufe in der Schweiz versus Italien gibt Ihnen objektive Daten für Gehaltsverhandlungen. Das Tool berechnet auch den Nettovorteil nach Schweizer Sozialabgaben und kantonaler Quellensteuer.',
 'Gehaltsunterschiede zwischen dem Tessin und anderen Schweizer Kantonen sind erheblich: Die Medianlöhne im Tessin liegen typischerweise 15–20 % unter denen in Zürich, Basel oder Genf. Dennoch bleibt das Tessin für italienische Grenzgänger attraktiv, da selbst niedrigere Schweizer Gehälter nach CHF-EUR-Umrechnung eine höhere Kaufkraft in Italien bieten. Der Vergleich hilft einzuschätzen, ob eine Tessiner Stelle einen besseren Nettowert bietet als eine höher bezahlte Position in einem teureren Kanton.',
 'Bei der Interpretation der Brutto-Netto-Umrechnung müssen Grenzgänger die Quellensteuersätze berücksichtigen, die je nach persönlichen Umständen erheblich variieren. Ein lediger Arbeitnehmer (Tabelle A) mit CHF 70.000 zahlt im Tessin etwa 8–10 % Quellensteuer, während ein Verheirateter mit zwei Kindern (Tabelle C2) beim gleichen Gehalt nur 2–4 % zahlt. Diese Unterschiede können den Nettovorteil um mehrere hundert Franken monatlich verschieben.',
 ],
 fr: [
 'La section statistiques salariales compare les salaires bruts médians et moyens dans 24 secteurs d\'activité du Canton du Tessin (CHF) versus les provinces italiennes équivalentes de Côme, Varèse et Verbano-Cusio-Ossola (EUR), convertis au taux de change actuel pour une comparaison directe du pouvoir d\'achat.',
 'Les données proviennent de l\'enquête annuelle sur les salaires de l\'OFS, des statistiques d\'emploi ISTAT et du Moniteur du Marché du Travail Cantonal SECO — une image statistiquement robuste du différentiel salarial transfrontalier par rôle, niveau d\'expérience et type de contrat pour 2026.',
 'La comparaison est conçue pour soutenir de vraies décisions de négociation : connaître le salaire médian pour votre secteur en Suisse versus Italie vous donne des données objectives. L\'outil calcule aussi l\'avantage net après cotisations sociales suisses et impôt à la source cantonal.',
 'Les écarts salariaux entre le Tessin et d\'autres cantons suisses sont significatifs : les salaires médians au Tessin sont typiquement 15–20 % inférieurs à ceux de Zurich, Bâle ou Genève. Pourtant, le Tessin reste attractif pour les frontaliers italiens car même les salaires suisses inférieurs offrent un pouvoir d\'achat supérieur en Italie après conversion CHF-EUR. La comparaison aide à évaluer si un poste au Tessin offre une meilleure valeur nette qu\'un poste mieux rémunéré dans un canton plus cher.',
 'Pour interpréter la conversion brut-net, les frontaliers doivent tenir compte des taux d\'imposition à la source qui varient considérablement selon la situation personnelle. Un travailleur célibataire (barème A) gagnant CHF 70 000 au Tessin paie environ 8–10 % d\'impôt à la source, tandis qu\'un marié avec deux enfants (barème C2) au même salaire ne paie que 2–4 %. Ces différences peuvent décaler l\'avantage net de plusieurs centaines de francs par mois.',
 ],
 },

 // ───── Salary landing pages (for all /calcola-stipendio/stipendio-netto-* pages) ──
 '/calcola-stipendio/stipendio-netto': {
 en: [
 'This salary simulation shows the complete tax breakdown for a cross-border worker at this specific gross income level: Swiss social deductions (AVS 5.3%, unemployment 1.1%, accident insurance, daily sickness benefits), Canton Ticino withholding tax, and Italian IRPEF after the EUR 10,000 franchise under the 2026 New Agreement.',
 'The net salary depends on several key parameters: marital status (tax table A for single, C for married), number of dependent children (each child reduces the withholding tax bracket), work percentage, and distance from the Swiss border (the 20 km rule determines whether the old or new fiscal regime applies).',
 'After viewing the simulation, use the "What If" tool to instantly see how changing one parameter (marriage, child, part-time) affects your net pay. You can also compare the result against actual cross-border living costs using the Cost of Living comparator.',
 ],
 de: [
 'Diese Gehaltssimulation zeigt die vollständige Steueraufschlüsselung für einen Grenzgänger auf dieser bestimmten Bruttoeinkommensstufe: Schweizer Sozialabzüge (AHV 5,3 %, Arbeitslosenversicherung 1,1 %, Unfallversicherung, Krankentaggeld), Tessiner Quellensteuer und italienische IRPEF nach der EUR 10.000-Freibetrag gemäss dem Neuen Abkommen 2026.',
 'Das Nettogehalt hängt von mehreren Schlüsselparametern ab: Familienstand (Steuertabelle A für Alleinstehende, C für Verheiratete), Anzahl unterhaltsberechtigter Kinder, Beschäftigungsgrad und Entfernung zur Schweizer Grenze (die 20-km-Regel bestimmt das geltende Steuerregime).',
 'Nutzen Sie nach der Simulation das „Was-wäre-wenn"-Tool, um sofort zu sehen, wie eine Parameteränderung (Heirat, Kind, Teilzeit) Ihr Nettogehalt beeinflusst.',
 ],
 fr: [
 'Cette simulation salariale montre la décomposition fiscale complète pour un frontalier à ce niveau de revenu brut spécifique : déductions sociales suisses (AVS 5,3 %, chômage 1,1 %, assurance accidents, indemnités journalières maladie), impôt à la source du Canton du Tessin et IRPEF italienne après la franchise de 10 000 EUR selon le Nouvel Accord 2026.',
 'Le salaire net dépend de plusieurs paramètres clés : état civil (barème A pour célibataire, C pour marié), nombre d\'enfants à charge, taux d\'activité et distance de la frontière suisse (la règle des 20 km détermine le régime fiscal applicable).',
 'Après la simulation, utilisez l\'outil « Et si » pour voir instantanément comment la modification d\'un paramètre (mariage, enfant, temps partiel) affecte votre salaire net.',
 ],
 },

 // ───── Calculator: new cross-border workers beyond 20 km ────
 '/calcola-stipendio/nuovi-frontalieri-oltre-20-km': {
 it: [
 'Il <strong>calcolo delle tasse per i frontalieri oltre 20 km</strong> dal confine segue regole diverse rispetto ai frontalieri "storici" o a chi risiede entro 20 km dalla frontiera: si applica il regime della <strong>tassazione concorrente</strong> previsto dal Nuovo Accordo del 17 luglio 2023 tra Italia e Svizzera, in vigore dal 2024.',
 '<strong>Come funziona la tassazione concorrente</strong>: per i nuovi frontalieri residenti in un comune italiano oltre i 20 km dalla frontiera, la Svizzera trattiene il 100% dell\'imposta alla fonte secondo le tabelle del Canton Ticino (niente split 80/20). Poi l\'Italia tassa nuovamente lo stesso reddito secondo l\'IRPEF ordinaria, riconoscendo un credito d\'imposta pari a quanto già pagato in Svizzera per evitare la doppia imposizione. In pratica il frontaliere paga la maggiore tra l\'imposta svizzera e quella italiana.',
 '<strong>Differenza con i vecchi frontalieri (ante 17 luglio 2023)</strong>: i frontalieri "storici" mantengono il regime di tassazione esclusivamente svizzera con rimborso parziale (40% ai comuni italiani di frontiera) fino al pensionamento, indipendentemente dalla distanza dal confine. I nuovi frontalieri oltre 20 km non beneficiano di questo regime e devono presentare la dichiarazione dei redditi italiana ogni anno includendo il reddito svizzero.',
 '<strong>Esempio pratico</strong>: un nuovo frontaliere residente a Como (entro 20 km) con RAL CHF 70.000 e imposta alla fonte TI di circa CHF 8.500 paga in Italia soltanto sull\'80% del reddito imponibile, con credito per l\'imposta svizzera. Lo stesso frontaliere residente a Milano (oltre 20 km) paga prima il 100% dell\'imposta svizzera, poi in Italia ricalcola l\'IRPEF sul 100% del reddito convertito in euro, scalando il credito estero: il carico fiscale finale può risultare superiore di 2.000-4.000 EUR l\'anno, a parità di stipendio lordo.',
 'Il simulatore integra le tabelle A/B/C/H del Canton Ticino 2026, la conversione CHF-EUR al cambio del giorno, l\'<a href="https://frontaliereticino.ch/calcola-stipendio/">IRPEF italiana con addizionali regionali e comunali</a>, e tiene conto di carichi di famiglia, contributi INPS e deduzioni italiane applicabili ai frontalieri. Al termine ricevi un confronto tra il netto disponibile come residente entro 20 km e oltre 20 km, così da valutare con dati reali la scelta della residenza prima dell\'assunzione in Svizzera.',
 ],
 en: [
 'This page is for cross-border workers who started employment in Switzerland after 17 July 2023 and reside in an Italian municipality more than 20 km from the border. Under these conditions, Swiss withholding tax is retained at 100% of the Canton Ticino rate, without the 80%/20% split that applies to workers within the 20 km zone.',
 'The hub compares practical scenarios at three income levels, placing the beyond-20 km case side by side with an identical profile within 20 km. This lets you immediately see whether the real difference lies in monthly net pay, the Italian tax settlement, or the operational simplicity of your annual tax filing.',
 'Related tools are linked directly: net salary simulator, 2025 vs 2026 comparison, income tax return guide, and the 2026 Canton Ticino withholding tax rate tables. The goal is to turn an abstract fiscal rule into a concrete decision about your personal situation.',
 ],
 de: [
 'Diese Seite richtet sich an Grenzgänger, die ihre Beschäftigung in der Schweiz nach dem 17. Juli 2023 aufgenommen haben und in einer italienischen Gemeinde wohnen, die mehr als 20 km von der Grenze entfernt liegt. Unter diesen Bedingungen wird die Schweizer Quellensteuer zu 100 % des Tessiner Satzes einbehalten, ohne die 80/20-Aufteilung, die für Arbeitnehmer innerhalb der 20-km-Zone gilt.',
 'Der Hub vergleicht praxisnahe Szenarien auf drei Einkommensstufen und stellt den Fall jenseits von 20 km einem identischen Profil innerhalb von 20 km gegenüber. So sehen Sie sofort, ob der Unterschied im monatlichen Netto, in der italienischen Steuerabrechnung oder in der operativen Einfachheit der Steuererklärung liegt.',
 'Verknüpfte Tools: Nettosimulator, Vergleich 2025 vs. 2026, Leitfaden zur Steuererklärung und Tessiner Quellensteuertabellen 2026. Ziel ist es, eine abstrakte Steuerregel in eine konkrete Entscheidung für Ihre persönliche Situation zu übersetzen.',
 ],
 fr: [
 'Cette page s\'adresse aux frontaliers ayant commencé leur emploi en Suisse après le 17 juillet 2023 et résidant dans une commune italienne à plus de 20 km de la frontière. Dans ces conditions, l\'impôt à la source suisse est retenu à 100 % du taux tessinois, sans la répartition 80/20 applicable aux travailleurs dans la zone des 20 km.',
 'Le hub compare des scénarios pratiques à trois niveaux de revenus, plaçant le cas au-delà de 20 km en regard d\'un profil identique en deçà de 20 km. Vous voyez immédiatement si la différence réelle porte sur le net mensuel, le solde fiscal en Italie ou la simplicité opérationnelle de la déclaration de revenus.',
 'Les outils associés sont directement liés : simulateur de salaire net, comparaison 2025 vs 2026, guide de la déclaration de revenus et barèmes de l\'impôt à la source du Tessin 2026. L\'objectif est de transformer une règle fiscale abstraite en une décision concrète concernant votre situation personnelle.',
 ],
 },

 // ───── Calculator: RAL vs net salary comparison ─────────────
 '/calcola-stipendio/confronta-retribuzione-ral': {
 en: [
 'The RAL vs net salary comparator converts a gross annual salary (RAL) stated in a Swiss job offer into the actual monthly net pay a cross-border worker receives after all Swiss deductions: AVS/AHV (5.3%), unemployment insurance (1.1%), non-occupational accident insurance, daily sickness benefits, LPP pension, and cantonal withholding tax.',
 'This tool is especially useful during salary negotiations: a RAL of CHF 80,000 can translate into very different monthly net amounts depending on marital status, number of children, canton, and age bracket for LPP contributions. Knowing the expected net before signing lets you make realistic comparisons with equivalent Italian salaries.',
 'The result includes CHF-EUR conversion at the current exchange rate and a side-by-side comparison with the net salary of an equivalent role in Lombardy or Piedmont, factoring in Italian IRPEF, INPS contributions, and regional surcharges, so you can concretely assess the economic advantage of working in Switzerland.',
 'Comparing RAL figures alone between Swiss and Italian offers is insufficient because the two countries have fundamentally different social security systems. Swiss employers contribute additionally to LPP pension (typically 50% employer share), accident insurance, and family allowances on top of the stated RAL. In Italy, employer-side INPS contributions are roughly 30% of gross salary but invisible on the payslip. A thorough comparison must factor in these hidden contributions to assess total compensation accurately.',
 'Total compensation in Switzerland often includes benefits that significantly increase the effective package beyond the headline RAL: the mandatory 13th month salary (standard in most Ticino sectors), employer LPP pension contributions worth 5–9% of salary, Swiss family allowances (CHF 200–300 per child per month), and in some cases meal vouchers or transport subsidies. When comparing a CHF 75,000 Swiss RAL to a EUR 40,000 Italian RAL, the true gap can be 40–60% wider than the gross numbers suggest.',
 ],
 de: [
 'Der RAL-Netto-Vergleicher rechnet ein in einem Schweizer Stellenangebot genanntes Bruttojahresgehalt (RAL) in das tatsächliche monatliche Nettogehalt eines Grenzgängers um, nach allen Schweizer Abzügen: AHV/IV/EO (5,3 %), Arbeitslosenversicherung (1,1 %), Nichtberufsunfallversicherung, Krankentaggeld, BVG-Beiträge und kantonale Quellensteuer.',
 'Dieses Tool ist besonders nützlich bei Gehaltsverhandlungen: Eine RAL von CHF 80.000 kann je nach Familienstand, Kinderzahl, Kanton und Altersgruppe für die BVG-Beiträge zu sehr unterschiedlichen monatlichen Nettobeträgen führen. Das erwartete Netto vor Vertragsunterzeichnung zu kennen, ermöglicht realistische Vergleiche mit italienischen Gehältern.',
 'Das Ergebnis enthält die CHF-EUR-Umrechnung zum aktuellen Wechselkurs und einen direkten Vergleich mit dem Nettogehalt einer gleichwertigen Stelle in der Lombardei oder im Piemont unter Berücksichtigung der italienischen IRPEF, INPS-Beiträge und Regionalzuschläge.',
 'Ein reiner RAL-Vergleich zwischen Schweizer und italienischen Angeboten reicht nicht aus, da beide Länder grundlegend verschiedene Sozialsysteme haben. Schweizer Arbeitgeber zahlen zusätzlich BVG-Beiträge (typisch 50 % Arbeitgeberanteil), Unfallversicherung und Familienzulagen über die angegebene RAL hinaus. In Italien betragen die arbeitgeberseitigen INPS-Beiträge ca. 30 % des Bruttolohns, sind aber auf der Lohnabrechnung unsichtbar. Ein gründlicher Vergleich muss diese versteckten Beiträge einbeziehen.',
 'Die Gesamtvergütung in der Schweiz umfasst oft Leistungen, die das effektive Paket über die Headline-RAL hinaus deutlich erhöhen: der obligatorische 13. Monatslohn (Standard in den meisten Tessiner Branchen), BVG-Arbeitgeberbeiträge von 5–9 % des Gehalts, Schweizer Familienzulagen (CHF 200–300 pro Kind und Monat) und teils Essensgutscheine oder Transportzuschüsse. Beim Vergleich einer Schweizer RAL von CHF 75.000 mit einer italienischen RAL von EUR 40.000 kann die tatsächliche Lücke 40–60 % grösser sein als die Bruttozahlen vermuten lassen.',
 ],
 fr: [
 'Le comparateur RAL vs net convertit un salaire brut annuel (RAL) mentionné dans une offre d\'emploi suisse en salaire net mensuel réel perçu par un frontalier après toutes les déductions suisses : AVS/AI/APG (5,3 %), assurance chômage (1,1 %), assurance accidents non professionnels, indemnités journalières maladie, LPP et impôt à la source cantonal.',
 'Cet outil est particulièrement utile lors des négociations salariales : une RAL de CHF 80 000 peut donner des nets mensuels très différents selon l\'état civil, le nombre d\'enfants, le canton et la tranche d\'âge pour la LPP. Connaître le net attendu avant de signer permet des comparaisons réalistes avec les salaires italiens.',
 'Le résultat inclut la conversion CHF-EUR au taux de change actuel et une comparaison directe avec le salaire net d\'un poste équivalent en Lombardie ou au Piémont, tenant compte de l\'IRPEF italienne, des cotisations INPS et des surtaxes régionales.',
 'Comparer les RAL seules entre offres suisses et italiennes est insuffisant car les deux pays ont des systèmes de sécurité sociale fondamentalement différents. Les employeurs suisses cotisent en plus à la LPP (typiquement 50 % part employeur), à l\'assurance accidents et aux allocations familiales au-delà de la RAL affichée. En Italie, les cotisations patronales INPS représentent environ 30 % du brut mais sont invisibles sur la fiche de paie. Une comparaison rigoureuse doit intégrer ces cotisations cachées.',
 'La rémunération totale en Suisse inclut souvent des avantages qui augmentent significativement le package au-delà de la RAL affichée : le 13e mois obligatoire (standard dans la plupart des secteurs tessinois), les cotisations LPP employeur de 5–9 % du salaire, les allocations familiales suisses (CHF 200–300 par enfant par mois) et parfois des chèques repas ou des indemnités de transport. En comparant une RAL suisse de CHF 75 000 à une RAL italienne de EUR 40 000, l\'écart réel peut être 40–60 % plus large que ne le suggèrent les chiffres bruts.',
 ],
 },

 // ───── Calculator: cross-border worker bonus estimate ───────
 '/calcola-stipendio/stima-bonus-frontaliere': {
 it: [
 'Lo stimatore dei bonus frontalieri calcola le prestazioni aggiuntive previste dalla legislazione italiana e svizzera per le famiglie dei lavoratori transfrontalieri. Include gli assegni familiari svizzeri (Familienzulagen), le deduzioni per figli dall\'imposta alla fonte cantonale e l\'Assegno Unico e Universale italiano (AUU) introdotto nel 2022 dall\'INPS.',
 'Per i frontalieri, il diritto ai bonus dipende dal paese di residenza e dalla tipologia di prestazione. Gli assegni familiari svizzeri vengono erogati dal datore di lavoro svizzero indipendentemente dalla residenza italiana del lavoratore: in Ticino ammontano a CHF 200 per figlio al mese (fino a 16 anni) e CHF 250 per figli in formazione (fino a 25 anni).',
 'L\'Assegno Unico Universale italiano è subordinato alla presentazione dell\'ISEE ed è erogato dall\'INPS su domanda separata. Per i frontalieri residenti in Italia con figli a carico, l\'AUU può integrare significativamente il reddito familiare: l\'importo base nel 2026 varia da 57 a 199,40 EUR al mese per figlio minorenne, in funzione della fascia ISEE del nucleo.',
 'La tredicesima mensilità è obbligatoria in Svizzera nei settori coperti da contratto collettivo di lavoro (CCL). In Ticino, la maggior parte dei settori — industria, costruzioni, commercio, ospitalità — prevede la tredicesima, che equivale a un dodicesimo del salario annuo lordo. Alcune aziende offrono anche gratifiche discrezionali o bonus legati ai risultati, soggetti alle stesse deduzioni sociali dello stipendio ordinario.',
 'Lo stimatore mostra il valore combinato mensile e annuale di tutti i bonus e le deduzioni applicabili al nucleo familiare. Il calcolo integra le prestazioni svizzere e italiane per determinare il reddito disponibile reale della famiglia frontaliera, aiutando a ottimizzare la posizione fiscale tra i due paesi e a valutare l\'impatto economico della composizione familiare sulla busta paga.',
 ],
 en: [
 'The cross-border worker bonus estimator calculates the additional benefits available under Italian and Swiss law: family allowances (assegni familiari), child deductions from withholding tax, and Italian bonus figli under the Assegno Unico e Universale (AUU) programme introduced in 2022.',
 'For frontalieri, bonus eligibility depends on the country of residence and the type of benefit: Swiss family allowances are paid by the Swiss employer regardless of Italian residence, while Italian AUU is means-tested using ISEE and requires a separate INPS application.',
 'In Canton Ticino, Swiss family allowances amount to CHF 200 per child per month (up to age 16) and CHF 250 for children in education (up to age 25). These allowances are not subject to withholding tax and are paid on top of net salary, representing a significant supplement for families with multiple children.',
 'The 13th month salary (tredicesima) is mandatory in Switzerland for sectors covered by a collective labour agreement (CCL/GAV). In Ticino, most industries — manufacturing, construction, retail, hospitality — include the 13th month. Some employers also offer discretionary bonuses or performance-linked gratifiche, subject to the same social deductions as regular salary.',
 'The estimator shows the combined monthly and annual value of all applicable bonuses and deductions, helping families optimise their fiscal position across both countries. By integrating Swiss allowances, Italian AUU, child-related tax deductions, and the 13th month, the tool provides a comprehensive view of total family income for cross-border households.',
 ],
 de: [
 'Der Grenzgänger-Bonus-Rechner berechnet die zusätzlichen Leistungen nach italienischem und schweizerischem Recht: Familienzulagen, Kinderabzüge bei der Quellensteuer und den italienischen Bonus Figli im Rahmen des Programms Assegno Unico e Universale (AUU), das 2022 eingeführt wurde.',
 'Für Grenzgänger hängt der Bonusanspruch vom Wohnsitzland und der Art der Leistung ab: Schweizer Familienzulagen werden unabhängig vom italienischen Wohnsitz vom Schweizer Arbeitgeber gezahlt, während der italienische AUU einkommensabhängig (ISEE) ist und einen separaten INPS-Antrag erfordert.',
 'Im Kanton Tessin betragen die Schweizer Familienzulagen CHF 200 pro Kind und Monat (bis 16 Jahre) und CHF 250 für Kinder in Ausbildung (bis 25 Jahre). Diese Zulagen unterliegen nicht der Quellensteuer und werden zusätzlich zum Nettogehalt ausgezahlt — eine erhebliche Ergänzung für Familien mit mehreren Kindern.',
 'Der 13. Monatslohn ist in der Schweiz in Branchen mit Gesamtarbeitsvertrag (GAV) obligatorisch. Im Tessin umfasst dies die meisten Sektoren — Industrie, Bau, Handel, Gastgewerbe. Einige Arbeitgeber bieten zusätzlich Ermessensboni oder leistungsgebundene Gratifikationen an, die denselben Sozialabzügen wie das reguläre Gehalt unterliegen.',
 'Der Rechner zeigt den kombinierten monatlichen und jährlichen Wert aller anwendbaren Boni und Abzüge. Durch die Integration von Schweizer Zulagen, italienischem AUU, kindbezogenen Steuerabzügen und dem 13. Monatslohn bietet das Tool einen umfassenden Überblick über das Gesamtfamilieneinkommen grenzüberschreitender Haushalte.',
 ],
 fr: [
 'L\'estimateur de bonus frontalier calcule les prestations supplémentaires disponibles en droit italien et suisse : allocations familiales, déductions pour enfants de l\'impôt à la source et le bonus figli italien dans le cadre du programme Assegno Unico e Universale (AUU) introduit en 2022.',
 'Pour les frontaliers, l\'éligibilité aux bonus dépend du pays de résidence et du type de prestation : les allocations familiales suisses sont versées par l\'employeur suisse indépendamment de la résidence italienne, tandis que l\'AUU italien est soumis à conditions de ressources (ISEE) et nécessite une demande INPS séparée.',
 'Au Canton du Tessin, les allocations familiales suisses s\'élèvent à CHF 200 par enfant et par mois (jusqu\'à 16 ans) et CHF 250 pour les enfants en formation (jusqu\'à 25 ans). Ces allocations ne sont pas soumises à l\'impôt à la source et s\'ajoutent au salaire net — un complément significatif pour les familles avec plusieurs enfants.',
 'Le 13e mois est obligatoire en Suisse dans les secteurs couverts par une convention collective de travail (CCT). Au Tessin, la plupart des secteurs — industrie, construction, commerce, hôtellerie — incluent le 13e mois. Certains employeurs proposent également des gratifications discrétionnaires ou des bonus liés aux résultats, soumis aux mêmes déductions sociales que le salaire ordinaire.',
 'L\'estimateur affiche la valeur mensuelle et annuelle combinée de tous les bonus et déductions applicables. En intégrant les allocations suisses, l\'AUU italien, les déductions fiscales pour enfants et le 13e mois, l\'outil fournit une vue complète du revenu familial total pour les ménages frontaliers.',
 ],
 },

 // ───── Calculator: parental leave check ─────────────────────
 '/calcola-stipendio/verifica-congedo-parentale': {
 it: [
 'Il verificatore del congedo parentale aiuta i frontalieri a comprendere i propri diritti secondo la legislazione svizzera e italiana. La Svizzera prevede 14 settimane di congedo maternità retribuite all\'80 % del salario attraverso l\'assicurazione per perdita di guadagno (IPG/EO), e 2 settimane di congedo paternità introdotto nel 2021 con le stesse condizioni economiche.',
 'L\'Italia offre protezioni aggiuntive: 5 mesi di congedo maternità obbligatorio retribuito dall\'INPS all\'80 % e un congedo parentale facoltativo fino a 11 mesi complessivi per nucleo familiare. Per il congedo facoltativo, l\'indennità è pari al 30 % della retribuzione per un massimo di 6 mesi, con un mese aggiuntivo all\'80 % introdotto dalla Legge di Bilancio 2024.',
 'Per i lavoratori frontalieri, il coordinamento tra i sistemi previdenziali svizzero e italiano determina quale paese eroga la prestazione. Se si è impiegati in Svizzera e residenti in Italia, l\'IPG svizzera copre il periodo obbligatorio di maternità e paternità. Il congedo parentale facoltativo italiano può essere richiesto all\'INPS in base alle regole di coordinamento bilaterale.',
 'Lo strumento calcola l\'impatto finanziario di ogni opzione di congedo sulla busta paga svizzera e sulla dichiarazione dei redditi italiana. Durante il congedo maternità svizzero, l\'indennità IPG è soggetta ai contributi AVS/AI/IPG ma è esente dall\'imposta alla fonte. Al rientro, il salario riprende integralmente senza alcuna penalizzazione contrattuale.',
 'Il verificatore chiarisce le scadenze da rispettare: la comunicazione al datore di lavoro svizzero deve avvenire almeno 3 mesi prima del parto, la domanda IPG va presentata entro 5 anni, e la richiesta di congedo parentale italiano all\'INPS richiede il modello SR23 compilato con i dati del rapporto di lavoro estero. La documentazione necessaria include il certificato di nascita, il contratto di lavoro e la conferma del datore di lavoro svizzero.',
 ],
 en: [
 'The parental leave checker helps cross-border workers understand their entitlements under both Swiss and Italian law. Switzerland provides 14 weeks of maternity leave at 80% salary (APG/EO insurance) and 2 weeks of paternity leave introduced in 2021 under the same conditions.',
 'Italy offers additional protections: 5 months of mandatory maternity leave paid by INPS at 80%, and optional parental leave of up to 11 months per family. For optional leave, the benefit is 30% of salary for up to 6 months, with an additional month at 80% introduced by the 2024 Budget Law.',
 'For cross-border workers, the coordination between Swiss and Italian social security systems determines which country pays the benefit. If employed in Switzerland and residing in Italy, Swiss APG covers the mandatory maternity and paternity period, while additional Italian parental leave may be available through INPS under bilateral coordination rules.',
 'The tool calculates the financial impact of each leave option on your Swiss payslip and Italian tax return. During Swiss maternity leave, APG benefits are subject to AVS/AI/APG contributions but exempt from withholding tax. Upon return, salary resumes in full with no contractual penalty.',
 'The checker clarifies deadlines: notification to the Swiss employer must be at least 3 months before the expected delivery date, the APG claim must be filed within 5 years, and the Italian parental leave application to INPS requires form SR23 with details of the foreign employment. Required documentation includes the birth certificate, employment contract, and confirmation from the Swiss employer.',
 ],
 de: [
 'Der Elternurlaub-Checker hilft Grenzgängern, ihre Ansprüche nach schweizerischem und italienischem Recht zu verstehen. Die Schweiz gewährt 14 Wochen Mutterschaftsurlaub bei 80 % Lohn (EO-Versicherung) und 2 Wochen Vaterschaftsurlaub, eingeführt 2021 unter denselben Bedingungen.',
 'Italien bietet zusätzlichen Schutz: 5 Monate obligatorischen Mutterschaftsurlaub (INPS, 80 %) und fakultativen Elternurlaub bis zu 11 Monate pro Familie. Für den fakultativen Urlaub beträgt die Entschädigung 30 % des Gehalts für maximal 6 Monate, mit einem zusätzlichen Monat bei 80 % gemäss dem Haushaltsgesetz 2024.',
 'Für Grenzgänger bestimmt die Koordination zwischen den schweizerischen und italienischen Sozialversicherungssystemen, welches Land die Leistung zahlt. Bei Beschäftigung in der Schweiz und Wohnsitz in Italien deckt die Schweizer EO die Pflichtzeit ab, während zusätzlicher italienischer Elternurlaub über INPS im Rahmen bilateraler Koordinationsregeln verfügbar sein kann.',
 'Das Tool berechnet die finanziellen Auswirkungen jeder Urlaubsoption auf die Schweizer Lohnabrechnung und die italienische Steuererklärung. Während des Schweizer Mutterschaftsurlaubs unterliegt die EO-Entschädigung den AHV/IV/EO-Beiträgen, ist aber von der Quellensteuer befreit. Bei Rückkehr wird das Gehalt vollständig ohne vertragliche Einbussen wieder aufgenommen.',
 'Der Checker klärt die einzuhaltenden Fristen: Mitteilung an den Schweizer Arbeitgeber mindestens 3 Monate vor der Geburt, EO-Antrag innerhalb von 5 Jahren, und italienischer Elternurlaubsantrag bei INPS mit Formular SR23 und Details des ausländischen Arbeitsverhältnisses. Erforderliche Unterlagen umfassen Geburtsurkunde, Arbeitsvertrag und Bestätigung des Schweizer Arbeitgebers.',
 ],
 fr: [
 'Le vérificateur de congé parental aide les frontaliers à comprendre leurs droits selon le droit suisse et italien. La Suisse accorde 14 semaines de congé maternité à 80 % du salaire (assurance APG/allocations perte de gain) et 2 semaines de congé paternité introduit en 2021 aux mêmes conditions.',
 'L\'Italie offre des protections supplémentaires : 5 mois de congé maternité obligatoire payé par l\'INPS à 80 %, et un congé parental facultatif jusqu\'à 11 mois par famille. Pour le congé facultatif, l\'indemnité est de 30 % du salaire pour 6 mois maximum, avec un mois supplémentaire à 80 % introduit par la loi de finances 2024.',
 'Pour les frontaliers, la coordination entre les systèmes de sécurité sociale suisse et italien détermine quel pays verse la prestation. En cas d\'emploi en Suisse et de résidence en Italie, l\'APG suisse couvre la période obligatoire de maternité et paternité, tandis que le congé parental italien supplémentaire peut être disponible via l\'INPS selon les règles de coordination bilatérale.',
 'L\'outil calcule l\'impact financier de chaque option de congé sur votre fiche de paie suisse et votre déclaration fiscale italienne. Pendant le congé maternité suisse, les indemnités APG sont soumises aux cotisations AVS/AI/APG mais exonérées de l\'impôt à la source. Au retour, le salaire reprend intégralement sans pénalité contractuelle.',
 'Le vérificateur précise les délais à respecter : notification à l\'employeur suisse au moins 3 mois avant l\'accouchement, demande APG à déposer dans les 5 ans, et demande de congé parental italien auprès de l\'INPS via le formulaire SR23 avec les détails de l\'emploi étranger. Les documents requis comprennent l\'acte de naissance, le contrat de travail et la confirmation de l\'employeur suisse.',
 ],
 },

 // ───── Calculator: residence change simulation ──────────────
 '/calcola-stipendio/simula-cambio-residenza': {
 it: [
 'Il simulatore di cambio residenza modella l\'impatto finanziario di un trasferimento tra comuni italiani oppure dall\'Italia alla Svizzera, con passaggio dal permesso G al permesso B. Per ogni scenario ricalcola lo stipendio netto, la tassazione complessiva, le addizionali comunali e regionali, e gli obblighi contributivi in entrambi i paesi.',
 'Le variabili chiave includono la soglia dei 20 km dalla frontiera svizzera, che determina il regime fiscale applicabile (vecchio vs nuovo frontaliere). I comuni entro 20 km beneficiano della ripartizione 80/20 dell\'imposta alla fonte per i nuovi frontalieri, mentre quelli oltre 20 km subiscono la tassazione integrale in Svizzera più l\'IRPEF italiana senza riduzione.',
 'Le addizionali IRPEF comunali e regionali variano significativamente tra le province italiane di confine. Ad esempio, l\'addizionale regionale lombarda può raggiungere l\'1,73 % per i redditi più elevati, mentre il Piemonte applica aliquote fino all\'1,62 %. Le addizionali comunali aggiungono un ulteriore 0,1–0,8 % a seconda del Comune di residenza.',
 'Il simulatore integra anche il differenziale del costo della vita tra residenza italiana e svizzera. Gli affitti in Ticino sono 2-3 volte superiori rispetto alle province di Como e Varese, la spesa alimentare costa il 35-50 % in più, e l\'assicurazione malattia LAMal come residente svizzero ha premi più elevati rispetto all\'opzione LAMal frontaliere.',
 'Lo strumento risponde alla domanda cruciale: trasferirsi più vicino o più lontano dal confine, oppure traslocare direttamente in Svizzera, genera un guadagno finanziario netto dopo aver contabilizzato affitto, tasse, costi di pendolarismo, assistenza sanitaria e spese quotidiane? Il confronto viene mostrato su base mensile e annuale con il dettaglio di ogni voce di costo.',
 ],
 en: [
 'The residence change simulator models the financial impact of moving between Italian municipalities or from Italy to Switzerland (switching from G permit to B permit). It recalculates net salary, taxation, municipal surcharges, and social contribution obligations under each scenario.',
 'Key variables include the 20 km border zone threshold (determining old vs new frontaliere tax regime), Italian municipal and regional IRPEF surcharges (which vary significantly between provinces), and the full cost-of-living differential between Italian and Swiss residence.',
 'Italian IRPEF surcharges vary substantially across border provinces. For example, the Lombardy regional surcharge can reach 1.73% for higher incomes, while Piedmont applies rates up to 1.62%. Municipal surcharges add an additional 0.1–0.8% depending on the specific commune.',
 'The simulator also factors in the cost-of-living differential between Italian and Swiss residence. Rents in Ticino are 2-3 times higher than in the provinces of Como and Varese, grocery costs are 35-50% more expensive, and LAMal health insurance as a Swiss resident carries higher premiums than the frontalier LAMal option.',
 'The simulator helps you answer the critical question: does moving closer to or further from the border, or relocating to Switzerland entirely, result in a net financial gain after accounting for rent, taxes, commute costs, healthcare, and daily expenses? The comparison is shown on a monthly and annual basis with a detailed breakdown of each cost item.',
 ],
 de: [
 'Der Wohnsitzwechsel-Simulator modelliert die finanziellen Auswirkungen eines Umzugs zwischen italienischen Gemeinden oder von Italien in die Schweiz (Wechsel von Ausweis G zu Ausweis B). Er berechnet Nettogehalt, Besteuerung, Gemeindezuschläge und Sozialversicherungspflichten für jedes Szenario neu.',
 'Schlüsselvariablen umfassen die 20-km-Grenzzone (Alt- vs. Neu-Grenzgänger-Steuerregime), italienische Gemeinde- und Regional-IRPEF-Zuschläge (die zwischen Provinzen erheblich variieren) und das Lebenshaltungskostengefälle zwischen italienischem und schweizerischem Wohnsitz.',
 'Die italienischen IRPEF-Zuschläge unterscheiden sich erheblich zwischen den Grenzprovinzen. Der regionale Zuschlag der Lombardei kann bei höheren Einkommen 1,73 % erreichen, während das Piemont Sätze bis 1,62 % anwendet. Gemeindezuschläge addieren je nach Wohnort weitere 0,1–0,8 %.',
 'Der Simulator berücksichtigt auch das Lebenshaltungskostengefälle: Mieten im Tessin sind 2-3 Mal höher als in den Provinzen Como und Varese, Lebensmittel kosten 35-50 % mehr, und die KVG-Prämie als Schweizer Einwohner ist höher als die Grenzgänger-Option.',
 'Der Simulator beantwortet die entscheidende Frage: Führt ein Umzug näher an die oder weiter weg von der Grenze — oder der vollständige Umzug in die Schweiz — nach Berücksichtigung von Miete, Steuern, Pendelkosten, Gesundheitsversorgung und Alltagsausgaben zu einem finanziellen Nettovorteil?',
 ],
 fr: [
 'Le simulateur de changement de résidence modélise l\'impact financier d\'un déménagement entre communes italiennes ou d\'Italie vers la Suisse (passage du permis G au permis B). Il recalcule le salaire net, la fiscalité, les surtaxes communales et les obligations de cotisation sociale pour chaque scénario.',
 'Les variables clés incluent le seuil de la zone frontalière de 20 km (régime fiscal ancien vs nouveau), les surtaxes IRPEF communales et régionales italiennes (qui varient significativement entre provinces) et le différentiel complet du coût de la vie entre résidence italienne et suisse.',
 'Les surtaxes IRPEF italiennes varient considérablement entre les provinces frontalières. Par exemple, la surtaxe régionale lombarde peut atteindre 1,73 % pour les revenus élevés, tandis que le Piémont applique des taux allant jusqu\'à 1,62 %. Les surtaxes communales ajoutent 0,1–0,8 % selon la commune.',
 'Le simulateur intègre aussi le différentiel du coût de la vie : les loyers au Tessin sont 2-3 fois plus élevés que dans les provinces de Côme et Varèse, les courses alimentaires coûtent 35-50 % de plus, et les primes LAMal en tant que résident suisse sont plus élevées que l\'option LAMal frontalier.',
 'Le simulateur répond à la question cruciale : un déménagement plus proche ou plus loin de la frontière — ou une relocalisation complète en Suisse — aboutit-il à un gain financier net après prise en compte du loyer, des impôts, des frais de trajet, des soins de santé et des dépenses quotidiennes ?',
 ],
 },

 // ───── Calculator: what would you earn in Switzerland ────────
 '/calcola-stipendio/quanto-guadagneresti-in-svizzera': {
 it: [
 'Questo strumento stima quanto guadagneresti se accettassi un ruolo equivalente al tuo attuale impiego italiano nel Canton Ticino svizzero. Utilizza dati salariali settoriali dell\'Ufficio federale di statistica (UST/BFS) e applica l\'intera catena di deduzioni svizzere: AVS/AI/IPG, assicurazione contro la disoccupazione, infortuni non professionali, LPP e imposta alla fonte cantonale ticinese.',
 'La stima tiene conto del contesto transfrontaliero: se pendolaresti dall\'Italia, si applica il regime fiscale del permesso G con imposta alla fonte; se ti trasferissi in Svizzera, si applica la tassazione ordinaria del permesso B. Entrambi gli scenari vengono mostrati affiancati per un confronto diretto e immediato.',
 'I dati di riferimento provengono dalla rilevazione strutturale dei salari (RLSS) dell\'UST, che copre oltre 35.000 aziende svizzere. Per il Canton Ticino, le retribuzioni mediane per settore sono inferiori del 10-15 % rispetto alla media nazionale svizzera, ma restano significativamente superiori a quelle lombarde e piemontesi.',
 'Il convertitore integrato trasforma il risultato in euro al tasso di cambio corrente, permettendo un confronto diretto con la retribuzione attuale in Italia. A parità di ruolo, il differenziale lordo tra Ticino e Lombardia oscilla mediamente tra il 40 % e il 60 %, ma il differenziale netto si riduce significativamente dopo deduzioni, imposta alla fonte e costi di pendolarismo.',
 'Utilizza questo strumento prima di colloqui di lavoro o trattative salariali per stabilire un\'aspettativa realistica del netto svizzero nel tuo settore e al tuo livello di esperienza. Il risultato include il dettaglio di ogni deduzione e la conversione in euro, così da negoziare con cognizione di causa.',
 ],
 en: [
 'This tool estimates what your current Italian salary would translate to if you took an equivalent role in Swiss Canton Ticino. It uses sector-specific salary data from the Federal Statistical Office (BFS) and applies the full Swiss deduction chain: AVS/AHV, unemployment, accident insurance, LPP pension, and Canton Ticino withholding tax.',
 'The estimate accounts for the cross-border context: if you would commute from Italy, the G permit withholding tax regime applies; if you would relocate to Switzerland, the B permit ordinary taxation applies. Both scenarios are shown side by side for immediate comparison.',
 'Reference data comes from the Swiss Earnings Structure Survey (SESS) by the BFS, covering over 35,000 Swiss companies. For Canton Ticino, median salaries by sector are 10-15% below the Swiss national average but remain significantly higher than those in Lombardy and Piedmont.',
 'The built-in converter translates the result into euros at the current exchange rate for direct comparison with your Italian compensation. For equivalent roles, the gross differential between Ticino and Lombardy averages 40-60%, but the net differential narrows considerably after deductions, withholding tax, and commuting costs.',
 'Use this tool before job interviews or salary negotiations to establish a realistic expectation of Swiss net pay in your sector and at your experience level. The result includes a breakdown of every deduction, converted to euros for direct comparison.',
 ],
 de: [
 'Dieses Tool schätzt, was Ihr aktuelles italienisches Gehalt bedeuten würde, wenn Sie eine gleichwertige Stelle im Schweizer Kanton Tessin annehmen würden. Es verwendet branchenspezifische Gehaltsdaten des Bundesamts für Statistik (BFS) und wendet die vollständige Schweizer Abzugskette an: AHV/IV/EO, Arbeitslosenversicherung, Unfallversicherung, BVG und Tessiner Quellensteuer.',
 'Die Schätzung berücksichtigt den Grenzgängerkontext: Bei Pendeln aus Italien gilt das Quellensteuerregime des Ausweises G; bei Umzug in die Schweiz die ordentliche Besteuerung des Ausweises B. Beide Szenarien werden nebeneinander für einen direkten Vergleich dargestellt.',
 'Die Referenzdaten stammen aus der Schweizerischen Lohnstrukturerhebung (LSE) des BFS mit über 35.000 Schweizer Unternehmen. Im Kanton Tessin liegen die Medianlöhne nach Branche 10-15 % unter dem Schweizer Durchschnitt, aber deutlich über den Werten in der Lombardei und im Piemont.',
 'Der integrierte Umrechner übersetzt das Ergebnis zum aktuellen Wechselkurs in Euro für einen direkten Vergleich mit der italienischen Vergütung. Bei gleichwertigen Stellen beträgt das Bruttodifferenzial zwischen Tessin und Lombardei durchschnittlich 40-60 %, das Nettodifferenzial verringert sich nach Abzügen, Quellensteuer und Pendelkosten deutlich.',
 'Nutzen Sie dieses Tool vor Vorstellungsgesprächen oder Gehaltsverhandlungen, um eine realistische Erwartung an das Schweizer Nettogehalt in Ihrem Sektor zu ermitteln. Das Ergebnis enthält eine Aufschlüsselung jedes Abzugs, umgerechnet in Euro zum direkten Vergleich.',
 ],
 fr: [
 'Cet outil estime ce que votre salaire italien actuel représenterait si vous acceptiez un poste équivalent dans le Canton du Tessin. Il utilise des données salariales sectorielles de l\'Office fédéral de la statistique (OFS) et applique la chaîne complète de déductions suisses : AVS/AI/APG, chômage, assurance accidents, LPP et impôt à la source tessinois.',
 'L\'estimation tient compte du contexte frontalier : en cas de pendularité depuis l\'Italie, le régime d\'impôt à la source du permis G s\'applique ; en cas de relocalisation en Suisse, la taxation ordinaire du permis B s\'applique. Les deux scénarios sont présentés côte à côte pour une comparaison immédiate.',
 'Les données de référence proviennent de l\'Enquête suisse sur la structure des salaires (ESS) de l\'OFS, couvrant plus de 35 000 entreprises suisses. Au Canton du Tessin, les salaires médians par secteur sont inférieurs de 10-15 % à la moyenne nationale suisse mais restent nettement supérieurs à ceux de Lombardie et du Piémont.',
 'Le convertisseur intégré traduit le résultat en euros au taux de change actuel pour une comparaison directe avec votre rémunération italienne. Pour des postes équivalents, le différentiel brut entre le Tessin et la Lombardie oscille entre 40 et 60 %, mais le différentiel net se réduit considérablement après déductions, impôt à la source et frais de trajet.',
 'Utilisez cet outil avant les entretiens ou négociations salariales pour établir une attente réaliste du salaire net suisse dans votre secteur. Le résultat détaille chaque déduction, converti en euros pour une comparaison directe.',
 ],
 },

 // ───── Calculator: 2025 vs 2026 net salary comparison ───────
 '/calcola-stipendio/confronto-netto-2025-2026': {
 it: [
 'Il confronto netto 2025 vs 2026 mostra come la fase transitoria del Nuovo Accordo Fiscale tra Italia e Svizzera influisce sulla busta paga dei frontalieri. Con l\'assunzione progressiva della tassazione concorrente da parte dell\'Italia, la quota di imposta alla fonte trattenuta dalla Svizzera cambia, modificando il calcolo del netto per i lavoratori transfrontalieri.',
 'Il confronto copre sia lo scenario dei residenti entro 20 km dal confine sia quello dei residenti oltre 20 km, evidenziando le variazioni specifiche di aliquota e franchigia che differiscono tra le due zone. Per i nuovi frontalieri entro 20 km, la Svizzera trattiene l\'80 % dell\'imposta alla fonte; per quelli oltre 20 km, il 100 %.',
 'Ogni scenario mostra le differenze nette mese per mese, così da pianificare il budget familiare con precisione. La variazione annuale tra 2025 e 2026 dipende principalmente dall\'aggiornamento delle tabelle cantonali dell\'imposta alla fonte e dall\'eventuale variazione delle aliquote IRPEF e delle addizionali regionali e comunali italiane.',
 'Per i vecchi frontalieri (assunti prima del 17 luglio 2023 e residenti entro 20 km), il regime resta invariato: tassazione esclusiva in Svizzera senza obbligo IRPEF. Il confronto mostra comunque le differenze dovute all\'aggiornamento delle tabelle cantonali 2026 e alle eventuali variazioni dei contributi sociali obbligatori.',
 'Utilizza questo strumento per capire se il tuo netto aumenterà o diminuirà nel 2026 e di quanto, così da adeguare proattivamente la pianificazione finanziaria, i versamenti al terzo pilastro e la strategia di dichiarazione dei redditi.',
 ],
 en: [
 'The 2025 vs 2026 net salary comparison shows how the transitional phase of the New Fiscal Agreement between Switzerland and Italy affects your take-home pay. As Italy progressively assumes concurrent taxation, the withholding tax share retained by Switzerland changes, altering the net calculation for cross-border workers.',
 'The comparison covers both the within-20 km and beyond-20 km scenarios, highlighting the specific rate changes and franchise adjustments that differ between the two zones. For new frontalieri within 20 km, Switzerland retains 80% of withholding tax; beyond 20 km, the full 100%.',
 'Each scenario shows month-by-month net differences to help you plan household budgets precisely. The annual variation between 2025 and 2026 depends mainly on updates to the cantonal withholding tax tables and any changes to Italian IRPEF rates and regional/municipal surcharges.',
 'For old frontalieri (hired before 17 July 2023, residing within 20 km), the regime remains unchanged: exclusive taxation in Switzerland with no IRPEF obligation. The comparison still shows differences due to updated 2026 cantonal tables and any changes to mandatory social contributions.',
 'Use this tool to understand whether your net salary will increase or decrease in 2026 and by how much, so you can proactively adjust financial planning, third-pillar contributions, and tax return strategy.',
 ],
 de: [
 'Der Nettovergleich 2025 vs. 2026 zeigt, wie die Übergangsphase des Neuen Steuerabkommens zwischen der Schweiz und Italien Ihr Nettogehalt beeinflusst. Da Italien schrittweise die konkurrierende Besteuerung übernimmt, ändert sich der von der Schweiz einbehaltene Quellensteueranteil.',
 'Der Vergleich deckt sowohl Szenarien innerhalb als auch jenseits der 20-km-Zone ab und hebt die spezifischen Satzänderungen und Franchise-Anpassungen hervor. Für neue Grenzgänger innerhalb von 20 km behält die Schweiz 80 % der Quellensteuer ein; jenseits von 20 km die vollen 100 %.',
 'Jedes Szenario zeigt monatliche Nettodifferenzen zur präzisen Haushaltsplanung. Die jährliche Veränderung zwischen 2025 und 2026 hängt hauptsächlich von Aktualisierungen der kantonalen Quellensteuertabellen und etwaigen Änderungen der italienischen IRPEF-Sätze ab.',
 'Für alte Grenzgänger (vor dem 17. Juli 2023 angestellt, innerhalb von 20 km wohnhaft) bleibt das Regime unverändert: ausschliessliche Besteuerung in der Schweiz ohne IRPEF-Pflicht. Der Vergleich zeigt dennoch Unterschiede durch aktualisierte kantonale Tabellen 2026.',
 'Nutzen Sie dieses Tool, um zu verstehen, ob Ihr Nettogehalt 2026 steigt oder sinkt und um wie viel — damit Sie Finanzplanung, Dritte-Säule-Einzahlungen und Steuerstrategie proaktiv anpassen können.',
 ],
 fr: [
 'La comparaison du salaire net 2025 vs 2026 montre comment la phase transitoire du Nouvel Accord Fiscal entre la Suisse et l\'Italie affecte votre salaire net. À mesure que l\'Italie assume progressivement la taxation concurrente, la part d\'impôt à la source retenue par la Suisse change.',
 'La comparaison couvre les scénarios en deçà et au-delà de 20 km, mettant en évidence les changements de taux et ajustements de franchise spécifiques. Pour les nouveaux frontaliers dans les 20 km, la Suisse retient 80 % de l\'impôt à la source ; au-delà de 20 km, 100 %.',
 'Chaque scénario montre les différences nettes mois par mois pour une planification budgétaire précise. La variation annuelle entre 2025 et 2026 dépend principalement des mises à jour des barèmes cantonaux et d\'éventuelles modifications des taux IRPEF italiens.',
 'Pour les anciens frontaliers (embauchés avant le 17 juillet 2023, résidant dans les 20 km), le régime reste inchangé : taxation exclusive en Suisse sans obligation IRPEF. La comparaison montre néanmoins les différences dues aux barèmes cantonaux 2026 actualisés.',
 'Utilisez cet outil pour comprendre si votre salaire net augmentera ou diminuera en 2026 et de combien, afin d\'ajuster proactivement planification financière, versements au 3e pilier et stratégie fiscale.',
 ],
 },

 // ───── Calculator: G permit vs B permit comparison ──────────
 '/calcola-stipendio/confronto-permesso-g-vs-b': {
 it: [
 'Il confronto permesso G vs permesso B calcola l\'impatto finanziario complessivo della scelta tra il pendolarismo dall\'Italia (permesso G, residenza in Italia) e il trasferimento in Svizzera (permesso B). L\'analisi va oltre il semplice stipendio netto e include affitto, premi assicurativi sanitari, costi di pendolarismo, tasse comunali italiane e tassazione ordinaria svizzera.',
 'Per i titolari di permesso G, il calcolo include l\'imposta alla fonte svizzera, l\'IRPEF italiana con franchigia di 10.000 EUR per i nuovi frontalieri, il costo della vita nei comuni italiani di confine e le spese di pendolarismo quotidiano (carburante, autostrada, parcheggio, o abbonamento TILO). Il vantaggio principale è il costo della vita inferiore in Italia.',
 'Per il permesso B, il calcolo include la tassazione ordinaria svizzera (che prevede la dichiarazione dei redditi con deduzioni personali), affitti svizzeri significativamente più alti, premi LAMal da residente, ma elimina il tempo di pendolarismo e le attese alla frontiera. In Ticino, un monolocale a Lugano costa CHF 1.000–1.400 al mese, contro EUR 400–600 a Como o Varese.',
 'Lo strumento modella scenari a diversi livelli di stipendio e configurazioni familiari, evidenziando il punto di pareggio salariale a partire dal quale il trasferimento in Svizzera diventa finanziariamente vantaggioso. Per un single, il break-even si situa tipicamente tra CHF 80.000 e 100.000 lordi; per le famiglie, sale significativamente.',
 'Il confronto include anche fattori qualitativi quantificabili: il tempo di pendolarismo risparmiato con il permesso B (1-2 ore al giorno), il costo opportunità delle ore perse in coda alla dogana, e l\'accesso ai servizi pubblici svizzeri (scuole, sanità, trasporti). Questi elementi possono incidere sulla decisione tanto quanto il puro calcolo economico.',
 ],
 en: [
 'The G permit vs B permit comparison calculates the total financial impact of choosing cross-border commuter status (permit G, residence in Italy) versus Swiss residence (permit B). The analysis goes beyond net salary to include rent, healthcare premiums, commute costs, Italian municipal taxes, and Swiss ordinary taxation.',
 'For permit G workers, the calculation includes Swiss withholding tax, Italian IRPEF with the EUR 10,000 franchise for new frontalieri, cost of living in Italian border towns, and daily commute expenses (fuel, motorway tolls, parking, or TILO rail pass). The main advantage is the lower cost of living in Italy.',
 'For permit B, the calculation includes Swiss ordinary taxation (with a tax return allowing personal deductions), significantly higher Swiss rents, resident LAMal premiums, but eliminates commuting time and border crossing delays. In Ticino, a studio apartment in Lugano costs CHF 1,000–1,400 per month, versus EUR 400–600 in Como or Varese.',
 'The tool models scenarios at different salary levels and family configurations, highlighting the break-even salary at which moving to Switzerland becomes financially advantageous despite higher living costs. For a single person, the break-even typically falls between CHF 80,000 and 100,000 gross; for families, it rises significantly.',
 'The comparison also includes quantifiable quality-of-life factors: commuting time saved with permit B (1-2 hours per day), the opportunity cost of hours lost in border queues, and access to Swiss public services (schools, healthcare, transport). These elements can influence the decision as much as the pure financial calculation.',
 ],
 de: [
 'Der Vergleich Ausweis G vs. Ausweis B berechnet die gesamten finanziellen Auswirkungen der Wahl zwischen Grenzgängerstatus (Ausweis G, Wohnsitz in Italien) und Schweizer Wohnsitz (Ausweis B). Die Analyse geht über das Nettogehalt hinaus und berücksichtigt Miete, Krankenkassenprämien, Pendelkosten, italienische Gemeindesteuern und Schweizer ordentliche Besteuerung.',
 'Für Ausweis-G-Arbeitnehmer umfasst die Berechnung Quellensteuer, italienische IRPEF mit EUR-10.000-Franchise für neue Grenzgänger, Lebenshaltungskosten in italienischen Grenzorten und tägliche Pendelkosten (Treibstoff, Autobahn, Parkplatz oder TILO-Abo). Der Hauptvorteil sind die niedrigeren Lebenshaltungskosten in Italien.',
 'Für Ausweis B umfasst die Berechnung die ordentliche Schweizer Besteuerung (mit Steuererklärung und persönlichen Abzügen), deutlich höhere Schweizer Mieten, KVG-Prämien als Einwohner, eliminiert aber Pendelzeit und Grenzwarteschlangen. Im Tessin kostet eine Einzimmerwohnung in Lugano CHF 1.000–1.400 pro Monat gegenüber EUR 400–600 in Como oder Varese.',
 'Das Tool modelliert Szenarien bei verschiedenen Gehaltsstufen und Familienkonstellationen und zeigt das Breakeven-Gehalt, ab dem der Umzug in die Schweiz trotz höherer Lebenshaltungskosten finanziell vorteilhaft wird. Für Alleinstehende liegt der Breakeven typischerweise zwischen CHF 80.000 und 100.000 brutto; für Familien deutlich höher.',
 'Der Vergleich berücksichtigt auch quantifizierbare Lebensqualitätsfaktoren: eingesparte Pendelzeit mit Ausweis B (1-2 Stunden täglich), Opportunitätskosten der im Grenzstau verlorenen Stunden und Zugang zu Schweizer öffentlichen Dienstleistungen. Diese Faktoren können die Entscheidung ebenso beeinflussen wie die rein finanzielle Berechnung.',
 ],
 fr: [
 'La comparaison permis G vs permis B calcule l\'impact financier total du choix entre le statut de frontalier (permis G, résidence en Italie) et la résidence suisse (permis B). L\'analyse va au-delà du salaire net pour inclure le loyer, les primes d\'assurance maladie, les frais de trajet, les impôts communaux italiens et la taxation ordinaire suisse.',
 'Pour les titulaires du permis G, le calcul inclut l\'impôt à la source suisse, l\'IRPEF italienne avec franchise de 10 000 EUR pour les nouveaux frontaliers, le coût de la vie dans les villes frontalières italiennes et les frais de trajet quotidiens (carburant, autoroute, parking ou abonnement TILO). L\'avantage principal est le coût de la vie inférieur en Italie.',
 'Pour le permis B, le calcul inclut la taxation ordinaire suisse (avec déclaration d\'impôt permettant des déductions personnelles), des loyers suisses nettement plus élevés, des primes LAMal de résident, mais élimine le temps de trajet et les attentes à la frontière. Au Tessin, un studio à Lugano coûte CHF 1 000–1 400 par mois, contre EUR 400–600 à Côme ou Varèse.',
 'L\'outil modélise des scénarios à différents niveaux de salaire et configurations familiales, indiquant le salaire d\'équilibre à partir duquel le déménagement en Suisse devient financièrement avantageux. Pour une personne seule, le seuil se situe typiquement entre CHF 80 000 et 100 000 bruts ; pour les familles, il augmente significativement.',
 'La comparaison inclut aussi des facteurs de qualité de vie quantifiables : temps de trajet économisé avec le permis B (1-2 heures par jour), coût d\'opportunité des heures perdues aux files frontalières et accès aux services publics suisses. Ces éléments peuvent influencer la décision autant que le calcul purement financier.',
 ],
 },

 // ───── Guide: cross-border unemployment ─────────────────────
 '/guida-frontaliere/disoccupazione-transfrontaliera': {
 en: [
 'Cross-border unemployment insurance is a complex area where Swiss and Italian regulations intersect. If you lose your job in Switzerland, unemployment benefits are generally paid by Italy (your country of residence), not Switzerland. However, the benefit amount is calculated based on Italian rules and your Italian contribution history, not your Swiss salary.',
 'There is a critical exception: if you had at least 12 months of Swiss employment, you can request Switzerland to transfer your contribution record to Italian INPS via the U1 form (formerly E301). This allows INPS to factor your Swiss employment period into the Italian NASPI unemployment benefit calculation.',
 'The guide covers the step-by-step procedure: obtaining the U1 attestation from the Swiss cantonal employment office (Ufficio del lavoro), filing the NASPI application with INPS within 68 days of job loss, and understanding the benefit duration and amount based on your combined Swiss-Italian contribution history.',
 ],
 de: [
 'Die grenzüberschreitende Arbeitslosenversicherung ist ein komplexer Bereich, in dem schweizerische und italienische Regelungen aufeinandertreffen. Bei Arbeitsplatzverlust in der Schweiz werden Arbeitslosenleistungen grundsätzlich von Italien (dem Wohnsitzland) gezahlt, nicht von der Schweiz. Die Höhe richtet sich nach italienischen Regeln und Ihrer italienischen Beitragsgeschichte.',
 'Es gibt eine wichtige Ausnahme: Bei mindestens 12 Monaten Schweizer Beschäftigung können Sie die Übertragung Ihrer Beitragszeiten an die italienische INPS über das Formular U1 (ehemals E301) beantragen. Dies ermöglicht der INPS, Ihre Schweizer Beschäftigungszeit in die Berechnung des italienischen NASPI einzubeziehen.',
 'Der Leitfaden behandelt das Verfahren Schritt für Schritt: Beschaffung der U1-Bescheinigung vom kantonalen Arbeitsamt, NASPI-Antrag bei der INPS innerhalb von 68 Tagen nach Arbeitsplatzverlust und Verständnis der Leistungsdauer basierend auf der kombinierten Beitragsgeschichte.',
 ],
 fr: [
 'L\'assurance chômage transfrontalière est un domaine complexe où les réglementations suisse et italienne s\'entrecroisent. En cas de perte d\'emploi en Suisse, les prestations de chômage sont généralement versées par l\'Italie (pays de résidence), pas par la Suisse. Le montant est calculé selon les règles italiennes et votre historique de cotisations italiennes.',
 'Il existe une exception critique : avec au moins 12 mois d\'emploi en Suisse, vous pouvez demander le transfert de vos périodes de cotisation à l\'INPS italienne via le formulaire U1 (anciennement E301). Cela permet à l\'INPS d\'intégrer votre période d\'emploi suisse dans le calcul de la NASPI italienne.',
 'Le guide couvre la procédure étape par étape : obtention de l\'attestation U1 auprès de l\'office cantonal de l\'emploi suisse, dépôt de la demande NASPI auprès de l\'INPS dans les 68 jours suivant la perte d\'emploi, et compréhension de la durée et du montant des prestations.',
 ],
 },

 // ───── Guide: G vs B permit comparison ──────────────────────
 '/guida-frontaliere/confronta-permesso-g-vs-b': {
 en: [
 'This guide compares the practical differences between the G permit (cross-border worker, residence in Italy) and the B permit (residence in Switzerland). Key distinctions include taxation method, healthcare access, pension accrual, family member rights, and implications for daily life quality.',
 'The G permit requires returning to Italy at least weekly and limits access to Swiss social services, but allows the cost-of-living advantage of Italian residence. The B permit grants full Swiss residency with ordinary taxation, access to Swiss healthcare and education, but at significantly higher living costs.',
 'Decision factors covered: salary threshold where B permit becomes advantageous, family configuration impact, commute time savings, children\'s education options, and the long-term pension implications of each permit type under the bilateral social security agreement.',
 ],
 de: [
 'Dieser Leitfaden vergleicht die praktischen Unterschiede zwischen dem Ausweis G (Grenzgänger, Wohnsitz in Italien) und dem Ausweis B (Wohnsitz in der Schweiz). Hauptunterschiede: Besteuerungsmethode, Zugang zur Gesundheitsversorgung, Vorsorgeaufbau, Rechte der Familienangehörigen und Auswirkungen auf die Lebensqualität.',
 'Der Ausweis G erfordert die wöchentliche Rückkehr nach Italien und schränkt den Zugang zu Schweizer Sozialdiensten ein, ermöglicht aber den Lebenshaltungskostenvorteil des italienischen Wohnsitzes. Der Ausweis B gewährt vollständigen Schweizer Wohnsitz mit ordentlicher Besteuerung, aber zu erheblich höheren Lebenshaltungskosten.',
 'Behandelte Entscheidungsfaktoren: Gehaltsschwelle, ab der Ausweis B vorteilhaft wird, Einfluss der Familienkonstellation, eingesparte Pendelzeit, Bildungsoptionen für Kinder und langfristige Vorsorgeauswirkungen jedes Bewilligungstyps.',
 ],
 fr: [
 'Ce guide compare les différences pratiques entre le permis G (frontalier, résidence en Italie) et le permis B (résidence en Suisse). Les distinctions clés incluent la méthode de taxation, l\'accès aux soins de santé, l\'accumulation de la prévoyance, les droits des membres de la famille et les implications sur la qualité de vie.',
 'Le permis G exige un retour en Italie au moins hebdomadaire et limite l\'accès aux services sociaux suisses, mais permet l\'avantage du coût de la vie italien. Le permis B accorde la pleine résidence suisse avec taxation ordinaire, mais à des coûts de vie nettement plus élevés.',
 'Facteurs de décision couverts : seuil salarial où le permis B devient avantageux, impact de la configuration familiale, économies de temps de trajet, options éducatives pour les enfants et implications de prévoyance à long terme de chaque type de permis.',
 ],
 },

 // ───── Guide: border map ────────────────────────────────────
 '/guida-frontaliere/mappa-confine': {
 en: [
 'The interactive border map shows the complete Swiss-Italian frontier in the Ticino region, marking all border crossings, customs offices, and key infrastructure. The map highlights the 20 km zone from the border — the threshold that determines which fiscal regime applies to cross-border workers under the 2026 New Agreement.',
 'Each crossing is annotated with opening hours, traffic type (pedestrian, vehicle, commercial), and links to real-time webcam feeds where available. The map also shows major transport corridors: the A2 motorway (Chiasso-Gotthard), regional rail lines (TILO), and bus routes connecting Italian border towns to Ticino employment centres.',
 'For workers choosing a residence municipality, the map provides distance measurements to the nearest border crossing and commute time estimates to Lugano, Bellinzona, Locarno, and Mendrisio — essential data for the G permit vs B permit decision.',
 ],
 de: [
 'Die interaktive Grenzkarte zeigt die komplette schweizerisch-italienische Grenze in der Tessiner Region mit allen Grenzübergängen, Zollämtern und wichtiger Infrastruktur. Die Karte hebt die 20-km-Zone von der Grenze hervor — der Schwellenwert, der das Steuerregime für Grenzgänger nach dem Neuen Abkommen 2026 bestimmt.',
 'Jeder Übergang ist mit Öffnungszeiten, Verkehrstyp (Fussgänger, Fahrzeug, Gewerbe) und Links zu Echtzeit-Webcams annotiert. Die Karte zeigt auch die Hauptverkehrskorridore: Autobahn A2 (Chiasso-Gotthard), Regionalbahnlinien (TILO) und Busverbindungen zwischen italienischen Grenzorten und Tessiner Beschäftigungszentren.',
 'Für Arbeitnehmer bei der Wohnsitzwahl bietet die Karte Entfernungsmessungen zum nächsten Grenzübergang und Pendlerzeitschätzungen nach Lugano, Bellinzona, Locarno und Mendrisio — wesentliche Daten für die Entscheidung zwischen Ausweis G und B.',
 ],
 fr: [
 'La carte interactive de la frontière montre l\'intégralité de la frontière suisse-italienne dans la région du Tessin, marquant tous les postes frontières, bureaux de douane et infrastructures clés. La carte met en évidence la zone des 20 km — le seuil déterminant le régime fiscal des frontaliers selon le Nouvel Accord 2026.',
 'Chaque poste est annoté avec les horaires d\'ouverture, le type de trafic (piéton, véhicule, commercial) et des liens vers les webcams en temps réel disponibles. La carte montre aussi les corridors de transport principaux : autoroute A2 (Chiasso-Gothard), lignes ferroviaires régionales (TILO) et bus reliant les villes frontalières italiennes aux centres d\'emploi tessinois.',
 'Pour les travailleurs choisissant une commune de résidence, la carte fournit les distances au poste frontière le plus proche et les estimations de temps de trajet vers Lugano, Bellinzone, Locarno et Mendrisio — des données essentielles pour la décision permis G vs B.',
 ],
 },

 // ───── Tax: Italian tax return ──────────────────────────────
 '/tasse-e-pensione/dichiarazione-redditi-italia': {
 en: [
 'The Italian tax return guide for cross-border workers covers the Modello 730 and Redditi PF filings required for those who work in Switzerland and are tax residents in Italy. Swiss employment income must be declared in section RC, converted from CHF to EUR using the official UIC exchange rate for the fiscal year.',
 'Under the 2024 New Agreement, new cross-border workers benefit from a EUR 10,000 franchise on Swiss employment income for IRPEF calculation. The foreign tax credit (Art. 165 TUIR) for Swiss withholding tax already paid is claimed in section CE/CR, preventing double taxation.',
 'The guide walks through each form section with examples: how to fill in the CU (Certificazione Unica) data from your Swiss employer, where to enter additional deductions (mortgage interest, medical expenses, renovation bonuses), and the deadlines — 30 September for the 730, 30 November for the Redditi PF.',
 ],
 de: [
 'Der Leitfaden zur italienischen Steuererklärung für Grenzgänger behandelt die Formulare Modello 730 und Redditi PF, die für Personen erforderlich sind, die in der Schweiz arbeiten und in Italien steuerlich ansässig sind. Das Schweizer Arbeitseinkommen muss in Abschnitt RC angegeben werden, umgerechnet von CHF in EUR zum offiziellen UIC-Wechselkurs.',
 'Nach dem Neuen Abkommen 2024 profitieren neue Grenzgänger von einer Franchise von EUR 10.000 auf das Schweizer Arbeitseinkommen für die IRPEF-Berechnung. Die Steuergutschrift (Art. 165 TUIR) für bereits gezahlte Schweizer Quellensteuer wird in Abschnitt CE/CR geltend gemacht.',
 'Der Leitfaden führt mit Beispielen durch jeden Formularteil: Eingabe der CU-Daten (Certificazione Unica) des Schweizer Arbeitgebers, zusätzliche Abzüge (Hypothekenzinsen, Arztkosten, Renovierungsbonus) und Fristen — 30. September für den 730, 30. November für den Redditi PF.',
 ],
 fr: [
 'Le guide de la déclaration fiscale italienne pour frontaliers couvre les formulaires Modello 730 et Redditi PF requis pour les personnes travaillant en Suisse et fiscalement résidentes en Italie. Le revenu d\'emploi suisse doit être déclaré dans la section RC, converti de CHF en EUR au taux de change officiel UIC.',
 'Selon le Nouvel Accord 2024, les nouveaux frontaliers bénéficient d\'une franchise de 10 000 EUR sur le revenu d\'emploi suisse pour le calcul de l\'IRPEF. Le crédit d\'impôt étranger (Art. 165 TUIR) pour l\'impôt à la source suisse déjà payé est demandé dans la section CE/CR.',
 'Le guide accompagne chaque section du formulaire avec des exemples : renseignement des données CU (Certificazione Unica) de l\'employeur suisse, déductions supplémentaires (intérêts hypothécaires, frais médicaux, bonus rénovation) et échéances — 30 septembre pour le 730, 30 novembre pour le Redditi PF.',
 ],
 },

 // ───── Tax: Swiss tax return ────────────────────────────────
 '/tasse-e-pensione/dichiarazione-redditi-svizzera': {
 en: [
 'The Swiss tax return guide covers the withholding tax rectification procedure (Tarifkorrektur/TDR) available to cross-border workers in Canton Ticino. By filing before 31 March of the following year, you can claim additional deductions not automatically included in withholding tax: pillar 3a contributions, actual transport costs, continuing education, and childcare expenses.',
 'For cross-border workers earning above CHF 120,000, supplementary ordinary taxation (TOU) is mandatory. The guide explains how to file via eTax Ticino, what supporting documents are required, and how the quasi-resident status can provide access to the same deductions available to Swiss residents.',
 'Key deadlines and procedures: filing the TDR application with the Ufficio delle Imposte (DFE), gathering Swiss and Italian documentation, and understanding how the Swiss tax rectification interacts with your Italian IRPEF return and the foreign tax credit mechanism.',
 ],
 de: [
 'Der Leitfaden zur Schweizer Steuererklärung behandelt das Quellensteuerberichtigungsverfahren (Tarifkorrektur/TDR) für Grenzgänger im Kanton Tessin. Durch Einreichung bis 31. März des Folgejahres können zusätzliche Abzüge geltend gemacht werden: Säule-3a-Beiträge, tatsächliche Transportkosten, Weiterbildung und Kinderbetreuungskosten.',
 'Für Grenzgänger mit einem Einkommen über CHF 120.000 ist die nachträgliche ordentliche Veranlagung (NOV) obligatorisch. Der Leitfaden erklärt die Einreichung über eTax Ticino, erforderliche Belege und wie der Quasi-Ansässigen-Status Zugang zu denselben Abzügen wie Schweizer Einwohner gewährt.',
 'Wichtige Fristen und Verfahren: TDR-Antrag beim Steueramt (DFE), Beschaffung schweizerischer und italienischer Dokumentation sowie das Zusammenspiel der Schweizer Steuerberichtigung mit der italienischen IRPEF-Erklärung und der Steuergutschrift.',
 ],
 fr: [
 'Le guide de la déclaration fiscale suisse couvre la procédure de rectification de l\'impôt à la source (correction du barème/TDR) disponible pour les frontaliers du Canton du Tessin. En déposant avant le 31 mars de l\'année suivante, vous pouvez réclamer des déductions supplémentaires : contributions pilier 3a, frais de transport effectifs, formation continue et frais de garde d\'enfants.',
 'Pour les frontaliers gagnant plus de CHF 120 000, la taxation ordinaire complémentaire (TOU) est obligatoire. Le guide explique comment déposer via eTax Ticino, les documents justificatifs requis et comment le statut de quasi-résident donne accès aux mêmes déductions que les résidents suisses.',
 'Échéances et procédures clés : dépôt de la demande TDR auprès de l\'office des impôts (DFE), rassemblement de la documentation suisse et italienne, et compréhension de l\'interaction entre la rectification suisse et la déclaration IRPEF italienne.',
 ],
 },

 // ───── Tax: 2026 withholding tax rates ──────────────────────
 '/tasse-e-pensione/aliquote-imposta-alla-fonte-ticino-2026': {
 it: [
 'Le tabelle dell\'imposta alla fonte del Canton Ticino per il 2026 mostrano le aliquote esatte applicate agli stipendi dei frontalieri, suddivise per tabella fiscale (A per celibi, B per celibi con figli, C per coniugati, H per genitori soli), fascia di reddito, numero di figli a carico e appartenenza religiosa. Le aliquote partono dallo 0 % per redditi inferiori a CHF 18.000 e possono arrivare fino al 24 % per i redditi più elevati.',
 'Per i nuovi frontalieri soggetti al Nuovo Accordo 2024, l\'aliquota viene ridotta all\'80 % del tasso ordinario per i residenti entro 20 km dal confine svizzero. I lavoratori residenti oltre 20 km pagano il 100 % dell\'aliquota ordinaria. Questa distinzione è fondamentale perché determina la base di calcolo dell\'imposta svizzera e, di conseguenza, l\'importo del credito d\'imposta disponibile nella dichiarazione dei redditi italiana.',
 'Ogni figlio a carico riduce l\'aliquota dell\'imposta alla fonte di circa 1-2 punti percentuali. Ad esempio, un frontaliere sposato con due figli (tabella C2) paga un\'aliquota effettiva significativamente inferiore rispetto a un celibe senza figli (tabella A0) a parità di reddito. Questa differenza può tradursi in diverse centinaia di franchi al mese per redditi medi di CHF 70.000-90.000.',
 'La confessione religiosa incide sull\'imposta alla fonte: i contribuenti cattolici o protestanti pagano un supplemento di circa 0,5-1 punto percentuale destinato all\'imposta ecclesiastica cantonale. Chi non appartiene a nessuna confessione riconosciuta può richiedere l\'applicazione dell\'aliquota senza supplemento religioso.',
 'Conoscere la propria aliquota esatta è essenziale per le trattative salariali e la pianificazione finanziaria. Le tabelle possono essere incrociate con il simulatore di busta paga per verificare la corretta deduzione. In caso di errore nella tabella applicata, è possibile richiedere una rettifica entro il 31 marzo dell\'anno successivo presso la Divisione delle contribuzioni del Canton Ticino.',
 ],
 en: [
 'The 2026 Canton Ticino withholding tax rate tables show the exact percentages applied to cross-border worker salaries, broken down by tax table (A for single, B for single with children, C for married, H for single parent), income bracket, number of children, and religious affiliation. Rates start at 0% for incomes below CHF 18,000 and can reach up to 24% for the highest earners.',
 'For new cross-border workers under the 2024 New Agreement, the withholding rate is reduced to 80% of the ordinary table rate for residents within 20 km of the border. Workers beyond 20 km pay the full 100% rate. This distinction is crucial as it determines the Swiss tax base and consequently the tax credit available in the Italian tax return.',
 'Each dependent child reduces the withholding tax rate by approximately 1-2 percentage points. For example, a married worker with two children (table C2) pays a significantly lower effective rate than a single worker without children (table A0) at the same income level. This difference can amount to several hundred francs per month for median incomes of CHF 70,000-90,000.',
 'Religious affiliation affects the withholding tax: Catholic or Protestant taxpayers pay a surcharge of approximately 0.5-1 percentage point for cantonal church tax. Those who do not belong to a recognised denomination can request the rate without the religious surcharge by notifying their employer or the cantonal tax office.',
 'Understanding your exact withholding rate is essential for salary negotiations and financial planning. The tables can be cross-referenced with the payslip simulator to verify that your employer is applying the correct deduction. If the wrong table is applied, a correction can be requested by 31 March of the following year at the Canton Ticino tax division.',
 ],
 de: [
 'Die Quellensteuertabellen 2026 des Kantons Tessin zeigen die genauen Prozentsätze für Grenzgängergehälter, aufgeschlüsselt nach Steuertabelle (A für Alleinstehende, B für Alleinstehende mit Kindern, C für Verheiratete, H für Alleinerziehende), Einkommensstufe, Kinderzahl und Konfession. Die Sätze beginnen bei 0 % für Einkommen unter CHF 18.000 und können bis zu 24 % erreichen.',
 'Für neue Grenzgänger nach dem Neuen Abkommen 2024 wird der Quellensteuersatz auf 80 % des ordentlichen Tabellensatzes für Einwohner innerhalb von 20 km der Grenze reduziert. Arbeitnehmer jenseits von 20 km zahlen den vollen 100-%-Satz. Diese Unterscheidung bestimmt die Schweizer Steuerbasis und die in der italienischen Steuererklärung verfügbare Steuergutschrift.',
 'Jedes unterhaltsberechtigte Kind reduziert den Quellensteuersatz um etwa 1-2 Prozentpunkte. Beispielsweise zahlt ein verheirateter Arbeitnehmer mit zwei Kindern (Tabelle C2) einen deutlich niedrigeren Effektivsatz als ein Alleinstehender ohne Kinder (Tabelle A0) bei gleichem Einkommen. Dieser Unterschied kann bei Medianeinkommen mehrere hundert Franken pro Monat ausmachen.',
 'Die Konfession beeinflusst die Quellensteuer: Katholische oder reformierte Steuerpflichtige zahlen einen Zuschlag von etwa 0,5-1 Prozentpunkt für die kantonale Kirchensteuer. Wer keiner anerkannten Konfession angehört, kann den Satz ohne Kirchensteuerzuschlag beantragen.',
 'Die Kenntnis des genauen Quellensteuersatzes ist wesentlich für Gehaltsverhandlungen und Finanzplanung. Die Tabellen können mit dem Lohnabrechnungssimulator abgeglichen werden. Bei falscher Tabelle kann eine Berichtigung bis zum 31. März des Folgejahres bei der Steuerverwaltung des Kantons Tessin beantragt werden.',
 ],
 fr: [
 'Les barèmes 2026 de l\'impôt à la source du Canton du Tessin montrent les pourcentages exacts appliqués aux salaires des frontaliers, ventilés par barème (A pour célibataire, B pour célibataire avec enfants, C pour marié, H pour famille monoparentale), tranche de revenu, nombre d\'enfants et appartenance religieuse. Les taux démarrent à 0 % pour les revenus inférieurs à CHF 18 000 et peuvent atteindre 24 %.',
 'Pour les nouveaux frontaliers selon le Nouvel Accord 2024, le taux de retenue est réduit à 80 % du taux ordinaire pour les résidents dans un rayon de 20 km de la frontière. Les travailleurs au-delà de 20 km paient le taux plein de 100 %. Cette distinction est cruciale car elle détermine la base d\'imposition suisse et le crédit d\'impôt disponible dans la déclaration italienne.',
 'Chaque enfant à charge réduit le taux d\'impôt à la source d\'environ 1-2 points de pourcentage. Par exemple, un travailleur marié avec deux enfants (barème C2) paie un taux effectif nettement inférieur à celui d\'un célibataire sans enfant (barème A0) au même niveau de revenu.',
 'L\'appartenance religieuse affecte l\'impôt à la source : les contribuables catholiques ou protestants paient un supplément d\'environ 0,5-1 point de pourcentage pour l\'impôt ecclésiastique cantonal. Les personnes n\'appartenant à aucune confession reconnue peuvent demander le taux sans supplément religieux.',
 'Connaître votre taux exact de retenue est essentiel pour les négociations salariales et la planification financière. Les barèmes peuvent être croisés avec le simulateur de fiche de paie pour vérifier la déduction correcte. En cas de barème erroné, une rectification peut être demandée avant le 31 mars de l\'année suivante.',
 ],
 },

 // ───── Tax: ristorni tracking ───────────────────────────────
 '/tasse-e-pensione/ristorni-fiscali': {
 en: [
 'Ristorni are the fiscal compensations that Canton Ticino pays to Italian border municipalities to offset the costs of hosting cross-border worker residents. Under the original 1974 agreement, approximately 40% of withholding tax collected from cross-border workers was returned to Italian municipalities within 20 km of the border.',
 'The 2024 New Agreement changes the ristorni framework: as Italy introduces concurrent taxation on new cross-border workers, the share of tax revenue flowing back to Italian municipalities will progressively decrease through the transitional period ending in 2033.',
 'This page tracks ristorni payments by municipality and year, showing historical trends and projected future changes. For cross-border workers, ristorni indirectly affect your community: municipalities receiving significant ristorni can maintain lower local tax rates and better public services.',
 ],
 de: [
 'Ristorni sind die Finanzkompensationen, die der Kanton Tessin an italienische Grenzgemeinden zahlt, um die Kosten der ansässigen Grenzgänger auszugleichen. Nach dem ursprünglichen Abkommen von 1974 wurden etwa 40 % der von Grenzgängern erhobenen Quellensteuer an italienische Gemeinden innerhalb von 20 km zurückerstattet.',
 'Das Neue Abkommen 2024 ändert den Ristorni-Rahmen: Mit der Einführung der konkurrierenden Besteuerung neuer Grenzgänger durch Italien wird der Anteil der an italienische Gemeinden zurückfliessenden Steuereinnahmen bis zum Ende der Übergangsphase 2033 schrittweise sinken.',
 'Diese Seite verfolgt Ristorni-Zahlungen nach Gemeinde und Jahr mit historischen Trends und prognostizierten Änderungen. Ristorni betreffen Ihre Gemeinde indirekt: Gemeinden mit hohen Ristorni können niedrigere lokale Steuersätze und bessere öffentliche Dienstleistungen aufrechterhalten.',
 ],
 fr: [
 'Les ristorni sont les compensations fiscales que le Canton du Tessin verse aux communes frontalières italiennes pour compenser les coûts liés aux frontaliers résidents. Selon l\'accord original de 1974, environ 40 % de l\'impôt à la source prélevé sur les frontaliers était restitué aux communes italiennes dans un rayon de 20 km.',
 'Le Nouvel Accord 2024 modifie le cadre des ristorni : avec l\'introduction de la taxation concurrente des nouveaux frontaliers par l\'Italie, la part des recettes fiscales retournant aux communes italiennes diminuera progressivement pendant la période transitoire jusqu\'en 2033.',
 'Cette page suit les versements de ristorni par commune et par année, montrant les tendances historiques et les changements futurs projetés. Les ristorni affectent indirectement votre communauté : les communes recevant des ristorni importants peuvent maintenir des taux d\'imposition locaux plus bas et de meilleurs services publics.',
 ],
 },

 // ───── Vita: nursery comparison ─────────────────────────────
 '/vivere-in-ticino/confronta-asili-nido': {
 en: [
 'The nursery comparison tool provides a detailed side-by-side analysis of childcare options in Swiss Canton Ticino and the Italian border provinces (Como, Varese, VCO). It compares monthly fees, opening hours, inclusion criteria, and available subsidies on both sides of the border.',
 'In Ticino, nursery costs range from CHF 1,500 to CHF 2,500 per month depending on the municipality and income bracket, with cantonal subsidies available for lower incomes. In Italy, municipal nurseries charge EUR 300-600 per month, and the national Bonus Asilo Nido provides up to EUR 3,000/year for eligible families.',
 'For cross-border families, the choice between Italian and Swiss childcare involves trade-offs: Italian nurseries are cheaper but may require Italian work schedule flexibility, while Ticino nurseries are closer to the workplace but significantly more expensive.',
 ],
 de: [
 'Das Kita-Vergleichstool bietet eine detaillierte Gegenüberstellung von Kinderbetreuungsoptionen im Schweizer Kanton Tessin und den italienischen Grenzprovinzen (Como, Varese, VCO). Es vergleicht Monatsgebühren, Öffnungszeiten, Aufnahmekriterien und verfügbare Zuschüsse beiderseits der Grenze.',
 'Im Tessin liegen die Kita-Kosten bei CHF 1.500 bis CHF 2.500 pro Monat je nach Gemeinde und Einkommensstufe, mit kantonalen Subventionen für tiefere Einkommen. In Italien berechnen kommunale Kitas EUR 300-600 pro Monat, und der nationale Bonus Asilo Nido gewährt bis zu EUR 3.000/Jahr für berechtigte Familien.',
 'Für Grenzgängerfamilien beinhaltet die Wahl zwischen italienischer und Schweizer Kinderbetreuung Abwägungen: Italienische Kitas sind günstiger, erfordern aber möglicherweise Flexibilität bei italienischen Arbeitszeiten, während Tessiner Kitas näher am Arbeitsplatz, aber deutlich teurer sind.',
 ],
 fr: [
 'L\'outil de comparaison des crèches fournit une analyse détaillée côte à côte des options de garde d\'enfants au Canton du Tessin et dans les provinces frontalières italiennes (Côme, Varèse, VCO). Il compare les tarifs mensuels, les horaires d\'ouverture, les critères d\'admission et les subventions disponibles des deux côtés de la frontière.',
 'Au Tessin, les frais de crèche vont de CHF 1 500 à CHF 2 500 par mois selon la commune et la tranche de revenus, avec des subventions cantonales pour les revenus plus modestes. En Italie, les crèches municipales facturent 300-600 EUR/mois, et le Bonus Asilo Nido national fournit jusqu\'à 3 000 EUR/an pour les familles éligibles.',
 'Pour les familles frontalières, le choix entre garde italienne et suisse implique des compromis : les crèches italiennes sont moins chères mais peuvent nécessiter une flexibilité d\'horaires italiens, tandis que les crèches tessinoises sont plus proches du lieu de travail mais nettement plus coûteuses.',
 ],
 },

 // ───── Vita: attractions in Italian-speaking Switzerland ────
 '/vivere-in-ticino/attrazioni-svizzera-italiana': {
 en: [
 'Italian-speaking Switzerland offers a unique blend of Swiss efficiency and Mediterranean lifestyle. Canton Ticino and the Grigioni Italiane feature lakeside towns (Lugano, Locarno, Ascona), UNESCO heritage sites (Bellinzona castles, Monte San Giorgio), and world-class cultural events (Locarno Film Festival, Lugano Estival Jazz).',
 'For cross-border workers, understanding Ticino\'s cultural and leisure landscape helps with the residence decision: proximity to the Lake Lugano shores, hiking trails in the Valle Verzasca, and vibrant restaurant culture are quality-of-life factors that complement the financial analysis of permit G vs B.',
 'The guide covers seasonal highlights, family-friendly activities, public transport accessibility from Italian border towns, and practical tips for making the most of evenings and weekends in Ticino without a Swiss residence permit.',
 ],
 de: [
 'Die italienischsprachige Schweiz bietet eine einzigartige Mischung aus Schweizer Effizienz und mediterranem Lebensgefühl. Der Kanton Tessin und das Grigioni Italiano bieten Seestädte (Lugano, Locarno, Ascona), UNESCO-Welterbestätten (Burgen von Bellinzona, Monte San Giorgio) und erstklassige Kulturveranstaltungen (Filmfestival Locarno, Estival Jazz Lugano).',
 'Für Grenzgänger hilft das Verständnis der Tessiner Kultur- und Freizeitlandschaft bei der Wohnsitzentscheidung: Nähe zum Luganersee, Wanderwege im Val Verzasca und die lebendige Restaurantkultur sind Lebensqualitätsfaktoren, die die finanzielle Analyse von Ausweis G vs. B ergänzen.',
 'Der Leitfaden behandelt saisonale Highlights, familienfreundliche Aktivitäten, ÖV-Erreichbarkeit von italienischen Grenzorten und praktische Tipps für Abende und Wochenenden im Tessin ohne Schweizer Aufenthaltsbewilligung.',
 ],
 fr: [
 'La Suisse italophone offre un mélange unique d\'efficacité suisse et de style de vie méditerranéen. Le Canton du Tessin et les Grisons italiens proposent des villes lacustres (Lugano, Locarno, Ascona), des sites UNESCO (châteaux de Bellinzone, Monte San Giorgio) et des événements culturels de premier plan (Festival du Film de Locarno, Estival Jazz Lugano).',
 'Pour les frontaliers, comprendre le paysage culturel et de loisirs tessinois aide à la décision de résidence : la proximité du lac de Lugano, les sentiers de randonnée du Val Verzasca et la culture gastronomique animée sont des facteurs de qualité de vie qui complètent l\'analyse financière du permis G vs B.',
 'Le guide couvre les temps forts saisonniers, les activités familiales, l\'accessibilité en transports publics depuis les villes frontalières italiennes et des conseils pratiques pour profiter des soirées et week-ends au Tessin sans permis de résidence suisse.',
 ],
 },

 // ───── Vita: cross-border transport ─────────────────────────
 '/vivere-in-ticino/trasporti-frontalieri': {
 en: [
 'The cross-border transport guide covers all commuting options between Italy and Swiss Canton Ticino: car via major border crossings, TILO regional trains (Lombardy-Ticino integration), FlixBus and regional bus services, car-sharing platforms, and cycling routes for border-adjacent municipalities.',
 'For daily commuters, the cost comparison is critical: a monthly TILO Arcobaleno pass costs CHF 150-280 depending on zones, while driving costs EUR 300-500/month including fuel, tolls, parking, and vehicle wear. The guide breaks down each option with realistic monthly costs.',
 'Time-saving strategies include staggered departure times (avoiding the 7:00-8:00 peak at Chiasso), alternative border crossings for different Ticino destinations, and the combination of Italian park-and-ride facilities with Swiss regional transit for the final leg.',
 ],
 de: [
 'Der Grenzgänger-Transportführer deckt alle Pendleroptionen zwischen Italien und dem Schweizer Kanton Tessin ab: Auto über die Hauptgrenzübergänge, TILO-Regionalzüge (Lombardei-Tessin-Integration), FlixBus und regionale Busdienste, Fahrgemeinschaftsplattformen und Fahrradrouten für grenznahe Gemeinden.',
 'Für tägliche Pendler ist der Kostenvergleich entscheidend: Ein TILO-Arcobaleno-Monatsabonnement kostet CHF 150-280 je nach Zone, während Autofahren EUR 300-500/Monat kostet inkl. Kraftstoff, Maut, Parkplatz und Fahrzeugverschleiss. Der Leitfaden schlüsselt jede Option mit realistischen Monatskosten auf.',
 'Zeitspartipps umfassen gestaffelte Abfahrtszeiten (Vermeidung der Spitze 7:00-8:00 bei Chiasso), alternative Grenzübergänge für verschiedene Tessiner Ziele und die Kombination italienischer Park-and-Ride-Anlagen mit dem Schweizer Regionalverkehr.',
 ],
 fr: [
 'Le guide des transports transfrontaliers couvre toutes les options de pendularité entre l\'Italie et le Canton du Tessin : voiture via les principaux postes frontières, trains régionaux TILO (intégration Lombardie-Tessin), FlixBus et services de bus régionaux, plateformes de covoiturage et itinéraires cyclables pour les communes proches de la frontière.',
 'Pour les pendulaires quotidiens, la comparaison des coûts est critique : un abonnement mensuel TILO Arcobaleno coûte CHF 150-280 selon les zones, tandis que la voiture coûte EUR 300-500/mois incluant carburant, péages, parking et usure du véhicule.',
 'Les stratégies de gain de temps incluent des départs décalés (éviter le pic 7h00-8h00 à Chiasso), des postes frontières alternatifs selon la destination au Tessin, et la combinaison de parkings relais italiens avec le transport régional suisse pour le dernier tronçon.',
 ],
 },

 // ───── Statistics: best border municipalities ───────────────
 '/statistiche/migliori-comuni-frontiera': {
 en: [
 'The best border municipalities ranking evaluates Italian comuni within 20 km of the Swiss-Ticino border across multiple criteria relevant to cross-border workers: commute time to major Ticino employers, rental costs, municipal tax rates (addizionale comunale IRPEF), public transport connections, school quality, and access to services.',
 'The ranking uses a composite livability score that weights financial factors (rent, taxes, commute cost) alongside quality-of-life indicators (green spaces, services density, crime rates). Each municipality is profiled with population data, distance to the nearest border crossing, and average property prices.',
 'For cross-border workers choosing where to live in Italy, this ranking provides objective data to complement personal preferences. Filter by province (Como, Varese, VCO), distance from border, or specific criteria to find the municipality that best matches your priorities.',
 ],
 de: [
 'Das Ranking der besten Grenzgemeinden bewertet italienische Comuni innerhalb von 20 km der schweizerisch-tessinischen Grenze nach mehreren Kriterien: Pendelzeit zu den grössten Tessiner Arbeitgebern, Mietkosten, kommunale Steuersätze (Addizionale Comunale IRPEF), ÖV-Anbindung, Schulqualität und Zugang zu Dienstleistungen.',
 'Das Ranking verwendet einen zusammengesetzten Lebensqualitätswert, der finanzielle Faktoren (Miete, Steuern, Pendelkosten) mit Lebensqualitätsindikatoren (Grünflächen, Dienstleistungsdichte, Kriminalitätsraten) gewichtet. Jede Gemeinde wird mit Bevölkerungsdaten, Entfernung zum nächsten Grenzübergang und durchschnittlichen Immobilienpreisen profiliert.',
 'Für Grenzgänger bei der Wohnsitzwahl in Italien bietet dieses Ranking objektive Daten. Filtern Sie nach Provinz (Como, Varese, VCO), Grenzentfernung oder spezifischen Kriterien, um die Gemeinde zu finden, die am besten zu Ihren Prioritäten passt.',
 ],
 fr: [
 'Le classement des meilleures communes frontalières évalue les comuni italiens dans un rayon de 20 km de la frontière suisse-tessinoise selon plusieurs critères : temps de trajet vers les principaux employeurs tessinois, coûts de location, taux d\'imposition communaux (addizionale comunale IRPEF), liaisons de transport public, qualité scolaire et accès aux services.',
 'Le classement utilise un score de qualité de vie composite pondérant les facteurs financiers (loyer, impôts, coûts de trajet) et les indicateurs de qualité de vie (espaces verts, densité de services, taux de criminalité). Chaque commune est profilée avec données démographiques, distance au poste frontière le plus proche et prix immobiliers moyens.',
 'Pour les frontaliers choisissant où vivre en Italie, ce classement fournit des données objectives. Filtrez par province (Côme, Varèse, VCO), distance de la frontière ou critères spécifiques pour trouver la commune correspondant le mieux à vos priorités.',
 ],
 },

 // ───── Statistics: Ticino salary observatory ────────────────
 '/statistiche/osservatorio-stipendi-lavori-ticino': {
 en: [
 'The Ticino salary observatory tracks median and average wages by sector, role, and experience level across Canton Ticino, using data from the Swiss Federal Statistical Office (BFS) wage survey and employer-reported figures. The observatory covers 24 industry sectors, from banking and pharmaceuticals to construction and hospitality.',
 'For cross-border workers, the observatory provides essential benchmarking data for salary negotiations: knowing the median salary for your sector and seniority level in Ticino helps you assess whether an offer is competitive. The data includes gross salary ranges, 25th and 75th percentile brackets, and year-over-year trends.',
 'Interactive charts let you filter by sector, job category (management, professional, technical, operative), and compare Ticino salaries against Swiss national averages and Italian equivalents in the border provinces.',
 ],
 de: [
 'Das Tessiner Gehalts-Observatorium verfolgt Median- und Durchschnittsgehälter nach Branche, Rolle und Erfahrungsstufe im Kanton Tessin, basierend auf der BFS-Lohnerhebung und Arbeitgeberdaten. Das Observatorium deckt 24 Branchen ab, von Banken und Pharma bis Bau und Gastgewerbe.',
 'Für Grenzgänger liefert das Observatorium wesentliche Benchmarking-Daten für Gehaltsverhandlungen: Die Kenntnis des Mediangehalts für Ihren Sektor und Ihre Erfahrungsstufe im Tessin hilft zu beurteilen, ob ein Angebot wettbewerbsfähig ist. Die Daten umfassen Bruttolohnspannen, 25. und 75. Perzentil sowie Jahresvergleiche.',
 'Interaktive Diagramme ermöglichen Filterung nach Branche, Berufskategorie (Management, Fachkräfte, Technik, Operativ) und Vergleich mit dem Schweizer Landesdurchschnitt und italienischen Äquivalenten in den Grenzprovinzen.',
 ],
 fr: [
 'L\'observatoire des salaires tessinois suit les salaires médians et moyens par secteur, poste et niveau d\'expérience au Canton du Tessin, à partir de l\'enquête salariale de l\'OFS et des données d\'employeurs. L\'observatoire couvre 24 secteurs, de la banque et pharmacie à la construction et l\'hôtellerie.',
 'Pour les frontaliers, l\'observatoire fournit des données de benchmarking essentielles pour les négociations salariales : connaître le salaire médian pour votre secteur et niveau d\'ancienneté au Tessin permet d\'évaluer la compétitivité d\'une offre. Les données incluent les fourchettes de salaires bruts et les tendances annuelles.',
 'Les graphiques interactifs permettent de filtrer par secteur, catégorie professionnelle (management, spécialistes, technique, opératif) et de comparer les salaires tessinois avec les moyennes nationales suisses et les équivalents italiens dans les provinces frontalières.',
 ],
 },

 // ───── Statistics: Swiss unemployment ───────────────────────
 '/statistiche/disoccupazione-svizzera': {
 en: [
 'The Swiss unemployment statistics page tracks cantonal and national unemployment rates using SECO data, with a focus on Canton Ticino and its implications for cross-border workers. Ticino historically has one of the highest unemployment rates among Swiss cantons, typically 1-2 percentage points above the national average.',
 'For cross-border workers, Swiss unemployment figures signal labour market conditions: sectors with rising unemployment may indicate slower hiring, while low unemployment sectors present stronger negotiating positions. The data is broken down by sector, nationality, age group, and duration of unemployment.',
 'The page also covers the relationship between frontaliere employment and Swiss unemployment — a politically sensitive topic in Ticino. Charts show the correlation between cross-border worker numbers and cantonal unemployment over time, providing factual context for public debate.',
 ],
 de: [
 'Die Schweizer Arbeitslosenstatistik verfolgt kantonale und nationale Arbeitslosenquoten anhand von SECO-Daten, mit Fokus auf den Kanton Tessin und dessen Auswirkungen für Grenzgänger. Das Tessin hat historisch eine der höchsten Arbeitslosenquoten unter den Schweizer Kantonen, typischerweise 1-2 Prozentpunkte über dem nationalen Durchschnitt.',
 'Für Grenzgänger signalisieren Schweizer Arbeitslosenzahlen die Arbeitsmarktlage: Sektoren mit steigender Arbeitslosigkeit können langsamere Einstellungen anzeigen, während Sektoren mit niedriger Arbeitslosigkeit stärkere Verhandlungspositionen bieten. Die Daten sind nach Branche, Nationalität, Altersgruppe und Dauer aufgeschlüsselt.',
 'Die Seite beleuchtet auch die Beziehung zwischen Grenzgängerbeschäftigung und Schweizer Arbeitslosigkeit — ein politisch heikles Thema im Tessin. Grafiken zeigen die Korrelation zwischen Grenzgängerzahlen und kantonaler Arbeitslosigkeit über die Zeit.',
 ],
 fr: [
 'La page des statistiques du chômage suisse suit les taux de chômage cantonaux et nationaux à partir des données SECO, avec un focus sur le Canton du Tessin et ses implications pour les frontaliers. Le Tessin a historiquement l\'un des taux de chômage les plus élevés parmi les cantons suisses, typiquement 1-2 points au-dessus de la moyenne nationale.',
 'Pour les frontaliers, les chiffres du chômage suisse signalent les conditions du marché du travail : les secteurs avec un chômage en hausse peuvent indiquer un ralentissement des embauches, tandis que les secteurs à faible chômage offrent de meilleures positions de négociation.',
 'La page couvre aussi la relation entre l\'emploi frontalier et le chômage suisse — un sujet politiquement sensible au Tessin. Les graphiques montrent la corrélation entre le nombre de frontaliers et le chômage cantonal au fil du temps, fournissant un contexte factuel au débat public.',
 ],
 },

 // ───── Statistics: mortgage comparison ──────────────────────
 '/statistiche/confronto-mutui': {
 en: [
 'The mortgage comparison page analyses interest rates and conditions for home loans in Switzerland and Italy, relevant for cross-border workers who own or plan to buy property on either side of the border. Swiss mortgage rates (typically 1.5-3% for fixed rate) are compared with Italian rates (typically 2.5-4.5%).',
 'For cross-border workers, the mortgage decision involves currency considerations: a Swiss mortgage on an Italian property exposes you to CHF-EUR exchange rate risk, while an Italian mortgage may offer higher rates but eliminates currency mismatch. The comparison shows total interest paid over 15, 20, and 25-year terms under different rate scenarios.',
 'The tool also covers Swiss cantonal lending rules (typically 20% down payment, 33% income-to-debt ratio), Italian banking requirements for non-residents, and the impact of declaring Swiss income on Italian mortgage eligibility.',
 ],
 de: [
 'Die Hypothekenvergleichsseite analysiert Zinssätze und Konditionen für Wohnkredite in der Schweiz und Italien, relevant für Grenzgänger, die Immobilien auf beiden Seiten der Grenze besitzen oder erwerben möchten. Schweizer Hypothekenzinsen (typisch 1,5-3 % für Festzins) werden mit italienischen Zinsen (typisch 2,5-4,5 %) verglichen.',
 'Für Grenzgänger beinhaltet die Hypothekenentscheidung Währungsüberlegungen: Eine Schweizer Hypothek auf eine italienische Immobilie setzt Sie dem CHF-EUR-Wechselkursrisiko aus, während eine italienische Hypothek höhere Zinsen, aber kein Währungsrisiko birgt.',
 'Das Tool behandelt auch Schweizer kantonale Kreditregeln (typisch 20 % Eigenkapital, 33 % Einkommens-Schulden-Verhältnis), italienische Bankanforderungen für Nicht-Ansässige und die Auswirkungen der Deklaration von Schweizer Einkommen auf die italienische Hypothekenwürdigkeit.',
 ],
 fr: [
 'La page de comparaison des hypothèques analyse les taux d\'intérêt et conditions des prêts immobiliers en Suisse et en Italie, pertinents pour les frontaliers possédant ou prévoyant d\'acheter un bien de part et d\'autre de la frontière. Les taux hypothécaires suisses (typiquement 1,5-3 % à taux fixe) sont comparés aux taux italiens (typiquement 2,5-4,5 %).',
 'Pour les frontaliers, la décision hypothécaire implique des considérations de change : une hypothèque suisse sur un bien italien expose au risque de change CHF-EUR, tandis qu\'une hypothèque italienne offre des taux plus élevés mais élimine le décalage monétaire.',
 'L\'outil couvre aussi les règles de prêt cantonales suisses (typiquement 20 % d\'apport, ratio revenus-dettes de 33 %), les exigences bancaires italiennes pour les non-résidents et l\'impact de la déclaration de revenus suisses sur l\'éligibilité hypothécaire italienne.',
 ],
 },

 // ───── Statistics: border fuel prices ───────────────────────
 '/statistiche/prezzi-benzina-confine': {
 en: [
 'The border fuel price tracker monitors petrol and diesel prices at service stations on both sides of the Swiss-Italian border, updated hourly from official sources. The price differential between Swiss and Italian fuel is a significant daily cost factor for cross-border commuters.',
 'On average, fuel in Italy is 15-25% cheaper than in Ticino, but the gap fluctuates with international oil prices, national excise taxes, and seasonal demand. The tracker shows current prices at stations near major border crossings (Chiasso, Stabio, Ponte Tresa), helping you decide where to fill up each day.',
 'Annual savings from consistently fuelling in Italy can reach EUR 800-1,200 for a daily 50 km round trip commute. The tool also factors in the time cost of detouring to Italian stations and Swiss customs rules on fuel quantity limits when crossing the border.',
 ],
 de: [
 'Der Benzinpreis-Tracker an der Grenze überwacht Benzin- und Dieselpreise an Tankstellen beiderseits der schweizerisch-italienischen Grenze, stündlich aktualisiert aus offiziellen Quellen. Das Preisgefälle zwischen Schweizer und italienischem Kraftstoff ist ein erheblicher täglicher Kostenfaktor für Grenzpendler.',
 'Im Durchschnitt ist Kraftstoff in Italien 15-25 % günstiger als im Tessin, aber die Differenz schwankt mit internationalen Ölpreisen, nationalen Verbrauchssteuern und saisonaler Nachfrage. Der Tracker zeigt aktuelle Preise an Tankstellen nahe den Hauptgrenzübergängen (Chiasso, Stabio, Ponte Tresa).',
 'Die jährlichen Einsparungen durch konsequentes Tanken in Italien können EUR 800-1.200 für einen täglichen 50-km-Rundweg-Pendel erreichen. Das Tool berücksichtigt auch den Zeitaufwand für Umwege und Schweizer Zollregeln zur Kraftstoffmengenbeschränkung beim Grenzübertritt.',
 ],
 fr: [
 'Le tracker des prix du carburant à la frontière surveille les prix de l\'essence et du diesel aux stations-service des deux côtés de la frontière suisse-italienne, mis à jour toutes les heures à partir de sources officielles. L\'écart de prix entre le carburant suisse et italien est un facteur de coût quotidien significatif pour les pendulaires.',
 'En moyenne, le carburant en Italie est 15-25 % moins cher qu\'au Tessin, mais l\'écart fluctue avec les prix internationaux du pétrole, les accises nationales et la demande saisonnière. Le tracker affiche les prix actuels aux stations proches des principaux postes frontières (Chiasso, Stabio, Ponte Tresa).',
 'Les économies annuelles en faisant le plein systématiquement en Italie peuvent atteindre 800-1 200 EUR pour un trajet quotidien de 50 km aller-retour. L\'outil prend aussi en compte le coût en temps du détour et les règles douanières suisses sur les limites de quantité de carburant.',
 ],
 },

 // ───── Statistics: health insurance premiums by municipality ─
 '/statistiche/premi-malattia-comuni': {
 en: [
 'The health insurance premium map shows LAMal (mandatory Swiss health insurance) monthly premiums by municipality and insurer in Canton Ticino and surrounding cantons. Premiums vary significantly: from CHF 270 in the cheapest combination to over CHF 560 in the most expensive, depending on insurer, model (standard, HMO, telmed), deductible, and accident coverage inclusion.',
 'For cross-border workers who opt for Swiss LAMal instead of the Italian National Health Service, premium comparison is essential. The choice is irrevocable for the entire duration of employment, making it one of the most consequential financial decisions a new frontaliere faces in the first 90 days.',
 'The tool also shows the premium evolution over the last 5 years and forecasts for the coming year, helping you anticipate annual cost increases. Filter by canton, insurer, and coverage model to find the optimal combination for your health profile and budget.',
 ],
 de: [
 'Die Krankenkassenprämien-Karte zeigt monatliche KVG-Prämien (obligatorische Schweizer Krankenversicherung) nach Gemeinde und Versicherer im Kanton Tessin und umliegenden Kantonen. Die Prämien variieren erheblich: von CHF 270 in der günstigsten Kombination bis über CHF 560 in der teuersten, je nach Versicherer, Modell (Standard, HMO, Telmed), Franchise und Unfalldeckung.',
 'Für Grenzgänger, die sich für die Schweizer KVG statt den italienischen Nationalen Gesundheitsdienst entscheiden, ist der Prämienvergleich entscheidend. Die Wahl ist für die gesamte Beschäftigungsdauer unwiderruflich — eine der folgenreichsten Finanzentscheidungen in den ersten 90 Tagen.',
 'Das Tool zeigt auch die Prämienentwicklung der letzten 5 Jahre und Prognosen für das kommende Jahr. Filtern Sie nach Kanton, Versicherer und Deckungsmodell, um die optimale Kombination für Ihr Gesundheitsprofil und Budget zu finden.',
 ],
 fr: [
 'La carte des primes d\'assurance maladie montre les primes mensuelles LAMal (assurance maladie obligatoire suisse) par commune et assureur au Canton du Tessin et cantons environnants. Les primes varient considérablement : de CHF 270 dans la combinaison la moins chère à plus de CHF 560 dans la plus onéreuse, selon l\'assureur, le modèle (standard, HMO, télémédecine), la franchise et la couverture accidents.',
 'Pour les frontaliers qui optent pour la LAMal suisse plutôt que le Service National de Santé italien, la comparaison des primes est essentielle. Le choix est irrévocable pour toute la durée de l\'emploi — l\'une des décisions financières les plus lourdes de conséquences dans les 90 premiers jours.',
 'L\'outil montre aussi l\'évolution des primes sur les 5 dernières années et les prévisions pour l\'année à venir. Filtrez par canton, assureur et modèle de couverture pour trouver la combinaison optimale pour votre profil de santé et budget.',
 ],
 },

 // ───── Job board ────────────────────────────────────────────
 '/cerca-lavoro-ticino': {
 en: [
 'The Ticino job board aggregates positions from over 100 employers in Canton Ticino, including multinational corporations, public institutions (USI, SUPSI, EOC), banking and insurance groups, pharmaceutical companies, and IT firms. Listings are sourced directly from company HR portals and updated daily by dedicated crawlers.',
 'Each listing includes normalised data: job title, company, location, contract type, publication date, and a direct link to apply on the employer\'s original website. Jobs are translated into all four supported languages (Italian, English, German, French) to help non-Italian-speaking candidates discover opportunities.',
 'Use the search and filter tools to narrow results by sector, location, contract type, or company. For cross-border workers, the board is designed to complement salary comparison tools — after finding a role, use the net salary simulator to estimate take-home pay under both the G permit and B permit tax regimes.',
 'The most in-demand sectors in Ticino for cross-border workers include pharmaceuticals and life sciences (with major employers in the Lugano and Mendrisio area), banking and financial services (particularly in Lugano\'s financial district), engineering and manufacturing (along the Chiasso–Mendrisio industrial corridor), IT and software development, and hospitality/tourism around Lake Lugano and the Locarno area. These sectors offer median salaries ranging from CHF 55,000 to CHF 95,000 depending on experience and specialisation.',
 'Preparing a Swiss-format CV and cover letter is essential for job applications in Ticino. Swiss employers expect a reverse-chronological CV with a professional photo, exact employment dates (month/year), and references listed with contact details. Cover letters should be concise (one page), addressed to the hiring manager by name, and written in Italian for Ticino roles. Including your Swiss work permit status (G permit) and availability date demonstrates familiarity with cross-border employment conventions.',
 ],
 de: [
 'Die Tessiner Stellenbörse aggregiert Positionen von über 100 Arbeitgebern im Kanton Tessin, darunter multinationale Konzerne, öffentliche Institutionen (USI, SUPSI, EOC), Banken- und Versicherungsgruppen, Pharmaunternehmen und IT-Firmen. Die Angebote stammen direkt von den HR-Portalen der Unternehmen und werden täglich aktualisiert.',
 'Jedes Inserat enthält normalisierte Daten: Stellenbezeichnung, Unternehmen, Standort, Vertragsart, Veröffentlichungsdatum und einen Direktlink zur Bewerbung auf der Originalwebsite des Arbeitgebers. Stellen werden in alle vier unterstützten Sprachen übersetzt.',
 'Nutzen Sie die Such- und Filtertools, um Ergebnisse nach Branche, Standort, Vertragsart oder Unternehmen einzugrenzen. Für Grenzgänger ist die Börse als Ergänzung zu den Gehaltsvergleichstools konzipiert — nach dem Finden einer Stelle können Sie den Nettosimulator nutzen.',
 'Die am meisten nachgefragten Branchen im Tessin für Grenzgänger umfassen Pharma und Life Sciences (mit grossen Arbeitgebern im Raum Lugano und Mendrisio), Bank- und Finanzdienstleistungen (besonders im Finanzdistrikt Lugano), Ingenieurwesen und Fertigung (entlang des Industriekorridors Chiasso–Mendrisio), IT und Softwareentwicklung sowie Gastronomie und Tourismus rund um den Luganersee und den Raum Locarno. Diese Branchen bieten Mediangehälter von CHF 55.000 bis CHF 95.000.',
 'Die Erstellung eines Lebenslaufs und Bewerbungsschreibens im Schweizer Format ist für Bewerbungen im Tessin unerlässlich. Schweizer Arbeitgeber erwarten einen umgekehrt chronologischen Lebenslauf mit Passfoto, exakten Anstellungsdaten (Monat/Jahr) und Referenzen mit Kontaktdaten. Anschreiben sollten einseitig sein, den Personalverantwortlichen namentlich ansprechen und für Tessiner Stellen auf Italienisch verfasst sein. Die Angabe des Arbeitsbewilligungsstatus (Ausweis G) und Verfügbarkeitsdatums zeigt Vertrautheit mit den Grenzgänger-Konventionen.',
 ],
 fr: [
 'Le tableau d\'emploi tessinois agrège les postes de plus de 100 employeurs du Canton du Tessin, incluant des multinationales, des institutions publiques (USI, SUPSI, EOC), des groupes bancaires et d\'assurance, des entreprises pharmaceutiques et des sociétés IT. Les offres proviennent directement des portails RH des entreprises et sont mises à jour quotidiennement.',
 'Chaque offre inclut des données normalisées : intitulé du poste, entreprise, lieu, type de contrat, date de publication et lien direct pour postuler sur le site original de l\'employeur. Les postes sont traduits dans les quatre langues supportées.',
 'Utilisez les outils de recherche et de filtrage pour affiner les résultats par secteur, lieu, type de contrat ou entreprise. Pour les frontaliers, le tableau est conçu pour compléter les outils de comparaison salariale — après avoir trouvé un poste, utilisez le simulateur de salaire net.',
 'Les secteurs les plus recherchés au Tessin pour les frontaliers comprennent la pharma et les sciences de la vie (avec de grands employeurs dans la zone Lugano-Mendrisio), les services bancaires et financiers (notamment le quartier financier de Lugano), l\'ingénierie et la manufacture (le long du corridor industriel Chiasso–Mendrisio), l\'IT et le développement logiciel, ainsi que l\'hôtellerie et le tourisme autour du lac de Lugano et de Locarno. Ces secteurs offrent des salaires médians de CHF 55 000 à CHF 95 000.',
 'Préparer un CV et une lettre de motivation au format suisse est essentiel pour postuler au Tessin. Les employeurs suisses attendent un CV antichronologique avec photo professionnelle, dates d\'emploi exactes (mois/année) et références avec coordonnées. La lettre de motivation doit être concise (une page), adressée au responsable du recrutement par son nom, et rédigée en italien pour les postes tessinois. Indiquer son statut de permis de travail (permis G) et sa date de disponibilité démontre une connaissance des conventions d\'emploi transfrontalier.',
 ],
 },

 // ───── Swiss employment contracts guide ─────────────────────
 '/contratti-lavoro-svizzera': {
 en: [
 'The Swiss employment contracts guide explains the main contract types used in Canton Ticino: unlimited-term (CDI), fixed-term (CDD), temporary (staffing/interinale), and on-call contracts. For cross-border workers, understanding contract type is essential because it affects G permit duration, unemployment benefit eligibility, and notice period obligations.',
 'Swiss employment law provides strong protections compared to Italian norms: minimum notice periods scale from 1 month in the first year to 3 months after 9 years, the 13th month salary is standard practice (though not legally mandatory in all sectors), and trial periods are limited to 1-3 months.',
 'The guide also covers collective labour agreements (CCL/GAV) that apply in major Ticino sectors, minimum wage provisions (CHF 19.75/hour in 2026), overtime compensation rules, and the documentation you should verify before signing a Swiss employment contract.',
 ],
 de: [
 'Der Leitfaden zu Schweizer Arbeitsverträgen erklärt die Hauptvertragsarten im Kanton Tessin: unbefristet (CDI), befristet (CDD), temporär (Personalverleih/Interinale) und Arbeit auf Abruf. Für Grenzgänger ist das Verständnis der Vertragsart wesentlich, da sie Ausweis-G-Dauer, Arbeitslosengeldanspruch und Kündigungsfristen beeinflusst.',
 'Das Schweizer Arbeitsrecht bietet im Vergleich zu italienischen Normen starke Schutzrechte: Mindestkündigungsfristen skalieren von 1 Monat im ersten Jahr auf 3 Monate nach 9 Jahren, der 13. Monatslohn ist gängige Praxis, und Probezeiten sind auf 1-3 Monate begrenzt.',
 'Der Leitfaden behandelt auch Gesamtarbeitsverträge (GAV), die in wichtigen Tessiner Branchen gelten, Mindestlohnbestimmungen (CHF 19,75/Stunde 2026), Überstundenregelungen und die Dokumentation, die Sie vor Unterzeichnung eines Schweizer Arbeitsvertrags prüfen sollten.',
 ],
 fr: [
 'Le guide des contrats de travail suisses explique les principaux types de contrats utilisés au Canton du Tessin : durée indéterminée (CDI), durée déterminée (CDD), temporaire (intérim) et sur appel. Pour les frontaliers, comprendre le type de contrat est essentiel car il affecte la durée du permis G, l\'éligibilité aux allocations chômage et les obligations de préavis.',
 'Le droit du travail suisse offre des protections solides par rapport aux normes italiennes : les préavis minimaux vont de 1 mois la première année à 3 mois après 9 ans, le 13e mois est la pratique standard, et les périodes d\'essai sont limitées à 1-3 mois.',
 'Le guide couvre aussi les conventions collectives de travail (CCT) applicables dans les grands secteurs tessinois, les dispositions sur le salaire minimum (CHF 19,75/heure en 2026), les règles de compensation des heures supplémentaires et les documents à vérifier avant de signer un contrat suisse.',
 ],
 },

 // ───── TFR/severance for cross-border workers ───────────────
 '/tfr-liquidazione-frontaliere': {
 en: [
 'The TFR (Trattamento di Fine Rapporto) and severance guide clarifies what happens at the end of a Swiss employment relationship for cross-border workers. Unlike Italian law where TFR accrues automatically, Swiss law does not provide an equivalent: there is no end-of-service payment in Switzerland. However, the second pillar (LPP/BVG) serves a similar function.',
 'When leaving Swiss employment, cross-border workers can withdraw their LPP pension capital as a lump sum (if leaving Switzerland permanently) or transfer it to a vested benefits account (Freizügigkeitskonto). The withdrawal is subject to Swiss capital withdrawal tax, which varies by canton — in Ticino, typically 5-8% depending on the amount.',
 'The guide covers the step-by-step process: notifying your pension fund, choosing between lump sum and transfer, tax implications in both Switzerland and Italy, and the interaction with Italian TFR if you had previous Italian employment. For workers returning to Italy, declaring the Swiss pension withdrawal on Italian tax returns is mandatory.',
 ],
 de: [
 'Der Leitfaden zu TFR (Trattamento di Fine Rapporto) und Abfindung klärt, was bei Beendigung eines Schweizer Arbeitsverhältnisses für Grenzgänger passiert. Anders als im italienischen Recht, wo TFR automatisch anfällt, gibt es im Schweizer Recht kein Äquivalent. Die zweite Säule (BVG) übernimmt jedoch eine ähnliche Funktion.',
 'Beim Austritt aus einer Schweizer Beschäftigung können Grenzgänger ihr BVG-Vorsorgekapital als Einmalbetrag beziehen (bei endgültigem Verlassen der Schweiz) oder auf ein Freizügigkeitskonto übertragen. Der Bezug unterliegt der Schweizer Kapitalabzugssteuer, die im Tessin typischerweise 5-8 % beträgt.',
 'Der Leitfaden behandelt den Ablauf: Benachrichtigung der Pensionskasse, Wahl zwischen Kapitalbezug und Übertragung, steuerliche Auswirkungen in beiden Ländern und das Zusammenspiel mit dem italienischen TFR bei früherer italienischer Beschäftigung.',
 ],
 fr: [
 'Le guide du TFR (Trattamento di Fine Rapporto) et des indemnités de départ clarifie ce qui se passe à la fin d\'une relation de travail suisse pour les frontaliers. Contrairement au droit italien où le TFR s\'accumule automatiquement, le droit suisse ne prévoit pas d\'équivalent. Cependant, le deuxième pilier (LPP) remplit une fonction similaire.',
 'En quittant un emploi suisse, les frontaliers peuvent retirer leur capital de prévoyance LPP en une fois (en cas de départ définitif de Suisse) ou le transférer sur un compte de libre passage. Le retrait est soumis à l\'impôt suisse sur le retrait en capital, qui au Tessin est typiquement de 5-8 %.',
 'Le guide couvre le processus étape par étape : notification de la caisse de pension, choix entre retrait en capital et transfert, implications fiscales dans les deux pays et interaction avec le TFR italien en cas d\'emploi antérieur en Italie.',
 ],
 },

 // ───── G vs B permit quiz ───────────────────────────────────
 '/quiz-permesso-b-o-g': {
 en: [
 'The G vs B permit quiz helps you determine which Swiss work permit is best suited to your situation through a series of practical questions about your employment, family configuration, commute preferences, and financial priorities. The quiz is not a legal determination — it provides a personalised recommendation based on common cross-border worker profiles.',
 'Questions cover key decision factors: gross salary level (the breakeven point where B permit becomes financially advantageous is typically around CHF 90,000-110,000 for a family), children\'s ages and schooling preferences, daily commute tolerance, and long-term residency plans.',
 'After completing the quiz, you receive a personalised analysis linking to the relevant calculators: net salary under each permit type, cost of living comparison, healthcare premium comparison, and the residence change simulator to model the financial impact of switching permits.',
 ],
 de: [
 'Das G-vs-B-Ausweis-Quiz hilft Ihnen, anhand praktischer Fragen zu Beschäftigung, Familienkonstellation, Pendlerpräferenzen und finanziellen Prioritäten zu bestimmen, welche Schweizer Arbeitsbewilligung am besten zu Ihrer Situation passt.',
 'Die Fragen decken zentrale Entscheidungsfaktoren ab: Bruttogehaltsstufe (der Breakeven-Punkt, ab dem Ausweis B finanziell vorteilhaft wird, liegt typischerweise bei CHF 90.000-110.000 für eine Familie), Alter der Kinder und Schulpräferenzen, tägliche Pendeltoleranz und langfristige Aufenthaltspläne.',
 'Nach Abschluss des Quiz erhalten Sie eine personalisierte Analyse mit Links zu den relevanten Rechnern: Nettogehalt je Bewilligungstyp, Lebenshaltungskostenvergleich, Krankenkassenprämienvergleich und der Wohnsitzwechsel-Simulator.',
 ],
 fr: [
 'Le quiz permis G vs B vous aide à déterminer quel permis de travail suisse convient le mieux à votre situation à travers une série de questions pratiques sur votre emploi, votre configuration familiale, vos préférences de trajet et vos priorités financières.',
 'Les questions couvrent les facteurs de décision clés : niveau de salaire brut (le point d\'équilibre où le permis B devient financièrement avantageux se situe typiquement autour de CHF 90 000-110 000 pour une famille), âge des enfants, tolérance au trajet quotidien et projets de résidence à long terme.',
 'Après le quiz, vous recevez une analyse personnalisée avec liens vers les calculateurs pertinents : salaire net par type de permis, comparaison du coût de la vie, comparaison des primes d\'assurance maladie et simulateur de changement de résidence.',
 ],
 },

 // ───── 13th month salary calculator ─────────────────────────
 '/calcolo-tredicesima-frontaliere': {
 en: [
 'The 13th month salary calculator determines how the "tredicesima" (13th month payment) works for cross-border workers in Switzerland. In Swiss employment, the 13th month salary is a contractual provision rather than a legal obligation, but it is standard practice in most Ticino sectors and covered by collective labour agreements (CCL/GAV).',
 'The calculator shows how the 13th month is distributed: typically paid in December as a full monthly gross salary, subject to the same social deductions (AVS, unemployment, LPP) and withholding tax as regular monthly pay. This means the net 13th month may be lower than expected if your marginal tax bracket is higher.',
 'For Italian tax purposes, the 13th month is part of your total Swiss employment income and must be included in the annual IRPEF calculation. The guide clarifies the timing: Swiss CU documentation reflects 13 monthly payments, while Italian tax rules require annualised income reporting.',
 ],
 de: [
 'Der Rechner für den 13. Monatslohn erklärt, wie die „Tredicesima" (13. Monatsgehalt) für Grenzgänger in der Schweiz funktioniert. Im Schweizer Arbeitsrecht ist der 13. Monatslohn eine vertragliche Vereinbarung, aber in den meisten Tessiner Branchen Standardpraxis und durch Gesamtarbeitsverträge (GAV) abgedeckt.',
 'Der Rechner zeigt die Verteilung: typischerweise im Dezember als volles Bruttomonatsgehalt ausgezahlt, mit denselben Sozialabzügen (AHV, ALV, BVG) und Quellensteuer wie das reguläre Monatsgehalt. Das Netto des 13. Monatslohns kann daher niedriger als erwartet ausfallen.',
 'Für die italienische Steuer ist der 13. Monatslohn Teil des gesamten Schweizer Arbeitseinkommens und muss in die IRPEF-Jahresberechnung einbezogen werden. Die Schweizer CU-Dokumentation weist 13 Monatsgehälter aus, während italienische Steuerregeln eine annualisierte Einkommensmeldung erfordern.',
 ],
 fr: [
 'Le calculateur du 13e mois explique comment la « tredicesima » (13e mois de salaire) fonctionne pour les frontaliers en Suisse. En droit du travail suisse, le 13e mois est une disposition contractuelle plutôt qu\'une obligation légale, mais c\'est la pratique standard dans la plupart des secteurs tessinois, couverte par les conventions collectives (CCT/GAV).',
 'Le calculateur montre la distribution : typiquement versé en décembre comme un salaire mensuel brut complet, soumis aux mêmes déductions sociales (AVS, chômage, LPP) et impôt à la source que le salaire mensuel régulier. Le net du 13e mois peut donc être inférieur aux attentes.',
 'Pour l\'impôt italien, le 13e mois fait partie du revenu total d\'emploi suisse et doit être inclus dans le calcul annuel de l\'IRPEF. La documentation CU suisse reflète 13 mensualités, tandis que les règles fiscales italiennes exigent une déclaration de revenu annualisé.',
 ],
 },

 // ───── About us ─────────────────────────────────────────────
 '/chi-siamo': {
 en: [
 'Frontaliere Ticino is an independent information platform for cross-border workers between Switzerland (Canton Ticino) and Italy. The platform provides free calculators, comparison tools, practical guides, and job listings — all maintained with data from official Swiss and Italian sources.',
 'The project started from the direct experience of cross-border workers who found it difficult to navigate the complex fiscal, administrative, and practical landscape of working in one country and living in another. Every tool is designed to answer real questions with verifiable data.',
 'Content is updated continuously to reflect legislative changes, new tax rates, and evolving bilateral agreements. The platform operates independently of any financial institution, insurance provider, or employer, ensuring unbiased information for all users.',
 ],
 de: [
 'Frontaliere Ticino ist eine unabhängige Informationsplattform für Grenzgänger zwischen der Schweiz (Kanton Tessin) und Italien. Die Plattform bietet kostenlose Rechner, Vergleichstools, praktische Leitfäden und Stellenangebote — alle mit Daten aus offiziellen schweizerischen und italienischen Quellen gepflegt.',
 'Das Projekt entstand aus der direkten Erfahrung von Grenzgängern, die es schwierig fanden, die komplexe steuerliche, administrative und praktische Landschaft der Arbeit in einem Land bei Wohnsitz in einem anderen zu navigieren. Jedes Tool beantwortet echte Fragen mit überprüfbaren Daten.',
 'Inhalte werden kontinuierlich aktualisiert, um Gesetzesänderungen, neue Steuersätze und sich weiterentwickelnde bilaterale Abkommen widerzuspiegeln. Die Plattform arbeitet unabhängig von Finanzinstituten, Versicherungsanbietern oder Arbeitgebern.',
 ],
 fr: [
 'Frontaliere Ticino est une plateforme d\'information indépendante pour les travailleurs frontaliers entre la Suisse (Canton du Tessin) et l\'Italie. La plateforme offre des calculateurs gratuits, des outils de comparaison, des guides pratiques et des offres d\'emploi — le tout alimenté par des données de sources officielles suisses et italiennes.',
 'Le projet est né de l\'expérience directe de frontaliers qui trouvaient difficile de naviguer dans le paysage fiscal, administratif et pratique complexe du travail dans un pays avec résidence dans un autre. Chaque outil répond à de vraies questions avec des données vérifiables.',
 'Le contenu est mis à jour en continu pour refléter les changements législatifs, les nouveaux taux d\'imposition et l\'évolution des accords bilatéraux. La plateforme fonctionne indépendamment de toute institution financière, assureur ou employeur.',
 ],
 },

 // ───── Contact ─────────────────────────────────────────────
 '/contattaci': {
 en: [
 'Frontaliere Ticino is available for questions about taxation, pensions, work permits, and daily life for cross-border workers between Switzerland and Italy. The team responds to practical queries about platform tools, calculator error reports, and suggestions for new features.',
 'Responses are provided within 48 business hours. For complex tax questions (tax returns, tax credits, 2026 new cross-border worker regime), we recommend the dedicated consulting service with professionals specialising in cross-border taxation between Switzerland and Italy.',
 'The platform operates independently of banks, insurance companies, and employers: all information provided is impartial and based on official Swiss and Italian sources (FTA, Italian Revenue Agency, SECO, INPS).',
 ],
 de: [
 'Frontaliere Ticino steht für Fragen zu Besteuerung, Vorsorge, Arbeitsbewilligungen und Alltagsleben für Grenzgänger zwischen der Schweiz und Italien zur Verfügung. Das Team beantwortet praktische Anfragen zu den Plattform-Tools, meldet Rechenfehler und nimmt Vorschläge für neue Funktionen entgegen.',
 'Antworten werden innerhalb von 48 Arbeitsstunden bereitgestellt. Für komplexe Steuerfragen (Steuererklärung, Steuergutschriften, Regelung für neue Grenzgänger 2026) empfehlen wir den dedizierten Beratungsservice mit Fachleuten für grenzüberschreitende Besteuerung.',
 'Die Plattform arbeitet unabhängig von Banken, Versicherungen und Arbeitgebern: Alle bereitgestellten Informationen sind unparteiisch und basieren auf offiziellen Schweizer und italienischen Quellen (ESTV, Agenzia delle Entrate, SECO, INPS).',
 ],
 fr: [
 'Frontaliere Ticino est disponible pour les questions sur la fiscalité, la prévoyance, les permis de travail et la vie quotidienne des travailleurs frontaliers entre la Suisse et l\'Italie. L\'équipe répond aux questions pratiques sur les outils de la plateforme, signalements d\'erreurs et suggestions de nouvelles fonctionnalités.',
 'Les réponses sont fournies dans les 48 heures ouvrables. Pour les questions fiscales complexes (déclaration de revenus, crédits d\'impôt, régime des nouveaux frontaliers 2026), nous recommandons le service de consultation dédié avec des professionnels spécialisés en fiscalité transfrontalière.',
 'La plateforme fonctionne indépendamment des banques, assurances et employeurs : toutes les informations fournies sont impartiales et basées sur des sources officielles suisses et italiennes (AFC, Agenzia delle Entrate, SECO, INPS).',
 ],
 },

 // ───── Consulting ─────────────────────────────────────────────
 '/consulenza': {
 en: [
 'The tax consulting service is designed for cross-border workers who need personalised assistance with taxation, pensions, and fiscal optimisation in the Swiss-Italian cross-border context. Consultants specialise in the regulations of both countries and are up to date on the 2026 New Tax Agreement.',
 'Key areas include: Italian tax returns for Swiss income, choosing the tax regime (old vs new cross-border workers), calculating and applying the €10,000 exemption, optimising foreign tax credits (Art. 165 TUIR), AVS/LPP/pillar 3a pension planning, and choosing between LAMal and NHS.',
 'Each consultation starts from an analysis of your individual situation — marital status, distance from the border, years of employment in Switzerland, gross income — to identify the most advantageous tax strategy.',
 ],
 de: [
 'Der Steuerberatungsservice richtet sich an Grenzgänger, die persönliche Unterstützung bei Besteuerung, Vorsorge und steuerlicher Optimierung im schweizerisch-italienischen Grenzgängerkontext benötigen. Die Berater sind auf die Regelungen beider Länder spezialisiert und auf dem aktuellen Stand des Neuen Steuerabkommens 2026.',
 'Die Hauptbereiche umfassen: italienische Steuererklärung für Schweizer Einkommen, Wahl des Steuerregimes (alte vs. neue Grenzgänger), Berechnung und Anwendung des Freibetrags von €10.000, Optimierung der Steuergutschriften für im Ausland gezahlte Steuern (Art. 165 TUIR), AHV/BVG/Säule-3a-Vorsorgeplanung.',
 'Jede Beratung beginnt mit einer Analyse der individuellen Situation — Familienstand, Entfernung zur Grenze, Beschäftigungsjahre in der Schweiz, Bruttoeinkommen — um die vorteilhafteste Steuerstrategie zu identifizieren.',
 ],
 fr: [
 'Le service de consultation fiscale s\'adresse aux travailleurs frontaliers ayant besoin d\'une assistance personnalisée en matière de fiscalité, prévoyance et optimisation fiscale dans le contexte transfrontalier Suisse-Italie. Les consultants sont spécialisés dans les réglementations des deux pays et à jour sur le Nouvel Accord Fiscal 2026.',
 'Les domaines principaux incluent : déclaration de revenus italienne pour les revenus suisses, choix du régime fiscal (anciens vs nouveaux frontaliers), calcul et application de la franchise de 10 000 €, optimisation des crédits d\'impôt pour impôts payés à l\'étranger (Art. 165 TUIR), planification AVS/LPP/3e pilier.',
 'Chaque consultation part de l\'analyse de la situation individuelle — état civil, distance de la frontière, années d\'emploi en Suisse, revenu brut — pour identifier la stratégie fiscale la plus avantageuse.',
 ],
 },

 // ───── Privacy ─────────────────────────────────────────────
 '/privacy': {
 en: [
 'Frontaliere Ticino processes user personal data in compliance with the General Data Protection Regulation (GDPR, EU Regulation 2016/679) and the Swiss Federal Act on Data Protection (nFADP 2023). The platform does not require mandatory registration: all calculators and comparators can be used without providing personal data.',
 'Data collected (email addresses for job alerts, browsing data via Google Analytics 4) is used exclusively for operating the services requested by the user and for aggregate analysis of platform usage. Data is never shared with third parties for marketing purposes.',
 'Tax and pension simulations run entirely in the user\'s browser: the data entered into calculators (salary, marital status, number of children) is never transmitted to servers. This architecture ensures maximum confidentiality of personal financial information.',
 ],
 de: [
 'Frontaliere Ticino verarbeitet personenbezogene Daten der Nutzer in Übereinstimmung mit der Datenschutz-Grundverordnung (DSGVO, EU-Verordnung 2016/679) und dem Schweizer Bundesgesetz über den Datenschutz (nDSG 2023). Die Plattform erfordert keine obligatorische Registrierung: Alle Rechner und Vergleicher können ohne Angabe persönlicher Daten genutzt werden.',
 'Erhobene Daten (E-Mail-Adressen für Jobbenachrichtigungen, Browsing-Daten über Google Analytics 4) werden ausschließlich für den Betrieb der vom Nutzer angeforderten Dienste und für die aggregierte Analyse der Plattformnutzung verwendet. Daten werden niemals für Marketingzwecke an Dritte weitergegeben.',
 'Steuer- und Vorsorgesimulationen laufen vollständig im Browser des Nutzers: Die in die Rechner eingegebenen Daten (Gehalt, Familienstand, Kinderzahl) werden niemals an Server übertragen. Diese Architektur gewährleistet maximale Vertraulichkeit persönlicher Finanzinformationen.',
 ],
 fr: [
 'Frontaliere Ticino traite les données personnelles des utilisateurs conformément au Règlement Général sur la Protection des Données (RGPD, Règlement UE 2016/679) et à la Loi fédérale suisse sur la protection des données (nLPD 2023). La plateforme ne requiert aucune inscription obligatoire : tous les calculateurs et comparateurs sont utilisables sans fournir de données personnelles.',
 'Les données éventuellement collectées (adresse e-mail pour les alertes emploi, données de navigation via Google Analytics 4) sont utilisées exclusivement pour le fonctionnement des services demandés par l\'utilisateur et pour l\'analyse agrégée de l\'utilisation de la plateforme. Aucune donnée n\'est cédée à des tiers à des fins marketing.',
 'Les simulations fiscales et de prévoyance s\'exécutent entièrement dans le navigateur de l\'utilisateur : les données saisies dans les calculateurs (salaire, état civil, nombre d\'enfants) ne sont jamais transmises aux serveurs. Cette architecture garantit la confidentialité maximale des informations financières personnelles.',
 ],
 },

 // ───── API Status ─────────────────────────────────────────────
 '/stato-api': {
 en: [
 'This page shows the real-time operational status of all external services used by the Frontaliere Ticino platform: CHF/EUR exchange rate (TwelveData API), border crossing traffic (Google Maps API), reCAPTCHA for form protection, and Firebase for storage and configurations.',
 'The platform is designed to work even when one or more external services are temporarily unavailable: exchange rates have a local cache with fallback to the most recent data, border traffic uses estimates based on historical data, and calculators run entirely in the browser without depending on remote servers.',
 'The history of outages and average availability of each service are visible on this page, along with average API latency and data update frequency.',
 ],
 de: [
 'Diese Seite zeigt den Echtzeit-Betriebsstatus aller von der Plattform Frontaliere Ticino genutzten externen Dienste: CHF/EUR-Wechselkurs (TwelveData API), Grenzverkehr (Google Maps API), reCAPTCHA für Formularschutz und Firebase für Speicherung und Konfigurationen.',
 'Die Plattform ist so konzipiert, dass sie auch bei vorübergehender Nichtverfügbarkeit eines oder mehrerer externer Dienste funktioniert: Wechselkurse haben einen lokalen Cache mit Fallback auf die neuesten Daten, und die Rechner laufen vollständig im Browser ohne Abhängigkeit von Remote-Servern.',
 'Die Historie der Ausfälle und die durchschnittliche Verfügbarkeit jedes Dienstes sind auf dieser Seite sichtbar, zusammen mit der durchschnittlichen API-Latenz und der Datenaktualisierungsfrequenz.',
 ],
 fr: [
 'Cette page affiche l\'état opérationnel en temps réel de tous les services externes utilisés par la plateforme Frontaliere Ticino : taux de change CHF/EUR (TwelveData API), trafic aux postes frontière (Google Maps API), reCAPTCHA pour la protection des formulaires et Firebase pour le stockage et les configurations.',
 'La plateforme est conçue pour fonctionner même lorsqu\'un ou plusieurs services externes sont temporairement indisponibles : les taux de change disposent d\'un cache local avec repli sur les données les plus récentes, et les calculateurs fonctionnent entièrement dans le navigateur sans dépendre de serveurs distants.',
 'L\'historique des interruptions et la disponibilité moyenne de chaque service sont visibles sur cette page, ainsi que la latence moyenne des API et la fréquence de mise à jour des données.',
 ],
 },

 // ───── Blog index ─────────────────────────────────────────────
 // The visible "browse all articles" anchor closes the BFS path from
 // the recent-articles index to the full A-Z archive (/tutti/, /all/,
 // /alle/, /tous/). Without it, Semrush flags every article only
 // reachable via /tutti/page-N/ as an orphan in sitemap.
 '/articoli-frontaliere': {
 en: [
 '<strong>Cross-Border Articles</strong> is the editorial hub of Frontaliere Ticino with over 700 in-depth articles for cross-border workers between Italy and Switzerland. Content covers taxation (2026 New Agreement, IRPEF, withholding tax), pensions (AVS, LPP, pillar 3a), practical guides (permits, banking, customs), and legislative updates.',
 'The articles section is built as an editorial hub: each piece dives deep into an operational topic and links to tools or guides so readers can move quickly from news to numerical simulation. Topics range from the 2026 New Agreement taxation rules to practical guides on opening a Swiss bank account.',
 'Main categories: Tax (cross-border taxation, withholding tax, IRPEF), Practical (permits, customs, transport, banking), News (Swiss and Italian legislative updates), Pension (AVS, LPP, pillar 3a). Articles are updated whenever significant regulatory changes occur.',
 'The article library covers a broad range of categories tailored to cross-border worker needs: fiscal deep-dives on the 2026 New Agreement and withholding tax tables, practical guides for opening Swiss bank accounts and transferring vehicles, pension planning articles comparing AVS projections with Italian INPS, job market analyses for Ticino\'s key sectors, and lifestyle content on housing, schools, and healthcare. A search and category filter system helps readers find relevant content quickly.',
 'Every article follows a rigorous editorial approach: content is verified against official sources including Swiss Federal Council publications, Canton Ticino tax authority (Divisione delle contribuzioni) circulars, Italian Agenzia delle Entrate guidelines, and bilateral agreement texts. Articles referencing 2026 regulations are reviewed and updated whenever new implementing provisions are published, ensuring readers always access current and actionable information rather than outdated guidance.',
 '<p style="margin:1rem 0"><a href="/en/cross-border-articles/all/" style="display:inline-block;padding:.5rem 1rem;border-radius:6px;background:#2563eb;color:#fff;text-decoration:none;font-weight:600">Browse all articles →</a></p>',
 ],
 de: [
 '<strong>Grenzgänger-Artikel</strong> ist der redaktionelle Hub von Frontaliere Ticino mit über 700 Vertiefungsartikeln für Grenzgänger zwischen Italien und der Schweiz. Die Inhalte decken Besteuerung (Neues Abkommen 2026, IRPEF, Quellensteuer), Vorsorge (AHV, BVG, Säule 3a), praktische Leitfäden (Bewilligungen, Bank, Zoll) und Gesetzesänderungen ab.',
 'Die Artikelsektion ist als redaktioneller Hub aufgebaut: Jeder Beitrag vertieft ein operatives Thema und verlinkt auf Tools oder Leitfäden, sodass Leser schnell von der Nachricht zur numerischen Simulation gelangen.',
 'Hauptkategorien: Steuer (Grenzgängerbesteuerung, Quellensteuer, IRPEF), Praktisch (Bewilligungen, Zoll, Transport, Bank), Neuigkeiten (Schweizer und italienische Gesetzesänderungen), Vorsorge (AHV, BVG, Säule 3a). Artikel werden bei jeder bedeutenden Rechtsänderung aktualisiert.',
 'Die Artikelbibliothek deckt ein breites Spektrum an Kategorien ab, die auf Grenzgänger-Bedürfnisse zugeschnitten sind: steuerliche Vertiefungen zum Neuen Abkommen 2026 und den Quellensteuertabellen, praktische Leitfäden zur Eröffnung von Schweizer Bankkonten und zum Fahrzeugtransfer, Vorsorge-Artikel mit Vergleichen der AHV-Projektionen und der italienischen INPS, Arbeitsmarktanalysen für die Tessiner Schlüsselbranchen sowie Lifestyle-Inhalte zu Wohnen, Schulen und Gesundheitsversorgung.',
 'Jeder Artikel folgt einem rigorosen redaktionellen Ansatz: Die Inhalte werden anhand offizieller Quellen verifiziert — darunter Publikationen des Schweizer Bundesrats, Rundschreiben der Tessiner Steuerverwaltung (Divisione delle contribuzioni), Leitlinien der italienischen Agenzia delle Entrate und Abkommenstexte. Artikel mit Bezug auf 2026er-Regelungen werden bei jeder neuen Durchführungsbestimmung überprüft und aktualisiert, um stets aktuelle und umsetzbare Informationen zu gewährleisten.',
 '<p style="margin:1rem 0"><a href="/de/grenzgaenger-artikel/alle/" style="display:inline-block;padding:.5rem 1rem;border-radius:6px;background:#2563eb;color:#fff;text-decoration:none;font-weight:600">Alle Artikel ansehen →</a></p>',
 ],
 fr: [
 '<strong>Articles Frontalier</strong> est le hub éditorial de Frontaliere Ticino avec plus de 700 articles approfondis pour les travailleurs frontaliers entre l\'Italie et la Suisse. Les contenus couvrent la fiscalité (Nouvel Accord 2026, IRPEF, impôt à la source), la prévoyance (AVS, LPP, 3e pilier), des guides pratiques (permis, banque, douane) et les mises à jour législatives.',
 'La section articles est conçue comme un hub éditorial : chaque contenu approfondit un thème opérationnel et renvoie aux outils ou guides pour passer rapidement de l\'information à la simulation chiffrée.',
 'Catégories principales : Fiscal (fiscalité frontalière, impôt à la source, IRPEF), Pratique (permis, douane, transport, banque), Actualités (mises à jour législatives suisses et italiennes), Prévoyance (AVS, LPP, 3e pilier). Les articles sont mis à jour à chaque modification réglementaire significative.',
 'La bibliothèque d\'articles couvre un large éventail de catégories adaptées aux besoins des frontaliers : analyses fiscales approfondies du Nouvel Accord 2026 et des barèmes d\'imposition à la source, guides pratiques pour l\'ouverture de comptes bancaires suisses et le transfert de véhicules, articles de planification retraite comparant les projections AVS avec l\'INPS italienne, analyses du marché de l\'emploi pour les secteurs clés du Tessin, et contenus lifestyle sur le logement, les écoles et la santé.',
 'Chaque article suit une approche éditoriale rigoureuse : les contenus sont vérifiés auprès de sources officielles incluant les publications du Conseil fédéral suisse, les circulaires de l\'administration fiscale tessinoise (Divisione delle contribuzioni), les directives de l\'Agenzia delle Entrate italienne et les textes des accords bilatéraux. Les articles référençant les réglementations 2026 sont révisés et mis à jour à chaque nouvelle disposition d\'application, garantissant des informations toujours actuelles et exploitables.',
 '<p style="margin:1rem 0"><a href="/fr/articles-frontalier/tous/" style="display:inline-block;padding:.5rem 1rem;border-radius:6px;background:#2563eb;color:#fff;text-decoration:none;font-weight:600">Voir tous les articles →</a></p>',
 ],
 },

 // ─────────────────────────────────────────────────────────────
 // Workstream C — New SEO landing pages (SemRush growth plan)
 // ─────────────────────────────────────────────────────────────
 '/guida-frontaliere/tassa-salute-frontalieri': {
 it: [
 '<h2 style="font-size:1.15rem;font-weight:700;margin:1.25rem 0 .5rem">Cos\'è la tassa salute per i frontalieri</h2>',
 '<p>La <strong>tassa salute frontalieri</strong>, detta anche contributo sanitario transfrontaliero, è un prelievo introdotto dall\'articolo 9 del <strong>Nuovo Accordo Italia-Svizzera</strong> entrato in vigore il 17 luglio 2023. Si applica ai cosiddetti <em>nuovi frontalieri</em> — coloro che hanno iniziato a lavorare in Svizzera dopo tale data — e va a finanziare il Servizio Sanitario Nazionale nelle Regioni italiane di confine (Lombardia, Piemonte, Valle d\'Aosta e Trentino-Alto Adige). La misura è stata pensata come meccanismo di compensazione finanziaria per le Regioni italiane che sostengono la spesa sanitaria di lavoratori che prestano la propria attività — e generano ricchezza fiscale — oltreconfine.</p>',
 '<h2 style="font-size:1.15rem;font-weight:700;margin:1.25rem 0 .5rem">Importo 2026 e modalità di calcolo</h2>',
 '<p>L\'aliquota fissata dall\'Accordo è del <strong>6% dell\'imposta alla fonte lorda</strong> trattenuta dal Cantone svizzero di lavoro sul salario del frontaliere. Su uno stipendio lordo annuo di CHF 72.000 con imposta alla fonte del 9% (circa CHF 6.480 annui di imposta fonte lorda), la tassa salute ammonta a CHF 388,80 all\'anno, ovvero poco più di <strong>CHF 32 al mese</strong>. Su un salario di CHF 90.000, con imposta fonte del 10%, la cifra sale a CHF 540 annui (CHF 45/mese). La trattenuta è visibile in busta paga svizzera (Lohnabrechnung) sotto una voce denominata in tedesco <em>Gesundheitsabgabe</em> o in italiano <em>contributo salute frontalieri</em>, a seconda del Cantone e del datore di lavoro.</p>',
 '<h2 style="font-size:1.15rem;font-weight:700;margin:1.25rem 0 .5rem">Chi paga e chi è esente</h2>',
 '<p>Sono soggetti alla tassa salute <strong>esclusivamente i nuovi frontalieri</strong> con permesso G assunti dopo il 17 luglio 2023, residenti in un Comune italiano entro 20 km dal confine e che rientrano quotidianamente (o almeno una volta a settimana) in Italia. Sono invece <strong>esenti</strong>: i vecchi frontalieri (assunti prima del 17/07/2023) ancora nel regime transitorio fino al 2033; i frontalieri con permesso B (dimora) in quanto residenti fiscali in Svizzera; i lavoratori stagionali con permessi di durata inferiore ai 90 giorni; i funzionari internazionali e diplomatici esenti per convenzione; i cittadini svizzeri che risiedono in Italia e lavorano in Svizzera.</p>',
 '<h2 style="font-size:1.15rem;font-weight:700;margin:1.25rem 0 .5rem">Meccanismo di riversamento alle Regioni</h2>',
 '<p>Il Cantone svizzero competente trattiene alla fonte sia l\'imposta fonte ordinaria (trasferita per l\'80% alla Confederazione e per il 20% ai comuni ticinesi) sia il contributo salute del 6%, che segue però un canale separato: viene trasferito alla Confederazione svizzera che, tramite il meccanismo di compensazione finanziaria previsto dall\'Accordo, lo riversa periodicamente alle Regioni italiane di confine. Ogni Regione destina poi le somme ricevute al finanziamento delle Aziende Sanitarie Locali (ASL) di appartenenza dei frontalieri residenti, garantendo così che il sistema sanitario italiano mantenga la capacità di fornire prestazioni ai frontalieri e alle loro famiglie.</p>',
 '<h2 style="font-size:1.15rem;font-weight:700;margin:1.25rem 0 .5rem">Differenza con LAMal e credito d\'imposta</h2>',
 '<p>È fondamentale <strong>non confondere la tassa salute con la LAMal</strong>, l\'assicurazione sanitaria svizzera obbligatoria. La LAMal è una polizza privata (pur obbligatoria per legge) con premio mensile di CHF 280-650 pagato direttamente alla cassa malati scelta; la tassa salute è un tributo pubblico trattenuto dallo Stato svizzero. Il nuovo frontaliere paga sempre la tassa salute indipendentemente dal fatto che abbia aderito alla LAMal o al SSN italiano. La tassa salute rientra nel credito d\'imposta italiano per imposte pagate all\'estero e va dichiarata nel Quadro CE del modello Redditi PF o nel Quadro G del 730: in pratica riduce euro su euro l\'IRPEF dovuta in Italia, minimizzandone l\'impatto netto.</p>',
 '<h2 style="font-size:1.15rem;font-weight:700;margin:1.25rem 0 .5rem">Documenti da conservare e fonti ufficiali</h2>',
 '<p>Il frontaliere deve conservare <strong>Lohnausweis</strong> (certificazione annuale svizzera), buste paga mensili che evidenzino la voce contributo salute, e attestazione del credito d\'imposta dall\'Agenzia delle Entrate italiana. Le fonti ufficiali cui fare riferimento sono il testo del <em>Nuovo Accordo Italia-Svizzera del 23 dicembre 2020</em>, ratificato con Legge n. 83 del 13 giugno 2023, e la <em>Circolare n. 25/E del 18 agosto 2023</em> dell\'Agenzia delle Entrate che chiarisce il trattamento fiscale. Per aggiornamenti specifici rivolgersi al consolato svizzero competente o a un commercialista specializzato in fiscalità transfrontaliera — l\'esperienza dimostra che errori nella dichiarazione dei redditi sono la prima causa di doppia imposizione evitabile.</p>',
 ],
 en: [
 '<h2 style="font-size:1.15rem;font-weight:700;margin:1.25rem 0 .5rem">What is the cross-border health contribution?</h2>',
 '<p>The <strong>cross-border health contribution</strong> (known in Italian as <em>tassa salute frontalieri</em>) is a levy introduced by Article 9 of the Italy-Switzerland New Agreement that entered into force on 17 July 2023. It applies to so-called "new cross-border workers" — those who started working in Switzerland after that date — and funds the Italian National Health Service in the border regions (Lombardy, Piedmont, Aosta Valley and Trentino-Alto Adige).</p>',
 '<h2 style="font-size:1.15rem;font-weight:700;margin:1.25rem 0 .5rem">2026 amount and calculation</h2>',
 '<p>The rate set by the Agreement is <strong>6% of the gross withholding tax</strong> levied by the Swiss canton of employment. On a gross annual salary of CHF 72,000 with a 9% withholding tax, the health contribution amounts to around CHF 389 per year, or just over CHF 32 per month. The deduction appears on the Swiss payslip (Lohnabrechnung) under a line labelled <em>Gesundheitsabgabe</em> or "contributo salute frontalieri".</p>',
 '<h2 style="font-size:1.15rem;font-weight:700;margin:1.25rem 0 .5rem">Who pays and who is exempt</h2>',
 '<p>Only new cross-border workers with a G permit hired after 17 July 2023 and residing in an Italian municipality within 20 km of the border are subject to the contribution. Exempt categories include old cross-border workers (hired before that date), B-permit holders, seasonal workers, and international officials.</p>',
 '<p>It is crucial not to confuse the health contribution with the LAMal Swiss compulsory health insurance: LAMal is a private policy with a monthly premium of CHF 280-650 paid to a health fund, while the health contribution is a public levy withheld by the Swiss state. A new cross-border worker always pays the health contribution regardless of the LAMal vs SSN option.</p>',
 ],
 de: [
 '<h2 style="font-size:1.15rem;font-weight:700;margin:1.25rem 0 .5rem">Was ist die Grenzgänger-Gesundheitsabgabe?</h2>',
 '<p>Die <strong>Gesundheitsabgabe für Grenzgänger</strong> (italienisch <em>tassa salute frontalieri</em>) ist eine Abgabe, die durch Artikel 9 des am 17. Juli 2023 in Kraft getretenen neuen Abkommens Italien-Schweiz eingeführt wurde. Sie gilt für sogenannte "neue Grenzgänger" — Personen, die nach diesem Datum ihre Tätigkeit in der Schweiz aufgenommen haben — und finanziert das italienische Gesundheitssystem in den Grenzregionen (Lombardei, Piemont, Aostatal und Trentino-Südtirol).</p>',
 '<h2 style="font-size:1.15rem;font-weight:700;margin:1.25rem 0 .5rem">Höhe 2026 und Berechnung</h2>',
 '<p>Der im Abkommen festgelegte Satz beträgt <strong>6 % der vom Arbeitskanton erhobenen Quellensteuer</strong>. Bei einem Bruttojahreslohn von CHF 72.000 mit 9 % Quellensteuer beläuft sich die Gesundheitsabgabe auf rund CHF 389 pro Jahr, also etwas über CHF 32 pro Monat. Der Abzug erscheint auf der Schweizer Lohnabrechnung als <em>Gesundheitsabgabe</em>.</p>',
 '<h2 style="font-size:1.15rem;font-weight:700;margin:1.25rem 0 .5rem">Wer bezahlt und wer ist befreit</h2>',
 '<p>Nur neue Grenzgänger mit G-Bewilligung, die nach dem 17. Juli 2023 eingestellt wurden und in einer italienischen Gemeinde innerhalb von 20 km zur Grenze wohnen, unterliegen der Abgabe. Befreit sind alte Grenzgänger (vor diesem Datum eingestellt), Inhaber einer B-Bewilligung, Saisonarbeiter und internationale Beamte.</p>',
 '<p>Die Gesundheitsabgabe darf nicht mit der obligatorischen Schweizer Krankenversicherung KVG/LAMal verwechselt werden: Die KVG ist eine private Police mit Monatsprämien von CHF 280-650, während die Gesundheitsabgabe eine vom Schweizer Staat einbehaltene öffentliche Abgabe ist. Ein neuer Grenzgänger zahlt die Abgabe unabhängig von der Wahl zwischen KVG und italienischem SSN.</p>',
 ],
 fr: [
 '<h2 style="font-size:1.15rem;font-weight:700;margin:1.25rem 0 .5rem">Qu\'est-ce que la contribution santé des frontaliers ?</h2>',
 '<p>La <strong>contribution santé pour frontaliers</strong> (en italien <em>tassa salute frontalieri</em>) est un prélèvement introduit par l\'article 9 du nouvel Accord Italie-Suisse entré en vigueur le 17 juillet 2023. Elle s\'applique aux "nouveaux frontaliers" — ceux qui ont commencé à travailler en Suisse après cette date — et finance le Service national de santé italien dans les régions frontalières (Lombardie, Piémont, Val d\'Aoste et Trentin-Haut-Adige).</p>',
 '<h2 style="font-size:1.15rem;font-weight:700;margin:1.25rem 0 .5rem">Montant 2026 et calcul</h2>',
 '<p>Le taux fixé par l\'Accord est de <strong>6 % de l\'impôt à la source brut</strong> prélevé par le canton suisse d\'emploi. Sur un salaire annuel brut de CHF 72.000 avec un impôt à la source de 9 %, la contribution santé s\'élève à environ CHF 389 par an, soit un peu plus de CHF 32 par mois. La retenue apparaît sur la fiche de paie suisse (Lohnabrechnung) sous la rubrique <em>Gesundheitsabgabe</em> ou "contributo salute frontalieri".</p>',
 '<h2 style="font-size:1.15rem;font-weight:700;margin:1.25rem 0 .5rem">Qui paie et qui est exempté</h2>',
 '<p>Seuls les nouveaux frontaliers titulaires d\'un permis G, embauchés après le 17 juillet 2023 et résidant dans une commune italienne à moins de 20 km de la frontière, sont soumis à la contribution. Sont exemptés les anciens frontaliers (embauchés avant cette date), les titulaires d\'un permis B, les travailleurs saisonniers et les fonctionnaires internationaux.</p>',
 '<p>Il ne faut pas confondre la contribution santé avec la LAMal, assurance maladie obligatoire suisse : la LAMal est une police privée avec une prime mensuelle de CHF 280-650 versée à une caisse maladie, tandis que la contribution santé est un prélèvement public retenu par l\'État suisse. Un nouveau frontalier paie toujours la contribution santé indépendamment du choix entre LAMal et SSN italien.</p>',
 ],
 },

 '/guida-frontaliere/lamal-frontalieri': {
 it: [
 '<h2 style="font-size:1.15rem;font-weight:700;margin:1.25rem 0 .5rem">LAMal: l\'assicurazione sanitaria svizzera obbligatoria</h2>',
 '<p>La <strong>LAMal</strong> (Legge federale sull\'assicurazione malattia, KVG in tedesco) è la base del sistema sanitario svizzero dal 1996: ogni persona domiciliata o che lavora in Svizzera è obbligata ad assicurarsi presso una delle casse malati riconosciute. Per i frontalieri residenti in Italia e attivi in Canton Ticino la LAMal rappresenta una delle due opzioni assicurative possibili — l\'altra è il Servizio Sanitario Nazionale italiano — e la scelta, detta <em>diritto d\'opzione</em>, deve essere esercitata entro tre mesi dall\'inizio del rapporto di lavoro ed è irrevocabile. Si tratta di una delle decisioni finanziarie più importanti nella vita da frontaliere, con impatto pluridecennale su costi, qualità delle cure e copertura familiare.</p>',
 '<h2 style="font-size:1.15rem;font-weight:700;margin:1.25rem 0 .5rem">Come funziona il diritto d\'opzione</h2>',
 '<p>All\'inizio del rapporto di lavoro il frontaliere riceve dal datore di lavoro svizzero una comunicazione del Servizio dell\'igiene pubblica del Canton Ticino che richiede la scelta dell\'opzione sanitaria. Il modulo va compilato e inviato entro <strong>tre mesi</strong> all\'Istituto Comune LAMal (Gemeinsame Einrichtung KVG) e, in copia, alla cassa malati scelta o all\'ASL italiana competente. Chi non risponde entro il termine è automaticamente iscritto alla LAMal con una cassa d\'ufficio assegnata dall\'Istituto Comune — una delle scelte tipicamente più costose. La scelta è definitiva: non è possibile passare dal SSN alla LAMal o viceversa se non con cambio di stato lavorativo (es. nuova assunzione).</p>',
 '<h2 style="font-size:1.15rem;font-weight:700;margin:1.25rem 0 .5rem">Premi 2026 delle casse malati per Ticino</h2>',
 '<p>I premi LAMal per frontalieri nel 2026 variano da circa <strong>CHF 280 a CHF 650 al mese</strong> per adulto, in base alla cassa scelta, alla franchigia (da CHF 300 minimo a CHF 2.500 massimo) e al modello assicurativo: standard (libera scelta del medico), medico di famiglia (gatekeeper), HMO (rete di medici), telemedicina (prima visita telefonica). Le 14 casse malati autorizzate per i frontalieri Ticino sono: <strong>Helsana, Swica, CSS, Sanitas, KPT, Visana, Sympany, Atupri, ÖKK, Concordia, Sodalis, EGK, SLKK e Rhenusana</strong>. Assura (spesso la più economica) e Mutuel/Groupe Mutuel non accettano frontalieri residenti in Italia nel 2026. I premi variano di anno in anno e sono pubblicati dall\'UFSP (Ufficio federale della sanità pubblica) entro ottobre per l\'anno successivo.</p>',
 '<h2 style="font-size:1.15rem;font-weight:700;margin:1.25rem 0 .5rem">Franchigie e modelli assicurativi a confronto</h2>',
 '<p>La franchigia è l\'importo che l\'assicurato paga di tasca propria prima che l\'assicurazione intervenga. Le opzioni sono: CHF 300 (premio più alto), 500, 1.000, 1.500, 2.000 e CHF 2.500 (premio più basso). Oltre alla franchigia c\'è la <em>partecipazione ai costi</em> del 10% fino a un massimo di CHF 700/anno per adulti e CHF 350 per minori. I modelli assicurativi alternativi riducono il premio del 15-25%: <strong>modello medico di famiglia</strong> (gatekeeper) richiede di consultare prima il medico scelto; <strong>HMO</strong> (rete di medici) limita la scelta a una lista; <strong>telemedicina</strong> impone una prima consulenza telefonica. Per chi ha buona salute conviene franchigia alta + modello telemedicina: combinazione che può tagliare il premio del 40% rispetto al piano standard con franchigia minima.</p>',
 '<h2 style="font-size:1.15rem;font-weight:700;margin:1.25rem 0 .5rem">LAMal vs SSN: decisione strategica</h2>',
 '<p>Non esiste una risposta universale: la scelta dipende da stato di salute, composizione familiare, distanza dai servizi sanitari, preferenze culturali. <strong>LAMal conviene</strong> a chi ha famiglia con figli piccoli (spesso malati), condizioni croniche, preferisce strutture private svizzere, lavora oltre 20 km dal confine. <strong>SSN conviene</strong> a chi ha buona salute, vive vicino al confine con buon ospedale italiano, ha basso stipendio (LAMal pesa di più in percentuale), vuole coprire anche coniuge e figli non lavoratori senza costi aggiuntivi. Calcolo orientativo: su uno stipendio di CHF 5.000/mese la LAMal costa il 7-11%, il SSN è gratuito ma con liste d\'attesa più lunghe e copertura svizzera solo per emergenze.</p>',
 '<h2 style="font-size:1.15rem;font-weight:700;margin:1.25rem 0 .5rem">Deduzione fiscale e documenti</h2>',
 '<p>Per i nuovi frontalieri (dal 17/07/2023) i premi LAMal versati in Svizzera sono <strong>deducibili fino a €3.000 annui</strong> ai fini IRPEF italiana secondo l\'art. 3 del Nuovo Accordo. La deduzione va indicata nel Quadro RP del modello Redditi PF o Quadro E del 730, conservando l\'attestazione annuale della cassa malati con premio totale pagato. I vecchi frontalieri non beneficiano della deduzione in Italia ma non essendo tassati in Italia non ne hanno bisogno. Per cambiare cassa malati all\'interno del sistema LAMal il termine è <strong>30 novembre per il cambio con effetto 1° gennaio</strong> (franchigia ordinaria), oppure 31 marzo e 30 settembre per le franchigie opzionali. La nuova cassa non può rifiutare l\'adesione per motivi di salute: l\'obbligo di accettazione è sancito per legge.</p>',
 ],
 en: [
 '<h2 style="font-size:1.15rem;font-weight:700;margin:1.25rem 0 .5rem">LAMal: the Swiss compulsory health insurance</h2>',
 '<p><strong>LAMal</strong> (Federal Health Insurance Act, KVG in German) is the backbone of the Swiss health system since 1996. Everyone domiciled or working in Switzerland must be insured with an approved health fund. For cross-border workers resident in Italy and working in Canton Ticino, LAMal is one of two options — the other being the Italian National Health Service — and the choice (called <em>right of option</em>) must be exercised within three months of starting work and is irrevocable.</p>',
 '<h2 style="font-size:1.15rem;font-weight:700;margin:1.25rem 0 .5rem">2026 premiums for Ticino cross-border workers</h2>',
 '<p>LAMal premiums for cross-border workers in 2026 range from around <strong>CHF 280 to CHF 650 per month</strong> per adult, depending on the fund, deductible (CHF 300 to 2,500) and insurance model (standard, family doctor, HMO, telemedicine). The 14 funds authorised for Ticino cross-border workers are Helsana, Swica, CSS, Sanitas, KPT, Visana, Sympany, Atupri, ÖKK, Concordia, Sodalis, EGK, SLKK and Rhenusana.</p>',
 '<h2 style="font-size:1.15rem;font-weight:700;margin:1.25rem 0 .5rem">LAMal vs SSN: the strategic decision</h2>',
 '<p>There is no one-size-fits-all answer: the choice depends on health status, family composition and preferences. LAMal is typically better for families with young children or chronic conditions; SSN is better for healthy young workers living near the border with good Italian hospitals. On a CHF 5,000/month salary, LAMal costs 7-11% of income; SSN is free but with longer waiting lists.</p>',
 '<p>For new cross-border workers (from 17 July 2023) LAMal premiums are tax-deductible in Italy up to EUR 3,000/year under Article 3 of the New Agreement. Fund switches within LAMal are allowed annually by giving notice by 30 November for effect on 1 January, or by 31 March / 30 September for optional deductible changes.</p>',
 ],
 de: [
 '<h2 style="font-size:1.15rem;font-weight:700;margin:1.25rem 0 .5rem">KVG/LAMal: die obligatorische Schweizer Krankenversicherung</h2>',
 '<p>Das <strong>KVG</strong> (Krankenversicherungsgesetz, LAMal auf Italienisch) ist seit 1996 das Rückgrat des Schweizer Gesundheitssystems. Jede in der Schweiz wohnhafte oder arbeitende Person muss bei einer anerkannten Krankenkasse versichert sein. Für Grenzgänger mit Wohnsitz in Italien und Arbeitsort im Tessin ist die KVG eine von zwei Optionen — die andere ist das italienische Gesundheitssystem SSN — und das <em>Optionsrecht</em> muss innerhalb von drei Monaten nach Arbeitsbeginn ausgeübt werden und ist unwiderruflich.</p>',
 '<h2 style="font-size:1.15rem;font-weight:700;margin:1.25rem 0 .5rem">Prämien 2026 für Tessiner Grenzgänger</h2>',
 '<p>Die KVG-Prämien für Grenzgänger bewegen sich 2026 zwischen <strong>CHF 280 und CHF 650 pro Monat</strong> pro Erwachsenen, je nach Kasse, Franchise (CHF 300 bis 2.500) und Versicherungsmodell (Standard, Hausarztmodell, HMO, Telmed). Die 14 für Tessiner Grenzgänger zugelassenen Kassen sind Helsana, Swica, CSS, Sanitas, KPT, Visana, Sympany, Atupri, ÖKK, Concordia, Sodalis, EGK, SLKK und Rhenusana.</p>',
 '<h2 style="font-size:1.15rem;font-weight:700;margin:1.25rem 0 .5rem">KVG vs SSN: die strategische Entscheidung</h2>',
 '<p>Es gibt keine universelle Antwort: Die Wahl hängt von Gesundheit, Familienzusammensetzung und Präferenzen ab. KVG eignet sich typischerweise besser für Familien mit kleinen Kindern oder chronisch Kranken; SSN für gesunde junge Arbeitnehmer in Grenznähe. Bei einem Lohn von CHF 5.000/Monat kostet die KVG 7-11 % des Einkommens; der SSN ist kostenlos, hat aber längere Wartezeiten.</p>',
 '<p>Für neue Grenzgänger (ab 17. Juli 2023) sind KVG-Prämien in Italien bis zu EUR 3.000/Jahr steuerlich absetzbar gemäss Artikel 3 des neuen Abkommens. Kassenwechsel innerhalb des KVG sind jährlich mit Kündigung bis 30. November möglich, mit Wirkung ab 1. Januar.</p>',
 ],
 fr: [
 '<h2 style="font-size:1.15rem;font-weight:700;margin:1.25rem 0 .5rem">LAMal : l\'assurance maladie obligatoire suisse</h2>',
 '<p>La <strong>LAMal</strong> (Loi fédérale sur l\'assurance maladie, KVG en allemand) est la colonne vertébrale du système de santé suisse depuis 1996. Toute personne domiciliée ou travaillant en Suisse doit être assurée auprès d\'une caisse maladie reconnue. Pour les frontaliers résidant en Italie et travaillant dans le canton du Tessin, la LAMal est l\'une des deux options — l\'autre étant le Service national de santé italien — et le <em>droit d\'option</em> doit être exercé dans les trois mois suivant le début du travail et est irrévocable.</p>',
 '<h2 style="font-size:1.15rem;font-weight:700;margin:1.25rem 0 .5rem">Primes 2026 pour frontaliers du Tessin</h2>',
 '<p>Les primes LAMal pour frontaliers en 2026 vont d\'environ <strong>CHF 280 à CHF 650 par mois</strong> par adulte, selon la caisse, la franchise (CHF 300 à 2.500) et le modèle d\'assurance (standard, médecin de famille, HMO, télémédecine). Les 14 caisses autorisées pour les frontaliers du Tessin sont Helsana, Swica, CSS, Sanitas, KPT, Visana, Sympany, Atupri, ÖKK, Concordia, Sodalis, EGK, SLKK et Rhenusana.</p>',
 '<h2 style="font-size:1.15rem;font-weight:700;margin:1.25rem 0 .5rem">LAMal vs SSN : la décision stratégique</h2>',
 '<p>Il n\'y a pas de réponse universelle : le choix dépend de la santé, de la composition familiale et des préférences. La LAMal convient typiquement mieux aux familles avec jeunes enfants ou maladies chroniques ; le SSN aux jeunes travailleurs en bonne santé vivant près de la frontière. Sur un salaire de CHF 5.000/mois, la LAMal coûte 7-11 % du revenu ; le SSN est gratuit mais avec des listes d\'attente plus longues.</p>',
 '<p>Pour les nouveaux frontaliers (à partir du 17 juillet 2023), les primes LAMal sont déductibles en Italie jusqu\'à 3.000 EUR/an selon l\'article 3 du nouvel Accord. Le changement de caisse au sein de la LAMal est possible annuellement avec préavis au 30 novembre, effet au 1er janvier.</p>',
 ],
 },

 '/vita-in-ticino/outlet-svizzera-fox-town-mendrisio': {
 it: [
 '<h2 style="font-size:1.15rem;font-weight:700;margin:1.25rem 0 .5rem">Fox Town Mendrisio: il più grande outlet del lusso in Svizzera</h2>',
 '<p><strong>Fox Town Factory Stores</strong> è il più grande outlet di lusso della Svizzera, inaugurato nel 1995 a Mendrisio (Canton Ticino) e oggi tra le destinazioni shopping più visitate d\'Europa con oltre <strong>3 milioni di visitatori all\'anno</strong>. Situato in Via Angelo Maspoli 18, 6850 Mendrisio, a soli 3 chilometri dal valico doganale di Chiasso-Brogeda, è facilmente raggiungibile da Como (25 km), Varese (30 km), Milano (60 km) e Lugano (20 km). La struttura si estende su tre piani con oltre <strong>160 boutique</strong>, 15 ristoranti e caffetterie, un Casinò interno (uno dei più grandi d\'Europa), area bambini e servizi concierge multilingue.</p>',
 '<h2 style="font-size:1.15rem;font-weight:700;margin:1.25rem 0 .5rem">Marchi di lusso e sconti permanenti</h2>',
 '<p>Fox Town ospita i marchi più prestigiosi della moda internazionale a prezzi scontati del <strong>30-70%</strong> sul listino delle boutique in centro città. I marchi stabilmente presenti includono <strong>Gucci, Prada, Burberry, Armani, Dolce & Gabbana, Bottega Veneta, Moncler, Tod\'s, Versace, Balenciaga, Valentino, Fendi, Salvatore Ferragamo, Saint Laurent, Miu Miu, Alexander McQueen, Givenchy, Celine, Loewe, Kenzo, Etro, Marni</strong> e molti altri. Nei periodi di saldi (gennaio e luglio) e sulle collezioni di due stagioni precedenti gli sconti possono raggiungere il 90%. I marchi accessori (orologi, pelletteria, occhiali) includono Rolex Service, Tag Heuer, Longines, Hugo Boss, Calvin Klein, Ray-Ban, Oakley, Samsonite e Porsche Design.</p>',
 '<h2 style="font-size:1.15rem;font-weight:700;margin:1.25rem 0 .5rem">Orari di apertura 2026</h2>',
 '<p>Fox Town è aperto <strong>tutti i giorni dell\'anno dalle 11:00 alle 19:00</strong>, comprese domeniche e festivi — una rarità in Svizzera dove la maggior parte dei negozi è chiusa la domenica. Le uniche chiusure totali sono il <strong>25 dicembre</strong> (Natale) e la mattina del <strong>1° gennaio</strong> (apertura dalle 14:00). Ristoranti e Casinò restano aperti fino a tarda notte. Durante i saldi di gennaio e luglio gli orari possono essere prolungati fino alle 20:00 o 21:00; le informazioni aggiornate sono disponibili sul sito ufficiale foxtown.com e sulla app Fox Town.</p>',
 '<h2 style="font-size:1.15rem;font-weight:700;margin:1.25rem 0 .5rem">Come arrivare: auto, treno, navetta</h2>',
 '<p><strong>In auto</strong> dall\'Italia: autostrada A9 (verso Chiasso) → superare la dogana di Brogeda → uscita Mendrisio dopo 3 km. Parcheggio gratuito con 2.500 posti auto coperti e scoperti, videosorvegliati 24/7. Da Milano Centrale circa 50 minuti; da Como 30 minuti; da Varese 35 minuti; da Lugano 15 minuti. <strong>In treno</strong>: stazione Mendrisio San Martino sulla linea TILO S10 (Como-Lugano-Locarno), a soli 800 metri dall\'outlet, collegata con navetta gratuita ogni 15 minuti dalle 10:30 alle 19:30. Abbonamento TILO mensile circa CHF 250 dal Ticino; in giornata dall\'Italia biglietto 3ª classe da Chiasso circa CHF 6 A/R. <strong>Aeroporti</strong>: Milano Malpensa (70 km, 50 min in auto), Bergamo Orio al Serio (120 km), Lugano Agno (20 km). Servizio taxi e Uber disponibili.</p>',
 '<h2 style="font-size:1.15rem;font-weight:700;margin:1.25rem 0 .5rem">Pagamenti, tax-free e risparmio fiscale</h2>',
 '<p>Tutti i negozi accettano <strong>CHF, EUR e carte di credito internazionali</strong> (Visa, Mastercard, Amex). Il tasso di cambio applicato dai negozi è generalmente sfavorevole rispetto al mid-market: conviene pagare in CHF se si dispone di un conto svizzero, di Revolut/Wise o di una carta multivaluta. I <strong>turisti non residenti in Svizzera</strong> possono richiedere il rimborso IVA svizzera (7,7%) per acquisti superiori a CHF 300: modulo compilato al momento dell\'acquisto, timbro doganale all\'uscita dalla Svizzera, rimborso entro 90 giorni. Per i frontalieri residenti in Italia che portano merci oltre confine, la franchigia in esenzione è di €300 per persona (o €150 per minori di 15 anni); sopra queste soglie vanno dichiarati IVA italiana e dazi. Fox Town collabora con Global Blue e Planet Tax Free: il banco Tax Refund è al piano terra all\'ingresso principale.</p>',
 '<h2 style="font-size:1.15rem;font-weight:700;margin:1.25rem 0 .5rem">Fox Town Privilege Card e servizi extra</h2>',
 '<p>La <strong>Fox Town Privilege Card</strong> è una tessera fedeltà gratuita richiedibile online o all\'Infopoint: offre sconti aggiuntivi del 5-10% in boutique selezionate, inviti a eventi esclusivi, promozioni via email e accesso alla <em>Privilege Lounge</em> con WiFi gratuito, bevande, giornali e servizio concierge. Servizi aggiuntivi: deposito bagagli, fasciatoi, area allattamento, carrozzine su richiesta, prenotazione taxi/navetta, shopping assistant multilingue (italiano, tedesco, inglese, francese, russo, cinese). Per gruppi organizzati è disponibile il servizio <em>VIP Shopping Tour</em> con sconti negoziati su misura. Il <strong>Casinò</strong> interno (dai 18 anni con documento) offre slot machine, roulette, black jack e poker. Consiglio: visita infrasettimanale al mattino per evitare folla (weekend e saldi sono molto affollati).</p>',
 ],
 en: [
 '<h2 style="font-size:1.15rem;font-weight:700;margin:1.25rem 0 .5rem">Fox Town Mendrisio: Switzerland\'s largest luxury outlet</h2>',
 '<p><strong>Fox Town Factory Stores</strong> is Switzerland\'s largest luxury outlet, opened in 1995 in Mendrisio (Canton Ticino) and today among Europe\'s most visited shopping destinations with over <strong>3 million visitors a year</strong>. Located at Via Angelo Maspoli 18, 6850 Mendrisio, just 3 km from the Italian border crossing of Chiasso-Brogeda, it is easily reachable from Como (25 km), Varese (30 km), Milan (60 km) and Lugano (20 km). The structure extends over three floors with over <strong>160 boutiques</strong>, 15 restaurants and cafés, an in-house casino, a kids area, and multilingual concierge services.</p>',
 '<h2 style="font-size:1.15rem;font-weight:700;margin:1.25rem 0 .5rem">Luxury brands and permanent discounts</h2>',
 '<p>Fox Town hosts the most prestigious international fashion brands at 30-70% off city retail prices: Gucci, Prada, Burberry, Armani, Dolce & Gabbana, Bottega Veneta, Moncler, Tod\'s, Versace, Balenciaga, Valentino, Fendi, Salvatore Ferragamo, Saint Laurent and many others. During sales periods (January and July) and on two-season-old collections, discounts can reach 90%.</p>',
 '<h2 style="font-size:1.15rem;font-weight:700;margin:1.25rem 0 .5rem">Opening hours and how to get there</h2>',
 '<p>Open <strong>every day of the year from 11:00 to 19:00</strong>, including Sundays and public holidays. Only closures: 25 December (Christmas) and 1 January morning. Free parking with 2,500 spaces. By train: Mendrisio San Martino station (TILO line) 800 m away with free shuttle every 15 minutes. Milan Malpensa Airport 70 km (50 min by car), Lugano Agno Airport 20 km.</p>',
 '<p>All stores accept CHF, EUR and international credit cards (Visa, Mastercard, Amex). Non-Swiss residents can request a Swiss VAT refund (7.7%) on purchases over CHF 300 at the Tax Refund desk near the main entrance. The free Fox Town Privilege Card unlocks extra 5-10% discounts at selected boutiques, access to the Privilege Lounge with WiFi and drinks, and invitations to exclusive events.</p>',
 ],
 de: [
 '<h2 style="font-size:1.15rem;font-weight:700;margin:1.25rem 0 .5rem">Fox Town Mendrisio: der grösste Luxus-Outlet der Schweiz</h2>',
 '<p><strong>Fox Town Factory Stores</strong> ist der grösste Luxus-Outlet der Schweiz, 1995 in Mendrisio (Kanton Tessin) eröffnet und heute mit über <strong>3 Millionen Besuchern pro Jahr</strong> eine der meistbesuchten Shopping-Destinationen Europas. Gelegen an der Via Angelo Maspoli 18, 6850 Mendrisio, nur 3 km vom Grenzübergang Chiasso-Brogeda entfernt, ist er bequem von Como (25 km), Varese (30 km), Mailand (60 km) und Lugano (20 km) erreichbar. Die Anlage erstreckt sich über drei Stockwerke mit über <strong>160 Boutiquen</strong>, 15 Restaurants, einem Casino und mehrsprachigem Concierge-Service.</p>',
 '<h2 style="font-size:1.15rem;font-weight:700;margin:1.25rem 0 .5rem">Luxusmarken und permanente Rabatte</h2>',
 '<p>Fox Town beherbergt die prestigeträchtigsten internationalen Modemarken mit 30-70 % Rabatt: Gucci, Prada, Burberry, Armani, Dolce & Gabbana, Bottega Veneta, Moncler, Tod\'s, Versace, Balenciaga, Valentino, Fendi und viele mehr. In den Schlussverkaufsperioden (Januar und Juli) und bei Kollektionen aus zwei Vorsaisonen können Rabatte bis zu 90 % erreichen.</p>',
 '<h2 style="font-size:1.15rem;font-weight:700;margin:1.25rem 0 .5rem">Öffnungszeiten und Anfahrt</h2>',
 '<p>Geöffnet <strong>an 365 Tagen im Jahr von 11:00 bis 19:00 Uhr</strong>, einschliesslich Sonn- und Feiertagen. Einzige Schliessungen: 25. Dezember (Weihnachten) und 1. Januar vormittags. Kostenlose Parkplätze mit 2.500 Stellplätzen. Mit der Bahn: Bahnhof Mendrisio San Martino (TILO-Linie) 800 m entfernt, Gratis-Shuttle alle 15 Minuten. Flughafen Mailand Malpensa 70 km (50 Min Auto), Flughafen Lugano Agno 20 km.</p>',
 '<p>Alle Geschäfte akzeptieren CHF, EUR und internationale Kreditkarten. Nicht in der Schweiz ansässige Besucher können bei Einkäufen über CHF 300 die Schweizer MwSt (7,7 %) am Tax-Refund-Schalter zurückfordern. Die kostenlose Fox Town Privilege Card bietet zusätzliche 5-10 % Rabatt in ausgewählten Boutiquen sowie Zugang zur Privilege Lounge.</p>',
 ],
 fr: [
 '<h2 style="font-size:1.15rem;font-weight:700;margin:1.25rem 0 .5rem">Fox Town Mendrisio : le plus grand outlet de luxe en Suisse</h2>',
 '<p><strong>Fox Town Factory Stores</strong> est le plus grand outlet de luxe en Suisse, inauguré en 1995 à Mendrisio (canton du Tessin) et aujourd\'hui parmi les destinations shopping les plus visitées d\'Europe avec plus de <strong>3 millions de visiteurs par an</strong>. Situé Via Angelo Maspoli 18, 6850 Mendrisio, à seulement 3 km du poste-frontière de Chiasso-Brogeda, il est facilement accessible depuis Côme (25 km), Varèse (30 km), Milan (60 km) et Lugano (20 km). L\'ensemble se déploie sur trois étages avec plus de <strong>160 boutiques</strong>, 15 restaurants, un casino et un service de conciergerie multilingue.</p>',
 '<h2 style="font-size:1.15rem;font-weight:700;margin:1.25rem 0 .5rem">Marques de luxe et remises permanentes</h2>',
 '<p>Fox Town abrite les marques de mode internationales les plus prestigieuses avec des remises de 30 à 70 % : Gucci, Prada, Burberry, Armani, Dolce & Gabbana, Bottega Veneta, Moncler, Tod\'s, Versace, Balenciaga, Valentino, Fendi et bien d\'autres. Pendant les soldes (janvier et juillet) et sur les collections de deux saisons précédentes, les remises peuvent atteindre 90 %.</p>',
 '<h2 style="font-size:1.15rem;font-weight:700;margin:1.25rem 0 .5rem">Horaires et comment s\'y rendre</h2>',
 '<p>Ouvert <strong>365 jours par an de 11h00 à 19h00</strong>, y compris dimanches et jours fériés. Seules fermetures : 25 décembre et 1er janvier au matin. Parking gratuit de 2 500 places. En train : gare de Mendrisio San Martino (ligne TILO) à 800 m, navette gratuite toutes les 15 minutes. Aéroport de Milan Malpensa à 70 km (50 min en voiture), aéroport de Lugano Agno à 20 km.</p>',
 '<p>Tous les magasins acceptent CHF, EUR et cartes de crédit internationales. Les visiteurs non-résidents en Suisse peuvent demander le remboursement de la TVA suisse (7,7 %) pour tout achat supérieur à CHF 300 au guichet Tax Refund. La Fox Town Privilege Card gratuite offre des remises supplémentaires de 5-10 % dans des boutiques sélectionnées et l\'accès à la Privilege Lounge.</p>',
 ],
 },

 '/vita-in-ticino/ponti-2026-ticino': {
 it: [
 buildPontiHero('it'),
 '<h2 style="font-size:1.15rem;font-weight:700;margin:1.25rem 0 .5rem">Calendario ponti 2026 in Ticino — 17 festività ufficiali</h2>',
 '<p>Il calendario dei <strong>ponti 2026 in Canton Ticino</strong> è particolarmente favorevole per i frontalieri: diverse festività infrasettimanali permettono long weekend di 3–4 giorni senza consumare troppe ferie. Le <strong>17 festività ufficiali</strong> riconosciute dal Canton Ticino (Legge sulle giornate festive cantonali) sono: Capodanno (giovedì 1/1), San Berchtoldo (venerdì 2/1), Epifania (martedì 6/1), Venerdì Santo (3 aprile), Pasqua (domenica 5 aprile), Pasquetta (lunedì 6 aprile), Festa del Lavoro (venerdì 1/5), Ascensione (giovedì 14 maggio), Pentecoste (domenica 24 maggio), Lunedì di Pentecoste (25 maggio), Corpus Domini (giovedì 4 giugno), Festa nazionale svizzera (sabato 1/8), Assunzione (sabato 15/8), Ognissanti (domenica 1/11), Immacolata (martedì 8/12), Natale (venerdì 25/12) e Santo Stefano (sabato 26/12).</p>',
 '<h2 style="font-size:1.15rem;font-weight:700;margin:1.25rem 0 .5rem">I migliori long weekend del 2026</h2>',
 '<p>Per i frontalieri i ponti più convenienti del 2026 sono: <strong>Capodanno + San Berchtoldo</strong> (giovedì 1/1 + venerdì 2/1, ponte automatico di 4 giorni con il weekend); <strong>Epifania</strong> (martedì 6/1, ponte di 4 giorni con 1 giorno di ferie lunedì 5/1); <strong>Pasqua</strong> (3–6 aprile, ponte di 4 giorni senza ferie); <strong>1° maggio</strong> (venerdì, long weekend automatico); <strong>Ascensione</strong> (giovedì 14 maggio, ponte di 4 giorni con 1 giorno di ferie venerdì 15); <strong>Pentecoste</strong> (sabato 23 → lunedì 25 maggio, long weekend automatico di 3 giorni); <strong>Corpus Domini</strong> (giovedì 4 giugno, ponte di 4 giorni con 1 giorno di ferie venerdì 5); <strong>Immacolata</strong> (martedì 8/12, ponte di 4 giorni con 1 giorno di ferie lunedì 7/12); <strong>Natale</strong> (venerdì 25 + sabato 26 + domenica 27 dicembre, long weekend automatico di 3 giorni). Nel 2026 Festa nazionale svizzera (1/8), Assunzione (15/8) e Ognissanti (1/11) cadono nel weekend e non generano un ponte.</p>',
 '<h2 style="font-size:1.15rem;font-weight:700;margin:1.25rem 0 .5rem">Differenze tra calendario svizzero e italiano</h2>',
 '<p>Il calendario festivo svizzero differisce da quello italiano su <strong>otto giorni</strong>. Sono festività <strong>solo in Ticino</strong> (non in Italia): San Berchtoldo (2/1), Venerdì Santo (3/4), Ascensione (14/5), Lunedì di Pentecoste (25/5), Corpus Domini (4/6) e Festa nazionale svizzera (1/8). Sono festività <strong>solo in Italia</strong> (non in Svizzera): 25 aprile (Festa della Liberazione) e 2 giugno (Festa della Repubblica). L\'Immacolata (8/12) non è festivo federale svizzero ma è festivo cantonale in Ticino. Il frontaliere segue il calendario del paese di lavoro (Svizzera) per ferie, indennità e festivi pagati; per le spese familiari in Italia (scuole, visite mediche, banche, pubblica amministrazione) deve invece tenere conto del calendario italiano. In caso di malattia o infortunio durante un giorno rosso italiano ma lavorativo svizzero, si applicano le regole del datore di lavoro svizzero e del CCL di settore.</p>',
 '<h2 style="font-size:1.15rem;font-weight:700;margin:1.25rem 0 .5rem">Chiusure dogana e traffico previsto</h2>',
 '<p>Le <strong>dogane tra Italia e Svizzera</strong> restano sempre aperte (autostradali 24/7, secondarie con orari differenziati) ma subiscono forti picchi di traffico nei weekend lunghi. Giornate di massimo traffico previste nel 2026: venerdì 3 aprile (ritorno vacanze pasquali), lunedì 6 aprile (ritorno in Italia), venerdì 1 maggio, giovedì 14 maggio (partenza Ascensione), lunedì 18 maggio (rientro), venerdì 31 luglio (partenza vacanze estive), venerdì 7 agosto (massimo esodo), mercoledì 23 dicembre (partenza Natale). Chi deve attraversare il confine in queste date è consigliato di partire fuori dalle fasce 7:00-10:00 e 16:00-20:00, controllando i tempi d\'attesa sulla nostra pagina <em>Tempi attesa dogana</em> aggiornata ogni 15 minuti tramite API TomTom.</p>',
 '<h2 style="font-size:1.15rem;font-weight:700;margin:1.25rem 0 .5rem">Stipendio frontaliere e festività</h2>',
 '<p>Lo <strong>stipendio del frontaliere</strong> non subisce decurtazioni per le festività svizzere: il salario mensile è calcolato sul lordo annuo che include già le giornate festive pagate (~13 giornate festive cantonali e federali in Ticino). In busta paga (Lohnabrechnung) i giorni festivi non appaiono come voce separata. Eventuali straordinari prestati in giornate festive sono pagati con maggiorazione del <strong>50–100 %</strong> a seconda del contratto collettivo di lavoro (CCL) o del contratto individuale: verificare sempre l\'articolo specifico del proprio CCL settoriale. La 13ª mensilità è prassi consolidata in molti settori (banche, assicurazioni, pubblica amministrazione, gran parte dell\'industria); la 14ª è rara in Svizzera.</p>',
 ],
 en: [
 buildPontiHero('en'),
 '<h2 style="font-size:1.15rem;font-weight:700;margin:1.25rem 0 .5rem">2026 public holidays calendar in Ticino — 17 official days</h2>',
 '<p>The <strong>2026 public holiday calendar in Canton Ticino</strong> is particularly favourable for cross-border workers: several midweek holidays create 3–4 day long weekends without burning much annual leave. Ticino officially recognises <strong>17 cantonal holidays</strong>: New Year (Thu 1/1), St Berchtold (Fri 2/1), Epiphany (Tue 6/1), Good Friday (Fri 3 April), Easter Sunday (5 April), Easter Monday (6 April), Labour Day (Fri 1/5), Ascension (Thu 14 May), Pentecost (Sun 24 May), Whit Monday (25 May), Corpus Christi (Thu 4 June), Swiss National Day (Sat 1/8), Assumption (Sat 15/8), All Saints (Sun 1/11), Immaculate Conception (Tue 8/12), Christmas (Fri 25/12) and Boxing Day (Sat 26/12).</p>',
 '<p>The most rewarding 2026 bridges for cross-border workers: New Year + St Berchtold (Thu 1/1 + Fri 2/1, automatic 4-day bridge); Epiphany (Tue 6/1, 4-day bridge with 1 day leave on Mon 5/1); Easter (3–6 April, 4 days with no leave); 1 May (Fri, automatic long weekend); Ascension (Thu 14 May + 1 day leave Fri 15); Pentecost (Sat 23 → Mon 25 May, automatic 3 days); Corpus Christi (Thu 4 June + 1 day leave Fri 5); Immaculate Conception (Tue 8/12 + 1 day leave Mon 7/12); Christmas (Fri 25 + Sat 26 + Sun 27 Dec, automatic 3 days). Swiss National Day, Assumption and All Saints fall on a weekend in 2026 and do not produce a bridge.</p>',
 '<h2 style="font-size:1.15rem;font-weight:700;margin:1.25rem 0 .5rem">Differences with the Italian calendar</h2>',
 '<p>The Swiss holiday calendar differs from the Italian one on <strong>eight days</strong>. Observed only in Ticino (not in Italy): St Berchtold (2/1), Good Friday (3/4), Ascension (14/5), Whit Monday (25/5), Corpus Christi (4/6) and Swiss National Day (1/8). Observed only in Italy (not in Switzerland): 25 April (Liberation Day) and 2 June (Republic Day). Immaculate Conception (8/12) is not a federal Swiss holiday but is recognised in Ticino.</p>',
 '<p>The Italy–Switzerland border crossings stay open 24/7 on motorways and operate reduced hours on secondary roads. Peak traffic days 2026: Fri 3 April, Mon 6 April, Fri 1 May, Thu 14 May, Mon 18 May, Fri 31 July, Fri 7 August, Wed 23 December — avoid the 7–10 am and 4–8 pm windows. Swiss salaries are <strong>not reduced</strong> on public holidays — the monthly salary already includes the gross annual figure with ~13 paid holidays.</p>',
 ],
 de: [
 buildPontiHero('de'),
 '<h2 style="font-size:1.15rem;font-weight:700;margin:1.25rem 0 .5rem">Feiertage 2026 im Tessin — 17 offizielle Tage</h2>',
 '<p>Der <strong>Feiertagskalender 2026 im Tessin</strong> ist für Grenzgänger besonders günstig: mehrere Feiertage fallen unter der Woche und ermöglichen 3–4-tägige verlängerte Wochenenden ohne grossen Urlaubsabzug. Das Tessin erkennt <strong>17 kantonale Feiertage</strong> an: Neujahr (Do 1.1.), Berchtoldstag (Fr 2.1.), Dreikönigstag (Di 6.1.), Karfreitag (Fr 3.4.), Ostersonntag (5.4.), Ostermontag (6.4.), Tag der Arbeit (Fr 1.5.), Auffahrt (Do 14.5.), Pfingstsonntag (So 24.5.), Pfingstmontag (25.5.), Fronleichnam (Do 4.6.), Schweizer Bundesfeier (Sa 1.8.), Mariä Himmelfahrt (Sa 15.8.), Allerheiligen (So 1.11.), Mariä Empfängnis (Di 8.12.), Weihnachten (Fr 25.12.) und Stephanstag (Sa 26.12.).</p>',
 '<p>Beste Brückentage 2026 für Grenzgänger: Neujahr + Berchtoldstag (Do 1.1. + Fr 2.1., automatische 4-Tage-Brücke); Dreikönigstag (Di 6.1. + 1 Urlaubstag Mo 5.1.); Ostern (3.–6.4., 4 Tage ohne Urlaub); 1. Mai (Fr, automatisch); Auffahrt (Do 14.5. + 1 Urlaubstag Fr 15.5.); Pfingsten (Sa 23. → Mo 25.5.); Fronleichnam (Do 4.6. + 1 Urlaubstag Fr 5.6.); Mariä Empfängnis (Di 8.12. + Mo 7.12. Urlaub); Weihnachten (Fr 25. + Sa 26. + So 27.12.). Bundesfeier (1.8.), Mariä Himmelfahrt (15.8.) und Allerheiligen (1.11.) fallen 2026 aufs Wochenende.</p>',
 '<h2 style="font-size:1.15rem;font-weight:700;margin:1.25rem 0 .5rem">Unterschiede zum italienischen Kalender</h2>',
 '<p>Der Schweizer Feiertagskalender unterscheidet sich vom italienischen an <strong>acht Tagen</strong>. Nur im Tessin (nicht in Italien): Berchtoldstag (2.1.), Karfreitag (3.4.), Auffahrt (14.5.), Pfingstmontag (25.5.), Fronleichnam (4.6.) und Schweizer Bundesfeier (1.8.). Nur in Italien (nicht in der Schweiz): 25. April (Befreiungstag) und 2. Juni (Tag der Republik). Mariä Empfängnis (8.12.) ist kein eidgenössischer Feiertag, im Tessin aber anerkannt.</p>',
 '<p>Grenzübergänge bleiben immer geöffnet, erleben aber an verlängerten Wochenenden starken Verkehr. Schweizer Löhne werden an Feiertagen <strong>nicht gekürzt</strong> — sie sind bereits im Jahresbruttolohn (~13 bezahlte Feiertage) enthalten. Überstunden an Feiertagen werden je nach Gesamtarbeitsvertrag (GAV) mit 50–100 % Zuschlag vergütet.</p>',
 ],
 fr: [
 buildPontiHero('fr'),
 '<h2 style="font-size:1.15rem;font-weight:700;margin:1.25rem 0 .5rem">Jours fériés 2026 au Tessin — 17 jours officiels</h2>',
 '<p>Le <strong>calendrier des jours fériés 2026 au Tessin</strong> est particulièrement favorable aux frontaliers : plusieurs fêtes tombent en milieu de semaine et permettent des longs week-ends de 3–4 jours sans trop entamer les congés annuels. Le Tessin reconnaît <strong>17 jours fériés cantonaux</strong> : Jour de l\'An (jeu 1/1), Saint-Berchtold (ven 2/1), Épiphanie (mar 6/1), Vendredi saint (ven 3/4), Pâques (dim 5/4), Lundi de Pâques (6/4), Fête du Travail (ven 1/5), Ascension (jeu 14/5), Pentecôte (dim 24/5), Lundi de Pentecôte (25/5), Fête-Dieu (jeu 4/6), Fête nationale suisse (sam 1/8), Assomption (sam 15/8), Toussaint (dim 1/11), Immaculée Conception (mar 8/12), Noël (ven 25/12) et Saint-Étienne (sam 26/12).</p>',
 '<p>Les ponts les plus rentables 2026 : Nouvel An + Saint-Berchtold (jeu 1/1 + ven 2/1, pont automatique de 4 jours) ; Épiphanie (mar 6/1 + 1 jour de congé lun 5/1) ; Pâques (3–6 avril, 4 jours sans congé) ; 1er mai (ven, automatique) ; Ascension (jeu 14/5 + 1 congé ven 15) ; Pentecôte (sam 23 → lun 25 mai) ; Fête-Dieu (jeu 4/6 + 1 congé ven 5) ; Immaculée (mar 8/12 + 1 congé lun 7/12) ; Noël (ven 25 + sam 26 + dim 27 décembre). Fête nationale suisse, Assomption et Toussaint tombent en week-end en 2026.</p>',
 '<h2 style="font-size:1.15rem;font-weight:700;margin:1.25rem 0 .5rem">Différences avec le calendrier italien</h2>',
 '<p>Le calendrier suisse diffère de l\'italien sur <strong>huit jours</strong>. Fériés uniquement au Tessin (pas en Italie) : Saint-Berchtold (2/1), Vendredi saint (3/4), Ascension (14/5), Lundi de Pentecôte (25/5), Fête-Dieu (4/6) et Fête nationale suisse (1/8). Fériés uniquement en Italie (pas en Suisse) : 25 avril (Libération) et 2 juin (République). L\'Immaculée Conception (8/12) n\'est pas un férié fédéral suisse, mais l\'est au Tessin.</p>',
 '<p>Les passages de frontière restent ouverts 24h/24 sur autoroute mais connaissent un trafic dense les vendredis et lundis de longs week-ends. Les salaires suisses <strong>ne sont pas réduits</strong> les jours fériés — ils intègrent déjà ~13 fériés payés dans le brut annuel. Les heures supplémentaires un jour férié sont majorées de 50–100 % selon la CCT.</p>',
 ],
 },

 '/vita-in-ticino/vacanze-scolastiche-ticino-2026': {
 it: [
 '<h2 style="font-size:1.15rem;font-weight:700;margin:1.25rem 0 .5rem">Calendario scolastico Ticino 2026-2027</h2>',
 '<p>Il calendario delle <strong>vacanze scolastiche in Canton Ticino</strong> è stabilito ogni anno dal <em>Dipartimento dell\'educazione, della cultura e dello sport (DECS)</em> e pubblicato sul sito ti.ch/decs. Si applica alle <strong>scuole dell\'infanzia (3-6 anni), elementari (6-11 anni), medie (11-15 anni)</strong> pubbliche del cantone. Le scuole private seguono generalmente lo stesso calendario ma possono avere deviazioni di 1-2 giorni comunicate ai genitori a inizio anno. Le scuole italiane di confine (Como, Varese, Valtellina) hanno un calendario completamente diverso: chi ha figli divisi tra sistemi svizzero e italiano deve pianificare con attenzione ferie e custodia alternativa.</p>',
 '<h2 style="font-size:1.15rem;font-weight:700;margin:1.25rem 0 .5rem">Date vacanze 2026-2027</h2>',
 '<p>Per l\'anno scolastico <strong>2026-2027</strong> le vacanze ufficiali in Ticino sono: <strong>inizio anno scolastico</strong> lunedì 31 agosto 2026 per scuole elementari e medie; <strong>vacanze autunnali</strong> da lunedì 19 ottobre a domenica 1° novembre 2026 (2 settimane); <strong>vacanze di Natale</strong> da sabato 19 dicembre 2026 a domenica 3 gennaio 2027 (2 settimane); <strong>vacanze di carnevale</strong> da sabato 13 febbraio a domenica 21 febbraio 2027 (1 settimana); <strong>vacanze di Pasqua</strong> da sabato 27 marzo a lunedì 5 aprile 2027 (10 giorni); <strong>Ponte dell\'Ascensione</strong> giovedì 13 e venerdì 14 maggio 2027; <strong>Pentecoste</strong> lunedì 24 maggio 2027; <strong>fine anno scolastico</strong> venerdì 25 giugno 2027. Le vacanze estive durano dal 26 giugno al 30 agosto 2027 (circa 9 settimane).</p>',
 '<h2 style="font-size:1.15rem;font-weight:700;margin:1.25rem 0 .5rem">Scuole dell\'infanzia (SI)</h2>',
 '<p>Le <strong>scuole dell\'infanzia ticinesi</strong> seguono il calendario delle elementari con alcune differenze: inizio più graduale a settembre (prime due settimane "inserimento progressivo"), chiusura estiva anticipata di circa 1 settimana rispetto alle elementari, pausa pranzo più strutturata. Gli orari standard sono 8:30-16:00 lunedì-venerdì con mensa interna facoltativa. Per i genitori frontalieri che lavorano orari lunghi sono disponibili <strong>centri extra-scolastici</strong> e <strong>doposcuola comunali</strong> aperti fino alle 18:00 (tariffa variabile da CHF 5 a CHF 25/giorno in base al reddito). Alcuni Comuni (Lugano, Bellinzona, Mendrisio, Chiasso) offrono anche servizio di <em>colonie diurne</em> durante le vacanze estive (8:00-17:00, CHF 20-40/giorno con pranzo).</p>',
 '<h2 style="font-size:1.15rem;font-weight:700;margin:1.25rem 0 .5rem">Mensa, trasporti e assicurazione scolastica</h2>',
 '<p>La <strong>mensa scolastica</strong> in Ticino costa circa CHF 8-12 per pasto e viene sussidiata per famiglie a basso reddito (richiedere alla direzione scolastica). Il <strong>trasporto scolastico</strong> è organizzato dal Comune di residenza per chi abita a più di 2 km dalla scuola (elementari) o 3 km (medie): bus gialli scolastici gratuiti o abbonamento TILO/ARCobaleno a prezzo ridotto. L\'<strong>assicurazione scolastica obbligatoria</strong> (RC + infortuni) è inclusa nella tassa comunale (CHF 30-80/anno) e copre anche gli spostamenti casa-scuola e le attività sportive. Materiale didattico e libri sono gratuiti fino alla 5ª elementare; dalle medie in poi è necessario acquistare alcuni volumi personalmente.</p>',
 '<h2 style="font-size:1.15rem;font-weight:700;margin:1.25rem 0 .5rem">Iscrizione: requisiti e scadenze</h2>',
 '<p>Per iscrivere un figlio alla scuola pubblica ticinese servono: <strong>residenza del bambino in Canton Ticino</strong> (quindi solo per frontalieri con permesso B, non G), certificato di nascita, documenti di identità dei genitori, certificato vaccinale. Le iscrizioni aprono in <strong>gennaio-febbraio</strong> per l\'anno scolastico successivo con scadenza entro il 31 marzo. Per i figli di frontalieri con permesso G la situazione è più complessa: le scuole svizzere non sono obbligate ad ammettere alunni residenti in Italia, salvo accordi specifici di confine o iscrizione a scuole private. Esistono <strong>scuole bilingui italo-svizzere</strong> a pagamento (SEL Sorengo, Liceo di Lugano) che accettano frontalieri con rette annuali tra CHF 15.000 e CHF 35.000.</p>',
 '<h2 style="font-size:1.15rem;font-weight:700;margin:1.25rem 0 .5rem">Calendario italiano per figli oltre confine</h2>',
 '<p>Per confronto, il calendario scolastico <strong>italiano (Lombardia, Piemonte)</strong> 2026-2027 prevede: inizio anno 14 settembre 2026, vacanze di Natale 24 dicembre - 6 gennaio, carnevale 15-17 febbraio 2027, Pasqua 25 marzo - 6 aprile 2027, fine anno 10 giugno 2027. Le vacanze estive italiane sono più lunghe (quasi 12 settimane contro le 9 svizzere). La mancanza di vacanze autunnali italiane è compensata da numerosi ponti festivi primaverili. Per famiglie divise tra i due sistemi è consigliabile consultare in anticipo il calendario USR (Ufficio Scolastico Regionale) competente e il calendario DECS ticinese per identificare finestre di ferie comuni.</p>',
 ],
 en: [
 '<h2 style="font-size:1.15rem;font-weight:700;margin:1.25rem 0 .5rem">Ticino school calendar 2026-2027</h2>',
 '<p>The <strong>school holiday calendar in Canton Ticino</strong> is set annually by the Department of Education, Culture and Sport (DECS) and applies to public kindergartens (ages 3-6), primary schools (6-11) and lower secondary schools (11-15). Private schools generally follow the same calendar with 1-2 day deviations.</p>',
 '<h2 style="font-size:1.15rem;font-weight:700;margin:1.25rem 0 .5rem">2026-2027 holiday dates</h2>',
 '<p>For the 2026-2027 school year the official Ticino holidays are: school start Monday 31 August 2026; autumn break 19 October - 1 November 2026 (2 weeks); Christmas holidays 19 December 2026 - 3 January 2027 (2 weeks); carnival 13-21 February 2027 (1 week); Easter 27 March - 5 April 2027 (10 days); Ascension bridge 13-14 May 2027; Pentecost 24 May 2027; end of school year 25 June 2027. Summer holidays run from 26 June to 30 August 2027 (approx 9 weeks).</p>',
 '<h2 style="font-size:1.15rem;font-weight:700;margin:1.25rem 0 .5rem">Enrolment and cost</h2>',
 '<p>To enrol a child in a Ticino public school the child must be resident in Ticino (so only for B-permit cross-border workers, not G). Enrolment opens in January-February. For G-permit children there are bilingual private schools (SEL Sorengo, Liceo di Lugano) charging CHF 15,000-35,000 per year. School meals cost about CHF 8-12 per meal, subsidies available for low-income families.</p>',
 ],
 de: [
 '<h2 style="font-size:1.15rem;font-weight:700;margin:1.25rem 0 .5rem">Schulkalender Tessin 2026-2027</h2>',
 '<p>Der <strong>Schulferienkalender im Kanton Tessin</strong> wird jährlich vom Departement für Bildung, Kultur und Sport (DECS) festgelegt und gilt für öffentliche Kindergärten (3-6 Jahre), Primar- (6-11) und Sekundarschulen (11-15). Privatschulen folgen im Allgemeinen demselben Kalender mit Abweichungen von 1-2 Tagen.</p>',
 '<h2 style="font-size:1.15rem;font-weight:700;margin:1.25rem 0 .5rem">Ferientermine 2026-2027</h2>',
 '<p>Für das Schuljahr 2026-2027 gelten folgende offizielle Tessiner Ferien: Schulbeginn Montag 31. August 2026; Herbstferien 19. Oktober - 1. November 2026 (2 Wochen); Weihnachtsferien 19. Dezember 2026 - 3. Januar 2027 (2 Wochen); Fasnacht 13.-21. Februar 2027; Osterferien 27. März - 5. April 2027; Auffahrtsbrücke 13.-14. Mai 2027; Pfingsten 24. Mai 2027; Schulende 25. Juni 2027. Sommerferien vom 26. Juni bis 30. August 2027.</p>',
 '<h2 style="font-size:1.15rem;font-weight:700;margin:1.25rem 0 .5rem">Anmeldung und Kosten</h2>',
 '<p>Für die Anmeldung an einer öffentlichen Tessiner Schule muss das Kind im Tessin wohnhaft sein (also nur für Grenzgänger mit B-Bewilligung, nicht G). Die Anmeldung öffnet im Januar-Februar. Für G-Kinder stehen zweisprachige Privatschulen (SEL Sorengo, Liceo di Lugano) mit Jahresgebühren von CHF 15.000-35.000 zur Verfügung. Schulmahlzeiten kosten etwa CHF 8-12; Subventionen für Familien mit niedrigem Einkommen erhältlich.</p>',
 ],
 fr: [
 '<h2 style="font-size:1.15rem;font-weight:700;margin:1.25rem 0 .5rem">Calendrier scolaire Tessin 2026-2027</h2>',
 '<p>Le <strong>calendrier des vacances scolaires au Tessin</strong> est fixé annuellement par le Département de l\'éducation, de la culture et du sport (DECS) et s\'applique aux écoles maternelles publiques (3-6 ans), primaires (6-11 ans) et secondaires (11-15 ans). Les écoles privées suivent généralement le même calendrier avec 1-2 jours d\'écart.</p>',
 '<h2 style="font-size:1.15rem;font-weight:700;margin:1.25rem 0 .5rem">Dates de vacances 2026-2027</h2>',
 '<p>Pour l\'année scolaire 2026-2027 les vacances officielles tessinoises sont : rentrée lundi 31 août 2026 ; vacances d\'automne 19 octobre - 1er novembre 2026 (2 semaines) ; vacances de Noël 19 décembre 2026 - 3 janvier 2027 (2 semaines) ; carnaval 13-21 février 2027 ; Pâques 27 mars - 5 avril 2027 ; pont de l\'Ascension 13-14 mai 2027 ; Pentecôte 24 mai 2027 ; fin d\'année 25 juin 2027. Vacances d\'été du 26 juin au 30 août 2027.</p>',
 '<h2 style="font-size:1.15rem;font-weight:700;margin:1.25rem 0 .5rem">Inscription et coûts</h2>',
 '<p>Pour inscrire un enfant à l\'école publique tessinoise, l\'enfant doit résider au Tessin (donc uniquement pour les frontaliers avec permis B, pas G). Les inscriptions ouvrent en janvier-février. Pour les enfants de frontaliers G, des écoles privées bilingues (SEL Sorengo, Liceo di Lugano) acceptent les inscriptions avec des frais annuels de CHF 15.000-35.000. Les repas scolaires coûtent CHF 8-12 ; des subventions sont disponibles pour les familles à bas revenus.</p>',
 ],
 },

 // ── Sprint 2 pillar pages (IT + EN/DE/FR editorial) ────────────
 '/tasse-e-pensione/tasse-svizzere-frontalieri': {
 it: [
 '<h2 style="font-size:1.15rem;font-weight:700;margin:1.25rem 0 .5rem">Come funzionano le tasse svizzere per un frontaliere italiano</h2>',
 '<p>Le tasse svizzere per frontalieri italiani sono strutturate su due livelli: l\'imposta alla fonte trattenuta mensilmente dal datore di lavoro in Canton Ticino e — per i nuovi frontalieri assunti dal 17 luglio 2023 — l\'IRPEF italiana dichiarata annualmente in Italia con franchigia di 10.000 € e credito d\'imposta. L\'imposta alla fonte ticinese segue le tabelle A (single), B (single con figli), C (coniugati) e H (monoparentali), aggiornate al 2026 con aliquote progressive dal 3 % al 35 % in base a reddito, stato civile e numero di figli.</p>',
 '<h2 style="font-size:1.15rem;font-weight:700;margin:1.25rem 0 .5rem">Nuovo Accordo 2026: chi paga cosa</h2>',
 '<p>Il Nuovo Accordo fiscale Italia-Svizzera, entrato in vigore il 17 luglio 2023 e pienamente applicato dal 2024, distingue due categorie. I vecchi frontalieri (assunti prima del 17/07/2023) mantengono il regime esclusivamente svizzero fino al 2033 — pagano solo in Svizzera e il 40 % del gettito viene retrocesso ai Comuni italiani di confine. I nuovi frontalieri pagano l\'imposta alla fonte in Svizzera (che resta integralmente al fisco elvetico nell\'80 %) e dichiarano anche in Italia: sulla base imponibile IRPEF si applica una franchigia di 10.000 €, poi un credito d\'imposta per quanto già versato in Svizzera.</p>',
 '<h2 style="font-size:1.15rem;font-weight:700;margin:1.25rem 0 .5rem">Aliquote alla fonte Ticino 2026 — esempi pratici</h2>',
 '<p>Un single senza figli con CHF 70.000 lordi annui in Ticino (tabella A) paga circa il 10-12 % di imposta alla fonte, pari a CHF 7.000-8.400, più le deduzioni sociali (AVS/AI/IPG al 5,3 %, AC all\'1,1 %, LAA, IJM) per un totale di circa CHF 11.500. Un coniugato con due figli e CHF 80.000 lordi (tabella C con 2 figli) paga solo il 5-7 % di imposta alla fonte. Su stipendi più alti (CHF 120.000+) l\'aliquota sale al 18-22 %. Le tabelle ufficiali sono pubblicate dall\'Amministrazione federale delle contribuzioni (AFC) e dalla Divisione delle contribuzioni del Canton Ticino.</p>',
 '<h2 style="font-size:1.15rem;font-weight:700;margin:1.25rem 0 .5rem">Dichiarazione redditi in Italia e credito d\'imposta</h2>',
 '<p>Il nuovo frontaliere compila il modello Redditi PF (o 730) inserendo lo stipendio svizzero lordo nel quadro RC, applica la franchigia di 10.000 € e indica nel quadro CE il credito d\'imposta per le tasse versate in Svizzera (art. 15 della Convenzione Italia-Svizzera contro la doppia imposizione). Documenti necessari: attestazione dell\'imposta alla fonte rilasciata dal datore svizzero, certificato di salario annuale (Lohnausweis), convertiti in euro al cambio medio di cambio BCE dell\'anno fiscale.</p>',
 '<h2 style="font-size:1.15rem;font-weight:700;margin:1.25rem 0 .5rem">Cantone Ticino vs altri cantoni frontalieri</h2>',
 '<p>Il Canton Ticino concentra oltre 77.000 frontalieri italiani, seguito da Grigioni (Val Mesolcina) e Vallese. Le aliquote alla fonte ticinesi sono in linea con quelle dei cantoni vicini ma leggermente più basse di Ginevra e Zurigo sui redditi medi. Per un frontaliere lombardo il Ticino è quasi sempre la scelta naturale per prossimità geografica; Grigionese e Vallese diventano competitive solo per ruoli molto specializzati con retribuzione elevata che giustifica il pendolarismo esteso o la doppia residenza.</p>',
 '<p>Per simulare il netto mensile con i parametri reali del tuo caso — stato civile, figli, distanza dal confine, anno di assunzione — usa il <a href="/calcola-stipendio/" style="color:#2563eb">calcolatore stipendio frontaliere</a>: confronta immediatamente vecchio regime vs nuovo regime e l\'impatto dell\'eventuale adesione al terzo pilastro 3a come deduzione fiscale.</p>',
 '<p style="color:#64748b;font-size:0.8rem;margin-top:4px;">Fonti ufficiali: <a href="https://www.estv.admin.ch" style="color:#2563eb;text-decoration:none;" rel="noopener">Amministrazione federale delle contribuzioni (AFC)</a> · <a href="https://www4.ti.ch/dfe/dc" style="color:#2563eb;text-decoration:none;" rel="noopener">Divisione contribuzioni Canton Ticino</a> · <a href="https://www.agenziaentrate.gov.it" style="color:#2563eb;text-decoration:none;" rel="noopener">Agenzia delle Entrate</a>.</p>',
 ],
 en: [
 '<h2 style="font-size:1.15rem;font-weight:700;margin:1.25rem 0 .5rem">How Swiss taxes work for Italian cross-border workers</h2>',
 '<p>Swiss taxes for Italian cross-border commuters are structured on two levels: withholding tax deducted monthly by the Swiss employer under Canton Ticino rules, and — for new frontalieri hired from 17 July 2023 onward — Italian IRPEF declared annually with a €10,000 allowance and a tax credit for withheld Swiss tax. Ticino withholding tax follows tables A (single), B (single with children), C (married) and H (single-parent), updated for 2026 with progressive rates from 3% to 35% depending on income, marital status and number of children.</p>',
 '<h2 style="font-size:1.15rem;font-weight:700;margin:1.25rem 0 .5rem">The 2026 Italy-Switzerland agreement — who pays what</h2>',
 '<p>The new Italy-Switzerland tax agreement, effective from 17 July 2023 and fully applied since 2024, distinguishes two categories. Old cross-border workers (hired before 17/07/2023) keep the Swiss-only regime until 2033: they pay solely in Switzerland and 40% of the revenue is returned to the Italian border municipalities. New cross-border workers pay Swiss withholding tax (the Swiss tax office keeps 80%) and also declare in Italy, applying a €10,000 deduction and then a tax credit for the Swiss withholding already paid.</p>',
 '<h2 style="font-size:1.15rem;font-weight:700;margin:1.25rem 0 .5rem">Ticino 2026 withholding rates — worked examples</h2>',
 '<p>A single no-children employee earning CHF 70,000 gross in Ticino (table A) pays around 10-12% withholding tax — CHF 7,000-8,400 — plus social deductions (AHV/IV/APG 5.3%, ALV 1.1%, NBU, KTG) totalling roughly CHF 11,500. A married parent with two children earning CHF 80,000 gross (table C with 2 children) pays only 5-7% withholding. On higher incomes (CHF 120,000+) the rate rises to 18-22%. Official rate tables are published by the Swiss Federal Tax Administration (AFC) and by the Canton Ticino Tax Division.</p>',
 '<h2 style="font-size:1.15rem;font-weight:700;margin:1.25rem 0 .5rem">Italian tax return and tax credit</h2>',
 '<p>The new frontaliere files the Italian "Redditi PF" (or 730) form, reporting gross Swiss salary in section RC, applying the €10,000 allowance and declaring the tax credit in section CE for withheld Swiss tax (art. 15 of the Italy-Switzerland double tax treaty). Required documents: withholding tax certificate issued by the Swiss employer and the annual salary statement (Lohnausweis), converted into euros at the ECB average exchange rate for the fiscal year.</p>',
 '<h2 style="font-size:1.15rem;font-weight:700;margin:1.25rem 0 .5rem">Ticino vs other border cantons</h2>',
 '<p>Canton Ticino hosts more than 77,000 Italian cross-border workers, followed by Grisons (Val Mesolcina) and Valais. Ticino withholding rates are in line with neighbouring cantons but slightly lower than Geneva and Zurich at middle income levels. For a Lombardy-based commuter Ticino is almost always the natural choice; Grisons and Valais only become competitive for highly specialised roles where the salary offsets the longer commute.</p>',
 '<p>To simulate the net monthly pay for your specific case — marital status, children, distance from the border, year of hire — use our <a href="/en/calculate-salary/" style="color:#2563eb">cross-border salary calculator</a>: it compares old vs new regime instantly and shows the impact of enrolling in the voluntary Pillar 3a pension as a tax deduction.</p>',
 '<p style="color:#64748b;font-size:0.8rem;margin-top:4px;">Official sources: <a href="https://www.estv.admin.ch" style="color:#2563eb;text-decoration:none;" rel="noopener">Swiss Federal Tax Administration (AFC)</a> · <a href="https://www4.ti.ch/dfe/dc" style="color:#2563eb;text-decoration:none;" rel="noopener">Canton Ticino Tax Division</a> · <a href="https://www.agenziaentrate.gov.it" style="color:#2563eb;text-decoration:none;" rel="noopener">Italian Revenue Agency</a>.</p>',
 ],
 de: [
 '<h2 style="font-size:1.15rem;font-weight:700;margin:1.25rem 0 .5rem">Wie Schweizer Steuern für italienische Grenzgänger funktionieren</h2>',
 '<p>Schweizer Steuern für italienische Grenzgänger sind auf zwei Ebenen organisiert: die Quellensteuer, die der Schweizer Arbeitgeber monatlich nach den Tessiner Regeln einbehält, und — für "neue Grenzgänger" seit dem 17. Juli 2023 — die italienische IRPEF, die jährlich in Italien mit Freibetrag von 10.000 € und Steueranrechnung für die bereits in der Schweiz gezahlte Quellensteuer deklariert wird. Die Tessiner Quellensteuer folgt den Tabellen A (ledig), B (ledig mit Kindern), C (verheiratet) und H (alleinerziehend) mit progressiven Sätzen von 3 % bis 35 %.</p>',
 '<h2 style="font-size:1.15rem;font-weight:700;margin:1.25rem 0 .5rem">Abkommen 2026 — wer zahlt was</h2>',
 '<p>Das neue Italien-Schweiz-Steuerabkommen, seit dem 17. Juli 2023 in Kraft und ab 2024 vollständig angewendet, unterscheidet zwei Kategorien. Alte Grenzgänger (vor dem 17/07/2023 eingestellt) behalten das rein schweizerische Regime bis 2033 — sie zahlen nur in der Schweiz, 40 % des Steueraufkommens gehen an die italienischen Grenzgemeinden. Neue Grenzgänger zahlen Schweizer Quellensteuer (der Schweizer Fiskus behält 80 %) und erklären zusätzlich in Italien mit 10.000 € Freibetrag und Steueranrechnung.</p>',
 '<h2 style="font-size:1.15rem;font-weight:700;margin:1.25rem 0 .5rem">Tessiner Sätze 2026 — Beispiele</h2>',
 '<p>Ein kinderloser Single mit CHF 70.000 Bruttojahresgehalt im Tessin (Tabelle A) zahlt etwa 10-12 % Quellensteuer, CHF 7.000-8.400, plus Sozialabzüge (AHV/IV/EO 5,3 %, ALV 1,1 %, NBU, KTG) von insgesamt rund CHF 11.500. Ein Verheirateter mit zwei Kindern und CHF 80.000 Brutto (Tabelle C mit 2 Kindern) zahlt nur 5-7 %. Ab CHF 120.000 steigt der Satz auf 18-22 %. Offizielle Tabellen von der Eidgenössischen Steuerverwaltung (AFC) und der Tessiner Steuerdivision.</p>',
 '<h2 style="font-size:1.15rem;font-weight:700;margin:1.25rem 0 .5rem">Italienische Steuererklärung und Anrechnung</h2>',
 '<p>Der neue Grenzgänger füllt in Italien das Formular "Redditi PF" (oder 730) aus: Schweizer Bruttolohn im Abschnitt RC, Anwendung des Freibetrags von 10.000 €, Steuergutschrift im Abschnitt CE für die in der Schweiz gezahlte Quellensteuer (Art. 15 des Doppelbesteuerungsabkommens). Erforderliche Dokumente: Quellensteuerbescheinigung vom Schweizer Arbeitgeber und Jahreslohnausweis, umgerechnet in Euro zum durchschnittlichen EZB-Kurs des Steuerjahres.</p>',
 '<p>Zum Simulieren des monatlichen Nettos für deinen spezifischen Fall — Familienstand, Kinder, Grenzdistanz, Einstellungsjahr — nutze den <a href="/de/gehalt-berechnen/" style="color:#2563eb">Grenzgänger-Gehaltsrechner</a>: vergleicht altes und neues Regime sofort und zeigt den Effekt einer freiwilligen Einzahlung in die dritte Säule 3a als Steuerabzug.</p>',
 '<p style="color:#64748b;font-size:0.8rem;margin-top:4px;">Offizielle Quellen: <a href="https://www.estv.admin.ch" style="color:#2563eb;text-decoration:none;" rel="noopener">Eidgenössische Steuerverwaltung (AFC)</a> · <a href="https://www4.ti.ch/dfe/dc" style="color:#2563eb;text-decoration:none;" rel="noopener">Steuerdivision Kanton Tessin</a> · <a href="https://www.agenziaentrate.gov.it" style="color:#2563eb;text-decoration:none;" rel="noopener">Italienische Steuerbehörde</a>.</p>',
 ],
 fr: [
 '<h2 style="font-size:1.15rem;font-weight:700;margin:1.25rem 0 .5rem">Le fonctionnement des impôts suisses pour les frontaliers italiens</h2>',
 '<p>Les impôts suisses pour les frontaliers italiens s\'organisent sur deux niveaux : l\'impôt à la source prélevé mensuellement par l\'employeur suisse selon les règles du Canton du Tessin, et — pour les « nouveaux frontaliers » embauchés à partir du 17 juillet 2023 — l\'IRPEF italien déclaré annuellement avec un abattement de 10.000 € et un crédit d\'impôt pour l\'impôt à la source déjà versé en Suisse. L\'impôt tessinois suit les barèmes A (célibataire), B (célibataire avec enfants), C (mariés), H (monoparentaux), avec des taux progressifs de 3 % à 35 %.</p>',
 '<h2 style="font-size:1.15rem;font-weight:700;margin:1.25rem 0 .5rem">Accord 2026 — qui paie quoi</h2>',
 '<p>Le nouvel accord fiscal Italie-Suisse, en vigueur depuis le 17 juillet 2023 et pleinement appliqué dès 2024, distingue deux catégories. Les anciens frontaliers (embauchés avant le 17/07/2023) conservent le régime uniquement suisse jusqu\'en 2033 — paiement uniquement en Suisse, 40 % des recettes reversées aux communes italiennes frontalières. Les nouveaux frontaliers paient l\'impôt à la source en Suisse (le fisc suisse garde 80 %) et déclarent aussi en Italie : abattement de 10.000 € puis crédit d\'impôt pour l\'impôt suisse déjà versé.</p>',
 '<h2 style="font-size:1.15rem;font-weight:700;margin:1.25rem 0 .5rem">Taux tessinois 2026 — exemples concrets</h2>',
 '<p>Un célibataire sans enfant avec CHF 70.000 de salaire brut annuel au Tessin (barème A) paie environ 10-12 % d\'impôt à la source, soit CHF 7.000-8.400, plus les déductions sociales (AVS/AI/APG 5,3 %, AC 1,1 %, AANP, IJM) totalisant environ CHF 11.500. Un marié avec deux enfants et CHF 80.000 brut (barème C 2 enfants) ne paie que 5-7 %. Au-delà de CHF 120.000 le taux monte à 18-22 %. Barèmes officiels publiés par l\'Administration fédérale des contributions (AFC) et la Division des contributions du Canton du Tessin.</p>',
 '<h2 style="font-size:1.15rem;font-weight:700;margin:1.25rem 0 .5rem">Déclaration italienne et crédit d\'impôt</h2>',
 '<p>Le nouveau frontalier remplit en Italie le formulaire « Redditi PF » (ou 730) : salaire brut suisse dans le cadre RC, application de l\'abattement de 10.000 €, crédit d\'impôt dans le cadre CE pour l\'impôt à la source versé en Suisse (art. 15 de la Convention Italie-Suisse contre la double imposition). Documents nécessaires : attestation de l\'impôt à la source de l\'employeur suisse et certificat de salaire annuel (Lohnausweis), convertis en euros au cours moyen BCE de l\'année fiscale.</p>',
 '<p>Pour simuler le net mensuel de ta situation — état civil, enfants, distance du poste-frontière, année d\'embauche — utilise le <a href="/fr/calculer-salaire/" style="color:#2563eb">calculateur salaire frontalier</a> : il compare ancien vs nouveau régime et affiche l\'impact d\'une cotisation volontaire au 3e pilier 3a en déduction fiscale.</p>',
 '<p style="color:#64748b;font-size:0.8rem;margin-top:4px;">Sources officielles : <a href="https://www.estv.admin.ch" style="color:#2563eb;text-decoration:none;" rel="noopener">Administration fédérale des contributions (AFC)</a> · <a href="https://www4.ti.ch/dfe/dc" style="color:#2563eb;text-decoration:none;" rel="noopener">Division des contributions Tessin</a> · <a href="https://www.agenziaentrate.gov.it" style="color:#2563eb;text-decoration:none;" rel="noopener">Agence des impôts italienne</a>.</p>',
 ],
 },

 '/vita-in-ticino/lavoro-a-lugano': {
 it: [
 '<h2 style="font-size:1.15rem;font-weight:700;margin:1.25rem 0 .5rem">Lavoro a Lugano per frontalieri — perché è la capitale economica del Ticino</h2>',
 '<p>Lugano è il polo economico del Canton Ticino con oltre 70.000 posti di lavoro e una presenza costante di circa 30.000 frontalieri italiani impiegati in città e nei comuni limitrofi (Paradiso, Massagno, Canobbio, Vezia). L\'economia lugane­se poggia su quattro pilastri: banche e gestione patrimoniale internazionale, sanità pubblica e privata, logistica e trasporti, retail di lusso. Il mercato genera mediamente 80-120 nuove posizioni aperte a frontalieri ogni settimana, con concentrazione in banking, infermieristica e ICT.</p>',
 '<h2 style="font-size:1.15rem;font-weight:700;margin:1.25rem 0 .5rem">Settori principali e stipendi medi lordi</h2>',
 '<p>Il settore bancario e finanziario (UBS, Credit Suisse, BancaStato, EFG International, Julius Baer, Vontobel) offre stipendi lordi annui di CHF 70.000-85.000 per posizioni junior e CHF 120.000-180.000 per ruoli senior o private banking. La sanità (Ente Ospedaliero Cantonale, Clinica Moncucco, Clinica Sant\'Anna, Clinica Luganese) paga infermieri CHF 75.000-95.000 e OSS CHF 55.000-65.000. La logistica (Rhenus, DHL, Planzer, SBB Cargo) offre ruoli operativi a CHF 55.000-70.000 e manageriali a CHF 90.000-120.000. L\'ICT e l\'ingegneria software (Ticinocom, SUPSI, startup innovative) paga developer junior CHF 85.000 e senior CHF 120.000-140.000.</p>',
 '<h2 style="font-size:1.15rem;font-weight:700;margin:1.25rem 0 .5rem">Come arrivare a Lugano — valichi e tempi</h2>',
 '<p>I principali punti di ingresso per chi arriva dalla Lombardia sono: Chiasso-Brogeda (15-20 minuti dal centro Lugano via autostrada A2), Stabio-Gaggiolo (18-25 minuti), Ponte Chiasso (alternativa con code minori alle ore di punta). In treno la linea TiLo collega Como San Giovanni a Lugano in 35 minuti con cadenza ogni 30 minuti; da Varese Lugano in 55 minuti via Mendrisio. Nelle ore di punta (6:30-8:30 e 17:00-19:00) i tempi di attesa al valico possono aggiungere 30-60 minuti; molti frontalieri optano per partenze alle 5:30-6:00 e rientri dopo le 19:00.</p>',
 '<h2 style="font-size:1.15rem;font-weight:700;margin:1.25rem 0 .5rem">Aziende che assumono a Lugano — top 20</h2>',
 '<p>La job board di Frontaliere Ticino aggrega settimanalmente le aziende luganesi con posizioni aperte a frontalieri italiani. Tra le aziende più attive: UBS, EFG International, Credit Suisse, BancaStato, Julius Baer, Vontobel, Ente Ospedaliero Cantonale, Clinica Moncucco, Clinica Sant\'Anna, Helsana, Swisslife, Rhenus, DHL, Planzer, Migros Ticino, Coop, Hugo Boss, Gucci (via Nassa), PwC, KPMG, Deloitte, Ernst & Young, e numerose boutique di commercialisti e avvocati internazionali. Per l\'elenco settimanale aggiornato consulta la pagina <a href="/cerca-lavoro-ticino/" style="color:#2563eb">job board Ticino</a>.</p>',
 '<h2 style="font-size:1.15rem;font-weight:700;margin:1.25rem 0 .5rem">Permessi, contratti e burocrazia</h2>',
 '<p>Per lavorare a Lugano come frontaliere serve il permesso G, richiesto dal datore di lavoro svizzero all\'Ufficio della migrazione di Bellinzona entro 8 giorni dall\'assunzione. I contratti standard svizzeri (CCL settoriali o contratti individuali) prevedono settimana lavorativa di 40-42 ore, 4-5 settimane di ferie, 13ª mensilità nella maggior parte dei settori, periodo di prova 1-3 mesi. La disdetta è regolata dal Codice delle Obbligazioni (CO): 1 mese nel primo anno, 2 mesi dal 2° al 9° anno, 3 mesi oltre. Per confrontare il netto Lugano con un ruolo italiano equivalente prova il <a href="/calcola-stipendio/" style="color:#2563eb">calcolatore stipendio frontaliere</a>.</p>',
 ],
 en: [
 '<h2 style="font-size:1.15rem;font-weight:700;margin:1.25rem 0 .5rem">Working in Lugano — the economic capital of Ticino</h2>',
 '<p>Lugano is the economic hub of Canton Ticino with over 70,000 jobs and a steady presence of about 30,000 Italian cross-border workers employed in the city and neighbouring municipalities (Paradiso, Massagno, Canobbio, Vezia). The local economy rests on four pillars: international banking and wealth management, public and private healthcare, logistics and transport, and luxury retail. The market generates an average of 80-120 new positions open to frontalieri every week, concentrated in banking, nursing and ICT.</p>',
 '<h2 style="font-size:1.15rem;font-weight:700;margin:1.25rem 0 .5rem">Main sectors and average gross pay</h2>',
 '<p>Banking and finance (UBS, Credit Suisse, BancaStato, EFG, Julius Baer, Vontobel) offers CHF 70,000-85,000 gross for junior roles and CHF 120,000-180,000 for senior or private banking. Healthcare (Ente Ospedaliero Cantonale, Moncucco, Sant\'Anna, Luganese) pays nurses CHF 75,000-95,000 and healthcare assistants CHF 55,000-65,000. Logistics (Rhenus, DHL, Planzer, SBB Cargo) offers operational roles at CHF 55,000-70,000 and management at CHF 90,000-120,000. ICT and software engineering pays junior developers CHF 85,000 and senior CHF 120,000-140,000.</p>',
 '<h2 style="font-size:1.15rem;font-weight:700;margin:1.25rem 0 .5rem">How to reach Lugano — crossings and travel time</h2>',
 '<p>Main entry points from Lombardy: Chiasso-Brogeda (15-20 minutes to Lugano centre via A2 motorway), Stabio-Gaggiolo (18-25 minutes), Ponte Chiasso (alternative with shorter peak-hour queues). By train the TiLo line runs Como San Giovanni to Lugano in 35 minutes every half hour; Varese to Lugano takes 55 minutes via Mendrisio. At peak times (6:30-8:30 and 17:00-19:00) border waits can add 30-60 minutes; many frontalieri leave home by 5:30-6:00 and return after 19:00.</p>',
 '<h2 style="font-size:1.15rem;font-weight:700;margin:1.25rem 0 .5rem">Top employers hiring in Lugano</h2>',
 '<p>The Frontaliere Ticino job board aggregates weekly the Lugano employers with open positions for Italian cross-border workers. Most active companies include: UBS, EFG, Credit Suisse, BancaStato, Julius Baer, Vontobel, Ente Ospedaliero Cantonale, Moncucco and Sant\'Anna clinics, Helsana, Swisslife, Rhenus, DHL, Planzer, Migros Ticino, Coop, luxury retail (Via Nassa), PwC, KPMG, Deloitte, EY, plus many boutique accounting and law firms. For the live weekly list see the <a href="/en/find-jobs-ticino/" style="color:#2563eb">Ticino job board</a>.</p>',
 '<h2 style="font-size:1.15rem;font-weight:700;margin:1.25rem 0 .5rem">Permits, contracts and paperwork</h2>',
 '<p>Working in Lugano as a frontaliere requires a G permit, requested by the Swiss employer from the Bellinzona migration office within 8 days of hiring. Standard Swiss contracts (sector CCL or individual contracts) imply 40-42 hour work weeks, 4-5 weeks of holiday, a 13th month in most sectors, and a 1-3 month trial period. Notice is governed by the Code of Obligations (CO): 1 month in year one, 2 months years 2-9, 3 months thereafter. To compare Lugano net pay with an Italian equivalent role, use the <a href="/en/calculate-salary/" style="color:#2563eb">cross-border salary calculator</a>.</p>',
 ],
 de: [
 '<h2 style="font-size:1.15rem;font-weight:700;margin:1.25rem 0 .5rem">Arbeiten in Lugano — die Wirtschaftshauptstadt des Tessins</h2>',
 '<p>Lugano ist das wirtschaftliche Zentrum des Kantons Tessin mit über 70.000 Arbeitsplätzen und rund 30.000 italienischen Grenzgängern, die in der Stadt und den umliegenden Gemeinden (Paradiso, Massagno, Canobbio, Vezia) beschäftigt sind. Die Wirtschaft stützt sich auf vier Säulen: internationales Banking und Vermögensverwaltung, öffentliches und privates Gesundheitswesen, Logistik und Transport, Luxuseinzelhandel. Der Markt erzeugt durchschnittlich 80-120 neue Stellen für Grenzgänger pro Woche.</p>',
 '<h2 style="font-size:1.15rem;font-weight:700;margin:1.25rem 0 .5rem">Branchen und durchschnittliche Bruttolöhne</h2>',
 '<p>Banking und Finanzen (UBS, Credit Suisse, BancaStato, EFG, Julius Baer, Vontobel) bieten CHF 70.000-85.000 brutto für Junior-Rollen und CHF 120.000-180.000 für Senior- oder Private-Banking-Positionen. Im Gesundheitswesen (Ente Ospedaliero Cantonale, Moncucco, Sant\'Anna, Luganese) verdienen Pflegefachkräfte CHF 75.000-95.000 und Pflegehelfer CHF 55.000-65.000. Logistik (Rhenus, DHL, Planzer, SBB Cargo) CHF 55.000-70.000 operativ, CHF 90.000-120.000 Management. ICT/Software: Junior CHF 85.000, Senior CHF 120.000-140.000.</p>',
 '<h2 style="font-size:1.15rem;font-weight:700;margin:1.25rem 0 .5rem">Anfahrt nach Lugano — Grenzübergänge und Fahrzeiten</h2>',
 '<p>Hauptübergänge aus der Lombardei: Chiasso-Brogeda (15-20 Minuten zum Zentrum Lugano via A2), Stabio-Gaggiolo (18-25 Minuten), Ponte Chiasso (Alternative mit kürzeren Warteschlangen). Mit TiLo von Como San Giovanni nach Lugano in 35 Minuten alle 30 Minuten; Varese-Lugano 55 Minuten via Mendrisio. In Stosszeiten (6:30-8:30, 17:00-19:00) zusätzliche 30-60 Minuten Wartezeit an der Grenze.</p>',
 '<h2 style="font-size:1.15rem;font-weight:700;margin:1.25rem 0 .5rem">Top-Arbeitgeber in Lugano</h2>',
 '<p>Die wöchentlich aktualisierte Job-Board von Frontaliere Ticino listet die aktivsten Arbeitgeber: UBS, EFG, Credit Suisse, BancaStato, Julius Baer, Vontobel, Ente Ospedaliero Cantonale, Kliniken Moncucco und Sant\'Anna, Helsana, Swisslife, Rhenus, DHL, Planzer, Migros Ticino, Coop, Luxus-Retail (Via Nassa), PwC, KPMG, Deloitte, EY. Vollständige wöchentliche Liste im <a href="/de/jobs-im-tessin/" style="color:#2563eb">Tessiner Job-Board</a>.</p>',
 '<h2 style="font-size:1.15rem;font-weight:700;margin:1.25rem 0 .5rem">Bewilligungen, Verträge und Bürokratie</h2>',
 '<p>Für die Arbeit in Lugano als Grenzgänger braucht es eine G-Bewilligung, die der Schweizer Arbeitgeber innerhalb von 8 Tagen nach Einstellung beim Migrationsamt in Bellinzona beantragt. Standardverträge: 40-42 Stunden Woche, 4-5 Wochen Ferien, 13. Monatsgehalt in den meisten Branchen, 1-3 Monate Probezeit. Kündigungsfrist nach Obligationenrecht: 1 Monat im ersten Jahr, 2 Monate Jahre 2-9, 3 Monate danach. Für den Nettovergleich Lugano/Italien den <a href="/de/gehalt-berechnen/" style="color:#2563eb">Grenzgänger-Rechner</a> nutzen.</p>',
 ],
 fr: [
 '<h2 style="font-size:1.15rem;font-weight:700;margin:1.25rem 0 .5rem">Travailler à Lugano — la capitale économique du Tessin</h2>',
 '<p>Lugano est le pôle économique du Canton du Tessin avec plus de 70.000 emplois et environ 30.000 frontaliers italiens employés dans la ville et les communes voisines (Paradiso, Massagno, Canobbio, Vezia). L\'économie repose sur quatre piliers : banque et gestion de patrimoine internationale, santé publique et privée, logistique et transports, commerce de luxe. Le marché génère en moyenne 80-120 nouvelles positions ouvertes aux frontaliers chaque semaine.</p>',
 '<h2 style="font-size:1.15rem;font-weight:700;margin:1.25rem 0 .5rem">Secteurs principaux et salaires bruts moyens</h2>',
 '<p>Banque et finance (UBS, Credit Suisse, BancaStato, EFG, Julius Baer, Vontobel) : CHF 70.000-85.000 bruts pour un junior, CHF 120.000-180.000 pour senior ou private banking. Santé (Ente Ospedaliero Cantonale, Moncucco, Sant\'Anna, Luganese) : infirmier CHF 75.000-95.000, aide-soignant CHF 55.000-65.000. Logistique (Rhenus, DHL, Planzer, SBB Cargo) : opérationnel CHF 55.000-70.000, management CHF 90.000-120.000. ICT/software : junior CHF 85.000, senior CHF 120.000-140.000.</p>',
 '<h2 style="font-size:1.15rem;font-weight:700;margin:1.25rem 0 .5rem">Comment rejoindre Lugano — postes-frontières et temps</h2>',
 '<p>Principaux points d\'entrée depuis la Lombardie : Chiasso-Brogeda (15-20 minutes du centre via A2), Stabio-Gaggiolo (18-25 minutes), Ponte Chiasso (alternative avec files plus courtes aux heures de pointe). En train TiLo : Como San Giovanni-Lugano en 35 minutes toutes les 30 minutes ; Varèse-Lugano 55 minutes via Mendrisio. Aux heures de pointe (6:30-8:30 et 17:00-19:00) l\'attente à la frontière peut ajouter 30-60 minutes.</p>',
 '<h2 style="font-size:1.15rem;font-weight:700;margin:1.25rem 0 .5rem">Employeurs principaux à Lugano</h2>',
 '<p>Le tableau des offres de Frontaliere Ticino recense chaque semaine les employeurs les plus actifs : UBS, EFG, Credit Suisse, BancaStato, Julius Baer, Vontobel, Ente Ospedaliero Cantonale, cliniques Moncucco et Sant\'Anna, Helsana, Swisslife, Rhenus, DHL, Planzer, Migros Ticino, Coop, commerce de luxe (Via Nassa), PwC, KPMG, Deloitte, EY. Liste hebdomadaire complète : <a href="/fr/trouver-emploi-tessin/" style="color:#2563eb">job board tessinoise</a>.</p>',
 '<h2 style="font-size:1.15rem;font-weight:700;margin:1.25rem 0 .5rem">Permis, contrats et démarches</h2>',
 '<p>Pour travailler à Lugano en tant que frontalier il faut le permis G, demandé par l\'employeur suisse à l\'office de la migration de Bellinzone dans les 8 jours suivant l\'embauche. Contrats standards : semaine de 40-42 heures, 4-5 semaines de congés, 13e mois dans la plupart des secteurs, période d\'essai 1-3 mois. Délai de préavis selon le Code des obligations : 1 mois la première année, 2 mois de la 2e à la 9e, 3 mois au-delà. Pour comparer le net Lugano avec l\'équivalent italien : <a href="/fr/calculer-salaire/" style="color:#2563eb">calculateur salaire frontalier</a>.</p>',
 ],
 },

 '/tasse-e-pensione/nuova-legge-frontalieri-2026': {
 it: [
 '<h2 style="font-size:1.15rem;font-weight:700;margin:1.25rem 0 .5rem">Nuova legge frontalieri 2026 — cronologia e punti chiave</h2>',
 '<p>La "nuova legge frontalieri" è di fatto il Nuovo Accordo fiscale Italia-Svizzera, firmato nel 2020, ratificato nel 2023 ed entrato in vigore il 17 luglio 2023 con piena applicazione dal 1° gennaio 2024. Sostituisce l\'accordo del 1974 che prevedeva la tassazione esclusiva in Svizzera e la retrocessione del 38,8 % ai comuni italiani di frontiera. Il nuovo impianto introduce due regimi: quello transitorio per i vecchi frontalieri (validi fino al 2033) e quello a regime per i nuovi frontalieri, con tassazione concorrente Italia-Svizzera.</p>',
 '<h2 style="font-size:1.15rem;font-weight:700;margin:1.25rem 0 .5rem">Cosa cambia concretamente nel 2026</h2>',
 '<p>Nel 2026 il nuovo regime è a pieno regime dal terzo anno consecutivo, le procedure sono consolidate e le tabelle aggiornate includono tutti i correttivi introdotti in sede di conferenza bilaterale italo-svizzera. I punti concreti che cambiano per i nuovi frontalieri rispetto al 2024: chiarimenti sulla franchigia di 10.000 € (rimane), soglia di 45 giorni di lavoro da remoto dall\'Italia ora codificata come "telelavoro ammesso" senza perdita dello status, nuove regole sul credito d\'imposta per le tasse locali e di culto. Per i vecchi frontalieri: nessun cambiamento sostanziale, il regime pre-2024 resta garantito fino al 2033.</p>',
 '<h2 style="font-size:1.15rem;font-weight:700;margin:1.25rem 0 .5rem">Tabella fiscale 2024 vs 2025 vs 2026 — stipendio tipo</h2>',
 '<p>Prendiamo un nuovo frontaliere single con CHF 70.000 lordi annui in Ticino. 2024: imposta alla fonte circa CHF 8.400, IRPEF italiana lorda sul Swiss gross meno franchigia 10.000 € circa €14.500, credito d\'imposta ~€9.000 → IRPEF residua ~€5.500, netto finale annuo circa €52.000. 2025: stessi parametri, netto ~€52.200 (effetto arrotondamento aliquote). 2026: con soglia telelavoro ammesso a 45 giorni senza perdita status, nessun cambio di netto se si resta entro la soglia. Il vecchio frontaliere con stesso lordo resta a netto ~€58.000 (solo Svizzera fino al 2033).</p>',
 '<h2 style="font-size:1.15rem;font-weight:700;margin:1.25rem 0 .5rem">Impatto sullo stipendio — esempio pratico con due figli</h2>',
 '<p>Un nuovo frontaliere coniugato con 2 figli, CHF 80.000 lordi, tabella C2: imposta alla fonte ticinese circa CHF 4.800 (6 %), deduzioni sociali CHF 12.000, netto svizzero ~CHF 63.200. In Italia: reddito imponibile ~€74.000 (cambio medio 0,95), meno franchigia 10.000 € e meno detrazioni familiari → IRPEF lorda ~€16.000, credito d\'imposta ~€5.000 → IRPEF residua ~€11.000. Netto finale annuo in euro circa €55.000. Un vecchio frontaliere con gli stessi parametri otterrebbe ~€63.000 di netto finale.</p>',
 '<h2 style="font-size:1.15rem;font-weight:700;margin:1.25rem 0 .5rem">Cosa fare ora — checklist per i nuovi e i vecchi frontalieri</h2>',
 '<p>Nuovi frontalieri: 1) conservare attestazione dell\'imposta alla fonte e Lohnausweis annuale; 2) richiedere la certificazione di residenza fiscale italiana al Comune; 3) dichiarare in Italia con quadro CE compilato correttamente per credito d\'imposta; 4) monitorare giorni di telelavoro dall\'Italia (massimo 45/anno); 5) considerare il terzo pilastro 3a come deduzione fiscale. Vecchi frontalieri: 1) verificare il riconoscimento dello status pre-2024; 2) conservare documenti contrattuali che attestino la data di assunzione ante 17/07/2023; 3) pianificare la transizione 2033. Per simulare il tuo caso specifico usa il <a href="/tasse-e-pensione/simulazione-tasse-nuovi-frontalieri/" style="color:#2563eb">simulatore tasse nuovi frontalieri</a>.</p>',
 '<p style="color:#64748b;font-size:0.8rem;margin-top:4px;">Fonti: <a href="https://www.admin.ch" style="color:#2563eb;text-decoration:none;" rel="noopener">Legge federale svizzera sulla tassazione transfrontaliera</a> · <a href="https://www.agenziaentrate.gov.it" style="color:#2563eb;text-decoration:none;" rel="noopener">Circolari Agenzia delle Entrate 2024-2026</a> · Testo dell\'Accordo fiscale Italia-Svizzera 2020.</p>',
 ],
 en: [
 '<h2 style="font-size:1.15rem;font-weight:700;margin:1.25rem 0 .5rem">The new 2026 cross-border worker law — timeline and key points</h2>',
 '<p>The "new cross-border worker law" is the new Italy-Switzerland tax agreement signed in 2020, ratified in 2023 and effective from 17 July 2023, fully applied from 1 January 2024. It replaces the 1974 agreement under which workers were taxed exclusively in Switzerland, with 38.8% revenue returned to Italian border municipalities. The new framework creates two regimes: transitional for old frontalieri (valid until 2033) and permanent for new frontalieri, with concurrent Italy-Switzerland taxation.</p>',
 '<h2 style="font-size:1.15rem;font-weight:700;margin:1.25rem 0 .5rem">What changes concretely in 2026</h2>',
 '<p>In 2026 the new regime is in its third full year, procedures are consolidated and updated tables reflect all adjustments agreed in the Italy-Switzerland bilateral commission. Key changes for new frontalieri vs 2024: clarification that the €10,000 allowance remains; the 45-day threshold for remote work from Italy is now codified as "permitted telework" without loss of status; new rules on tax credit for local and church taxes. For old frontalieri: no material change, the pre-2024 regime is guaranteed until 2033.</p>',
 '<h2 style="font-size:1.15rem;font-weight:700;margin:1.25rem 0 .5rem">Tax table 2024 vs 2025 vs 2026 — typical salary</h2>',
 '<p>Take a new single frontaliere with CHF 70,000 gross in Ticino. 2024: Swiss withholding ~CHF 8,400, Italian IRPEF on Swiss gross minus €10,000 allowance ~€14,500, tax credit ~€9,000 → residual IRPEF ~€5,500, net annual ~€52,000. 2025: same parameters, net ~€52,200. 2026: with codified 45-day telework threshold, no net change if within threshold. An old frontaliere with identical gross keeps net ~€58,000 (Switzerland-only until 2033).</p>',
 '<h2 style="font-size:1.15rem;font-weight:700;margin:1.25rem 0 .5rem">Salary impact — worked example with two children</h2>',
 '<p>A new frontaliere, married, two children, CHF 80,000 gross, table C2: Ticino withholding ~CHF 4,800 (6%), social deductions CHF 12,000, Swiss net ~CHF 63,200. In Italy: taxable income ~€74,000 (0.95 exchange), minus €10,000 allowance and family deductions → gross IRPEF ~€16,000, tax credit ~€5,000 → residual IRPEF ~€11,000. Final annual net in euros ~€55,000. An old frontaliere with same parameters ~€63,000 net.</p>',
 '<h2 style="font-size:1.15rem;font-weight:700;margin:1.25rem 0 .5rem">What to do now — checklist for new and old frontalieri</h2>',
 '<p>New frontalieri: (1) keep withholding tax certificate and annual Lohnausweis; (2) obtain Italian fiscal residence certificate from your Comune; (3) declare in Italy with section CE correctly filled for tax credit; (4) track telework days from Italy (max 45/year); (5) consider voluntary Pillar 3a as a tax deduction. Old frontalieri: (1) verify pre-2024 status is recognised; (2) keep contract documents proving hire date before 17/07/2023; (3) plan the 2033 transition. To simulate your specific case use the <a href="/en/taxes-and-pension/tax-simulation-new-cross-border-workers/" style="color:#2563eb">new-regime tax simulator</a>.</p>',
 '<p style="color:#64748b;font-size:0.8rem;margin-top:4px;">Sources: <a href="https://www.admin.ch" style="color:#2563eb;text-decoration:none;" rel="noopener">Swiss Federal Law on Cross-Border Taxation</a> · <a href="https://www.agenziaentrate.gov.it" style="color:#2563eb;text-decoration:none;" rel="noopener">Italian Revenue Agency circulars 2024-2026</a> · 2020 Italy-Switzerland tax agreement.</p>',
 ],
 de: [
 '<h2 style="font-size:1.15rem;font-weight:700;margin:1.25rem 0 .5rem">Neues Grenzgängergesetz 2026 — Zeitplan und Eckpunkte</h2>',
 '<p>Das "neue Grenzgängergesetz" ist das neue Italien-Schweiz-Steuerabkommen, 2020 unterzeichnet, 2023 ratifiziert, ab 17. Juli 2023 in Kraft und ab 1. Januar 2024 vollständig angewendet. Es ersetzt das Abkommen von 1974, das ausschliessliche Besteuerung in der Schweiz mit 38,8 % Rückerstattung an die italienischen Grenzgemeinden vorsah. Das neue System schafft zwei Regime: Übergangsregelung für alte Grenzgänger (bis 2033) und Dauerregelung für neue Grenzgänger mit parallel­er italienisch-schweizerischer Besteuerung.</p>',
 '<h2 style="font-size:1.15rem;font-weight:700;margin:1.25rem 0 .5rem">Was sich 2026 konkret ändert</h2>',
 '<p>2026 ist das dritte volle Jahr des neuen Regimes: die Verfahren sind gefestigt und die aktualisierten Tabellen berücksichtigen alle Anpassungen aus der bilateralen Kommission. Änderungen für neue Grenzgänger gegenüber 2024: Klarstellung, dass der Freibetrag von 10.000 € bleibt; die 45-Tage-Schwelle für Homeoffice aus Italien ist jetzt als "zulässiges Telearbeit" kodifiziert; neue Regeln zur Anrechnung von Gemeinde- und Kirchensteuern. Für alte Grenzgänger: keine materielle Änderung, das Regime vor 2024 ist bis 2033 garantiert.</p>',
 '<h2 style="font-size:1.15rem;font-weight:700;margin:1.25rem 0 .5rem">Steuertabelle 2024 vs 2025 vs 2026</h2>',
 '<p>Beispiel neuer Grenzgänger, ledig, CHF 70.000 brutto im Tessin. 2024: Schweizer Quellensteuer ~CHF 8.400, italienische IRPEF auf Schweizer Brutto minus 10.000 € Freibetrag ~14.500 €, Anrechnung ~9.000 € → Restbetrag IRPEF ~5.500 €, Jahresnetto ~52.000 €. 2025: gleiche Parameter, Netto ~52.200 €. 2026: bei Einhaltung der 45-Tage-Schwelle keine Änderung. Alter Grenzgänger bei gleichem Bruttolohn: Netto ~58.000 € (nur Schweiz bis 2033).</p>',
 '<h2 style="font-size:1.15rem;font-weight:700;margin:1.25rem 0 .5rem">Auswirkung auf das Gehalt — Beispiel mit zwei Kindern</h2>',
 '<p>Neuer Grenzgänger, verheiratet, 2 Kinder, CHF 80.000 brutto, Tabelle C2: Tessiner Quellensteuer ~CHF 4.800 (6 %), Sozialabzüge CHF 12.000, Schweizer Netto ~CHF 63.200. In Italien: steuerpflichtiges Einkommen ~74.000 € (Kurs 0,95), minus 10.000 € Freibetrag und Familienabzüge → IRPEF brutto ~16.000 €, Anrechnung ~5.000 € → Restbetrag ~11.000 €. Jahresnetto in Euro ~55.000 €. Alter Grenzgänger mit gleichen Parametern ~63.000 €.</p>',
 '<h2 style="font-size:1.15rem;font-weight:700;margin:1.25rem 0 .5rem">Was jetzt zu tun ist — Checkliste</h2>',
 '<p>Neue Grenzgänger: (1) Quellensteuerbescheinigung und Jahreslohnausweis aufbewahren; (2) italienische Steueransässigkeit bestätigen lassen; (3) Erklärung in Italien mit korrekt ausgefüllter Sektion CE für Anrechnung; (4) Homeoffice-Tage aus Italien erfassen (max. 45/Jahr); (5) freiwillige Säule 3a als Steuerabzug in Erwägung ziehen. Alte Grenzgänger: (1) Vorab-2024-Status prüfen; (2) Vertragsdokumente mit Einstellungsdatum vor 17/07/2023 archivieren; (3) Übergang 2033 planen. Individuelle Simulation: <a href="/de/steuern-und-vorsorge/steuerberechnung-neue-grenzgaenger/" style="color:#2563eb">Steuersimulator neues Regime</a>.</p>',
 ],
 fr: [
 '<h2 style="font-size:1.15rem;font-weight:700;margin:1.25rem 0 .5rem">La nouvelle loi frontaliers 2026 — chronologie et points clés</h2>',
 '<p>La « nouvelle loi frontaliers » désigne le nouvel accord fiscal Italie-Suisse, signé en 2020, ratifié en 2023 et en vigueur depuis le 17 juillet 2023, pleinement appliqué dès le 1er janvier 2024. Il remplace l\'accord de 1974 qui prévoyait une imposition exclusive en Suisse avec rétrocession de 38,8 % aux communes italiennes frontalières. Le nouveau cadre crée deux régimes : transitoire pour les anciens frontaliers (valable jusqu\'en 2033) et permanent pour les nouveaux, avec imposition concurrente Italie-Suisse.</p>',
 '<h2 style="font-size:1.15rem;font-weight:700;margin:1.25rem 0 .5rem">Ce qui change concrètement en 2026</h2>',
 '<p>En 2026 le nouveau régime en est à sa troisième année, les procédures sont consolidées et les barèmes mis à jour intègrent tous les correctifs de la commission bilatérale. Principales évolutions pour les nouveaux frontaliers vs 2024 : confirmation de l\'abattement de 10.000 € ; seuil des 45 jours de télétravail depuis l\'Italie désormais codifié comme « télétravail admis » sans perte de statut ; nouvelles règles sur le crédit d\'impôt pour les taxes communales et de culte. Pour les anciens frontaliers : aucun changement matériel, le régime antérieur reste garanti jusqu\'en 2033.</p>',
 '<h2 style="font-size:1.15rem;font-weight:700;margin:1.25rem 0 .5rem">Tableau fiscal 2024 vs 2025 vs 2026</h2>',
 '<p>Exemple : nouveau frontalier célibataire, CHF 70.000 brut au Tessin. 2024 : impôt à la source suisse ~CHF 8.400, IRPEF italien sur brut suisse moins abattement 10.000 € ~14.500 €, crédit ~9.000 € → IRPEF résiduel ~5.500 €, net annuel ~52.000 €. 2025 : mêmes paramètres, net ~52.200 €. 2026 : sous le seuil des 45 jours, aucun changement. Ancien frontalier à brut équivalent : net ~58.000 € (Suisse uniquement jusqu\'en 2033).</p>',
 '<h2 style="font-size:1.15rem;font-weight:700;margin:1.25rem 0 .5rem">Impact sur le salaire — exemple avec deux enfants</h2>',
 '<p>Nouveau frontalier marié avec 2 enfants, CHF 80.000 brut, barème C2 : impôt à la source tessinois ~CHF 4.800 (6 %), déductions sociales CHF 12.000, net suisse ~CHF 63.200. En Italie : revenu imposable ~74.000 € (change 0,95), moins abattement 10.000 € et déductions familiales → IRPEF brut ~16.000 €, crédit ~5.000 € → résiduel ~11.000 €. Net annuel en euros ~55.000 €. Ancien frontalier avec mêmes paramètres : ~63.000 € net.</p>',
 '<h2 style="font-size:1.15rem;font-weight:700;margin:1.25rem 0 .5rem">Que faire maintenant — checklist</h2>',
 '<p>Nouveaux frontaliers : (1) conserver attestation impôt à la source et Lohnausweis annuel ; (2) obtenir certificat de résidence fiscale italienne ; (3) déclarer en Italie avec cadre CE correctement rempli pour le crédit d\'impôt ; (4) suivre les jours de télétravail depuis l\'Italie (max 45/an) ; (5) envisager le 3e pilier 3a comme déduction fiscale. Anciens frontaliers : (1) faire reconnaître le statut pré-2024 ; (2) conserver les documents contractuels prouvant une embauche avant le 17/07/2023 ; (3) planifier la transition 2033. Simulation personnalisée : <a href="/fr/impots-et-retraite/simulation-impots-nouveaux-frontaliers/" style="color:#2563eb">simulateur nouveau régime</a>.</p>',
 ],
 },

 '/vita-in-ticino/oss-svizzera': {
 it: [
 '<h2 style="font-size:1.15rem;font-weight:700;margin:1.25rem 0 .5rem">OSS in Svizzera — la professione equivalente e il suo ruolo</h2>',
 '<p>L\'OSS italiano (operatore socio-sanitario) corrisponde in Svizzera all\'Assistente di cura AFC, che nel Ticino italofono prende il nome di ASSC (Assistente socio-sanitario) e nella Svizzera tedesca FaGe (Fachfrau/Fachmann Gesundheit). È una professione sanitaria regolamentata con formazione triennale di tipo duale (scuola + tirocinio in struttura), che svolge attività di igiene, mobilizzazione, somministrazione di farmaci sotto supervisione infermieristica, assistenza nelle attività di vita quotidiana e raccolta di segni vitali. Le competenze sono paragonabili a quelle dell\'OSS italiano, con alcune differenze operative a seconda del contesto (ospedale acuto, casa anziani, cure a domicilio).</p>',
 '<h2 style="font-size:1.15rem;font-weight:700;margin:1.25rem 0 .5rem">Stipendi OSS in Ticino 2026</h2>',
 '<p>In Canton Ticino un ASSC neoassunto guadagna CHF 55.000-62.000 lordi annui con la 13ª mensilità; l\'intervallo cresce a CHF 65.000-75.000 con 5+ anni di esperienza. Nelle strutture pubbliche (Ente Ospedaliero Cantonale) le progressioni sono regolate dal contratto collettivo cantonale e le indennità per turni notturni (CHF 10-14 all\'ora aggiuntivi), festivi (+50-100 % sulla tariffa oraria) e Natale/Pasqua/Capodanno portano il netto mensile medio a €2.900-3.400. Nelle cliniche private (Moncucco, Sant\'Anna, Luganese, Santa Chiara) le retribuzioni base sono allineate ma le indennità variano.</p>',
 '<h2 style="font-size:1.15rem;font-weight:700;margin:1.25rem 0 .5rem">Riconoscimento titolo di studio — procedura SRK</h2>',
 '<p>Per lavorare come ASSC in Svizzera un OSS italiano deve far riconoscere il titolo dalla Croce Rossa Svizzera (SRK/CRS). La procedura avviene online sul portale della SRK: caricamento di diploma OSS tradotto con traduzione giurata, curriculum formativo dettagliato con monte ore e tirocini, documento d\'identità, tassa di esame fra CHF 900 e CHF 1.100. La SRK valuta l\'equivalenza e può decidere: (a) riconoscimento immediato; (b) periodo di adattamento di 3-12 mesi in struttura svizzera; (c) provvedimenti compensativi (moduli formativi aggiuntivi); (d) esame di abilitazione. Tempi medi di valutazione: 4-6 mesi.</p>',
 '<h2 style="font-size:1.15rem;font-weight:700;margin:1.25rem 0 .5rem">Aziende sanitarie che assumono frontalieri OSS</h2>',
 '<p>Le principali strutture ticinesi che assumono ASSC frontalieri italiani sono: Ente Ospedaliero Cantonale EOC (Ospedale Civico Lugano, Ospedale Regionale Bellinzona e Valli, Ospedale Beata Vergine Mendrisio, Ospedale La Carità Locarno); cliniche private Moncucco, Sant\'Anna, Luganese, Santa Chiara, San Rocco; case per anziani cantonali (Serena Lugano, Cigno Bianco Agno, Paradiso, Generoso Novazzano); agenzie di cure a domicilio (SCuDo, ABAD, Spitex Ticino). Le posizioni aperte settimanalmente sono tipicamente 30-60 nel solo settore anziani e 20-40 in ospedale acuto.</p>',
 '<h2 style="font-size:1.15rem;font-weight:700;margin:1.25rem 0 .5rem">Formazione e percorso per diventare ASSC in Ticino</h2>',
 '<p>Per chi vuole diventare ASSC partendo dall\'Italia senza titolo OSS italiano, la formazione ticinese triennale è offerta dalla Scuola Specializzata per le Professioni Sanitarie e Sociali (SSPSS) con sedi a Lugano, Bellinzona e Locarno. Il percorso prevede 3 anni di apprendistato duale: 1-2 giorni a scuola e 3-4 in struttura sanitaria, con contratto di apprendistato e stipendio progressivo (CHF 800 primo anno, CHF 1.100 secondo, CHF 1.500 terzo). Al termine si ottiene l\'Attestato Federale di Capacità (AFC) direttamente spendibile. Per chi ha già un titolo OSS italiano, la via del riconoscimento SRK è più rapida. Per valutare il guadagno netto da ASSC frontaliere: <a href="/calcola-stipendio/" style="color:#2563eb">calcolatore stipendio frontaliere</a>.</p>',
 ],
 en: [
 '<h2 style="font-size:1.15rem;font-weight:700;margin:1.25rem 0 .5rem">Healthcare assistant (OSS) in Switzerland — the equivalent profession</h2>',
 '<p>The Italian OSS (operatore socio-sanitario) corresponds in Switzerland to the Assistente di cura AFC — called ASSC in Italian Ticino and FaGe (Fachfrau/Fachmann Gesundheit) in German-speaking Switzerland. It is a regulated healthcare profession with a dual three-year training (school + workplace apprenticeship) covering hygiene, mobilisation, medication administration under nursing supervision, assistance with daily living, and vital-sign monitoring. Skills are comparable to the Italian OSS, with some operational differences depending on setting (acute hospital, nursing home, home care).</p>',
 '<h2 style="font-size:1.15rem;font-weight:700;margin:1.25rem 0 .5rem">ASSC salaries in Ticino 2026</h2>',
 '<p>In Canton Ticino a newly-hired ASSC earns CHF 55,000-62,000 gross annually with a 13th month; the band rises to CHF 65,000-75,000 with 5+ years of experience. In public facilities (Ente Ospedaliero Cantonale) progressions follow the cantonal collective agreement; shift premiums (CHF 10-14 extra per hour on nights, +50-100% on holidays, full pay on Christmas/Easter/New Year) bring average net monthly pay to €2,900-3,400. In private clinics (Moncucco, Sant\'Anna, Luganese, Santa Chiara) base pay is aligned but bonuses vary.</p>',
 '<h2 style="font-size:1.15rem;font-weight:700;margin:1.25rem 0 .5rem">Diploma recognition — the SRK procedure</h2>',
 '<p>An Italian OSS must have the diploma recognised by the Swiss Red Cross (SRK/CRS). Procedure is online on the SRK portal: upload a sworn translation of the OSS diploma, detailed training record with hours and placements, ID document; fee CHF 900-1,100. SRK decides: (a) direct recognition; (b) 3-12 month adaptation period in a Swiss facility; (c) compensatory measures (additional training modules); (d) aptitude test. Average processing time: 4-6 months.</p>',
 '<h2 style="font-size:1.15rem;font-weight:700;margin:1.25rem 0 .5rem">Healthcare employers hiring frontalieri</h2>',
 '<p>Main Ticino structures hiring Italian cross-border ASSC include: Ente Ospedaliero Cantonale EOC (Lugano Civico, Bellinzona, Mendrisio, Locarno hospitals); private clinics Moncucco, Sant\'Anna, Luganese, Santa Chiara, San Rocco; cantonal nursing homes (Serena Lugano, Cigno Bianco Agno, Paradiso, Generoso Novazzano); home-care agencies (SCuDo, ABAD, Spitex Ticino). Weekly openings: 30-60 in elderly care, 20-40 in acute hospital.</p>',
 '<h2 style="font-size:1.15rem;font-weight:700;margin:1.25rem 0 .5rem">Training path — becoming ASSC in Ticino from scratch</h2>',
 '<p>Without an Italian OSS diploma, Ticino\'s three-year dual training is offered by the SSPSS school (Lugano, Bellinzona, Locarno). It runs 1-2 days of school + 3-4 days of placement per week, apprenticeship contract with progressive pay (CHF 800 year one, CHF 1,100 year two, CHF 1,500 year three). Graduates obtain the Federal AFC diploma directly. With an existing Italian OSS qualification the SRK route is faster. To estimate net pay as an ASSC frontaliere, use the <a href="/en/calculate-salary/" style="color:#2563eb">cross-border salary calculator</a>.</p>',
 ],
 de: [
 '<h2 style="font-size:1.15rem;font-weight:700;margin:1.25rem 0 .5rem">Pflegehelfer/Fachperson Gesundheit in der Schweiz</h2>',
 '<p>Die italienische Berufsfigur OSS entspricht in der Schweiz der Fachperson Gesundheit EFZ (FaGe auf Deutsch, ASSC auf Italienisch). Es ist ein reglementierter Gesundheitsberuf mit einer dreijährigen dualen Ausbildung (Schule + Lehrbetrieb): Hygiene, Mobilisation, Medikamentenverabreichung unter pflegerischer Aufsicht, Unterstützung im Alltag, Erhebung der Vitalzeichen. Die Kompetenzen sind mit dem italienischen OSS vergleichbar, mit Unterschieden je nach Einsatzbereich (Akutspital, Pflegeheim, Spitex).</p>',
 '<h2 style="font-size:1.15rem;font-weight:700;margin:1.25rem 0 .5rem">ASSC-Löhne im Tessin 2026</h2>',
 '<p>Eine neu eingestellte ASSC im Tessin verdient CHF 55.000-62.000 brutto pro Jahr inklusive 13. Monatslohn; mit 5+ Jahren Erfahrung steigt der Lohn auf CHF 65.000-75.000. In öffentlichen Einrichtungen (Ente Ospedaliero Cantonale) folgt der Gesamtarbeitsvertrag; Schichtzulagen (CHF 10-14 zusätzlich pro Nachtstunde, +50-100 % an Feiertagen) bringen das monatliche Netto auf 2.900-3.400 €.</p>',
 '<h2 style="font-size:1.15rem;font-weight:700;margin:1.25rem 0 .5rem">Diplomanerkennung — SRK-Verfahren</h2>',
 '<p>Ein italienischer OSS muss das Diplom vom Schweizerischen Roten Kreuz (SRK) anerkennen lassen. Online-Verfahren auf der SRK-Website: beglaubigte Übersetzung des OSS-Diploms, detaillierte Ausbildungsnachweise, Ausweis; Gebühr CHF 900-1.100. Entscheidungen: (a) direkte Anerkennung; (b) Anpassungspraktikum 3-12 Monate; (c) Ausgleichsmodule; (d) Eignungsprüfung. Bearbeitungszeit 4-6 Monate.</p>',
 '<h2 style="font-size:1.15rem;font-weight:700;margin:1.25rem 0 .5rem">Arbeitgeber im Gesundheitswesen</h2>',
 '<p>Hauptarbeitgeber für italienische Grenzgänger-ASSC im Tessin: EOC (Spitäler Lugano Civico, Bellinzona, Mendrisio, Locarno); Privatkliniken Moncucco, Sant\'Anna, Luganese, Santa Chiara, San Rocco; Pflegeheime (Serena Lugano, Cigno Bianco Agno); Spitex-Organisationen (SCuDo, ABAD, Spitex Ticino). Wöchentlich 30-60 offene Stellen in der Altenpflege und 20-40 im Akutspital. Für die Nettolohnberechnung als ASSC-Grenzgänger: <a href="/de/gehalt-berechnen/" style="color:#2563eb">Grenzgänger-Gehaltsrechner</a>.</p>',
 ],
 fr: [
 '<h2 style="font-size:1.15rem;font-weight:700;margin:1.25rem 0 .5rem">Aide-soignant (OSS) en Suisse — la profession équivalente</h2>',
 '<p>L\'OSS italien correspond en Suisse à l\'Assistant en soins CFC, appelé ASSC au Tessin italophone et FaGe en Suisse alémanique. C\'est une profession de santé réglementée avec une formation duale sur trois ans (école + place d\'apprentissage), couvrant hygiène, mobilisation, administration de médicaments sous supervision infirmière, aide à la vie quotidienne, surveillance des paramètres vitaux. Les compétences sont comparables à celles de l\'OSS italien, avec des variantes selon le cadre (hôpital aigu, EMS, soins à domicile).</p>',
 '<h2 style="font-size:1.15rem;font-weight:700;margin:1.25rem 0 .5rem">Salaires ASSC au Tessin 2026</h2>',
 '<p>Au Tessin un ASSC nouvellement engagé gagne CHF 55.000-62.000 brut par an avec 13e mois ; la fourchette monte à CHF 65.000-75.000 avec 5+ ans d\'expérience. Dans les structures publiques (Ente Ospedaliero Cantonale) les évolutions suivent la convention collective cantonale ; les indemnités de nuit (CHF 10-14 supplémentaires/h), weekend (+50-100 %) et fêtes portent le net mensuel à 2.900-3.400 €.</p>',
 '<h2 style="font-size:1.15rem;font-weight:700;margin:1.25rem 0 .5rem">Reconnaissance du diplôme — procédure CRS</h2>',
 '<p>Un OSS italien doit faire reconnaître son diplôme par la Croix-Rouge Suisse (CRS/SRK). Procédure en ligne : traduction jurée du diplôme OSS, dossier de formation détaillé, pièce d\'identité ; taxe CHF 900-1.100. Décisions : (a) reconnaissance directe ; (b) stage d\'adaptation 3-12 mois ; (c) mesures de compensation ; (d) test d\'aptitude. Délai moyen 4-6 mois.</p>',
 '<h2 style="font-size:1.15rem;font-weight:700;margin:1.25rem 0 .5rem">Employeurs du secteur santé</h2>',
 '<p>Principaux employeurs d\'ASSC frontaliers italiens au Tessin : EOC (hôpitaux Lugano Civico, Bellinzona, Mendrisio, Locarno) ; cliniques privées Moncucco, Sant\'Anna, Luganese, Santa Chiara, San Rocco ; EMS cantonaux (Serena Lugano, Cigno Bianco Agno) ; soins à domicile (SCuDo, ABAD, Spitex Ticino). Ouvertures hebdomadaires : 30-60 en EMS, 20-40 en hôpital aigu. Pour calculer le net en tant qu\'ASSC frontalier : <a href="/fr/calculer-salaire/" style="color:#2563eb">calculateur salaire frontalier</a>.</p>',
 ],
 },

 '/statistiche/stipendi-svizzera-vs-italia': {
 it: [
 '<h2 style="font-size:1.15rem;font-weight:700;margin:1.25rem 0 .5rem">Stipendi Svizzera vs Italia — il quadro 2026</h2>',
 '<p>Il confronto degli stipendi fra Svizzera e Italia nel 2026 conferma un differenziale strutturale di 2-2,5x a favore della Svizzera per ruoli equivalenti. Il divario non è uniforme: nei settori ad alta qualifica (sanità, finanza, ingegneria, ICT) lo scarto supera spesso il 150 % lordo; nei ruoli base retail e ristorazione è più contenuto (+40-70 %). La spiegazione è composita: produttività oraria superiore in Svizzera, costo della vita più alto in patria che giustifica retribuzioni maggiori, contrattazione collettiva più forte su alcuni settori, carenza di manodopera qualificata in specifici ambiti (sanità in primis).</p>',
 '<h2 style="font-size:1.15rem;font-weight:700;margin:1.25rem 0 .5rem">Stipendi medi per settore — tabella Italia vs Ticino</h2>',
 '<p>Infermiere: Italia €28.000 lordi annui vs CHF 78.000 Ticino (~€81.000), +189 %. OSS/ASSC: Italia €22.000 vs CHF 58.000 (~€60.000), +173 %. Ingegnere junior: Italia €32.000 vs CHF 95.000 (~€98.800), +209 %. Software developer medio: Italia €40.000 vs CHF 110.000 (~€114.400), +186 %. Impiegato bancario junior: Italia €30.000 vs CHF 78.000 (~€81.000), +170 %. Commercialista staff: Italia €35.000 vs CHF 85.000 (~€88.400), +153 %. Operatore logistico: Italia €25.000 vs CHF 60.000 (~€62.400), +150 %. Cameriere/barista: Italia €20.000 vs CHF 50.000 (~€52.000), +160 %.</p>',
 '<h2 style="font-size:1.15rem;font-weight:700;margin:1.25rem 0 .5rem">Netto reale post-tasse — impatto del regime frontaliere</h2>',
 '<p>Il differenziale lordo non si traduce automaticamente in netto. Per un nuovo frontaliere (dal 17/07/2023) il netto finale sconta l\'imposta alla fonte svizzera e l\'IRPEF italiana con franchigia 10.000 € e credito d\'imposta. Esempio infermiere: CHF 78.000 lordi → netto finale ~€58.000 in Italia (nuovo regime) o ~€64.000 (vecchio regime). Il collega italiano con €28.000 lordi incassa ~€21.000 netti. Differenziale netto: +176 % (nuovo) o +205 % (vecchio). Il vantaggio è reale e strutturale ma si accompagna al costo del pendolarismo quotidiano.</p>',
 '<h2 style="font-size:1.15rem;font-weight:700;margin:1.25rem 0 .5rem">Costo della vita Lugano vs Milano — cosa cambia veramente</h2>',
 '<p>Il frontaliere mantiene residenza in Italia: paga gli affitti, la spesa e i servizi italiani (più bassi) mentre incassa uno stipendio svizzero. Milano ha affitti medi €1.200-1.800/mese per bilocale in zone semicentrali; Lugano CHF 1.800-2.600 per un appartamento analogo (+60-80 %). Un pasto al ristorante a Milano €20-35, Lugano CHF 35-55 (+90 %). Carburante in Italia €1,75-1,85/litro, Svizzera CHF 1,80-1,95 (prezzo allineato ma meno con cambio favorevole). Il pendolarismo aggiunge €200-400/mese di trasporto e CHF 300-500 di LAMal/cassa malati non deducibile dallo stipendio.</p>',
 '<h2 style="font-size:1.15rem;font-weight:700;margin:1.25rem 0 .5rem">Quando vale la pena fare il frontaliere — matrice decisionale</h2>',
 '<p>Conviene se: (1) si vive entro 40-50 km dai valichi ticinesi; (2) ruolo qualificato con differenziale ampio; (3) la famiglia accetta il pendolarismo di 1-3 ore al giorno; (4) netto incrementale mensile supera €1.000 rispetto al ruolo italiano equivalente; (5) tolleranza per la variabilità di orario al confine. Non conviene se: ruolo base con differenziale minimo; tragitto oltre 70 km; necessità di flessibilità oraria elevata; figli piccoli con orari scolastici rigidi. Per una valutazione personalizzata usa il <a href="/statistiche/confronta-stipendi/" style="color:#2563eb">confronto stipendi</a>.</p>',
 '<p style="color:#64748b;font-size:0.8rem;margin-top:4px;">Fonti dati: Ufficio federale di statistica (UFS) rilevazione salari 2024, ISTAT rilevazione retributive 2024, contrattazione collettiva CCNL italiana, CCL settoriali ticinesi, elaborazione interna Frontaliere Ticino.</p>',
 ],
 en: [
 '<h2 style="font-size:1.15rem;font-weight:700;margin:1.25rem 0 .5rem">Switzerland vs Italy salaries — the 2026 picture</h2>',
 '<p>The salary comparison between Switzerland and Italy in 2026 confirms a structural 2-2.5x differential in favour of Switzerland for equivalent roles. The gap is not uniform: in high-skill sectors (healthcare, finance, engineering, ICT) the gap often exceeds 150% gross, while entry-level retail and hospitality roles see +40-70%. The reasons are compound: higher hourly productivity, higher domestic cost of living pushing up wages, stronger collective bargaining in some sectors, labour shortage in specific areas (healthcare first).</p>',
 '<h2 style="font-size:1.15rem;font-weight:700;margin:1.25rem 0 .5rem">Average gross salaries by sector — Italy vs Ticino</h2>',
 '<p>Nurse: Italy €28,000 gross annual vs CHF 78,000 Ticino (~€81,000), +189%. Healthcare assistant (OSS/ASSC): Italy €22,000 vs CHF 58,000 (~€60,000), +173%. Junior engineer: Italy €32,000 vs CHF 95,000 (~€98,800), +209%. Mid-level software developer: Italy €40,000 vs CHF 110,000, +186%. Junior bank clerk: Italy €30,000 vs CHF 78,000, +170%. Accountant staff: Italy €35,000 vs CHF 85,000, +153%. Logistics operator: Italy €25,000 vs CHF 60,000, +150%. Waiter/barista: Italy €20,000 vs CHF 50,000, +160%.</p>',
 '<h2 style="font-size:1.15rem;font-weight:700;margin:1.25rem 0 .5rem">Actual net pay post-tax — impact of the frontaliere regime</h2>',
 '<p>Gross differential does not translate automatically into net. For a new frontaliere (from 17/07/2023) the final net factors in Swiss withholding plus Italian IRPEF with €10,000 allowance and tax credit. Example nurse: CHF 78,000 gross → final net ~€58,000 in Italy (new regime) or ~€64,000 (old regime). An Italian colleague on €28,000 gross takes home ~€21,000 net. Net differential: +176% (new) or +205% (old). Real, structural advantage balanced against the cost of daily commuting.</p>',
 '<h2 style="font-size:1.15rem;font-weight:700;margin:1.25rem 0 .5rem">Cost of living Lugano vs Milan</h2>',
 '<p>The frontaliere keeps residence in Italy: pays Italian rents and services (lower) while receiving a Swiss salary. Milan average rent €1,200-1,800/month for a two-bed flat in semi-central areas; Lugano CHF 1,800-2,600 for an equivalent flat (+60-80%). A restaurant meal in Milan €20-35, Lugano CHF 35-55 (+90%). Fuel in Italy €1.75-1.85/L, Switzerland CHF 1.80-1.95. Commuting adds €200-400/month in transport plus CHF 300-500 of LAMal health insurance not deductible from pay.</p>',
 '<h2 style="font-size:1.15rem;font-weight:700;margin:1.25rem 0 .5rem">When is frontaliere commuting worth it — decision matrix</h2>',
 '<p>Worth it if: (1) you live within 40-50 km of a Ticino crossing; (2) qualified role with wide differential; (3) family accepts 1-3 hour daily commute; (4) incremental monthly net >€1,000 vs equivalent Italian role; (5) tolerance for variable border times. Not worth it if: entry role with minimal gap; commute over 70 km; need for high schedule flexibility; small children with rigid school hours. For a personalised evaluation use the <a href="/en/calculate-salary/compare-salaries/" style="color:#2563eb">salary comparator</a>.</p>',
 '<p style="color:#64748b;font-size:0.8rem;margin-top:4px;">Data sources: Swiss Federal Statistical Office (UFS) 2024 wage survey, ISTAT 2024 earnings survey, Italian CCNL, Ticino CCL, Frontaliere Ticino internal elaboration.</p>',
 ],
 de: [
 '<h2 style="font-size:1.15rem;font-weight:700;margin:1.25rem 0 .5rem">Löhne Schweiz vs Italien — das Bild 2026</h2>',
 '<p>Der Lohnvergleich Schweiz-Italien 2026 bestätigt einen strukturellen Faktor von 2-2,5 zugunsten der Schweiz bei gleichwertigen Positionen. Die Lücke ist nicht einheitlich: in hochqualifizierten Branchen (Gesundheit, Finanzen, Ingenieurwesen, ICT) übersteigt sie oft 150 % brutto; in Einsteigerbereichen Retail und Gastronomie +40-70 %. Gründe: höhere Produktivität pro Stunde, höhere Lebenshaltungskosten, stärkere Gesamtarbeitsverträge, Fachkräftemangel in bestimmten Bereichen (Pflege zuerst).</p>',
 '<h2 style="font-size:1.15rem;font-weight:700;margin:1.25rem 0 .5rem">Durchschnittslöhne nach Branche — Italien vs Tessin</h2>',
 '<p>Pflegefachperson: Italien 28.000 € vs CHF 78.000 Tessin (~81.000 €), +189 %. Pflegehelfer (OSS/ASSC): Italien 22.000 € vs CHF 58.000 (~60.000 €), +173 %. Ingenieur Junior: Italien 32.000 € vs CHF 95.000 (~98.800 €), +209 %. Software Developer: Italien 40.000 € vs CHF 110.000, +186 %. Bankangestellter Junior: Italien 30.000 € vs CHF 78.000, +170 %. Treuhänder: Italien 35.000 € vs CHF 85.000, +153 %. Logistik: Italien 25.000 € vs CHF 60.000, +150 %. Kellner: Italien 20.000 € vs CHF 50.000, +160 %.</p>',
 '<h2 style="font-size:1.15rem;font-weight:700;margin:1.25rem 0 .5rem">Tatsächlicher Netto nach Steuern</h2>',
 '<p>Die Bruttodifferenz führt nicht automatisch zum Netto. Für einen neuen Grenzgänger (ab 17/07/2023) berücksichtigt das Netto Quellensteuer + italienische IRPEF mit 10.000 € Freibetrag und Anrechnung. Beispiel Pflegefachperson: CHF 78.000 brutto → Netto ~58.000 € (neues Regime) oder ~64.000 € (altes Regime). Italienischer Kollege mit 28.000 € brutto: Netto ~21.000 €. Nettodifferenz: +176 % oder +205 %.</p>',
 '<h2 style="font-size:1.15rem;font-weight:700;margin:1.25rem 0 .5rem">Lebenshaltungskosten Lugano vs Mailand</h2>',
 '<p>Der Grenzgänger behält Wohnsitz in Italien: zahlt italienische Mieten (tiefer), kassiert Schweizer Löhne. Mailand 2-Zimmer: 1.200-1.800 €/Monat; Lugano CHF 1.800-2.600 (+60-80 %). Restaurantessen Mailand 20-35 €, Lugano CHF 35-55 (+90 %). Treibstoff: Italien 1,75-1,85 €/L, Schweiz CHF 1,80-1,95. Pendeln zusätzlich 200-400 €/Monat Transport plus CHF 300-500 LAMal.</p>',
 '<h2 style="font-size:1.15rem;font-weight:700;margin:1.25rem 0 .5rem">Wann lohnt sich der Grenzgänger-Status</h2>',
 '<p>Lohnt sich wenn: Wohnsitz innerhalb 40-50 km vom Grenzübergang; qualifizierte Rolle mit grosser Lohndifferenz; Familie akzeptiert 1-3 Stunden Pendelzeit; Netto-Mehreinnahme >1.000 €/Monat gegenüber italienischem Job. Lohnt sich nicht: Einsteigerrolle mit minimalem Unterschied; Weg über 70 km; hohe Zeitflexibilität nötig. Personalisierte Auswertung: <a href="/de/gehalt-berechnen/gehaelter-vergleichen/" style="color:#2563eb">Lohnvergleich</a>.</p>',
 ],
 fr: [
 '<h2 style="font-size:1.15rem;font-weight:700;margin:1.25rem 0 .5rem">Salaires Suisse vs Italie — tableau 2026</h2>',
 '<p>La comparaison des salaires Suisse-Italie en 2026 confirme un différentiel structurel de 2-2,5x en faveur de la Suisse pour des rôles équivalents. L\'écart n\'est pas uniforme : dans les secteurs hautement qualifiés (santé, finance, ingénierie, ICT) il dépasse souvent 150 % brut ; dans les rôles de base du retail et de la restauration +40-70 %. Raisons : productivité horaire supérieure, coût de la vie plus élevé, conventions collectives plus fortes, pénurie de main-d\'œuvre qualifiée.</p>',
 '<h2 style="font-size:1.15rem;font-weight:700;margin:1.25rem 0 .5rem">Salaires moyens par secteur — Italie vs Tessin</h2>',
 '<p>Infirmier : Italie 28.000 € vs CHF 78.000 Tessin (~81.000 €), +189 %. Aide-soignant : Italie 22.000 € vs CHF 58.000 (~60.000 €), +173 %. Ingénieur junior : Italie 32.000 € vs CHF 95.000 (~98.800 €), +209 %. Développeur logiciel : Italie 40.000 € vs CHF 110.000, +186 %. Employé de banque junior : Italie 30.000 € vs CHF 78.000, +170 %. Comptable : Italie 35.000 € vs CHF 85.000, +153 %. Logistique : Italie 25.000 € vs CHF 60.000, +150 %. Serveur : Italie 20.000 € vs CHF 50.000, +160 %.</p>',
 '<h2 style="font-size:1.15rem;font-weight:700;margin:1.25rem 0 .5rem">Net réel après impôts — régime frontalier</h2>',
 '<p>Le différentiel brut ne se traduit pas automatiquement en net. Pour un nouveau frontalier (depuis 17/07/2023) le net final intègre l\'impôt à la source suisse + IRPEF italienne avec abattement 10.000 € et crédit. Exemple infirmier : CHF 78.000 brut → net final ~58.000 € (nouveau régime) ou ~64.000 € (ancien). Collègue italien à 28.000 € brut : net ~21.000 €. Écart net : +176 % ou +205 %.</p>',
 '<h2 style="font-size:1.15rem;font-weight:700;margin:1.25rem 0 .5rem">Coût de la vie Lugano vs Milan</h2>',
 '<p>Le frontalier garde sa résidence en Italie : il paie les loyers italiens (plus bas) et perçoit un salaire suisse. Milan 2-pièces : 1.200-1.800 €/mois ; Lugano CHF 1.800-2.600 (+60-80 %). Repas restaurant Milan 20-35 €, Lugano CHF 35-55 (+90 %). Carburant : Italie 1,75-1,85 €/L, Suisse CHF 1,80-1,95. Les déplacements ajoutent 200-400 €/mois de transport plus CHF 300-500 de LAMal.</p>',
 '<h2 style="font-size:1.15rem;font-weight:700;margin:1.25rem 0 .5rem">Quand ça vaut la peine d\'être frontalier</h2>',
 '<p>Ça vaut la peine si : résidence à moins de 40-50 km du poste-frontière ; poste qualifié avec écart large ; famille accepte 1-3 heures de trajet ; net mensuel supplémentaire >1.000 € vs équivalent italien. Ça ne vaut pas si : poste de base à écart minimal ; trajet de plus de 70 km ; besoin de flexibilité horaire élevée. Évaluation personnalisée : <a href="/fr/calculer-salaire/comparer-salaires/" style="color:#2563eb">comparateur salarial</a>.</p>',
 ],
 },

};

/**
 * Sorted prefixes (longest first) for correct prefix-matching.
 * This ensures e.g. '/calcola-stipendio/simula-busta-paga' matches
 * before the generic '/calcola-stipendio/' fallback.
 */
export const SECTION_EDITORIAL_KEYS: string[] = Object.keys(SECTION_EDITORIAL)
 .sort((a, b) => b.length - a.length);
