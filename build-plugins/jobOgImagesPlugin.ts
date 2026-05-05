/**
 * Generates per-job Open Graph images (1200×630 PNG) for every job in
 * `data/jobs.json`. Output is written to `dist/og/jobs/<slug>.png` and
 * referenced by `og:image` on the corresponding job page (see
 * jobsSeoPagesPlugin → jobOgImageUrl).
 *
 * Why per-job: Facebook/LinkedIn previews show a single OG card per link.
 * A generic site-wide image yields zero context (just the brand). A per-job
 * image with title + company logo + city + salary gives a much richer
 * preview, lifting CTR from organic FB/LinkedIn shares and from the
 * scheduled posting pipeline (scripts/schedule-fb-jobs-daily.mjs).
 *
 * Performance: satori (HTML/JSX → SVG) + @resvg/resvg-js (SVG → PNG) renders
 * each card in ~30-60ms. 2100 jobs ≈ 1-2 min in CI. Skipped under
 * FAST_BUILD=1 (gating happens in vite.config.ts).
 *
 * Caching: idempotent. If the output PNG already exists for a slug, we skip
 * regeneration. To force regeneration of one job, delete its PNG.
 */

import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { cpus } from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import { Worker } from 'worker_threads';
import type { Plugin } from 'vite';

const OUT_SUBDIR = 'og/jobs';
// Persistent cache dir survives `dist/` cleanup. Cache step in deploy.yml
// restores this between CI runs so unchanged jobs keep their PNG.
const CACHE_SUBDIR = '.cache/og-jobs';

/**
 * Bump this string when the rendering pipeline changes shape (layout,
 * colors, fonts, brand wordmark, chip style, …). Embedded into every
 * cached PNG's filename so layout-only changes invalidate the cache
 * cleanly even when the actions/cache restore-keys cascade rehydrates
 * an older cache layer. Same pattern used by pdfWhitepapersPlugin
 * (PDF_RENDER_VERSION).
 *
 * Cache filename is `<jobId>.<OG_RENDER_VERSION>.png`. When this version
 * bumps, the new build looks for new filenames, doesn't find them, and
 * re-renders. Old cached PNGs become orphaned and age out automatically
 * when the GitHub Actions cache evicts them (~7-day TTL).
 */
const OG_RENDER_VERSION = 'v1-2026-05-05';
const PNG_WIDTH = 1200;
const PNG_HEIGHT = 630;

// Brand palette (Frontaliere Ticino). Kept inline to avoid coupling the
// plugin to runtime CSS — these are the design tokens for OG only.
const BRAND_BG_FROM = '#0F2557'; // deep navy
const BRAND_BG_TO = '#1E3D8F'; // mid blue
const BRAND_ACCENT = '#FFB300'; // amber (price/CTA)
const TEXT_PRIMARY = '#FFFFFF';
const TEXT_MUTED = 'rgba(255,255,255,0.78)';
const SURFACE = '#FFFFFF';

interface JobMinimal {
  id: string;
  title?: string;
  company?: string;
  companyKey?: string;
  hiringOrganization?: { name?: string };
  jobLocation?: { address?: { addressLocality?: string } };
  location?: string;
  baseSalary?: {
    currency?: string;
    value?: { minValue?: number; maxValue?: number; unitText?: string } | number;
  };
  salaryMin?: number;
  salaryMax?: number;
  slug?: string;
  slugByLocale?: Record<string, string>;
  category?: string;
  sector?: string;
  employmentType?: string;
}

function readFontPair(rootDir: string): { regular: Buffer; bold: Buffer } | null {
  // satori needs static TTF/OTF (variable fonts unsupported by its embedded
  // opentype.js). Roboto static TTF lives in public/fonts/.
  const regularPath = path.join(rootDir, 'public/fonts/Roboto-Regular.ttf');
  const boldPath = path.join(rootDir, 'public/fonts/Roboto-Bold.ttf');
  if (!existsSync(regularPath) || !existsSync(boldPath)) return null;
  try {
    return {
      regular: readFileSync(regularPath),
      bold: readFileSync(boldPath),
    };
  } catch {
    return null;
  }
}

