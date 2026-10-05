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
export const BRAND_VIDEO_BACKGROUND = '0x0F2557';
export const TIKTOK_VIDEO_CONTENT_TYPE = 'video/mp4';

const SILENT_AUDIO_INPUT = 'anullsrc=channel_layout=stereo:sample_rate=44100';

function slideFilter(index) {
  return `[${index}:v]scale=${TIKTOK_VIDEO_WIDTH}:${TIKTOK_VIDEO_HEIGHT}:force_original_aspect_ratio=decrease,pad=${TIKTOK_VIDEO_WIDTH}:${TIKTOK_VIDEO_HEIGHT}:(ow-iw)/2:(oh-ih)/2:color=${BRAND_VIDEO_BACKGROUND},setsar=1,fps=${TIKTOK_VIDEO_FPS},format=yuv420p,settb=1/${TIKTOK_VIDEO_FPS}[v${index}]`;
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
  for (const inputPath of inputPaths) {
    args.push('-loop', '1', '-t', String(TIKTOK_SLIDE_DURATION_SECONDS), '-i', String(inputPath));
  }

  const audioIndex = inputPaths.length;
  const filters = inputPaths.map((_, index) => slideFilter(index));
  let current = 'v0';
  for (let index = 1; index < inputPaths.length; index += 1) {
    const output = `xfade${index}`;
    const offset = (index * (TIKTOK_SLIDE_DURATION_SECONDS - TIKTOK_CROSSFADE_DURATION_SECONDS)).toFixed(3);
    filters.push(`[${current}][v${index}]xfade=transition=fade:duration=${TIKTOK_CROSSFADE_DURATION_SECONDS}:offset=${offset}[${output}]`);
    current = output;
  }

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
