/**
 * daily-brief-template.mjs — the email dress of the "Bollettino del Frontaliere".
 *
 * WHY THIS EXISTS (issue #5415 §2b)
 * ─────────────────────────────────
 * The daily brief shipped inside `buildNewsletter()`, the WEEKLY newsletter's
 * template, which parametrises none of its own dress: the recipient got the
 * weekly masthead, the weekly issue counter (`getIssueNumberFallback`, so two
 * consecutive days carried the same number), the hero subtitle "Ecco cosa
 * succede ai tuoi soldi QUESTA SETTIMANA" over daily numbers, hardcoded
 * placeholder metrics (2.8% / CHF 467), and a `<title>` reading "Frontaliere
 * Weekly". The brief's own paragraphs went into the slot the weekly reserves
 * for its editorial. Only the subject line differed.
 *
 * So this is a SEPARATE template, not a parameter on that one. What it reuses
 * from the weekly channel is the MECHANICS — signed unsubscribe/preferences
 * URLs, the provider cascade, suppression sets, per-user send scheduling — all
 * of which live outside the template. What it deliberately does not reuse is
 * the layout, the palette, the voice, and the issue numbering.
 *
 * SHAPE. Four data blocks, each its own live-page link (border waits, fuel,
 * exchange rate, jobs), under a masthead that names the bulletin and carries
 * THE EDITION'S date — `brief.dateIso`, never `new Date()`, so a resend or a
 * delayed slot cannot relabel yesterday's numbers as today's. A block the
 * corpus could not measure is simply absent (`available: false`); the sender
 * refuses to send at all below two blocks.
 *
 * NO ISSUE NUMBER. A daily edition is identified by its date. The weekly's
 * fallback counter is exactly the artefact that made two consecutive bulletins
 * look like the same issue.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * THE RESTYLE (issue #5683)
 * ─────────────────────────────────────────────────────────────────────────────
 * Until 2026-08-12 the four blocks were four identical grey panels with the
 * same type size, and the only genuinely daily fact in the message — the
 * movement against the previous day — was set in the same 14px grey as
 * everything else (`-0,0001 sul giorno precedente`). A message where nothing
 * is bigger than anything else gives no reason to open tomorrow's, and this is
 * the channel that can reach one email a day.
 *
 * 1. ONE LEAD, THE REST AS SUPPORT. Exactly one block is rendered as the hero
 *    (40px number, its own bright panel, accent rule); the others share a
 *    single recessed panel at 20px. The lead is NOT a fixed block: it is the
 *    one whose number MOVED most against its own previous-day baseline —
 *    see `markLead()` for the rule and why only two of the four blocks can
 *    compete for it.
 *
 * 2. THE MOVEMENT GETS ITS OWN TREATMENT. Direction glyph (▲/▼/■), explicit
 *    sign, colour, and the comparison spelled out ("da 1,0695 di ieri",
 *    "contro una media di 598 al giorno"). Colour is never the only carrier:
 *    the glyph and the sign say the same thing, which is what keeps it
 *    readable for colour-blind recipients AND under a mail client's forced
 *    dark-mode colour transform.
 *
 * 3. ONE LINE THAT IS NOT A NUMBER (`dailyHighlight()`). The 25,70 € saved on
 *    a tank at Livigno was already in the payload, buried in a block's support
 *    line; as a sentence it is the one thing in the message a person repeats
 *    to someone else. It rotates by date, deterministically — same date, same
 *    line, so a resend is byte-identical.
 *
 * 4. FOOTER (#5675 + the abuse-desk complaint of 2026-08-12). The controller
 *    identity comes from `dataControllerFooterLine()`, the single source in
 *    functions/src/lib/ — never a string spelled out here, or the next change
 *    to the identity would update one place out of nine. The unsubscribe stops
 *    being 11px grey-on-grey and becomes a bordered 14px pill next to an
 *    equally prominent "manage preferences" one: the recipient who wants out
 *    finds it, and the one who only wants it less often has an equally easy
 *    door. A recipient who finds neither writes to the provider's abuse desk,
 *    which is how this issue was opened.
 *
 * NOT CHANGED HERE, ON PURPOSE: the unsubscribe URL itself. `data.unsubscribeUrl`
 * is `makeOneClickUnsubscribeUrl()`'s output (the Cloud Function endpoint, which
 * works with no JS and no autologin code) — swapping it for the SPA-processed
 * `makeUnsubscribeUrl()` form would make the link LESS reliable exactly while
 * making it more visible. The template only dresses the URL it is handed.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * MAIL-CLIENT CONSTRAINTS, all of them load-bearing
 * ─────────────────────────────────────────────────────────────────────────────
 * · TABLES AND INLINE STYLES, no flexbox and no grid. Outlook's Word rendering
 *   engine supports neither; a `display:flex` row collapses into stacked text.
 * · NO IMAGES AT ALL. Not "images with alt text" — none. Every figure, glyph
 *   and rule here is text or a table border, so the message is complete with
 *   images blocked (most clients block them by default on first receipt) and
 *   so a daily send to thousands of addresses carries no image payload.
 * · DARK MODE, both kinds. Apple Mail / iOS honour
 *   `@media (prefers-color-scheme:dark)`, so the `<style>` block below restates
 *   the palette with `!important` (which is what beats an inline style).
 *   Outlook and Gmail Android instead FORCE a colour transform of their own and
 *   ignore that media query, so the light design has to survive being inverted:
 *   every element that sets a `background` also sets a `color` on the SAME
 *   element. That pairing is the whole trick — Gmail's partial inversion flips
 *   a declared background and leaves an undeclared text colour behind, which is
 *   how "dark grey on dark grey" happens. There is no `#ffffff`-on-unset text
 *   anywhere below.
 * · `<style>` IS PROGRESSIVE ENHANCEMENT. Clients that drop the head entirely
 *   still get the full light design from the inline styles.
 */

