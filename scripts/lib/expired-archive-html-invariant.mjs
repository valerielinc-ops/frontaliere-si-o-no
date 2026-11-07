import crypto from 'node:crypto';
import {
  CDN_OFFLOAD_ASSET_FILE_PATTERN,
  CDN_OFFLOAD_DATA_FILE_PATTERN,
  CDN_OFFLOAD_IMAGE_FILE_PATTERN,
  CDN_OFFLOADED_IMAGE_TARGETS,
} from '../../build-plugins/shared/cdnOffloadTargets.mjs';
import { CDN_ASSET_ORIGIN } from '../../build-plugins/shared/cdnAssetOffloadRx.mjs';

const SITE_ORIGIN = 'https://frontaliereticino.ch';

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function rewriteKnownCdnReferences(html) {
  const rules = [
    { prefix: '/assets/', file: CDN_OFFLOAD_ASSET_FILE_PATTERN },
    { prefix: '/data/', file: CDN_OFFLOAD_DATA_FILE_PATTERN },
    ...CDN_OFFLOADED_IMAGE_TARGETS.map(({ url: prefix }) => ({
      prefix,
      file: CDN_OFFLOAD_IMAGE_FILE_PATTERN,
    })),
  ];
  let normalized = html;
  for (const { prefix, file } of rules) {
    const escapedPrefix = escapeRegExp(prefix);
    const absolute = new RegExp(`${escapeRegExp(SITE_ORIGIN)}${escapedPrefix}${file}`, 'g');
    const relative = new RegExp(`(?<![\\w.@])${escapedPrefix}${file}`, 'g');
    const replace = (_match, resourcePath) => `${CDN_ASSET_ORIGIN}${prefix}${resourcePath}`;
    normalized = normalized.replace(absolute, replace).replace(relative, replace);
  }
  return normalized;
}

function removeGeneratedCdnBootstrapFromHead(html) {
  const opening = /<head\b[^>]*>/iu.exec(html);
  if (!opening) return html;
  const contentStart = opening.index + opening[0].length;
  const closing = /<\/head\s*>/iu.exec(html.slice(contentStart));
  const contentEnd = closing ? contentStart + closing.index : html.length;
  const head = html.slice(contentStart, contentEnd);
  const escapedOrigin = escapeRegExp(CDN_ASSET_ORIGIN);
  const marker = new RegExp(`<script>window\\.__CDN_DATA_BASE__="${escapedOrigin}"<\\/script>`, 'g');
  return html.slice(0, contentStart) + head.replace(marker, '') + html.slice(contentEnd);
}

/**
 * Hash HTML after applying only the deterministic deploy-time CDN rewrites.
 * Every other byte, including page body, canonical, title, description and
 * robots directives, remains part of the digest. The Hreflang result is
 * refreshed into the evidence after its own decision pass.
 */
export function expiredArchiveCdnInvariantSha256(html) {
  const source = String(html ?? '');
  const normalized = removeGeneratedCdnBootstrapFromHead(rewriteKnownCdnReferences(source));
  return sha256(normalized);
}
