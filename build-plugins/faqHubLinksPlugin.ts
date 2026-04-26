/**
 * FAQ Hub (AE-5 caveat) — internal-links injector.
 *
 * After {@link faqHubPlugin} writes the 4 locale FAQ-hub landings into
 * `dist/`, this plugin walks the 4 `/guida-frontaliere/` (and locale twin)
 * hub root pages and injects a single contextual anchor into each so
 * Google / users can discover the 100-Q&A FAQ hub from the guide pillar.
 *
 * Idempotent: if the target href is already present in the HTML we skip
 * that file. One link per target per file, no duplicate injection on
 * rebuild.
 *
 * Targets (4 guide-hub roots, one per locale):
 *   - IT: `/guida-frontaliere/`                     → `/domande-frequenti-frontalieri/`
 *   - EN: `/en/cross-border-guide/`                 → `/en/frequently-asked-questions/`
 *   - DE: `/de/grenzgaenger-ratgeber/`              → `/de/haeufige-fragen/`
 *   - FR: `/fr/guide-frontalier/`                   → `/fr/questions-frequentes/`
 *
 * Pattern mirrors {@link comparisonsHubLinksPlugin} (AE-7).
 */

import fs from 'node:fs';
import np from 'node:path';
import type { Plugin } from 'vite';

interface LinkTarget {
  /** Absolute file path to the index.html (both index.html and flat .html get patched). */
  readonly indexPath: string;
  readonly flatPath?: string;
  /** Anchor href to inject (absolute path under site root). */
  readonly href: string;
  /** Visible anchor text. */
  readonly label: string;
  /** Short callout sentence wrapping the anchor for context. */
  readonly intro: string;
}

const MARKER = 'data-ae5-faq-link';

function patchFile(opts: LinkTarget): boolean {
  const { indexPath, href, label, intro } = opts;
  if (!fs.existsSync(indexPath)) return false;
  let html = fs.readFileSync(indexPath, 'utf-8');
  // Idempotency guards: either the marker or the exact href already present.
  if (html.includes(MARKER)) return false;
  if (html.includes(`href="${href}"`)) return false;

  const block = `<aside ${MARKER} style="margin:1.25rem 0;padding:14px 16px;border:1px solid var(--color-edge);border-radius:12px;background:var(--color-surface-alt)"><p style="margin:0;color:var(--color-body);font-size:.95rem;line-height:1.6">${intro} <a href="${href}" style="color:var(--color-link);text-decoration:none;font-weight:600">${label}</a>.</p></aside>`;

  // Prefer injecting right after the first `<main …>` open tag so the
  // block appears near the top of the editorial content.
  const mainOpen = html.match(/<main\b[^>]*>/);
  if (mainOpen && mainOpen.index !== undefined) {
    const insertAt = mainOpen.index + mainOpen[0].length;
    html = html.slice(0, insertAt) + block + html.slice(insertAt);
  } else if (html.includes('</main>')) {
    html = html.replace('</main>', `${block}</main>`);
  } else {
    return false;
  }

  fs.writeFileSync(indexPath, html, 'utf-8');
  // Do not write the flat .html sibling — it is a redirect bridge emitted
  // by flatHtmlRedirectPlugin and must stay untouched.
  return true;
}

export function faqHubLinksPlugin(rootDir: string): Plugin {
  return {
    name: 'faq-hub-links',
    apply: 'build',
    // Run after staticPagesPlugin (which uses enforce: 'post' to write
    // guide-hub static HTML) so the target files already exist on disk
    // when closeBundle fires here.
    enforce: 'post',
    async closeBundle() {
      const distDir = np.resolve(rootDir, 'dist');
      if (!fs.existsSync(distDir)) return;

      const targets: LinkTarget[] = [
        // IT — primary locale.
        {
          indexPath: np.join(distDir, 'guida-frontaliere', 'index.html'),
          flatPath: np.join(distDir, 'guida-frontaliere.html'),
          href: '/domande-frequenti-frontalieri/',
          label: 'Apri le 100 domande frequenti dei frontalieri',
          intro:
            'Hai domande specifiche su fisco, permessi, LAMal, AVS, stipendio, trasporti o diritti del lavoro? Consulta le risposte dettagliate con fonti ufficiali.',
        },
        // EN
        {
          indexPath: np.join(distDir, 'en', 'cross-border-guide', 'index.html'),
          flatPath: np.join(distDir, 'en', 'cross-border-guide.html'),
          href: '/en/frequently-asked-questions/',
          label: 'Browse the 100 cross-border FAQs',
          intro:
            'Have specific questions on taxes, permits, LAMal, AVS/LPP, pay, transport or labour rights? See detailed answers with official sources.',
        },
        // DE
        {
          indexPath: np.join(distDir, 'de', 'grenzgaenger-ratgeber', 'index.html'),
          flatPath: np.join(distDir, 'de', 'grenzgaenger-ratgeber.html'),
          href: '/de/haeufige-fragen/',
          label: 'Zu den 100 häufigen Fragen für Grenzgänger',
          intro:
            'Haben Sie spezifische Fragen zu Steuern, Bewilligungen, KVG/LAMal, AHV/BVG, Lohn, Verkehr oder Arbeitsrecht? Hier finden Sie ausführliche Antworten mit offiziellen Quellen.',
        },
        // FR
        {
          indexPath: np.join(distDir, 'fr', 'guide-frontalier', 'index.html'),
          flatPath: np.join(distDir, 'fr', 'guide-frontalier.html'),
          href: '/fr/questions-frequentes/',
          label: 'Voir les 100 questions fréquentes des frontaliers',
          intro:
            'Des questions précises sur la fiscalité, les permis, LAMal, AVS/LPP, le salaire, les transports ou le droit du travail ? Consultez les réponses détaillées avec sources officielles.',
        },
      ];

      let patched = 0;
      for (const t of targets) {
        if (patchFile(t)) patched++;
      }
      console.log(
        `\x1b[36m[faq-hub-links]\x1b[0m Injected AE-5 FAQ-hub link into ${patched}/${targets.length} guide-hub pages.`,
      );
    },
  };
}
