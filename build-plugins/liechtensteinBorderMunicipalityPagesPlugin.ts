/**
 * Per-municipality LIECHTENSTEIN border pages (issue #4884, third of the
 * FR/DE/LI rollout after France #4545/#4878 and Germany #4882).
 *
 * Emits, for every Liechtenstein Gemeinde ABOVE the population floor
 * (data/liechtenstein-municipalities.json, 8 of 11), a page:
 *
 *   /vivere-in-liechtenstein-lavorare-in-svizzera/{slug}/  (it, + 3 locale prefixes)
 *   "Vivere a {Gemeinde} (Liechtenstein) e lavorare in Svizzera"
 *
 * Reuses data/liechtensteinCorridorContent.ts's `LIECHTENSTEIN_CONTENT` for
 * every substantive fact (hub title/lede, per-comune title, the 5-entry FAQ
 * — including its treaty-mechanism, 45-day threshold, customs-union, AVS/AI
 * and MANDATORY flow-inversion-disclosure answers) rather than rewriting
 * that copy here, per the issue brief. Only page chrome (meta description,
 * tile labels, hub grouping, breadcrumb, the H1 regime-suffix, the
 * title-cascade's mid/short rungs, and the per-comune lede's first sentence)
 * is authored in this file — and that lede's flow-inversion sentence still
 * reads the live `LIECHTENSTEIN_COMMUTING_CONTEXT` numbers rather than
 * duplicating any hand-authored string, so it cannot silently drift out of
 * sync with the content module's own hubLede.
 *
 * Unlike France (per-canton REGIME_TAX amount) and Germany (uniform
 * Quellensteuer RATE), this corridor has no sourced numeric annual tax
 * figure at all — only the qualitative Art. 15 cpv. 4 treaty rule (exclusive
 * taxation in the state of residence for genuine daily commuters). Tiles
 * therefore surface population + the sourced non-return/customs/monetary
 * facts (LIECHTENSTEIN_REGIME), never an invented CHF/EUR amount.
 *
 * Explicitly NOT modeled: the health-insurance Optionsrecht (unverified for
 * this corridor, secondary sources only — see liechtensteinBorderMunicipalityData.ts
 * header and liechtensteinCorridorContent.ts's own "NOT included" note).
 *
 * Municipalities BELOW the floor (3 of 11) get a noindex,follow bridge at
 * the SAME URL (never a silent skip — AGENTS.md § Static SEO Pages), paired
 * with the self-map in build-plugins/searchConsoleCompat.ts.
 */

import fs from 'node:fs';
import path from 'node:path';
import type { Plugin } from 'vite';
import { WriteCollector } from './batchWrite';
import { BASE_URL, countHtmlBodyWords, MIN_INDEXABLE_WORDS } from './constants';
import { buildSeoPageHtml } from './shared/seoPageShell';
import { endOfContentMultiplexHtml } from './lib/adSlotHtml';
import { inlineScriptJson } from './shared/inlineJsonScript';
import { resolveLiechtensteinBorderMunicipalitiesFlushed } from './shared/buildSignals';
import { composePlaceTitle, TITLE_MAX_CHARS } from './shared/titleSuffix';
import {
  LIECHTENSTEIN_CONTENT,
  type LiechtensteinLocaleContent,
} from '../data/liechtensteinCorridorContent';
import {
  LIECHTENSTEIN_LOCALES,
  LIECHTENSTEIN_ABOVE_FLOOR,
  LIECHTENSTEIN_BELOW_FLOOR,
  LIECHTENSTEIN_HUB_PATH,
  LIECHTENSTEIN_REGIME,
  LIECHTENSTEIN_COMMUTING_CONTEXT,
  liechtensteinMunicipalityPathFor,
  type LiechtensteinLocale,
  type LiechtensteinBorderMunicipality,
} from './liechtensteinBorderMunicipalityData';

const OG_LOCALE: Record<LiechtensteinLocale, string> = {
  it: 'it_CH',
  en: 'en_US',
  de: 'de_CH',
  fr: 'fr_CH',
};

const SITEMAP_NAME = 'sitemap-comuni-liechtenstein.xml';