import { nlNormLocale, localizedUrl } from '../functions/src/lib/newsletterUrlPaths.js';
// Data-controller identity for the footer (#5675) — see that file's header
// for why the canonical home is functions/src/lib/, not services/.
import { dataControllerFooterLine } from '../functions/src/lib/dataControllerIdentity.js';

const BASE_URL = 'https://frontaliereticino.ch';

/**
 * PALETTE. Deliberately NOT the weekly's — the weekly is orange-on-slate
 * (#f97316/#0f172a), the bulletin is a cold early-morning blue, so the two are
 * told apart in the inbox preview before a single word is read.
 *
 * Everything EXCEPT the masthead navy is now the site's own scale (#5683,
 * "template and linked pages look like two products"): slate-100/200/700 for
 * panels, borders and body text, blue-700 for links, the same 12/16px radii
 * and the same system font stack the site ships. Two of those moves are also
 * contrast fixes: links were sky-500 `#0ea5e9` on white (2.7:1, below AA) and
 * are now blue-700 `#1d4ed8` (6.3:1); the identity/footer lines were
 * `#94a3b8` on `#f1f5f9` (1.9:1, effectively invisible) and are now the body
 * `#334155` (9.1:1).
 */
const SANS = "-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif";
const INK = '#0b2545';        // bulletin navy: masthead + every headline number
const INK_SOFT = '#13315c';   // the tagline strip under the masthead
const ACCENT = '#1d4ed8';     // link text (blue-700)
const ACCENT_BTN = '#2563eb'; // button fill (blue-600) — white on it is 5.2:1
const PAGE_BG = '#eef2f7';
const CARD_BG = '#ffffff';
const PANEL_BG = '#f1f5f9';   // site slate-100
const NOTE_BG = '#eff6ff';    // the one non-number line
const NOTE_RULE = '#93c5fd';
const BORDER = '#e2e8f0';     // site slate-200
const TEXT = '#334155';       // site slate-700
const MUTED = '#64748b';      // site slate-500
const GOOD = '#15803d';
const WARN = '#c2410c';

const LOCALES = ['it', 'en', 'de', 'fr'];

const DATE_LOCALE = { it: 'it-IT', en: 'en-GB', de: 'de-DE', fr: 'fr-FR' };

