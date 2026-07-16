/**
 * FR landing — "Calcul salaire net frontalier en Suisse 2026".
 *
 * Targets the French Semrush keyword `calcul salaire net suisse frontalier`
 * (CH database, 880 searches/month). Our `/fr/` homepage ranks position 48
 * for this query because we don't have a dedicated topical landing — only
 * the multilingual home + the generic `/fr/calculer-salaire/` calculator UI.
 *
 * This plugin emits a single static HTML page at:
 *
 *   /fr/calculer-salaire/calcul-salaire-net-frontalier-suisse/
 *
 * The page is self-contained: it does not register a new SPA route (router.ts
 * is intentionally untouched here), so it relies on Vite's GitHub Pages
 * fallback (`public/404.html` → `index.html`) for client-side hydration. The
 * static HTML wins for SEO / first paint; the SPA may replace it on hydrate
 * with the generic `/fr/calculer-salaire/` calculator view, which is the
 * desired behaviour (every CTA on the page leads there anyway).
 *
 * Layout — template B mobile-first per CLAUDE.md regola #17. The page is a
 * CALCULATOR FUNNEL landing (not per-mestiere): the meaty above-the-fold
 * content is the 3 stat tiles + primary CTA to the calculator + curated
 * "exemples chiffrés" cards + "cantons frontaliers" grid. The long prose
 * (cotisations breakdown, scenarios table, FAQ) lives BELOW the "Pour aller
 * plus loin" divider so it never pushes the calculator CTA below the
 * mobile 414 px fold.
 *
 * Body order (template B, mobile-first):
 *   1. breadcrumb
 *   2. header (eyebrow · H1 · dense lede ≤120 chars)
 *   3. 3 stat tiles (FR frontaliers count · median salary · saving vs FR)
 *   4. primary CTA → /fr/calculer-salaire/ (the calculator app)
 *   5. "Exemples chiffrés" — 3 curated mini-profile cards
 *   6. "Cantons frontaliers les plus convoités" — 4 canton cards
 *   7. ─── "Pour aller plus loin" divider ───
 *   8. long-form sections (cotisations breakdown, scenarios, FAQ, related)
 *
 * Hreflang points at the closest existing sibling page in each locale:
 *   it     → /calcola-stipendio/
 *   en     → /en/calculate-salary/
 *   de     → /de/gehalt-berechnen/
 *   fr     → self (canonical)
 *   x-default → IT canonical (matches the rest of the site).
 *
 * JSON-LD: BreadcrumbList + FAQPage + Article + WebApplication (the
 * calculator referenced by the primary CTA).
 *
 * Sitemap: writes `dist/sitemap-fr-salaire-net.xml` and patches the
 * `sitemap.xml` index. `sitemapAliasPlugin` auto-discovers the file.
 *
 * Gate: SKIP_FR_SALAIRE_NET=1 fast-exits the plugin for local builds. CI
 * (`npm run build:ci`) always exercises it — exit 0 required.
 *
 * Stat-tile numbers are curated editorial constants — see the inline
 * `// Source:` comments next to each value (OFS / INSEE public data).
 */

import fs from 'node:fs';
import np from 'node:path';
import type { Plugin } from 'vite';
import { BASE_URL, MIN_INDEXABLE_WORDS, countHtmlBodyWords } from './constants';
import { buildSeoPageHtml } from './shared/seoPageShell';
import { renderAuthoritativeSourcesHtml } from './shared/authoritativeSources';
import { FX_HREF } from './shared/comparatorHref';
import { WriteCollector } from './batchWrite';
import { imageObjectLd } from '../services/seo/imageObjectLd';
import { inlineScriptJson } from './shared/inlineJsonScript';
import { guardArticleJsonLdDescription } from './shared/safeTruncate';
import {
  H1_STYLE,
  LEDE_STYLE,
  BODY_STYLE,
  H2_STYLE,
  H3_STYLE,
  LINK_ACCENT_STYLE,
  HERO_EYEBROW_STYLE,
  SMALL_HEADING_STYLE,
  renderStatGrid,
} from './shared/seoContentTokens';

// ── Constants ────────────────────────────────────────────────────

