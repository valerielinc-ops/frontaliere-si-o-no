/**
 * Generates per-job Open Graph images (1080×1350 WebP) for every job in
 * `data/jobs.json`. Output is written to `dist/og/jobs/<slug>.webp` and
 * referenced by `og:image` on the corresponding job page (see
 * jobsSeoPagesPlugin → jobOgImageUrl).
 *
 * Why per-job: Facebook/LinkedIn previews show a single OG card per link.
 * A generic site-wide image yields zero context (just the brand). A per-job
 * image with a generated workplace photo, title, city, and salary gives people
 * more context when a role is shared on Facebook or LinkedIn.
 *
 * Performance: satori (HTML/JSX → SVG) + @resvg/resvg-js (SVG → PNG) +
 * sharp (PNG → WebP q72) render cards through a bounded worker pool.
 * Skipped under FAST_BUILD=1 (gating happens in vite.config.ts).
 *
 * Why WebP: quality 72 + effort 6 keeps photo detail while limiting the
 * storage cost of thousands of generated cards. Facebook receives a portrait
 * 4:5 image; other preview clients can crop it as needed.
 *
 * Caching: filenames include the job slug, selected photo, and render version.
 * To force regeneration, bump OG_RENDER_VERSION.
 */

import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, unlinkSync, writeFileSync } from 'fs';
import { cpus } from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import { peelDanglingClauseTail } from './shared/clauseTail.mjs';
import { Worker } from 'worker_threads';
import type { Plugin } from 'vite';
import { shouldEmitLocale } from './shared/localeEmitFilter';
import { JOB_OG_PHOTO_FILES, getJobOgPhotoKey } from './shared/jobOgImageCatalog.mjs';
import {
  ARCHIVED_JOB_OG_IMAGE_VERSION,
  JOB_OG_IMAGE_VERSION,
  versionedJobOgImageUrl,
} from './shared/jobOgImageVersion.mjs';

const OUT_SUBDIR = 'og/jobs';
// Persistent cache dir survives `dist/` cleanup. Cache step in deploy.yml
// restores this between CI runs so unchanged jobs keep their WebP.
const CACHE_SUBDIR = '.cache/og-jobs';

/**
 * Bump this string when the rendering pipeline changes shape (layout,
 * colors, photo treatment, fonts, CTA, dimensions, …). Embedded into every
 * cached WebP's filename so layout-only changes invalidate the cache
 * cleanly even when the actions/cache restore-keys cascade rehydrates
 * an older cache layer. Same pattern used by pdfWhitepapersPlugin
 * (PDF_RENDER_VERSION).
 *
 * Cache filename is `<slug>.<photoKey>.<OG_RENDER_VERSION>.webp`. When this version
 * bumps, the new build looks for new filenames, doesn't find them, and
 * re-renders. Old cached files become orphaned and age out automatically
 * when the GitHub Actions cache evicts them (~7-day TTL).
 */
const OG_RENDER_VERSION = JOB_OG_IMAGE_VERSION;
const OG_WIDTH = 1080;
const OG_HEIGHT = 1350;

// Brand palette (Frontaliere Ticino). Kept inline to avoid coupling the
// plugin to runtime CSS — these are the design tokens for OG only.
const BRAND_BG_FROM = '#0F2557'; // deep navy
const BRAND_ACCENT = '#FFB300'; // amber (price/CTA)
const CTA_RED = '#DC2626';
const TEXT_PRIMARY = '#FFFFFF';
const TEXT_MUTED = 'rgba(255,255,255,0.78)';

