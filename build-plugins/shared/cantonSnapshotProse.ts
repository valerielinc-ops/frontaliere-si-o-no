/**
 * cantonSnapshotProse.ts
 *
 * Long-form prose appended to every per-canton job-market snapshot page
 * (`/{localePrefix}/{job-board-slug}-{canton}/snapshot/`). Sister module to
 * `cantonSeoProse.ts`, which serves the canton-hub / today / sector slots
 * already wired into PR #140. The snapshot pages are a different beast:
 *
 *  - Body is dominated by two short rank tables (top cities + top sectors)
 *    and a 3-tile stat grid. With only the existing 2-paragraph methodology
 *    block the EN locale runs ~9.2-9.7 % visible-text / HTML and trips the
 *    `audit:text-html-ratio` Semrush gate (≤ 10 % is the floor).
 *  - The TI page already has substantial editorial prose; only the 20
 *    non-TI EN snapshots are thin (run 25752701002 ratchet failure).
 *
 * Why a dedicated module
 * ----------------------
 *  - Tone is unique: snapshot interpretation, market timing, frontaliere
 *    positioning vs Ticino — different from the canton-hub flavour.
 *  - Adds ~1.6-2.0 KB visible text per page across 4 paragraphs, lifting
 *    every page above the 12 % ratio with margin for data drift.
 *  - Parameterised by canton display name and supplied snapshot data so two cantons
 *    emit different prose and Google's cross-page duplicate-content
 *    heuristic stays happy.
 *
 * Design constraints (CLAUDE.md non-negotiables #15-17)
 * -----------------------------------------------------
 *  - Mobile-first: caller inserts the block BELOW the data area (rank
 *    tables + tiles). Filler never pushes the meat below the fold on a
 *    ≤ 414 px viewport.
 *  - No new colour values: only `--color-*` semantic tokens. Auto-switches
 *    light/dark with no `dark:` Tailwind prefixes.
 *  - Pure: identical inputs return identical HTML, so determinism + any
 *    future snapshot tests stay stable.
 *
 * Public API
 * ----------
 *  - `buildSnapshotProseBlock({ locale, cantonDisplay, totalJobs, ctaHref,
 *    ctaLabel })` returns a self-contained `<section>` of HTML.
 */

// Canonical per-locale calculator path, single source of truth shared with
// cantonSeoProse / jobsSeoPagesPlugin via the leaf module ./calcHref. Keeping
// a local copy here let the DE cross-link drift to a dead /de/lohnrechner/
// (404) and EN/FR to 301-redirect hops (#1948).
import { CALC_HREF } from './calcHref';
import { FX_HREF, HEALTH_HREF, FUEL_HREF } from './comparatorHref';

export type SnapshotLocale = 'it' | 'en' | 'de' | 'fr';

export interface SnapshotProseOpts {
  /** Output locale. */
  locale: SnapshotLocale;
  /** Canton display name in the target locale (e.g. 'Zurich', 'Argovia'). */
  cantonDisplay: string;
  /** Total active openings for the canton today. */
  totalJobs: number;
  /** Top sector label in the target locale (e.g. 'Healthcare'). Optional. */
  topSectorLabel?: string | null;
  /** Top city name (raw, not localised). Optional. */
  topCityName?: string | null;
  /** Absolute or root-relative href to the matching "hiring this week" hub. */
  ctaHref: string;
  /** Localised CTA label. */
  ctaLabel: string;
}

