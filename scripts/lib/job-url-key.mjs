/**
 * Canonical URL-key normalization for job identity — single source of truth.
 *
 * Historically the same job URL was normalized THREE different ways at three
 * call sites, and the subtle divergences silently dropped/mismatched jobs:
 *
 *   1. mergeUrlKey      — crawl-time MERGE key (was extractStableJobId,
 *                         scripts/lib/job-match-key.mjs). Decodes &amp; and
 *                         extracts the most stable token so vendor slug
 *                         renames don't fragment the match.
 *   2. assembleUrlKey   — assemble-time DEDUP key (was the inline URL branch
 *                         of assemblerIdentity in assemble-jobs-dataset.mjs).
 *                         Preserves the FULL raw URL including hash fragments.
 *   3. identityUrlKey   — stats/diff/firstSeenAt identity (was
 *                         normalizeIdentityUrl in scripts/lib/job-identity.mjs).
 *                         Parses the URL and STRIPS the hash + default ports.
 *
 * The three diverge ON PURPOSE in places — most notably hash handling:
 *   • assembleUrlKey PRESERVES `#job.id=NNN` (Galenica encodes distinct
 *     positions in the fragment — stripping it would collapse them into one).
 *   • identityUrlKey STRIPS the hash (stats/diff treat the canonical page,
 *     not the fragment, as the identity).
 *   • mergeUrlKey extracts a stable token (UUID / long numeric / long hex)
 *     and only falls back to the full URL, so it ignores hash differences
 *     whenever a stable token exists.
 *
 * Centralizing all three here makes those divergences visible in ONE place
 * and turns a future convergence (a single written identity) into a localized,
 * test-gated change rather than a hunt across the codebase. See
 * docs/CRAWLER-OUTPUT-NORMALIZATION.md for the convergence study.
 *
 * ⚠️  These are PERSISTED dedup/merge keys. Do NOT change the observable
 * output of any exported variant without a gated re-key migration — a silent
 * change re-keys every existing job and can cause mass slug churn. Every
 * variant's output is pinned byte-for-byte by tests/job-url-key.test.ts.
 */

const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
const NUM_ID_RE = /\b\d{6,}\b/;
const HEX_TOKEN_RE = /\b[0-9a-f]{10,}\b/i;

// Workday job URLs (`*.myworkdayjobs.com`) follow `…/job/<Location>/<Title>_<req>`
// where <Title> is hyphen-slugified (never `_`) and the requisition id is the
// stable per-job token, e.g.
//   …/job/Sion/Conseiller-en-immobilier-…-Sierre-_R11696
// The vendor requisition format varies wildly across the ~29 tenants in the
// corpus — `R11696`, `JR123456`, `SJR987`, `R-0002527`, `REQ-16005`, `R26_173`,
// pure-numeric `31138417`, each optionally with a `-N` re-posting suffix — so
// instead of enumerating formats (and missing the next one) we take EVERYTHING
// after the FIRST underscore in the leaf, which is the title↔req separator. A
// digit is required so a stray non-req underscore can't be mistaken for an id.
// Host-gated so no other crawler's key changes. The `-N`/`_N` re-posting suffix
// is kept (distinct postings of the same req must not collapse onto one id).
const WORKDAY_HOST_RE = /(?:^|\/\/)[^/]*\.myworkdayjobs\.com(?:[:/]|$)/;

/**
 * Workday requisition id = the leaf substring after its FIRST underscore (the
 * title↔req separator), lowercased. Returns '' when the leaf has no underscore,
 * nothing follows it, or the suffix carries no digit (so it isn't a requisition).
 * Shared by mergeUrlKey Rule W and extractJobIdentityFromUrl so both derive the
 * SAME stable Workday id (one definition, no drift).
 * @param {string} leaf - path leaf (last `/`-separated segment, no query/hash)
 * @returns {string}
 */
export function workdayReqFromLeaf(leaf) {
  const s = String(leaf || '');
  const i = s.indexOf('_');
  if (i < 0 || i === s.length - 1) return '';
  const req = s.slice(i + 1).toLowerCase();
  return /\d/.test(req) ? req : '';
}