const I18N = {
  it: {
    brand: 'Frontaliere Ticino',
    masthead: 'Bollettino del Frontaliere',
    tagline: 'I numeri di stamattina, misurati da noi.',
    greeting: 'Buongiorno.',
    greetingNamed: 'Buongiorno, {name}.',
    leadEyebrow: 'il numero di oggi',
    movedFrom: 'da {prev} di ieri',
    vsAverage: 'contro una media di {avg} al giorno',
    flatShort: 'invariato',
    goodToKnow: 'Buono a sapersi',
    borderTitle: 'Valichi',
    borderWorst: 'Attesa più lunga',
    borderClear: '{n} valichi su {total} senza coda',
    borderCta: 'Traffico ai valichi in tempo reale',
    fuelTitle: 'Benzina',
    fuelCheapest: 'Minimo nei comuni di confine',
    fuelSaving: 'Risparmio su un pieno da 50 litri a {place}',
    fuelCta: 'Prezzi benzina al confine, oggi',
    fxTitle: 'Cambio',
    fxLabel: '1 franco',
    fxCta: 'Confronta i servizi di cambio',
    jobsTitle: 'Lavoro',
    jobsYesterday: 'Nuovi annunci ieri',
    jobsActive: '{n} annunci attivi da {companies} aziende',
    jobsCta: 'Cerca lavoro in Ticino e in Svizzera',
    editionCta: 'Leggi il bollettino completo',
    editionNote: 'I numeri qui sopra fotografano il momento della pubblicazione. Le pagine collegate restano aggiornate tutto il giorno.',
    cadenceNote: 'Ricevi il bollettino {cadence}. La frequenza si adatta a quanto lo apri: puoi fissarla o disattivarla dalle tue preferenze.',
    cadenceDaily: 'ogni mattina',
    cadenceEveryN: 'ogni {n} giorni',
    cadenceWeekly: 'una volta a settimana',
    preferences: 'Gestisci le preferenze',
    unsubscribe: 'Disiscriviti',
    unsubTitle: 'Troppe email? Cambia frequenza o esci in un clic.',
    footer: 'Bollettino quotidiano di Frontaliere Ticino — dati misurati, non stimati.',
    minutes: 'min',
    funFuelIt: 'Un pieno da 50 litri a {place} costa {amount} € meno che in Svizzera.',
    funFuelCh: 'A {place} conviene il pieno svizzero: {amount} € in meno su 50 litri.',
    funBorderClear: 'Stamattina si passa: {n} valichi su {total} sono senza coda.',
    funBorderQueue: 'La coda più lunga di stamattina è a {place}: {n} minuti.',
    funJobs: 'In questo momento {companies} aziende hanno almeno un annuncio aperto.',
    funFxWeek: 'Sette giorni fa un franco valeva {prev} €.',
  },
  en: {
    brand: 'Frontaliere Ticino',
    masthead: 'Cross-border Daily Brief',
    tagline: "This morning's numbers, measured by us.",
    greeting: 'Good morning.',
    greetingNamed: 'Good morning, {name}.',
    leadEyebrow: "today's number",
    movedFrom: 'from {prev} yesterday',
    vsAverage: 'against an average of {avg} a day',
    flatShort: 'unchanged',
    goodToKnow: 'Good to know',
    borderTitle: 'Border crossings',
    borderWorst: 'Longest wait',
    borderClear: '{n} of {total} crossings queue-free',
    borderCta: 'Live border traffic',
    fuelTitle: 'Fuel',
    fuelCheapest: 'Border-municipality low',
    fuelSaving: 'Saving on a 50-litre tank in {place}',
    fuelCta: "Today's border fuel prices",
    fxTitle: 'Exchange rate',
    fxLabel: '1 franc',
    fxCta: 'Compare exchange services',
    jobsTitle: 'Jobs',
    jobsYesterday: 'New listings yesterday',
    jobsActive: '{n} active listings from {companies} companies',
    jobsCta: 'Search jobs in Ticino and Switzerland',
    editionCta: 'Read the full brief',
    editionNote: 'The numbers above are a snapshot taken at publication. The linked pages stay live all day.',
    cadenceNote: 'You receive this brief {cadence}. The frequency follows how often you open it — you can pin it or turn it off in your preferences.',
    cadenceDaily: 'every morning',
    cadenceEveryN: 'every {n} days',
    cadenceWeekly: 'once a week',
    preferences: 'Manage preferences',
    unsubscribe: 'Unsubscribe',
    unsubTitle: 'Too much email? Change the frequency, or leave in one click.',
    footer: 'Frontaliere Ticino daily brief — measured data, not estimates.',
    minutes: 'min',
    funFuelIt: 'A 50-litre tank in {place} costs {amount} € less than in Switzerland.',
    funFuelCh: 'In {place} the Swiss tank wins: {amount} € less over 50 litres.',
    funBorderClear: 'Clear run this morning: {n} of {total} crossings have no queue.',
    funBorderQueue: 'The longest queue this morning is at {place}: {n} minutes.',
    funJobs: 'Right now {companies} companies have at least one listing open.',
    funFxWeek: 'Seven days ago one franc was worth {prev} €.',
  },
  de: {
    brand: 'Frontaliere Ticino',
    masthead: 'Grenzgänger-Tagesbulletin',
    tagline: 'Die Zahlen von heute Morgen, von uns gemessen.',
    greeting: 'Guten Morgen.',
    greetingNamed: 'Guten Morgen, {name}.',
    leadEyebrow: 'die Zahl des Tages',
    movedFrom: 'von {prev} gestern',
    vsAverage: 'gegenüber durchschnittlich {avg} pro Tag',
    flatShort: 'unverändert',
    goodToKnow: 'Gut zu wissen',
    borderTitle: 'Grenzübergänge',
    borderWorst: 'Längste Wartezeit',
    borderClear: '{n} von {total} Übergängen ohne Warteschlange',
    borderCta: 'Grenzverkehr in Echtzeit',
    fuelTitle: 'Benzin',
    fuelCheapest: 'Tiefstpreis der Grenzgemeinden',
    fuelSaving: 'Ersparnis bei 50 Litern in {place}',
    fuelCta: 'Benzinpreise an der Grenze, heute',
    fxTitle: 'Wechselkurs',
    fxLabel: '1 Franken',
    fxCta: 'Wechseldienste vergleichen',
    jobsTitle: 'Stellen',
    jobsYesterday: 'Neue Inserate gestern',
    jobsActive: '{n} aktive Inserate von {companies} Unternehmen',
    jobsCta: 'Stellen im Tessin und in der Schweiz suchen',
    editionCta: 'Zum vollständigen Bulletin',
    editionNote: 'Die Zahlen oben sind eine Momentaufnahme zum Zeitpunkt der Veröffentlichung. Die verlinkten Seiten bleiben den ganzen Tag aktuell.',
    cadenceNote: 'Sie erhalten dieses Bulletin {cadence}. Die Frequenz richtet sich danach, wie oft Sie es öffnen — in den Einstellungen können Sie sie festlegen oder abschalten.',
    cadenceDaily: 'jeden Morgen',
    cadenceEveryN: 'alle {n} Tage',
    cadenceWeekly: 'einmal pro Woche',
    preferences: 'Einstellungen verwalten',
    unsubscribe: 'Abmelden',
    unsubTitle: 'Zu viele E-Mails? Frequenz ändern oder mit einem Klick abmelden.',
    footer: 'Tagesbulletin von Frontaliere Ticino — gemessene Daten, keine Schätzungen.',
    minutes: 'Min.',
    funFuelIt: 'Eine 50-Liter-Tankfüllung in {place} kostet {amount} € weniger als in der Schweiz.',
    funFuelCh: 'In {place} lohnt sich das Tanken auf der Schweizer Seite: {amount} € weniger auf 50 Liter.',
    funBorderClear: 'Heute Morgen freie Fahrt: {n} von {total} Übergängen ohne Warteschlange.',
    funBorderQueue: 'Die längste Warteschlange heute Morgen ist in {place}: {n} Minuten.',
    funJobs: 'Aktuell haben {companies} Unternehmen mindestens ein Inserat offen.',
    funFxWeek: 'Vor sieben Tagen war ein Franken {prev} € wert.',
  },
  fr: {
    brand: 'Frontaliere Ticino',
    masthead: 'Bulletin du Frontalier',
    tagline: 'Les chiffres de ce matin, mesurés par nos soins.',
    greeting: 'Bonjour.',
    greetingNamed: 'Bonjour, {name}.',
    leadEyebrow: 'le chiffre du jour',
    movedFrom: 'contre {prev} hier',
    vsAverage: 'contre une moyenne de {avg} par jour',
    flatShort: 'inchangé',
    goodToKnow: 'Bon à savoir',
    borderTitle: 'Passages frontaliers',
    borderWorst: 'Attente la plus longue',
    borderClear: '{n} passages sur {total} sans file',
    borderCta: 'Trafic aux douanes en temps réel',
    fuelTitle: 'Essence',
    fuelCheapest: 'Minimum des communes frontalières',
    fuelSaving: 'Économie sur un plein de 50 litres à {place}',
    fuelCta: "Prix de l'essence à la frontière, aujourd'hui",
    fxTitle: 'Taux de change',
    fxLabel: '1 franc',
    fxCta: 'Comparer les services de change',
    jobsTitle: 'Emploi',
    jobsYesterday: 'Nouvelles offres hier',
    jobsActive: '{n} offres actives de {companies} entreprises',
    jobsCta: 'Chercher un emploi au Tessin et en Suisse',
    editionCta: 'Lire le bulletin complet',
    editionNote: 'Les chiffres ci-dessus sont un instantané au moment de la publication. Les pages liées restent à jour toute la journée.',
    cadenceNote: 'Vous recevez ce bulletin {cadence}. La fréquence suit la façon dont vous l’ouvrez — vous pouvez la fixer ou la désactiver dans vos préférences.',
    cadenceDaily: 'chaque matin',
    cadenceEveryN: 'tous les {n} jours',
    cadenceWeekly: 'une fois par semaine',
    preferences: 'Gérer les préférences',
    unsubscribe: 'Se désabonner',
    unsubTitle: 'Trop d’e-mails ? Changez la fréquence, ou partez en un clic.',
    footer: 'Bulletin quotidien de Frontaliere Ticino — des données mesurées, pas estimées.',
    minutes: 'min',
    funFuelIt: 'Un plein de 50 litres à {place} coûte {amount} € de moins qu’en Suisse.',
    funFuelCh: 'À {place} le plein suisse est plus avantageux : {amount} € de moins sur 50 litres.',
    funBorderClear: 'Ce matin ça passe : {n} passages sur {total} sont sans file.',
    funBorderQueue: 'La file la plus longue de ce matin est à {place} : {n} minutes.',
    funJobs: 'En ce moment {companies} entreprises ont au moins une offre ouverte.',
    funFxWeek: 'Il y a sept jours, un franc valait {prev} €.',
  },
};

