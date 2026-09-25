/**
 * Renders the square (1080×1080) carousel cards Instagram/TikTok posting
 * needs. Neither channel will unfurl a link the way Facebook/LinkedIn/
 * Telegram do — a post there is a caption plus an image, always — so this is
 * the one genuinely new piece the other four channels never required.
 *
 * Same render pipeline as build-plugins/og-render-worker.mjs (satori → SVG →
 * @resvg/resvg-js → PNG), minus the worker pool: that plugin renders
 * thousands of job cards at build time and needs to parallelize; this script
 * renders at most ~6 slides per run (a cover + up to 5 ranked items), cheap
 * enough to do inline on the main thread.
 *
 * Output is JPEG, not the OG plugin's WebP: TikTok's Content Posting API
 * photo endpoint accepts only JPEG/WEBP (PNG is rejected), and JPEG is the
 * safer common denominator across both platforms' upload paths.
 *
 * Brand palette values are copied from build-plugins/jobOgImagesPlugin.ts,
 * not imported — that file documents its own palette as "kept inline to
 * avoid coupling the plugin to runtime CSS", and scripts/lib/
 * border-wait-ranking-content.mjs sets the precedent for this codebase of
 * deliberately duplicating a small, stable constant across a module boundary
 * rather than manufacturing a dependency on a Vite build plugin from a cron
 * script. Keep these in sync by eye if the brand palette ever changes.
 */

import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..', '..');

const CARD_SIZE = 1080;
const JPEG_QUALITY = 90;

// Copied from build-plugins/jobOgImagesPlugin.ts — see header comment.
const BRAND_BG_FROM = '#0F2557';
const BRAND_BG_TO = '#1E3D8F';
const BRAND_ACCENT = '#FFB300';
const TEXT_PRIMARY = '#FFFFFF';
const TEXT_MUTED = 'rgba(255,255,255,0.78)';

function readFontPair() {
  const regularPath = path.join(ROOT, 'public/fonts/Roboto-Regular.ttf');
  const boldPath = path.join(ROOT, 'public/fonts/Roboto-Bold.ttf');
  if (!existsSync(regularPath) || !existsSync(boldPath)) return null;
  try {
    return { regular: readFileSync(regularPath), bold: readFileSync(boldPath) };
  } catch {
    return null;
  }
}

function truncate(text, maxChars) {
  const s = String(text || '');
  if (s.length <= maxChars) return s;
  const cut = s.slice(0, maxChars);
  const lastSpace = cut.lastIndexOf(' ');
  return `${(lastSpace > maxChars * 0.6 ? cut.slice(0, lastSpace) : cut).trim()}…`;
}

function brandFooter() {
  return {
    type: 'div',
    props: {
      style: {
        display: 'flex',
        flexDirection: 'row',
        justifyContent: 'space-between',
        alignItems: 'center',
        borderTop: '2px solid rgba(255,255,255,0.18)',
        paddingTop: 24,
      },
      children: [
        {
          type: 'div',
          props: {
            style: { fontSize: 26, fontWeight: 700, letterSpacing: 1, color: BRAND_ACCENT },
            children: 'FRONTALIERE TICINO',
          },
        },
        {
          type: 'div',
          props: {
            style: { fontSize: 24, color: TEXT_MUTED },
            children: 'frontaliereticino.ch',
          },
        },
      ],
    },
  };
}

function cardShell(children) {
  return {
    type: 'div',
    props: {
      style: {
        width: CARD_SIZE,
        height: CARD_SIZE,
        display: 'flex',
        flexDirection: 'column',
        justifyContent: 'space-between',
        backgroundImage: `linear-gradient(135deg, ${BRAND_BG_FROM} 0%, ${BRAND_BG_TO} 100%)`,
        color: TEXT_PRIMARY,
        fontFamily: 'Roboto',
        padding: 64,
      },
      children,
    },
  };
}

