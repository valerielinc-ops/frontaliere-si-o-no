/**
 * Hreflang index manifest — which URLs may take part in a hreflang cluster.
 *
 * Why this exists
 * ---------------
 * The build's own hreflang pass (`transformHreflang`,
 * packages/articles/engine/hreflangPostprocess.ts) answers ONE question:
 * "does a file exist at the target path?". Two others stay unanswered:
 *
 *   1. Is the target a page Google may index — no `noindex`, canonical on
 *      itself? An alternate pointing at a `noindex` page, or at a page whose
 *      canonical goes somewhere else, is ignored by Google and breaks the
 *      cluster for every member.
 *   2. Is the target cluster RECIPROCAL — does the target declare the same
 *      set of alternates back? A one-way alternate is ignored too.
 *
 * And on a `BUILD_LOCALE` shard even the first question is skipped for every
 * alternate whose locale the shard does not emit (`!shouldEmitLocale → keep`),
 * so an IT page links to EN/DE/FR targets nobody checked.
 *
 * The manifest
 * ------------
 * One entry per page that is eligible as a hreflang member, keyed by URL path
 * (leading slash, no trailing slash): `entries[path] = clusterKey`.
 *   - eligible = no `noindex` in `<meta name="robots|googlebot">` AND the
 *     canonical (when present) is the page itself. Read from the FINAL HTML in
 *     `dist/`, so it reflects whatever indexability rules the emitters applied
 *     — it never re-derives them.
 *   - clusterKey = hash of the page's own `hreflang → path` set, x-default
 *     excluded. Two pages are reciprocal members of one cluster exactly when
 *     both are eligible and their keys are equal: each lists the other, and
 *     they agree on every other member.
 *
 * The key is computed from the HTML BEFORE this pass rewrites anything, so a
 * strip decided here never feeds into the next run's manifest (no deadlock: a
 * cluster stripped once because a member was new is restored as soon as every
 * member is in the manifest).
 *
 * The decision
 * ------------
 * A hreflang block is kept only when the page is eligible, the page is a
 * member of its own block, and every member that can be judged is eligible
 * with the same clusterKey. Otherwise the WHOLE block goes — not the single
 * offending entry: every member makes the same judgement on the same members,
 * so they all drop together and the survivors stay reciprocal, and
 * `audit:hreflang` requires the full 4 locales + x-default once any hreflang
 * is present (a thinned block only trades `missingTarget` for `tooFew`).
 * A kept block gets an x-default equal to its IT member.
 *
 * A member is NOT judged (kept as today) when no manifest can speak for it:
 * a section served outside this build (article shards), a foreign host, or a
 * locale whose manifest is not available to this run. Those counts are printed
 * on every run, never silent.
 *
 * Pure module: no filesystem access. The CLI is
 * scripts/ci/hreflang-index-manifest.mjs.
 */

import { createHash } from 'node:crypto';
import { readAttr } from './html-attr.mjs';
import { isExternallyServedPath } from './externally-served-paths.mjs';

export const HREFLANG_INDEX_MANIFEST_VERSION = 1;
export const MANIFEST_LOCALES = Object.freeze(['it', 'en', 'de', 'fr']);
export const DEFAULT_BASE_URL = 'https://frontaliereticino.ch';

/**
 * One pass over the `<head>`: script bodies and comments are matched (and
 * skipped) as whole tokens, so a `<link>` written inside inline JS or a
 * comment is never read as live markup. Group 1 = tag name of a live
 * `<link>`/`<meta>` start tag.
 */
const HEAD_TOKEN_RE = /<script\b[\s\S]*?<\/script\s*>|<!--[\s\S]*?-->|<(link|meta)\b[^>]*>/gi;
const HEAD_END_RE = /<\/head\s*>/i;

/** Map a URL path to the locale subtree that serves it. */
export function localeOfPath(urlPath) {
  const m = /^\/(en|de|fr)(?:\/|$)/.exec(urlPath);
  return m ? m[1] : 'it';
}

function safeDecode(value) {
  try {
    return decodeURI(value);
  } catch {
    return value;
  }
}

/** Normalise a URL path: leading slash, no trailing slash, `/` for the root. */
export function normalizeUrlPath(pathname) {
  let p = String(pathname || '');
  const q = p.indexOf('?');
  if (q !== -1) p = p.slice(0, q);
  const h = p.indexOf('#');
  if (h !== -1) p = p.slice(0, h);
  p = p.replace(/\/+$/, '');
  if (p === '') return '/';
  return p.startsWith('/') ? p : `/${p}`;
}

/**
 * Own-host URL → normalised path; `null` for any other host or an unparsable
 * href (such a member cannot be judged by this site's manifest).
 */
export function sitePathOf(href, baseUrl = DEFAULT_BASE_URL) {
  if (typeof href !== 'string' || href.trim() === '') return null;
  let url;
  try {
    url = new URL(href.trim().replace(/&amp;/g, '&'), baseUrl);
  } catch {
    return null;
  }
  if (url.origin !== new URL(baseUrl).origin) return null;
  return normalizeUrlPath(safeDecode(url.pathname));
}

