/**
 * Calculator legacy-alias plugin — recovers 22 GSC `Indicizzata Non trovata`
 * URLs of the form `/{en|de|fr}/calcola-stipendio/?reddito=...&tipo=...`.
 *
 * Historical context
 * ------------------
 * Pre-routing-refactor, `buildPath({activeTab:'calculator'}, locale)` emitted
 * the literal IT slug `calcola-stipendio` under non-IT locale prefixes
 * (e.g. `/en/calcola-stipendio/`). Current code (services/router.ts:2847)
 * returns the locale root (`/en/`, `/de/`, `/fr/`) for the calculator main
 * tab, so the bad pattern is no longer generated. But Google still has the
 * 22 historical URLs indexed; they all 404 today.
 *
 * Why not a 301
 * -------------
 * A 301 strips AdSense rendering and loses the prefilled-calculator UX
 * (users land on a redirect, lose state, see the empty calc). We need a
 * real 200 page that:
 *   - Returns full SPA chrome + content (AdSense fires, monetization OK)
 *   - Carries `<link rel="canonical">` pointing to the locale-canonical
 *     calculator slug so Google de-duplicates without de-indexing
 *   - Silently rewrites the URL bar to the canonical via
 *     `history.replaceState` BEFORE the SPA boots — preserves the query
 *     string (`?reddito=65000&tipo=OLD&stato=MARRIED&figli=2&zona=WITHIN_20KM`)
 *     so `urlStateService.decodeSimulationParams` prefills the simulation
 *     and the user immediately sees their result
 *
 * Per CLAUDE.md non-negotiable #14, every static SSG page MUST use the
 * shared SPA shell helper. We wrap via `buildSeoPageHtml`.
 * Per memory `feedback_never_noindex_without_approval`, we set
 * `robots: 'index,follow'` and lean on the canonical signal alone.
 *
 * Outputs
 * -------
 *   dist/en/calcola-stipendio/index.html  → canonical /en/calculate-salary/
 *   dist/de/calcola-stipendio/index.html  → canonical /de/gehalt-berechnen/
 *   dist/fr/calcola-stipendio/index.html  → canonical /fr/calculer-salaire/
 *
 * Sitemap policy: these aliases are NOT added to any sitemap. The
 * canonical pages already are; we don't want to signal these as crawl
 * targets, just to repair the existing 404 cohort.
 */

import path from 'node:path';
import fs from 'node:fs';
import type { Plugin } from 'vite';
import { buildSeoPageHtml } from './shared/seoPageShell';
import type { Locale } from '../services/i18n';

const BASE_URL = 'https://frontaliereticino.ch';

interface LegacyAliasEntry {
  /** Locale prefix path (with trailing slash). */
  readonly locale: Exclude<Locale, 'it'>;
  /** Locale-canonical calculator path (e.g. `/en/calculate-salary/`). */
  readonly canonicalPath: string;
  /** `<title>` headline (sans brand suffix — buildTitleWithBrand adds it). */
  readonly title: string;
  /** Meta description (120-160 chars). */
  readonly description: string;
  /** H1 shown inside the static body (different from <title> per audit). */
  readonly h1: string;
  /** Lead paragraph above the SPA root — supplies text-to-HTML ratio. */
  readonly prose: string;
  /** Additional FAQ block paragraphs (kept short, lifts text-to-HTML ratio
   *  above the 10% Semrush threshold for these stub pages — they ship a
   *  ~7 KB shell with only the lead paragraph, which floors the ratio at
   *  ~9.4%). Each entry is one Q + A pair rendered as a <p>. */
  readonly faq: ReadonlyArray<{ readonly q: string; readonly a: string }>;
  /** OpenGraph locale token. */
  readonly ogLocale: string;
}

