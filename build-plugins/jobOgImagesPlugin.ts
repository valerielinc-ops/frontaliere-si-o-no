/**
 * Generates per-job Open Graph images (1080×1350 WebP) for every job in
 * `data/jobs.json`. Output is written to `dist/og/jobs/<slug>.webp` and
 * referenced by `og:image` on the corresponding job page (see
 * jobsSeoPagesPlugin → jobOgImageUrl).
 *
 * Why per-job: Facebook/LinkedIn previews show a single OG card per link.
 * A generic site-wide image yields zero context (just the brand). A per-job
 * image with a generated workplace photo, title, employer identity, city, and
 * salary gives people more context when a role is shared on Facebook or LinkedIn.
 *
 * Performance: satori (HTML/JSX → SVG) + @resvg/resvg-js (SVG → PNG) +
 * sharp (PNG → WebP q72) render cards through a bounded worker pool.
 * Skipped under FAST_BUILD=1 (gating happens in vite.config.ts).
 *
 * Why WebP: quality 72 + effort 6 keeps photo detail while limiting the
 * storage cost of thousands of generated cards. Facebook receives a portrait
 * 4:5 image; other preview clients can crop it as needed.
 *
 * Caching: filenames include the job slug, selected photo, employer-logo
 * fingerprint, and render version. To force regeneration, bump OG_RENDER_VERSION.
 */

import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'fs';
import { cpus } from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import { readJsonFile } from '../scripts/lib/read-large-json.mjs';
import { DatasetReadError, jobsFromParsedDataset } from './shared/readJobsDatasetStrict';
import { peelDanglingClauseTail } from './shared/clauseTail.mjs';
import { Worker } from 'worker_threads';
import type { Plugin } from 'vite';
import { shouldEmitLocale } from './shared/localeEmitFilter';
import { JOB_OG_PHOTO_FILES } from './shared/jobOgImageCatalog.mjs';
import {
  companyLogoFingerprint,
  readCompanyLogosManifest,
} from './shared/jobOgLogoFingerprint.mjs';
import {
  JOB_PHOTO_KEYS,
  selectJobOgPhoto,
  type JobFallbackPhotoKey,
} from './shared/jobPhotoClassification';
import { getItalianJobTitle } from './shared/italianJobTitle.mjs';
import { JOB_EMPLOYMENT_LABELS_BY_LOCALE } from '../scripts/lib/job-employment-type.mjs';
import {
  ARCHIVED_JOB_OG_IMAGE_VERSION,
  JOB_OG_IMAGE_VERSION,
  versionedJobOgImageUrl,
} from './shared/jobOgImageVersion.mjs';
import {
  JOB_OG_DEFERRED_FALLBACKS,
  JOB_OG_DEFERRED_R2_MANIFEST,
  cacheEntryBelongsToSlugs,
  isJobOgRenderBudgetSpent,
  parseJobOgRenderBudgetMs,
  sortJobsForOgRender,
} from './shared/jobOgRenderBudget.mjs';

const OUT_SUBDIR = 'og/jobs';
// Persistent cache dir survives `dist/` cleanup. Cache step in deploy.yml
// restores this between CI runs so unchanged jobs keep their WebP.
const CACHE_SUBDIR = '.cache/og-jobs';
const CACHE_COMPLETION_MARKER = '.complete';

function writeFileAtomicallySync(filePath: string, data: Buffer | string): void {
  const temporaryPath = `${filePath}.tmp-${process.pid}`;
  try {
    writeFileSync(temporaryPath, data);
    renameSync(temporaryPath, filePath);
  } catch (err) {
    try {
      unlinkSync(temporaryPath);
    } catch {
      /* best-effort cleanup after a failed write */
    }
    throw err;
  }
}

