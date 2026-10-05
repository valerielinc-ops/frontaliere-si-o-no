/**
 * Guard for the Instagram/TikTok carousel posters (scripts/post-to-instagram.mjs,
 * scripts/post-to-tiktok.mjs + the shared libs they introduced). Sibling of
 * tests/linkedin-member-daily.test.ts — pickFirstUnposted's carousel-format
 * counterpart, the UTM identity contract extended to two more channels, and
 * the same fail-soft file-content guards.
 */
import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';

import { pickTopNUnposted } from '../scripts/lib/daily-top-content.mjs';
import { formatDayIt, buildCarouselCaption, buildTikTokCaption, TIKTOK_CAPTION_MAX_CHARS } from '../scripts/lib/social-post-utils.mjs';
import { buildQueueEntry, isAllowedVideoUrl } from '../scripts/lib/social-publish-queue.mjs';
import {
  BRAND_VIDEO_BACKGROUND,
  TIKTOK_VIDEO_HEIGHT,
  TIKTOK_VIDEO_WIDTH,
  buildCarouselVideoFfmpegArgs,
  renderCarouselVideo,
} from '../scripts/lib/social-carousel-video.mjs';
import {
  instagramUrl,
  INSTAGRAM_UTM_SOURCE,
  INSTAGRAM_CAMPAIGN_ARTICLE,
  INSTAGRAM_CAMPAIGN_JOB,
  INSTAGRAM_CAMPAIGN_BORDER,
} from '../scripts/lib/instagram-links.mjs';
import {
  tiktokUrl,
  TIKTOK_UTM_SOURCE,
  TIKTOK_CAMPAIGN_ARTICLE,
  TIKTOK_CAMPAIGN_JOB,
  TIKTOK_CAMPAIGN_BORDER,
} from '../scripts/lib/tiktok-links.mjs';

describe('pickTopNUnposted — the carousel-format sibling of pickFirstUnposted', () => {
  const ranked = [
    { slug: 'a', views: 100 },
    { slug: 'b', views: 90 },
    { slug: 'c', views: 80 },
    { slug: 'd', views: 70 },
    { slug: 'e', views: 60 },
    { slug: 'f', views: 50 },
  ];

  it('takes the top N when nothing was posted', () => {
    const { picks, skipped } = pickTopNUnposted(ranked, new Set(), 5);
    expect(picks.map((p) => p.slug)).toEqual(['a', 'b', 'c', 'd', 'e']);
    expect(skipped).toBe(0);
  });

  it('skips already-posted items and fills from further down the ranking', () => {
    const { picks, skipped } = pickTopNUnposted(ranked, new Set(['a', 'c']), 3);
    expect(picks.map((p) => p.slug)).toEqual(['b', 'd', 'e']);
    expect(skipped).toBe(2);
  });

  it('returns a shorter carousel rather than padding when the pool runs out', () => {
    const { picks } = pickTopNUnposted(ranked, new Set(['a', 'b', 'c', 'd', 'e', 'f']), 5);
    expect(picks).toHaveLength(0);
  });

  it('returns empty picks for limit 0 or a negative limit, never throws', () => {
    expect(pickTopNUnposted(ranked, new Set(), 0).picks).toHaveLength(0);
    expect(pickTopNUnposted(ranked, new Set(), -3).picks).toHaveLength(0);
  });

  it('never returns more than `limit` picks even with a huge candidate pool', () => {
    const big = Array.from({ length: 50 }, (_, i) => ({ slug: `s${i}`, views: 50 - i }));
    expect(pickTopNUnposted(big, new Set(), 5).picks).toHaveLength(5);
  });
});

describe('formatDayIt', () => {
  it('renders an Italian dd/mm/yyyy date', () => {
    expect(formatDayIt('2026-08-23')).toBe('23/08/2026');
  });

  it('returns the input unchanged when it is not a YYYY-MM-DD string', () => {
    expect(formatDayIt('not-a-date')).toBe('not-a-date');
  });
});

