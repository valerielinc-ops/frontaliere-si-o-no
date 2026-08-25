/**
 * Live-page OG fetch + LinkedIn Images API upload for the member daily post.
 *
 * LinkedIn Posts API does not scrape Open Graph. The card thumbnail must be
 * an image URN from initializeUpload. Site og:image is often WebP; Images API
 * accepts JPG/GIF/PNG only — convert before PUT or the upload 400s.
 *
 * Every network failure is fail-soft: return null / empty meta, never throw
 * to the cron. The post still goes out with title+description.
 */

import sharp from 'sharp';
import { LINKEDIN_REST_VERSION } from './linkedin-links.mjs';
import {
  extractOgFromHtml,
  resolveMaybeAbsoluteUrl,
} from './linkedin-member-copy.mjs';

export const LINKEDIN_IMAGES_API = 'https://api.linkedin.com/rest/images';
export const LINKEDIN_IMAGES_VERSION = LINKEDIN_REST_VERSION;

const FETCH_TIMEOUT_MS = 15000;
const MAX_EDGE_PX = 1920;

// Tetto in byte per il buffer che finisce nel PUT su Images API.
//
// Ogni ramo tranne la GIF era gia' limitato per costruzione: `sharp().resize()`
// a 1920px riporta qualunque originale a pochi centinaia di KB. La GIF no —
// tornava il buffer scaricato cosi' com'era, quindi una `og:image` GIF animata
// e pesante andava al PUT senza che nulla la guardasse (follow-up #6450 item 3).
// Il fail-soft assorbe il reject, ma assorbendolo perde la thumbnail in
// silenzio: il post esce senza card.
//
// 5 MB sta sotto il limite documentato da LinkedIn per l'upload immagini
// (10 MB) con un margine che copre l'overhead di trasferimento; una GIF sopra
// questa soglia non e' una thumbnail, e' un asset fuori posto.
export const MAX_UPLOAD_BYTES = 5_000_000;

/**
 * @param {string} pageUrl
 * @param {typeof fetch} [fetchImpl]
 * @returns {Promise<{ ogImage: string, ogDescription: string }>}
 */
export async function fetchPageOg(pageUrl, fetchImpl = fetch) {
  const url = String(pageUrl || '').trim();
  if (!url) return { ogImage: '', ogDescription: '' };
  try {
    const res = await fetchImpl(url, {
      redirect: 'follow',
      headers: { 'User-Agent': 'frontaliereticino-linkedin-bot/1.0' },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!res?.ok) return { ogImage: '', ogDescription: '' };
    const html = await res.text();
    const meta = extractOgFromHtml(html);
    return {
      ogImage: resolveMaybeAbsoluteUrl(meta.ogImage, url),
      ogDescription: meta.ogDescription,
    };
  } catch (err) {
    console.warn(`⚠️  og:image fetch failed: ${err.message}`);
    return { ogImage: '', ogDescription: '' };
  }
}

/**
 * Convert a downloaded image to a LinkedIn-accepted still (JPEG/PNG/GIF).
 * WebP and unknown types become JPEG. Already-accepted types pass through
 * after an optional downscale so we never upload a 36-megapixel original.
 *
 * @param {Buffer} buffer
 * @param {{ contentType?: string, url?: string }} [meta]
 * @returns {Promise<{ buffer: Buffer, contentType: string }>}
 */
export async function convertImageForLinkedIn(buffer, meta = {}) {
  const buf = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer || []);
  if (buf.length === 0) {
    throw new Error('empty image buffer');
  }
  const type = String(meta.contentType || '').toLowerCase();
  const path = String(meta.url || '').split('?')[0].toLowerCase();
  const isPng = type.includes('png') || /\.png$/i.test(path);
  const isGif = type.includes('gif') || /\.gif$/i.test(path);

  // Una GIF entro il tetto passa intatta: e' l'unico formato in cui
  // l'animazione e' il contenuto, e ricodificarla la ucciderebbe.
  // Sopra il tetto non si scarta — si degrada al primo fotogramma, che e'
  // esattamente cio' che ogni altro ramo produce. Una thumbnail statica vale
  // piu' di un PUT rifiutato e assorbito dal fail-soft (follow-up #6450).
  if (isGif && buf.length <= MAX_UPLOAD_BYTES) {
    return { buffer: buf, contentType: 'image/gif' };
  }

  const pipeline = sharp(buf, { failOn: 'none' }).rotate().resize({
    width: MAX_EDGE_PX,
    height: MAX_EDGE_PX,
    fit: 'inside',
    withoutEnlargement: true,
  });

  if (isPng) {
    const out = await pipeline.png().toBuffer();
    return { buffer: out, contentType: 'image/png' };
  }
  // JPEG path, WebP, AVIF, or unknown → JPEG (Images API does not take WebP).
  const out = await pipeline.jpeg({ quality: 85 }).toBuffer();
  return { buffer: out, contentType: 'image/jpeg' };
}

/**
 * Download og:image, convert, initializeUpload, PUT. Returns the image URN
 * or null. Never throws.
 *
 * @param {{ accessToken: string, ownerUrn: string, imageUrl: string, fetchImpl?: typeof fetch }} opts
 * @returns {Promise<string|null>}
 */
export async function uploadLinkedInImage({
  accessToken,
  ownerUrn,
  imageUrl,
  fetchImpl = fetch,
} = {}) {
  const token = String(accessToken || '').trim();
  const owner = String(ownerUrn || '').trim();
  const src = String(imageUrl || '').trim();
  if (!token || !owner || !src) return null;

  try {
    const imgRes = await fetchImpl(src, {
      redirect: 'follow',
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!imgRes?.ok) {
      console.warn(`⚠️  thumbnail download ${imgRes?.status || 'fail'} — posting without image`);
      return null;
    }
    const raw = Buffer.from(await imgRes.arrayBuffer());
    const contentType = imgRes.headers?.get?.('content-type') || '';
    const converted = await convertImageForLinkedIn(raw, { contentType, url: src });

    const initRes = await fetchImpl(`${LINKEDIN_IMAGES_API}?action=initializeUpload`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        'LinkedIn-Version': LINKEDIN_IMAGES_VERSION,
        'X-Restli-Protocol-Version': '2.0.0',
      },
      body: JSON.stringify({ initializeUploadRequest: { owner } }),
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!initRes?.ok) {
      const body = await initRes.text().catch(() => '');
      console.warn(
        `⚠️  LinkedIn initializeUpload ${initRes.status} — posting without image: ${body.slice(0, 180)}`,
      );
      return null;
    }
    const initJson = await initRes.json().catch(() => ({}));
    const uploadUrl = initJson?.value?.uploadUrl;
    const imageUrn = initJson?.value?.image;
    if (!uploadUrl || !imageUrn) {
      console.warn('⚠️  initializeUpload missing uploadUrl/image — posting without image');
      return null;
    }

    const putRes = await fetchImpl(uploadUrl, {
      method: 'PUT',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': converted.contentType,
      },
      body: converted.buffer,
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!putRes?.ok) {
      const body = await putRes.text().catch(() => '');
      console.warn(
        `⚠️  LinkedIn image PUT ${putRes.status} — posting without image: ${body.slice(0, 180)}`,
      );
      return null;
    }
    return imageUrn;
  } catch (err) {
    console.warn(`⚠️  LinkedIn image upload failed: ${err.message}`);
    return null;
  }
}