function readLogosManifest(rootDir: string): Record<string, string> {
  const file = path.join(rootDir, 'data/company-logos-manifest.json');
  try {
    if (!existsSync(file)) return {};
    return JSON.parse(readFileSync(file, 'utf-8')) as Record<string, string>;
  } catch {
    return {};
  }
}

function readJobsJson(rootDir: string): JobMinimal[] {
  const candidates = [
    path.join(rootDir, 'data/jobs.json'),
    path.join(rootDir, 'public/data/jobs.json'),
  ];
  for (const c of candidates) {
    if (!existsSync(c)) continue;
    try {
      const parsed = JSON.parse(readFileSync(c, 'utf-8')) as unknown;
      if (Array.isArray(parsed)) return parsed as JobMinimal[];
      const wrapped = parsed as { jobs?: JobMinimal[] };
      if (wrapped && Array.isArray(wrapped.jobs)) return wrapped.jobs;
    } catch {
      /* try next */
    }
  }
  return [];
}

function logoDataUrl(rootDir: string, manifestPath: string): string | null {
  // manifestPath looks like "/images/brands/<slug>.png"
  if (!manifestPath || !manifestPath.startsWith('/')) return null;
  const abs = path.join(rootDir, 'public', manifestPath);
  if (!existsSync(abs)) return null;
  try {
    const ext = path.extname(abs).toLowerCase();
    const mime =
      ext === '.png'
        ? 'image/png'
        : ext === '.jpg' || ext === '.jpeg'
        ? 'image/jpeg'
        : ext === '.svg'
        ? 'image/svg+xml'
        : 'image/png';
    const buf = readFileSync(abs);
    return `data:${mime};base64,${buf.toString('base64')}`;
  } catch {
    return null;
  }
}

function formatChf(min?: number, max?: number): string | null {
  const fmt = (n: number) =>
    n.toLocaleString('de-CH').replace(/’/g, "'");
  if (min && max && max > min) return `CHF ${fmt(min)}–${fmt(max)}`;
  if (min) return `CHF ${fmt(min)}+`;
  if (max) return `CHF fino a ${fmt(max)}`;
  return null;
}

function deriveSalary(job: JobMinimal): string | null {
  const v = job?.baseSalary?.value;
  if (v && typeof v === 'object') {
    return formatChf(v.minValue, v.maxValue);
  }
  if (job?.salaryMin || job?.salaryMax) {
    return formatChf(job.salaryMin, job.salaryMax);
  }
  return null;
}

function deriveCity(job: JobMinimal): string | null {
  return (
    job?.jobLocation?.address?.addressLocality?.trim() ||
    job?.location?.trim() ||
    null
  );
}

function deriveCompany(job: JobMinimal): string | null {
  return (
    job?.hiringOrganization?.name?.trim() ||
    job?.company?.trim() ||
    null
  );
}

function deriveSlug(job: JobMinimal): string | null {
  return (
    job?.slugByLocale?.it ||
    job?.slug ||
    null
  );
}

const EMPLOYMENT_LABEL_IT: Record<string, string> = {
  FULL_TIME: 'Tempo pieno',
  PART_TIME: 'Part-time',
  CONTRACTOR: 'Contratto',
  TEMPORARY: 'Temporaneo',
  INTERN: 'Stage',
};

function truncateText(s: string, maxChars: number): string {
  if (!s) return '';
  if (s.length <= maxChars) return s;
  // Cut at word boundary
  const slice = s.slice(0, maxChars);
  const lastSpace = slice.lastIndexOf(' ');
  return (lastSpace > maxChars * 0.6 ? slice.slice(0, lastSpace) : slice).trim() + '…';
}

interface CardModel {
  title: string;
  company: string | null;
  city: string | null;
  salary: string | null;
  employmentLabel: string | null;
  logoDataUrl: string | null;
}