/**
 * Bump this string when the rendering pipeline changes shape (layout,
 * colors, photo treatment, fonts, CTA, dimensions, …). Embedded into every
 * cached WebP's filename so layout-only changes invalidate the cache
 * cleanly even when the actions/cache restore-keys cascade rehydrates
 * an older cache layer. Same pattern used by pdfWhitepapersPlugin
 * (PDF_RENDER_VERSION).
 *
 * Cache filename is `<slug>.<photoKey>.<logoFingerprint>.<OG_RENDER_VERSION>.webp`.
 * When this version bumps, the new build looks for new filenames, doesn't find
 * them, and re-renders. Old cached files become orphaned and age out
 * automatically when the GitHub Actions cache evicts them (~7-day TTL).
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

export interface JobMinimal {
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
  datePosted?: string;
  postedDate?: string;
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
      const parsed = readJsonFile(c) as unknown;
      return jobsFromParsedDataset<JobMinimal>(parsed, 'job-og-images', c);
    } catch (err) {
      if (err instanceof DatasetReadError) throw err;
      // Fail closed: "no jobs" here skips every OG image while the job pages
      // still point og:image at the files that were never written.
      throw new DatasetReadError('job-og-images', c, err);
    }
  }
  return [];
}

function readJobPopularity(rootDir: string): Record<string, number> {
  try {
    const parsed = JSON.parse(
      readFileSync(path.join(rootDir, 'data/job-popularity.json'), 'utf-8'),
    ) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    return Object.fromEntries(
      Object.entries(parsed).filter((entry): entry is [string, number] =>
        typeof entry[1] === 'number' && Number.isFinite(entry[1]) && entry[1] > 0,
      ),
    );
  } catch {
    // The popularity export is optional; datePosted remains the deterministic fallback.
    return {};
  }
}

interface CompanyLogoAsset {
  dataUrl: string | null;
  cacheKey: string;
}

function companyLogoAsset(
  rootDir: string,
  manifestPath: string | undefined,
  cache: Map<string, CompanyLogoAsset>,
): CompanyLogoAsset {
  if (!manifestPath || !manifestPath.startsWith('/images/brands/')) {
    return { dataUrl: null, cacheKey: 'no-logo' };
  }
  const cached = cache.get(manifestPath);
  if (cached) return cached;

  let dataUrl: string | null = null;
  let imageBytes: Buffer | null = null;
  const relativePath = manifestPath.slice('/images/brands/'.length);
  if (!relativePath.includes('..')) {
    const abs = path.join(rootDir, 'public/images/brands', relativePath);
    if (existsSync(abs)) {
      try {
        const ext = path.extname(abs).toLowerCase();
        const mimeByExtension: Record<string, string> = {
          '.png': 'image/png',
          '.jpg': 'image/jpeg',
          '.jpeg': 'image/jpeg',
          '.svg': 'image/svg+xml',
          '.webp': 'image/webp',
        };
        const mime = mimeByExtension[ext];
        const image = readFileSync(abs);
        imageBytes = image;
        if (mime) {
          // Keep unusually large source logos from bloating the render queue.
          if (image.length > 0 && image.length <= 1024 * 1024) {
            dataUrl = `data:${mime};base64,${image.toString('base64')}`;
          }
        }
      } catch {
        /* a missing or unreadable logo falls back to the employer name */
      }
    }
  }

  const cacheKey = companyLogoFingerprint(manifestPath, imageBytes);
  const result = { dataUrl, cacheKey };
  cache.set(manifestPath, result);
  return result;
}

type JobPhotoKey = string;

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