interface JobMinimal {
  id: string;
  title?: string;
  titleByLocale?: Record<string, string>;
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

const JOB_PHOTO_KEYS = ['healthcare', 'hospitality', 'trades', 'office'] as const;
type JobFallbackPhotoKey = (typeof JOB_PHOTO_KEYS)[number];
type JobPhotoKey = string;

const JOB_PHOTO_KEYWORDS: Record<JobFallbackPhotoKey, string[]> = {
  healthcare: [
    'health', 'sanit', 'inferm', 'medic', 'farmac', 'pharma', 'biotech',
    'osped', 'clinica', 'assistenz', 'cura', 'pflege', 'soins', 'sante',
    'nursing', 'nurse', 'arzt',
  ],
  hospitality: [
    'hotel', 'hospitality', 'albergo', 'ristor', 'restaurant', 'camerier',
    'cuoc', 'chef', 'cucina', 'barista', 'housekeep', 'reception', 'turism',
    'catering', 'gastronom', 'servicefach', 'restauration', 'hoteller',
  ],
  trades: [
    'tecnic', 'elettric', 'idraulic', 'meccanic', 'ingegner', 'engineer',
    'manutenz', 'montator', 'saldat', 'produzion', 'magazzin', 'operator',
    'logistic', 'liefer', 'lager', 'werkstatt', 'bau', 'construction',
    'instandhalt', 'automation', 'technicien', 'atelier', 'installator',
    'technical', 'tech', 'manufacturing', 'industr', 'agricol', 'farm',
  ],
  office: [
    'office', 'admin', 'amministr', 'administr', 'contab', 'segreter',
    'commercial', 'marketing', 'sales', 'vendit', 'commerc', 'retail',
    'dettaglio', 'back-office', 'risorse umane', 'human resources', 'hr',
    'analyst', 'finanz', 'finance', 'assicuraz', 'insurance', 'account',
    'legal', 'bureau', 'impiegat', 'assistant', 'education', 'formazione',
    'it',
  ],
};

function classifyJobPhoto(job: JobMinimal): JobFallbackPhotoKey {
  const searchText = [job.category, job.sector, job.titleByLocale?.it, job.title]
    .filter(Boolean)
    .join(' ')
    .toLocaleLowerCase('it')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '');
  const searchTerms = new Set(searchText.split(/[^a-z0-9]+/).filter(Boolean));
  return JOB_PHOTO_KEYS.find((key) => JOB_PHOTO_KEYWORDS[key].some((keyword) => {
    if (keyword.length <= 3) return searchTerms.has(keyword);
    return searchText.includes(keyword);
  })) ?? 'office';
}

interface JobPhotoSources {
  fallbackDataUrls: Record<JobFallbackPhotoKey, string>;
  specificPhotoPaths: Record<string, string>;
}