function buildCardJsx(model: CardModel): unknown {
  // Satori accepts a JSX-like object literal (React-style) — not real React.
  const pill = (text: string, accent = false) => ({
    type: 'div',
    props: {
      style: {
        display: 'flex',
        backgroundColor: accent ? BRAND_ACCENT : 'rgba(255,255,255,0.16)',
        color: accent ? '#0F2557' : TEXT_PRIMARY,
        fontSize: 28,
        fontWeight: 600,
        padding: '10px 22px',
        borderRadius: 999,
        marginRight: 16,
      },
      children: text,
    },
  });

  // No emoji in chips: Roboto has no emoji glyphs and shipping a colored
  // emoji font would inflate the build for marginal value. Pill backgrounds
  // + colors give enough visual hierarchy.
  const chips = [
    model.city ? pill(model.city) : null,
    model.salary ? pill(model.salary, true) : null,
    model.employmentLabel ? pill(model.employmentLabel) : null,
  ].filter(Boolean);

  const logoBlock = model.logoDataUrl
    ? {
        type: 'div',
        props: {
          style: {
            display: 'flex',
            width: 180,
            height: 180,
            backgroundColor: SURFACE,
            borderRadius: 24,
            alignItems: 'center',
            justifyContent: 'center',
            padding: 16,
            boxShadow: '0 12px 28px rgba(0,0,0,0.35)',
          },
          children: {
            type: 'img',
            props: {
              src: model.logoDataUrl,
              width: 148,
              height: 148,
              style: { objectFit: 'contain' },
            },
          },
        },
      }
    : null;

  return {
    type: 'div',
    props: {
      style: {
        width: PNG_WIDTH,
        height: PNG_HEIGHT,
        display: 'flex',
        flexDirection: 'column',
        backgroundImage: `linear-gradient(135deg, ${BRAND_BG_FROM} 0%, ${BRAND_BG_TO} 100%)`,
        color: TEXT_PRIMARY,
        fontFamily: 'Roboto',
        padding: 60,
        position: 'relative',
      },
      children: [
        // Top: brand row + logo
        {
          type: 'div',
          props: {
            style: {
              display: 'flex',
              flexDirection: 'row',
              justifyContent: 'space-between',
              alignItems: 'flex-start',
            },
            children: [
              {
                type: 'div',
                props: {
                  style: {
                    display: 'flex',
                    flexDirection: 'column',
                  },
                  children: [
                    {
                      type: 'div',
                      props: {
                        style: {
                          fontSize: 26,
                          fontWeight: 700,
                          letterSpacing: 1,
                          color: BRAND_ACCENT,
                        },
                        children: 'FRONTALIERE TICINO',
                      },
                    },
                    {
                      type: 'div',
                      props: {
                        style: {
                          fontSize: 22,
                          color: TEXT_MUTED,
                          marginTop: 4,
                        },
                        children: 'Lavoro in Svizzera per frontalieri',
                      },
                    },
                  ],
                },
              },
              logoBlock,
            ].filter(Boolean),
          },
        },
        // Middle: title + company
        {
          type: 'div',
          props: {
            style: {
              display: 'flex',
              flexDirection: 'column',
              flexGrow: 1,
              justifyContent: 'center',
              marginTop: 30,
              marginBottom: 30,
            },
            children: [
              {
                type: 'div',
                props: {
                  style: {
                    fontSize: 64,
                    fontWeight: 800,
                    lineHeight: 1.1,
                    color: TEXT_PRIMARY,
                    display: 'block',
                  },
                  children: model.title,
                },
              },
              model.company
                ? {
                    type: 'div',
                    props: {
                      style: {
                        fontSize: 36,
                        fontWeight: 600,
                        color: TEXT_MUTED,
                        marginTop: 18,
                      },
                      children: model.company,
                    },
                  }
                : null,
            ].filter(Boolean),
          },
        },
        // Bottom: chips
        {
          type: 'div',
          props: {
            style: {
              display: 'flex',
              flexDirection: 'row',
              flexWrap: 'wrap',
              alignItems: 'center',
            },
            children: chips,
          },
        },
        // Watermark
        {
          type: 'div',
          props: {
            style: {
              position: 'absolute',
              right: 60,
              bottom: 36,
              fontSize: 22,
              color: TEXT_MUTED,
            },
            children: 'frontaliereticino.ch',
          },
        },
      ],
    },
  };
}

function ogPathForSlug(slug: string): string {
  return path.join(OUT_SUBDIR, `${slug}.png`);
}

