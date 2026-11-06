/**
 * Renders the three vertical cards used by the controlled Instagram Reel test.
 * This deliberately has a different 1080×1920 composition from the square
 * carousel: the hook gets the first screen, the data gets one screen, and the
 * final screen asks for one measurable action.
 */

import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..', '..');

export const REEL_WIDTH = 1080;
export const REEL_HEIGHT = 1920;
const JPEG_QUALITY = 90;
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
  const value = String(text || '');
  if (value.length <= maxChars) return value;
  const cut = value.slice(0, maxChars);
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
        paddingTop: 28,
      },
      children: [
        { type: 'div', props: { style: { fontSize: 26, fontWeight: 700, letterSpacing: 1, color: BRAND_ACCENT }, children: 'FRONTALIERE TICINO' } },
        { type: 'div', props: { style: { fontSize: 24, color: TEXT_MUTED }, children: 'frontaliereticino.ch' } },
      ],
    },
  };
}

function reelShell(children) {
  return {
    type: 'div',
    props: {
      style: {
        width: REEL_WIDTH,
        height: REEL_HEIGHT,
        display: 'flex',
        flexDirection: 'column',
        justifyContent: 'space-between',
        backgroundImage: `linear-gradient(155deg, ${BRAND_BG_FROM} 0%, ${BRAND_BG_TO} 100%)`,
        color: TEXT_PRIMARY,
        fontFamily: 'Roboto',
        padding: 72,
      },
      children,
    },
  };
}

function slideTree(slide) {
  const isCta = slide?.type === 'cta';
  return reelShell([
    {
      type: 'div',
      props: {
        style: { display: 'flex', flexDirection: 'column', flex: 1, justifyContent: 'center' },
        children: [
          {
            type: 'div',
            props: {
              style: { fontSize: 34, fontWeight: 700, letterSpacing: 2, color: BRAND_ACCENT, marginBottom: 34 },
              children: truncate(slide?.kicker, 60),
            },
          },
          {
            type: 'div',
            props: {
              style: { fontSize: isCta ? 58 : 72, fontWeight: 700, lineHeight: 1.14 },
              children: truncate(slide?.title, isCta ? 130 : 90),
            },
          },
          slide?.body
            ? {
                type: 'div',
                props: {
                  style: { fontSize: 36, lineHeight: 1.35, color: TEXT_MUTED, marginTop: 42 },
                  children: truncate(slide.body, 190),
                },
              }
            : null,
          slide?.cta
            ? {
                type: 'div',
                props: {
                  style: {
                    alignSelf: 'flex-start',
                    marginTop: 48,
                    backgroundColor: BRAND_ACCENT,
                    color: BRAND_BG_FROM,
                    borderRadius: 18,
                    padding: '20px 30px',
                    fontSize: 32,
                    fontWeight: 700,
                  },
                  children: truncate(slide.cta, 80),
                },
              }
            : null,
        ].filter(Boolean),
      },
    },
    brandFooter(),
  ]);
}

/** Pure plan used by tests before fonts/native rendering are involved. */
export function buildReelSlidePlan({ slides } = {}) {
  return (Array.isArray(slides) ? slides : []).map((slide) => ({
    type: slide?.type,
    kicker: slide?.kicker,
    title: slide?.title,
    body: slide?.body,
    cta: slide?.cta,
  }));
}

/**
 * Render exactly the supplied vertical cards as JPEG buffers. Missing fonts
 * return null, matching the social carousel's fail-soft contract.
 */
export async function renderReelSlides({ slides } = {}) {
  const plan = buildReelSlidePlan({ slides });
  if (plan.length !== 3) return null;
  const fonts = readFontPair();
  if (!fonts) return null;

  const [{ default: satori }, { Resvg }, { default: sharp }] = await Promise.all([
    import('satori'),
    import('@resvg/resvg-js'),
    import('sharp'),
  ]);
  const fontConfig = [
    { name: 'Roboto', data: fonts.regular, weight: 400, style: 'normal' },
    { name: 'Roboto', data: fonts.bold, weight: 700, style: 'normal' },
  ];
  const buffers = [];
  for (const slide of plan) {
    const svg = await satori(slideTree(slide), { width: REEL_WIDTH, height: REEL_HEIGHT, fonts: fontConfig });
    const png = new Resvg(svg, {
      background: BRAND_BG_FROM,
      fitTo: { mode: 'width', value: REEL_WIDTH },
    }).render().asPng();
    buffers.push(await sharp(png).flatten({ background: BRAND_BG_FROM }).jpeg({ quality: JPEG_QUALITY }).toBuffer());
  }
  return buffers;
}
