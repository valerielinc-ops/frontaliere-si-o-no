/**
 * Profession landings (AE-3) — internal-links injector.
 *
 * After {@link professionLandingsPlugin} writes the 40 static profession
 * landings into `dist/`, this plugin walks a handful of high-intent parent
 * pages and injects a single contextual block linking to the 10 IT (or
 * locale) profession landings so users + crawlers can discover them.
 *
 * Idempotent: marker attribute `data-ae3-profession-links` prevents
 * duplicate injection on rebuild.
 *
 * Parent targets:
 *   - `/cerca-lavoro-ticino/`                 — IT job-board hub
 *   - `/en/find-jobs-ticino/`                 — EN hub
 *   - `/de/jobs-im-tessin/`                   — DE hub
 *   - `/fr/trouver-emploi-tessin/`            — FR hub
 *   - `/oss-svizzera-guida-frontaliere/`      — IT pillar (infermieri +
 *                                                educatori cross-link)
 *
 * The pillar page only gets the 2 healthcare/education professions; the
 * hubs get the full top-10 list.
 *
 * ───────────────────────────────────────────────────────────────────────
 * Determinism note (2026-04-28):
 *
 * Vite/Rollup runs `closeBundle` hooks IN PARALLEL via `hookParallel`.
 * Both `staticPagesPlugin` and `professionLandingsPlugin` write the same
 * hub `index.html` paths via `WriteCollector.add()`, which auto-flushes
 * in the background once the pending queue crosses 5 000 writes. Under
 * heavy CI builds the hub HTML can be (a) written by an early background
 * batch, (b) read+patched by this plugin's `waitForStable` poll, then
 * (c) overwritten by a later background batch from staticPagesPlugin —
 * silently losing every patch. Symptom in CI: `Injected … into 0/5
 * parent pages.` and 10 sitemap-professions.xml orphans.
 *
 * Fix: instead of polling mtime, await explicit signals from each
 * producer plugin (see `build-plugins/shared/buildSignals.ts`). The
 * producers resolve their signals AFTER `await collector.flush()`, so by
 * the time we patch the file content is final. We also throw a hard
 * error if any target hub remains unpatched, so any future regression
 * surfaces in the build log instead of an audit five minutes later.
 */

import fs from 'node:fs';
import np from 'node:path';
import type { Plugin } from 'vite';
import {
  PROFESSION_IDS,
  PROFESSION_LOCALES,
  PROFESSION_SLUGS,
  buildProfessionLandingPath,
  type ProfessionId,
  type ProfessionLocale,
} from './professionLandingsData';
import {
  staticPagesFlushed,
  professionLandingsFlushed,
} from './shared/buildSignals';

interface InjectionTarget {
  readonly indexPath: string;
  readonly flatPath?: string;
  readonly locale: ProfessionLocale;
  readonly title: string;
  readonly intro: string;
  readonly professionIds: readonly ProfessionId[];
}

const ANCHOR_LABELS: Record<ProfessionLocale, Record<ProfessionId, string>> = {
  it: {
    infermiere: 'Lavoro infermiere in Ticino',
    operaio: 'Lavoro operaio in Ticino',
    impiegato: 'Lavoro impiegato in Ticino',
    ingegnere: 'Lavoro ingegnere in Ticino',
    educatore: 'Lavoro educatore in Ticino',
    autista: 'Lavoro autista in Ticino',
    muratore: 'Lavoro muratore in Ticino',
    cuoco: 'Lavoro cuoco in Ticino',
    cameriere: 'Lavoro cameriere in Ticino',
    elettricista: 'Lavoro elettricista in Ticino',
  },
  en: {
    infermiere: 'Nurse jobs in Ticino',
    operaio: 'Worker jobs in Ticino',
    impiegato: 'Clerk jobs in Ticino',
    ingegnere: 'Engineer jobs in Ticino',
    educatore: 'Educator jobs in Ticino',
    autista: 'Driver jobs in Ticino',
    muratore: 'Mason jobs in Ticino',
    cuoco: 'Cook jobs in Ticino',
    cameriere: 'Waiter jobs in Ticino',
    elettricista: 'Electrician jobs in Ticino',
  },
  de: {
    infermiere: 'Krankenpfleger-Jobs im Tessin',
    operaio: 'Arbeiter-Jobs im Tessin',
    impiegato: 'Sachbearbeiter-Jobs im Tessin',
    ingegnere: 'Ingenieur-Jobs im Tessin',
    educatore: 'Erzieher-Jobs im Tessin',
    autista: 'Fahrer-Jobs im Tessin',
    muratore: 'Maurer-Jobs im Tessin',
    cuoco: 'Koch-Jobs im Tessin',
    cameriere: 'Kellner-Jobs im Tessin',
    elettricista: 'Elektriker-Jobs im Tessin',
  },
  fr: {
    infermiere: 'Emploi infirmier au Tessin',
    operaio: 'Emploi ouvrier au Tessin',
    impiegato: 'Emploi employé au Tessin',
    ingegnere: 'Emploi ingénieur au Tessin',
    educatore: 'Emploi éducateur au Tessin',
    autista: 'Emploi chauffeur au Tessin',
    muratore: 'Emploi maçon au Tessin',
    cuoco: 'Emploi cuisinier au Tessin',
    cameriere: 'Emploi serveur au Tessin',
    elettricista: 'Emploi électricien au Tessin',
  },
};

