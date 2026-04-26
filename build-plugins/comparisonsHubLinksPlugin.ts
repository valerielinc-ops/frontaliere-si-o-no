/**
 * Comparisons Hub (AE-7) — internal-links injector.
 *
 * After {@link comparisonsHubPlugin} writes the 4 static landings into
 * `dist/`, this plugin walks a handful of high-traffic parent pages and
 * injects a single contextual anchor into each so Google / users can
 * discover the new hub from homepage + existing hub pillars.
 *
 * Idempotent: if the target href is already present in the HTML we skip
 * that file. One link per target per file, no duplicate injection.
 *
 * Targets (IT canonicals):
 *   - `/index.html`                          — root homepage
 *   - `/compara-servizi/index.html`          — Confronti hub root
 *   - `/statistiche/confronta-stipendi/`     — salary-compare stats page
 *
 * Anchor text is anchored on a keyword the target page already uses so
 * the link reads naturally; we prepend a short callout paragraph before
 * the existing content nav rather than mutate prose.
 */

import fs from 'node:fs';
import np from 'node:path';
import type { Plugin } from 'vite';

interface LinkTarget {
  /** Absolute file path (both index.html and flat .html get patched). */
  readonly indexPath: string;
  readonly flatPath?: string;
  /** Anchor href to inject (absolute path under site root). */
  readonly href: string;
  /** Visible anchor text. */
  readonly label: string;
  /** Short callout sentence wrapping the anchor for context. */
  readonly intro: string;
}

function patchFile(opts: LinkTarget): boolean {
  const { indexPath, href, label, intro } = opts;
  if (!fs.existsSync(indexPath)) return false;
  let html = fs.readFileSync(indexPath, 'utf-8');
  if (html.includes(`href="${href}"`)) return false;

  // Injection block — plain HTML, styled with design tokens so it
  // blends into the existing static SEO body (same pattern as other
  // programmatic-links plugins already in the codebase).
  const block = `<aside data-ae7-link style="margin:1.25rem 0;padding:14px 16px;border:1px solid var(--color-edge);border-radius:12px;background:var(--color-surface-alt)"><p style="margin:0;color:var(--color-body);font-size:.95rem;line-height:1.6">${intro} <a href="${href}" style="color:var(--color-link);text-decoration:none;font-weight:600">${label}</a>.</p></aside>`;

  // Prefer injecting right after the first `<main …>` open tag so the
  // block appears near the top of the editorial content. Fall back to
  // before `</main>` if the open tag regex misses.
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

export function comparisonsHubLinksPlugin(rootDir: string): Plugin {
  return {
    name: 'comparisons-hub-links',
    apply: 'build',
    async closeBundle() {
      if (process.env.SKIP_COMPARISONS_HUB === '1') return;

      const distDir = np.resolve(rootDir, 'dist');
      if (!fs.existsSync(distDir)) return;

      const targets: LinkTarget[] = [
        // Homepage — IT root. Single highest-authority backlink.
        {
          indexPath: np.join(distDir, 'index.html'),
          href: '/confronti-frontalieri/',
          label: 'Apri i confronti Svizzera vs Italia per frontalieri',
          intro:
            'Stai valutando se lavorare oltreconfine? Cinque tabelle dense con dati 2026 su stipendi, tasse, LAMal, contributi e costo della vita.',
        },
        // Confronti hub root — same section, sidebar link.
        {
          indexPath: np.join(distDir, 'compara-servizi', 'index.html'),
          flatPath: np.join(distDir, 'compara-servizi.html'),
          href: '/confronti-frontalieri/',
          label: 'Vai al confronto completo CH vs IT',
          intro:
            'Vuoi il quadro d\'insieme? Tabella unica con stipendi per settore, tasse, LAMal, contributi e costo della vita.',
        },
        // Salary-compare stats sub-tab — natural transition to the hub.
        {
          indexPath: np.join(distDir, 'statistiche', 'confronta-stipendi', 'index.html'),
          flatPath: np.join(distDir, 'statistiche', 'confronta-stipendi.html'),
          href: '/confronti-frontalieri/',
          label: 'Vedi il confronto completo Svizzera vs Italia',
          intro:
            'Oltre agli stipendi ci sono anche tasse, LAMal, contributi sociali e costo della vita.',
        },
        // IT salary pillar (Sprint 2) — only present under its canonical slug.
        {
          indexPath: np.join(distDir, 'stipendi-frontalieri-ticino', 'index.html'),
          flatPath: np.join(distDir, 'stipendi-frontalieri-ticino.html'),
          href: '/confronti-frontalieri/',
          label: 'Confronta il quadro completo CH vs IT',
          intro:
            'Gli stipendi sono solo una parte: completa il confronto con tasse, LAMal e costo della vita.',
        },
      ];

      let patched = 0;
      for (const t of targets) {
        if (patchFile(t)) patched++;
      }
      console.log(
        `\x1b[36m[comparisons-hub-links]\x1b[0m Injected AE-7 hub link into ${patched}/${targets.length} parent pages.`,
      );
    },
  };
}