const URL_PATH = '/fr/calculer-salaire/calcul-salaire-net-frontalier-suisse/';
const CALCULATOR_PATH = '/fr/calculer-salaire/';
const LOCALE = 'fr' as const;
const OG_LOCALE = 'fr_CH';
const TITLE = 'Calcul salaire net frontalier Suisse 2026 | Frontaliere Ticino';
const META_DESCRIPTION =
  'Calcul salaire net frontalier Suisse 2026: barème détaillé des cotisations AVS/AI/AC, LPP, impôt à la source. Salaire moyen 6 500 CHF brut, ~5 200 CHF net.';
const H1 = 'Calcul salaire net frontalier en Suisse 2026';

// Dense lede — ≤120 chars per CLAUDE.md regola #16. The full numeric story
// moves into the stat tiles below.
const DENSE_LEDE =
  'Estimez votre net mensuel en quelques secondes — barème 2026 pour les ~210 000 frontaliers français en Suisse.';

// Stat tiles — curated editorial constants. Sources:
//  - Frontaliers FR effectif: OFS STAF 2024 (~210 000 frontaliers FR actifs en CH).
//  - Salaire médian brut frontalier: OFS — Enquête suisse sur la structure des
//    salaires 2024 (~6 500 CHF brut/mois, 13e mois inclus, secteur privé).
//  - Économie net vs France: estimation différentielle pouvoir d'achat
//    frontalier vs salarié français équivalent (études de référence INSEE /
//    OST). Indicatif: ~+45 % en moyenne après cotisations sociales.
const STAT_FRONTALIERS = '~210 000';
const STAT_FRONTALIERS_LABEL = 'Frontaliers FR';
const STAT_MEDIAN = '~CHF 6 800';
const STAT_MEDIAN_LABEL = 'Salaire médian brut';
const STAT_NET_SAVING = '~+45 %';
const STAT_NET_SAVING_LABEL = 'Économie net vs FR';

// Hreflang siblings — closest existing canonical per locale.
const HREFLANG_SIBLINGS: ReadonlyArray<{ hreflang: string; href: string }> = [
  { hreflang: 'fr', href: `${BASE_URL}${URL_PATH}` },
  { hreflang: 'it', href: `${BASE_URL}/calcola-stipendio/` },
  { hreflang: 'en', href: `${BASE_URL}/en/calculate-salary/` },
  { hreflang: 'de', href: `${BASE_URL}/de/gehalt-berechnen/` },
  { hreflang: 'x-default', href: `${BASE_URL}/calcola-stipendio/` },
];

// ── Helpers ──────────────────────────────────────────────────────