/**
 * The live page behind each block, as CANONICAL IT paths — `localizedUrl()`
 * resolves them per locale through LOCALE_PATH_MAP, the same map the weekly
 * newsletter, the onboarding drip and the welcome email already use. Spelling
 * the localized slugs out here would be a fourth copy of the route table.
 *
 * `jobs` points at the Switzerland-wide board, not the Ticino one: the block's
 * figures (`activeJobs`, `yesterdayAdded`) count every canton, so the TI board
 * would open on a shorter list than the number printed above the link. Same
 * reasoning the weekly's own "browse all jobs" CTA follows.
 */
const LIVE_PAGES = {
  border: '/traffico-dogane',
  fuel: '/prezzi-benzina/oggi',
  fx: '/compara-servizi/cambio-franco-euro',
  jobs: '/cerca-lavoro-svizzera',
};

const esc = (value) => String(value ?? '')
  .replace(/&/g, '&amp;')
  .replace(/</g, '&lt;')
  .replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;');

const fill = (template, values) =>
  String(template).replace(/\{(\w+)\}/g, (_, key) => (values[key] == null ? '' : String(values[key])));

/**
 * The edition's date, spelled out in the recipient's locale.
 * Parsed as UTC noon so a timezone shift can never move the label to the
 * neighbouring day — the label has to match the edition id.
 */
export function formatEditionDate(dateIso, locale) {
  const date = new Date(`${dateIso}T12:00:00Z`);
  if (Number.isNaN(date.getTime())) return dateIso;
  return new Intl.DateTimeFormat(DATE_LOCALE[locale] || 'it-IT', {
    weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC',
  }).format(date);
}

/** Localized decimal separator for the numbers in the blocks. */
const num = (value, digits, locale) =>
  new Intl.NumberFormat(DATE_LOCALE[locale] || 'it-IT', {
    minimumFractionDigits: digits, maximumFractionDigits: digits,
  }).format(value);

const int = (value, locale) => new Intl.NumberFormat(DATE_LOCALE[locale] || 'it-IT').format(value);

/** Whole days since the epoch for an edition date — the rotation index. */
const dayNumber = (dateIso) => {
  const ms = Date.parse(`${dateIso}T12:00:00Z`);
  return Number.isFinite(ms) ? Math.floor(ms / 86_400_000) : null;
};

/**
 * The one sentence that tells the recipient why this arrived today and how to
 * change that (issue #5415 §3.7: adaptive cadence is only acceptable with a
 * disclosed, effective opt-out). `tierDays` is the recipient's cadence in days.
 */
export function cadenceSentence(locale, tierDays) {
  const s = I18N[locale] || I18N.it;
  const days = Number(tierDays);
  const cadence = !Number.isFinite(days) || days <= 1
    ? s.cadenceDaily
    : days >= 7 ? s.cadenceWeekly : fill(s.cadenceEveryN, { n: days });
  return fill(s.cadenceNote, { cadence });
}

// ── The lead ───────────────────────────────────────────────────────────────

/**
 * How large a day-over-day move has to be, IN PERCENT OF ITS OWN BASELINE, to
 * be worth putting at the top of the message. One threshold per metric, because
 * the two metrics live on incomparable scales and "whichever percentage is
 * bigger" would hand the lead to the noisier one every single morning.
 *
 *   exchange  0.3 %  — EUR/CHF moves 0.05–0.2 % on an ordinary day (measured
 *                      2026-08-12: 1,0695 → 1,0694, i.e. 0,009 %). 0.3 % is a
 *                      day a frontaliere would actually notice on a salary.
 *   jobs       40 %  — new-listing counts swing hugely by weekday (measured
 *                      2026-08-12: 762 against a 7-day mean of 598, +27 %, an
 *                      unremarkable Tuesday). Below 40 % it is the weekly
 *                      rhythm, not news.
 *
 * BELOW THRESHOLD THERE IS NO LEAD BY MOVEMENT and the first available block in
 * reading order leads — border waits, which is what a commuter opens the
 * message for at 6 a.m.
 */
const LEAD_NOTABLE_PCT = { exchange: 0.3, jobs: 40 };

/**
 * Only `exchange` and `jobs` carry a previous-day baseline in `daily-brief.json`
 * (`prevRate`, `last7dAdded`). Fuel and border waits publish today's figure and
 * nothing to compare it with, so they cannot win the lead on movement — and a
 * baseline invented here to let them compete would be exactly the fabricated
 * `2.8% / CHF 467` this template was split off to get rid of. They lead by
 * reading order or not at all.
 *
 * Mutates and returns the array: exactly one section gets `lead: true`.
 */
