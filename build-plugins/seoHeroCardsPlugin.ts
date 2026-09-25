/**
 * Generates the hero cards the static SEO families request (issue #5001
 * punto 2).
 *
 * Measured 2026-08-06 on the live sitemaps: 40 of 86 families ship **zero**
 * `<img>` tags. For data landings that is a legitimate editorial choice — a
 * hero photograph for "tasse frontalieri a Colico" would be invented. For the
 * eight editorial families (~514 URLs) it is a gap: they carry
 * `max-image-preview:large` and an `og:image` pointing at the site-wide
 * default, so a header-only audit reads them as fine while Discover has no
 * page-specific image to build a large card from. Same shape #5101 fixed on
 * article pages.
 *
 * HOW IT FINDS ITS WORK
 * ─────────────────────
 * It does not scan `dist/`. Every hero goes through
 * `shared/seoHeroImage.ts:renderSeoHeroImage`, which registers the card as it
 * emits the markup, so this plugin just drains that registry. Two consequences
 * worth stating: a family cannot emit a hero and forget to request the image
 * (they are one call), and the ~800k-file `dist/` is never walked.
 *
 * It therefore MUST run after the emitters — `enforce: 'post'` plus last-ish
 * registration in vite.config.ts. If it ran first the registry would be empty
 * and it would render nothing, which is why {@link seoHeroCardsPlugin} logs
 * the drained count rather than silently doing nothing.
 *
 * Rendering reuses `og-render-worker.mjs` unchanged — the worker takes a
 * satori tree and returns a WebP buffer, with nothing job-specific in it
 * despite the name. The job-card design in `jobOgImagesPlugin` is NOT reused:
 * that card shows city/salary/company chips, which do not exist here. Same
 * pipeline, different tree.
 *
 * Idempotent: a card already on disk is left alone, so incremental builds pay
 * only for new pages.
 */

import fs from 'node:fs';
import np from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { Worker } from 'node:worker_threads';
import type { Plugin } from 'vite';

import {
  drainSeoHeroCardRequests,
  lateSeoHeroCardFamilies,
  seoHeroCardPath,
  SEO_HERO_HEIGHT,
  SEO_HERO_WIDTH,
  type SeoHeroCardRequest,
} from './shared/seoHeroImage';

// Same brand palette as the job cards, so the two card families read as one
// system rather than two designs that happen to share a size.
const BRAND_BG_FROM = '#0F2557';
const BRAND_BG_TO = '#1E3D8F';
const BRAND_ACCENT = '#FFB300';
const TEXT_PRIMARY = '#FFFFFF';

/** Headline budget. Beyond this satori wraps into the footer. */
const HEADLINE_MAX_CHARS = 110;

function truncate(s: string, max: number): string {
  const t = String(s ?? '').replace(/\s+/g, ' ').trim();
  if (t.length <= max) return t;
  const cut = t.slice(0, max - 1);
  const sp = cut.lastIndexOf(' ');
  return `${(sp > max * 0.6 ? cut.slice(0, sp) : cut).trimEnd()}…`;
}

function readFontPair(rootDir: string): { regular: Buffer; bold: Buffer } | null {
  try {
    return {
      regular: fs.readFileSync(np.join(rootDir, 'public/fonts/Roboto-Regular.ttf')),
      bold: fs.readFileSync(np.join(rootDir, 'public/fonts/Roboto-Bold.ttf')),
    };
  } catch {
    return null;
  }
}

/** Satori accepts a JSX-like object literal (React-style) — not real React. */
function buildCardTree(req: SeoHeroCardRequest): unknown {
  const children: unknown[] = [];

  if (req.eyebrow) {
    children.push({
      type: 'div',
      props: {
        style: {
          display: 'flex',
          color: BRAND_ACCENT,
          fontSize: 30,
          fontWeight: 700,
          letterSpacing: 2,
          textTransform: 'uppercase',
          marginBottom: 24,
        },
        children: truncate(req.eyebrow, 40),
      },
    });
  }

  children.push({
    type: 'div',
    props: {
      style: {
        display: 'flex',
        color: TEXT_PRIMARY,
        fontSize: 64,
        fontWeight: 700,
        lineHeight: 1.15,
        maxWidth: 1000,
      },
      children: truncate(req.headline, HEADLINE_MAX_CHARS),
    },
  });

  children.push({
    type: 'div',
    props: {
      style: {
        display: 'flex',
        marginTop: 'auto',
        color: 'rgba(255,255,255,0.82)',
        fontSize: 30,
        fontWeight: 400,
      },
      children: 'frontaliereticino.ch',
    },
  });

  return {
    type: 'div',
    props: {
      style: {
        display: 'flex',
        flexDirection: 'column',
        width: SEO_HERO_WIDTH,
        height: SEO_HERO_HEIGHT,
        padding: '72px 80px',
        backgroundImage: `linear-gradient(135deg, ${BRAND_BG_FROM} 0%, ${BRAND_BG_TO} 100%)`,
        fontFamily: 'Roboto',
      },
      children,
    },
  };
}

