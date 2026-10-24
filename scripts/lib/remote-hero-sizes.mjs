// remote-hero-sizes.mjs — measure the article heroes a sparse re-render cannot
// see on disk, from the bytes the site actually serves.
//
// WHY. scripts/rerender-article-corpus.mjs renders from a sparse checkout
// without `public/images/`, so `resolveImagePath` (packages/articles/engine/
// ogPagesPlugin.ts) found no hero file and fell back to `/og-image.png` with a
// guessed 1200x675 size. #14902 then string-patched the fallback back to the
// registry path AFTER the CDN rewrite had already run, which shipped a
// site-relative `/images/blog/<file>` in og:image, twitter:image, the JSON-LD
// ImageObject, the hero <img> and its preload — and the origin answers 404 for
// every one of them (blog heroes live only on the CDN). Measured live on
// 2026-10-24: 51 of 80 sampled article pages, every one of them in the
// frontaliere section, with the hero image broken and the MIME/size wrong.
//
// Instead of patching the HTML, the re-render now tells the renderer which
// heroes are served and how big they are (`remoteHeroSizes`), so a sparse
// render resolves the hero exactly as the full build does. Only the header
// bytes are fetched (HTTP Range), the same 64 KiB `readImageIntrinsicSize`
// reads from disk.
//
// A hero that cannot be measured (404, network error, unparsable header) is
// simply left out of the map: the renderer then falls back to `/og-image.png`
// and `filterEntriesByImagePostcondition` withholds the page, so the live
// shard keeps the copy it already has. Never a guessed size, never a URL that
// was not observed to answer.

import fs from 'node:fs';
import path from 'node:path';

import { CDN_BLOG_BASE } from '../../packages/articles/engine/blogImageCdnFinalize.ts';
import { intrinsicSizeFromBuffer } from '../../packages/articles/engine/shared/imageIntrinsicSize.ts';

export const SITE_ORIGIN = 'https://frontaliereticino.ch';
export const HERO_HEADER_BYTES = 65536;