const EMPLOYMENT_LABEL_IT: Record<string, string> = JOB_EMPLOYMENT_LABELS_BY_LOCALE.it;

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
  kicker?: string;
  title: string;
  subtitle?: string;
  company: string | null;
  companyLogoDataUrl: string | null;
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

  const employerRow = model.company
    ? {
        type: 'div',
        props: {
          style: {
            display: 'flex',
            flexDirection: 'row',
            alignItems: 'center',
            marginTop: 8,
          },
          children: [
            model.companyLogoDataUrl
              ? {
                  type: 'div',
                  props: {
                    style: {
                      display: 'flex',
                      width: 92,
                      height: 92,
                      flexShrink: 0,
                      alignItems: 'center',
                      justifyContent: 'center',
                      backgroundColor: '#FFFFFF',
                      borderRadius: 14,
                      padding: 10,
                      marginRight: 20,
                    },
                    children: {
                      type: 'img',
                      props: {
                        src: model.companyLogoDataUrl,
                        width: 72,
                        height: 72,
                        style: { objectFit: 'contain' },
                      },
                    },
                  },
                }
              : null,
            {
              type: 'div',
              props: {
                style: {
                  display: 'flex',
                  maxWidth: 760,
                  fontSize: 34,
                  lineHeight: 1.08,
                  fontWeight: 700,
                  color: TEXT_PRIMARY,
                },
                children: truncateText(model.company, 46),
              },
            },
          ].filter(Boolean),
        },
      }
    : null;

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
                    model.kicker
                      ? {
                          type: 'div',
                          props: {
                            style: {
                              display: 'flex',
                              fontSize: 48,
                              fontWeight: 700,
                              letterSpacing: 1.5,
                              color: BRAND_ACCENT,
                              marginBottom: 12,
                            },
                            children: model.kicker,
                          },
                        }
                      : null,
                    employerRow,
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
 * The cache filename uses `slug` + `photoKey` + employer-logo fingerprint +
 * `OG_RENDER_VERSION`.
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
 * - The employer-logo fingerprint changes when its path or bytes change,
 *   so a corrected or replaced logo also gets a fresh raster.
 *
 * Coverage gap: salary and employment-type edits DON'T change the slug
 * or photo key. Empirically <0.5 %/week of jobs (mostly translation
 * refinements) — accepted in exchange for simpler code and no separate
 * visual-hash maintenance.
 *
 * Cache filename: `<slug>.<photoKey>.<logoFingerprint>.<OG_RENDER_VERSION>.webp`
 *
 * slug + photo + design stable → same filename → cache hit
 * title/company/city edit → new slug      → re-render
 * logo path/asset change  → new fingerprint → re-render
 * design bump             → new version   → re-render
 *
 * Old cache entries (orphaned slugs) age out automatically via the
 * GitHub Actions cache TTL (~7 days).
 */

export function jobOgImageUrl(
  baseUrl: string,
  slug: string | null,
  logoFingerprint?: string,
): string | null {
  return versionedJobOgImageUrl(baseUrl, slug, undefined, logoFingerprint);
}

interface Stats {
  rendered: number;
  cached: number;
  skipped: number;
  errors: number;
}

interface RenderContext {
  fontPair: { regular: Buffer; bold: Buffer };
  photoSources: JobPhotoSources;
  companyLogosManifest: Record<string, string>;
  companyLogoCache: Map<string, CompanyLogoAsset>;
  cacheRoot: string;
}

interface JobRenderDescriptor {
  jobId: string;
  slug: string;
  cachePath: string;
  outPath: string | null;
  model: CardModel;
}

interface RenderJob extends Omit<JobRenderDescriptor, 'model'> {
  tree: unknown;
}

interface RenderQueueResult {
  renderedSlugs: Set<string>;
  deferredSlugs: Set<string>;
  errors: number;
}

function resolveRootPath(rootDir: string, candidate: string): string {
  return path.isAbsolute(candidate) ? candidate : path.join(rootDir, candidate);
}

function createRenderContext(rootDir: string, cacheRoot: string): RenderContext | null {
  const fontPair = readFontPair(rootDir);
  if (!fontPair) return null;
  const photoSources = readJobPhotoSources(rootDir);
  if (!photoSources) return null;
  mkdirSync(cacheRoot, { recursive: true });
  return {
    fontPair,
    photoSources,
    companyLogosManifest: readCompanyLogosManifest(rootDir),
    companyLogoCache: new Map<string, CompanyLogoAsset>(),
    cacheRoot,
  };
}