describe('buildCarouselCaption', () => {
  const picks = [
    { title: 'Infermiere/a EOC', statValue: '312 visualizzazioni' },
    { title: 'Magazziniere Migros', statValue: '210 visualizzazioni' },
  ];

  it('numbers every pick and never emits a clickable URL — Instagram/TikTok captions cannot carry one', () => {
    const caption = buildCarouselCaption({ kind: 'job', dayLabel: '23/08/2026', picks });
    expect(caption).toContain('1. Infermiere/a EOC — 312 visualizzazioni');
    expect(caption).toContain('2. Magazziniere Migros — 210 visualizzazioni');
    expect(caption).not.toMatch(/https?:\/\//);
    expect(caption).toContain('link');
  });

  it('picks distinct copy per kind so job/article/border are never confused', () => {
    const job = buildCarouselCaption({ kind: 'job', dayLabel: 'x', picks });
    const article = buildCarouselCaption({ kind: 'article', dayLabel: 'x', picks });
    const border = buildCarouselCaption({ kind: 'border', dayLabel: 'x', picks });
    expect(new Set([job, article, border]).size).toBe(3);
    expect(border).toContain('dogane');
  });
});

describe('buildTikTokCaption', () => {
  const picks = [
    { title: 'Infermiere/a EOC', statValue: '312 visualizzazioni' },
    { title: 'Magazziniere Migros', statValue: '210 visualizzazioni' },
  ];

  it('opens with searchable keywords, summarizes the ranking and keeps the plain bio link', () => {
    const expectedLead = {
      article: 'frontalieri Ticino',
      job: 'lavoro in Svizzera',
      border: 'dogane Ticino',
    } as const;
    for (const kind of ['article', 'job', 'border'] as const) {
      const caption = buildTikTokCaption({ kind, dayLabel: '23/08/2026', picks });
      expect(caption.split('\n')[0].toLowerCase(), kind).toContain(expectedLead[kind].toLowerCase());
      expect(caption).toContain('23/08/2026');
      expect(caption.toLowerCase()).toContain('link in bio');
      expect(caption).toContain('frontaliereticino.ch');
      expect(caption).not.toMatch(/https?:\/\//);
      expect(caption.length, kind).toBeLessThanOrEqual(TIKTOK_CAPTION_MAX_CHARS);
      const tags = caption.match(/#[\p{L}\p{N}_]+/gu) || [];
      expect(tags.length, kind).toBeGreaterThanOrEqual(4);
      expect(tags.length, kind).toBeLessThanOrEqual(6);
      expect(new Set(tags.map((tag) => tag.toLowerCase())).size, kind).toBe(tags.length);
      expect(tags.join(''), kind).not.toMatch(/[àèéìòùäëïöü]/i);
    }
  });

  it('deduplicates and removes accents from supplied hashtags without changing the topic', () => {
    const caption = buildTikTokCaption({
      kind: 'border',
      dayLabel: '23/08/2026',
      picks,
      hashtags: ['#doganè', '#dogane', '#ticino', '#ticino', '#confine'],
    });
    expect(caption.match(/#dogane/g)).toHaveLength(1);
    expect(caption.match(/#ticino/g)).toHaveLength(1);
    expect(caption).toContain('#confine');
  });
});

describe('TikTok video queue contract', () => {
  const hasFfmpeg = spawnSync('ffmpeg', ['-version'], { stdio: 'ignore' }).status === 0
    && spawnSync('ffprobe', ['-version'], { stdio: 'ignore' }).status === 0;
  const video = {
    url: 'https://cdn.frontaliereticino.ch/images/social/tiktok/article-2026-08-23.mp4',
    bytes: 123456,
    sha256: 'a'.repeat(64),
    durationMs: 7750,
    width: TIKTOK_VIDEO_WIDTH,
    height: TIKTOK_VIDEO_HEIGHT,
  };

  it('stores the signed video metadata alongside the carousel slides', () => {
    const entry = buildQueueEntry({
      channel: 'tiktok',
      kind: 'article',
      day: '2026-08-23',
      caption: 'caption',
      imageUrls: ['https://cdn.frontaliereticino.ch/images/social/tiktok/article-2026-08-23-0.jpg'],
      video,
      ledgerEntries: [],
    });
    expect(entry.video).toEqual(video);
    expect(isAllowedVideoUrl(video.url)).toBe(true);
    expect(isAllowedVideoUrl('https://evil.example/article.mp4')).toBe(false);
  });

  it('builds a vertical H.264 command with padded slides, dissolves and silent AAC', () => {
    const args = buildCarouselVideoFfmpegArgs(['slide-1.jpg', 'slide-2.jpg'], 'carousel.mp4');
    const filter = args[args.indexOf('-filter_complex') + 1];
    expect(args.filter((arg) => arg === '-loop')).toHaveLength(2);
    expect(args.filter((arg) => arg === '-i')).toHaveLength(3);
    expect(filter).toContain(`scale=${TIKTOK_VIDEO_WIDTH}:${TIKTOK_VIDEO_HEIGHT}:force_original_aspect_ratio=decrease`);
    expect(filter).toContain('in_range=full:out_range=tv');
    expect(filter).toContain(`pad=${TIKTOK_VIDEO_WIDTH}:${TIKTOK_VIDEO_HEIGHT}`);
    expect(filter).toContain(BRAND_VIDEO_BACKGROUND);
    expect(filter).toContain('xfade=transition=fade');
    expect(filter).toContain('setrange=tv');
    expect(args).toContain('anullsrc=channel_layout=stereo:sample_rate=44100');
    expect(args).toEqual(expect.arrayContaining(['-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-r', '30', '-c:a', 'aac', '-movflags', '+faststart']));
    expect(args.at(-1)).toBe('carousel.mp4');
  });

  it('uploads MP4 with the video MIME type used by the robot download check', () => {
    const uploader = fs.readFileSync(path.resolve(__dirname, '../scripts/lib/upload-cdn-file.sh'), 'utf8');
    expect(uploader).toContain('mp4) printf \'%s\' "video/mp4"');
  });

  it.skipIf(!hasFfmpeg)('renders an H.264 yuv420p MP4 with 30 fps and silent AAC', async () => {
    const slide = await sharp({
      create: { width: 1080, height: 1080, channels: 3, background: '#0F2557' },
    }).jpeg().toBuffer();
    const rendered = renderCarouselVideo([slide, slide]);
    const probe = spawnSync('ffprobe', [
      '-v', 'error',
      '-show_entries', 'stream=codec_type,codec_name,pix_fmt,width,height,r_frame_rate,sample_rate,channels:format=duration',
      '-of', 'json',
      'pipe:0',
    ], { input: rendered.buffer, encoding: 'utf8' });
    expect(probe.status).toBe(0);
    const parsed = JSON.parse(probe.stdout);
    const videoStream = parsed.streams.find((stream) => stream.codec_type === 'video');
    const audioStream = parsed.streams.find((stream) => stream.codec_type === 'audio');
    expect(videoStream).toMatchObject({
      codec_name: 'h264',
      pix_fmt: 'yuv420p',
      width: TIKTOK_VIDEO_WIDTH,
      height: TIKTOK_VIDEO_HEIGHT,
      r_frame_rate: '30/1',
    });
    expect(audioStream).toMatchObject({ codec_name: 'aac', sample_rate: '44100', channels: 2 });
    expect(Number(parsed.format.duration)).toBeGreaterThan(7);
    expect(Number(parsed.format.duration)).toBeLessThan(8.5);
  });
});

describe('UTM identity — Instagram and TikTok each get one stable GA4 source row', () => {
  it('tags every campaign with the correct source/medium', () => {
    for (const campaign of [INSTAGRAM_CAMPAIGN_ARTICLE, INSTAGRAM_CAMPAIGN_JOB, INSTAGRAM_CAMPAIGN_BORDER]) {
      const u = new URL(instagramUrl('https://frontaliereticino.ch/articoli-frontaliere/x/', campaign, 'x'));
      expect(u.searchParams.get('utm_source')).toBe(INSTAGRAM_UTM_SOURCE);
      expect(u.searchParams.get('utm_medium')).toBe('social');
      expect(u.searchParams.get('utm_campaign')).toBe(campaign);
    }
    for (const campaign of [TIKTOK_CAMPAIGN_ARTICLE, TIKTOK_CAMPAIGN_JOB, TIKTOK_CAMPAIGN_BORDER]) {
      const u = new URL(tiktokUrl('https://frontaliereticino.ch/articoli-frontaliere/x/', campaign, 'x'));
      expect(u.searchParams.get('utm_source')).toBe(TIKTOK_UTM_SOURCE);
      expect(u.searchParams.get('utm_medium')).toBe('social');
      expect(u.searchParams.get('utm_campaign')).toBe(campaign);
    }
  });

  it('keeps instagram and tiktok as distinct GA4 source rows from every other channel', () => {
    const sources = new Set([INSTAGRAM_UTM_SOURCE, TIKTOK_UTM_SOURCE, 'linkedin', 'telegram', 'facebook', 'reddit']);
    expect(sources.size).toBe(6);
  });

  it('returns an unparseable URL verbatim rather than dropping the link', () => {
    expect(instagramUrl('not a url', INSTAGRAM_CAMPAIGN_JOB, 'x')).toBe('not a url');
    expect(tiktokUrl('not a url', TIKTOK_CAMPAIGN_JOB, 'x')).toBe('not a url');
  });
});

describe('fail-soft posture — Instagram/TikTok posters never exit non-zero', () => {
  const root = path.resolve(__dirname, '..', 'scripts');
  for (const file of ['post-to-instagram.mjs', 'post-to-tiktok.mjs']) {
    it(`${file} always exits 0, even on a caught error`, () => {
      const src = fs.readFileSync(path.join(root, file), 'utf-8');
      expect(src).toContain('process.exit(0)');
      expect(src).not.toMatch(/process\.exit\([1-9]/);
    });

    it(`${file} tags every link it builds with its channel's UTM helper`, () => {
      const src = fs.readFileSync(path.join(root, file), 'utf-8');
      const helper = file.includes('instagram') ? 'instagramUrl(' : 'tiktokUrl(';
      expect(src).toContain(helper);
    });
  }
});