/** Slide 1: kicker ("LA CLASSIFICA DI OGGI"), title, subtitle (date/range). */
function coverTree({ kicker, title, subtitle }) {
  return cardShell([
    {
      type: 'div',
      props: {
        style: { display: 'flex', flexDirection: 'column', flex: 1, justifyContent: 'center' },
        children: [
          {
            type: 'div',
            props: {
              style: {
                fontSize: 32,
                fontWeight: 700,
                letterSpacing: 2,
                color: BRAND_ACCENT,
                marginBottom: 24,
              },
              children: kicker,
            },
          },
          {
            type: 'div',
            props: {
              style: { fontSize: 72, fontWeight: 700, lineHeight: 1.15 },
              children: truncate(title, 90),
            },
          },
          subtitle
            ? {
                type: 'div',
                props: {
                  style: { fontSize: 34, color: TEXT_MUTED, marginTop: 28 },
                  children: subtitle,
                },
              }
            : null,
        ].filter(Boolean),
      },
    },
    brandFooter(),
  ]);
}

/** Slides 2..N: rank number, item title, one stat line. */
function itemTree({ rank, total, title, statLabel, statValue, footerNote }) {
  return cardShell([
    {
      type: 'div',
      props: {
        style: { display: 'flex', flexDirection: 'column', flex: 1, justifyContent: 'center' },
        children: [
          {
            type: 'div',
            props: {
              style: {
                display: 'flex',
                alignItems: 'baseline',
                fontSize: 40,
                fontWeight: 700,
                color: BRAND_ACCENT,
                marginBottom: 28,
              },
              children: `#${rank}${total ? ` / ${total}` : ''}`,
            },
          },
          {
            type: 'div',
            props: {
              style: { fontSize: 58, fontWeight: 700, lineHeight: 1.2 },
              children: truncate(title, 110),
            },
          },
          statValue
            ? {
                type: 'div',
                props: {
                  style: {
                    display: 'flex',
                    // Not `width: 'fit-content'` — satori (unlike a browser)
                    // rejects that value and silently falls back. flex-start
                    // on the cross axis achieves the same "hug content"
                    // sizing without relying on an unsupported CSS value.
                    alignSelf: 'flex-start',
                    marginTop: 36,
                    backgroundColor: 'rgba(255,255,255,0.14)',
                    borderRadius: 20,
                    padding: '18px 28px',
                    fontSize: 32,
                    fontWeight: 600,
                  },
                  children: statLabel ? `${statLabel}: ${statValue}` : statValue,
                },
              }
            : null,
          footerNote
            ? {
                type: 'div',
                props: {
                  style: { fontSize: 26, color: TEXT_MUTED, marginTop: 20 },
                  children: truncate(footerNote, 80),
                },
              }
            : null,
        ].filter(Boolean),
      },
    },
    brandFooter(),
  ]);
}

/**
 * Render a cover slide + up to `items.length` ranked-item slides as JPEG
 * buffers, cover first. Returns null (never throws) when fonts are missing —
 * callers must treat that as "skip the image, log and move on" the same way
 * every other soft-fail in this codebase's social posters works.
 *
 * @param {{ kicker: string, title: string, subtitle?: string, items: Array<{title:string, statLabel?:string, statValue?:string, footerNote?:string}> }} params
 * @returns {Promise<Buffer[]|null>}
 */
export async function renderCarouselSlides({ kicker, title, subtitle, items }) {
  const fonts = readFontPair();
  if (!fonts) return null;
  if (!Array.isArray(items) || items.length === 0) return null;

  const [{ default: satori }, { Resvg }, { default: sharp }] = await Promise.all([
    import('satori'),
    import('@resvg/resvg-js'),
    import('sharp'),
  ]);

  const fontConfig = [
    { name: 'Roboto', data: fonts.regular, weight: 400, style: 'normal' },
    { name: 'Roboto', data: fonts.bold, weight: 700, style: 'normal' },
  ];

  const trees = [
    coverTree({ kicker, title, subtitle }),
    ...items.map((item, i) =>
      itemTree({
        rank: i + 1,
        total: items.length,
        title: item.title,
        statLabel: item.statLabel,
        statValue: item.statValue,
        footerNote: item.footerNote,
      }),
    ),
  ];

  const buffers = [];
  for (const tree of trees) {
    const svg = await satori(tree, { width: CARD_SIZE, height: CARD_SIZE, fonts: fontConfig });
    const png = new Resvg(svg, {
      background: BRAND_BG_FROM,
      fitTo: { mode: 'width', value: CARD_SIZE },
    })
      .render()
      .asPng();
    const jpeg = await sharp(png).flatten({ background: BRAND_BG_FROM }).jpeg({ quality: JPEG_QUALITY }).toBuffer();
    buffers.push(jpeg);
  }
  return buffers;
}
