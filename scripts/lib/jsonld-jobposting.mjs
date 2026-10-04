#!/usr/bin/env node
/**
 * Shared schema.org/JobPosting JSON-LD extraction for career boards that embed
 * a clean `<script type="application/ld+json">` JobPosting on each detail page
 * (e.g. the Swiss Medical Network board at jobs.spitalzofingen.ch). One helper
 * so every JSON-LD board maps the same fields the same way.
 */
import { decodeEntities, normalizeSpace } from './hospital-custom-html-helpers.mjs';

/** Collect JobPosting objects across all JSON-LD blocks in `html`. */
export function extractJobPostingsLd(html) {
  if (!html || typeof html !== 'string') return [];
  const postings = [];
  const rx = /<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  let m;
  while ((m = rx.exec(html))) {
    let data;
    try {
      // Strip a leading UTF-8 BOM and raw control chars some boards leave in JSON.
      data = JSON.parse(m[1].replace(/^﻿/, '').replace(/[\x00-\x1F]/g, ' '));
    } catch {
      continue;
    }
    const items = Array.isArray(data) ? data : (Array.isArray(data?.['@graph']) ? data['@graph'] : [data]);
    for (const it of items) {
      const t = it?.['@type'];
      if (t === 'JobPosting' || (Array.isArray(t) && t.includes('JobPosting'))) postings.push(it);
    }
  }
  return postings;
}

/** Find the first JobPosting object; preserves the existing caller contract. */
export function extractJobPostingLd(html) {
  return extractJobPostingsLd(html)[0] ?? null;
}

/** HTML description → plain text with bullets preserved. */
export function jobPostingDescriptionText(rawDescription = '') {
  let text = String(rawDescription || '')
    .replace(/<li[^>]*>/gi, '\n• ')
    .replace(/<\/li\s*>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|h[1-6]|ul)\s*>/gi, '\n')
    .replace(/<[^>]+>/g, ' ');
  text = decodeEntities(text).replace(/[ \t]+/g, ' ').replace(/\n{2,}/g, '\n').trim();
  return text;
}

/** Pull the flat address fields out of a JobPosting `jobLocation`. */
export function jobPostingAddress(ld) {
  const loc = Array.isArray(ld?.jobLocation) ? ld.jobLocation[0] : ld?.jobLocation;
  const addr = loc?.address || {};
  return {
    addressLocality: normalizeSpace(String(addr.addressLocality || '')),
    addressRegion: normalizeSpace(String(addr.addressRegion || '')),
    streetAddress: normalizeSpace(String(addr.streetAddress || '')),
    postalCode: normalizeSpace(String(addr.postalCode || '')),
  };
}