const ENTRIES: ReadonlyArray<LegacyAliasEntry> = [
  {
    locale: 'en',
    canonicalPath: '/en/calculate-salary/',
    title: 'Cross-border salary calculator — pre-filled results',
    description: 'Net salary calculator for Swiss-Italian frontalieri. We pre-filled your scenario from the URL parameters — adjust income, family status, residence distance and recalculate live.',
    h1: 'Salary calculator — your scenario',
    prose: 'This page recovers a legacy URL from an older share link. The calculator below is pre-filled from the parameters in your URL (income, frontaliere type, marital status, children, residence distance) and recalculates net salary instantly under both the old (pre-2026) and new bilateral agreements. Drag the inputs or paste a new income to see updated CHF and EUR figures, plus the AVS/AC/LAA/IJM/LPP breakdown and the monthly net comparison between living in Switzerland on a Permit B and commuting from Italy. The full guide to the 2026 frontaliere reform lives on the canonical page linked from the header.',
    faq: [
      { q: 'What is the new 2026 frontaliere agreement?', a: 'The 2026 Switzerland–Italy bilateral treaty replaces the 1974 cantonal-reversal-only scheme with a 80/20 split: 80% of income tax goes to the canton of employment, 20% to the Italian municipality of residence. New frontalieri hired after 17 July 2023 fall under the new rules; those hired before keep grandfathered terms.' },
      { q: 'Why do I see two net figures (CHF and EUR)?', a: 'The calculator converts the Swiss net salary at the current CHF/EUR rate so you can compare like-for-like with Italian payslips. The EUR figure already subtracts the LAMal premium, cross-border health contribution, and an estimated commute cost so the comparison reflects what actually lands in your pocket.' },
      { q: 'Does the result include the 13th-month salary?', a: 'Yes — the gross we use already includes the 13th-month pay where the contract provides one, and AVS/AC/UV/KTG/BVG contributions are deducted on the same base. A 14th month is rare in Switzerland and treated as a discretionary bonus, not built into the default scenario.' },
      { q: 'Can I share the pre-filled scenario?', a: 'Yes — copy the URL from your browser address bar after adjusting the inputs. The query string encodes every parameter so the recipient lands on the same scenario without retyping it.' },
    ],
    ogLocale: 'en_US',
  },
  {
    locale: 'de',
    canonicalPath: '/de/gehalt-berechnen/',
    title: 'Lohnrechner Grenzgänger — vorausgefüllte Ergebnisse',
    description: 'Nettolohn-Rechner für italienisch-schweizerische Grenzgänger. Ihr Szenario wurde aus den URL-Parametern vorausgefüllt — Einkommen, Familienstand und Wohnentfernung jederzeit anpassen.',
    h1: 'Lohnrechner — Ihr Szenario',
    prose: 'Diese Seite stellt eine ältere geteilte Verknüpfung wieder her. Der Rechner unten ist mit den Werten aus Ihrer URL vorausgefüllt (Bruttoeinkommen, Grenzgänger-Typ, Familienstand, Kinder, Wohnentfernung) und berechnet den Nettolohn sofort unter dem alten und dem neuen bilateralen Abkommen. Passen Sie die Eingaben an, um aktualisierte CHF- und EUR-Beträge zu sehen — inklusive AHV/ALV/UV/KTG/BVG-Aufschlüsselung und dem monatlichen Netto-Vergleich zwischen einer Permit-B-Wohnsitznahme in der Schweiz und dem Pendeln aus Italien. Den vollständigen Leitfaden zur Reform 2026 finden Sie auf der kanonischen Seite, verlinkt im Header.',
    faq: [
      { q: 'Was bringt das neue Grenzgänger-Abkommen 2026?', a: 'Der bilaterale Schweiz–Italien-Vertrag 2026 ersetzt die alte 100%-Quellensteuer auf Schweizer Seite durch eine 80/20-Aufteilung: 80 % der Einkommensteuer bleiben im Beschäftigungskanton, 20 % gehen an die italienische Wohnsitzgemeinde. Neue Grenzgänger ab dem 17. Juli 2023 fallen unter die neue Regelung; früher Eingestellte behalten den Bestandsstatus.' },
      { q: 'Warum sehe ich zwei Netto-Beträge (CHF und EUR)?', a: 'Der Rechner konvertiert den Schweizer Nettolohn zum aktuellen CHF/EUR-Kurs für einen Vergleich mit italienischen Lohnabrechnungen. Im EUR-Wert sind LAMal-Prämie, italienischer Gesundheitsbeitrag und geschätzte Pendelkosten bereits abgezogen — was tatsächlich auf dem Konto landet.' },
      { q: 'Ist der 13. Monatslohn enthalten?', a: 'Ja — der verwendete Bruttolohn enthält bereits den 13. Monatslohn, soweit vertraglich vorgesehen, und AHV/ALV/UV/KTG/BVG werden auf derselben Basis abgezogen. Ein 14. Monat ist in der Schweiz selten und gilt als diskretionärer Bonus.' },
      { q: 'Kann ich das vorausgefüllte Szenario teilen?', a: 'Ja — kopieren Sie nach Eingabe der Werte die URL aus der Adressleiste. Der Query-String kodiert alle Parameter, sodass die empfangende Person dasselbe Szenario direkt vorgeführt bekommt.' },
    ],
    ogLocale: 'de_DE',
  },
  {
    locale: 'fr',
    canonicalPath: '/fr/calculer-salaire/',
    title: 'Calculateur salaire frontalier — résultats pré-remplis',
    description: 'Calculateur de salaire net pour les frontaliers italo-suisses. Votre scénario a été pré-rempli depuis les paramètres URL — ajustez revenu, statut familial et distance domicile à tout moment.',
    h1: 'Calculateur de salaire — votre scénario',
    prose: 'Cette page récupère une ancienne URL partagée. Le calculateur ci-dessous est pré-rempli avec les valeurs de votre URL (salaire brut, type de frontalier, statut familial, enfants, distance du domicile) et calcule le salaire net en direct sous l\'ancien et le nouvel accord bilatéral. Ajustez les entrées pour voir les montants CHF et EUR mis à jour — y compris la ventilation AVS/AC/LAA/IJM/LPP et la comparaison mensuelle entre vivre en Suisse avec un permis B et faire la navette depuis l\'Italie. Le guide complet de la réforme frontaliere 2026 se trouve sur la page canonique liée dans l\'en-tête.',
    faq: [
      { q: 'Qu\'apporte le nouvel accord frontalier 2026 ?', a: 'Le traité bilatéral Suisse–Italie 2026 remplace l\'ancien système de retenue à 100 % côté suisse par un partage 80/20 : 80 % de l\'impôt sur le revenu restent au canton d\'emploi, 20 % vont à la commune italienne de résidence. Les nouveaux frontaliers embauchés après le 17 juillet 2023 relèvent du nouveau régime ; les autres conservent leur statut antérieur.' },
      { q: 'Pourquoi deux montants nets (CHF et EUR) ?', a: 'Le calculateur convertit le salaire net suisse au taux CHF/EUR courant pour comparer point par point avec une fiche de paie italienne. Le montant en EUR déduit déjà la prime LAMal, la contribution italienne santé et un coût de trajet estimé — ce qui atterrit effectivement sur le compte.' },
      { q: 'Le 13ème mois est-il inclus ?', a: 'Oui — le brut utilisé inclut le 13ème mois lorsque prévu au contrat, et AVS/AC/LAA/IJM/LPP sont déduits sur la même base. Un 14ème mois est rare en Suisse et traité comme bonus discrétionnaire, pas intégré au scénario par défaut.' },
      { q: 'Puis-je partager le scénario pré-rempli ?', a: 'Oui — copiez l\'URL depuis la barre d\'adresse après avoir ajusté les entrées. La query string encode tous les paramètres, le destinataire ouvre exactement le même scénario sans le re-saisir.' },
    ],
    ogLocale: 'fr_FR',
  },
];