function relTokens(raw) {
  return readAttr(raw, 'rel').toLowerCase().split(/\s+/).filter(Boolean);
}

/**
 * Parse the hreflang-relevant head metadata of one page.
 *
 * `alternates[].index/end` are offsets into `html`, so the same parse drives
 * the rewrite.
 */
export function parseHreflangHead(html) {
  const source = String(html || '');
  const headEnd = source.search(HEAD_END_RE);
  const head = headEnd === -1 ? source : source.slice(0, headEnd);
  let noindex = false;
  let canonical = null;
  const alternates = [];
  HEAD_TOKEN_RE.lastIndex = 0;
  let m;
  while ((m = HEAD_TOKEN_RE.exec(head)) !== null) {
    const tag = m[1];
    if (!tag) continue;
    const raw = m[0];
    if (tag.toLowerCase() === 'meta') {
      const name = readAttr(raw, 'name').toLowerCase();
      if (name !== 'robots' && name !== 'googlebot') continue;
      const content = readAttr(raw, 'content').toLowerCase();
      if (/(?:^|[\s,])(?:noindex|none)(?:$|[\s,])/.test(content)) noindex = true;
      continue;
    }
    const rels = relTokens(raw);
    if (rels.includes('canonical')) {
      if (canonical === null) canonical = readAttr(raw, 'href');
      continue;
    }
    if (!rels.includes('alternate')) continue;
    const hreflang = readAttr(raw, 'hreflang').trim();
    const href = readAttr(raw, 'href').trim();
    if (!hreflang || !href) continue;
    alternates.push({ hreflang, href, index: m.index, end: m.index + raw.length });
  }
  return { noindex, canonical, alternates };
}

/** Stable identity of a page's hreflang set (x-default excluded). */
export function clusterKeyOf(members) {
  const parts = members
    .map((m) => `${m.hreflang.toLowerCase()}=${m.path ?? `!${m.href.toLowerCase()}`}`)
    .sort();
  return createHash('sha1').update(parts.join('\n')).digest('hex').slice(0, 16);
}

/**
 * Classify one page from its (head) HTML.
 *
 * @param {string} html
 * @param {string} urlPath  normalised URL path the file serves
 * @param {{ baseUrl?: string }} [options]
 */
export function classifyHreflangPage(html, urlPath, { baseUrl = DEFAULT_BASE_URL } = {}) {
  const parsed = parseHreflangHead(html);
  const self = normalizeUrlPath(urlPath);
  let reason = 'eligible';
  if (parsed.noindex) reason = 'page-noindex';
  else if (parsed.canonical !== null && parsed.canonical.trim() !== '') {
    if (sitePathOf(parsed.canonical, baseUrl) !== self) reason = 'page-canonical-elsewhere';
  }
  const members = [];
  let xDefault = null;
  for (const alt of parsed.alternates) {
    const entry = { hreflang: alt.hreflang, href: alt.href, path: sitePathOf(alt.href, baseUrl) };
    if (alt.hreflang.toLowerCase() === 'x-default') {
      if (xDefault === null) xDefault = entry;
    } else {
      members.push(entry);
    }
  }
  return {
    path: self,
    eligible: reason === 'eligible',
    reason,
    hasHreflang: parsed.alternates.length > 0,
    members,
    xDefault,
    clusterKey: members.length > 0 ? clusterKeyOf(members) : '',
  };
}

/**
 * Decide what happens to one page's hreflang block.
 *
 * @param {ReturnType<typeof classifyHreflangPage>} page
 * @param {(locale: string, path: string) =>
 *   { status: 'eligible', key: string } | { status: 'absent' } | { status: 'unknown', reason: string }} lookup
 * @returns {{ action: 'none' | 'keep' | 'strip', reason: string,
 *   xDefault: null | { op: 'insert' | 'rewrite' | 'remove', href?: string },
 *   unknown: string[] }}
 */