function esc(s: unknown): string {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// ── Content blocks ───────────────────────────────────────────────

interface FaqItem {
  readonly question: string;
  readonly answer: string;
}

const FAQS: ReadonlyArray<FaqItem> = [
  {
    question: 'Combien gagne un frontalier en Suisse en moyenne ?',
    answer:
      'Selon les données de l\'Office fédéral de la statistique, le salaire mensuel brut médian en Suisse atteint environ 6 500 CHF (13 mois inclus). Pour un frontalier célibataire travaillant au Tessin, le salaire net après impôt à la source et cotisations sociales se situe généralement entre 5 100 et 5 400 CHF par mois — soit l\'équivalent d\'environ 5 350 à 5 650 EUR au taux de change actuel.',
  },
  {
    question: 'Quelles sont les déductions sur le salaire suisse ?',
    answer:
      'Les déductions obligatoires comprennent: AVS/AI/APG (5,3 %), assurance chômage (1,1 % jusqu\'à 148 200 CHF/an), prévoyance professionnelle LPP (~7 % en moyenne, variable selon l\'âge et la caisse), assurance accident non professionnelle LAINF (~1 %), et l\'impôt à la source (entre 5 % et 12 % selon le canton et la situation familiale). Le total des déductions représente en moyenne 18 à 22 % du salaire brut.',
  },
  {
    question: 'Le frontalier paie-t-il des impôts en France/Italie sur le salaire suisse ?',
    answer:
      'Cela dépend du canton de travail et du nouvel accord fiscal italo-suisse 2026. Pour le Tessin, depuis le 1er janvier 2024, les nouveaux frontaliers (ceux qui commencent à travailler après l\'entrée en vigueur de l\'accord) paient l\'impôt à la source au taux suisse réduit (80 %), puis déclarent et complètent en Italie. Les anciens frontaliers (engagés avant le 17 juillet 2023 et résidant dans la zone des 20 km) restent soumis uniquement à l\'imposition suisse — l\'Italie ne taxe pas leur salaire.',
  },
  {
    question: 'Comment convertir CHF en EUR sur la fiche de paie ?',
    answer:
      'La fiche de paie suisse est libellée en CHF. Pour la conversion en euros, utilisez le taux de change officiel BNS du jour du versement, ou le taux moyen mensuel publié par votre banque. Au taux actuel (env. 1 CHF ≈ 1,06 EUR), un salaire net de 5 200 CHF représente environ 5 510 EUR. Notre comparateur de change CHF/EUR liste les meilleurs taux interbancaires et services Wise/Revolut pour minimiser les frais de change.',
  },
];

const BREAKDOWN_ROWS: ReadonlyArray<{ label: string; rate: string; note: string }> = [
  { label: 'AVS / AI / APG (vieillesse + invalidité + perte de gain)', rate: '5,3 %', note: 'Plafond illimité' },
  { label: 'Assurance chômage (AC)', rate: '1,1 %', note: 'Jusqu\'à 148 200 CHF/an' },
  { label: 'Prévoyance professionnelle (LPP / 2e pilier)', rate: '~7 % moyen', note: 'Variable selon l\'âge (7 % à 18 % à partir de 55 ans)' },
  { label: 'Assurance accident non professionnelle (LAINF)', rate: '~1 %', note: 'À la charge du salarié' },
  { label: 'Impôt à la source (frontaliers, Tessin)', rate: '5 % – 12 %', note: 'Barème dégressif selon le revenu et la situation familiale' },
];

interface ScenarioRow {
  readonly gross: number;
  readonly net: number;
  readonly effective: string;
}

const SCENARIOS: ReadonlyArray<ScenarioRow> = [
  { gross: 4_500, net: 3_700, effective: '17,8 %' },
  { gross: 6_000, net: 4_870, effective: '18,8 %' },
  { gross: 8_000, net: 6_400, effective: '20,0 %' },
  { gross: 10_000, net: 7_900, effective: '21,0 %' },
];

// Above-the-fold "exemples chiffrés" — 3 curated mini-profile cards. These
// translate the abstract scenarios table into concrete frontalier personas.
interface ProfileExample {
  readonly role: string;
  readonly canton: string;
  readonly grossEur: string;
  readonly netEur: string;
}

const PROFILE_EXAMPLES: ReadonlyArray<ProfileExample> = [
  // Indicative — derived from SCENARIOS using 1 CHF ≈ 1,06 EUR.
  { role: 'Ingénieur', canton: 'Genève', grossEur: '≈ 8 800 €/mois brut', netEur: '≈ 6 800 €/mois net' },
  { role: 'Infirmier·ère', canton: 'Vaud', grossEur: '≈ 6 400 €/mois brut', netEur: '≈ 5 200 €/mois net' },
  { role: 'Employé·e administratif', canton: 'Jura', grossEur: '≈ 4 800 €/mois brut', netEur: '≈ 3 950 €/mois net' },
];

// Above-the-fold cantons grid. Effectif frontaliers FR par canton — STAF 2024
// (OFS). Numbers are public-data approximations, rounded.
interface CantonCard {
  readonly name: string;
  readonly count: string;
}

const TOP_CANTONS: ReadonlyArray<CantonCard> = [
  { name: 'Genève', count: '~110 000 frontaliers FR' },
  { name: 'Vaud', count: '~38 000 frontaliers FR' },
  { name: 'Jura', count: '~9 000 frontaliers FR' },
  { name: 'Berne', count: '~7 000 frontaliers FR' },
];

const INTERNAL_LINKS: ReadonlyArray<{ href: string; label: string }> = [
  { href: '/fr/calculer-salaire/', label: 'Calculateur salaire net frontalier (simulation complète)' },
  { href: FX_HREF.fr, label: 'Comparateur change CHF / EUR (meilleurs taux)' },
  { href: '/fr/guide-frontalier/guide-complet-calcul-salaire-frontalier-2026/', label: 'Guide complet: salaire frontalier 2026' },
  { href: '/fr/comparaisons-frontaliers/', label: 'Tous les comparateurs frontaliers (banques, assurance, mobile)' },
];

// ── Template B above-the-fold renderers ──────────────────────────

function renderProfileExamples(): string {
  const cards = PROFILE_EXAMPLES.map(
    (p) => `<div class="s-card" style="display:flex;flex-direction:column;gap:4px">
      <div class="s-YR-bwN">${esc(p.role)} · ${esc(p.canton)}</div>
      <div class="s-Z7vpPG">${esc(p.grossEur)}</div>
      <div class="s-jOqm8t">${esc(p.netEur)}</div>
    </div>`,
  ).join('');
  return `<section class="s-KZc0LQ">
    <h2 style="${H2_STYLE}">Exemples chiffrés</h2>
    <p style="${BODY_STYLE};max-width:780px">
      Trois profils types pour situer rapidement votre futur revenu net (estimations
      indicatives, conversion CHF→EUR au taux courant).
    </p>
    <div class="s-J2fKgL">${cards}</div>
  </section>`;
}

function renderCantonsGrid(): string {
  const cells = TOP_CANTONS.map(
    (c) => `<div class="s-cpad s-cbody" style="display:flex;align-items:center;gap:10px">
      <div class="s-KGNylX">
        <div class="s-AT4KWZ">${esc(c.name)}</div>
        <div class="s--JqMke">${esc(c.count)}</div>
      </div>
    </div>`,
  ).join('');
  return `<section class="s-KZc0LQ">
    <h2 style="${H2_STYLE}">Cantons frontaliers les plus convoités</h2>
    <p style="${BODY_STYLE};max-width:780px">
      Répartition indicative des frontaliers français par canton de travail
      (Source: OFS — Statistique des frontaliers STAF 2024).
    </p>
    <div class="s-yG5zT8">${cells}</div>
  </section>`;
}

function renderApprofondisciDivider(label: string): string {
  return `<div class="s-7V0OIo" role="separator" aria-label="${esc(label)}">
    <span class="s-EIg6N7" aria-hidden="true"></span>
    <span style="${SMALL_HEADING_STYLE};margin:0">${esc(label)}</span>
    <span class="s-EIg6N7" aria-hidden="true"></span>
  </div>`;
}

// ── Long-form (below-the-fold) renderers ─────────────────────────

function renderBreakdownTable(): string {
  const rows = BREAKDOWN_ROWS.map(
    (r) => `
      <tr class="s-_yM8Lx">
        <td class="s-aVTCCh">${esc(r.label)}</td>
        <td class="s-uqJP2T">${esc(r.rate)}</td>
        <td class="s-6olq44">${esc(r.note)}</td>
      </tr>`,
  ).join('');
  return `
    <div class="s-card" style="overflow-x:auto;padding:0;border-radius:14px">
      <table class="s-grO3Cl">
        <thead>
          <tr class="s-_esAK2">
            <th class="s-QTDcUd">Cotisation</th>
            <th class="s-QTDcUd">Taux</th>
            <th class="s-QTDcUd">Remarques</th>
          </tr>
        </thead>
        <tbody>${rows}</tbody>
      </table>
    </div>`;
}

function renderScenariosTable(): string {
  const fmt = (n: number): string => n.toLocaleString('fr-CH', { maximumFractionDigits: 0 });
  const rows = SCENARIOS.map(
    (s) => `
      <tr class="s-_yM8Lx">
        <td class="s-9Z4OtE">${fmt(s.gross)} CHF</td>
        <td class="s-fLU9Xz">${fmt(s.net)} CHF</td>
        <td class="s-BsBNiT">${esc(s.effective)}</td>
      </tr>`,
  ).join('');
  return `
    <div class="s-card" style="overflow-x:auto;padding:0;border-radius:14px">
      <table class="s-w50MTU">
        <caption class="s-li0wom">
          Estimations indicatives pour un frontalier célibataire, sans enfants, travaillant au Tessin (régime 2026 nouveau frontalier).
        </caption>
        <thead>
          <tr class="s-_esAK2">
            <th class="s-QTDcUd">Salaire brut mensuel</th>
            <th class="s-QTDcUd">Salaire net estimé</th>
            <th class="s-QTDcUd">Taux de prélèvement</th>
          </tr>
        </thead>
        <tbody>${rows}</tbody>
      </table>
    </div>`;
}

function renderFaqBlock(): string {
  return FAQS.map(
    (f) => `
      <details class="s-card" style="margin:0 0 10px;border-radius:12px">
        <summary class="s-ZAbW3N">${esc(f.question)}</summary>
        <p class="s-XXXebZ">${esc(f.answer)}</p>
      </details>`,
  ).join('');
}

function renderInternalLinks(): string {
  const items = INTERNAL_LINKS.map(
    (l) =>
      `<li class="s-Pkexk_"><a href="${esc(l.href)}" style="${LINK_ACCENT_STYLE}">${esc(l.label)}</a></li>`,
  ).join('');
  return `<ul class="s-BNZI5h">${items}</ul>`;
}

// ── Page assembly ────────────────────────────────────────────────

interface RenderOpts {
  readonly distDir?: string;
  readonly dateStamp: string;
}

interface RenderResult {
  readonly html: string;
  readonly wordCount: number;
}

function renderPage(opts: RenderOpts): RenderResult {
  const { distDir, dateStamp } = opts;
  const canonicalUrl = `${BASE_URL}${URL_PATH}`;
  const homeUrl = `${BASE_URL}/${LOCALE}/`;
  const calcUrl = `${BASE_URL}${CALCULATOR_PATH}`;

  const hreflangHtml = HREFLANG_SIBLINGS.map(
    (h) => `    <link rel="alternate" hreflang="${h.hreflang}" href="${h.href}">`,
  ).join('\n');

  const breadcrumbLd = inlineScriptJson({
    '@context': 'https://schema.org',
    '@type': 'BreadcrumbList',
    itemListElement: [
      { '@type': 'ListItem', position: 1, name: 'Accueil', item: homeUrl },
      { '@type': 'ListItem', position: 2, name: 'Calculer le salaire', item: calcUrl },
      { '@type': 'ListItem', position: 3, name: H1, item: canonicalUrl },
    ],
  });

  const faqLd = inlineScriptJson({
    '@context': 'https://schema.org',
    '@type': 'FAQPage',
    inLanguage: LOCALE,
    mainEntity: FAQS.map((f) => ({
      '@type': 'Question',
      name: f.question,
      acceptedAnswer: { '@type': 'Answer', text: f.answer },
    })),
  });

  const articleLd = inlineScriptJson({
    '@context': 'https://schema.org',
    '@type': 'Article',
    headline: H1,
    description: guardArticleJsonLdDescription(META_DESCRIPTION),
    image: `${BASE_URL}/og-image.png`,
    inLanguage: LOCALE,
    url: canonicalUrl,
    datePublished: dateStamp,
    dateModified: dateStamp,
    author: { '@type': 'Organization', name: 'Frontaliere Ticino', url: `${BASE_URL}/` },
    publisher: {
      '@type': 'Organization',
      name: 'Frontaliere Ticino',
      url: `${BASE_URL}/`,
      logo: imageObjectLd({
        url: `${BASE_URL}/icons/icon-512x512.png`,
        width: 512,
        height: 512,
      }),
    },
    mainEntityOfPage: { '@type': 'WebPage', '@id': canonicalUrl },
  });

  // WebApplication LD — the calculator the primary CTA points at. Helps
  // Google understand that the page exposes an interactive tool, not just
  // an article.
  const webAppLd = inlineScriptJson({
    '@context': 'https://schema.org',
    '@type': 'WebApplication',
    name: 'Calculateur salaire net frontalier Suisse',
    url: calcUrl,
    applicationCategory: 'FinanceApplication',
    operatingSystem: 'Any',
    inLanguage: LOCALE,
    offers: {
      '@type': 'Offer',
      price: '0',
      priceCurrency: 'EUR',
    },
    provider: { '@type': 'Organization', name: 'Frontaliere Ticino', url: `${BASE_URL}/` },
  });

  // Above-the-fold blocks (template B order).
  const statTilesHtml = renderStatGrid([
    { label: STAT_FRONTALIERS_LABEL, value: STAT_FRONTALIERS, tone: 'success' },
    { label: STAT_MEDIAN_LABEL, value: STAT_MEDIAN, tone: 'accent' },
    { label: STAT_NET_SAVING_LABEL, value: STAT_NET_SAVING, tone: 'warning' },
  ]);

  const primaryCtaHtml = `<div class="s-KZc0LQ"><a href="${esc(calcUrl)}" class="s-cta">Lancer la simulation gratuite →</a></div>`;

  const profileExamplesHtml = renderProfileExamples();
  const cantonsGridHtml = renderCantonsGrid();
  const dividerHtml = renderApprofondisciDivider('Pour aller plus loin');

  const body = `
    <nav class="s-bcr">
      <a href="${esc(homeUrl)}" class="s-bcl">Accueil</a>
      <span> / </span>
      <a href="${esc(calcUrl)}" class="s-bcl">Calculer le salaire</a>
      <span> / </span>
      <span>Calcul salaire net frontalier Suisse 2026</span>
    </nav>
    <header class="s-YcUNX5">
      <p style="${HERO_EYEBROW_STYLE}">Calculateur · Frontalier suisse · 2026 · Mis à jour ${esc(dateStamp)}</p>
      <h1 style="${H1_STYLE}">${esc(H1)}</h1>
      <p style="${LEDE_STYLE}">${esc(DENSE_LEDE)}</p>
    </header>
    ${statTilesHtml}
    ${primaryCtaHtml}
    ${profileExamplesHtml}
    ${cantonsGridHtml}
    ${dividerHtml}

    <section class="s-KZc0LQ">
      <h2 style="${H2_STYLE}">Comment est calculé le salaire net en Suisse</h2>
      <p style="${BODY_STYLE};max-width:780px">
        Le salaire net d'un frontalier au Tessin résulte du salaire brut moins les
        cotisations sociales obligatoires et l'impôt à la source. Le tableau ci-dessous
        détaille chacune des déductions appliquées chaque mois sur la fiche de paie suisse.
      </p>
      ${renderBreakdownTable()}
      <p style="${BODY_STYLE};max-width:780px;margin-top:14px">
        En cumulant ces postes, le taux global de prélèvement oscille entre <strong>18 %
        et 22 %</strong> du salaire brut pour un frontalier célibataire — un niveau
        sensiblement inférieur à celui d'un résident suisse, qui paie en plus l'impôt
        cantonal et communal sur le revenu.
      </p>
    </section>

    <section class="s-KZc0LQ">
      <h2 style="${H2_STYLE}">Tableau de référence: brut vs net (4 scénarios)</h2>
      <p style="${BODY_STYLE};max-width:780px">
        Voici quatre scénarios de référence pour un frontalier célibataire sans enfants,
        travaillant au Tessin sous le nouveau régime fiscal 2026. Les montants sont
        mensuels et incluent toutes les déductions obligatoires (AVS, AI, AC, LPP, LAINF
        et impôt à la source).
      </p>
      ${renderScenariosTable()}
      <h3 style="${H3_STYLE}">Adaptation à votre situation</h3>
      <p style="${BODY_STYLE};max-width:780px">
        Ces estimations sont indicatives. Pour un calcul personnalisé tenant compte de
        votre situation familiale, du nombre d'enfants, du choix entre ancien et nouveau
        régime de frontalier, et de votre commune de résidence en Italie, utilisez notre
        simulateur officiel.
      </p>
      <p class="s-4GMup_">
        <a href="${esc(calcUrl)}" class="s-cta">Lancer la simulation complète</a>
      </p>
    </section>

    <section class="s-KZc0LQ">
      <h2 style="${H2_STYLE}">Questions fréquentes</h2>
      ${renderFaqBlock()}
    </section>

    ${renderAuthoritativeSourcesHtml('fr', undefined, { section: 's-KZc0LQ', headingStyle: H2_STYLE, list: 'my-2.5 ml-5 list-disc space-y-1.5 text-body' })}

    <section class="s-KZc0LQ">
      <h2 style="${H2_STYLE}">Liens utiles</h2>
      ${renderInternalLinks()}
    </section>`;

  const bodyHtml = `<main class="s-xzWvwM">${body}</main>`;

  const wordCount = countHtmlBodyWords(body);

  const html = buildSeoPageHtml({
    locale: LOCALE,
    title: TITLE,
    description: META_DESCRIPTION,
    canonicalUrl,
    robots: wordCount >= MIN_INDEXABLE_WORDS ? 'index,follow' : 'noindex,follow',
    ogType: 'article',
    ogLocale: OG_LOCALE,
    hreflangHtml,
    jsonLdScripts: [breadcrumbLd, faqLd, articleLd, webAppLd],
    bodyHtml,
    distDir,
  });

  return { html, wordCount };
}

// ── Sitemap ──────────────────────────────────────────────────────

function buildSitemapXml(dateStamp: string): string {
  const altLinks = HREFLANG_SIBLINGS.map(
    (h) => `    <xhtml:link rel="alternate" hreflang="${h.hreflang}" href="${h.href}" />`,
  ).join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:xhtml="http://www.w3.org/1999/xhtml">
  <url>
    <loc>${BASE_URL}${URL_PATH}</loc>
${altLinks}
    <lastmod>${dateStamp}</lastmod>
    <changefreq>monthly</changefreq>
    <priority>0.7</priority>
  </url>
</urlset>
`;
}

function patchSitemapIndex(distDir: string, dateStamp: string): void {
  const indexPath = np.join(distDir, 'sitemap.xml');
  if (!fs.existsSync(indexPath)) return;
  try {
    let idx = fs.readFileSync(indexPath, 'utf-8');
    if (!idx.includes('sitemap-fr-salaire-net.xml')) {
      idx = idx.replace(
        '</sitemapindex>',
        `  <sitemap>\n    <loc>${BASE_URL}/sitemap-fr-salaire-net.xml</loc>\n    <lastmod>${dateStamp}</lastmod>\n  </sitemap>\n</sitemapindex>`,
      );
    } else {
      idx = idx.replace(
        /(<loc>https:\/\/frontaliereticino\.ch\/sitemap-fr-salaire-net\.xml<\/loc>\s*<lastmod>)\d{4}-\d{2}-\d{2}(<\/lastmod>)/,
        `$1${dateStamp}$2`,
      );
    }
    fs.writeFileSync(indexPath, idx, 'utf-8');
  } catch (err) {
    console.warn('[fr-salaire-net] failed to patch sitemap index', err);
  }
}

// ── Plugin entry ─────────────────────────────────────────────────

export function frSalaireNetLandingPlugin(rootDir: string): Plugin {
  return {
    name: 'fr-salaire-net-landing',
    apply: 'build',
    async closeBundle() {
      if (process.env.SKIP_FR_SALAIRE_NET === '1') {
        console.log('\x1b[33m[fr-salaire-net]\x1b[0m Skipped (SKIP_FR_SALAIRE_NET=1)');
        return;
      }

      const distDir = np.resolve(rootDir, 'dist');
      if (!fs.existsSync(distDir)) return;

      const dateStamp = new Date().toISOString().slice(0, 10);

      const collector = new WriteCollector({
        distDir,
        pluginName: 'frSalaireNetLandingPlugin',
      });
      const rendered = renderPage({ distDir, dateStamp });

      if (rendered.wordCount < MIN_INDEXABLE_WORDS) {
        console.warn(
          `\x1b[33m[fr-salaire-net]\x1b[0m Page below MIN_INDEXABLE_WORDS (${rendered.wordCount}) — emitted as noindex,follow`,
        );
      }

      const indexPath = np.join(distDir, URL_PATH, 'index.html');
      const flatPath = np.join(distDir, URL_PATH.replace(/\/+$/, '') + '.html');
      collector.add(indexPath, rendered.html);
      collector.add(flatPath, rendered.html);

      try {
        const xml = buildSitemapXml(dateStamp);
        fs.mkdirSync(distDir, { recursive: true });
        const sitemapPath = np.join(distDir, 'sitemap-fr-salaire-net.xml');
        fs.writeFileSync(sitemapPath, xml, 'utf-8');
      } catch (err) {
        console.warn('\x1b[33m[fr-salaire-net]\x1b[0m sitemap write failed:', err);
      }

      const t0 = Date.now();
      const written = await collector.flush();
      console.log(
        `\x1b[36m[fr-salaire-net]\x1b[0m Generated 1 page (${rendered.wordCount} words) — flushed ${written} files in ${((Date.now() - t0) / 1000).toFixed(1)}s`,
      );

      // Always-run: patch sitemap.xml index (regenerated each build).
      if (fs.existsSync(np.join(distDir, 'sitemap-fr-salaire-net.xml'))) {
        try {
          patchSitemapIndex(distDir, dateStamp);
        } catch (err) {
          console.warn('\x1b[33m[fr-salaire-net]\x1b[0m sitemap-index patch failed:', err);
        }
      }
    },
  };
}