function readJobPhotoSources(rootDir: string): JobPhotoSources | null {
  const photoDir = path.join(rootDir, 'build-plugins/assets/facebook-jobs');
  const fallbackDataUrls = {} as Record<JobFallbackPhotoKey, string>;
  const specificPhotoPaths: Record<string, string> = {};
  try {
    for (const key of JOB_PHOTO_KEYS) {
      const file = path.join(photoDir, `${key}.jpg`);
      if (!existsSync(file)) return null;
      fallbackDataUrls[key] = `data:image/jpeg;base64,${readFileSync(file).toString('base64')}`;
    }
    for (const [key, fileName] of Object.entries(JOB_OG_PHOTO_FILES)) {
      const file = path.join(photoDir, fileName);
      if (!existsSync(file)) return null;
      specificPhotoPaths[key] = file;
    }
    const archivePhoto = path.join(photoDir, 'archive-neutral.jpg');
    if (!existsSync(archivePhoto)) return null;
    specificPhotoPaths['archive-neutral'] = archivePhoto;
    return { fallbackDataUrls, specificPhotoPaths };
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
  // Shared peel — a word-boundary cut still stops mid-clause.
  return peelDanglingClauseTail((lastSpace > maxChars * 0.6 ? slice.slice(0, lastSpace) : slice).trim()) + '…';
}

interface CardModel {
  title: string;
  subtitle?: string;
  company: string | null;
  city: string | null;
  salary: string | null;
  employmentLabel: string | null;
  photoKey: JobPhotoKey;
  ctaLabel?: string;
  ctaSite?: string;
}

function buildCardJsx(model: CardModel): unknown {
  // Satori accepts a JSX-like object literal (React-style) — not real React.
  const pill = (text: string, accent = false) => ({
    type: 'div',
    props: {
      style: {
        display: 'flex',
        backgroundColor: accent ? BRAND_ACCENT : 'rgba(255,255,255,0.18)',
        color: accent ? BRAND_BG_FROM : TEXT_PRIMARY,
        fontSize: 25,
        fontWeight: 600,
        padding: '12px 20px',
        borderRadius: 14,
        marginRight: 14,
        marginBottom: 14,
      },
      children: text,
    },
  });

  const chips = [
    model.city ? pill(truncateText(model.city, 32)) : null,
    model.salary ? pill(model.salary, true) : null,
    model.employmentLabel ? pill(model.employmentLabel) : null,
  ].filter(Boolean);

  return {
    type: 'div',
    props: {
      style: {
        width: OG_WIDTH,
        height: OG_HEIGHT,
        display: 'flex',
        flexDirection: 'column',
        backgroundColor: BRAND_BG_FROM,
        color: TEXT_PRIMARY,
        fontFamily: 'Roboto',
        position: 'relative',
        overflow: 'hidden',
      },
      children: [
        {
          type: 'img',
          props: {
            src: 'job-photo:' + model.photoKey,
            width: OG_WIDTH,
            height: OG_HEIGHT,
            style: {
              position: 'absolute',
              top: 0,
              left: 0,
              width: OG_WIDTH,
              height: OG_HEIGHT,
              objectFit: 'cover',
            },
          },
        },
        {
          type: 'div',
          props: {
            style: {
              position: 'absolute',
              top: 0,
              left: 0,
              width: OG_WIDTH,
              height: OG_HEIGHT,
              backgroundImage: 'linear-gradient(90deg, rgba(7,20,52,0.96) 0%, rgba(7,20,52,0.9) 58%, rgba(7,20,52,0.68) 82%, rgba(7,20,52,0.28) 100%)',
            },
          },
        },
        {
          type: 'div',
          props: {
            style: {
              display: 'flex',
              flexDirection: 'column',
              justifyContent: 'space-between',
              width: OG_WIDTH,
              height: OG_HEIGHT,
              padding: 64,
              position: 'relative',
            },
            children: [
              {
                type: 'div',
                props: {
                  style: {
                    display: 'flex',
                    flexDirection: 'column',
                    alignItems: 'flex-start',
                  },
                  children: [
                    {
                      type: 'div',
                      props: {
                        style: {
                          fontSize: 30,
                          fontWeight: 700,
                          letterSpacing: 1.4,
                          color: TEXT_PRIMARY,
                        },
                        children: 'FRONTALIERETICINO.CH',
                      },
                    },
                    {
                      type: 'div',
                      props: {
                        style: {
                          width: 92,
                          height: 7,
                          backgroundColor: BRAND_ACCENT,
                          marginTop: 18,
                        },
                      },
                    },
                  ],
                },
              },
              {
                type: 'div',
                props: {
                  style: {
                    display: 'flex',
                    flexDirection: 'column',
                    maxWidth: 850,
                    marginTop: 55,
                    marginBottom: 45,
                  },
                  children: [
                    {
                      type: 'div',
                      props: {
                        style: {
                          fontSize: 62,
                          fontWeight: 800,
                          lineHeight: 1.05,
                          color: TEXT_PRIMARY,
                          display: 'block',
                        },
                        children: model.title,
                      },
                    },
                    model.subtitle
                      ? {
                          type: 'div',
                          props: {
                            style: {
                              fontSize: 32,
                              lineHeight: 1.2,
                              fontWeight: 600,
                              color: TEXT_MUTED,
                              marginTop: 20,
                            },
                            children: model.subtitle,
                          },
                        }
                      : null,
                    model.company
                      ? {
                          type: 'div',
                          props: {
                            style: {
                              fontSize: 32,
                              fontWeight: 600,
                              color: TEXT_MUTED,
                              marginTop: 20,
                            },
                            children: truncateText(model.company, 52),
                          },
                        }
                      : null,
                    chips.length
                      ? {
                          type: 'div',
                          props: {
                            style: {
                              display: 'flex',
                              flexDirection: 'row',
                              flexWrap: 'wrap',
                              alignItems: 'center',
                              marginTop: 28,
                            },
                            children: chips,
                          },
                        }
                      : null,
                  ].filter(Boolean),
                },
              },
              {
                type: 'div',
                props: {
                  style: {
                    display: 'flex',
                    flexDirection: 'column',
                    alignItems: 'center',
                    justifyContent: 'center',
                    backgroundColor: CTA_RED,
                    borderRadius: 18,
                    width: 850,
                    padding: '24px 30px',
                  },
                  children: [
                    {
                      type: 'div',
                      props: {
                        style: {
                          fontSize: 23,
                          lineHeight: 1.1,
                          fontWeight: 700,
                          letterSpacing: 1.2,
                          color: TEXT_PRIMARY,
                        },
                        children: model.ctaLabel ?? 'CANDIDATI SU',
                      },
                    },
                    {
                      type: 'div',
                      props: {
                        style: {
                          fontSize: 34,
                          lineHeight: 1.1,
                          fontWeight: 700,
                          color: TEXT_PRIMARY,
                          marginTop: 7,
                        },
                        children: model.ctaSite ?? 'frontaliereticino.ch',
                      },
                    },
                  ],
                },
              },
            ],
          },
        },
      ],
    },
  };
}

function ogPathForSlug(slug: string): string {
  return path.join(OUT_SUBDIR, `${slug}.webp`);
}

/**
 * The cache filename uses `slug` + `photoKey` + `OG_RENDER_VERSION`.
 *
 * Why slug (not job.id, not a custom hash):
 * - The crawler `job.id` is URL-derived (sha1 of the source URL), so
 *   it's stable when the URL is reused for a different role — we've
 *   seen `a-group-6cbebae3da1d` go from "Receptionist" → "Consulente
 *   Legal Jr." in production. ID-only cache would have served stale.
 * - The slug, by contrast, is title-derived. It already encodes the
 *   three fields that account for ~99 % of OG-visible content changes:
 *   title, company, city. When any changes, the slug changes, the
 *   cache filename changes, and we re-render automatically.
 * - Slug-based filenames are human-readable in `.cache/og-jobs/`,
 *   which makes debugging and one-off invalidation trivial
 *   (`rm .cache/og-jobs/aiuto-flessibile-tally-weijl-chur.*`).
 *
 * Coverage gap: salary and employment-type edits DON'T change the slug
 * or photo key. Empirically <0.5 %/week of jobs (mostly translation
 * refinements) — accepted in exchange for simpler code and no separate
 * visual-hash maintenance.
 *
 * Cache filename: `<slug>.<photoKey>.<OG_RENDER_VERSION>.webp`
 *
 * slug + photo + design stable → same filename → cache hit
 * title/company/city edit → new slug      → re-render
 * design bump             → new version   → re-render
 *
 * Old cache entries (orphaned slugs) age out automatically via the
 * GitHub Actions cache TTL (~7 days).
 */

export function jobOgImageUrl(baseUrl: string, slug: string | null): string | null {
  return versionedJobOgImageUrl(baseUrl, slug);
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
      // dist/og is IT-owned (root-level, language-neutral: one card per job slug,
      // written here via direct fs.writeFileSync — it bypasses the WriteCollector's
      // shouldEmitPath gate). On a per-locale shard that does NOT own the root
      // (BUILD_LOCALE=en/de/fr) these cards would be rendered/copied into dist/og
      // only to be deleted by prune-locale-shard.mjs — pure wasted I/O (thousands
      // of webp). Skip: the IT shard (always present in the matrix) generates them
      // and pushes /og to the CDN; en/de/fr pages reference that shared CDN /og.
      // Monolith (EMIT_ALL) and the IT shard keep generating them unchanged, so the
      // recomposed-vs-monolith equivalence is unaffected (en/de/fr never carried
      // /og in their pruned output anyway).
      if (!shouldEmitLocale('it')) {
        // eslint-disable-next-line no-console
        console.log('[job-og-images] BUILD_LOCALE excludes IT (root owner) — skipping OG generation (CDN-shared, pruned on this shard).');
        return;
      }
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

      const photoSources = readJobPhotoSources(rootDir);
      if (!photoSources) {
        // eslint-disable-next-line no-console
        console.warn('[job-og-images] generated workplace photos are missing — skipping OG images.');
        return;
      }
      const outRoot = path.join(rootDir, outDir, OUT_SUBDIR);
      const cacheRoot = path.join(rootDir, CACHE_SUBDIR);
      mkdirSync(outRoot, { recursive: true });
      mkdirSync(cacheRoot, { recursive: true });

      const stats: Stats = { rendered: 0, cached: 0, skipped: 0, errors: 0 };
      const startMs = Date.now();

      // ── Pass 1: drain the cache (synchronous I/O, no satori needed) ──
      // For each job, decide whether we already have a fresh WebP. If yes,
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
        if (!slug || !job?.title) {
          stats.skipped += 1;
          continue;
        }
        const outPath = path.join(rootDir, outDir, ogPathForSlug(slug));
        const photoKey = getJobOgPhotoKey(slug) ?? classifyJobPhoto(job);
        // See the doc-comment above the deleted cacheKeyForJob for why
        // we cache by slug + photo key + version (not job.id + visualHash).
        const cachePath = path.join(
          cacheRoot,
          `${slug}.${photoKey}.${OG_RENDER_VERSION}.webp`,
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

        const model: CardModel = {
          // Prefer the Italian-translated title when present. The plugin's
          // audience is Italian-speaking frontalieri, the slug is built from
          // titleByLocale.it, and the OG meta `og:title` on the linked page
          // is the IT version — using the raw `job.title` (often German or
          // English source) leaks the wrong language into the social card.
          title: truncateText(
            job.titleByLocale?.it ?? job.title ?? '',
            82,
          ),
          company: deriveCompany(job),
          city: deriveCity(job),
          salary: deriveSalary(job),
          employmentLabel: job.employmentType
            ? EMPLOYMENT_LABEL_IT[job.employmentType] ?? null
            : null,
          photoKey,
        };
        renderQueue.push({
          jobId: slug,
          slug,
          outPath,
          cachePath,
          tree: buildCardJsx(model),
        });
      }

      const archivedOutPath = path.join(rootDir, outDir, OUT_SUBDIR, 'archive-landing-card.webp');
      const archivedCachePath = path.join(
        cacheRoot,
        `archive-landing-card.archive-neutral.${ARCHIVED_JOB_OG_IMAGE_VERSION}.webp`,
      );
      let archiveCardCached = false;
      if (existsSync(archivedCachePath)) {
        try {
          mkdirSync(path.dirname(archivedOutPath), { recursive: true });
          copyFileSync(archivedCachePath, archivedOutPath);
          stats.cached += 1;
          archiveCardCached = true;
        } catch {
          /* fall through to enqueue for render */
        }
      }
      if (!archiveCardCached) {
        renderQueue.push({
          jobId: 'archive-landing-card',
          slug: 'archive-landing-card',
          outPath: archivedOutPath,
          cachePath: archivedCachePath,
          tree: buildCardJsx({
            title: 'ANNUNCIO ARCHIVIATO',
            subtitle: 'Questa posizione non è più disponibile.',
            company: null,
            city: null,
            salary: null,
            employmentLabel: null,
            photoKey: 'archive-neutral',
            ctaLabel: 'CERCA OFFERTE ATTIVE',
          }),
        });
      }

      // ── Pass 2: render the queue across a worker pool ─────────
      if (renderQueue.length > 0) {
        const workerCount = Math.max(
          1,
          Math.min(
            renderQueue.length,
            Number(process.env.OG_WORKER_COUNT) || cpus().length || 2,
            // Cap at 4 — each worker keeps the static fonts and four compact
            // fallback JPEG data URLs in memory; offer-specific photos load lazily.
            4,
          ),
        );
        // eslint-disable-next-line no-console
        console.log(
          `[job-og-images] rendering ${renderQueue.length} cards across ${workerCount} workers (cache hits: ${stats.cached}/${jobs.length + 1})`,
        );

        // Resolve worker URL relative to this file, so the build path
        // (dist or source) doesn't matter at runtime.
        const here = path.dirname(fileURLToPath(import.meta.url));
        const workerPath = path.join(here, 'og-render-worker.mjs');

        const writeResult = (job: RenderJob, webp: Buffer) => {
          try {
            mkdirSync(path.dirname(job.cachePath), { recursive: true });
            mkdirSync(path.dirname(job.outPath), { recursive: true });
            writeFileSync(job.cachePath, webp);
            writeFileSync(job.outPath, webp);
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
                photoDataUrls: photoSources.fallbackDataUrls,
                photoFilePaths: photoSources.specificPhotoPaths,
                width: OG_WIDTH,
                height: OG_HEIGHT,
              },
            });

            worker.on(
              'message',
              (
                msg:
                  | { jobId: string; ok: true; webp: Buffer }
                  | { jobId: string; ok: false; error: string },
              ) => {
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                const job: RenderJob = (worker as any).__inflight;
                if (msg.ok === true) {
                  writeResult(job, msg.webp);
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

      // ── Cache cleanup: remove stale-version files from .cache/og-jobs/ ──
      // After a design bump (OG_RENDER_VERSION change) or format migration
      // (PNG → WebP), the actions/cache restore-keys cascade rehydrates the
      // previous version's cached files alongside the freshly-rendered ones.
      // Without cleanup the cache size grows by ~180 MB per version bump,
      // which both wastes the GitHub Actions cache budget and slows future
      // restores. Filenames are `<slug>.<photoKey>.<OG_RENDER_VERSION>.<ext>` so we drop
      // any entry whose suffix doesn't match the current version+extension.
      const versionSuffixes = [
        `.${OG_RENDER_VERSION}.webp`,
        `.${ARCHIVED_JOB_OG_IMAGE_VERSION}.webp`,
      ];
      let pruned = 0;
      let prunedBytes = 0;
      try {
        for (const entry of readdirSync(cacheRoot)) {
          if (versionSuffixes.some((suffix) => entry.endsWith(suffix))) continue;
          if (!entry.endsWith('.png') && !entry.endsWith('.webp')) continue;
          const orphaned = path.join(cacheRoot, entry);
          try {
            unlinkSync(orphaned);
            pruned += 1;
            // Rough avg: stale PNGs ~95 KB, stale WebPs ~30 KB. Used only
            // for the human-readable log line below.
            prunedBytes += entry.endsWith('.png') ? 95_000 : 30_000;
          } catch {
            /* ignore — best-effort cleanup */
          }
        }
      } catch {
        /* cacheRoot doesn't exist (impossible here) — noop */
      }

      const elapsedMs = Date.now() - startMs;
      // eslint-disable-next-line no-console
      console.log(
        `[job-og-images] rendered=${stats.rendered} cached=${stats.cached} skipped=${stats.skipped} errors=${stats.errors} pruned-stale=${pruned} (~${(prunedBytes / 1_048_576).toFixed(0)}MB) in ${(elapsedMs / 1000).toFixed(1)}s`,
      );
    },
  };
}
