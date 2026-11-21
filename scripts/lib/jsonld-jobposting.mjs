#!/usr/bin/env node
/**
 * Shared schema.org/JobPosting JSON-LD extraction for career boards that embed
 * a clean `<script type="application/ld+json">` JobPosting on each detail page
 * (e.g. the Swiss Medical Network board at jobs.spitalzofingen.ch). One helper
 * so every JSON-LD board maps the same fields the same way.
 */
import { decodeEntities, normalizeSpace } from './hospital-custom-html-helpers.mjs';
import { extractJobPostingNodesFromJson } from './jobposting-jsonld.mjs';

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
    postings.push(...extractJobPostingNodesFromJson(data));
  }
  return postings;
}

function postingIdentityKey(value = '') {
  return normalizeSpace(String(value || ''))
    .toLowerCase()
    .normalize('NFKC')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

function postingUrlKey(value = '', baseUrl = '') {
  if (!value) return '';
  try {
    const url = new URL(String(value), baseUrl || undefined);
    return `${url.origin}${url.pathname.replace(/\/$/, '')}`.toLowerCase();
  } catch {
    return '';
  }
}

/**
 * Select the JobPosting that identifies the current vacancy.
 *
 * Detail pages may include related-job JSON-LD blocks before the current
 * vacancy. A single candidate is safe after the caller's detail boundary has
 * accepted the page; when there are several candidates, require the current
 * URL or exact normalized title instead of silently trusting the first node.
 */
export function selectJobPostingLd(postings, { title = '', url = '' } = {}) {
  const candidates = Array.isArray(postings) ? postings.filter(Boolean) : [];
  if (candidates.length === 0) return null;
  if (candidates.length === 1) return candidates[0];

  const expectedUrl = postingUrlKey(url, url);
  if (expectedUrl) {
    const byUrl = candidates.filter((posting) => postingUrlKey(posting.url, url) === expectedUrl);
    if (byUrl.length === 1) return byUrl[0];
  }

  const expectedTitle = postingIdentityKey(title);
  if (expectedTitle) {
    const byTitle = candidates.filter((posting) => postingIdentityKey(posting.title) === expectedTitle);
    if (byTitle.length === 1) return byTitle[0];
  }

  return null;
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
