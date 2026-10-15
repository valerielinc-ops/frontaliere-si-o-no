/**
 * Publication gate for image URLs that leave the site.
 *
 * The image registry is permission to publish generated or verified licensed
 * photo bytes. The image-credits reader is permission to publish a Wikimedia
 * cover. A CDN URL alone is never enough: callers must pass through this
 * policy before a third-party API downloads the bytes.
 *
 * The allowlist below is deliberately narrower than the site's complete image
 * tree. It is used only for build-produced `og:image` values that are owned by
 * the site and therefore do not have a per-image licence record. It is not an
 * exception for LinkedIn downloads: LinkedIn uses `checkPublishedImageUrl`
 * with `requireCdn: true`, so an unrecorded site-owned card is omitted there.
 */

import fs from 'node:fs';
import path from 'node:path';

import {
  isGeneratedImagePath,
  validateGeneratedImageRecord,
  validateGeneratedImageRegistry,
} from '../../packages/articles/engine/shared/generatedImageRegistry.mjs';
import { coverKey, createImageCreditReader } from '../../packages/articles/engine/shared/imageCredits.mjs';
import { loadInferredCoverDecisions } from './blog-cover-decisions.mjs';

export const SITE_ORIGIN = 'https://frontaliereticino.ch';
export const IMAGE_CDN_ORIGIN = 'https://cdn.frontaliereticino.ch';

/** CDN paths whose bytes require a registry/ledger record. */
export const RECORDED_CDN_IMAGE_PREFIXES = Object.freeze([
  `${IMAGE_CDN_ORIGIN}/images/blog/`,
  `${IMAGE_CDN_ORIGIN}/images/events/library/`,
  `${IMAGE_CDN_ORIGIN}/images/generated/`,
  `${IMAGE_CDN_ORIGIN}/images/authors/`,
  `${IMAGE_CDN_ORIGIN}/images/places/`,
]);

/**
 * Explicit build-owned OG assets. Keep this list in sync with the build
 * emitters and `scripts/offload-generated-images-cdn.mjs`; adding a broad
 * host-only entry would make the gate meaningless.
 */
export const SITE_OWNED_OG_IMAGE_ALLOWLIST = Object.freeze([
  `${SITE_ORIGIN}/og-image.png`,
  `${SITE_ORIGIN}/og/jobs/`,
  `${SITE_ORIGIN}/og/seo/`,
  `${SITE_ORIGIN}/og/border-wait/`,
  `${IMAGE_CDN_ORIGIN}/og/jobs/`,
  `${IMAGE_CDN_ORIGIN}/og/seo/`,
  `${IMAGE_CDN_ORIGIN}/og/border-wait/`,
  `${SITE_ORIGIN}/images/events/catalog/`,
  `${IMAGE_CDN_ORIGIN}/images/events/catalog/`,
]);

function asAbsoluteHttpsUrl(value) {
  try {
    const url = new URL(String(value || ''), SITE_ORIGIN);
    return url.protocol === 'https:' ? url : null;
  } catch {
    return null;
  }
}

function recordPath(record) {
  if (!record || typeof record.imageUrl !== 'string') return '';
  try {
    return new URL(record.imageUrl, SITE_ORIGIN).pathname;
  } catch {
    return '';
  }
}

function recordsByPath(records) {
  const map = new Map();
  for (const record of Array.isArray(records) ? records : []) {
    const imagePath = recordPath(record);
    if (imagePath) map.set(imagePath, record);
  }
  return map;
}

function failure(reason, url, extra = {}) {
  return { valid: false, reason, url: String(url || ''), ...extra };
}

function validGeneratedRecord(url, record, expectedPath) {
  if (!record) return failure('missing-generated-record', url, { path: expectedPath });
  const validation = validateGeneratedImageRecord(record);
  if (!validation.valid) {
    return failure('invalid-generated-record', url, {
      path: expectedPath,
      errors: validation.errors,
    });
  }
  if (recordPath(record) !== expectedPath || !isGeneratedImagePath(expectedPath)) {
    return failure('generated-record-path-mismatch', url, { path: expectedPath });
  }
  return {
    valid: true,
    source: record.license === 'private-grant'
      ? 'private-grant-registry'
      : record.kind === 'photo'
        ? 'licensed-photo-registry'
        : 'generated-registry',
    url: String(url),
    path: expectedPath,
    record,
  };
}

function cdnPrefixForPath(pathname) {
  return RECORDED_CDN_IMAGE_PREFIXES.find((prefix) => {
    try {
      return new URL(prefix).pathname === pathname.slice(0, new URL(prefix).pathname.length)
        || pathname.startsWith(new URL(prefix).pathname);
    } catch {
      return false;
    }
  });
}

