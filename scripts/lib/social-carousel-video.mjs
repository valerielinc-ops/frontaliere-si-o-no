/**
 * Builds the TikTok robot transport video from the same JPEG carousel slides
 * the API path receives. The API publish path never invokes this renderer: the
 * video is prepared only when the poster may need the Playwright queue.
 */
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

export const TIKTOK_VIDEO_WIDTH = 1080;
export const TIKTOK_VIDEO_HEIGHT = 1920;
export const TIKTOK_VIDEO_FPS = 30;
export const TIKTOK_SLIDE_DURATION_MS = 4_000;
export const TIKTOK_SLIDE_DURATION_SECONDS = TIKTOK_SLIDE_DURATION_MS / 1000;
export const TIKTOK_CROSSFADE_DURATION_MS = 250;
export const TIKTOK_CROSSFADE_DURATION_SECONDS = TIKTOK_CROSSFADE_DURATION_MS / 1000;
export const TIKTOK_MOTION_TRANSITION_MS = 350;
export const TIKTOK_MOTION_TRANSITION_SECONDS = TIKTOK_MOTION_TRANSITION_MS / 1000;
export const BRAND_VIDEO_BACKGROUND = '0x0F2557';
export const BRAND_VIDEO_ACCENT = '0xFFB300';
export const BRAND_VIDEO_BLUE = '0x1E3D8F';
export const TIKTOK_VIDEO_CONTENT_TYPE = 'video/mp4';

const SILENT_AUDIO_INPUT = 'anullsrc=channel_layout=stereo:sample_rate=44100';

function slideFilter(index) {
  return `[${index}:v]scale=${TIKTOK_VIDEO_WIDTH}:${TIKTOK_VIDEO_HEIGHT}:force_original_aspect_ratio=decrease:in_range=full:out_range=tv,pad=${TIKTOK_VIDEO_WIDTH}:${TIKTOK_VIDEO_HEIGHT}:(ow-iw)/2:(oh-ih)/2:color=${BRAND_VIDEO_BACKGROUND},setsar=1,fps=${TIKTOK_VIDEO_FPS},format=yuv420p,setrange=tv,settb=1/${TIKTOK_VIDEO_FPS}[v${index}]`;
}

/**
 * Compose a square card over an animated vertical stage. The source cards
 * stay readable, while the moving shapes, card drift and wipe transitions
 * make this a genuine motion-graphic treatment rather than a stack of static
 * slides. The expressions use only ffmpeg filters available on the CI and Mac
 * toolchains; no external footage or music is downloaded.
 */
function motionSlideFilter(index) {
  const phase = (index * 0.77).toFixed(2);
  return [
    `[${index}:v]fps=${TIKTOK_VIDEO_FPS},scale=900:900:force_original_aspect_ratio=decrease,format=rgba,pad=900:900:(ow-iw)/2:(oh-ih)/2:color=${BRAND_VIDEO_BACKGROUND}[card${index}]`,
    `color=c=${BRAND_VIDEO_BACKGROUND}:s=${TIKTOK_VIDEO_WIDTH}x${TIKTOK_VIDEO_HEIGHT}:r=${TIKTOK_VIDEO_FPS}:d=${TIKTOK_SLIDE_DURATION_SECONDS},format=rgba,drawbox=x=60:y=60:w=960:h=1800:color=0xFFFFFF@0.12:t=4,drawbox=x=78:y=498:w=924:h=924:color=0x000000@0.42:t=fill,drawbox=x='-200+180*t':y='180+100*sin(t*0.8+${phase})':w=360:h=360:color=${BRAND_VIDEO_ACCENT}@0.28:t=fill,drawbox=x='780-140*t':y='1200+80*cos(t*0.7+${phase})':w=420:h=420:color=${BRAND_VIDEO_BLUE}@0.78:t=fill,drawbox=x=72:y=1760:w='max(1,936*t/${TIKTOK_SLIDE_DURATION_SECONDS})':h=10:color=${BRAND_VIDEO_ACCENT}@0.95:t=fill[stage${index}]`,
    `[stage${index}][card${index}]overlay=x='90+18*sin(t*1.1+${phase})':y='510+18*cos(t*0.9+${phase})':eval=frame:shortest=1,format=yuv420p,setrange=tv,settb=1/${TIKTOK_VIDEO_FPS}[m${index}]`,
  ].join(';');
}