export function decideHreflangBlock(page, lookup) {
  const unknown = [];
  if (!page.hasHreflang) return { action: 'none', reason: 'no-hreflang', xDefault: null, unknown };
  if (!page.eligible) return { action: 'strip', reason: page.reason, xDefault: null, unknown };
  if (page.members.length === 0) {
    return { action: 'strip', reason: 'page-not-member', xDefault: null, unknown };
  }
  if (!page.members.some((m) => m.path === page.path)) {
    return { action: 'strip', reason: 'page-not-member', xDefault: null, unknown };
  }
  const seenCodes = new Map();
  for (const member of page.members) {
    const code = member.hreflang.toLowerCase();
    const previous = seenCodes.get(code);
    if (previous !== undefined && previous !== (member.path ?? member.href)) {
      return { action: 'strip', reason: 'duplicate-hreflang', xDefault: null, unknown };
    }
    seenCodes.set(code, member.path ?? member.href);
  }
  // A block is valid only for the complete, exact four-locale contract.  The
  // size check alone would allow four unknown codes; the explicit membership
  // checks reject both partial clusters and extra/unknown locale codes.
  const expectedCodes = new Set(MANIFEST_LOCALES);
  if (seenCodes.size !== expectedCodes.size
    || MANIFEST_LOCALES.some((locale) => !seenCodes.has(locale))
    || [...seenCodes.keys()].some((code) => !expectedCodes.has(code))) {
    return { action: 'strip', reason: 'incomplete-locale-set', xDefault: null, unknown };
  }
  for (const member of page.members) {
    if (member.path === page.path) continue;
    if (member.path === null) {
      unknown.push('foreign-host');
      continue;
    }
    if (isExternallyServedPath(member.path)) {
      unknown.push('externally-served');
      continue;
    }
    const verdict = lookup(localeOfPath(member.path), member.path);
    if (verdict.status === 'unknown') {
      unknown.push(verdict.reason);
      continue;
    }
    if (verdict.status === 'absent') {
      return { action: 'strip', reason: 'member-not-indexable', xDefault: null, unknown };
    }
    if (verdict.key !== page.clusterKey) {
      return { action: 'strip', reason: 'member-not-reciprocal', xDefault: null, unknown };
    }
  }

  const itMember = page.members.find((m) => m.hreflang.toLowerCase() === 'it');
  let xDefault = null;
  if (itMember) {
    if (page.xDefault === null) xDefault = { op: 'insert', href: itMember.href };
    else if (page.xDefault.path !== itMember.path) xDefault = { op: 'rewrite', href: itMember.href };
  } else if (page.xDefault !== null && !page.members.some((m) => m.path === page.xDefault.path)) {
    xDefault = { op: 'remove' };
  }
  return { action: 'keep', reason: xDefault ? `x-default-${xDefault.op}` : 'kept', xDefault, unknown };
}

function escapeAttr(value) {
  return String(value).replace(/&(?!amp;|quot;|lt;|gt;|#)/g, '&amp;').replace(/"/g, '&quot;');
}

function removeRange(html, index, end) {
  const trailingNl = html.charCodeAt(end) === 10 ? 1 : 0;
  return html.slice(0, index) + html.slice(end + trailingNl);
}

/**
 * Apply a decision to the full HTML of the page. Returns `null` when the
 * document does not change.
 */
export function applyHreflangDecision(html, decision) {
  if (decision.action === 'none') return null;
  if (decision.action === 'keep' && decision.xDefault === null) return null;
  const { alternates } = parseHreflangHead(html);
  if (alternates.length === 0) return null;
  let out = html;
  if (decision.action === 'strip') {
    for (let i = alternates.length - 1; i >= 0; i--) {
      out = removeRange(out, alternates[i].index, alternates[i].end);
    }
    return out === html ? null : out;
  }
  const xIndex = alternates.findIndex((a) => a.hreflang.toLowerCase() === 'x-default');
  const op = decision.xDefault.op;
  if (op === 'remove') {
    if (xIndex === -1) return null;
    out = removeRange(out, alternates[xIndex].index, alternates[xIndex].end);
  } else {
    const tag = `<link rel="alternate" hreflang="x-default" href="${escapeAttr(decision.xDefault.href)}">`;
    if (op === 'rewrite' && xIndex !== -1) {
      out = out.slice(0, alternates[xIndex].index) + tag + out.slice(alternates[xIndex].end);
    } else {
      const last = alternates[alternates.length - 1];
      out = out.slice(0, last.end) + tag + out.slice(last.end);
    }
  }
  return out === html ? null : out;
}

/** Serialise one locale's manifest. `entries` is a Map path → clusterKey. */
export function serializeHreflangManifest({ locale, entries, runId = '', generatedAt = new Date().toISOString() }) {
  const sorted = [...entries.keys()].sort();
  const obj = {};
  for (const key of sorted) obj[key] = entries.get(key);
  return JSON.stringify({
    version: HREFLANG_INDEX_MANIFEST_VERSION,
    locale,
    runId: String(runId || ''),
    generatedAt,
    complete: true,
    entryCount: sorted.length,
    entries: obj,
  });
}

/**
 * Parse a manifest written by {@link serializeHreflangManifest}. Returns
 * `{ error }` for anything that is not a complete manifest of `locale`: an
 * incomplete manifest would call live pages absent, so it must never be used.
 */
export function parseHreflangManifest(text, locale) {
  let data;
  try {
    data = JSON.parse(text);
  } catch (error) {
    return { error: `unparsable (${error instanceof Error ? error.message : String(error)})` };
  }
  if (!data || typeof data !== 'object') return { error: 'not an object' };
  if (data.version !== HREFLANG_INDEX_MANIFEST_VERSION) return { error: `version ${data.version}` };
  if (data.locale !== locale) return { error: `locale ${data.locale} != ${locale}` };
  if (data.complete !== true) return { error: 'not complete' };
  if (!data.entries || typeof data.entries !== 'object') return { error: 'no entries' };
  const entries = new Map(Object.entries(data.entries));
  if (entries.size !== data.entryCount) return { error: `entryCount ${data.entryCount} != ${entries.size}` };
  if (entries.size === 0) return { error: 'empty' };
  return { entries, runId: String(data.runId || ''), generatedAt: String(data.generatedAt || '') };
}