/**
 * The cache filename uses `job.id` directly — the crawler emits IDs of
 * the form `<companyKey>-<contentHash12>` (e.g. "tether-163fdd7ecddc")
 * where the trailing 12 hex chars are a content-derived hash that
 * already changes whenever a job's title/company/salary/etc. is
 * updated. So caching by ID gives content-aware invalidation for free,
 * without us having to maintain our own field-set + hash function.
 *
 * Slug changes that don't change content → same ID → cache hit, just
 * copies the PNG to the new slug filename in dist.
 * Content changes → new ID → cache miss → fresh render.
 */
function cacheKeyForJob(job: JobMinimal): string | null {
  if (!job?.id || typeof job.id !== 'string') return null;
  // Sanitize: IDs are crawler-emitted but paranoia is cheap. Replace any
  // path-unsafe character with `_` to keep filenames sane.
  return job.id.replace(/[^A-Za-z0-9._-]/g, '_');
}

export function jobOgImageUrl(baseUrl: string, slug: string | null): string | null {
  if (!slug) return null;
  return `${baseUrl}/${OUT_SUBDIR}/${slug}.png`;
}

interface Stats {
  rendered: number;
  cached: number;
  skipped: number;
  errors: number;
}

export default function jobOgImagesPlugin(): Plugin {
  let outDir: string | null = null;
  let rootDir: string | null = null;

  return {
    name: 'job-og-images',
    apply: 'build',
    configResolved(cfg) {
      outDir = cfg.build?.outDir ?? 'dist';
      rootDir = cfg.root ?? process.cwd();
    },
    async closeBundle() {
      if (!outDir || !rootDir) return;
      const fontPair = readFontPair(rootDir);
      if (!fontPair) {
        // eslint-disable-next-line no-console
        console.warn(
          '[job-og-images] Roboto-{Regular,Bold}.ttf not found in public/fonts — skipping OG images.',
        );
        return;
      }
      const jobs = readJobsJson(rootDir);
      if (jobs.length === 0) {
        // eslint-disable-next-line no-console
        console.warn('[job-og-images] no jobs in jobs.json — skipping.');
        return;
      }

      const manifest = readLogosManifest(rootDir);
      const outRoot = path.join(rootDir, outDir, OUT_SUBDIR);
      const cacheRoot = path.join(rootDir, CACHE_SUBDIR);
      mkdirSync(outRoot, { recursive: true });
      mkdirSync(cacheRoot, { recursive: true });

      const stats: Stats = { rendered: 0, cached: 0, skipped: 0, errors: 0 };
      const startMs = Date.now();

      // ── Pass 1: drain the cache (synchronous I/O, no satori needed) ──
      // For each job, decide whether we already have a fresh PNG. If yes,
      // copy cache → dist and skip. If no, queue for render in pass 2.
      interface RenderJob {
        jobId: string;
        slug: string;
        outPath: string;
        cachePath: string;
        // Pre-built satori tree (computed in pass 1 to avoid re-deriving
        // model fields when the worker pool dispatches).
        tree: unknown;
      }
      const renderQueue: RenderJob[] = [];
      for (const job of jobs) {
        const slug = deriveSlug(job);
        const cacheKey = cacheKeyForJob(job);
        if (!slug || !cacheKey || !job?.title) {
          stats.skipped += 1;
          continue;
        }
        const outPath = path.join(rootDir, outDir, ogPathForSlug(slug));
        // Cache filename combines (a) job.id (crawler-emitted content
        // hash) AND (b) OG_RENDER_VERSION (our design version). When
        // either changes the filename changes → cache miss → re-render.
        const cachePath = path.join(
          cacheRoot,
          `${cacheKey}.${OG_RENDER_VERSION}.png`,
        );

        if (existsSync(cachePath)) {
          try {
            mkdirSync(path.dirname(outPath), { recursive: true });
            copyFileSync(cachePath, outPath);
            stats.cached += 1;
            continue;
          } catch {
            /* fall through to enqueue for render */
          }
        }

        const logoMfPath = job.companyKey ? manifest[job.companyKey] : undefined;
        const model: CardModel = {
          title: truncateText(job.title, 110),
          company: deriveCompany(job),
          city: deriveCity(job),
          salary: deriveSalary(job),
          employmentLabel: job.employmentType
            ? EMPLOYMENT_LABEL_IT[job.employmentType] ?? null
            : null,
          logoDataUrl: logoMfPath ? logoDataUrl(rootDir, logoMfPath) : null,
        };
        renderQueue.push({
          jobId: cacheKey,
          slug,
          outPath,
          cachePath,
          tree: buildCardJsx(model),
        });
      }

      // ── Pass 2: render the queue across a worker pool ─────────
      if (renderQueue.length > 0) {
        const workerCount = Math.max(
          1,
          Math.min(
            renderQueue.length,
            Number(process.env.OG_WORKER_COUNT) || cpus().length || 2,
            // Cap at 4 — diminishing returns beyond that on a 2-core CI
            // runner, and font buffers are duplicated per worker (2× 45KB).
            4,
          ),
        );
        // eslint-disable-next-line no-console
        console.log(
          `[job-og-images] rendering ${renderQueue.length} cards across ${workerCount} workers (cache hits: ${stats.cached}/${jobs.length})`,
        );

        // Resolve worker URL relative to this file, so the build path
        // (dist or source) doesn't matter at runtime.
        const here = path.dirname(fileURLToPath(import.meta.url));
        const workerPath = path.join(here, 'og-render-worker.mjs');

        const writeResult = (job: RenderJob, png: Buffer) => {
          try {
            mkdirSync(path.dirname(job.cachePath), { recursive: true });
            mkdirSync(path.dirname(job.outPath), { recursive: true });
            writeFileSync(job.cachePath, png);
            writeFileSync(job.outPath, png);
            stats.rendered += 1;
          } catch (err) {
            stats.errors += 1;
            if (stats.errors <= 5) {
              // eslint-disable-next-line no-console
              console.warn(
                `[job-og-images] write failed for ${job.slug}: ${(err as Error).message}`,
              );
            }
          }
        };

        await new Promise<void>((resolve) => {
          let nextIdx = 0;
          let liveWorkers = workerCount;

          const dispatch = (worker: Worker) => {
            if (nextIdx >= renderQueue.length) {
              worker.postMessage('shutdown');
              return false;
            }
            const job = renderQueue[nextIdx];
            nextIdx += 1;
            // Tag worker → in-flight job via WeakMap-equivalent on the
            // worker instance. Simpler: store on a property.
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            (worker as any).__inflight = job;
            worker.postMessage({ jobId: job.jobId, tree: job.tree });
            return true;
          };

          for (let i = 0; i < workerCount; i++) {
            const worker = new Worker(workerPath, {
              workerData: {
                fontRegular: fontPair.regular,
                fontBold: fontPair.bold,
                brandBgFrom: BRAND_BG_FROM,
                width: PNG_WIDTH,
                height: PNG_HEIGHT,
              },
            });

            worker.on(
              'message',
              (
                msg:
                  | { jobId: string; ok: true; png: Buffer }
                  | { jobId: string; ok: false; error: string },
              ) => {
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                const job: RenderJob = (worker as any).__inflight;
                if (msg.ok === true) {
                  writeResult(job, msg.png);
                } else {
                  stats.errors += 1;
                  if (stats.errors <= 5) {
                    // eslint-disable-next-line no-console
                    console.warn(
                      `[job-og-images] render failed for ${job.slug}: ${msg.error}`,
                    );
                  }
                }
                if (!dispatch(worker)) {
                  worker.terminate();
                }
              },
            );
            worker.on('error', (err) => {
              stats.errors += 1;
              // eslint-disable-next-line no-console
              console.warn(`[job-og-images] worker error: ${err.message}`);
            });
            worker.on('exit', () => {
              liveWorkers -= 1;
              if (liveWorkers === 0) resolve();
            });

            // Prime the worker with its first job.
            dispatch(worker);
          }
        });
      }

      const elapsedMs = Date.now() - startMs;
      // eslint-disable-next-line no-console
      console.log(
        `[job-og-images] rendered=${stats.rendered} cached=${stats.cached} skipped=${stats.skipped} errors=${stats.errors} in ${(elapsedMs / 1000).toFixed(1)}s`,
      );
    },
  };
}