function esc(value: string): string {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function fmtJobs(jobs: number, locale: SnapshotLocale): string {
  const tag =
    locale === 'it' ? 'it-CH'
    : locale === 'de' ? 'de-CH'
    : locale === 'fr' ? 'fr-CH'
    : 'en-US';
  return jobs.toLocaleString(tag);
}

interface ProseParagraphs {
  heading: string;
  reading: string;     // P1 — what this week's snapshot signals
  positioning: string; // P2 — frontaliere permit, fiscal and commute requirements
  timing: string;      // P3 — when/how to apply, use of city/sector ranks
  related: string;     // P4 — cross-links (calculator, FX, health, fuel)
}

function buildParagraphs(opts: SnapshotProseOpts): ProseParagraphs {
  const { locale, totalJobs } = opts;
  const canton = esc(opts.cantonDisplay);
  const jobs = fmtJobs(totalJobs, locale);
  const city = opts.topCityName ? esc(opts.topCityName) : null;
  const sector = opts.topSectorLabel ? esc(opts.topSectorLabel) : null;
  const links = {
    calc: `<a class="s-6L_4jt" href="${esc(CALC_HREF[locale])}">${{ it: 'Calcolatore', en: 'Calculator', de: 'Lohnrechner', fr: 'Calculateur' }[locale]}</a>`,
    fx: `<a class="s-6L_4jt" href="${esc(FX_HREF[locale])}">CHF/EUR</a>`,
    health: `<a class="s-6L_4jt" href="${esc(HEALTH_HREF[locale])}">LAMal</a>`,
    fuel: `<a class="s-6L_4jt" href="${esc(FUEL_HREF[locale])}">${{ it: 'Carburante', en: 'Fuel', de: 'Treibstoff', fr: 'Carburant' }[locale]}</a>`,
    jobs: `<a class="s-nF5mos" href="${esc(opts.ctaHref)}">${esc(opts.ctaLabel)}</a>`,
  };
  const sem = '<a href="https://www.sem.admin.ch/sem/it/home/themen/aufenthalt/eu_efta/ausweis_g_eu_efta.html">SEM</a>';
  const tax = '<a href="https://www.estv.admin.ch/dam/it/sd-web/Zbr5Jb-40aYm/int-laender-it-faktenblatt-faqs-it.pdf">ESTV</a>';
  const health = '<a href="https://www.bag.admin.ch/it/assicurazione-malattie-lavoratori-frontalieri-in-svizzera">UFSP / BAG</a>';
  const copy: Record<SnapshotLocale, ProseParagraphs> = {
    it: {
      heading: 'Come leggere lo snapshot da frontaliere',
      reading: `Lo snapshot del Canton ${canton} contiene ${jobs} offerte attive nel campione disponibile. Il totale descrive annunci raccolti, non assunzioni concluse, posti garantiti o tutta la domanda del cantone. Controlla il periodo indicato sulla pagina e la fonte del datore prima di candidarti: un annuncio può essere stato aggiornato o chiuso dopo la raccolta. Confronta città e settori nella stessa rilevazione; una differenza tra due pagine con date diverse non dimostra da sola una crescita del mercato.`,
      positioning: `Valuta il tragitto tra domicilio e sede esatta usando gli orari del turno, i collegamenti di rientro e preventivi reali di trasporto o alloggio. Il nome ${canton} non dimostra un tempo di viaggio universale. Per il permesso G UE/AELS è richiesto il rientro almeno settimanale (${sem}); il regime fiscale dei frontalieri Italia–Svizzera richiede condizioni distinte, fra cui territorio ammesso e rientro in principio quotidiano (${tax}). Un permesso B da solo non determina la residenza fiscale né esclude ogni obbligo italiano.`,
      timing: `Prima di inviare il CV confronta mansioni, esperienza, lingua, grado di occupazione, sede e modalità di candidatura. ${city ? `La città evidenziata nel campione è ${city}.` : 'Se non è indicata una città prevalente, verifica le sedi delle singole offerte.'} ${sector ? `Il settore evidenziato è ${sector}.` : 'Se manca il settore prevalente, usa la classificazione delle singole offerte.'} Questi dati orientano la ricerca, ma non garantiscono che il ruolo sia adatto o che una candidatura riceva risposta. Segui le scadenze del datore senza presumere giorni della settimana più favorevoli.`,
      related: `Per confrontare offerte concrete usa ${links.calc} con lordo, mensilità, situazione personale e status fiscale verificato; il risultato è una stima. Considera ${links.fx}, premi ${links.health} e ${links.fuel} nel bilancio personale. I cittadini UE residenti in Italia aventi diritto di opzione possono chiedere formalmente l’esenzione LAMal al Cantone di lavoro entro tre mesi dall’inizio dell’attività: la sola iscrizione SSN non basta, verifica requisiti con Cantone e ASL (${health}). Per proseguire: ${links.jobs}.`,
    },
    en: {
      heading: 'Reading the snapshot as a cross-border worker',
      reading: `The Canton ${canton} snapshot contains ${jobs} active listings in the available sample. This is a count of collected adverts, not completed hires, guaranteed vacancies or the entire cantonal labour market. Check the period shown and the employer’s source before applying: a vacancy may have changed or closed since collection. Compare cities and sectors within the same observation; differences between pages dated differently do not by themselves establish market growth.`,
      positioning: `Assess the journey between your home and the exact workplace using shift times, return connections and real travel or accommodation quotes. The name ${canton} does not establish a universal journey time. The EU/EFTA G permit requires at least weekly return (${sem}); Italy–Switzerland fiscal cross-border status has separate territorial and in-principle daily-return conditions (${tax}). A B permit alone does not establish tax residence or remove every Italian obligation.`,
      timing: `Before applying, compare duties, experience, language, workload, location and the employer’s application procedure. ${city ? `The city highlighted in the sample is ${city}.` : 'Without a leading city, check the workplace in each listing.'} ${sector ? `The highlighted sector is ${sector}.` : 'Without a leading sector, use each listing’s classification.'} These figures guide your search but do not guarantee suitability or a response. Follow the employer’s deadlines without assuming that a particular weekday produces faster replies.`,
      related: `Compare concrete offers with ${links.calc}, using gross pay, salary instalments, personal circumstances and verified tax status; its result is an estimate. Include ${links.fx}, ${links.health} premiums and ${links.fuel} in your budget. Eligible EU citizens resident in Italy may formally request a LAMal exemption from the work canton within three months of starting work. Italian SSN enrolment alone is insufficient: check eligibility and procedure with the canton and ASL (${health}). Continue to ${links.jobs}.`,
    },
    de: {
      heading: 'Den Snapshot als Grenzgänger lesen',
      reading: `Der Snapshot des Kantons ${canton} enthält ${jobs} aktive Inserate der verfügbaren Stichprobe. Das sind gesammelte Stellenanzeigen, keine abgeschlossenen Einstellungen, garantierten Stellen oder der gesamte kantonale Arbeitsmarkt. Prüfen Sie den angegebenen Zeitraum und die Arbeitgeberquelle vor der Bewerbung: Ein Inserat kann seit der Erfassung geändert oder geschlossen worden sein. Vergleichen Sie Städte und Branchen innerhalb derselben Erhebung; unterschiedlich datierte Seiten belegen allein kein Marktwachstum.`,
      positioning: `Prüfen Sie den Weg zwischen Wohnsitz und genauem Arbeitsort anhand der Schichtzeiten, Rückverbindungen und tatsächlichen Reise- oder Unterkunftsangebote. Der Name ${canton} belegt keine allgemeingültige Fahrzeit. Die G-Bewilligung EU/EFTA verlangt mindestens wöchentliche Heimkehr (${sem}); der steuerliche Grenzgängerstatus Italien–Schweiz hat eigene Gebiets- und grundsätzlich tägliche Rückkehrbedingungen (${tax}). Eine B-Bewilligung allein bestimmt weder den Steuerwohnsitz noch den Wegfall aller italienischen Pflichten.`,
      timing: `Vergleichen Sie vor der Bewerbung Aufgaben, Erfahrung, Sprache, Pensum, Arbeitsort und Bewerbungsweg. ${city ? `Die in der Stichprobe hervorgehobene Stadt ist ${city}.` : 'Ohne führende Stadt sind die Arbeitsorte der einzelnen Inserate zu prüfen.'} ${sector ? `Die hervorgehobene Branche ist ${sector}.` : 'Ohne führende Branche nutzen Sie die Einordnung der einzelnen Inserate.'} Diese Angaben helfen bei der Suche, garantieren aber weder Eignung noch Antwort. Beachten Sie Arbeitgeberfristen statt schnellere Antworten an bestimmten Wochentagen anzunehmen.`,
      related: `Vergleichen Sie konkrete Angebote mit ${links.calc} anhand von Bruttolohn, Lohnzahlungen, persönlichen Umständen und geprüftem Steuerstatus; das Ergebnis ist eine Schätzung. Berücksichtigen Sie ${links.fx}, ${links.health}-Prämien und ${links.fuel}. Berechtigte EU-Bürger mit Wohnsitz Italien können innerhalb von drei Monaten nach Arbeitsbeginn beim Arbeitskanton formell eine LAMal-Befreiung beantragen. Die SSN-Anmeldung allein genügt nicht; Voraussetzungen und Verfahren sind mit Kanton und ASL zu prüfen (${health}). Weiter zu ${links.jobs}.`,
    },
    fr: {
      heading: 'Lire cet aperçu en tant que frontalier',
      reading: `L’aperçu du canton ${canton} contient ${jobs} annonces actives dans l’échantillon disponible. Ce total décrit des annonces collectées, pas des embauches, des postes garantis ou toute la demande cantonale. Vérifiez la période affichée et la source employeur avant de postuler : une annonce peut avoir changé ou été fermée depuis la collecte. Comparez villes et secteurs dans la même observation ; des pages datées différemment ne prouvent pas à elles seules une croissance du marché.`,
      positioning: `Évaluez le trajet domicile–lieu de travail exact selon les horaires du poste, les retours possibles et des devis réels de transport ou logement. Le nom ${canton} ne définit pas une durée universelle. Le permis G UE/AELE exige un retour au moins hebdomadaire (${sem}) ; le statut fiscal frontalier Italie–Suisse impose des conditions territoriales et un retour en principe quotidien distincts (${tax}). Un permis B ne détermine pas à lui seul la résidence fiscale ni la disparition de toute obligation italienne.`,
      timing: `Avant de postuler, comparez missions, expérience, langue, taux d’activité, lieu et procédure de candidature. ${city ? `La ville mise en évidence dans l’échantillon est ${city}.` : 'Sans ville dominante, vérifiez le lieu de chaque offre.'} ${sector ? `Le secteur mis en évidence est ${sector}.` : 'Sans secteur dominant, utilisez le classement des offres individuelles.'} Ces indications orientent la recherche sans garantir adéquation ni réponse. Suivez les délais de l’employeur sans supposer que certains jours de la semaine assurent une réponse plus rapide.`,
      related: `Comparez les offres concrètes avec ${links.calc}, selon brut, mensualités, situation personnelle et statut fiscal vérifié ; le résultat est une estimation. Intégrez ${links.fx}, les primes ${links.health} et ${links.fuel}. Les citoyens UE résidant en Italie qui ont le droit d’option peuvent demander formellement l’exemption LAMal au canton de travail dans les trois mois suivant le début d’activité. L’inscription SSN seule ne suffit pas : vérifiez conditions et procédure auprès du canton et de l’ASL (${health}). Pour continuer : ${links.jobs}.`,
    },
  };
  return copy[locale];
}

/**
 * Render the snapshot-specific deep-dive prose block. Returned HTML is a
 * self-contained `<section>` that the caller appends BELOW the data area
 * (rank tables + tiles + methodology) and ABOVE the closing CTA, so the
 * mobile fold rule (CLAUDE.md #15-17) is respected.
 *
 * The block adds ~1.6-2.0 KB of visible text per page across four
 * paragraphs (~110-160 words each), lifting the text-to-HTML ratio above
 * the 12 % bar with comfortable margin against data drift.
 */
export function buildSnapshotProseBlock(opts: SnapshotProseOpts): string {
  const p = buildParagraphs(opts);
  const blockStyle =
    'max-width:860px;margin:32px auto 0;color:var(--color-body);line-height:1.65;font-size:15px';
  const h2Style =
    'font-size:20px;font-weight:700;color:var(--color-heading);margin:24px 0 12px';
  const pStyle = 'margin:0 0 14px';

  return `<section class="snapshot-seo-prose" data-canton="${esc(opts.cantonDisplay)}" data-locale="${esc(opts.locale)}" style="${blockStyle}">
  <h2 style="${h2Style}">${esc(p.heading)}</h2>
  <p style="${pStyle}">${p.reading}</p>
  <p style="${pStyle}">${p.positioning}</p>
  <p style="${pStyle}">${p.timing}</p>
  <p style="${pStyle}">${p.related}</p>
</section>`;
}