function describeJobForRender(
  rootDir: string,
  job: JobMinimal,
  context: RenderContext,
  outDir: string | null,
): JobRenderDescriptor | null {
  const slug = deriveSlug(job);
  const italianTitle = getItalianJobTitle(job);
  if (!slug || !italianTitle) return null;

  const { photoKey } = selectJobOgPhoto(job, slug);
  const logoPath = job.companyKey
    ? context.companyLogosManifest[job.companyKey]
    : undefined;
  const companyLogo = companyLogoAsset(rootDir, logoPath, context.companyLogoCache);
  const cachePath = path.join(
    context.cacheRoot,
    `${slug}.${photoKey}.${companyLogo.cacheKey}.${OG_RENDER_VERSION}.webp`,
  );
  const outPath = outDir
    ? path.join(outDir, ogPathForSlug(slug))
    : null;

  return {
    jobId: slug,
    slug,
    cachePath,
    outPath,
    model: {
      kicker: 'STIAMO ASSUMENDO',
      title: truncateText(italianTitle, 82),
      company: deriveCompany(job),
      companyLogoDataUrl: companyLogo.dataUrl,
      city: deriveCity(job),
      salary: deriveSalary(job),
      employmentLabel: job.employmentType
        ? EMPLOYMENT_LABEL_IT[job.employmentType] ?? null
        : null,
      photoKey,
    },
  };
}

function describeArchiveCard(
  context: RenderContext,
  outDir: string | null,
): JobRenderDescriptor {
  return {
    jobId: 'archive-landing-card',
    slug: 'archive-landing-card',
    cachePath: path.join(
      context.cacheRoot,
      `archive-landing-card.archive-neutral.${ARCHIVED_JOB_OG_IMAGE_VERSION}.webp`,
    ),
    outPath: outDir ? path.join(outDir, OUT_SUBDIR, 'archive-landing-card.webp') : null,
    model: {
      title: 'ANNUNCIO ARCHIVIATO',
      subtitle: 'Questa posizione non è più disponibile.',
      company: null,
      companyLogoDataUrl: null,
      city: null,
      salary: null,
      employmentLabel: null,
      photoKey: 'archive-neutral',
      ctaLabel: 'CERCA OFFERTE ATTIVE',
    },
  };
}

function renderJob(descriptor: JobRenderDescriptor): RenderJob {
  return { ...descriptor, tree: buildCardJsx(descriptor.model) };
}

function readPublishedR2OgPaths(
  rootDir: string,
  publishTarget: string,
  manifestPath = '.cache/r2-og-published-manifest.json',
): Set<string> {
  if (publishTarget !== 'r2') return new Set();
  try {
    const manifest = JSON.parse(
      readFileSync(resolveRootPath(rootDir, manifestPath), 'utf-8'),
    ) as { version?: unknown; files?: Array<{ path?: unknown }> };
    if (manifest?.version !== 1 || !Array.isArray(manifest.files)) return new Set();
    return new Set(
      manifest.files
        .filter((file) => typeof file?.path === 'string' && /^jobs\/[A-Za-z0-9._-]+\.webp$/.test(file.path))
        .map((file) => file.path as string),
    );
  } catch {
    return new Set();
  }
}