function inputArgs(inputPaths) {
  const args = [];
  for (const inputPath of inputPaths) {
    args.push('-loop', '1', '-t', String(TIKTOK_SLIDE_DURATION_SECONDS), '-i', String(inputPath));
  }
  return args;
}

function addTransitions(filters, slideCount, { transition, duration }) {
  let current = transition === 'wipe' ? 'm0' : 'v0';
  for (let index = 1; index < slideCount; index += 1) {
    const output = `${transition}x${index}`;
    const offset = (index * (TIKTOK_SLIDE_DURATION_SECONDS - duration)).toFixed(3);
    filters.push(`[${current}][${transition === 'wipe' ? `m${index}` : `v${index}`}]xfade=transition=${transition === 'wipe' ? 'wipeleft' : 'fade'}:duration=${duration}:offset=${offset}[${output}]`);
    current = output;
  }
  return current;
}

/**
 * Build the ffmpeg invocation without running it. Keeping this pure makes
 * the output format and the slide timing reviewable without a media binary.
 *
 * @param {string[]} inputPaths
 * @param {string} outputPath
 * @returns {string[]}
 */
export function buildCarouselVideoFfmpegArgs(inputPaths, outputPath) {
  if (!Array.isArray(inputPaths) || inputPaths.length === 0) throw new Error('a TikTok video needs at least one slide');
  if (!String(outputPath || '').trim()) throw new Error('a TikTok video needs an output path');

  const args = ['-hide_banner', '-loglevel', 'error', '-y'];
  args.push(...inputArgs(inputPaths));

  const audioIndex = inputPaths.length;
  const filters = inputPaths.map((_, index) => slideFilter(index));
  const current = addTransitions(filters, inputPaths.length, {
    transition: 'fade',
    duration: TIKTOK_CROSSFADE_DURATION_SECONDS,
  });

  args.push(
    '-f', 'lavfi', '-i', SILENT_AUDIO_INPUT,
    '-filter_complex', filters.join(';'),
    '-map', `[${current}]`,
    '-map', `${audioIndex}:a:0`,
    '-c:v', 'libx264',
    '-preset', 'medium',
    '-pix_fmt', 'yuv420p',
    '-r', String(TIKTOK_VIDEO_FPS),
    '-c:a', 'aac',
    '-b:a', '96k',
    '-ar', '44100',
    '-ac', '2',
    '-shortest',
    '-movflags', '+faststart',
    String(outputPath),
  );
  return args;
}

/** Build the motion-graphic treatment without executing ffmpeg. */
export function buildMotionGraphicVideoFfmpegArgs(inputPaths, outputPath) {
  if (!Array.isArray(inputPaths) || inputPaths.length === 0) throw new Error('a TikTok video needs at least one slide');
  if (!String(outputPath || '').trim()) throw new Error('a TikTok video needs an output path');

  const args = ['-hide_banner', '-loglevel', 'error', '-y'];
  args.push(...inputArgs(inputPaths));

  const audioIndex = inputPaths.length;
  const filters = inputPaths.map((_, index) => motionSlideFilter(index));
  const current = addTransitions(filters, inputPaths.length, {
    transition: 'wipe',
    duration: TIKTOK_MOTION_TRANSITION_SECONDS,
  });

  args.push(
    '-f', 'lavfi', '-i', SILENT_AUDIO_INPUT,
    '-filter_complex', filters.join(';'),
    '-map', `[${current}]`,
    '-map', `${audioIndex}:a:0`,
    '-c:v', 'libx264',
    '-preset', 'medium',
    '-pix_fmt', 'yuv420p',
    '-r', String(TIKTOK_VIDEO_FPS),
    '-c:a', 'aac',
    '-b:a', '96k',
    '-ar', '44100',
    '-ac', '2',
    '-shortest',
    '-movflags', '+faststart',
    String(outputPath),
  );
  return args;
}

function processError(binary, result) {
  const detail = result?.error?.message || result?.stderr?.trim() || `exit ${result?.status ?? 'unknown'}`;
  return new Error(`${binary} failed: ${detail}`);
}

