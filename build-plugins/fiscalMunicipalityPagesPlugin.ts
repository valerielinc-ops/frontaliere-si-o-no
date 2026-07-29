/**
 * Per-municipality FISCAL guide pages (epic #4482 / sub #4484).
 *
 * Emits, for every Italian border comune in the fiscal corridor (ALL 11
 * provinces present in data/municipalities.ts — CO/VA/VB/SO/AO/VC/BS/BZ/MB/
 * BG/TN, widened from the original CO/VA/VB-only cut by issue #4893; see
 * scripts/build-fiscal-municipalities.mjs's CORRIDOR CRITERION doc comment
 * for the numeric rationale) that is ABOVE the fiscal floor
 * (data/fiscal-municipalities.json), a page:
 *
 *   /tasse-frontalieri-comune/{slug}/            (it, + 3 locale prefixes)
 *   "Tasse frontaliere residente a {comune}: vecchio vs nuovo regime"
 *
 * with a MANDATORY numeric scenario (vecchio vs nuovo regime, computed with the
 * salaryHubScenarios → calculationService engine for a typical single
 * frontaliere on 55'000 CHF) that uses the comune's REAL addizionale comunale
 * IRPEF, plus a FAQ on the 2024 cross-border agreement.
 *
 * Comuni BELOW the floor get a noindex,follow bridge at the SAME URL (never a
 * silent 404 — AGENTS.md § Static SEO Pages), paired with the self-map in
 * build-plugins/searchConsoleCompat.ts.
 *
 * Anti-cannibalization: the fiscal page cross-links to the existing
 * "vivere a {comune}" page (borderMunicipalityPagesPlugin) with a DISTINCT
 * intent in the title/H1 (fiscale vs vita), and vice-versa the two never share
 * a title. That "vivere a" page family stays Ticino-only (CO/VA/VB —
 * shared/borderMunicipalityCorridors.ts): the cross-link is gated on
 * province membership (hasVitaLink()) so the 198 comuni added by #4893
 * outside that narrower corridor never emit a link to a page that doesn't
 * exist for them.
 */

import fs from 'node:fs';
import path from 'node:path';
import type { Plugin } from 'vite';
import { WriteCollector } from './batchWrite';
import { BASE_URL, countHtmlBodyWords, MIN_INDEXABLE_WORDS } from './constants';
import { buildSeoPageHtml } from './shared/seoPageShell';
import { endOfContentMultiplexHtml } from './lib/adSlotHtml';
import { inlineScriptJson } from './shared/inlineJsonScript';
import { calculateSimulation } from '../services/calculationService';
import { scenarioToInputs, type SalaryHubScenario } from './salaryHubScenarios';
import { resolveFiscalMunicipalitiesFlushed } from './shared/buildSignals';
import { composePlaceTitle, TITLE_MAX_CHARS } from './shared/titleSuffix';
import {
  FISCAL_LOCALES,
  FISCAL_ABOVE_FLOOR,
  FISCAL_BELOW_FLOOR,
  FISCAL_HUB_PATH,
  FISCAL_PROFILE,
  fiscalPathFor,
  type FiscalLocale,
  type FiscalMunicipality,
} from './fiscalMunicipalityData';
import { TICINO_VITA_CORRIDOR_PROVINCES } from './shared/borderMunicipalityCorridors';

// "Vivere a {comune}" cross-link base paths (borderMunicipalityPagesPlugin).
const VITA_BASE_PATH: Record<FiscalLocale, string> = {
  it: '/vivere-in-ticino/comuni-di-frontiera',
  en: '/en/living-in-ticino/border-municipalities',
  de: '/de/leben-im-tessin/grenzgemeinden',
  fr: '/fr/vivre-au-tessin/communes-frontiere',
};

const OG_LOCALE: Record<FiscalLocale, string> = {
  it: 'it_CH',
  en: 'en_US',
  de: 'de_CH',
  fr: 'fr_CH',
};

// <title> cascade fallback tiers (issue #4886) — literal substrings of each
// locale's `title` template above, reused so the cascade never has to
// invent wording. See the `titleCandidates` comment near composePlaceTitle
// below for why the bare comune name is never an acceptable last resort.
const TITLE_KEYWORD_TAIL: Record<FiscalLocale, string> = {
  it: 'tasse frontaliere',
  en: 'cross-border tax',
  de: 'Grenzgänger-Steuern',
  fr: 'impôts frontaliers',
};
const TITLE_COLON: Record<FiscalLocale, string> = {
  it: ': ',
  en: ': ',
  de: ': ',
  fr: ' : ',
};

const SITEMAP_NAME = 'sitemap-comuni-fiscale.xml';
const FISCAL_YEAR_LABEL = '2024';

