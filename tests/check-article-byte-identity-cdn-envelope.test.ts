/**
 * Pins the deploy-boundary normalization in
 * scripts/check-article-byte-identity.mjs (#10072).
 *
 * A fast audit render runs the same CDN offload pass as a deploy, while the
 * live page can belong to the previous generation. The comparison may ignore
 * only the exact active-head envelope for the canonical origin. Article
 * content, a wrong runtime base, and marker-shaped text in non-active HTML
 * must remain visible.
 */
import { describe, it, expect } from 'vitest';
import { CDN_ASSET_ORIGIN } from '../build-plugins/shared/cdnAssetOffloadRx.mjs';
import {
  canonicalizeCdnDataEnvelope,
  canonicalizeForComparison,
} from '../scripts/check-article-byte-identity.mjs';

const page = (head: string, body = '<p>corpo</p>') =>
  `<!doctype html>\n<html lang="it">\n<head>\n${head}\n</head>\n<body>\n${body}\n</body>\n</html>\n`;

const CDN_SCRIPT = `<script>window.__CDN_DATA_BASE__="${CDN_ASSET_ORIGIN}"</script>`;
const PRECONNECT = `<link rel="preconnect" href="${CDN_ASSET_ORIGIN}" crossorigin>`;
const DNS_PREFETCH = `<link rel="dns-prefetch" href="${CDN_ASSET_ORIGIN}">`;
const ENVELOPE = `${PRECONNECT}${DNS_PREFETCH}${CDN_SCRIPT}`;

describe('canonicalizeCdnDataEnvelope — deployment boundary only', () => {
  it('makes the real fast/live shape compare equal when only the envelope differs', () => {
    const fast = page(`<meta charset="utf-8">${ENVELOPE}<title>Articolo</title>`);
    const live = page('<meta charset="utf-8"><title>Articolo</title>');

    expect(fast).not.toBe(live);
    expect(canonicalizeCdnDataEnvelope(fast)).toBe(live);
  });

  it('handles the optional hint pair and the data-base script independently', () => {
    const withoutHints = page(CDN_SCRIPT);
    const withoutScript = page(`${PRECONNECT}${DNS_PREFETCH}`);
    const empty = page('');

    expect(canonicalizeCdnDataEnvelope(withoutHints)).toBe(empty);
    expect(canonicalizeCdnDataEnvelope(withoutScript)).toBe(empty);
  });

  it('keeps a wrong or changed CDN runtime value as a mismatch', () => {
    const wrongOrigin = page(
      '<script>window.__CDN_DATA_BASE__="https://cdn.example.test"</script>',
    );
    const changedPath = page(
      `<script>window.__CDN_DATA_BASE__="${CDN_ASSET_ORIGIN}/stale"</script>`,
    );

    expect(canonicalizeCdnDataEnvelope(wrongOrigin)).toBe(wrongOrigin);
    expect(canonicalizeCdnDataEnvelope(changedPath)).toBe(changedPath);
  });

  it('does not remove marker-shaped text from comments, templates, body, or another script', () => {
    const comment = `<!--${CDN_SCRIPT}-->`;
    const template = `<template>${CDN_SCRIPT}</template>`;
    const bodyScript = page('', `<div>${CDN_SCRIPT}</div>`);
    const nonEnvelopeHead = page(`${comment}${template}<script>const marker = '${CDN_SCRIPT}'</script>`);

    expect(canonicalizeCdnDataEnvelope(bodyScript)).toBe(bodyScript);
    expect(canonicalizeCdnDataEnvelope(nonEnvelopeHead)).toBe(nonEnvelopeHead);
  });

  it('fails closed for duplicate or malformed active assignments', () => {
    const duplicate = page(`${CDN_SCRIPT}${CDN_SCRIPT}`);
    const malformed = page(`<script>window.__CDN_DATA_BASE__="${CDN_ASSET_ORIGIN}"`);

    expect(canonicalizeCdnDataEnvelope(duplicate)).toBe(duplicate);
    expect(canonicalizeCdnDataEnvelope(malformed)).toBe(malformed);
  });

  it('composes with the existing meta and robots order normalizations', () => {
    const fast = page(
      `${ENVELOPE}<meta property="og:title" content="Titolo"><meta name="robots" content="index, follow">`,
    );
    const live = page(
      '<meta name="robots" content="follow, index"><meta property="og:title" content="Titolo">',
    );

    expect(canonicalizeForComparison(fast)).toBe(canonicalizeForComparison(live));
  });
});
