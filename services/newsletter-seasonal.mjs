/**
 * Seasonal utility content (#4299) — the third content type the issue's
 * action plan calls for alongside "new jobs by interest/location" and
 * "winner articles per cluster": time-of-year-relevant utility tools/guides
 * for the `utility` interest cohort (subscribers acquired via TaxCalendar,
 * calculators, comparisons, tax/life/glossary pages — see
 * services/newsletter-segments.mjs's inferInterest/UTILITY_ROUTE_FAMILIES).
 *
 * Pure, dependency-free, deterministic-by-month (no randomness, no fs/net
 * access) so it is unit-testable with a fixed Date and reusable by both
 * scripts/send-newsletter.mjs (regular hot_utility/warm_utility sends) and
 * any future reporting. Every slug below is a REAL, existing top-level route
 * (see services/router.ts SLUG_TABLES) — not a placeholder page.
 *
 * Calendar is 6 two-month buckets covering all 12 months, each picked for
 * genuine seasonal relevance to Ticino/Lombardy cross-border workers:
 *   Jan-Feb  TFR/severance calculator      — new-year job-change season
 *   Mar-Apr  Italian tax return guide      — Modello 730 precompilato season
 *   May-Jun  Salary calculator             — mid-year raise/contract-renewal check
 *   Jul-Aug  Permit (B/G) quiz             — summer admin catch-up
 *   Sep-Oct  3rd pillar simulator          — CHF 7,258 (2026) 3a deadline is Dec 31; plan ahead
 *   Nov-Dec  Tredicesima (13th salary) calc — the 13th-month payout itself lands in Nov/Dec
 */

import { localePathPrefix } from '../scripts/lib/articleContent.mjs';
import { SLUG_TABLES } from './routeSlugs.data.ts';

// Derived subset of the shared SLUG_TABLES (#4315) — only these 7 stable
// slugs are needed here.
const SLUGS = {
  it: {
    fisco: SLUG_TABLES.it.fisco,
    taxReturnItalia: SLUG_TABLES.it.taxReturnItalia,
    calcolatore: SLUG_TABLES.it.calcolatore,
    tfrCalculator: SLUG_TABLES.it.tfrCalculator,
    permitQuiz: SLUG_TABLES.it.permitQuiz,
    pillar3: SLUG_TABLES.it.pillar3,
    tredicesima: SLUG_TABLES.it.tredicesima,
  },
  en: {
    fisco: SLUG_TABLES.en.fisco,
    taxReturnItalia: SLUG_TABLES.en.taxReturnItalia,
    calcolatore: SLUG_TABLES.en.calcolatore,
    tfrCalculator: SLUG_TABLES.en.tfrCalculator,
    permitQuiz: SLUG_TABLES.en.permitQuiz,
    pillar3: SLUG_TABLES.en.pillar3,
    tredicesima: SLUG_TABLES.en.tredicesima,
  },
  de: {
    fisco: SLUG_TABLES.de.fisco,
    taxReturnItalia: SLUG_TABLES.de.taxReturnItalia,
    calcolatore: SLUG_TABLES.de.calcolatore,
    tfrCalculator: SLUG_TABLES.de.tfrCalculator,
    permitQuiz: SLUG_TABLES.de.permitQuiz,
    pillar3: SLUG_TABLES.de.pillar3,
    tredicesima: SLUG_TABLES.de.tredicesima,
  },
  fr: {
    fisco: SLUG_TABLES.fr.fisco,
    taxReturnItalia: SLUG_TABLES.fr.taxReturnItalia,
    calcolatore: SLUG_TABLES.fr.calcolatore,
    tfrCalculator: SLUG_TABLES.fr.tfrCalculator,
    permitQuiz: SLUG_TABLES.fr.permitQuiz,
    pillar3: SLUG_TABLES.fr.pillar3,
    tredicesima: SLUG_TABLES.fr.tredicesima,
  },
};

function norm(locale) {
  const l = String(locale || 'it').slice(0, 2).toLowerCase();
  return SLUGS[l] ? l : 'it';
}

// path(l, ...segments) builds a trailing-slash-terminated relative path from
// the locale prefix + one or more of this locale's stable slugs.
function path(l, ...slugKeys) {
  const prefix = localePathPrefix(l);
  const table = SLUGS[l];
  return `${prefix}/${slugKeys.map((k) => table[k]).join('/')}/`;
}