function probeVideo(outputPath, ffprobePath) {
  const result = spawnSync(ffprobePath, [
    '-v', 'error',
    '-select_streams', 'v:0',
    '-show_entries', 'stream=width,height:format=duration',
    '-of', 'json',
    outputPath,
  ], { encoding: 'utf8' });
  if (result.status !== 0) throw processError(ffprobePath, result);
  let parsed;
  try {
    parsed = JSON.parse(result.stdout || '{}');
  } catch (err) {
    throw new Error(`${ffprobePath} returned invalid JSON: ${err.message}`);
  }
  const stream = parsed.streams?.[0];
  const duration = Number(parsed.format?.duration);
  if (stream?.width !== TIKTOK_VIDEO_WIDTH || stream?.height !== TIKTOK_VIDEO_HEIGHT || !Number.isFinite(duration) || duration <= 0) {
    throw new Error(`${ffprobePath} returned an invalid TikTok video shape`);
  }
  return { width: stream.width, height: stream.height, durationMs: Math.round(duration * 1000) };
}

/**
 * Render the supplied JPEG buffers and return the exact bytes plus the
 * metadata signed into the queue. The temporary input/output files never
 * leave the runner.
 *
 * @param {Buffer[]} slideBuffers
 * @param {{ ffmpegPath?: string, ffprobePath?: string }} [opts]
 * @returns {{ buffer: Buffer, bytes: number, sha256: string, durationMs: number, width: number, height: number }}
 */
export function renderCarouselVideo(slideBuffers, { ffmpegPath = 'ffmpeg', ffprobePath = 'ffprobe' } = {}) {
  if (!Array.isArray(slideBuffers) || slideBuffers.length === 0) throw new Error('a TikTok video needs at least one slide');
  const tmpDir = mkdtempSync(path.join(os.tmpdir(), 'social-carousel-video-'));
  const outputPath = path.join(tmpDir, 'carousel.mp4');
  try {
    const inputPaths = slideBuffers.map((buffer, index) => {
      const inputPath = path.join(tmpDir, `slide-${index + 1}.jpg`);
      writeFileSync(inputPath, buffer);
      return inputPath;
    });
    const result = spawnSync(ffmpegPath, buildCarouselVideoFfmpegArgs(inputPaths, outputPath), { encoding: 'utf8' });
    if (result.status !== 0) throw processError(ffmpegPath, result);
    const bytes = statSync(outputPath).size;
    if (!bytes) throw new Error('ffmpeg produced an empty TikTok video');
    const shape = probeVideo(outputPath, ffprobePath);
    const buffer = readFileSync(outputPath);
    return {
      buffer,
      bytes,
      sha256: createHash('sha256').update(buffer).digest('hex'),
      ...shape,
    };
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
}

function renderWithBuilder(slideBuffers, builder, { ffmpegPath = 'ffmpeg', ffprobePath = 'ffprobe' } = {}) {
  if (!Array.isArray(slideBuffers) || slideBuffers.length === 0) throw new Error('a TikTok video needs at least one slide');
  const tmpDir = mkdtempSync(path.join(os.tmpdir(), 'social-motion-video-'));
  const outputPath = path.join(tmpDir, 'motion.mp4');
  try {
    const inputPaths = slideBuffers.map((buffer, index) => {
      const inputPath = path.join(tmpDir, `slide-${index + 1}.jpg`);
      writeFileSync(inputPath, buffer);
      return inputPath;
    });
    const result = spawnSync(ffmpegPath, builder(inputPaths, outputPath), { encoding: 'utf8' });
    if (result.status !== 0) throw processError(ffmpegPath, result);
    const bytes = statSync(outputPath).size;
    if (!bytes) throw new Error('ffmpeg produced an empty TikTok motion video');
    const shape = probeVideo(outputPath, ffprobePath);
    const buffer = readFileSync(outputPath);
    return {
      buffer,
      bytes,
      sha256: createHash('sha256').update(buffer).digest('hex'),
      ...shape,
    };
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
}

/** Render the Firebase-selected motion-graphic TikTok treatment. */
export function renderMotionGraphicVideo(slideBuffers, opts = {}) {
  return renderWithBuilder(slideBuffers, buildMotionGraphicVideoFfmpegArgs, opts);
}