function esc(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function renderBlock(target: InjectionTarget): string {
  const items = target.professionIds
    .map((id) => {
      const href = buildProfessionLandingPath(target.locale, id);
      const label = ANCHOR_LABELS[target.locale][id];
      return `<li style="margin:0;padding:6px 0"><a href="${esc(href)}" style="color:#1d4ed8;text-decoration:none;font-weight:600">${esc(label)}</a></li>`;
    })
    .join('');
  return `<aside data-ae3-profession-links style="margin:1.5rem 0;padding:16px 18px;border:1px solid #e2e8f0;border-radius:12px;background:#f8fafc"><p style="margin:0 0 8px;color:#0f172a;font-size:1rem;font-weight:700">${esc(target.title)}</p><p style="margin:0 0 10px;color:#334155;font-size:.95rem;line-height:1.55">${esc(target.intro)}</p><ul style="margin:0;padding:0 0 0 18px;color:#0f172a;font-size:.95rem;line-height:1.6">${items}</ul></aside>`;
}

/**
 * Pure injector — exported for unit tests.
 *
 * Inserts `block` immediately after the opening `<main …>` tag in `html`.
 * Falls back to the position just before `</main>` and then `</body>` if
 * neither exists. Returns the original string when:
 *  - the marker `data-ae3-profession-links` is already present (idempotent), OR
 *  - none of `<main>`, `</main>`, `</body>` are found (caller treats as failure).
 *
 * The third return tuple element reports `'inserted' | 'duplicate' | 'no-anchor'`
 * so the plugin can hard-fail on `'no-anchor'` and silently no-op on `'duplicate'`.
 */
export type InjectionOutcome = 'inserted' | 'duplicate' | 'no-anchor';

export function injectAe3Block(
  html: string,
  block: string,
): { html: string; outcome: InjectionOutcome } {
  if (html.includes('data-ae3-profession-links')) {
    return { html, outcome: 'duplicate' };
  }

  const mainOpen = html.match(/<main\b[^>]*>/);
  if (mainOpen && mainOpen.index !== undefined) {
    const insertAt = mainOpen.index + mainOpen[0].length;
    return {
      html: html.slice(0, insertAt) + block + html.slice(insertAt),
      outcome: 'inserted',
    };
  }
  if (html.includes('</main>')) {
    return {
      html: html.replace('</main>', `${block}</main>`),
      outcome: 'inserted',
    };
  }
  if (html.includes('</body>')) {
    return {
      html: html.replace('</body>', `${block}</body>`),
      outcome: 'inserted',
    };
  }
  return { html, outcome: 'no-anchor' };
}

interface PatchResult {
  readonly target: InjectionTarget;
  readonly outcome: InjectionOutcome | 'missing-file';
}

function patchFile(target: InjectionTarget): PatchResult {
  if (!fs.existsSync(target.indexPath)) {
    return { target, outcome: 'missing-file' };
  }
  const html = fs.readFileSync(target.indexPath, 'utf-8');
  const block = renderBlock(target);
  const { html: patched, outcome } = injectAe3Block(html, block);
  if (outcome === 'inserted') {
    fs.writeFileSync(target.indexPath, patched, 'utf-8');
  }
  // Do not write the flat .html sibling — it is a redirect bridge emitted
  // by flatHtmlRedirectPlugin and must stay untouched.
  return { target, outcome };
}

function buildTargets(distDir: string): InjectionTarget[] {
  const hubPaths: Record<ProfessionLocale, { index: string; flat: string }> = {
    it: {
      index: np.join(distDir, 'cerca-lavoro-ticino', 'index.html'),
      flat: np.join(distDir, 'cerca-lavoro-ticino.html'),
    },
    en: {
      index: np.join(distDir, 'en', 'find-jobs-ticino', 'index.html'),
      flat: np.join(distDir, 'en', 'find-jobs-ticino.html'),
    },
    de: {
      index: np.join(distDir, 'de', 'jobs-im-tessin', 'index.html'),
      flat: np.join(distDir, 'de', 'jobs-im-tessin.html'),
    },
    fr: {
      index: np.join(distDir, 'fr', 'trouver-emploi-tessin', 'index.html'),
      flat: np.join(distDir, 'fr', 'trouver-emploi-tessin.html'),
    },
  };

  const hubTitles: Record<ProfessionLocale, { title: string; intro: string }> = {
    it: {
      title: 'Landing per professione',
      intro:
        'Scopri stipendio, CCL, permesso G, datori di lavoro e iter di riconoscimento per le 10 professioni più cercate in Ticino.',
    },
    en: {
      title: 'Landings by profession',
      intro:
        'Find salary, CCL, G-permit notes, top employers and recognition steps for the 10 most-searched roles in Ticino.',
    },
    de: {
      title: 'Landings nach Beruf',
      intro:
        'Lohn, GAV, G-Bewilligung, Top-Arbeitgeber und Anerkennungsverfahren für die 10 gefragtesten Berufe im Tessin.',
    },
    fr: {
      title: 'Landings par métier',
      intro:
        'Salaire, CCT, permis G, principaux employeurs et reconnaissance pour les 10 métiers les plus recherchés au Tessin.',
    },
  };

  const targets: InjectionTarget[] = PROFESSION_LOCALES.map((loc) => ({
    indexPath: hubPaths[loc].index,
    flatPath: hubPaths[loc].flat,
    locale: loc,
    title: hubTitles[loc].title,
    intro: hubTitles[loc].intro,
    professionIds: PROFESSION_IDS,
  }));

  // Pillar oss-svizzera: only healthcare/education cross-link.
  // The IT canonical lives at /vita-in-ticino/oss-svizzera/ (Sprint 2 pillar).
  targets.push({
    indexPath: np.join(distDir, 'vita-in-ticino', 'oss-svizzera', 'index.html'),
    flatPath: np.join(distDir, 'vita-in-ticino', 'oss-svizzera.html'),
    locale: 'it',
    title: 'Landing correlate per professione',
    intro:
      'Approfondisci iter di riconoscimento MEBEKO/SRK, CCL EOC, stipendio medio e datori di lavoro per le figure sanitarie ed educative in Ticino.',
    professionIds: ['infermiere', 'educatore'],
  });

  return targets;
}

export function professionLandingsLinksPlugin(rootDir: string): Plugin {
  return {
    name: 'profession-landings-links',
    apply: 'build',
    // `closeBundle` hooks run in parallel across plugins, so `enforce: 'post'`
    // alone is NOT enough to guarantee ordering against `staticPagesPlugin`
    // (which is also `enforce: 'post'`) — see the Determinism note at the top
    // of this file. We rely on the explicit signals exported by each producer.
    enforce: 'post',
    async closeBundle() {
      if (process.env.SKIP_PROFESSION_LANDINGS === '1') return;

      const distDir = np.resolve(rootDir, 'dist');
      if (!fs.existsSync(distDir)) return;

      // Mark the linter-friendly use of PROFESSION_SLUGS so imports don't drift.
      // (Anchor labels derived from ANCHOR_LABELS; slugs are built via
      // buildProfessionLandingPath which reads PROFESSION_SLUGS internally.)
      void PROFESSION_SLUGS;

      const targets = buildTargets(distDir);

      // Wait for both producers to flush before we read+patch. This replaces
      // the previous `waitForStable(t.indexPath)` mtime poll, which was
      // racing under heavy CI builds (5/5 → 0/5 silent regression).
      await Promise.all([staticPagesFlushed, professionLandingsFlushed]);

      const results = targets.map((t) => patchFile(t));

      const inserted = results.filter((r) => r.outcome === 'inserted').length;
      const duplicate = results.filter((r) => r.outcome === 'duplicate').length;
      const missingFile = results.filter((r) => r.outcome === 'missing-file');
      const noAnchor = results.filter((r) => r.outcome === 'no-anchor');

      console.log(
        `\x1b[36m[profession-landings-links]\x1b[0m Injected AE-3 profession-links block into ${inserted}/${targets.length} parent pages` +
          (duplicate > 0 ? ` (${duplicate} already had the marker)` : '') +
          '.',
      );

      // Hard-fail on any non-idempotent miss. A successful build MUST inject
      // the block into every target where it isn't already present — otherwise
      // the AE-3 internal-links graph collapses and 10 profession landings
      // turn into sitemap-professions.xml orphans (Semrush gate).
      const failures = [...missingFile, ...noAnchor];
      if (failures.length > 0) {
        const lines = failures.map(
          (r) =>
            ` - [${r.outcome}] ${np.relative(distDir, r.target.indexPath)}`,
        );
        throw new Error(
          `[profession-landings-links] AE-3 injection failed for ${failures.length}/${targets.length} target(s):\n${lines.join('\n')}\n\n` +
            'This breaks the AE-3 link graph and creates sitemap-professions.xml orphans. ' +
            'Diagnose: the target file did not exist after the producer signals fired (race condition), ' +
            'or the HTML had no <main>/</main>/</body> anchor. See build-plugins/shared/buildSignals.ts.',
        );
      }
    },
  };
}