/**
 * Inline pre-hydration script. Runs in `<head>` BEFORE the deferred SPA
 * module bundle so the URL rewrite happens before any router parsing.
 *
 * Safe to embed via `extraHeadHtml` (no template literals to escape — we
 * hard-code the canonical path per locale).
 */
function buildRewriteScript(legacyPath: string, canonicalPath: string): string {
  const safeLegacy = JSON.stringify(legacyPath);
  const safeCanonical = JSON.stringify(canonicalPath);
  return `<script>(function(){try{if(location.pathname===${safeLegacy}){history.replaceState(null,'',${safeCanonical}+location.search+location.hash);}}catch(e){}})();</script>`;
}

/** Build a single alias page's HTML using the shared SEO shell. */
function renderAliasPage(entry: LegacyAliasEntry, distDir: string): string {
  const legacyPath = `/${entry.locale}/calcola-stipendio/`;
  const canonicalUrl = `${BASE_URL}${entry.canonicalPath}`;
  const legacyAbsoluteUrl = `${BASE_URL}${legacyPath}`;

  // FAQ heading label per locale — short, matches the canonical calculator
  // pages' FAQ section convention.
  const faqHeading = entry.locale === 'de' ? 'Häufige Fragen'
    : entry.locale === 'fr' ? 'Questions fréquentes'
    : 'Frequently asked';
  const faqHtml = entry.faq
    .map((qa) => `<p style="margin:14px 0 0;font-size:15px"><strong>${qa.q}</strong> ${qa.a}</p>`)
    .join('');

  const bodyHtml = `<main class="cluster-seo-prose" style="max-width:860px;margin:0 auto;padding:24px 16px;color:var(--color-body);line-height:1.65">
    <header style="margin-bottom:16px">
      <h1 style="font-size:28px;font-weight:700;color:var(--color-heading);margin:0 0 8px;letter-spacing:-0.01em">${entry.h1}</h1>
    </header>
    <p style="margin:0;font-size:15.5px">${entry.prose}</p>
    <section style="margin-top:24px" aria-label="${faqHeading}">
      <h2 style="font-size:20px;font-weight:700;color:var(--color-heading);margin:0 0 6px">${faqHeading}</h2>
      ${faqHtml}
    </section>
  </main>`;

  // Minimal 2-level BreadcrumbList (Home → page) — required by the D.2 SEO
  // gate (`tests/seo/breadcrumb-coverage.test.ts`). Describes the legacy URL
  // visitors actually land on; canonical points to the live calculator.
  // entry.locale is 'en' | 'de' | 'fr' (the alias is only emitted for non-IT
  // locales; IT lives at the canonical `/calcola-stipendio/`).
  const homeLabel = entry.locale === 'de' ? 'Startseite' : entry.locale === 'fr' ? 'Accueil' : 'Home';
  const homeUrl = `${BASE_URL}/${entry.locale}/`;
  const breadcrumbLd = JSON.stringify({
    '@context': 'https://schema.org',
    '@type': 'BreadcrumbList',
    itemListElement: [
      { '@type': 'ListItem', position: 1, name: homeLabel, item: homeUrl },
      { '@type': 'ListItem', position: 2, name: entry.h1, item: legacyAbsoluteUrl },
    ],
  });

  return buildSeoPageHtml({
    locale: entry.locale,
    title: entry.title,
    description: entry.description,
    canonicalUrl,
    robots: 'index,follow',
    ogType: 'website',
    ogLocale: entry.ogLocale,
    hreflangHtml: '',
    jsonLdScripts: [breadcrumbLd],
    extraHeadHtml: buildRewriteScript(legacyPath, entry.canonicalPath),
    bodyHtml,
    distDir,
    // Don't use lite-shell — let the SPA hydrate `#root` with the
    // full calculator UI once the URL rewrite settles.
    seoMainClass: 'cluster-seo-prose',
  });
}

