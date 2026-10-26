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
 * The navy control palette is copied from build-plugins/jobOgImagesPlugin.ts,
 * not imported — that file documents its own palette as "kept inline to
 * avoid coupling the plugin to runtime CSS". The other surfaces live in
 * instagram-carousel-background.mjs because they are an explicit Firebase-
 * controlled experiment, while the renderer keeps typography and safe-area
 * geometry identical across every arm.
 */

import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  INSTAGRAM_CAROUSEL_SAFE_AREA,
  instagramCarouselBackgroundForId,
} from './instagram-carousel-background.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..', '..');

export const INSTAGRAM_CAROUSEL_CARD_SIZE = 1080;
const CARD_SIZE = INSTAGRAM_CAROUSEL_CARD_SIZE;
const JPEG_QUALITY = 90;

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

function brandFooter(theme) {
  return {
    type: 'div',
    props: {
      style: {
        display: 'flex',
        flexDirection: 'row',
        justifyContent: 'space-between',
        alignItems: 'center',
        borderTop: `2px solid ${theme.footerBorder}`,
        paddingTop: 24,
      },
      children: [
        {
          type: 'div',
          props: {
            style: { fontSize: 26, fontWeight: 700, letterSpacing: 1, color: theme.accent },
            children: 'FRONTALIERE TICINO',
          },
        },
        {
          type: 'div',
          props: {
            style: { fontSize: 24, color: theme.textMuted },
            children: 'frontaliereticino.ch',
          },
        },
      ],
    },
  };
}

function cardShell(children, theme) {
  return {
    type: 'div',
    props: {
      style: {
        width: CARD_SIZE,
        height: CARD_SIZE,
        display: 'flex',
        flexDirection: 'column',
        justifyContent: 'space-between',
        backgroundColor: theme.backgroundColor,
        backgroundImage: theme.backgroundImage,
        color: theme.textPrimary,
        fontFamily: 'Roboto',
        paddingTop: INSTAGRAM_CAROUSEL_SAFE_AREA.insetTop,
        paddingRight: INSTAGRAM_CAROUSEL_SAFE_AREA.insetX,
        paddingBottom: INSTAGRAM_CAROUSEL_SAFE_AREA.insetBottom,
        paddingLeft: INSTAGRAM_CAROUSEL_SAFE_AREA.insetX,
      },
      children,
    },
  };
}

/** Slide 1: kicker ("LA CLASSIFICA DI OGGI"), title, subtitle (date/range). */
function coverTree({ kicker, title, subtitle }, theme) {
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
                color: theme.accent,
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
                  style: { fontSize: 34, color: theme.textMuted, marginTop: 28 },
                  children: subtitle,
                },
              }
            : null,
        ].filter(Boolean),
      },
    },
    brandFooter(theme),
  ], theme);
}

/** Slides 2..N: rank number, item title, one stat line. */
function itemTree({ rank, total, title, statLabel, statValue, footerNote }, theme) {
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
                color: theme.accent,
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
                    backgroundColor: theme.statSurface,
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
                  style: { fontSize: 26, color: theme.textMuted, marginTop: 20 },
                  children: truncate(footerNote, 80),
                },
              }
            : null,
        ].filter(Boolean),
      },
    },
    brandFooter(theme),
  ], theme);
}

/** Final slide: turn the chosen editorial objective into one visible action. */
function closingTree({ kicker, title, body, cta }, theme) {
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
                color: theme.accent,
                marginBottom: 24,
              },
              children: truncate(kicker, 60),
            },
          },
          {
            type: 'div',
            props: {
              style: { fontSize: 64, fontWeight: 700, lineHeight: 1.15 },
              children: truncate(title, 100),
            },
          },
          body
            ? {
                type: 'div',
                props: {
                  style: { fontSize: 32, lineHeight: 1.35, color: theme.textMuted, marginTop: 28 },
                  children: truncate(body, 160),
                },
              }
            : null,
          cta
            ? {
                type: 'div',
                props: {
                  style: {
                    alignSelf: 'flex-start',
                    marginTop: 36,
                    backgroundColor: theme.accent,
                    color: theme.accentText,
                    borderRadius: 18,
                    padding: '18px 28px',
                    fontSize: 30,
                    fontWeight: 700,
                  },
                  children: truncate(cta, 80),
                },
              }
            : null,
        ].filter(Boolean),
      },
    },
    brandFooter(theme),
  ], theme);
}

/**
 * Return the render plan without loading fonts or native image libraries.
 * Keeping this pure makes the creative contract testable in CI and prevents a
 * change to the closing CTA from hiding inside an opaque rendered buffer.
 */
export function buildCarouselSlidePlan({ kicker, title, subtitle, items, closing } = {}) {
  const safeItems = Array.isArray(items) ? items : [];
  const plan = [
    { type: 'cover', kicker, title, subtitle },
    ...safeItems.map((item, i) => ({
      type: 'item',
      rank: i + 1,
      total: safeItems.length,
      title: item?.title,
      statLabel: item?.statLabel,
      statValue: item?.statValue,
      footerNote: item?.footerNote,
    })),
  ];
  if (closing) plan.push({ type: 'closing', ...closing });
  return plan;
}

/**
 * Render a cover slide + up to `items.length` ranked-item slides as JPEG
 * buffers, cover first. Returns null (never throws) when fonts are missing —
 * callers must treat that as "skip the image, log and move on" the same way
 * every other soft-fail in this codebase's social posters works.
 *
 * @param {{ kicker: string, title: string, subtitle?: string, items: Array<{title:string, statLabel?:string, statValue?:string, footerNote?:string}>, closing?: {kicker:string, title:string, body?:string, cta?:string}, backgroundVariant?: string }} params
 * @returns {Promise<Buffer[]|null>}
 */
export async function renderCarouselSlides({ kicker, title, subtitle, items, closing, backgroundVariant }) {
  const fonts = readFontPair();
  if (!fonts) return null;
  if (!Array.isArray(items) || items.length === 0) return null;
  const theme = instagramCarouselBackgroundForId(backgroundVariant);

  const [{ default: satori }, { Resvg }, { default: sharp }] = await Promise.all([
    import('satori'),
    import('@resvg/resvg-js'),
    import('sharp'),
  ]);

  const fontConfig = [
    { name: 'Roboto', data: fonts.regular, weight: 400, style: 'normal' },
    { name: 'Roboto', data: fonts.bold, weight: 700, style: 'normal' },
  ];

  const trees = buildCarouselSlidePlan({ kicker, title, subtitle, items, closing }).map((slide) => {
    if (slide.type === 'cover') return coverTree(slide, theme);
    if (slide.type === 'closing') return closingTree(slide, theme);
    return itemTree(slide, theme);
  });

  const buffers = [];
  for (const tree of trees) {
    const svg = await satori(tree, { width: CARD_SIZE, height: CARD_SIZE, fonts: fontConfig });
    const png = new Resvg(svg, {
      background: theme.backgroundColor,
      fitTo: { mode: 'width', value: CARD_SIZE },
    })
      .render()
      .asPng();
    const jpeg = await sharp(png).flatten({ background: theme.backgroundColor }).jpeg({ quality: JPEG_QUALITY }).toBuffer();
    buffers.push(jpeg);
  }
  return buffers;
}