export { WORKDAY_HOST_RE };

// Umantis job urls: recruitingapp-<tenantId>.umantis.com/Vacancies/<id>/Description/<lang>
// Tenant lives in the subdomain; host-gated so no other crawler's key changes.
const UMANTIS_HOST_RE = /(?:^|\/\/)recruitingapp-\d+\.umantis\.com(?:[:/]|$)/;

// A path leaf that is a generic directory-index page (apply.refline.ch ends
// every job at `…/<companyId>/<jobId>/pub/1/index.html`) — the only extractable
// token is the shared companyId, so the per-job identity is the whole URL.
const GENERIC_LEAF_RE = /^(?:index|default)\.(?:html?|php|aspx?)$/i;
// A path leaf that is a downloadable document (Weebly/Drupal upload folders host
// every PDF under one shared numeric site/folder id, e.g.
// `…/146598773/segretaria_legale_.pdf`). `%20`-encoded spaces next to a year can
// even synthesise a fake ≥6-digit "id" (`…EFZ%202027.pdf` → `202027`). Identity
// is the whole URL (the distinct filename), never the ancestor folder token.
const FILE_LEAF_RE = /\.(?:pdf|docx?|xlsx?|pptx?|rtf|txt|odt)$/i;

// A per-job id carried in the QUERY string behind a generic/file leaf
// (`…/index.html?id=NNN`, `…/apply.php?jobId=ABC123`). Anchored to a query-param
// boundary (`[?&]`) so a SHARED ancestor param — `cid=`/`companyId=` (refline
// keys every job under one `?cid=101`) — is never mistaken for the per-job id:
// `[?&]id=` cannot match `cid=` (the `c` breaks the `?`/`&` adjacency). Capturing
// `jobId`/`offerId`/`positionId`/bare `id` only; `cid`/`companyId`/`team` are NOT
// per-job tokens and must fall through to the whole-URL identity.
const QUERY_JOB_ID_RE = /[?&](?:job[_-]?id|offer[_-]?id|position[_-]?id|id)=([^&#]+)/i;

/**
 * Per-job token extracted from a query `id=`/`jobId=` param, classified with the
 * same UUID → ≥6-digit → ≥10-hex priority as the rest of the module. Returns ''
 * when the query carries no per-job id param or its value holds no stable token.
 * @param {string} u - already-normalized URL string
 * @returns {string}
 */
function queryJobToken(u) {
  const m = u.match(QUERY_JOB_ID_RE);
  if (!m) return '';
  const val = m[1];
  const uuid = val.match(UUID_RE);
  if (uuid) return `uuid:${uuid[0]}`;
  const num = val.match(NUM_ID_RE);
  if (num) return `num:${num[0]}`;
  const hex = val.match(HEX_TOKEN_RE);
  if (hex) return `hex:${hex[0]}`;
  return '';
}

/**
 * Legacy leftmost-token scan: the first UUID → first ≥6-digit run → first ≥10
 * hex run anywhere in the normalized URL, else the full URL. Retained verbatim
 * as the Rule C fallback so every key whose id lives in the query, fragment, or
 * an ancestor segment (and whose leaf carries no token) is preserved byte-for-byte.
 * @param {string} u - already-normalized URL string
 * @returns {string}
 */
function legacyMergeToken(u) {
  const uuid = u.match(UUID_RE);
  if (uuid) return `uuid:${uuid[0]}`;
  const num = u.match(NUM_ID_RE);
  if (num) return `num:${num[0]}`;
  const hex = u.match(HEX_TOKEN_RE);
  if (hex) return `hex:${hex[0]}`;
  return `url:${u}`;
}

/**
 * Shared low-level normalizer: trim → strip trailing slashes → lowercase.
 * Slash-strip and lowercase commute, so callers may compose in either order.
 * @param {string} url
 * @returns {string}
 */
export function lowerStripTrailingSlash(url) {
  return String(url || '').trim().replace(/\/+$/, '').toLowerCase();
}

/**
 * Variant 1 — crawl-time MERGE key.
 *
 * Decodes `&amp;`, strips trailing slashes, lowercases, then extracts the most
 * stable token so a vendor slug rename doesn't change the key:
 *   UUID → long numeric (≥6 digits) → long hex (≥10 chars) → full URL.
 * Empty input returns '' so callers can fall back to slug-keyed matching.
 *
 * The extraction is LEAF-SCOPED to avoid latching onto a token shared across an
 * entire crawler. Vendors put the per-job reference in the most-specific
 * (rightmost) path component; board/company/site/upload-folder ids live in
 * ANCESTOR segments. A blind leftmost scan grabs the ancestor id and collapses
 * every sibling job onto ONE key — `mergePreserveLocaleData` then merges them all
 * onto a single stable id, cross-contaminating titleByLocale/slugByLocale and
 * leaving 1 job-detail file for N distinct postings (observed: lwphr/cseb/refline/
 * flury/caritas/spital-limmattal, ~55 jobs). The three rules below fix the whole
 * class while preserving every key whose id already lives in the leaf:
 *   W. Workday host (`*.myworkdayjobs.com`) → `req:<full-host>:<req>`, where <req>
 *      is the leaf suffix after the FIRST underscore (`Title_R11696` → `r11696`).
 *      Workday puts the renamable title text BEFORE the `_<req>` separator, and the
 *      generic rules miss most req formats (`R11696` is `R`+5 digits — below
 *      `\b\d{6,}\b`; `REQ-16005` is non-numeric+5 digits → whole-URL fallback).
 *      Without this a Workday title rename fragments the merge and orphans the old
 *      slug (no previousSlug captured → soft-landing; observed: Swiss Life `_R11696`).
 *      The FULL host is prefixed because every Workday tenant shares the
 *      `myworkdayjobs.com` registrable domain, so a bare requisition (`R11696`)
 *      would collide across distinct employers in a multi-tenant match set —
 *      mirrors extractJobIdentityFromUrl's full-host identity (one consistent
 *      Workday key). See workdayReqFromLeaf for the format-agnostic extraction;
 *      host-gated so no other crawler's key changes, re-posting suffixes
 *      (`-N`/`_N`) KEPT.
 *   A. generic-index / document-file leaf + numeric/hex legacy token → per-job
 *      query id if present (`…/index.html?id=NNN`), else full URL (the only token
 *      is a shared folder/company id or a `%20`+year artifact).
 *   B. leaf carries its own UUID/num/hex token → use it (per-job id beats the
 *      shared ancestor id, e.g. cseb's second UUID, hotelcareer's trailing job id).
 *   C. legacy leftmost whole-URL scan (unchanged) — id in query/fragment/ancestor.
 *
 * @param {string} url
 * @returns {string}
 */
export function mergeUrlKey(url) {
  if (!url) return '';
  const u = String(url).trim().replace(/&amp;/g, '&').replace(/\/+$/, '').toLowerCase();
  if (!u) return '';

  const leaf = u.split(/[?#]/)[0].split('/').filter(Boolean).pop() || '';
  const legacy = legacyMergeToken(u);

  // Rule W — Workday requisition id (host-gated). The stable per-job token is the
  // leaf suffix after the first underscore (title text precedes it, freely renamed).
  // Prefix the FULL host: all Workday tenants share the `myworkdayjobs.com`
  // registrable domain, so a bare requisition (`R11696`) would collide across
  // distinct employers in a multi-tenant match set. Mirrors extractJobIdentityFromUrl's
  // full-host identity (dedicated-crawler-common.mjs) for one consistent Workday key.
  // Free re-key: the merge key is recomputed live every crawl (never persisted), so
  // both the existing job and the fresh crawl rederive the host-prefixed form → match.
  if (WORKDAY_HOST_RE.test(u)) {
    const req = workdayReqFromLeaf(leaf);
    if (req) {
      const host = u.match(/^https?:\/\/([^/]+)/)?.[1] || '';
      return `req:${host}:${req}`;
    }
  }

  // Rule A — generic-page / document-file leaf whose only PATH token is a shared
  // ancestor numeric/hex id (or `%20`+digits artifact): identity is the whole
  // URL. UUID legacy keys are left intact — they are globally-unique node ids.
  if (leaf && (GENERIC_LEAF_RE.test(leaf) || FILE_LEAF_RE.test(leaf))
      && (legacy.startsWith('num:') || legacy.startsWith('hex:'))) {
    // A genuine per-job id can still live in the QUERY behind a generic leaf
    // (`…/index.html?id=NNN`, `…/apply.php?jobId=NNN`). Keying on the full URL
    // there lets a varying tracking param (`&utm=…`, session token) fragment the
    // same job into duplicate postings — extract the per-job query token first.
    // No per-job query id → the leaf carries only a shared folder/company id, so
    // the whole URL is the identity (refline `?cid=101` falls through here).
    const queryToken = queryJobToken(u);
    if (queryToken) return queryToken;
    return `url:${u}`;
  }

  // Rule B — the leaf segment carries its own stable token (leftmost-in-leaf,
  // consistent with the legacy class priority). Distinguishes siblings sharing
  // an ancestor board/company id.
  if (leaf) {
    const lu = leaf.match(UUID_RE);
    if (lu) return `uuid:${lu[0]}`;
    const ln = leaf.match(NUM_ID_RE);
    if (ln) return `num:${ln[0]}`;
    const lh = leaf.match(HEX_TOKEN_RE);
    if (lh) return `hex:${lh[0]}`;
  }

  // Rule U — Umantis host-gated guard (dormant today, prevents future
  // collision). Umantis job urls (`recruitingapp-<tenantId>.umantis.com/
  // Vacancies/<id>/Description/<lang>`) carry the id in an ANCESTOR segment —
  // the leaf is the 2-letter locale code — so a future id that grows to
  // ≥6 digits would hit the legacy num:/hex: rule bare (no tenant scoping)
  // and could collide across tenants (ids are per-tenant sequences).
  // Prefixing the host only when the legacy key is already a bare num:/hex:
  // token keeps TODAY's output identical (ids are 3-4 digits, legacy already
  // falls to url:) — only changes behavior once a tenant crosses the
  // collision-risk threshold.
  if (UMANTIS_HOST_RE.test(u) && (legacy.startsWith('num:') || legacy.startsWith('hex:'))) {
    const host = u.match(/^https?:\/\/([^/]+)/)?.[1] || '';
    return `req:${host}:${legacy}`;
  }

  // Rule C — legacy leftmost whole-URL scan (unchanged).
  return legacy;
}

/**
 * Variant 2 — assemble-time DEDUP key (URL portion only, no `url:` prefix).
 *
 * Preserves the full raw URL INCLUDING hash fragments (Galenica uses
 * `/it/jobs/#job.id=12345` to distinguish individual positions). Returns the
 * normalized URL string, or '' when there is no URL.
 *
 * @param {string} url
 * @returns {string}
 */
export function assembleUrlKey(url) {
  return lowerStripTrailingSlash(url);
}

/**
 * Variant 3 — stats/diff/firstSeenAt identity (URL portion only).
 *
 * Parses the URL, STRIPS the hash and default ports (:443/:80), normalizes a
 * trailing-slash-only pathname to '/', and lowercases. Falls back to a plain
 * trailing-slash-strip + lowercase when the URL is unparseable. Returns '' for
 * empty input.
 *
 * @param {string} url
 * @returns {string}
 */
export function identityUrlKey(url) {
  const raw = String(url || '').replace(/\s+/g, ' ').trim();
  if (!raw) return '';

  try {
    const parsed = new URL(raw);
    parsed.hash = '';
    if ((parsed.protocol === 'https:' && parsed.port === '443') || (parsed.protocol === 'http:' && parsed.port === '80')) {
      parsed.port = '';
    }
    parsed.pathname = parsed.pathname.replace(/\/+$/g, '') || '/';
    return parsed.toString().toLowerCase();
  } catch {
    return raw.replace(/\/+$/g, '').toLowerCase();
  }
}
