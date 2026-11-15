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
  canonicalizeHeadInterTagWhitespace,
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

  it('removes envelope indentation without leaving a false head diff', () => {
    const fast = page(
      `<meta charset="utf-8">\n ${PRECONNECT}${DNS_PREFETCH}${CDN_SCRIPT}\n <title>Articolo</title>`,
    );
    const live = page('<meta charset="utf-8">\n <title>Articolo</title>');

    expect(canonicalizeCdnDataEnvelope(fast)).toBe(live);
  });

  it('keeps adjacent head tags separated when the envelope was injected contiguously', () => {
    const fast = page(
      `<meta charset="utf-8">${ENVELOPE}<meta name="description" content="Articolo">`,
    );
    const live = page(
      `<meta charset="utf-8">\n <meta name="description" content="Articolo">`,
    );

    expect(canonicalizeForComparison(fast)).toBe(canonicalizeForComparison(live));
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

describe('canonicalizeHeadInterTagWhitespace — top-level head boundaries only', () => {
  it('does not rewrite raw text, templates, nested nodes, attributes, or body content', () => {
    const html = page(
      '<title>  Titolo\n  </title>\n'
      + '<script>const value = ">\n<";</script>\n'
      + '<template>\n <meta name="description" content="template">\n </template>\n'
      + '<noscript>\n <link rel="stylesheet" href="/no-script.css">\n </noscript>\n'
      + '<meta name="description" content="live">',
      '<div>\n <span>corpo</span>\n </div>',
    );

    const normalized = canonicalizeHeadInterTagWhitespace(html);

    expect(normalized).toContain('<title>  Titolo\n  </title>');
    expect(normalized).toContain('<script>const value = ">\n<";</script>');
    expect(normalized).toContain('<template>\n <meta name="description" content="template">\n </template>');
    expect(normalized).toContain('<noscript>\n <link rel="stylesheet" href="/no-script.css">\n </noscript>');
    expect(normalized).toContain('<div>\n <span>corpo</span>\n </div>');
  });

  it('fails closed when the head contains unbalanced markup', () => {
    const malformed = page('<noscript>\n <link rel="stylesheet" href="/x.css">');
    expect(canonicalizeHeadInterTagWhitespace(malformed)).toBe(malformed);
  });
});