export function markLead(sections) {
  let best = null;
  let bestRatio = 0;
  for (const section of sections) {
    const notable = LEAD_NOTABLE_PCT[section.key];
    if (!notable || !section.move || !Number.isFinite(section.move.pct)) continue;
    const ratio = section.move.pct / notable;
    if (ratio >= 1 && ratio > bestRatio) { best = section; bestRatio = ratio; }
  }
  const lead = best || sections[0];
  for (const section of sections) section.lead = section === lead;
  return sections;
}

// ── Section builders ───────────────────────────────────────────────────────

/**
 * The four blocks, in reading order, skipping whatever the corpus could not
 * measure this morning. Exported so a caller sees exactly the block set the
 * HTML renders — AND so the sender's own refusal gate can ask it directly
 * instead of trusting `brief.counts.availableBlocks` on faith (#5714 item 3).
 * `scripts/send-daily-brief.mjs:loadDayPayload` now calls this and overwrites
 * `brief.counts.availableBlocks` with the length it gets back before the
 * refusal check runs, so the payload's own count and the render can no longer
 * silently disagree about how thin a morning is — a divergence is logged, not
 * trusted.
 *
 * Reading order is stable regardless of which block leads: `buildDailyBriefEmail`
 * hoists the lead at render time, so callers that only care about availability
 * (the sender's refusal gate) keep seeing the same sequence they always did.
 */
export function briefSections(brief, locale, { utm = '' } = {}) {
  const s = I18N[locale] || I18N.it;
  // `localizedUrl` returns a bare path (no trailing slash) by design — the edge
  // 301s to the slashed form, same as every other lifecycle email.
  const link = (key) => `${localizedUrl(LIVE_PAGES[key], locale)}/${utm}`;
  const sections = [];

  const wait = brief?.blocks?.borderWait;
  if (wait?.available && wait.worst) {
    sections.push({
      key: 'borderWait',
      title: s.borderTitle,
      headline: `${wait.worst.waitMinutes} ${s.minutes}`,
      support: `${wait.worst.name} — ${fill(s.borderClear, { n: wait.zeroWaitCount, total: wait.count })}`,
      ctaLabel: s.borderCta,
      ctaUrl: link('border'),
      tone: wait.worst.waitMinutes >= 10 ? 'warn' : 'good',
      text: `${s.borderTitle}: ${wait.worst.name} ${wait.worst.waitMinutes} ${s.minutes} (${fill(s.borderClear, { n: wait.zeroWaitCount, total: wait.count })})`,
    });
  }

  const fuel = brief?.blocks?.fuel;
  const cheapest = fuel?.cheapestItaly?.[0];
  if (fuel?.available && cheapest) {
    const best = fuel.bestSavings?.[0];
    sections.push({
      key: 'fuel',
      title: s.fuelTitle,
      headline: `${num(cheapest.minPriceEur, 3, locale)} €/L`,
      support: `${s.fuelCheapest}: ${cheapest.municipality}${cheapest.province ? ` (${cheapest.province})` : ''}`
        + (best?.saving50LEur ? ` · ${fill(s.fuelSaving, { place: best.municipality })}: ${num(best.saving50LEur, 2, locale)} €` : ''),
      ctaLabel: s.fuelCta,
      ctaUrl: link('fuel'),
      text: `${s.fuelTitle}: ${num(cheapest.minPriceEur, 3, locale)} €/L — ${cheapest.municipality}`,
    });
  }

  const fx = brief?.blocks?.exchange;
  if (fx?.available && Number.isFinite(fx.rate)) {
    const delta = Number(fx.delta1d ?? 0);
    const prev = Number(fx.prevRate);
    sections.push({
      key: 'exchange',
      title: s.fxTitle,
      headline: `${num(fx.rate, 4, locale)} €`,
      support: s.fxLabel,
      ctaLabel: s.fxCta,
      ctaUrl: link('fx'),
      tone: delta > 0 ? 'good' : delta < 0 ? 'warn' : undefined,
      move: {
        dir: delta > 0 ? 'up' : delta < 0 ? 'down' : 'flat',
        label: delta === 0 ? s.flatShort : `${delta > 0 ? '+' : '-'}${num(Math.abs(delta), 4, locale)}`,
        compare: Number.isFinite(prev) ? fill(s.movedFrom, { prev: num(prev, 4, locale) }) : '',
        // Percent of the previous close, so a fourth-decimal wiggle scores as
        // the fraction of a percent it actually is.
        pct: Number.isFinite(prev) && prev !== 0 ? (Math.abs(delta) / prev) * 100 : 0,
      },
      // The movement is NOT spelled into `text`: the plain-text renderer appends
      // `move.label` + `move.compare` to every block that has one, and having it
      // here too printed the same delta twice on the exchange line.
      text: `${s.fxTitle}: ${s.fxLabel} = ${num(fx.rate, 4, locale)} €`,
    });
  }

  const jobs = brief?.blocks?.jobs;
  if (jobs?.available && Number.isFinite(jobs.yesterdayAdded)) {
    // The 7-day mean is the only previous-day baseline the payload carries for
    // jobs; without `last7dAdded` the block simply has no movement to show.
    const avg7 = Number.isFinite(jobs.last7dAdded) && jobs.last7dAdded > 0 ? jobs.last7dAdded / 7 : null;
    const diff = avg7 == null ? null : jobs.yesterdayAdded - avg7;
    sections.push({
      key: 'jobs',
      title: s.jobsTitle,
      headline: `+${int(jobs.yesterdayAdded, locale)}`,
      support: `${s.jobsYesterday} · ${fill(s.jobsActive, { n: int(jobs.activeJobs ?? 0, locale), companies: int(jobs.activeCompanies ?? 0, locale) })}`,
      ctaLabel: s.jobsCta,
      ctaUrl: link('jobs'),
      ...(diff == null ? {} : {
        move: {
          dir: diff > 0 ? 'up' : diff < 0 ? 'down' : 'flat',
          label: diff === 0 ? s.flatShort : `${diff > 0 ? '+' : '-'}${Math.round(Math.abs(diff) / avg7 * 100)}%`,
          compare: fill(s.vsAverage, { avg: int(Math.round(avg7), locale) }),
          pct: (Math.abs(diff) / avg7) * 100,
        },
      }),
      text: `${s.jobsTitle}: +${int(jobs.yesterdayAdded, locale)} — ${fill(s.jobsActive, { n: int(jobs.activeJobs ?? 0, locale), companies: int(jobs.activeCompanies ?? 0, locale) })}`,
    });
  }

  return markLead(sections);
}