const COPY = {
  it: [
    { title: 'Cambio lavoro? Calcola subito il tuo TFR', excerpt: 'Stai valutando un nuovo impiego a inizio anno? Simula la liquidazione prima di firmare.', slugKeys: ['tfrCalculator'] },
    { title: 'Dichiarazione dei redditi in Italia: la guida frontalieri', excerpt: 'Il 730 precompilato si avvicina: cosa dichiarare, cosa detrarre, le scadenze da non perdere.', slugKeys: ['fisco', 'taxReturnItalia'] },
    { title: 'Stipendio in linea col mercato? Verificalo in 2 minuti', excerpt: 'Metà anno è il momento giusto per un confronto: calcola il tuo netto e confrontalo col tuo settore.', slugKeys: ['calcolatore'] },
    { title: 'Permesso B o G: fai il quiz e verifica la tua situazione', excerpt: 'Rinnovi, cambi di stato, novità normative: 5 domande per capire dove sei messo.', slugKeys: ['permitQuiz'] },
    { title: 'Terzo pilastro: ottimizza le tasse prima di dicembre', excerpt: 'La deduzione 3a per il 2026 arriva fino a 7.258 CHF — pianifica il versamento in tempo.', slugKeys: ['fisco', 'pillar3'] },
    { title: 'Tredicesima in arrivo: calcola quanto ti spetta', excerpt: 'Netto, lordo, contributi: simula la tua tredicesima prima che arrivi in busta paga.', slugKeys: ['tredicesima'] },
  ],
  en: [
    { title: 'Changing jobs? Calculate your TFR severance now', excerpt: 'Weighing a new role at the start of the year? Simulate your severance pay before you sign.', slugKeys: ['tfrCalculator'] },
    { title: 'Italian tax return: the cross-border workers’ guide', excerpt: 'The pre-filled 730 season is coming: what to declare, what to deduct, and the deadlines to watch.', slugKeys: ['fisco', 'taxReturnItalia'] },
    { title: 'Is your salary still in line with the market?', excerpt: 'Mid-year is a good time for a check: calculate your net pay and compare it to your sector.', slugKeys: ['calcolatore'] },
    { title: 'Permit B or G: take the quiz and check your status', excerpt: 'Renewals, status changes, new rules: 5 questions to see where you stand.', slugKeys: ['permitQuiz'] },
    { title: 'Third pillar: optimize your taxes before December', excerpt: 'The 2026 pillar 3a deduction goes up to CHF 7,258 — plan your contribution in time.', slugKeys: ['fisco', 'pillar3'] },
    { title: 'Thirteenth salary is coming: calculate what you’re owed', excerpt: 'Net, gross, contributions: simulate your thirteenth salary before it lands in your payslip.', slugKeys: ['tredicesima'] },
  ],
  de: [
    { title: 'Jobwechsel? Berechne jetzt deine TFR-Abfindung', excerpt: 'Denkst du zu Jahresbeginn über einen neuen Job nach? Simuliere die Abfindung, bevor du unterschreibst.', slugKeys: ['tfrCalculator'] },
    { title: 'Steuererklärung in Italien: der Grenzgänger-Guide', excerpt: 'Die Saison des vorausgefüllten 730 beginnt: was du angeben, absetzen und welche Fristen du beachten musst.', slugKeys: ['fisco', 'taxReturnItalia'] },
    { title: 'Ist dein Lohn noch marktgerecht?', excerpt: 'Zur Jahresmitte lohnt sich ein Check: berechne deinen Nettolohn und vergleiche ihn mit deiner Branche.', slugKeys: ['calcolatore'] },
    { title: 'Bewilligung B oder G: mach den Quiz und prüfe deinen Status', excerpt: 'Verlängerungen, Statuswechsel, neue Regeln: 5 Fragen, um zu wissen, wo du stehst.', slugKeys: ['permitQuiz'] },
    { title: 'Dritte Säule: optimiere deine Steuern vor Dezember', excerpt: 'Der 3a-Abzug 2026 geht bis 7.258 CHF — plane deine Einzahlung rechtzeitig.', slugKeys: ['fisco', 'pillar3'] },
    { title: 'Der 13. Monatslohn kommt: berechne, was dir zusteht', excerpt: 'Netto, brutto, Abzüge: simuliere deinen 13. Monatslohn, bevor er auf der Lohnabrechnung landet.', slugKeys: ['tredicesima'] },
  ],
  fr: [
    { title: 'Changement d’emploi ? Calcule ton indemnité TFR maintenant', excerpt: 'Tu envisages un nouveau poste en début d’année ? Simule l’indemnité avant de signer.', slugKeys: ['tfrCalculator'] },
    { title: 'Déclaration de revenus en Italie : le guide frontalier', excerpt: 'La saison du 730 prérempli approche : quoi déclarer, quoi déduire, les délais à ne pas manquer.', slugKeys: ['fisco', 'taxReturnItalia'] },
    { title: 'Ton salaire est-il toujours aligné sur le marché ?', excerpt: 'Le milieu d’année est un bon moment pour vérifier : calcule ton net et compare-le à ton secteur.', slugKeys: ['calcolatore'] },
    { title: 'Permis B ou G : fais le quiz et vérifie ta situation', excerpt: 'Renouvellements, changements de statut, nouvelles règles : 5 questions pour savoir où tu en es.', slugKeys: ['permitQuiz'] },
    { title: 'Troisième pilier : optimise tes impôts avant décembre', excerpt: 'La déduction 3a 2026 va jusqu’à 7’258 CHF — planifie ton versement à temps.', slugKeys: ['fisco', 'pillar3'] },
    { title: 'Le treizième salaire arrive : calcule ce qui te revient', excerpt: 'Net, brut, cotisations : simule ton treizième salaire avant qu’il n’arrive sur ta fiche de paie.', slugKeys: ['tredicesima'] },
  ],
};

/**
 * @param {number} month 1-12 (calendar month, 1=January)
 * @returns {number} bucket index 0-5 into COPY[locale]
 */
function bucketForMonth(month) {
  return Math.floor((((month - 1) % 12 + 12) % 12) / 2);
}

/**
 * @param {Date} [date] defaults to now
 * @param {string} [locale] defaults to 'it'
 * @returns {{title: string, excerpt: string, url: string}}
 */
export function getSeasonalUtilityContent(date = new Date(), locale = 'it') {
  const l = norm(locale);
  const entry = COPY[l][bucketForMonth(date.getMonth() + 1)];
  return { title: entry.title, excerpt: entry.excerpt, url: path(l, ...entry.slugKeys) };
}