function esc(value: unknown): string {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function intlLang(locale: FiscalLocale): string {
  return locale === 'it' ? 'it-IT' : locale === 'de' ? 'de-DE' : locale === 'fr' ? 'fr-FR' : 'en-US';
}
function eur(amount: number, locale: FiscalLocale): string {
  return new Intl.NumberFormat(intlLang(locale), {
    style: 'currency',
    currency: 'EUR',
    maximumFractionDigits: 0,
  }).format(Math.round(amount));
}
function pct(value: number, locale: FiscalLocale): string {
  return `${new Intl.NumberFormat(intlLang(locale), { maximumFractionDigits: 2 }).format(value)}%`;
}
function intFmt(n: number, locale: FiscalLocale): string {
  return new Intl.NumberFormat(intlLang(locale), { maximumFractionDigits: 0 }).format(n);
}

// ── Numeric scenario (vecchio vs nuovo regime) ──────────────────

interface RegimeNumbers {
  grossAnnualEUR: number;
  socialAnnualEUR: number;
  oldTaxAnnualEUR: number;
  newTaxAnnualEUR: number;
  addizionaleAnnualEUR: number;
  oldNetAnnualEUR: number;
  newNetAnnualEUR: number;
  oldNetMonthlyEUR: number;
  newNetMonthlyEUR: number;
  diffMonthlyEUR: number;
  diffAnnualEUR: number;
}

/** Compute the old-vs-new-regime numbers for a comune's real addizionale, using
 *  the shared salaryHubScenarios → calculationService engine. */
export function computeRegimes(irpefPct: number): RegimeNumbers {
  const base: SalaryHubScenario = {
    salary: FISCAL_PROFILE.annualIncomeCHF,
    frontierType: 'OLD',
    maritalStatus: FISCAL_PROFILE.maritalStatus,
    children: FISCAL_PROFILE.children,
    distanceZone: FISCAL_PROFILE.distanceZone,
  };
  const rate = irpefPct / 100;
  const oldR = calculateSimulation({ ...scenarioToInputs(base), itAddizionaleRate: rate });
  const newR = calculateSimulation({ ...scenarioToInputs({ ...base, frontierType: 'NEW' }), itAddizionaleRate: rate });
  const xr = oldR.exchangeRate;
  const toEur = (chf: number) => Math.round(chf * xr);

  const oldNetAnnualEUR = toEur(oldR.itResident.netIncomeAnnual);
  const newNetAnnualEUR = toEur(newR.itResident.netIncomeAnnual);
  const oldNetMonthlyEUR = toEur(oldR.itResident.netIncomeMonthly);
  const newNetMonthlyEUR = toEur(newR.itResident.netIncomeMonthly);

  return {
    grossAnnualEUR: toEur(FISCAL_PROFILE.annualIncomeCHF),
    socialAnnualEUR: toEur(oldR.itResident.socialContributions),
    oldTaxAnnualEUR: toEur(oldR.itResident.taxes),
    newTaxAnnualEUR: toEur(newR.itResident.taxes),
    addizionaleAnnualEUR: Math.round(newR.itResident.details.irpefDetails?.addizionaliEUR ?? 0),
    oldNetAnnualEUR,
    newNetAnnualEUR,
    oldNetMonthlyEUR,
    newNetMonthlyEUR,
    diffMonthlyEUR: oldNetMonthlyEUR - newNetMonthlyEUR,
    diffAnnualEUR: oldNetAnnualEUR - newNetAnnualEUR,
  };
}

// ── Localized copy ──────────────────────────────────────────────

interface Copy {
  role: string;
  updated: string;
  home: string;
  hubLabel: string;
  h1: (name: string) => string;
  title: (name: string) => string;
  desc: (name: string, addiz: string) => string;
  lede: (name: string, addiz: string, diff: string) => string;
  tileAddiz: string;
  tileOldNet: string;
  tileNewNet: string;
  tileDiff: string;
  perMonth: string;
  perYear: string;
  scenarioTitle: string;
  profileNote: (gross: string) => string;
  colOld: string;
  colNew: string;
  rowGross: string;
  rowSocial: string;
  rowTax: string;
  rowAddiz: string;
  rowNetYear: string;
  rowNetMonth: string;
  explainTitle: string;
  explainOld: (name: string) => string;
  explainNew: (name: string, addiz: string, addizEur: string) => string;
  crossTitle: string;
  vitaLink: (name: string) => string;
  calcLink: string;
  taxReturnLink: string;
  relatedTitle: string;
  faqTitle: string;
  faqQ1: string;
  faqA1: (name: string, diff: string) => string;
  faqQ2: string;
  faqA2: string;
  faqQ3: (name: string) => string;
  faqA3: (name: string, addiz: string, addizEur: string) => string;
  disclaimer: string;
  hubTitle: string;
  hubLede: string;
  bridgeLede: (name: string) => string;
}

const COPY: Record<FiscalLocale, Copy> = {
  it: {
    role: 'Guida fiscale',
    updated: 'Aggiornato',
    home: 'Home',
    hubLabel: 'Tasse frontalieri per comune',
    h1: (n) => `Tasse frontaliere residente a ${n}: vecchio vs nuovo regime`,
    title: (n) => `Tasse frontaliere ${n}: vecchio vs nuovo regime`,
    desc: (n, a) =>
      `Quanto cambiano le tasse per un frontaliere residente a ${n} tra vecchio e nuovo regime (accordo 2024). Scenario numerico reale con addizionale comunale ${a}.`,
    lede: (n, a, d) =>
      `A ${n} l'addizionale comunale IRPEF è ${a}. Con il nuovo regime frontalieri un profilo tipo perde circa ${d} al mese di netto rispetto al vecchio regime a tassazione esclusiva svizzera.`,
    tileAddiz: 'Addizionale comunale',
    tileOldNet: 'Netto vecchio regime',
    tileNewNet: 'Netto nuovo regime',
    tileDiff: 'Differenza netto',
    perMonth: '/mese',
    perYear: "/anno",
    scenarioTitle: 'Scenario numerico: vecchio vs nuovo regime',
    profileNote: (g) =>
      `Profilo tipo: frontaliere single, senza figli, ${g} lordi CHF/anno, residenza entro 20 km dal confine. Cambi fiscali reali applicati al comune.`,
    colOld: 'Vecchio regime',
    colNew: 'Nuovo regime',
    rowGross: 'Reddito lordo annuo',
    rowSocial: 'Contributi sociali CH',
    rowTax: 'Imposte totali annue',
    rowAddiz: 'di cui addizionale comunale',
    rowNetYear: 'Netto annuo',
    rowNetMonth: 'Netto mensile',
    explainTitle: 'Come funziona l\'accordo 2024',
    explainOld: (n) =>
      `I vecchi frontalieri (già frontalieri prima del 17 luglio 2023 e residenti nella fascia di 20 km, come ${n}) restano a tassazione esclusiva in Svizzera: pagano solo l'imposta alla fonte svizzera e non versano IRPEF italiana sul reddito da lavoro frontaliero.`,
    explainNew: (n, a, ae) =>
      `I nuovi frontalieri sono a tassazione concorrente: la Svizzera trattiene l'imposta alla fonte e l'Italia tassa lo stesso reddito riconoscendo il credito per le imposte svizzere, aggiungendo addizionale regionale e comunale. A ${n} l'addizionale comunale è ${a}, cioè circa ${ae} l'anno nello scenario tipo.`,
    crossTitle: 'Approfondimenti utili',
    vitaLink: (n) => `Vivere a ${n}: dogana, affitti e pendolarismo`,
    calcLink: 'Calcola il tuo stipendio netto',
    taxReturnLink: 'Dichiarazione dei redditi frontalieri',
    relatedTitle: 'Altri comuni della fascia',
    faqTitle: 'Domande frequenti',
    faqQ1: 'Conviene di più il vecchio o il nuovo regime?',
    faqA1: (n, d) =>
      `Nello scenario tipo a ${n} il vecchio regime lascia circa ${d} al mese in più, perché evita la tassazione concorrente italiana. Ma il vecchio regime spetta solo a chi era già frontaliere prima del 17 luglio 2023: chi inizia oggi rientra nel nuovo regime.`,
    faqQ2: 'Chi è vecchio frontaliere e chi è nuovo frontaliere?',
    faqA2:
      'È vecchio frontaliere chi ha svolto attività di frontaliere in Ticino, Grigioni o Vallese tra il 31 dicembre 2018 e il 17 luglio 2023. Chi ha iniziato dopo il 17 luglio 2023 è nuovo frontaliere e segue la tassazione concorrente dell\'accordo 2024.',
    faqQ3: (n) => `Quanto pesa l'addizionale comunale a ${n}?`,
    faqA3: (n, a, ae) =>
      `L'addizionale comunale IRPEF di ${n} è ${a}. Nello scenario tipo del nuovo regime vale circa ${ae} l'anno: è una delle voci che varia da comune a comune e che conviene confrontare prima di scegliere la residenza.`,
    disclaimer:
      'Stime a scopo orientativo. La tassazione effettiva dipende da data di assunzione, status vecchio/nuovo frontaliere, deduzioni, situazione familiare e dichiarazione italiana. Verifica sempre con un consulente.',
    hubTitle: 'Tasse frontalieri per comune di residenza',
    hubLede:
      'Confronta vecchio e nuovo regime frontalieri (accordo 2024) comune per comune, con addizionale comunale IRPEF reale e scenario numerico per un profilo tipo.',
    bridgeLede: (n) =>
      `${n} è nella fascia di frontiera ma ha una popolazione ridotta: la guida fiscale dedicata non è ancora pubblicata. Usa il calcolatore e la guida alla dichiarazione, oppure esplora i comuni principali della fascia.`,
  },
  en: {
    role: 'Tax guide',
    updated: 'Updated',
    home: 'Home',
    hubLabel: 'Cross-border tax by municipality',
    h1: (n) => `Cross-border worker tax in ${n}: old vs new regime`,
    title: (n) => `${n} cross-border tax: old vs new regime`,
    desc: (n, a) =>
      `How taxes change for a cross-border worker living in ${n} between the old and new regime (2024 agreement). Real numeric scenario with ${a} municipal surtax.`,
    lede: (n, a, d) =>
      `In ${n} the municipal IRPEF surtax is ${a}. Under the new cross-border regime a typical profile keeps about ${d} less net per month than under the old Swiss-only taxation.`,
    tileAddiz: 'Municipal surtax',
    tileOldNet: 'Net, old regime',
    tileNewNet: 'Net, new regime',
    tileDiff: 'Net difference',
    perMonth: '/month',
    perYear: '/year',
    scenarioTitle: 'Numeric scenario: old vs new regime',
    profileNote: (g) =>
      `Sample profile: single cross-border worker, no children, ${g} gross CHF/year, residence within 20 km of the border. Real municipal figures applied.`,
    colOld: 'Old regime',
    colNew: 'New regime',
    rowGross: 'Gross annual income',
    rowSocial: 'Swiss social contributions',
    rowTax: 'Total annual tax',
    rowAddiz: 'of which municipal surtax',
    rowNetYear: 'Net per year',
    rowNetMonth: 'Net per month',
    explainTitle: 'How the 2024 agreement works',
    explainOld: (n) =>
      `Old cross-border workers (already commuting before 17 July 2023 and resident in the 20 km band, like ${n}) stay taxed exclusively in Switzerland: they pay only the Swiss withholding tax and no Italian IRPEF on their frontier income.`,
    explainNew: (n, a, ae) =>
      `New cross-border workers face concurrent taxation: Switzerland withholds tax at source and Italy taxes the same income while granting a credit for the Swiss tax, adding regional and municipal surtaxes. In ${n} the municipal surtax is ${a}, about ${ae} per year in the sample scenario.`,
    crossTitle: 'Useful reading',
    vitaLink: (n) => `Living in ${n}: border, rent and commuting`,
    calcLink: 'Calculate your net salary',
    taxReturnLink: 'Cross-border tax return guide',
    relatedTitle: 'Other municipalities in the band',
    faqTitle: 'FAQ',
    faqQ1: 'Is the old or the new regime better?',
    faqA1: (n, d) =>
      `In the sample scenario for ${n} the old regime leaves about ${d} more per month, because it avoids Italian concurrent taxation. But the old regime only applies to those already commuting before 17 July 2023: new starters fall under the new regime.`,
    faqQ2: 'Who is an old vs a new cross-border worker?',
    faqA2:
      'An old cross-border worker commuted to Ticino, Graubünden or Valais between 31 December 2018 and 17 July 2023. Those who started after 17 July 2023 are new cross-border workers under the 2024 agreement\'s concurrent taxation.',
    faqQ3: (n) => `How heavy is the municipal surtax in ${n}?`,
    faqA3: (n, a, ae) =>
      `The municipal IRPEF surtax in ${n} is ${a}. In the sample new-regime scenario it is about ${ae} per year: it varies from town to town and is worth comparing before choosing a residence.`,
    disclaimer:
      'Estimates for guidance only. Actual taxation depends on hire date, old/new frontier status, deductions, family situation and the Italian tax return. Always check with an adviser.',
    hubTitle: 'Cross-border tax by municipality of residence',
    hubLede:
      'Compare the old and new cross-border regime (2024 agreement) town by town, with the real municipal IRPEF surtax and a numeric scenario for a sample profile.',
    bridgeLede: (n) =>
      `${n} is in the border band but has a small population, so its dedicated tax guide is not published yet. Use the calculator and the tax-return guide, or explore the main towns in the band.`,
  },
  de: {
    role: 'Steuerratgeber',
    updated: 'Aktualisiert',
    home: 'Startseite',
    hubLabel: 'Grenzgänger-Steuern nach Gemeinde',
    h1: (n) => `Grenzgänger-Steuern in ${n}: altes vs. neues Regime`,
    title: (n) => `${n} Grenzgänger-Steuern: alt vs. neu`,
    desc: (n, a) =>
      `Wie sich die Steuern für einen Grenzgänger mit Wohnsitz in ${n} zwischen altem und neuem Regime (Abkommen 2024) ändern. Reales Zahlenszenario mit Gemeindezuschlag ${a}.`,
    lede: (n, a, d) =>
      `In ${n} beträgt der kommunale IRPEF-Zuschlag ${a}. Im neuen Grenzgänger-Regime bleibt einem Musterprofil rund ${d} pro Monat weniger netto als im alten Regime mit ausschliesslicher Schweizer Besteuerung.`,
    tileAddiz: 'Gemeindezuschlag',
    tileOldNet: 'Netto, altes Regime',
    tileNewNet: 'Netto, neues Regime',
    tileDiff: 'Netto-Differenz',
    perMonth: '/Monat',
    perYear: '/Jahr',
    scenarioTitle: 'Zahlenszenario: altes vs. neues Regime',
    profileNote: (g) =>
      `Musterprofil: alleinstehender Grenzgänger, keine Kinder, ${g} brutto CHF/Jahr, Wohnsitz innerhalb von 20 km zur Grenze. Reale Gemeindewerte angewendet.`,
    colOld: 'Altes Regime',
    colNew: 'Neues Regime',
    rowGross: 'Bruttojahreseinkommen',
    rowSocial: 'Schweizer Sozialabgaben',
    rowTax: 'Steuern gesamt pro Jahr',
    rowAddiz: 'davon Gemeindezuschlag',
    rowNetYear: 'Netto pro Jahr',
    rowNetMonth: 'Netto pro Monat',
    explainTitle: 'So funktioniert das Abkommen 2024',
    explainOld: (n) =>
      `Alte Grenzgänger (bereits vor dem 17. Juli 2023 pendelnd und in der 20-km-Zone wohnhaft, wie ${n}) bleiben ausschliesslich in der Schweiz besteuert: Sie zahlen nur die Schweizer Quellensteuer und keine italienische IRPEF auf das Grenzgängereinkommen.`,
    explainNew: (n, a, ae) =>
      `Neue Grenzgänger unterliegen der konkurrierenden Besteuerung: Die Schweiz behält die Quellensteuer ein und Italien besteuert dasselbe Einkommen, rechnet die Schweizer Steuer an und ergänzt regionalen und kommunalen Zuschlag. In ${n} beträgt der Gemeindezuschlag ${a}, im Musterszenario rund ${ae} pro Jahr.`,
    crossTitle: 'Nützliche Lektüre',
    vitaLink: (n) => `Leben in ${n}: Grenze, Miete und Pendeln`,
    calcLink: 'Nettolohn berechnen',
    taxReturnLink: 'Leitfaden zur Steuererklärung',
    relatedTitle: 'Weitere Gemeinden der Zone',
    faqTitle: 'Häufige Fragen',
    faqQ1: 'Ist das alte oder das neue Regime besser?',
    faqA1: (n, d) =>
      `Im Musterszenario für ${n} lässt das alte Regime rund ${d} pro Monat mehr, weil es die italienische konkurrierende Besteuerung vermeidet. Das alte Regime gilt aber nur für vor dem 17. Juli 2023 Pendelnde: Neueinsteiger fallen unter das neue Regime.`,
    faqQ2: 'Wer ist alter, wer neuer Grenzgänger?',
    faqA2:
      'Alter Grenzgänger ist, wer zwischen dem 31. Dezember 2018 und dem 17. Juli 2023 ins Tessin, nach Graubünden oder ins Wallis pendelte. Wer nach dem 17. Juli 2023 begann, ist neuer Grenzgänger mit konkurrierender Besteuerung nach dem Abkommen 2024.',
    faqQ3: (n) => `Wie stark wiegt der Gemeindezuschlag in ${n}?`,
    faqA3: (n, a, ae) =>
      `Der kommunale IRPEF-Zuschlag in ${n} beträgt ${a}. Im Muster-Neuregime sind das rund ${ae} pro Jahr: Er variiert von Gemeinde zu Gemeinde und lohnt einen Vergleich vor der Wohnsitzwahl.`,
    disclaimer:
      'Schätzungen nur zur Orientierung. Die tatsächliche Besteuerung hängt von Einstellungsdatum, altem/neuem Grenzgängerstatus, Abzügen, Familiensituation und der italienischen Steuererklärung ab. Immer mit einer Beratung prüfen.',
    hubTitle: 'Grenzgänger-Steuern nach Wohngemeinde',
    hubLede:
      'Vergleichen Sie altes und neues Grenzgänger-Regime (Abkommen 2024) Gemeinde für Gemeinde, mit realem kommunalem IRPEF-Zuschlag und einem Zahlenszenario für ein Musterprofil.',
    bridgeLede: (n) =>
      `${n} liegt in der Grenzzone, hat aber eine kleine Bevölkerung, daher ist der eigene Steuerratgeber noch nicht veröffentlicht. Nutzen Sie den Rechner und den Steuererklärungs-Leitfaden oder erkunden Sie die grösseren Orte der Zone.`,
  },
  fr: {
    role: 'Guide fiscal',
    updated: 'Mis à jour',
    home: 'Accueil',
    hubLabel: 'Impôts frontaliers par commune',
    h1: (n) => `Impôts frontaliers à ${n} : ancien vs nouveau régime`,
    title: (n) => `${n} impôts frontaliers : ancien vs nouveau`,
    desc: (n, a) =>
      `Comment les impôts changent pour un frontalier résidant à ${n} entre l'ancien et le nouveau régime (accord 2024). Scénario chiffré réel avec surtaxe communale ${a}.`,
    lede: (n, a, d) =>
      `À ${n} la surtaxe communale IRPEF est de ${a}. Avec le nouveau régime frontalier, un profil type conserve environ ${d} de net en moins par mois qu'avec l'ancien régime à imposition suisse exclusive.`,
    tileAddiz: 'Surtaxe communale',
    tileOldNet: 'Net, ancien régime',
    tileNewNet: 'Net, nouveau régime',
    tileDiff: 'Écart de net',
    perMonth: '/mois',
    perYear: '/an',
    scenarioTitle: 'Scénario chiffré : ancien vs nouveau régime',
    profileNote: (g) =>
      `Profil type : frontalier célibataire, sans enfant, ${g} bruts CHF/an, résidence à moins de 20 km de la frontière. Valeurs communales réelles appliquées.`,
    colOld: 'Ancien régime',
    colNew: 'Nouveau régime',
    rowGross: 'Revenu brut annuel',
    rowSocial: 'Cotisations sociales CH',
    rowTax: 'Impôts totaux annuels',
    rowAddiz: 'dont surtaxe communale',
    rowNetYear: 'Net par an',
    rowNetMonth: 'Net par mois',
    explainTitle: 'Comment fonctionne l\'accord 2024',
    explainOld: (n) =>
      `Les anciens frontaliers (déjà frontaliers avant le 17 juillet 2023 et résidant dans la bande des 20 km, comme ${n}) restent imposés exclusivement en Suisse : ils ne paient que l'impôt à la source suisse et pas d'IRPEF italien sur le revenu frontalier.`,
    explainNew: (n, a, ae) =>
      `Les nouveaux frontaliers relèvent de l'imposition concurrente : la Suisse retient l'impôt à la source et l'Italie impose le même revenu en accordant un crédit pour l'impôt suisse, en ajoutant les surtaxes régionale et communale. À ${n} la surtaxe communale est de ${a}, soit environ ${ae} par an dans le scénario type.`,
    crossTitle: 'À lire aussi',
    vitaLink: (n) => `Vivre à ${n} : douane, loyers et trajets`,
    calcLink: 'Calculez votre salaire net',
    taxReturnLink: 'Guide de la déclaration frontalière',
    relatedTitle: 'Autres communes de la bande',
    faqTitle: 'Questions fréquentes',
    faqQ1: 'L\'ancien ou le nouveau régime est-il plus avantageux ?',
    faqA1: (n, d) =>
      `Dans le scénario type pour ${n}, l'ancien régime laisse environ ${d} de plus par mois, car il évite l'imposition concurrente italienne. Mais l'ancien régime ne concerne que ceux déjà frontaliers avant le 17 juillet 2023 : les nouveaux relèvent du nouveau régime.`,
    faqQ2: 'Qui est ancien et qui est nouveau frontalier ?',
    faqA2:
      'Est ancien frontalier celui qui a travaillé comme frontalier au Tessin, aux Grisons ou en Valais entre le 31 décembre 2018 et le 17 juillet 2023. Ceux qui ont commencé après le 17 juillet 2023 sont de nouveaux frontaliers sous l\'imposition concurrente de l\'accord 2024.',
    faqQ3: (n) => `Quel est le poids de la surtaxe communale à ${n} ?`,
    faqA3: (n, a, ae) =>
      `La surtaxe communale IRPEF de ${n} est de ${a}. Dans le scénario type du nouveau régime, elle représente environ ${ae} par an : elle varie d'une commune à l'autre et mérite d'être comparée avant de choisir sa résidence.`,
    disclaimer:
      'Estimations à titre indicatif. L\'imposition réelle dépend de la date d\'embauche, du statut ancien/nouveau frontalier, des déductions, de la situation familiale et de la déclaration italienne. Vérifiez toujours avec un conseiller.',
    hubTitle: 'Impôts frontaliers par commune de résidence',
    hubLede:
      'Comparez l\'ancien et le nouveau régime frontalier (accord 2024) commune par commune, avec la surtaxe communale IRPEF réelle et un scénario chiffré pour un profil type.',
    bridgeLede: (n) =>
      `${n} est dans la bande frontalière mais peu peuplée, son guide fiscal dédié n'est pas encore publié. Utilisez le calculateur et le guide de déclaration, ou explorez les principales communes de la bande.`,
  },
};

// ── Localized helper link targets ───────────────────────────────

const CALC_PATH: Record<FiscalLocale, string> = {
  it: '/calcola-stipendio/',
  en: '/en/calculate-salary/',
  de: '/de/gehalt-berechnen/',
  fr: '/fr/calculer-salaire/',
};
const TAX_RETURN_PATH: Record<FiscalLocale, string> = {
  it: '/tasse-e-pensione/dichiarazione-redditi/',
  en: '/en/taxes-and-pension/tax-return/',
  de: '/de/steuern-und-rente/steuererklaerung/',
  fr: '/fr/impots-et-retraite/declaration-impots/',
};

function vitaPathFor(locale: FiscalLocale, slug: string): string {
  return `${VITA_BASE_PATH[locale]}/${slug}/`;
}

// The fiscal corridor (scripts/build-fiscal-municipalities.mjs) covers all
// 11 Italian border provinces (issue #4893); the "vivere a {comune}" page
// family (borderMunicipalityPagesPlugin.ts) stays Ticino-only
// (TICINO_VITA_CORRIDOR_PROVINCES). A fiscal comune outside that narrower
// corridor has no live "vivere a" target — cross-linking to it unconditionally
// would emit a broken internal link (404). Gate on province membership so the
// card/list-item is only rendered where the target actually exists.
function hasVitaLink(municipality: FiscalMunicipality): boolean {
  return TICINO_VITA_CORRIDOR_PROVINCES.has(municipality.province);
}

// ── hreflang / breadcrumb ───────────────────────────────────────

function hreflangFor(slug: string, locales: readonly FiscalLocale[] = FISCAL_LOCALES): string {
  const lines = locales.map(
    (alt) => `    <link rel="alternate" hreflang="${alt}" href="${BASE_URL}${fiscalPathFor(alt, slug)}">`,
  );
  if (locales.includes('it')) {
    lines.push(`    <link rel="alternate" hreflang="x-default" href="${BASE_URL}${fiscalPathFor('it', slug)}">`);
  }
  return lines.join('\n');
}

function breadcrumbLd(locale: FiscalLocale, name: string, canonicalUrl: string): string {
  return inlineScriptJson({
    '@context': 'https://schema.org',
    '@type': 'BreadcrumbList',
    itemListElement: [
      { '@type': 'ListItem', position: 1, name: COPY[locale].home, item: `${BASE_URL}/` },
      { '@type': 'ListItem', position: 2, name: COPY[locale].hubLabel, item: `${BASE_URL}${FISCAL_HUB_PATH[locale]}` },
      { '@type': 'ListItem', position: 3, name, item: canonicalUrl },
    ],
  });
}

// ── Page renderers ──────────────────────────────────────────────

function renderRelated(locale: FiscalLocale, current: FiscalMunicipality): string {
  const others = FISCAL_ABOVE_FLOOR.filter((m) => m.slug !== current.slug).slice(0, 6);
  if (others.length === 0) return '';
  const links = others
    .map(
      (m) =>
        `<a class="rounded-md border border-edge bg-surface-raised p-3 text-sm font-semibold text-heading hover:border-accent-border" href="${fiscalPathFor(locale, m.slug)}">${esc(m.name)} <span class="font-normal text-muted">· ${esc(pct(m.irpefAddizionale, locale))}</span></a>`,
    )
    .join('');
  return `<section class="mt-6 rounded-md border border-edge bg-surface p-5">
      <h2 class="text-xl font-bold text-heading">${esc(COPY[locale].relatedTitle)}</h2>
      <div class="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">${links}</div>
    </section>`;
}

export function renderAboveFloorPage(params: {
  municipality: FiscalMunicipality;
  locale: FiscalLocale;
  dateStamp: string;
  distDir: string;
}): { urlPath: string; html: string; wordCount: number } {
  const { municipality, locale, dateStamp, distDir } = params;
  const c = COPY[locale];
  const n = municipality.name;
  const nums = computeRegimes(municipality.irpefAddizionale);
  const addizPctStr = pct(municipality.irpefAddizionale, locale);
  const diffMonthlyStr = eur(nums.diffMonthlyEUR, locale);
  const addizEurStr = eur(nums.addizionaleAnnualEUR, locale);
  const canonicalPath = fiscalPathFor(locale, municipality.slug);
  const canonicalUrl = `${BASE_URL}${canonicalPath}`;

  const tile = (label: string, value: string, sub: string) =>
    `<div class="rounded-md border border-edge bg-surface p-4">
        <dt class="text-xs font-semibold uppercase tracking-wide text-muted">${esc(label)}</dt>
        <dd class="mt-1 text-2xl font-bold text-heading">${esc(value)}</dd>
        <dd class="mt-0.5 text-xs text-subtle">${esc(sub)}</dd>
      </div>`;

  const scenarioRow = (label: string, oldVal: string, newVal: string, strong = false) =>
    `<tr class="${strong ? 'font-bold text-heading' : 'text-body'}">
        <th scope="row" class="py-2 pr-3 text-left font-medium">${esc(label)}</th>
        <td class="py-2 px-3 text-right tabular-nums">${esc(oldVal)}</td>
        <td class="py-2 pl-3 text-right tabular-nums">${esc(newVal)}</td>
      </tr>`;

  const body = `<div class="mx-auto max-w-4xl px-4 py-6 sm:px-6 lg:px-8">
    <nav class="mb-4 text-sm text-muted" aria-label="Breadcrumb">
      <a class="text-link hover:text-link-hover" href="/">${esc(c.home)}</a>
      <span class="mx-2">/</span>
      <a class="text-link hover:text-link-hover" href="${FISCAL_HUB_PATH[locale]}">${esc(c.hubLabel)}</a>
      <span class="mx-2">/</span>
      <span>${esc(n)}</span>
    </nav>

    <header class="rounded-md border border-edge bg-surface p-5 sm:p-7" data-speakable>
      <div class="flex flex-wrap items-center gap-2 text-sm">
        <span class="rounded-full border border-info-border bg-info-subtle px-3 py-1 font-semibold text-info">${esc(c.role)}</span>
        <span class="rounded-full border border-edge bg-surface-raised px-3 py-1 text-subtle">${esc(municipality.province)} · ${esc(intFmt(municipality.distanceKm, locale))} km</span>
      </div>
      <h1 class="mt-4 text-3xl font-bold leading-tight text-heading sm:text-4xl">${esc(c.h1(n))}</h1>
      <p class="mt-3 max-w-3xl text-base leading-7 text-body">${esc(c.lede(n, addizPctStr, diffMonthlyStr))}</p>
      <p class="mt-3 text-sm text-muted">${esc(c.updated)}: <time datetime="${dateStamp}">${dateStamp}</time></p>
    </header>

    <dl class="mt-5 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
      ${tile(c.tileAddiz, addizPctStr, 'IRPEF ' + FISCAL_YEAR_LABEL)}
      ${tile(c.tileOldNet, eur(nums.oldNetMonthlyEUR, locale), c.perMonth)}
      ${tile(c.tileNewNet, eur(nums.newNetMonthlyEUR, locale), c.perMonth)}
      ${tile(c.tileDiff, `-${eur(Math.abs(nums.diffMonthlyEUR), locale)}`, c.perMonth)}
    </dl>

    <section class="mt-6 rounded-md border border-edge bg-surface p-5">
      <h2 class="text-xl font-bold text-heading">${esc(c.scenarioTitle)}</h2>
      <p class="mt-2 text-sm text-muted">${esc(c.profileNote(intFmt(FISCAL_PROFILE.annualIncomeCHF, locale)))}</p>
      <div class="mt-4 overflow-x-auto">
        <table class="w-full min-w-[420px] border-collapse text-sm">
          <thead>
            <tr class="border-b border-edge text-xs uppercase tracking-wide text-muted">
              <th scope="col" class="py-2 pr-3 text-left"></th>
              <th scope="col" class="py-2 px-3 text-right">${esc(c.colOld)}</th>
              <th scope="col" class="py-2 pl-3 text-right">${esc(c.colNew)}</th>
            </tr>
          </thead>
          <tbody class="divide-y divide-edge">
            ${scenarioRow(c.rowGross, eur(nums.grossAnnualEUR, locale), eur(nums.grossAnnualEUR, locale))}
            ${scenarioRow(c.rowSocial, eur(nums.socialAnnualEUR, locale), eur(nums.socialAnnualEUR, locale))}
            ${scenarioRow(c.rowTax, eur(nums.oldTaxAnnualEUR, locale), eur(nums.newTaxAnnualEUR, locale))}
            ${scenarioRow(c.rowAddiz, '—', eur(nums.addizionaleAnnualEUR, locale))}
            ${scenarioRow(c.rowNetYear, eur(nums.oldNetAnnualEUR, locale), eur(nums.newNetAnnualEUR, locale), true)}
            ${scenarioRow(c.rowNetMonth, eur(nums.oldNetMonthlyEUR, locale), eur(nums.newNetMonthlyEUR, locale), true)}
          </tbody>
        </table>
      </div>
    </section>

    <section class="mt-6 rounded-md border border-edge bg-surface p-5">
      <h2 class="text-xl font-bold text-heading">${esc(c.explainTitle)}</h2>
      <p class="mt-3 text-sm leading-6 text-body">${esc(c.explainOld(n))}</p>
      <p class="mt-3 text-sm leading-6 text-body">${esc(c.explainNew(n, addizPctStr, addizEurStr))}</p>
    </section>

    <section class="mt-6 rounded-md border border-edge bg-surface p-5">
      <h2 class="text-xl font-bold text-heading">${esc(c.crossTitle)}</h2>
      <div class="mt-4 grid gap-3 ${hasVitaLink(municipality) ? 'sm:grid-cols-3' : 'sm:grid-cols-2'}">
        ${hasVitaLink(municipality) ? `<a class="rounded-md border border-accent-border bg-accent-subtle p-4 text-sm font-semibold text-heading hover:border-accent-strong" href="${vitaPathFor(locale, municipality.slug)}">${esc(c.vitaLink(n))}</a>` : ''}
        <a class="rounded-md border border-edge bg-surface-raised p-4 text-sm font-semibold text-heading hover:border-accent-border" href="${CALC_PATH[locale]}">${esc(c.calcLink)}</a>
        <a class="rounded-md border border-edge bg-surface-raised p-4 text-sm font-semibold text-heading hover:border-accent-border" href="${TAX_RETURN_PATH[locale]}">${esc(c.taxReturnLink)}</a>
      </div>
    </section>

    ${renderRelated(locale, municipality)}

    <section class="mt-6 rounded-md border border-edge bg-surface p-5">
      <h2 class="text-xl font-bold text-heading">${esc(c.faqTitle)}</h2>
      <div class="mt-4 divide-y divide-edge">
        <details class="py-3" open><summary class="cursor-pointer font-semibold text-heading">${esc(c.faqQ1)}</summary><p class="mt-2 text-sm leading-6 text-body">${esc(c.faqA1(n, diffMonthlyStr))}</p></details>
        <details class="py-3"><summary class="cursor-pointer font-semibold text-heading">${esc(c.faqQ2)}</summary><p class="mt-2 text-sm leading-6 text-body">${esc(c.faqA2)}</p></details>
        <details class="py-3"><summary class="cursor-pointer font-semibold text-heading">${esc(c.faqQ3(n))}</summary><p class="mt-2 text-sm leading-6 text-body">${esc(c.faqA3(n, addizPctStr, addizEurStr))}</p></details>
      </div>
    </section>

    <p class="mt-6 text-xs leading-5 text-muted">${esc(c.disclaimer)}</p>
  </div>`;

  const wordCount = countHtmlBodyWords(body);
  const bodyWithAd = `${body}${endOfContentMultiplexHtml({ indexable: wordCount >= MIN_INDEXABLE_WORDS })}`;

  const faqLd = inlineScriptJson({
    '@context': 'https://schema.org',
    '@type': 'FAQPage',
    mainEntity: [
      { '@type': 'Question', name: c.faqQ1, acceptedAnswer: { '@type': 'Answer', text: c.faqA1(n, diffMonthlyStr) } },
      { '@type': 'Question', name: c.faqQ2, acceptedAnswer: { '@type': 'Answer', text: c.faqA2 } },
      { '@type': 'Question', name: c.faqQ3(n), acceptedAnswer: { '@type': 'Answer', text: c.faqA3(n, addizPctStr, addizEurStr) } },
    ],
  });

  // Budget-aware cascade — sibling of the same fix in employerProfilePagesPlugin.ts
  // / professionCityLandings.ts / professionCantonLandings.ts / the FR border
  // municipality plugin (audit:title-length regression #4593, issue #4886):
  // `c.title(n)` has no fallback, so a comune name longer than today's corridor
  // dataset's longest (19 chars, "Casnate con Bernate", already 62/66 for IT)
  // would overflow with no recovery. Not currently overflowing (verified
  // against the live dataset). Three rungs, longest-first: `c.title(n)` (full
  // sentence) -> keyword-tail (still names the topic) -> role label
  // (shortest, still keyword-bearing). The bare comune name is NEVER a
  // candidate (issue #4886): it stays under the char cap but carries zero
  // query-intent signal, so falling back to it is SEO-dead, not a safe
  // degradation — never truncates the comune name itself either
  // (composePlaceTitle policy).
  const titleCandidates = [
    c.title(n),
    `${n}${TITLE_COLON[locale]}${TITLE_KEYWORD_TAIL[locale]}`,
    `${n}${TITLE_COLON[locale]}${c.role}`,
  ];
  const html = buildSeoPageHtml({
    locale,
    title: composePlaceTitle(titleCandidates, TITLE_MAX_CHARS, (s) => esc(s).length),
    description: c.desc(n, addizPctStr),
    canonicalUrl,
    robots: wordCount >= MIN_INDEXABLE_WORDS ? 'index,follow' : 'noindex,follow',
    ogLocale: OG_LOCALE[locale],
    hreflangHtml: hreflangFor(municipality.slug),
    jsonLdScripts: [breadcrumbLd(locale, n, canonicalUrl), faqLd],
    bodyHtml: bodyWithAd,
    distDir,
    skipMainWrap: true,
  });

  return { urlPath: canonicalPath, html, wordCount };
}

export function renderBridgePage(params: {
  municipality: FiscalMunicipality;
  locale: FiscalLocale;
  distDir: string;
}): string {
  const { municipality, locale, distDir } = params;
  const c = COPY[locale];
  const n = municipality.name;
  const canonicalPath = fiscalPathFor(locale, municipality.slug);
  const canonicalUrl = `${BASE_URL}${canonicalPath}`;

  const body = `<main class="seo-static-content mx-auto max-w-[760px] px-5 pt-8 pb-14 text-body">
    <nav class="mb-4 text-sm text-muted" aria-label="Breadcrumb">
      <a class="text-link hover:text-link-hover" href="/">${esc(c.home)}</a>
      <span class="mx-2">/</span>
      <a class="text-link hover:text-link-hover" href="${FISCAL_HUB_PATH[locale]}">${esc(c.hubLabel)}</a>
      <span class="mx-2">/</span>
      <span>${esc(n)}</span>
    </nav>
    <h1 class="text-2xl font-bold text-heading mb-3">${esc(c.h1(n))}</h1>
    <p class="text-body mb-5 leading-6">${esc(c.bridgeLede(n))}</p>
    <ul class="space-y-2 list-none p-0 m-0">
      <li><a href="${CALC_PATH[locale]}" class="text-sm font-semibold text-link">${esc(c.calcLink)} →</a></li>
      <li><a href="${TAX_RETURN_PATH[locale]}" class="text-sm font-semibold text-link">${esc(c.taxReturnLink)} →</a></li>
      ${hasVitaLink(municipality) ? `<li><a href="${vitaPathFor(locale, municipality.slug)}" class="text-sm font-semibold text-link">${esc(c.vitaLink(n))} →</a></li>` : ''}
      <li><a href="${FISCAL_HUB_PATH[locale]}" class="text-sm font-semibold text-link">${esc(c.hubTitle)} →</a></li>
    </ul>
  </main>`;

  return buildSeoPageHtml({
    locale,
    title: c.title(n),
    description: c.desc(n, pct(municipality.irpefAddizionale, locale)),
    canonicalUrl,
    robots: 'noindex,follow',
    ogLocale: OG_LOCALE[locale],
    hreflangHtml: hreflangFor(municipality.slug),
    jsonLdScripts: [breadcrumbLd(locale, n, canonicalUrl)],
    bodyHtml: body,
    distDir,
    skipMainWrap: true,
  });
}

function renderHubPage(params: { locale: FiscalLocale; dateStamp: string; distDir: string }): {
  urlPath: string;
  html: string;
} {
  const { locale, dateStamp, distDir } = params;
  const c = COPY[locale];
  const canonicalPath = FISCAL_HUB_PATH[locale];
  const canonicalUrl = `${BASE_URL}${canonicalPath}`;

  const byProvince = new Map<string, FiscalMunicipality[]>();
  for (const m of FISCAL_ABOVE_FLOOR) {
    const arr = byProvince.get(m.province);
    if (arr) arr.push(m);
    else byProvince.set(m.province, [m]);
  }
  const groups = [...byProvince.entries()]
    .map(([prov, list]) => {
      const cards = list
        .map(
          (m) =>
            `<a class="rounded-md border border-edge bg-surface-raised p-4 hover:border-accent-border" href="${fiscalPathFor(locale, m.slug)}">
              <span class="block text-sm font-semibold text-heading">${esc(m.name)}</span>
              <span class="mt-1 block text-xs text-muted">${esc(c.tileAddiz)}: ${esc(pct(m.irpefAddizionale, locale))}</span>
            </a>`,
        )
        .join('');
      return `<div class="mt-5">
          <h2 class="text-lg font-bold text-heading">${esc(prov)}</h2>
          <div class="mt-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">${cards}</div>
        </div>`;
    })
    .join('');

  const body = `<div class="mx-auto max-w-5xl px-4 py-6 sm:px-6 lg:px-8">
    <nav class="mb-4 text-sm text-muted" aria-label="Breadcrumb">
      <a class="text-link hover:text-link-hover" href="/">${esc(c.home)}</a>
      <span class="mx-2">/</span>
      <span>${esc(c.hubLabel)}</span>
    </nav>
    <header class="rounded-md border border-edge bg-surface p-5 sm:p-7">
      <h1 class="text-3xl font-bold leading-tight text-heading sm:text-4xl">${esc(c.hubTitle)}</h1>
      <p class="mt-3 max-w-3xl text-base leading-7 text-body">${esc(c.hubLede)}</p>
      <p class="mt-3 text-sm text-muted">${esc(c.updated)}: <time datetime="${dateStamp}">${dateStamp}</time></p>
    </header>
    ${groups}
    <p class="mt-6 text-xs leading-5 text-muted">${esc(c.disclaimer)}</p>
  </div>`;

  const wordCount = countHtmlBodyWords(body);
  const bodyWithAd = `${body}${endOfContentMultiplexHtml({ indexable: wordCount >= MIN_INDEXABLE_WORDS })}`;

  const hubHreflang = FISCAL_LOCALES.map(
    (alt) => `    <link rel="alternate" hreflang="${alt}" href="${BASE_URL}${FISCAL_HUB_PATH[alt]}">`,
  )
    .concat(`    <link rel="alternate" hreflang="x-default" href="${BASE_URL}${FISCAL_HUB_PATH.it}">`)
    .join('\n');

  const breadcrumb = inlineScriptJson({
    '@context': 'https://schema.org',
    '@type': 'BreadcrumbList',
    itemListElement: [
      { '@type': 'ListItem', position: 1, name: c.home, item: `${BASE_URL}/` },
      { '@type': 'ListItem', position: 2, name: c.hubLabel, item: canonicalUrl },
    ],
  });

  const html = buildSeoPageHtml({
    locale,
    title: c.hubTitle,
    description: c.hubLede,
    canonicalUrl,
    robots: 'index,follow',
    ogLocale: OG_LOCALE[locale],
    hreflangHtml: hubHreflang,
    jsonLdScripts: [breadcrumb],
    bodyHtml: bodyWithAd,
    distDir,
    skipMainWrap: true,
  });

  return { urlPath: canonicalPath, html };
}

// ── Sitemap ─────────────────────────────────────────────────────

function buildSitemap(dateStamp: string): string {
  const entry = (canonicalPath: string, alts: Array<{ hreflang: string; href: string }>, priority: string) => {
    const altLines = alts
      .map((a) => `    <xhtml:link rel="alternate" hreflang="${a.hreflang}" href="${a.href}" />`)
      .join('\n');
    return `  <url>\n    <loc>${BASE_URL}${canonicalPath}</loc>\n${altLines}\n    <lastmod>${dateStamp}</lastmod>\n    <changefreq>monthly</changefreq>\n    <priority>${priority}</priority>\n  </url>`;
  };

  const urls: string[] = [];

  // Hub (IT canonical), alternates across all locales.
  urls.push(
    entry(
      FISCAL_HUB_PATH.it,
      FISCAL_LOCALES.map((l) => ({ hreflang: l as string, href: `${BASE_URL}${FISCAL_HUB_PATH[l]}` })).concat({
        hreflang: 'x-default',
        href: `${BASE_URL}${FISCAL_HUB_PATH.it}`,
      }),
      '0.7',
    ),
  );

  // Above-floor comuni (indexable), IT canonical + alternates.
  for (const m of FISCAL_ABOVE_FLOOR) {
    urls.push(
      entry(
        fiscalPathFor('it', m.slug),
        FISCAL_LOCALES.map((l) => ({ hreflang: l as string, href: `${BASE_URL}${fiscalPathFor(l, m.slug)}` })).concat({
          hreflang: 'x-default',
          href: `${BASE_URL}${fiscalPathFor('it', m.slug)}`,
        }),
        '0.6',
      ),
    );
  }

  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:xhtml="http://www.w3.org/1999/xhtml">\n${urls.join('\n')}\n</urlset>\n`;
}

export function patchSitemapIndex(distDir: string, dateStamp: string): void {
  const sitemapPath = path.join(distDir, 'sitemap.xml');
  if (!fs.existsSync(sitemapPath)) return;
  let idx = fs.readFileSync(sitemapPath, 'utf-8');
  if (!idx.includes(SITEMAP_NAME)) {
    idx = idx.replace(
      '</sitemapindex>',
      `  <sitemap>\n    <loc>${BASE_URL}/${SITEMAP_NAME}</loc>\n    <lastmod>${dateStamp}</lastmod>\n  </sitemap>\n</sitemapindex>`,
    );
  } else {
    idx = idx.replace(
      new RegExp(`(<loc>${BASE_URL.replace(/\//g, '\\/')}/${SITEMAP_NAME}<\\/loc>\\s*<lastmod>)\\d{4}-\\d{2}-\\d{2}(<\\/lastmod>)`),
      `$1${dateStamp}$2`,
    );
  }
  fs.writeFileSync(sitemapPath, idx, 'utf-8');
}

// ── Plugin ──────────────────────────────────────────────────────

export function fiscalMunicipalityPagesPlugin(rootDir: string): Plugin {
  return {
    name: 'fiscal-municipality-pages',
    apply: 'build',
    enforce: 'post',
    async closeBundle() {
      if (process.env.SKIP_FISCAL_MUNICIPALITY_PAGES === '1') {
        console.log('\x1b[36m[fiscal-municipalities]\x1b[0m skipped (SKIP_FISCAL_MUNICIPALITY_PAGES=1)');
        resolveFiscalMunicipalitiesFlushed([]);
        return;
      }
      const distDir = path.resolve(rootDir, 'dist');
      if (!fs.existsSync(distDir)) {
        resolveFiscalMunicipalitiesFlushed([]);
        return;
      }

      const dateStamp = new Date().toISOString().slice(0, 10);
      const collector = new WriteCollector({ distDir, pluginName: 'fiscalMunicipalityPagesPlugin' });
      const t0 = Date.now();
      let indexablePages = 0;
      let bridgePages = 0;
      let thinPages = 0;

      // Hub index (one per locale).
      const hubPaths: string[] = [];
      for (const locale of FISCAL_LOCALES) {
        const { urlPath, html } = renderHubPage({ locale, dateStamp, distDir });
        collector.add(path.join(distDir, urlPath, 'index.html'), html);
        collector.add(path.join(distDir, urlPath.replace(/\/+$/, '') + '.html'), html);
        hubPaths.push(urlPath);
      }

      // Above-floor pages (indexable, with numeric scenario).
      for (const municipality of FISCAL_ABOVE_FLOOR) {
        for (const locale of FISCAL_LOCALES) {
          const { urlPath, html, wordCount } = renderAboveFloorPage({ municipality, locale, dateStamp, distDir });
          if (wordCount < MIN_INDEXABLE_WORDS) thinPages++;
          collector.add(path.join(distDir, urlPath, 'index.html'), html);
          collector.add(path.join(distDir, urlPath.replace(/\/+$/, '') + '.html'), html);
          indexablePages++;
        }
      }

      // Below-floor bridges (noindex,follow at the SAME URL).
      for (const municipality of FISCAL_BELOW_FLOOR) {
        for (const locale of FISCAL_LOCALES) {
          const urlPath = fiscalPathFor(locale, municipality.slug);
          const html = renderBridgePage({ municipality, locale, distDir });
          collector.add(path.join(distDir, urlPath, 'index.html'), html);
          collector.add(path.join(distDir, urlPath.replace(/\/+$/, '') + '.html'), html);
          bridgePages++;
        }
      }

      const written = await collector.flush();

      fs.writeFileSync(path.join(distDir, SITEMAP_NAME), buildSitemap(dateStamp), 'utf-8');
      patchSitemapIndex(distDir, dateStamp);

      console.log(
        `\x1b[36m[fiscal-municipalities]\x1b[0m ${FISCAL_ABOVE_FLOOR.length} above-floor + ${FISCAL_BELOW_FLOOR.length} below-floor → ` +
          `${indexablePages} pages (${thinPages} thin) + ${bridgePages} bridges + ${FISCAL_LOCALES.length} hubs — ` +
          `flushed ${written} files in ${((Date.now() - t0) / 1000).toFixed(1)}s`,
      );

      // Unblocks fiscalMunicipalityLinksPlugin, which injects a hub link
      // into the per-locale HTML sitemap page — without it the whole
      // sitemap-comuni-fiscale.xml shard ships BFS-unreachable from `/`
      // (audit:max-bfs-depth regression #4593).
      resolveFiscalMunicipalitiesFlushed(hubPaths);
    },
  };
}