/**
 * The line that is not a number (#5683).
 *
 * Every candidate is built from a figure the payload already carries and the
 * blocks already print — nothing is invented, and a missing block simply drops
 * its candidate. Which one runs is a function of the EDITION DATE, so it
 * rotates day to day (a different closing line is half the reason to open
 * tomorrow's) while a resend of the same edition reproduces the same message
 * byte for byte.
 *
 * @returns {string|null} null when no block could be measured
 */
export function dailyHighlight(brief, locale) {
  const s = I18N[locale] || I18N.it;
  const candidates = [];

  const fuel = brief?.blocks?.fuel;
  const best = fuel?.available ? fuel.bestSavings?.[0] : null;
  if (best?.saving50LEur) {
    candidates.push(fill(best.cheaperCountry === 'CH' ? s.funFuelCh : s.funFuelIt, {
      place: best.municipality, amount: num(best.saving50LEur, 2, locale),
    }));
  }

  const wait = brief?.blocks?.borderWait;
  if (wait?.available && Number.isFinite(wait.count) && Number.isFinite(wait.zeroWaitCount)) {
    candidates.push(wait.worst?.waitMinutes > 0
      ? fill(s.funBorderQueue, { place: wait.worst.name, n: wait.worst.waitMinutes })
      : fill(s.funBorderClear, { n: wait.zeroWaitCount, total: wait.count }));
  }

  const jobs = brief?.blocks?.jobs;
  if (jobs?.available && Number.isFinite(jobs.activeCompanies)) {
    candidates.push(fill(s.funJobs, { companies: int(jobs.activeCompanies, locale) }));
  }

  const fx = brief?.blocks?.exchange;
  if (fx?.available && Number.isFinite(fx.rate7dAgo)) {
    candidates.push(fill(s.funFxWeek, { prev: num(fx.rate7dAgo, 4, locale) }));
  }

  if (!candidates.length) return null;
  const day = dayNumber(brief?.dateIso);
  const index = day == null ? 0 : ((day % candidates.length) + candidates.length) % candidates.length;
  return candidates[index];
}

/** ▲ / ▼ / ■ — the direction, carried by a glyph so colour is never alone. */
const MOVE_GLYPH = { up: '▲', down: '▼', flat: '■' };

/** One block as a plain-text line, movement included when it has one. */
const textLine = (section) => section.text
  + (section.move ? ` (${section.move.label}${section.move.compare ? `, ${section.move.compare}` : ''})` : '');

/** Colour for a movement: green up, orange down, ink flat. */
const moveColor = (dir) => (dir === 'up' ? GOOD : dir === 'down' ? WARN : MUTED);
const moveClass = (dir) => (dir === 'up' ? 'fb-good' : dir === 'down' ? 'fb-warn' : 'fb-muted');

/**
 * THE LEAD BLOCK. Its own bright panel with an accent rule, a 40px number and
 * the movement immediately under it at 16px bold. Everything that sets a
 * background here also sets a colour — see the dark-mode note in the header.
 */
function leadBlock(section, s) {
  const toneColor = section.tone === 'warn' ? WARN : section.tone === 'good' ? GOOD : INK;
  // The dark-mode class has to match the light colour it overrides: tagging a
  // warn-toned number `fb-ink` would repaint it near-white in dark mode and
  // drop the tone the light version carries.
  const toneClass = section.tone === 'warn' ? 'fb-warn' : section.tone === 'good' ? 'fb-good' : 'fb-ink';
  const move = section.move;
  return `
      <tr><td class="fb-pad" style="padding:12px 28px 4px">
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" class="fb-lead" style="background:${CARD_BG};color:${TEXT};border:1px solid ${BORDER};border-left:4px solid ${ACCENT};border-radius:14px">
          <tr><td style="padding:20px 22px 18px">
            <div class="fb-muted" style="font:700 11px/1.2 ${SANS};letter-spacing:.12em;text-transform:uppercase;color:${MUTED}">${esc(section.title)} &middot; ${esc(s.leadEyebrow)}</div>
            <div class="${toneClass} fb-lead-num" style="margin:10px 0 0;font:800 40px/1.05 ${SANS};color:${toneColor}">${esc(section.headline)}</div>
            ${move ? `<div class="${moveClass(move.dir)}" style="margin:10px 0 0;font:700 17px/1.3 ${SANS};color:${moveColor(move.dir)}">${MOVE_GLYPH[move.dir]} ${esc(move.label)}${move.compare ? `<span class="fb-muted" style="font:400 14px/1.3 ${SANS};color:${MUTED}"> &nbsp;${esc(move.compare)}</span>` : ''}</div>` : ''}
            ${section.support ? `<div class="fb-text" style="margin:8px 0 0;font:400 15px/1.5 ${SANS};color:${TEXT}">${esc(section.support)}</div>` : ''}
            <div style="margin:16px 0 0"><a class="fb-link" href="${esc(section.ctaUrl)}" style="font:700 14px/1.2 ${SANS};color:${ACCENT};text-decoration:underline">${esc(section.ctaLabel)} &rarr;</a></div>
          </td></tr>
        </table>
      </td></tr>`;
}