async function renderQueue(
  tasks: RenderJob[],
  context: RenderContext,
  budgetMs: number | null,
): Promise<RenderQueueResult> {
  const result: RenderQueueResult = {
    renderedSlugs: new Set(),
    deferredSlugs: new Set(),
    errors: 0,
  };
  if (tasks.length === 0) return result;

  const workerCount = Math.max(
    1,
    Math.min(
      tasks.length,
      Number(process.env.OG_WORKER_COUNT) || cpus().length || 2,
      4,
    ),
  );
  const here = path.dirname(fileURLToPath(import.meta.url));
  const workerPath = path.join(here, 'og-render-worker.mjs');
  const workerData = {
    fontRegular: context.fontPair.regular,
    fontBold: context.fontPair.bold,
    brandBgFrom: BRAND_BG_FROM,
    photoDataUrls: context.photoSources.fallbackDataUrls,
    photoFilePaths: context.photoSources.specificPhotoPaths,
    width: OG_WIDTH,
    height: OG_HEIGHT,
  };
  const startedAt = Date.now();
  let nextIndex = 0;
  let liveWorkers = 0;
  let budgetStopped = budgetMs !== null && budgetMs <= 0;
  let settled = false;
  const workers = new Set<Worker>();
  const slots = new Map<Worker, { inFlight: RenderJob | null }>();

  const markPendingDeferred = () => {
    while (nextIndex < tasks.length) {
      result.deferredSlugs.add(tasks[nextIndex].slug);
      nextIndex += 1;
    }
  };
  const stopForBudget = () => {
    if (budgetStopped) return;
    budgetStopped = true;
    markPendingDeferred();
    for (const worker of workers) {
      const slot = slots.get(worker);
      if (slot?.inFlight) {
        result.deferredSlugs.add(slot.inFlight.slug);
        slot.inFlight = null;
      }
      void worker.terminate();
    }
  };
  const budgetIsSpent = () => {
    if (budgetMs !== null && isJobOgRenderBudgetSpent(startedAt, budgetMs, Date.now())) {
      stopForBudget();
      return true;
    }
    return budgetStopped;
  };

  await new Promise<void>((resolve) => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    const maybeResolve = () => {
      if (settled || liveWorkers !== 0) return;
      settled = true;
      if (timer !== null) clearTimeout(timer);
      resolve();
    };

    const dispatch = (worker: Worker) => {
      if (budgetIsSpent()) return false;
      if (nextIndex >= tasks.length) {
        worker.postMessage('shutdown');
        return false;
      }
      const job = tasks[nextIndex];
      nextIndex += 1;
      const slot = slots.get(worker);
      if (slot) slot.inFlight = job;
      worker.postMessage({ jobId: job.jobId, tree: job.tree });
      return true;
    };

    const spawnWorker = () => {
      if (budgetIsSpent() || liveWorkers >= workerCount) return;
      const worker = new Worker(workerPath, { workerData });
      workers.add(worker);
      slots.set(worker, { inFlight: null });
      liveWorkers += 1;

      worker.on('message', (message: { jobId: string; ok: true; webp: Buffer } | { jobId: string; ok: false; error: string }) => {
        const slot = slots.get(worker);
        const job = slot?.inFlight;
        if (!job) return;
        if (budgetIsSpent()) return;

        if (!('error' in message)) {
          try {
            mkdirSync(path.dirname(job.cachePath), { recursive: true });
            writeFileAtomicallySync(job.cachePath, message.webp);
            if (job.outPath) {
              mkdirSync(path.dirname(job.outPath), { recursive: true });
              copyFileSync(job.cachePath, job.outPath);
            }
            result.renderedSlugs.add(job.slug);
          } catch (error) {
            result.errors += 1;
            if (result.errors <= 5) {
              // eslint-disable-next-line no-console
              console.warn(`[job-og-images] write failed for ${job.slug}: ${(error as Error).message}`);
            }
          }
        } else {
          result.errors += 1;
          if (result.errors <= 5) {
            // eslint-disable-next-line no-console
            console.warn(`[job-og-images] render failed for ${job.slug}: ${message.error}`);
          }
        }
        slot.inFlight = null;
        dispatch(worker);
      });

      worker.on('error', (error) => {
        result.errors += 1;
        const slot = slots.get(worker);
        if (slot) slot.inFlight = null;
        if (result.errors <= 5) {
          // eslint-disable-next-line no-console
          console.warn(`[job-og-images] worker error: ${error.message}`);
        }
        void worker.terminate();
      });

      worker.on('exit', () => {
        const slot = slots.get(worker);
        if (slot?.inFlight) {
          if (budgetIsSpent()) result.deferredSlugs.add(slot.inFlight.slug);
          else result.errors += 1;
          slot.inFlight = null;
        }
        workers.delete(worker);
        slots.delete(worker);
        liveWorkers -= 1;
        if (!budgetIsSpent() && nextIndex < tasks.length && liveWorkers < workerCount) {
          spawnWorker();
        }
        maybeResolve();
      });

      dispatch(worker);
    };

    timer = budgetMs === null
      ? null
      : setTimeout(stopForBudget, Math.max(0, budgetMs));
    if (!budgetStopped) {
      for (let index = 0; index < workerCount; index += 1) spawnWorker();
    } else {
      markPendingDeferred();
    }
    if (liveWorkers === 0) maybeResolve();
  });

  return result;
}

