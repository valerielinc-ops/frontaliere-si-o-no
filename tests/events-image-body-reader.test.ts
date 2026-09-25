/**
 * #9729 — `mirrorEventImage` reads the image body in streaming with the
 * per-response cap `EVENT_IMAGE_MAX_BYTES` applied DURING the download.
 *
 * Before: `Buffer.from(await res.arrayBuffer())` and the cap checked only once
 * the whole body had arrived, so a chunked response without Content-Length was
 * downloaded in full before being rejected. Port of the corpus fix
 * (nanakokyobashi-rgb/frontaliere-articles#1770, #1728, #1746): streaming read,
 * fail-closed over the cap with the stream cancelled, allocation following the
 * declared/received bytes, and `releaseLock()` as non-fatal cleanup.
 *
 * Synthetic streams only: no network. The manifest is redirected to a temp
 * file (EVENTS_IMAGE_MANIFEST_PATH) so the tracked index is never rewritten,
 * and the single image the success paths write is removed afterwards.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  EVENT_IMAGE_MAX_BYTES,
  mirrorEventImage,
  resetEventImageManifestCache,
} from '../scripts/lib/events-utils.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const EVENT_IMAGE_DIR = path.join(REPO_ROOT, 'public', 'images', 'events');
const MIB = 1024 * 1024;
const URL_OK = 'https://images.example.test/a.jpg';

let dir: string;
let previousManifest: string | undefined;
const written: string[] = [];

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'events-image-body-'));
  previousManifest = process.env.EVENTS_IMAGE_MANIFEST_PATH;
  process.env.EVENTS_IMAGE_MANIFEST_PATH = path.join(dir, 'manifest.json');
  writeFileSync(process.env.EVENTS_IMAGE_MANIFEST_PATH, '{}\n');
  resetEventImageManifestCache();
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  if (previousManifest === undefined) delete process.env.EVENTS_IMAGE_MANIFEST_PATH;
  else process.env.EVENTS_IMAGE_MANIFEST_PATH = previousManifest;
  resetEventImageManifestCache();
  for (const file of written.splice(0)) rmSync(file, { force: true });
  rmSync(dir, { recursive: true, force: true });
});

function uniqueId(tag: string) {
  return `test9729-${tag}-${process.pid}-${Math.random().toString(36).slice(2, 10)}`;
}

function trackWritten(result: string | null) {
  if (result) written.push(path.join(EVENT_IMAGE_DIR, path.basename(result)));
  return result;
}

/** Chunked body (no Content-Length) that counts how many chunks were pulled. */
function countingStream(totalChunks: number, chunkBytes: number) {
  const stats = { pulled: 0, cancelled: false };
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (stats.pulled >= totalChunks) {
        controller.close();
        return;
      }
      stats.pulled += 1;
      controller.enqueue(new Uint8Array(chunkBytes));
    },
    cancel() { stats.cancelled = true; },
  }, { highWaterMark: 0 });
  return { stream, stats };
}

function imageResponse(body: ReadableStream<Uint8Array>, headers: Record<string, string> = {}) {
  return new Response(body, { status: 200, headers: { 'content-type': 'image/jpeg', ...headers } });
}

describe('mirrorEventImage: streaming body with the cap applied during the download (#9729)', () => {
  it('interrupts a chunked response without Content-Length as soon as it crosses the cap', async () => {
    const totalChunks = 64; // 64 MiB offered, cap is 20 MiB
    const { stream, stats } = countingStream(totalChunks, MIB);
    const fetchStub = vi.fn().mockResolvedValue(imageResponse(stream));
    vi.stubGlobal('fetch', fetchStub);

    const result = trackWritten(await mirrorEventImage(URL_OK, uniqueId('over')));

    expect(result).toBeNull();
    const capChunks = EVENT_IMAGE_MAX_BYTES / MIB;
    // Before the fix every one of the 64 chunks was downloaded; now the read
    // stops on the first chunk past the cap (plus at most one in flight).
    expect(stats.pulled).toBeLessThanOrEqual(capChunks + 2);
    expect(stats.pulled).toBeLessThan(totalChunks);
    expect(stats.cancelled).toBe(true);
  });

  it('keeps a chunked response without Content-Length that stays under the cap', async () => {
    const { stream, stats } = countingStream(3, 1024);
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(imageResponse(stream)));

    const result = trackWritten(await mirrorEventImage(URL_OK, uniqueId('under')));

    expect(result).toMatch(/^\/images\/events\/test9729-under-.+\.(jpg|webp)$/);
    expect(existsSync(path.join(EVENT_IMAGE_DIR, path.basename(result!)))).toBe(true);
    expect(stats.pulled).toBe(3);
    expect(stats.cancelled).toBe(false);
  });

  it('rejects a declared Content-Length over the cap without reading the body', async () => {
    const { stream, stats } = countingStream(4, MIB);
    const response = imageResponse(stream, { 'content-length': String(EVENT_IMAGE_MAX_BYTES + 1) });
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response));

    const result = trackWritten(await mirrorEventImage(URL_OK, uniqueId('declared')));

    expect(result).toBeNull();
    expect(stats.pulled).toBeLessThanOrEqual(1);
    expect(stats.cancelled).toBe(true);
  });

  it('a releaseLock() that throws does not turn a fully read image into null', async () => {
    const queue = [Uint8Array.from([0xff, 0xd8, 0xff]), Uint8Array.from([0xd9])];
    const reader = {
      read: async () => (queue.length ? { done: false, value: queue.shift() } : { done: true, value: undefined }),
      cancel: async () => {},
      releaseLock() { throw new TypeError('Invalid state: reader released with pending read requests'); },
    };
    const response = {
      ok: true,
      status: 200,
      headers: new Headers({ 'content-type': 'image/jpeg' }),
      body: { getReader: () => reader, cancel: async () => {} },
    };
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response));

    const result = trackWritten(await mirrorEventImage(URL_OK, uniqueId('release')));

    expect(result).toMatch(/^\/images\/events\/test9729-release-.+\.(jpg|webp)$/);
  });

  it('a releaseLock() that throws keeps the oversize verdict', async () => {
    let cancelled = false;
    const reader = {
      read: async () => ({ done: false, value: new Uint8Array(MIB) }),
      cancel: async () => { cancelled = true; },
      releaseLock() { throw new TypeError('released'); },
    };
    const response = {
      ok: true,
      status: 200,
      headers: new Headers({ 'content-type': 'image/jpeg' }),
      body: { getReader: () => reader, cancel: async () => {} },
    };
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response));

    // An infinite body: only a cap applied during the read can terminate this.
    const result = trackWritten(await mirrorEventImage(URL_OK, uniqueId('release-over')));

    expect(result).toBeNull();
    expect(cancelled).toBe(true);
  });
});
