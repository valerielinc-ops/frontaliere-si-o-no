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

async function waitForStable(
  path: string,
  timeoutMs = 600_000,
  stableMs = 750,
  pollMs = 250,
): Promise<boolean> {
  // Wait for the file to exist AND remain unchanged in size+mtime for
  // `stableMs` — staticPagesPlugin + professionLandingsPlugin run in parallel
  // via rollup's `closeBundle` hook, so a file can briefly exist then be
  // rewritten. We need the final flush to land before patching.
  const deadline = Date.now() + timeoutMs;
  let lastSig = '';
  let stableSince = 0;
  while (Date.now() < deadline) {
    try {
      const st = fs.statSync(path);
      const sig = `${st.size}|${st.mtimeMs}`;
      if (sig === lastSig) {
        if (Date.now() - stableSince >= stableMs) return true;
      } else {
        lastSig = sig;
        stableSince = Date.now();
      }
    } catch {
      // File does not exist yet — keep polling.
    }
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
  return fs.existsSync(path);
}

function patchFile(target: InjectionTarget): boolean {
  if (!fs.existsSync(target.indexPath)) return false;
  let html = fs.readFileSync(target.indexPath, 'utf-8');
  if (html.includes('data-ae3-profession-links')) return false;

  const block = renderBlock(target);
  const mainOpen = html.match(/<main\b[^>]*>/);
  if (mainOpen && mainOpen.index !== undefined) {
    const insertAt = mainOpen.index + mainOpen[0].length;
    html = html.slice(0, insertAt) + block + html.slice(insertAt);
  } else if (html.includes('</main>')) {
    html = html.replace('</main>', `${block}</main>`);
  } else if (html.includes('</body>')) {
    html = html.replace('</body>', `${block}</body>`);
  } else {
    return false;
  }

  fs.writeFileSync(target.indexPath, html, 'utf-8');
  // Do not write the flat .html sibling — it is a redirect bridge emitted
  // by flatHtmlRedirectPlugin and must stay untouched.
  return true;
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
    // `closeBundle` hooks run in parallel across plugins; mark this one `post`
    // so it runs AFTER staticPagesPlugin (which writes the target hub HTML)
    // and AFTER professionLandingsPlugin has flushed its own files. Combined
    // with the waitForStable poll, this ensures we inject AFTER the writer
    // has finished — otherwise the patch is silently overwritten.
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

      // staticPagesPlugin batches + flushes its writes via WriteCollector at
      // the end of its own closeBundle (~250s into the build). Poll for each
      // target's file to stabilise before we patch, otherwise the writer
      // races over our injection.
      await Promise.all(targets.map((t) => waitForStable(t.indexPath)));

      let patched = 0;
      for (const t of targets) {
        if (patchFile(t)) patched++;
      }
      console.log(
        `\x1b[36m[profession-landings-links]\x1b[0m Injected AE-3 profession-links block into ${patched}/${targets.length} parent pages.`,
      );
    },
  };
}