export function seoHeroCardsPlugin(rootDir: string): Plugin {
  return {
    name: 'seo-hero-cards',
    apply: 'build',
    enforce: 'post',
    async closeBundle() {
      const requests = drainSeoHeroCardRequests();
      if (requests.length === 0) {
        // Not silent: an empty registry means either no family opted in yet,
        // or this plugin ran before the emitters — the second is a wiring bug
        // and would otherwise look identical to the first.
        console.log('\x1b[33m[seo-hero-cards]\x1b[0m nessuna card richiesta (registry vuoto)');
        return;
      }
      if (process.env.SKIP_SEO_HERO_CARDS === '1') {
        console.log(
          `\x1b[33m[seo-hero-cards]\x1b[0m Skipped (SKIP_SEO_HERO_CARDS=1) — ${requests.length} card non generate`,
        );
        return;
      }

      const distDir = np.resolve(rootDir, 'dist');
      if (!fs.existsSync(distDir)) {
        // Simmetrico agli altri due early-return: un dist/ assente per un
        // problema di build-order non deve somigliare a «tutto ok, niente da
        // fare».
        console.warn(
          `\x1b[33m[seo-hero-cards]\x1b[0m dist/ assente (${distDir}) — ${requests.length} card non generate`,
        );
        return;
      }

      const fontPair = readFontPair(rootDir);
      if (!fontPair) {
        // Degrade loudly but do not fail the build: the pages still render,
        // they just keep a broken hero until the fonts are present. Matches
        // jobOgImagesPlugin's own behaviour for the same missing files.
        console.warn(
          '\x1b[33m[seo-hero-cards]\x1b[0m public/fonts/Roboto-{Regular,Bold}.ttf assenti — nessuna card generata',
        );
        return;
      }

      const queue = requests.filter((r) => {
        const out = np.join(distDir, seoHeroCardPath(r.family, r.key, r.locale));
        return !fs.existsSync(out);
      });
      if (queue.length === 0) {
        console.log(`\x1b[36m[seo-hero-cards]\x1b[0m ${requests.length} card già presenti`);
        return;
      }

      const workerCount = Math.max(1, Math.min(os.cpus().length - 1, 4));
      const workerPath = np.join(np.dirname(fileURLToPath(import.meta.url)), 'og-render-worker.mjs');
      console.log(
        `\x1b[36m[seo-hero-cards]\x1b[0m ${queue.length} card da generare su ${workerCount} worker (${requests.length - queue.length} già in cache)`,
      );

      let rendered = 0;
      let failed = 0;
      const t0 = Date.now();

      await new Promise<void>((resolve) => {
        let next = 0;
        let live = workerCount;
        const inflight = new Map<number, SeoHeroCardRequest>();

        const spawn = (): Worker => {
          const worker = new Worker(workerPath, {
            workerData: {
              fontRegular: fontPair.regular,
              fontBold: fontPair.bold,
              brandBgFrom: BRAND_BG_FROM,
              width: SEO_HERO_WIDTH,
              height: SEO_HERO_HEIGHT,
            },
          });

          // Job attualmente in volo su QUESTO worker, per poterlo nominare se
          // il worker muore (l'`inflight` globale non dice di chi era).
          let current: number | null = null;

          const dispatch = (): void => {
            if (next >= queue.length) {
              current = null;
              worker.postMessage('shutdown');
              return;
            }
            const jobId = next++;
            current = jobId;
            inflight.set(jobId, queue[jobId]);
            worker.postMessage({ jobId, tree: buildCardTree(queue[jobId]) });
          };

          worker.on('message', (msg: { jobId: number; ok: boolean; webp?: Buffer; error?: string }) => {
            const req = inflight.get(msg.jobId);
            inflight.delete(msg.jobId);
            if (msg.ok && msg.webp && req) {
              const out = np.join(distDir, seoHeroCardPath(req.family, req.key, req.locale));
              try {
                fs.mkdirSync(np.dirname(out), { recursive: true });
                fs.writeFileSync(out, msg.webp);
                rendered++;
              } catch (err) {
                failed++;
                if (failed <= 5) {
                  console.warn(`\x1b[33m[seo-hero-cards]\x1b[0m scrittura fallita ${out}: ${(err as Error).message}`);
                }
              }
            } else {
              failed++;
              if (failed <= 5) {
                console.warn(`\x1b[33m[seo-hero-cards]\x1b[0m render fallito: ${msg.error ?? 'motivo ignoto'}`);
              }
            }
            dispatch();
          });

          worker.on('error', (err) => {
            // Il job che questo worker aveva in volo non tornera' mai: senza
            // nominarlo resterebbe un hero 404 su UNA pagina, invisibile in un
            // log che dice solo «worker error».
            const lost = current !== null ? queue[current] : undefined;
            failed++;
            console.warn(
              `\x1b[33m[seo-hero-cards]\x1b[0m worker error: ${err.message}` +
                (lost ? ` — card persa: ${lost.family}/${lost.key}/${lost.locale}` : ''),
            );
          });

          worker.on('exit', () => {
            live -= 1;
            if (live === 0) resolve();
          });

          dispatch();
          return worker;
        };

        for (let i = 0; i < workerCount; i++) spawn();
      });

      console.log(
        `\x1b[36m[seo-hero-cards]\x1b[0m ${rendered} card generate (${failed} fallite) in ${((Date.now() - t0) / 1000).toFixed(1)}s`,
      );

      // Chi ha chiesto una card DOPO il drain non l'avra' mai, e la sua pagina
      // e' gia' stata scritta con un <img> verso quel file: un hero 404. E'
      // successo davvero (pdfWhitepapersPlugin, `await import` in testa a
      // closeBundle), ed era invisibile senza una build reale — quindi qui non
      // resta silenzioso.
      const late = lateSeoHeroCardFamilies();
      if (late.length > 0) {
        console.warn(
          `\x1b[33m[seo-hero-cards]\x1b[0m ${late.length} card richieste DOPO il drain — le loro pagine puntano a un webp inesistente. ` +
            `Causa tipica: un \`await\` prima del loop di render nell'emettitore, che sospende closeBundle oltre il drain. ` +
            `Famiglie: ${late.join(', ')}`,
        );
      }
    },
  };
}