function esc(value: unknown): string {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * The inverted-commuting disclosure is mandatory on every page of this
 * corridor: the dominant flow is CH->FL (14'891 vs 2'426 in 2023, ~6:1), the
 * opposite of what the "living abroad, working in Switzerland" template
 * implies. A reader must be able to tell which of the two groups they are in.
 *
 * This used to read `faq[faq.length - 1]`, i.e. it depended on the disclosure
 * happening to sit last in the array. Reordering the FAQ — an edit nobody would
 * think twice about — would have swapped the accent box for an unrelated answer
 * silently, with every test still green. Keyed lookup, and a hard failure if the
 * marked entry disappears, so the guarantee can't erode by accident.
 */
function commutingDisclosure(content: LiechtensteinLocaleContent): string {
  const entry = content.faq.find((f) => f.kind === 'commuting-direction');
  if (!entry) {
    throw new Error(
      'liechtenstein: no FAQ entry marked `kind: "commuting-direction"` — the mandatory ' +
        'inverted-commuting disclosure would silently vanish from the page. Restore the marker ' +
        'in data/liechtensteinCorridorContent.ts instead of removing this check.',
    );
  }
  return entry.answer;
}

function intlLang(locale: LiechtensteinLocale): string {
  return locale === 'it' ? 'it-IT' : locale === 'de' ? 'de-DE' : locale === 'fr' ? 'fr-FR' : 'en-US';
}
function intFmt(n: number, locale: LiechtensteinLocale): string {
  return new Intl.NumberFormat(intlLang(locale), { maximumFractionDigits: 0 }).format(n);
}

/** Swiss-apostrophe grouping for the corridor's commuting-flow numbers —
 *  same deterministic grouper the content module uses, so a 4-digit and a
 *  5-digit figure never appear inconsistently grouped in the same sentence
 *  (see liechtensteinCorridorContent.ts header for the toLocaleString bug
 *  this works around). */
function groupThousands(value: number): string {
  return Math.trunc(value).toString().replace(/\B(?=(\d{3})+(?!\d))/g, "'");
}

const NON_RETURN_DAYS = LIECHTENSTEIN_REGIME.nonReturnThresholdDaysPerYear;
const CUSTOMS_UNION_SINCE = LIECHTENSTEIN_REGIME.customsUnionSince;
const MONETARY_UNION_SINCE = LIECHTENSTEIN_REGIME.monetaryUnionSince;
const CH_TO_LI = groupThousands(LIECHTENSTEIN_COMMUTING_CONTEXT.chToLi);
const LI_TO_CH = groupThousands(LIECHTENSTEIN_COMMUTING_CONTEXT.liToCh);
const FLOW_RATIO = LIECHTENSTEIN_COMMUTING_CONTEXT.ratio;
const FLOW_YEAR = LIECHTENSTEIN_COMMUTING_CONTEXT.year;

// ── Localized page chrome (facts themselves come from LIECHTENSTEIN_CONTENT) ──

interface Copy {
  role: string;
  updated: string;
  home: string;
  hubLabel: string;
  h1: (n: string) => string;
  /** Rung 1 of the <title> cascade — literally LIECHTENSTEIN_CONTENT's own
   *  municipalityTitle(), the required reuse target. */
  titleMid: (n: string) => string;
  titleShort: (n: string) => string;
  desc: (n: string) => string;
  /** Per-comune lede, first sentence authored here + a flow-inversion
   *  sentence built from the live CTX numbers (never a hard-coded copy of
   *  the content module's own hubLede string). */
  lede: (n: string) => string;
  tilePop: string;
  tilePopYear: string;
  tileNonReturn: string;
  tileCustoms: string;
  crossTitle: string;
  calcLink: string;
  relatedTitle: string;
  faqTitle: string;
  disclaimer: string;
  bridgeLede: (n: string) => string;
}

const COPY: Record<LiechtensteinLocale, Copy> = {
  it: {
    role: 'Guida frontalieri',
    updated: 'Aggiornato',
    home: 'Home',
    hubLabel: 'Vivere in Liechtenstein e lavorare in Svizzera',
    h1: (n) => `${LIECHTENSTEIN_CONTENT.it.municipalityTitle(n)}: tassazione nello Stato di residenza`,
    titleMid: (n) => `${n}: vivere in Liechtenstein, lavorare in CH`,
    titleShort: (n) => `Vivere a ${n} (LI)`,
    desc: (n) =>
      `Tassazione nello Stato di residenza (art. 15 cpv. 4), soglia dei ${NON_RETURN_DAYS} giorni di non rientro e flusso dominante invertito del corridoio per chi vive a ${n} e lavora in Svizzera.`,
    lede: (n) =>
      `${n} è uno degli 11 comuni del Liechtenstein: chi vi risiede e lavora in Svizzera come vero frontaliere giornaliero è tassato esclusivamente nello Stato di residenza (art. 15 cpv. 4 CDI CH-LI), a condizione di non superare ${NON_RETURN_DAYS} giorni lavorativi di non rientro all'anno. ` +
      `Attenzione: il flusso dominante di questo corridoio va nella direzione opposta — nel ${FLOW_YEAR} erano ${CH_TO_LI} le persone Svizzera → Liechtenstein contro ${LI_TO_CH} in questa direzione (${FLOW_RATIO}); questa guida copre il flusso minoritario, coerente con il pubblico del sito.`,
    tilePop: 'Popolazione',
    tilePopYear: 'Anno dato',
    tileNonReturn: 'Soglia non rientro',
    tileCustoms: 'Unione doganale dal',
    crossTitle: 'Approfondimenti utili',
    calcLink: 'Calcola il tuo stipendio netto',
    relatedTitle: 'Altri comuni del Liechtenstein',
    faqTitle: 'Domande frequenti',
    disclaimer:
      'Stime a scopo orientativo. Verifica sempre con un consulente fiscale o le autorità competenti prima di decidere.',
    bridgeLede: (n) =>
      `${n} è un comune del Liechtenstein ma è sotto la soglia di popolazione: la guida dedicata non è ancora pubblicata. Usa il calcolatore o esplora i comuni principali del Principato.`,
  },
  en: {
    role: 'Cross-border guide',
    updated: 'Updated',
    home: 'Home',
    hubLabel: 'Living in Liechtenstein, working in Switzerland',
    h1: (n) => `${LIECHTENSTEIN_CONTENT.en.municipalityTitle(n)}: taxed in your state of residence`,
    titleMid: (n) => `${n}: living in Liechtenstein, working in CH`,
    titleShort: (n) => `Living in ${n} (LI)`,
    desc: (n) =>
      `Taxed in your state of residence (art. 15 para 4), the ${NON_RETURN_DAYS}-day non-return threshold, and this corridor's inverted dominant flow for residents of ${n} working in Switzerland.`,
    lede: (n) =>
      `${n} is one of Liechtenstein's 11 municipalities: residents who work in Switzerland as genuine daily commuters are taxed exclusively in their state of residence (art. 15 para 4 CH-LI treaty), provided they don't exceed ${NON_RETURN_DAYS} non-return working days per year. ` +
      `Note: this corridor's dominant flow runs the other way — in ${FLOW_YEAR}, ${CH_TO_LI} people commuted Switzerland → Liechtenstein versus ${LI_TO_CH} in this direction (${FLOW_RATIO}); this guide covers the minority flow, consistent with this site's audience.`,
    tilePop: 'Population',
    tilePopYear: 'Data year',
    tileNonReturn: 'Non-return threshold',
    tileCustoms: 'Customs union since',
    crossTitle: 'Useful reading',
    calcLink: 'Calculate your net salary',
    relatedTitle: 'Other Liechtenstein municipalities',
    faqTitle: 'FAQ',
    disclaimer: 'Estimates for guidance only. Always check with a tax adviser or the competent authorities before deciding.',
    bridgeLede: (n) =>
      `${n} is a Liechtenstein municipality but below the population floor, so its dedicated guide is not published yet. Use the calculator or explore the Principality's main municipalities.`,
  },
  de: {
    role: 'Grenzgänger-Ratgeber',
    updated: 'Aktualisiert',
    home: 'Startseite',
    hubLabel: 'In Liechtenstein leben, in der Schweiz arbeiten',
    h1: (n) => `${LIECHTENSTEIN_CONTENT.de.municipalityTitle(n)}: Besteuerung im Wohnsitzstaat`,
    titleMid: (n) => `${n}: Wohnen in Liechtenstein, Arbeiten in CH`,
    titleShort: (n) => `Wohnen in ${n} (LI)`,
    desc: (n) =>
      `Besteuerung im Wohnsitzstaat (Art. 15 Abs. 4), die ${NON_RETURN_DAYS}-Tage-Nichtrückkehrschwelle und die umgekehrte Hauptrichtung dieses Korridors für Einwohner von ${n}, die in der Schweiz arbeiten.`,
    lede: (n) =>
      `${n} ist eine von 11 Gemeinden Liechtensteins: Wer hier wohnt und als echter Tagesgrenzgänger in der Schweiz arbeitet, wird ausschliesslich im Wohnsitzstaat besteuert (Art. 15 Abs. 4 DBA CH-LI), sofern nicht mehr als ${NON_RETURN_DAYS} Nichtrückkehr-Arbeitstage pro Jahr anfallen. ` +
      `Wichtig: Die Hauptrichtung dieses Korridors verläuft umgekehrt — ${FLOW_YEAR} pendelten ${CH_TO_LI} Personen Schweiz → Liechtenstein, gegenüber ${LI_TO_CH} in dieser Richtung (${FLOW_RATIO}); dieser Ratgeber deckt die Minderheitsrichtung ab, passend zur Leserschaft dieser Seite.`,
    tilePop: 'Einwohner',
    tilePopYear: 'Datenjahr',
    tileNonReturn: 'Nichtrückkehrschwelle',
    tileCustoms: 'Zollunion seit',
    crossTitle: 'Nützliche Lektüre',
    calcLink: 'Nettolohn berechnen',
    relatedTitle: 'Weitere Gemeinden Liechtensteins',
    faqTitle: 'Häufige Fragen',
    disclaimer: 'Schätzungen nur zur Orientierung. Immer mit einer Steuerberatung oder den zuständigen Behörden prüfen.',
    bridgeLede: (n) =>
      `${n} ist eine Gemeinde Liechtensteins, liegt aber unter der Bevölkerungsschwelle, daher ist der eigene Ratgeber noch nicht veröffentlicht. Nutzen Sie den Rechner oder erkunden Sie die grösseren Gemeinden des Fürstentums.`,
  },
  fr: {
    role: 'Guide frontalier',
    updated: 'Mis à jour',
    home: 'Accueil',
    hubLabel: 'Vivre au Liechtenstein, travailler en Suisse',
    h1: (n) => `${LIECHTENSTEIN_CONTENT.fr.municipalityTitle(n)} : imposition dans l'État de résidence`,
    titleMid: (n) => `${n} : vivre au Liechtenstein, travailler en CH`,
    titleShort: (n) => `Vivre à ${n} (LI)`,
    desc: (n) =>
      `Imposition dans l'État de résidence (art. 15 al. 4), seuil de ${NON_RETURN_DAYS} jours de non-retour et flux dominant inversé de ce corridor pour les habitants de ${n} qui travaillent en Suisse.`,
    lede: (n) =>
      `${n} est l'une des 11 communes du Liechtenstein : ses habitants qui travaillent en Suisse comme véritables frontaliers journaliers sont imposés exclusivement dans leur État de résidence (art. 15 al. 4 CDI CH-LI), à condition de ne pas dépasser ${NON_RETURN_DAYS} jours ouvrés de non-retour par an. ` +
      `Attention : le flux dominant de ce corridor va dans le sens inverse — en ${FLOW_YEAR}, ${CH_TO_LI} personnes faisaient le trajet Suisse → Liechtenstein contre ${LI_TO_CH} dans ce sens (${FLOW_RATIO}) ; ce guide couvre le flux minoritaire, cohérent avec le public de ce site.`,
    tilePop: 'Population',
    tilePopYear: 'Année des données',
    tileNonReturn: 'Seuil de non-retour',
    tileCustoms: 'Union douanière depuis',
    crossTitle: 'À lire aussi',
    calcLink: 'Calculez votre salaire net',
    relatedTitle: 'Autres communes du Liechtenstein',
    faqTitle: 'Questions fréquentes',
    disclaimer: "Estimations à titre indicatif. Vérifiez toujours avec un conseiller fiscal ou les autorités compétentes avant de décider.",
    bridgeLede: (n) =>
      `${n} est une commune du Liechtenstein mais en dessous du seuil de population : son guide dédié n'est pas encore publié. Utilisez le calculateur ou explorez les principales communes de la Principauté.`,
  },
};

const CALC_PATH: Record<LiechtensteinLocale, string> = {
  it: '/calcola-stipendio/',
  en: '/en/calculate-salary/',
  de: '/de/gehalt-berechnen/',
  fr: '/fr/calculer-salaire/',
};

// ── hreflang / breadcrumb ───────────────────────────────────────

function hreflangFor(slug: string, locales: readonly LiechtensteinLocale[] = LIECHTENSTEIN_LOCALES): string {
  const lines = locales.map(
    (alt) => `    <link rel="alternate" hreflang="${alt}" href="${BASE_URL}${liechtensteinMunicipalityPathFor(alt, slug)}">`,
  );
  if (locales.includes('it')) {
    lines.push(`    <link rel="alternate" hreflang="x-default" href="${BASE_URL}${liechtensteinMunicipalityPathFor('it', slug)}">`);
  }
  return lines.join('\n');
}

function breadcrumbLd(locale: LiechtensteinLocale, name: string, canonicalUrl: string): string {
  return inlineScriptJson({
    '@context': 'https://schema.org',
    '@type': 'BreadcrumbList',
    itemListElement: [
      { '@type': 'ListItem', position: 1, name: COPY[locale].home, item: `${BASE_URL}/` },
      { '@type': 'ListItem', position: 2, name: COPY[locale].hubLabel, item: `${BASE_URL}${LIECHTENSTEIN_HUB_PATH[locale]}` },
      { '@type': 'ListItem', position: 3, name, item: canonicalUrl },
    ],
  });
}

// ── Page renderers ──────────────────────────────────────────────

function renderRelated(locale: LiechtensteinLocale, current: LiechtensteinBorderMunicipality): string {
  const others = LIECHTENSTEIN_ABOVE_FLOOR.filter((m) => m.slug !== current.slug);
  if (others.length === 0) return '';
  const links = others
    .map(
      (m) =>
        `<a class="rounded-md border border-edge bg-surface-raised p-3 text-sm font-semibold text-heading hover:border-accent-border" href="${liechtensteinMunicipalityPathFor(locale, m.slug)}">${esc(m.name)}</a>`,
    )
    .join('');
  return `<section class="mt-6 rounded-md border border-edge bg-surface p-5">
      <h2 class="text-xl font-bold text-heading">${esc(COPY[locale].relatedTitle)}</h2>
      <div class="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">${links}</div>
    </section>`;
}

function renderFaqSection(locale: LiechtensteinLocale, faqTitle: string): string {
  const faq = LIECHTENSTEIN_CONTENT[locale].faq;
  const items = faq
    .map(
      (entry, i) =>
        `<details class="py-3"${i === 0 ? ' open' : ''}><summary class="cursor-pointer font-semibold text-heading">${esc(entry.question)}</summary><p class="mt-2 text-sm leading-6 text-body">${esc(entry.answer)}</p></details>`,
    )
    .join('');
  return `<section class="mt-6 rounded-md border border-edge bg-surface p-5">
      <h2 class="text-xl font-bold text-heading">${esc(faqTitle)}</h2>
      <div class="mt-4 divide-y divide-edge">${items}</div>
    </section>`;
}

function faqLdFor(locale: LiechtensteinLocale): string {
  const faq = LIECHTENSTEIN_CONTENT[locale].faq;
  return inlineScriptJson({
    '@context': 'https://schema.org',
    '@type': 'FAQPage',
    mainEntity: faq.map((entry) => ({
      '@type': 'Question',
      name: entry.question,
      acceptedAnswer: { '@type': 'Answer', text: entry.answer },
    })),
  });
}

export function renderAboveFloorPage(params: {
  municipality: LiechtensteinBorderMunicipality;
  locale: LiechtensteinLocale;
  dateStamp: string;
  distDir: string;
}): { urlPath: string; html: string; wordCount: number } {
  const { municipality, locale, dateStamp, distDir } = params;
  const c = COPY[locale];
  const content = LIECHTENSTEIN_CONTENT[locale];
  const n = municipality.name;
  const canonicalPath = liechtensteinMunicipalityPathFor(locale, municipality.slug);
  const canonicalUrl = `${BASE_URL}${canonicalPath}`;

  const tile = (label: string, value: string) =>
    `<div class="rounded-md border border-edge bg-surface p-4">
        <dt class="text-xs font-semibold uppercase tracking-wide text-muted">${esc(label)}</dt>
        <dd class="mt-1 text-2xl font-bold text-heading">${esc(value)}</dd>
      </div>`;

  const body = `<div class="mx-auto max-w-4xl px-4 py-6 sm:px-6 lg:px-8">
    <nav class="mb-4 text-sm text-muted" aria-label="Breadcrumb">
      <a class="text-link hover:text-link-hover" href="/">${esc(c.home)}</a>
      <span class="mx-2">/</span>
      <a class="text-link hover:text-link-hover" href="${LIECHTENSTEIN_HUB_PATH[locale]}">${esc(c.hubLabel)}</a>
      <span class="mx-2">/</span>
      <span>${esc(n)}</span>
    </nav>

    <header class="rounded-md border border-edge bg-surface p-5 sm:p-7" data-speakable>
      <div class="flex flex-wrap items-center gap-2 text-sm">
        <span class="rounded-full border border-info-border bg-info-subtle px-3 py-1 font-semibold text-info">${esc(c.role)}</span>
      </div>
      <h1 class="mt-4 text-3xl font-bold leading-tight text-heading sm:text-4xl">${esc(c.h1(n))}</h1>
      <p class="mt-3 max-w-3xl text-base leading-7 text-body">${esc(c.lede(n))}</p>
      <p class="mt-3 text-sm text-muted">${esc(c.updated)}: <time datetime="${dateStamp}">${dateStamp}</time></p>
    </header>

    <dl class="mt-5 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
      ${tile(c.tilePop, intFmt(municipality.population, locale))}
      ${tile(c.tilePopYear, String(municipality.populationYear))}
      ${tile(c.tileNonReturn, `${NON_RETURN_DAYS}`)}
      ${tile(c.tileCustoms, String(CUSTOMS_UNION_SINCE))}
    </dl>

    <section class="mt-6 rounded-md border border-accent-border bg-accent-subtle p-5">
      <p class="text-sm leading-6 text-body">${esc(commutingDisclosure(content))}</p>
    </section>

    <section class="mt-6 rounded-md border border-edge bg-surface p-5">
      <h2 class="text-xl font-bold text-heading">${esc(c.crossTitle)}</h2>
      <div class="mt-4 grid gap-3 sm:grid-cols-2">
        <a class="rounded-md border border-accent-border bg-accent-subtle p-4 text-sm font-semibold text-heading hover:border-accent-strong" href="${CALC_PATH[locale]}">${esc(c.calcLink)}</a>
        <a class="rounded-md border border-edge bg-surface-raised p-4 text-sm font-semibold text-heading hover:border-accent-border" href="${LIECHTENSTEIN_HUB_PATH[locale]}">${esc(c.hubLabel)}</a>
      </div>
    </section>

    ${renderRelated(locale, municipality)}

    ${renderFaqSection(locale, c.faqTitle)}

    <p class="mt-6 text-xs leading-5 text-muted">${esc(c.disclaimer)}</p>
  </div>`;

  const wordCount = countHtmlBodyWords(body);
  const bodyWithAd = `${body}${endOfContentMultiplexHtml({ indexable: wordCount >= MIN_INDEXABLE_WORDS })}`;

  // Budget-aware, keyword-preserving cascade (composePlaceTitle) — three
  // rungs, longest-first (issue #4886): rung 1 reuses
  // LIECHTENSTEIN_CONTENT's own municipalityTitle() (the required reuse
  // target) → titleMid (name + role) → titleShort (still carries the core
  // "living in {name}" keyword per locale). The bare Gemeinde name is NEVER
  // a candidate.
  const titleCandidates = [content.municipalityTitle(n), c.titleMid(n), c.titleShort(n)];
  const html = buildSeoPageHtml({
    locale,
    title: composePlaceTitle(titleCandidates, TITLE_MAX_CHARS, (s) => esc(s).length),
    description: c.desc(n),
    canonicalUrl,
    robots: wordCount >= MIN_INDEXABLE_WORDS ? 'index,follow' : 'noindex,follow',
    ogLocale: OG_LOCALE[locale],
    hreflangHtml: hreflangFor(municipality.slug),
    jsonLdScripts: [breadcrumbLd(locale, n, canonicalUrl), faqLdFor(locale)],
    bodyHtml: bodyWithAd,
    distDir,
    skipMainWrap: true,
  });

  return { urlPath: canonicalPath, html, wordCount };
}

export function renderBridgePage(params: {
  municipality: LiechtensteinBorderMunicipality;
  locale: LiechtensteinLocale;
  distDir: string;
}): string {
  const { municipality, locale, distDir } = params;
  const c = COPY[locale];
  const content = LIECHTENSTEIN_CONTENT[locale];
  const n = municipality.name;
  const canonicalPath = liechtensteinMunicipalityPathFor(locale, municipality.slug);
  const canonicalUrl = `${BASE_URL}${canonicalPath}`;

  const body = `<main class="seo-static-content mx-auto max-w-[760px] px-5 pt-8 pb-14 text-body">
    <nav class="mb-4 text-sm text-muted" aria-label="Breadcrumb">
      <a class="text-link hover:text-link-hover" href="/">${esc(c.home)}</a>
      <span class="mx-2">/</span>
      <a class="text-link hover:text-link-hover" href="${LIECHTENSTEIN_HUB_PATH[locale]}">${esc(c.hubLabel)}</a>
      <span class="mx-2">/</span>
      <span>${esc(n)}</span>
    </nav>
    <h1 class="text-2xl font-bold text-heading mb-3">${esc(c.h1(n))}</h1>
    <p class="text-body mb-5 leading-6">${esc(c.bridgeLede(n))}</p>
    <ul class="space-y-2 list-none p-0 m-0">
      <li><a href="${CALC_PATH[locale]}" class="text-sm font-semibold text-link">${esc(c.calcLink)} →</a></li>
      <li><a href="${LIECHTENSTEIN_HUB_PATH[locale]}" class="text-sm font-semibold text-link">${esc(c.hubLabel)} →</a></li>
    </ul>
  </main>`;

  return buildSeoPageHtml({
    locale,
    title: content.municipalityTitle(n),
    description: c.desc(n),
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

function renderHubPage(params: { locale: LiechtensteinLocale; dateStamp: string; distDir: string }): {
  urlPath: string;
  html: string;
} {
  const { locale, dateStamp, distDir } = params;
  const c = COPY[locale];
  const content = LIECHTENSTEIN_CONTENT[locale];
  const canonicalPath = LIECHTENSTEIN_HUB_PATH[locale];
  const canonicalUrl = `${BASE_URL}${canonicalPath}`;

  const cards = LIECHTENSTEIN_ABOVE_FLOOR.map(
    (m) =>
      `<a class="rounded-md border border-edge bg-surface-raised p-4 hover:border-accent-border" href="${liechtensteinMunicipalityPathFor(locale, m.slug)}">
        <span class="block text-sm font-semibold text-heading">${esc(m.name)}</span>
        <span class="mt-1 block text-xs text-muted">${intFmt(m.population, locale)}</span>
      </a>`,
  ).join('');

  const body = `<div class="mx-auto max-w-5xl px-4 py-6 sm:px-6 lg:px-8">
    <nav class="mb-4 text-sm text-muted" aria-label="Breadcrumb">
      <a class="text-link hover:text-link-hover" href="/">${esc(c.home)}</a>
      <span class="mx-2">/</span>
      <span>${esc(c.hubLabel)}</span>
    </nav>
    <header class="rounded-md border border-edge bg-surface p-5 sm:p-7">
      <h1 class="text-3xl font-bold leading-tight text-heading sm:text-4xl">${esc(content.hubTitle)}</h1>
      <p class="mt-3 max-w-3xl text-base leading-7 text-body">${esc(content.hubLede)}</p>
      <p class="mt-3 text-sm text-muted">${esc(c.updated)}: <time datetime="${dateStamp}">${dateStamp}</time></p>
    </header>
    <div class="mt-5 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">${cards}</div>
    ${renderFaqSection(locale, c.faqTitle)}
    <p class="mt-6 text-xs leading-5 text-muted">${esc(c.disclaimer)}</p>
  </div>`;

  const wordCount = countHtmlBodyWords(body);
  const bodyWithAd = `${body}${endOfContentMultiplexHtml({ indexable: wordCount >= MIN_INDEXABLE_WORDS })}`;

  const hubHreflang = LIECHTENSTEIN_LOCALES.map(
    (alt) => `    <link rel="alternate" hreflang="${alt}" href="${BASE_URL}${LIECHTENSTEIN_HUB_PATH[alt]}">`,
  )
    .concat(`    <link rel="alternate" hreflang="x-default" href="${BASE_URL}${LIECHTENSTEIN_HUB_PATH.it}">`)
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
    title: content.hubTitle,
    description: content.hubLede,
    canonicalUrl,
    robots: 'index,follow',
    ogLocale: OG_LOCALE[locale],
    hreflangHtml: hubHreflang,
    jsonLdScripts: [breadcrumb, faqLdFor(locale)],
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

  urls.push(
    entry(
      LIECHTENSTEIN_HUB_PATH.it,
      LIECHTENSTEIN_LOCALES.map((l) => ({ hreflang: l as string, href: `${BASE_URL}${LIECHTENSTEIN_HUB_PATH[l]}` })).concat({
        hreflang: 'x-default',
        href: `${BASE_URL}${LIECHTENSTEIN_HUB_PATH.it}`,
      }),
      '0.7',
    ),
  );

  for (const m of LIECHTENSTEIN_ABOVE_FLOOR) {
    urls.push(
      entry(
        liechtensteinMunicipalityPathFor('it', m.slug),
        LIECHTENSTEIN_LOCALES.map((l) => ({
          hreflang: l as string,
          href: `${BASE_URL}${liechtensteinMunicipalityPathFor(l, m.slug)}`,
        })).concat({
          hreflang: 'x-default',
          href: `${BASE_URL}${liechtensteinMunicipalityPathFor('it', m.slug)}`,
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

export function liechtensteinBorderMunicipalityPagesPlugin(rootDir: string): Plugin {
  return {
    name: 'liechtenstein-border-municipality-pages',
    apply: 'build',
    enforce: 'post',
    async closeBundle() {
      if (process.env.SKIP_LIECHTENSTEIN_BORDER_MUNICIPALITY_PAGES === '1') {
        console.log('\x1b[36m[liechtenstein-border-municipalities]\x1b[0m skipped (SKIP_LIECHTENSTEIN_BORDER_MUNICIPALITY_PAGES=1)');
        resolveLiechtensteinBorderMunicipalitiesFlushed([]);
        return;
      }
      const distDir = path.resolve(rootDir, 'dist');
      if (!fs.existsSync(distDir)) {
        resolveLiechtensteinBorderMunicipalitiesFlushed([]);
        return;
      }

      const dateStamp = new Date().toISOString().slice(0, 10);
      const collector = new WriteCollector({ distDir, pluginName: 'liechtensteinBorderMunicipalityPagesPlugin' });
      const t0 = Date.now();
      let indexablePages = 0;
      let bridgePages = 0;
      let thinPages = 0;

      const hubPaths: string[] = [];
      for (const locale of LIECHTENSTEIN_LOCALES) {
        const { urlPath, html } = renderHubPage({ locale, dateStamp, distDir });
        collector.add(path.join(distDir, urlPath, 'index.html'), html);
        collector.add(path.join(distDir, urlPath.replace(/\/+$/, '') + '.html'), html);
        hubPaths.push(urlPath);
      }

      for (const municipality of LIECHTENSTEIN_ABOVE_FLOOR) {
        for (const locale of LIECHTENSTEIN_LOCALES) {
          const { urlPath, html, wordCount } = renderAboveFloorPage({ municipality, locale, dateStamp, distDir });
          if (wordCount < MIN_INDEXABLE_WORDS) thinPages++;
          collector.add(path.join(distDir, urlPath, 'index.html'), html);
          collector.add(path.join(distDir, urlPath.replace(/\/+$/, '') + '.html'), html);
          indexablePages++;
        }
      }

      for (const municipality of LIECHTENSTEIN_BELOW_FLOOR) {
        for (const locale of LIECHTENSTEIN_LOCALES) {
          const urlPath = liechtensteinMunicipalityPathFor(locale, municipality.slug);
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
        `\x1b[36m[liechtenstein-border-municipalities]\x1b[0m ${LIECHTENSTEIN_ABOVE_FLOOR.length} above-floor + ${LIECHTENSTEIN_BELOW_FLOOR.length} below-floor → ` +
          `${indexablePages} pages (${thinPages} thin) + ${bridgePages} bridges + ${LIECHTENSTEIN_LOCALES.length} hubs — ` +
          `flushed ${written} files in ${((Date.now() - t0) / 1000).toFixed(1)}s`,
      );

      // Unblocks liechtensteinBorderMunicipalityLinksPlugin, which injects a
      // hub link into the per-locale HTML sitemap page — without it the
      // whole sitemap-comuni-liechtenstein.xml shard ships BFS-unreachable
      // from `/` (same orphan-tier hazard as the France/Germany families,
      // audit:max-bfs-depth regression #4593).
      resolveLiechtensteinBorderMunicipalitiesFlushed(hubPaths);
    },
  };
}