export function findMissingJobOgImageJobs(
  rootDir: string,
  jobs: JobMinimal[],
  cacheRoot = CACHE_SUBDIR,
): { jobs: JobMinimal[]; archiveMissing: boolean } {
  const absoluteCacheRoot = resolveRootPath(rootDir, cacheRoot);
  const context = createRenderContext(rootDir, absoluteCacheRoot);
  if (!context) throw new Error('Job OG render inputs are incomplete (fonts or photo assets missing).');
  const missing: JobMinimal[] = [];
  for (const job of sortJobsForOgRender(jobs, readJobPopularity(rootDir))) {
    const descriptor = describeJobForRender(rootDir, job, context, null);
    if (descriptor && !existsSync(descriptor.cachePath)) missing.push(job);
  }
  const archiveMissing = !existsSync(describeArchiveCard(context, null).cachePath);
  return { jobs: missing, archiveMissing };
}

export async function renderJobOgImages(
  rootDir: string,
  jobs: JobMinimal[],
  {
    outDir = 'dist',
    cacheRoot = CACHE_SUBDIR,
    budgetMs = null,
    publishTarget = 'pages',
    publishedManifestPath = '.cache/r2-og-published-manifest.json',
    cacheOnly = false,
    includeArchive = true,
    strict = false,
  }: {
    outDir?: string | null;
    cacheRoot?: string;
    budgetMs?: number | null;
    publishTarget?: string;
    publishedManifestPath?: string;
    cacheOnly?: boolean;
    includeArchive?: boolean;
    strict?: boolean;
  } = {},
): Promise<Stats & { deferred: number; hits: number; deferredSlugs: string[] }> {
  const absoluteCacheRoot = resolveRootPath(rootDir, cacheRoot);
  const absoluteOutDir = outDir && !cacheOnly ? resolveRootPath(rootDir, outDir) : null;
  const context = createRenderContext(rootDir, absoluteCacheRoot);
  if (!context) {
    const message = 'Job OG render inputs are incomplete (fonts or photo assets missing).';
    if (strict) throw new Error(message);
    // eslint-disable-next-line no-console
    console.warn(`[job-og-images] ${message}`);
    return { rendered: 0, cached: 0, skipped: jobs.length, errors: 0, deferred: 0, hits: 0, deferredSlugs: [] };
  }

  const stats: Stats = { rendered: 0, cached: 0, skipped: 0, errors: 0 };
  const jobRenderQueue: RenderJob[] = [];
  const orderedJobs = sortJobsForOgRender(jobs, readJobPopularity(rootDir));
  for (const job of orderedJobs) {
    const descriptor = describeJobForRender(rootDir, job, context, absoluteOutDir);
    if (!descriptor) {
      stats.skipped += 1;
      continue;
    }
    if (existsSync(descriptor.cachePath)) {
      try {
        if (descriptor.outPath) {
          mkdirSync(path.dirname(descriptor.outPath), { recursive: true });
          copyFileSync(descriptor.cachePath, descriptor.outPath);
        }
        stats.cached += 1;
      } catch {
        jobRenderQueue.push(renderJob(descriptor));
      }
      continue;
    }
    jobRenderQueue.push(renderJob(descriptor));
  }

  let archiveCardPath: string | null = null;
  if (includeArchive) {
    const archive = describeArchiveCard(context, absoluteOutDir);
    archiveCardPath = archive.outPath;
    if (existsSync(archive.cachePath)) {
      try {
        if (archive.outPath) {
          mkdirSync(path.dirname(archive.outPath), { recursive: true });
          copyFileSync(archive.cachePath, archive.outPath);
        }
        stats.cached += 1;
      } catch {
        const archiveResult = await renderQueue([renderJob(archive)], context, null);
        stats.rendered += archiveResult.renderedSlugs.size;
        stats.errors += archiveResult.errors;
      }
    } else {
      const archiveResult = await renderQueue([renderJob(archive)], context, null);
      stats.rendered += archiveResult.renderedSlugs.size;
      stats.errors += archiveResult.errors;
    }
  }

  if (absoluteOutDir && includeArchive && (!archiveCardPath || !existsSync(archiveCardPath))) {
    throw new Error('Job OG archive card could not be emitted; the build cannot guarantee valid archived-job previews.');
  }

  const queueResult = await renderQueue(jobRenderQueue, context, budgetMs);
  stats.rendered += queueResult.renderedSlugs.size;
  stats.errors += queueResult.errors;
  const succeeded = queueResult.renderedSlugs;
  const unrenderedSlugs = new Set(
    jobRenderQueue.map((job) => job.slug).filter((slug) => !succeeded.has(slug)),
  );
  const publishedR2Paths = readPublishedR2OgPaths(rootDir, publishTarget, publishedManifestPath);
  const preservePublishedSlugs = new Set<string>();
  const fallbackSlugs = new Set<string>();
  for (const slug of unrenderedSlugs) {
    if (publishedR2Paths.has(`jobs/${slug}.webp`)) preservePublishedSlugs.add(slug);
    else fallbackSlugs.add(slug);
  }

  if (absoluteOutDir && fallbackSlugs.size > 0) {
    if (!archiveCardPath || !existsSync(archiveCardPath)) {
      throw new Error('Job OG deferrals require an archive fallback card, but it was not emitted.');
    }
  }

  if (preservePublishedSlugs.size > 0) {
    writeFileAtomicallySync(
      path.join(absoluteCacheRoot, JOB_OG_DEFERRED_R2_MANIFEST),
      `${JSON.stringify([...preservePublishedSlugs].sort())}\n`,
    );
  } else {
    try { unlinkSync(path.join(absoluteCacheRoot, JOB_OG_DEFERRED_R2_MANIFEST)); } catch { /* absent */ }
  }
  if (fallbackSlugs.size > 0) {
    writeFileAtomicallySync(
      path.join(absoluteCacheRoot, JOB_OG_DEFERRED_FALLBACKS),
      `${JSON.stringify([...fallbackSlugs].sort())}\n`,
    );
  } else {
    try { unlinkSync(path.join(absoluteCacheRoot, JOB_OG_DEFERRED_FALLBACKS)); } catch { /* absent */ }
  }

  // A legacy cache restored under the current prefix can contain old versions.
  // If any current job is still missing, retain its cache entries so a later
  // run can recover them; prune only entries we can prove belong to other jobs.
  let pruned = 0;
  let prunedBytes = 0;
  const protectedSlugs = unrenderedSlugs;
  try {
    for (const entry of readdirSync(absoluteCacheRoot)) {
      if (/\.tmp-\d+$/.test(entry)) {
        try { unlinkSync(path.join(absoluteCacheRoot, entry)); } catch { /* best effort */ }
        continue;
      }
      const versionSuffixes = [
        `.${OG_RENDER_VERSION}.webp`,
        `.${ARCHIVED_JOB_OG_IMAGE_VERSION}.webp`,
      ];
      if (versionSuffixes.some((suffix) => entry.endsWith(suffix))) continue;
      if (!entry.endsWith('.png') && !entry.endsWith('.webp')) continue;
      if (cacheEntryBelongsToSlugs(entry, protectedSlugs)) continue;
      try {
        unlinkSync(path.join(absoluteCacheRoot, entry));
        pruned += 1;
        prunedBytes += entry.endsWith('.png') ? 95_000 : 30_000;
      } catch {
        /* best-effort cleanup */
      }
    }
  } catch {
    /* cacheRoot doesn't exist — noop */
  }

  const deferredSlugs = [...queueResult.deferredSlugs].sort();
  const budgetLabel = budgetMs === null ? 'unlimited' : `${Math.floor(budgetMs / 1000)}s`;
  const jobHits = orderedJobs.length - stats.skipped - jobRenderQueue.length;
  // eslint-disable-next-line no-console
  console.log(`[job-og-images] budget=${budgetLabel} rendered=${queueResult.renderedSlugs.size} deferred=${deferredSlugs.length} hits=${jobHits}`);
  if (deferredSlugs.length > 0) {
    // eslint-disable-next-line no-console
    console.warn(`::warning::[job-og-images] ${deferredSlugs.length} active job card(s) deferred; the next build/prewarm will continue the cache fill`);
  }
  // eslint-disable-next-line no-console
  console.log(
    `[job-og-images] rendered=${stats.rendered} cached=${stats.cached} skipped=${stats.skipped} errors=${stats.errors} pruned-stale=${pruned} (~${(prunedBytes / 1_048_576).toFixed(0)}MB)`,
  );
  if (stats.rendered + stats.cached > 0 && !cacheOnly) {
    writeFileAtomicallySync(
      path.join(absoluteCacheRoot, CACHE_COMPLETION_MARKER),
      `${JSON.stringify({ rendered: stats.rendered, cached: stats.cached, skipped: stats.skipped, errors: stats.errors, deferred: deferredSlugs.length })}\n`,
    );
  }
  if (strict && (stats.errors > 0 || queueResult.deferredSlugs.size > 0)) {
    throw new Error(
      `Job OG cache render incomplete: ${stats.errors} error(s), ${queueResult.deferredSlugs.size} deferred card(s).`,
    );
  }
  return {
    ...stats,
    deferred: deferredSlugs.length,
    hits: jobHits,
    deferredSlugs,
  };
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
      // A restored marker only describes the previous build. Remove it before
      // the new build so the workflow saves a cache only after this plugin has
      // finished processing the current image set.
      try {
        unlinkSync(path.join(rootDir, CACHE_SUBDIR, CACHE_COMPLETION_MARKER));
      } catch {
        /* marker absent on a cold cache */
      }
      for (const metadataFile of [JOB_OG_DEFERRED_R2_MANIFEST, JOB_OG_DEFERRED_FALLBACKS]) {
        try {
          unlinkSync(path.join(rootDir, CACHE_SUBDIR, metadataFile));
        } catch {
          /* metadata belongs to the prior build */
        }
      }
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
      const jobs = readJobsJson(rootDir);
      if (jobs.length === 0) {
        // eslint-disable-next-line no-console
        console.warn('[job-og-images] no jobs in jobs.json — skipping.');
        return;
      }
      const budgetMs = parseJobOgRenderBudgetMs(process.env.JOB_OG_RENDER_BUDGET_S);
      if (process.env.JOB_OG_RENDER_BUDGET_S && budgetMs === 0) {
        const seconds = Number(process.env.JOB_OG_RENDER_BUDGET_S);
        if (!Number.isFinite(seconds) || seconds < 0) {
          // eslint-disable-next-line no-console
          console.warn('[job-og-images] invalid JOB_OG_RENDER_BUDGET_S; using a zero-second render budget.');
        }
      }
      await renderJobOgImages(rootDir, jobs, {
        outDir,
        budgetMs,
        publishTarget: process.env.JOB_OG_PUBLISH_TARGET || 'pages',
      });
    },
  };
}