/**
 * THE SUPPORTING BLOCKS. One recessed panel, hairline-separated rows, numbers
 * at 20px against the lead's 40px. Single column on purpose: a two-column row
 * at 600px becomes two cramped columns at 320px in clients that ignore the
 * media query, and the hierarchy here is carried by size, not by position.
 */
function supportBlocks(sections) {
  if (!sections.length) return '';
  const rows = sections.map((section, index) => {
    const move = section.move;
    return `
            <tr><td class="fb-rule" style="padding:14px 18px;${index ? `border-top:1px solid ${BORDER};` : ''}color:${TEXT}">
              <div class="fb-muted" style="font:700 11px/1.2 ${SANS};letter-spacing:.1em;text-transform:uppercase;color:${MUTED}">${esc(section.title)}</div>
              <div style="margin:5px 0 0">
                <span class="fb-ink" style="font:800 20px/1.25 ${SANS};color:${INK}">${esc(section.headline)}</span>${move ? `<span class="${moveClass(move.dir)}" style="font:700 14px/1.25 ${SANS};color:${moveColor(move.dir)}">&nbsp;&nbsp;${MOVE_GLYPH[move.dir]} ${esc(move.label)}</span>` : ''}
              </div>
              ${section.support || move?.compare ? `<div class="fb-text" style="margin:5px 0 0;font:400 13px/1.5 ${SANS};color:${TEXT}">${esc([section.support, move?.compare].filter(Boolean).join(' · '))}</div>` : ''}
              <div style="margin:9px 0 0"><a class="fb-link" href="${esc(section.ctaUrl)}" style="font:600 13px/1.2 ${SANS};color:${ACCENT};text-decoration:underline">${esc(section.ctaLabel)} &rarr;</a></div>
            </td></tr>`;
  }).join('');

  return `
      <tr><td class="fb-pad" style="padding:12px 28px 4px">
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" class="fb-panel" style="background:${PANEL_BG};color:${TEXT};border:1px solid ${BORDER};border-radius:12px">${rows}
        </table>
      </td></tr>`;
}

/**
 * Build the bulletin email.
 *
 * @param {object} data
 * @param {'it'|'en'|'de'|'fr'} data.locale
 * @param {object} data.brief             the day's payload (`daily-brief.json`)
 * @param {string} data.editionUrl        the edition's page for this locale
 * @param {string} data.editionTitle      the edition's own title — also the subject
 * @param {string} [data.recipientName]   already sanitized by the caller
 * @param {number} [data.cadenceDays]     the recipient's cadence, for the disclosure line
 * @param {string} data.unsubscribeUrl    one-click endpoint (NOT the SPA form)
 * @param {string} data.preferencesUrl
 * @returns {{ html: string, text: string, preheader: string }}
 */
