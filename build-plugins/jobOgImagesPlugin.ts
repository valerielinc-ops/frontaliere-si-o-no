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

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import path from 'path';
import type { Plugin } from 'vite';
import satori from 'satori';
import { Resvg } from '@resvg/resvg-js';

const OUT_SUBDIR = 'og/jobs';
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
      mkdirSync(outRoot, { recursive: true });

      const fonts = [
        { name: 'Roboto', data: fontPair.regular, weight: 400 as const, style: 'normal' as const },
        { name: 'Roboto', data: fontPair.bold, weight: 700 as const, style: 'normal' as const },
      ];

      const stats: Stats = { rendered: 0, cached: 0, skipped: 0, errors: 0 };
      const startMs = Date.now();

      for (const job of jobs) {
        const slug = deriveSlug(job);
        if (!slug || !job?.title) {
          stats.skipped += 1;
          continue;
        }
        const outPath = path.join(rootDir, outDir, ogPathForSlug(slug));
        if (existsSync(outPath)) {
          stats.cached += 1;
          continue;
        }
        try {
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
          const tree = buildCardJsx(model);
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const svg = await satori(tree as any, {
            width: PNG_WIDTH,
            height: PNG_HEIGHT,
            fonts,
          });
          const png = new Resvg(svg, {
            background: BRAND_BG_FROM,
            fitTo: { mode: 'width', value: PNG_WIDTH },
          })
            .render()
            .asPng();
          mkdirSync(path.dirname(outPath), { recursive: true });
          writeFileSync(outPath, png);
          stats.rendered += 1;
        } catch (err) {
          stats.errors += 1;
          if (stats.errors <= 5) {
            // eslint-disable-next-line no-console
            console.warn(
              `[job-og-images] render failed for ${slug}: ${(err as Error).message}`,
            );
          }
        }
      }
      const elapsedMs = Date.now() - startMs;
      // eslint-disable-next-line no-console
      console.log(
        `[job-og-images] rendered=${stats.rendered} cached=${stats.cached} skipped=${stats.skipped} errors=${stats.errors} in ${(elapsedMs / 1000).toFixed(1)}s`,
      );
    },
  };
}
