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
// (or /Vacancies/<id>/Application/CheckLogin/<n> since the vendor dropped the
// standalone Description page on some tenants — see ksa-job-parser.mjs).
// Tenant lives in the subdomain; host-gated so no other crawler's key changes.
// Exported (like WORKDAY_HOST_RE/workdayReqFromLeaf) so
// extractJobIdentityFromUrl (dedicated-crawler-common.mjs) derives the SAME
// per-tenant vacancy identity as mergeUrlKey Rule U — one definition, no drift.
export const UMANTIS_HOST_RE = /(?:^|\/\/)recruitingapp-\d+\.umantis\.com(?:[:/]|$)/;
// Per-job vacancy id lives in the ANCESTOR segment right after /vacancies/
// (the URL is lowercased before matching). 1+ digits: observed ids are 3-4
// digits today (1910, 5105, …) — far below NUM_ID_RE's ≥6-digit floor.
export const UMANTIS_VACANCY_PATH_RE = /\/vacancies\/(\d+)(?:\/|$)/;

// PageExecutive detail urls encode two numeric tokens in the leaf:
//   /ref/jn-<MMYYYY>-<requisition>
// The date-like publication tag is shared by every posting created that month,
// so generic Rule B used to collapse siblings onto `num:082026`. The final
// requisition is the stable per-job token. Both host and full path shape are
// required so no other Michael Page property or generic jn-* URL is re-keyed.
const PAGEEXECUTIVE_HOST_RE = /^https?:\/\/(?:www\.)?pageexecutive\.com(?:[:/]|$)/;
const PAGEEXECUTIVE_DETAIL_REF_RE = /\/job-detail\/[^/?#]+\/ref\/jn-(?:0[1-9]|1[0-2])\d{4}-(\d{6,})\/?$/;

// Bank Cler job urls: cler.ch/…/<any-path>/offene-stellen/<title-slug>-<reqId>.
// Cler's own requisition id is only 3-4 digits — below the generic
// \b\d{6,}\b threshold — so the leaf carries no extractable token and every
// key falls back to the whole URL (Rule C). Observed 2026-07-04: Cler
// relaunched the career section mid-day (`jobs-und-karriere` →
// `jobs-und-karriere-2026`, an ANCESTOR segment unrelated to job identity),
// which changed the whole-URL key for every open position and duplicated
// all of them (#3497). Host-gated so no other crawler's key changes.
const CLER_HOST_RE = /(?:^|\/\/)(?:www\.)?cler\.ch(?:[:/]|$)/;

// #5230 — Rule K's requisition extraction only fires when the leaf ENDS in a
// digit run, and that assumption leaks in both directions:
//
//   OVER-COLLAPSE. `trailingDigitRunFromLeaf` returns any trailing run, so a
//   slug DISAMBIGUATOR (`…-bem-praktikum-region-bern-2`) is read as a
//   requisition id and keys to `req:cler.ch:2` — which every other Cler slug
//   ending in `-2` also maps to, silently merging unrelated postings onto one
//   key. Cler requisition ids are 3-4 digits (see comment above), so a 1-2
//   digit trailing run is never one; require CLER_MIN_REQ_DIGITS.
//
//   UNDER-COLLAPSE (the #5230 failure). Many Cler postings carry NO requisition
//   suffix at all — the apprenticeship/internship slugs are pure title text
//   (`…-aka-lehrstelle-kauffrau-kaufmann-efz-bank-region-bern`). Those fall
//   through Rule K to Rule C's whole-URL key, which is exactly what #3497 was
//   about: the site still serves every posting under BOTH the legacy
//   `…/jobs-und-karriere/…` and the relaunched `…/jobs-und-karriere-2026/…`
//   ancestor (verified 2026-08-06 — both return HTTP 200 with the same title
//   and a SELF-referencing canonical, so neither path retires), and the two
//   whole-URL keys differ → the same posting is emitted twice. Rule K fixed
//   this for numeric slugs only; non-numeric slugs stayed duplicated.
//
// The fix for the second case is to key on the LEAF, which is the posting's
// identity across every ancestor/locale variant Cler publishes (the Italian
// path `…/it/banca-cler/jobs-und-karriere/cercare-candidatura/offene-stellen/…`
// carries the SAME leaf as the German one). Gated on the `/offene-stellen/<leaf>`
// detail shape so LISTING urls — where the leaf is the shared `offene-stellen`
// segment itself — keep falling through to the whole-URL key instead of
// collapsing every locale's listing page onto one key.
const CLER_MIN_REQ_DIGITS = 3;
const CLER_DETAIL_LEAF_RE = /\/offene-stellen\/([^/?#]+)$/i;

// ETA SA (Swatch Group) job urls: eta.ch/…/vacancies/detail/<reqId>. Same
// slug-drift class as Cler above — eta.ch's requisition id is only 4 digits
// (below the generic \b\d{6,}\b threshold) and the site toggles an ANCESTOR
// `index.php/` path segment (`/en/jobs-careers/…` vs `/index.php/en/jobs-careers/…`)
// unrelated to job identity, which duplicated every open position under two
// whole-URL keys (#3497). Host-gated so no other crawler's key changes.
const ETA_HOST_RE = /(?:^|\/\/)(?:www\.)?eta\.ch(?:[:/]|$)/;

// apply.refline.ch (host-gated). Detail urls are `/<companyId>/<posId>/pub/<rev>`,
// optionally suffixed `/index.html`. Some tenants (e.g. ZKB, refline tenant
// 792841 — see scripts/lib/zkb-job-parser.mjs) resolve the BARE form with no
// `/index.html` leaf, so Rule A's GENERIC_LEAF_RE never fires (the leaf is
// just the trailing revision number, e.g. `2`) and the per-job posId — one
// ancestor segment further up — is too short/absent from the leaf for Rule B.
// Falling through to Rule C's blind leftmost-in-URL scan then grabs the
// LEFTMOST ≥6-digit run, which is the shared companyId (`792841`), not the
// per-job posId — colliding every job at that tenant onto ONE merge key
// (#3699). Host-gated so no other crawler's key changes; the already-tested
// `/index.html`-suffixed form is unaffected (Rule A returns first).
const REFLINE_HOST_RE = /(?:^|\/\/)(?:www\.)?apply\.refline\.ch(?:[:/]|$)/;
// Matches `/<companyId>/<posId>/pub/<rev>` with no trailing path segment
// after `<rev>` (i.e. no `/index.html`) — the shape Rule A does not catch.
const REFLINE_BARE_PATH_RE = /^https?:\/\/[^/]+\/([a-z0-9]+)\/([a-z0-9]+)\/pub\/\d+$/i;

// rexx systems ATS (vendor-signature-gated, NOT host-gated: ~19+ tenants each
// publish under their OWN hostname — jobs.zkb.ch has nothing to do with this,
// see e.g. jobs.emilfrey.ch, jobs.globus.ch, jobs.newyorker.de — there is no
// shared registrable domain to key a *_HOST_RE constant on). Detail urls end
// `…-j<digits>.html`, optionally followed by a per-REQUEST `?sid=<32-hex>`
// session token (scripts/lib/rexx-systems-job-parser-common.mjs's own
// `parseRexxListing` extracts the SAME `-j(\d+)\.html` id for its purposes,
// but that stable id is never threaded into mergeUrlKey — this re-derives it
// independently from the raw URL). Two failure modes without this rule:
//  - short ids (New Yorker: 5 digits, e.g. `j27003`) fall below Rule B's
//    ≥6-digit leaf threshold and are invisible to Rule A (leaf isn't a
//    literal `index.html`/`default.html`), so nothing intercepts them before
//    Rule C's blind scan.
//  - Rule C's blind leftmost-in-URL scan then finds the volatile `sid=` hex
//    token (which happens to satisfy HEX_TOKEN_RE) BEFORE it would ever reach
//    the stable `-j<digits>` leaf token — so the merge key changes on every
//    single crawl (a fresh session id each request), and the job looks new
//    every time (#3699).
const REXX_DETAIL_LEAF_RE = /-j(\d+)\.html?$/i;

/**
 * Trailing digit run of a path leaf (`…-w-m-2589` → `2589`, `…/detail/3719` →
 * `3719`). Returns '' when the leaf has no trailing digit run. Shared by the
 * Cler (Rule K) and ETA SA (Rule L) host-gated guards — both sites publish a
 * short (3-4 digit) requisition id in the leaf, too short for Rule B's
 * ≥6-digit threshold, behind an ancestor path segment prone to drifting.
 * @param {string} leaf - path leaf (last `/`-separated segment, no query/hash)
 * @returns {string}
 */
export function trailingDigitRunFromLeaf(leaf) {
  const m = String(leaf || '').match(/(\d+)$/);
  return m ? m[1] : '';
}

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
 *   P. PageExecutive `/ref/jn-MMYYYY-<req>` detail → final requisition; the
 *      leading date token is shared by every posting opened in that month.
 *   A. generic-index / document-file leaf + numeric/hex legacy token → per-job
 *      query id if present (`…/index.html?id=NNN`), else full URL (the only token
 *      is a shared folder/company id or a `%20`+year artifact).
 *   B. leaf carries its own UUID/num/hex token → use it (per-job id beats the
 *      shared ancestor id, e.g. cseb's second UUID, hotelcareer's trailing job id).
 *   R. apply.refline.ch bare `/<companyId>/<posId>/pub/<rev>` leaf (no
 *      `/index.html`, host-gated) → per-job posId, not the companyId (#3699).
 *   X. rexx systems `-j<digits>.html` leaf (vendor-signature-gated, not
 *      host-gated — ~19+ tenants, no shared hostname) → stable detail id,
 *      ahead of a volatile `?sid=` session token later in the URL (#3699).
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

  // Rule P — PageExecutive's final requisition outranks the shared MMYYYY tag.
  // This must run before generic Rule B, whose leftmost numeric match is the
  // publication month rather than the vacancy identity (#6785).
  if (PAGEEXECUTIVE_HOST_RE.test(u)) {
    const pathOnly = u.split(/[?#]/)[0];
    const ref = pathOnly.match(PAGEEXECUTIVE_DETAIL_REF_RE);
    if (ref) return `num:${ref[1]}`;
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

  // Rule U — Umantis per-vacancy id (host-gated). Umantis job urls
  // (`recruitingapp-<tenantId>.umantis.com/Vacancies/<id>/Description/<lang>`
  // or `…/Vacancies/<id>/Application/CheckLogin/<n>`) carry the per-job id in
  // an ANCESTOR segment — the leaf is a locale code / form step number, so
  // Rule B never fires. The vacancy id (3-4 digits) is below NUM_ID_RE's
  // ≥6-digit floor, but the TENANT id in the hostname
  // (`recruitingapp-122706`) is 6 digits, so the legacy whole-URL scan
  // returns `num:<tenantId>` — the SAME key for every job at the tenant.
  // The previous version of this rule only host-prefixed that legacy token
  // (believing it "dormant"), which still collapsed all of a tenant's jobs
  // onto ONE key: mergePreserveLocaleData's non-injective-key guard then
  // refused EVERY existing↔fresh match and the whole slice re-keyed on each
  // crawl, dropping previousSlugs/firstSeenAt (KSA incident, run 29086057860,
  // commit c74a569d — 31 previousSlugs entries lost across 19 jobs).
  // Extract the real per-vacancy id instead; tenant host prefixed because
  // vacancy ids are per-tenant sequences. Free re-key: the old key never
  // produced a successful match (always ambiguous), so no correct match can
  // regress; the merge key is recomputed live every crawl, never persisted.
  if (UMANTIS_HOST_RE.test(u)) {
    const host = u.match(/^https?:\/\/([^/]+)/)?.[1] || '';
    const vac = u.split(/[?#]/)[0].match(UMANTIS_VACANCY_PATH_RE);
    if (vac) return `req:${host}:vac:${vac[1]}`;
    // No /vacancies/<id>/ segment (listing/root pages): keep the previous
    // host-prefixed fallback for bare num:/hex: legacy tokens.
    if (legacy.startsWith('num:') || legacy.startsWith('hex:')) {
      return `req:${host}:${legacy}`;
    }
  }

  // Rule K — Bank Cler requisition id (host-gated). The leaf's trailing digit
  // run is too short (3-4 digits) for Rule B's ≥6-digit threshold, so without
  // this it falls all the way to the whole-URL fallback (Rule C) — see
  // CLER_HOST_RE above for the incident this caused.
  if (CLER_HOST_RE.test(u)) {
    const req = trailingDigitRunFromLeaf(leaf);
    // Only a 3-4 digit run is a real requisition id — a shorter one is a slug
    // disambiguator and would collide unrelated postings (see #5230 above).
    if (req.length >= CLER_MIN_REQ_DIGITS) return `req:cler.ch:${req}`;
    // No requisition id in the slug: key on the detail leaf so the posting
    // survives the `jobs-und-karriere` → `jobs-und-karriere-2026` ancestor
    // split (and the de/it locale paths) instead of duplicating under Rule C.
    const detailLeaf = u.split(/[?#]/)[0].match(CLER_DETAIL_LEAF_RE);
    if (detailLeaf) return `req:cler.ch:slug:${detailLeaf[1]}`;
  }

  // Rule L — ETA SA (Swatch Group) requisition id (host-gated). Same
  // too-short-leaf-token problem as Rule K above — see ETA_HOST_RE above for
  // the incident this caused.
  if (ETA_HOST_RE.test(u)) {
    const req = trailingDigitRunFromLeaf(leaf);
    if (req) return `req:eta.ch:${req}`;
  }

  // Rule R — apply.refline.ch bare `/<companyId>/<posId>/pub/<rev>` leaf, no
  // `/index.html` (host-gated). See REFLINE_HOST_RE/REFLINE_BARE_PATH_RE above
  // for why Rule A/B never catch this shape. Extract the per-job posId
  // explicitly instead of falling through to Rule C's companyId-colliding scan.
  if (REFLINE_HOST_RE.test(u)) {
    const pathOnly = u.split(/[?#]/)[0];
    const m = pathOnly.match(REFLINE_BARE_PATH_RE);
    if (m && m[2]) return `req:refline.ch:${m[2]}`;
  }

  // Rule X — rexx systems detail-page id (vendor-signature-gated via leaf
  // shape, not host — see REXX_DETAIL_LEAF_RE above). Extract the stable
  // `-j<digits>` id from the leaf BEFORE Rule C's blind scan can reach a
  // volatile `?sid=` session token later in the same URL.
  if (leaf) {
    const rexx = leaf.match(REXX_DETAIL_LEAF_RE);
    if (rexx) return `req:rexx:${rexx[1]}`;
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
    // Johdi Suite ATS widget (eHnv, H-JU, Daler — johdisuite.ch tenants) hash-routes
    // every distinct posting as `#offer/<numeric-id>/<slug>` on ONE shared canonical
    // career-page URL. Blindly stripping the hash below collapses all postings at a
    // tenant onto a single stats/diff/firstSeenAt identity — computeCrawlDiff's
    // removedJobs then never fires for these tenants (masked by any other still-open
    // posting), so a genuinely-removed indexed job URL never gets its soft-landing
    // expired page (crawler-template.mjs Step 4b archival). Key on the numeric offer
    // id instead — same title/slug-proof stability rationale as the sibling fix in
    // extractJobIdentityFromUrl (dedicated-crawler-common.mjs, eHnv 15→1 incident).
    const johdiSuiteMatch = parsed.hash.match(/^#offer\/(\d+)\//i);
    parsed.hash = johdiSuiteMatch ? `#offer-${johdiSuiteMatch[1]}` : '';
    if ((parsed.protocol === 'https:' && parsed.port === '443') || (parsed.protocol === 'http:' && parsed.port === '80')) {
      parsed.port = '';
    }
    parsed.pathname = parsed.pathname.replace(/\/+$/g, '') || '/';
    return parsed.toString().toLowerCase();
  } catch {
    return raw.replace(/\/+$/g, '').toLowerCase();
  }
}