const FULL_BLOG_HERO_RX = /^\/images\/blog\/([^/?#]+\.(?:webp|png|jpe?g|avif))$/i;

/**
 * Site-relative hero path (`/images/...`) for a registry `image` value, or
 * null when the value is not a same-site image the renderer could resolve.
 * External URLs are not ours to measure and are left to the renderer.
 */
export function heroPathOf(value) {
  const raw = String(value ?? '').trim();
  if (!raw || /^https?:\/\//i.test(raw)) return null;
  const p = (raw.startsWith('/') ? raw : `/${raw}`).replace(/\/+/g, '/').split(/[?#]/, 1)[0];
  return p.startsWith('/images/') ? p : null;
}

/** Where the site serves a hero: full blog heroes on the CDN, the rest on the origin. */
export function publicHeroUrl(heroPath) {
  const m = String(heroPath).match(FULL_BLOG_HERO_RX);
  return m ? `${CDN_BLOG_BASE}/${m[1]}` : `${SITE_ORIGIN}${heroPath}`;
}

/**
 * Every URL the hero size may be read from, in order: where the site serves
 * it, then — for a non-blog hero served by the origin — the same path on the
 * CDN. The origin answers 403 to GitHub-hosted runners for `/images/places/*`
 * (Cloudflare bot rule; rerender run 40082618932: 11 heroes, 10 svizzera
 * articles withheld), while the CDN mirror serves the same bytes to them.
 * Only the size is read from the mirror; the page keeps the origin URL.
 */
export function heroMeasureUrls(heroPath) {
  const primary = publicHeroUrl(heroPath);
  const cdnOrigin = CDN_BLOG_BASE.replace(/\/images\/blog$/, '');
  const mirror = `${cdnOrigin}${heroPath}`;
  return primary === mirror ? [primary] : [primary, mirror];
}

/** Read only the prefix needed by the intrinsic-size parser. */
async function readResponsePrefix(res, maxBytes) {
  const body = res.body;
  if (!body?.getReader) return Buffer.alloc(0);

  let reader;
  let byob = true;
  try {
    // Fetch responses expose a byte stream in Node, so BYOB prevents a single
    // oversized chunk from making us consume more than the requested prefix.
    reader = body.getReader({ mode: 'byob' });
  } catch {
    // Keep compatibility with generic ReadableStreams supplied by tests/tools.
    byob = false;
    reader = body.getReader();
  }

  const chunks = [];
  let total = 0;
  try {
    while (total < maxBytes) {
      const remaining = maxBytes - total;
      const { done, value } = byob ? await reader.read(new Uint8Array(remaining)) : await reader.read();
      if (done) break;
      // A stream is allowed to reuse its backing buffer on the next read.
      // Normalise both ArrayBuffer and typed-array chunks through
      // Uint8Array.from so the retained bytes are an independent copy.
      const bytes = value instanceof ArrayBuffer ? new Uint8Array(value) : value;
      const chunk = bytes ? Buffer.from(Uint8Array.from(bytes)) : Buffer.alloc(0);
      if (!chunk.length) continue;
      const take = Math.min(chunk.length, remaining);
      chunks.push(chunk.subarray(0, take));
      total += take;
      if (take < chunk.length || total >= maxBytes) {
        await reader.cancel();
        break;
      }
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks, total);
}

async function measureOne(url, { fetchImpl, timeoutMs }) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetchImpl(url, {
      headers: { Range: `bytes=0-${HERO_HEADER_BYTES - 1}` },
      signal: controller.signal,
    });
    if (res.status !== 200 && res.status !== 206) return { ok: false, reason: `HTTP ${res.status}` };
    const type = String(res.headers?.get?.('content-type') ?? '');
    if (type && !/^image\//i.test(type)) return { ok: false, reason: `content-type ${type}` };
    const size = intrinsicSizeFromBuffer(await readResponsePrefix(res, HERO_HEADER_BYTES));
    return size ? { ok: true, size } : { ok: false, reason: 'unparsable header' };
  } catch (err) {
    return { ok: false, reason: err instanceof Error ? err.message : String(err) };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Measure every declared hero that is absent from `publicDir`.
 *
 * @param {Iterable<string>} declaredImages registry `image` values
 * @param {{ publicDir: string, fetchImpl?: typeof fetch, concurrency?: number, timeoutMs?: number }} opts
 * @returns {Promise<{ sizes: Record<string, {width:number,height:number}>, probed: number, local: number, failed: Array<{path:string,url:string,reason:string}> }>}
 */
export async function probeRemoteHeroSizes(declaredImages, opts) {
  const { publicDir, fetchImpl = globalThis.fetch, concurrency = 16, timeoutMs = 15000 } = opts;
  const unique = [...new Set([...declaredImages].map(heroPathOf).filter(Boolean))].sort();
  const missing = [];
  let local = 0;
  for (const heroPath of unique) {
    let onDisk = false;
    try {
      onDisk = fs.statSync(path.join(publicDir, heroPath.replace(/^\/+/, ''))).isFile();
    } catch {
      onDisk = false;
    }
    if (onDisk) local += 1;
    else missing.push(heroPath);
  }

  const sizes = {};
  const failed = [];
  let next = 0;
  const worker = async () => {
    while (next < missing.length) {
      const heroPath = missing[next++];
      const url = publicHeroUrl(heroPath);
      let result = { ok: false, reason: 'not probed' };
      const [primary, mirror] = heroMeasureUrls(heroPath);
      result = await measureOne(primary, { fetchImpl, timeoutMs });
      // Only the documented refusal (403 to the runner) falls back to the
      // mirror. A 404, a timeout or an unparsable header stays terminal: a
      // leftover CDN copy must never vouch for a hero the page cannot serve.
      if (!result.ok && mirror && result.reason === 'HTTP 403') {
        result = await measureOne(mirror, { fetchImpl, timeoutMs });
      }
      if (result.ok) sizes[heroPath] = result.size;
      else failed.push({ path: heroPath, url, reason: result.reason });
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(concurrency, missing.length)) }, worker));
  return { sizes, probed: missing.length, local, failed };
}