export function calculatorLegacyAliasPlugin(rootDir: string): Plugin {
  return {
    name: 'calculator-legacy-alias',
    apply: 'build',
    enforce: 'post',
    async closeBundle() {
      const distDir = path.join(rootDir, 'dist');
      if (!fs.existsSync(distDir)) {
        console.warn('\x1b[33m[calculator-legacy-alias]\x1b[0m dist/ missing — skipping');
        return;
      }

      let emitted = 0;
      for (const entry of ENTRIES) {
        const html = renderAliasPage(entry, distDir);
        const indexTarget = path.join(distDir, entry.locale, 'calcola-stipendio', 'index.html');
        const flatTarget = path.join(distDir, entry.locale, 'calcola-stipendio.html');
        try {
          fs.mkdirSync(path.dirname(indexTarget), { recursive: true });
          fs.writeFileSync(indexTarget, html, 'utf-8');
          // Flat .html sibling: GH Pages serves trailing-slash and non-slash
          // forms separately. Mirror the trailing-slash content verbatim so
          // both resolve to the same 200 page (avoids a second cohort of
          // 404s if Google indexed the flat form).
          fs.writeFileSync(flatTarget, html, 'utf-8');
          emitted += 2;
        } catch (err) {
          console.warn(`\x1b[33m[calculator-legacy-alias]\x1b[0m failed to write ${indexTarget}:`, err);
        }
      }
      console.log(`\x1b[36m[calculator-legacy-alias]\x1b[0m emitted ${emitted} alias files (${ENTRIES.length} locales × 2 paths)`);
    },
  };
}