export function buildDailyBriefEmail(data) {
  const locale = LOCALES.includes(data.locale) ? data.locale : nlNormLocale(data.locale);
  const s = I18N[locale] || I18N.it;
  const brief = data.brief || {};
  const utm = '?utm_source=daily-brief&utm_medium=email&utm_campaign=bollettino';
  const editionUrl = data.editionUrl ? `${data.editionUrl}${data.editionUrl.includes('?') ? '&' : '?'}${utm.slice(1)}` : BASE_URL;
  const editionDate = formatEditionDate(brief.dateIso, locale);
  const sections = briefSections(brief, locale, { utm });
  const lead = sections.find((section) => section.lead) || null;
  const rest = sections.filter((section) => section !== lead);
  const greeting = data.recipientName ? fill(s.greetingNamed, { name: data.recipientName }) : s.greeting;
  const cadence = cadenceSentence(locale, data.cadenceDays);
  const highlight = dailyHighlight(brief, locale);

  // The inbox preview line. Date first (the edition's identity), then the LEAD
  // and its movement — the one thing that is different from yesterday — then
  // the rest. The weekly's preheader was the article title.
  const preheader = [
    editionDate,
    ...(lead ? [`${lead.title} ${lead.headline}${lead.move ? ` (${MOVE_GLYPH[lead.move.dir]} ${lead.move.label})` : ''}`] : []),
    ...rest.map((section) => `${section.title} ${section.headline}`),
  ].join(' · ');

  const html = `<!DOCTYPE html>
<html lang="${locale}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="light dark">
<meta name="supported-color-schemes" content="light dark">
<title>${esc(data.editionTitle || `${s.masthead} — ${editionDate}`)}</title>
<style>
  body { margin:0; padding:0; width:100% !important; }
  table { border-collapse:collapse; }
  a { color:${ACCENT}; }
  @media only screen and (max-width:480px) {
    .fb-pad { padding-left:18px !important; padding-right:18px !important; }
    .fb-lead-num { font-size:34px !important; }
    .fb-pill-cell { display:block !important; width:100% !important; padding:0 0 8px 0 !important; }
    .fb-pill { display:block !important; text-align:center !important; }
  }
  /* Apple Mail / iOS honour this; Outlook and Gmail Android force their own
     transform instead, which the light palette above is built to survive. */
  @media (prefers-color-scheme: dark) {
    .fb-page { background:#0b1220 !important; }
    .fb-card { background:#111c2e !important; }
    .fb-lead { background:#152238 !important; border-color:#2b3d5b !important; border-left-color:#60a5fa !important; }
    .fb-panel, .fb-foot { background:#16233a !important; border-color:#2b3d5b !important; }
    .fb-note { background:#152238 !important; border-left-color:#3b82f6 !important; }
    .fb-rule { border-top-color:#2b3d5b !important; }
    .fb-ink { color:#e8eef7 !important; }
    .fb-text { color:#cbd5e1 !important; }
    .fb-muted { color:#94a3b8 !important; }
    .fb-link { color:#7dd3fc !important; }
    .fb-good { color:#4ade80 !important; }
    .fb-warn { color:#fb923c !important; }
    .fb-pill { background:#152238 !important; border-color:#4b6383 !important; color:#e8eef7 !important; }
  }
</style>
</head>
<body class="fb-page" style="margin:0;padding:0;background:${PAGE_BG};color:${TEXT}">
<div style="display:none;max-height:0;overflow:hidden;opacity:0;color:transparent">${esc(preheader)}</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" class="fb-page" style="background:${PAGE_BG};color:${TEXT}">
  <tr><td align="center" style="padding:24px 12px">
    <table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0" class="fb-card" style="width:600px;max-width:100%;background:${CARD_BG};color:${TEXT};border-radius:16px;overflow:hidden">

      <tr><td class="fb-pad" style="background:${INK};color:#ffffff;padding:22px 28px">
        <div style="font:700 11px/1.2 ${SANS};letter-spacing:.16em;text-transform:uppercase;color:#8fb0d6">${esc(s.brand)}</div>
        <div style="margin:7px 0 0;font:800 22px/1.2 ${SANS};color:#ffffff">${esc(s.masthead)}</div>
        <div style="margin:5px 0 0;font:400 13px/1.4 ${SANS};color:#b9cbe4">${esc(editionDate)}</div>
      </td></tr>
      <tr><td class="fb-pad" style="background:${INK_SOFT};color:#cddcef;padding:9px 28px;font:400 12px/1.4 ${SANS}">${esc(s.tagline)}</td></tr>

      <tr><td class="fb-pad" style="padding:22px 28px 4px">
        <div class="fb-ink" style="font:700 16px/1.4 ${SANS};color:${INK}">${esc(greeting)}</div>
      </td></tr>

${lead ? leadBlock(lead, s) : ''}${supportBlocks(rest)}
${highlight ? `
      <tr><td class="fb-pad" style="padding:14px 28px 2px">
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" class="fb-note" style="background:${NOTE_BG};color:${TEXT};border-left:3px solid ${NOTE_RULE};border-radius:0 10px 10px 0">
          <tr><td style="padding:14px 18px">
            <div class="fb-muted" style="font:700 11px/1.2 ${SANS};letter-spacing:.12em;text-transform:uppercase;color:${MUTED}">${esc(s.goodToKnow)}</div>
            <div class="fb-ink" style="margin:6px 0 0;font:400 15px/1.55 ${SANS};color:${INK}">${esc(highlight)}</div>
          </td></tr>
        </table>
      </td></tr>` : ''}

      <tr><td class="fb-pad" style="padding:18px 28px 4px">
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
          <tr><td align="center" bgcolor="${ACCENT_BTN}" style="background:${ACCENT_BTN};color:#ffffff;border-radius:10px">
            <a href="${esc(editionUrl)}" style="display:block;padding:14px 18px;color:#ffffff;font:800 15px/1.2 ${SANS};text-decoration:none">${esc(s.editionCta)}</a>
          </td></tr>
        </table>
      </td></tr>
      <tr><td class="fb-pad fb-muted" style="padding:12px 28px 22px;font:400 13px/1.6 ${SANS};color:${MUTED}">${esc(s.editionNote)}</td></tr>

      <tr><td class="fb-pad fb-foot" style="border-top:1px solid ${BORDER};padding:20px 28px 24px;background:${PANEL_BG};color:${TEXT}">
        <div class="fb-text" style="font:400 13px/1.6 ${SANS};color:${TEXT}">${esc(cadence)}</div>
        <div class="fb-ink" style="margin:14px 0 9px;font:700 13px/1.5 ${SANS};color:${INK}">${esc(s.unsubTitle)}</div>
        <table role="presentation" cellpadding="0" cellspacing="0" border="0">
          <tr>
            <td class="fb-pill-cell" style="padding:0 8px 0 0">
              <a class="fb-pill" href="${esc(data.preferencesUrl)}" style="display:inline-block;padding:11px 16px;background:${CARD_BG};color:${INK};border:1px solid #cbd5e1;border-radius:10px;font:700 14px/1.2 ${SANS};text-decoration:none">${esc(s.preferences)}</a>
            </td>
            <td class="fb-pill-cell" style="padding:0">
              <a class="fb-pill" href="${esc(data.unsubscribeUrl)}" style="display:inline-block;padding:11px 16px;background:${CARD_BG};color:${INK};border:1px solid #cbd5e1;border-radius:10px;font:700 14px/1.2 ${SANS};text-decoration:underline">${esc(s.unsubscribe)}</a>
            </td>
          </tr>
        </table>
        <div class="fb-text" style="margin:16px 0 0;font:400 12px/1.6 ${SANS};color:${TEXT}">${esc(dataControllerFooterLine(locale))}</div>
        <div class="fb-muted" style="margin:4px 0 0;font:400 12px/1.6 ${SANS};color:${MUTED}">${esc(s.footer)}</div>
      </td></tr>

    </table>
  </td></tr>
</table>
</body>
</html>`;

  const text = [
    `${s.masthead} — ${editionDate}`,
    '',
    greeting,
    '',
    // The lead first here too, and marked with a different bullet, so the
    // plain-text part carries the same hierarchy the HTML does rather than a
    // flat list. No glyphs: the sign inside `move.label` says the direction.
    ...(lead ? [`* ${textLine(lead)}`] : []),
    ...rest.map((section) => `- ${textLine(section)}`),
    ...(highlight ? ['', `${s.goodToKnow}: ${highlight}`] : []),
    '',
    `${s.editionCta}: ${editionUrl}`,
    '',
    s.editionNote,
    '',
    cadence,
    `${s.preferences}: ${data.preferencesUrl}`,
    `${s.unsubscribe}: ${data.unsubscribeUrl}`,
    '',
    dataControllerFooterLine(locale),
    s.footer,
  ].join('\n');

  return { html, text, preheader };
}

export { I18N as DAILY_BRIEF_STRINGS };