/**
 * Validate a publishable image URL.
 *
 * `requireCdn: true` is for uploaders that hand the URL to a third party. The
 * build OG gate leaves it false so it can inspect same-origin emitted HTML
 * before the CDN offload rewrite has happened.
 *
 * `inferredCovers` is passed by the build OG gate only. It answers for the
 * historical blog covers the owner keeps without a credit: the page already
 * shows them, so its `og:image` may name them. An uploader does not pass it,
 * and such a cover stays unpublishable to a third party.
 */
export function checkPublishedImageUrl(
  imageUrl,
  { records = [], imageCreditReader = null, requireCdn = false, inferredCovers = null } = {},
) {
  const url = asAbsoluteHttpsUrl(imageUrl);
  if (!url) return failure('not-https-url', imageUrl);

  const origin = url.origin;
  const pathname = url.pathname;
  if (requireCdn && origin !== IMAGE_CDN_ORIGIN) {
    return failure('not-our-cdn', imageUrl, { host: url.hostname });
  }
  if (origin !== SITE_ORIGIN && origin !== IMAGE_CDN_ORIGIN) {
    return failure('third-party-image-url', imageUrl, { host: url.hostname });
  }

  const generatedPrefix = pathname.startsWith('/images/events/library/')
    || pathname.startsWith('/images/generated/')
    || pathname.startsWith('/images/authors/')
    || pathname.startsWith('/images/places/');
  if (generatedPrefix) {
    const record = recordsByPath(records).get(pathname);
    return validGeneratedRecord(imageUrl, record, pathname);
  }

  if (pathname.startsWith('/images/blog/')) {
    if (!imageCreditReader || typeof imageCreditReader.get !== 'function') {
      return failure('missing-image-credit-reader', imageUrl, { path: pathname });
    }
    const record = imageCreditReader.get(pathname);
    if (!record) {
      if (inferredCovers && typeof inferredCovers.has === 'function' && inferredCovers.has(coverKey(pathname))) {
        return { valid: true, source: 'inferred-no-credit', url: String(imageUrl), path: pathname };
      }
      return failure('missing-or-unpublishable-image-credit', imageUrl, { path: pathname });
    }
    return {
      valid: true,
      source: 'image-credits',
      url: String(imageUrl),
      path: pathname,
      record,
    };
  }

  if (origin === IMAGE_CDN_ORIGIN && cdnPrefixForPath(pathname)) {
    return failure('unrecorded-cdn-prefix', imageUrl, { path: pathname });
  }
  return failure('unsupported-image-prefix', imageUrl, { path: pathname });
}

/** Check the explicit site-owned exception list used by the OG build gate. */
export function checkOwnedOgImage(imageUrl, options = {}) {
  const value = String(imageUrl || '');
  if (SITE_OWNED_OG_IMAGE_ALLOWLIST.some((prefix) => value === prefix || value.startsWith(prefix))) {
    return { valid: true, source: 'site-owned-og-allowlist', url: value };
  }
  return checkPublishedImageUrl(value, options);
}

function readRegistryFile(filePath, { scope, warn }) {
  if (!fs.existsSync(filePath)) return { records: [], error: null };
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    const validation = validateGeneratedImageRegistry(parsed, scope ? { scope } : {});
    if (!validation.valid) {
      const error = `${filePath}: ${validation.errors.join('; ')}`;
      warn(`[published-image-policy] ${error}`);
      return { records: [], error };
    }
    return { records: Array.isArray(parsed) ? parsed : parsed.assets, error: null };
  } catch (error) {
    const message = `${filePath}: unreadable registry (${error.message})`;
    warn(`[published-image-policy] ${message}`);
    return { records: [], error: message };
  }
}

/**
 * Load the site's local registries for Node uploaders and CI gates. Missing
 * optional registries are fine; a present but invalid registry is fail-closed.
 */
export function loadPublishedImagePolicy({ root = process.cwd(), warn = console.warn } = {}) {
  const registrySpecs = [
    { path: path.join(root, 'data', 'event-image-library.json'), scope: 'event-library' },
    { path: path.join(root, 'data', 'generated-image-registry.json') },
    { path: path.join(root, 'public', 'data', 'generated-image-registry.json') },
  ];
  const records = [];
  const registryErrors = [];
  for (const spec of registrySpecs) {
    const result = readRegistryFile(spec.path, { scope: spec.scope, warn });
    records.push(...result.records);
    if (result.error) registryErrors.push(result.error);
  }

  const imageCreditReader = createImageCreditReader(
    fs,
    [
      path.join(root, 'packages', 'articles', 'content', 'image-credits'),
      path.join(root, 'content', 'image-credits'),
    ],
    { warn },
  );
  const check = (imageUrl, options = {}) => checkPublishedImageUrl(imageUrl, {
    ...options,
    records,
    imageCreditReader,
    // Never for an uploader, whatever the caller passes.
    inferredCovers: null,
  });
  const inferredCovers = loadInferredCoverDecisions({ root });
  const checkOg = (imageUrl) => checkOwnedOgImage(imageUrl, { records, imageCreditReader, inferredCovers });
  return { records, imageCreditReader, registryErrors, check, checkOg };
}
