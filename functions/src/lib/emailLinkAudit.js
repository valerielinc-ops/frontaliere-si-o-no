/**
 * emailLinkAudit.js — post-send link audit for an email we actually sent.
 *
 * Why this exists (issue #5682). The only pre-send guard on unsubscribe links
 * was a substring test in scripts/send-newsletter.mjs:
 *
 *     if (!sampleHtml.includes('action=unsubscribe')) fail('unsubscribe_url', ...)
 *
 * That asserts the TEXT is present. It cannot see whether the URL resolves,
 * whether the endpoint answers, or whether the recipient's click does
 * anything — a syntactically perfect link to a route nobody serves passes it.
 * The #5672/#5673 unsubscribe defect lived for months behind exactly that
 * green check and only surfaced when a recipient sent a legal notice.
 *
 * ── The two traps this module exists to survive ─────────────────────────────
 *
 * A naive "no link 404s and no link lands on the home page" check — the shape
 * issue #5682 asks for — is WRONG IN BOTH DIRECTIONS on this site. Measured
 * against production on 2026-08-12:
 *
 *  1. FALSE RED. `https://frontaliereticino.ch/preferenze-newsletter/` answers
 *     HTTP **404** in all four locales, and it is CORRECT. GitHub Pages serves
 *     404.html, whose inline `spaRedirect()` stores `location.href` in
 *     `sessionStorage.redirect` and `location.replace('/')`, and index.html
 *     restores the route — the recipient sees the preferences page. The route
 *     is deliberately not prerendered (see the comment in
 *     build-plugins/legacyRedirectsPlugin.ts about /preferenze-newsletter/ and
 *     /email-confirmed/). So status alone condemns a working link.
 *     → SPA_FALLTHROUGH_MARKER below is what tells a real dead end apart from
 *       an SPA fallthrough: a 404 body that carries it is fine.
 *
 *  2. FALSE GREEN, and it is the one the legal notice was about.
 *     `https://frontaliereticino.ch/?action=unsubscribe&email=…&token=…`
 *     (makeUnsubscribeUrl) answers HTTP **200** — with the HOME PAGE. The
 *     server has no idea what `action=unsubscribe` means; App.tsx decides
 *     client-side, and it REJECTS the link with "Link non valido" unless the
 *     URL also carries the `ac` autologin code. A live status check on that
 *     URL is green no matter how broken the link is.
 *     → the `ac` requirement is therefore asserted STATICALLY (findSpaActionAc
 *       below), because no HTTP response can ever report it.
 *
 * Same structural blindness as EXPIRED_JOB_MARKER in
 * scripts/lib/live-link-check.mjs: on this site, HTTP status is not the
 * oracle. Both markers exist for the same reason and neither can be replaced
 * by a status check.
 *
 * ── The two unsubscribe links are not interchangeable ───────────────────────
 *
 *  - `makeOneClickUnsubscribeUrl` → /disiscrivi-newsletter/, proxied straight
 *    to the newsletterManageSubscription Cloud Function by
 *    infra/cloudflare-worker/locale-router.js. No SPA, no `ac`, works from a
 *    mail client's automated POST. Measured: 403 to an invalid token, 400 to
 *    a request with no params. Both prove the route is alive AND enforcing.
 *  - `makeUnsubscribeUrl` → the site root, handled by the SPA, REQUIRES `ac`.
 *
 * A body-footer unsubscribe link built with the second one and never given an
 * `ac` is the #5672 shape, and this module reports it as an error.
 *
 * ── Read-only by construction ───────────────────────────────────────────────
 *
 * This audit never changes state. The only endpoint it POSTs nothing to and
 * GETs with a DELIBERATELY INVALID token (INVALID_TOKEN_PROBE below, which is
 * not a 64-char hex HMAC and can never verify) is the one-click unsubscribe
 * route, precisely so the probe is refused at the signature check before any
 * subscriber document is read or written. Every other request is a plain GET
 * with `redirect: 'manual'`. Auditing an email must never be able to
 * unsubscribe anybody.
 *
 * Canonical home is functions/src/lib/ — not services/ or scripts/lib/ —
 * because firebase.json's `source: "functions"` deploy has no bundler and
 * functions/src/** can only import from within functions/ (same boundary that
 * put newsletterUrls.js and welcomeEmailTemplate.js here).
 * scripts/lib/email-link-audit.mjs re-exports it so every scripts/ caller
 * resolves the same module. Its only import is a sibling in this same
 * directory; everything else is a Node/web global (fetch, URL, URLSearchParams,
 * Buffer, console), so it is safe on both runtimes.
 */
import { PREFERENCES_SLUG } from './newsletterUrls.js';

/** Canonical prod host (no www) — matches BASE_URL in newsletterUrls.js. */
export const SITE_HOST = 'frontaliereticino.ch';

/** Provider click-tracking host. Every href in a delivered message is
 * rewritten to `https://click.frontaliereticino.ch/v2/redirect/<base64>` by
 * the sending provider, so the audit must resolve THROUGH it before it can
 * judge anything. Nothing in this repo produces these URLs — they only exist
 * in the message the recipient actually receives, which is why no test could
 * ever have covered them. */
export const CLICK_TRACKER_HOSTS = ['click.frontaliereticino.ch'];

/**
 * Every apex path the CF Worker transparently proxies to an unsubscribe Cloud
 * Function. RUNTIME MIRROR of `UNSUB_PROXIES` in
 * infra/cloudflare-worker/locale-router.js — the Worker is deployed on its own
 * and cannot be imported from here (it is a Workers module, not a library), so
 * this copy cannot be made impossible-by-construction. It is instead guarded by
 * a drift test: "one-click unsubscribe path table" in
 * tests/sent-email-link-audit.test.ts reads the Worker source, extracts the
 * UNSUB_PROXIES keys, and fails when the two lists disagree — the same
 * technique route-slugs-no-drift.test.ts uses for the functions-side slug table.
 *
 * There are FOUR of them, not one: the newsletter is only the best known.
 * scripts/send-saved-jobs-digest.mjs and scripts/send-job-alerts.mjs each have
 * their own endpoint and their own token scheme, and an audit that knew only
 * about /disiscrivi-newsletter/ would have declared their (perfectly good)
 * unsubscribe links missing.
 */
export const ONE_CLICK_UNSUBSCRIBE_PATHS = [
  '/disiscrivi-alert',
  '/disiscrivi-outreach',
  '/disiscrivi-newsletter',
  '/disiscrivi-promemoria-salvati',
];

/** The newsletter one, in the trailing-slash form newsletterUrls.js builds
 * (ONE_CLICK_BASE_URL). */
export const ONE_CLICK_PATH = '/disiscrivi-newsletter/';

/**
 * The four locale URLs of the newsletter-preferences page — the page where a
 * subscriber inspects and withdraws consent, linked from the footer of every
 * newsletter, job alert, daily brief and welcome email.
 *
 * DERIVED from PREFERENCES_SLUG rather than copied, so a slug rename cannot
 * leave the audit probing paths that no longer exist. Mirrors makePreferencesUrl's
 * own prefix rule (IT at the root, the other three under /<locale>/).
 */
export function preferencesPaths() {
  return Object.entries(PREFERENCES_SLUG).map(
    ([locale, slug]) => `${locale === 'it' ? '' : `/${locale}`}/${slug}/`,
  );
}

function isOneClickPath(pathname) {
  const bare = pathname.endsWith('/') && pathname.length > 1 ? pathname.slice(0, -1) : pathname;
  return ONE_CLICK_UNSUBSCRIBE_PATHS.includes(bare);
}

/** Substring emitted by the inline `spaRedirect()` in the built 404.html. Its
 * presence in a 404 body means the SPA will restore the route client-side, so
 * the link works for a human even though the status says otherwise (trap 1 in
 * the header comment). Its ABSENCE in a 404 body is a real dead end. */
export const SPA_FALLTHROUGH_MARKER = 'sessionStorage.redirect';

/** Token used to probe the one-click unsubscribe endpoint. Deliberately NOT a
 * 64-char hex HMAC, so signedEmailToken can never accept it and the probe is
 * refused before any read or write. Asserted in tests. */
export const INVALID_TOKEN_PROBE = 'link-audit-invalid-token-never-valid';

export const AUDIT_USER_AGENT = 'FrontaliereTicino-EmailLinkAudit/1.0 (+https://frontaliereticino.ch)';
export const DEFAULT_AUDIT_TIMEOUT_MS = 8_000;
export const DEFAULT_MAX_HOPS = 5;
/** Cap on distinct URLs probed live per message. Unsubscribe / preferences /
 * action links are always probed; the rest are sampled up to this budget, so
 * a 60-job-card digest cannot turn one send into 60 origin requests. */
export const DEFAULT_LIVE_BUDGET = 20;

const ENTITY = { '&amp;': '&', '&#38;': '&', '&quot;': '"', '&#39;': "'", '&lt;': '<', '&gt;': '>' };

function decodeEntities(s) {
  return String(s).replace(/&(?:amp|#38|quot|#39|lt|gt);/g, (m) => ENTITY[m] ?? m);
}

/** Strip a recipient address out of anything that gets logged. The audit runs
 * inside senders whose logs are public CI artifacts (AGENTS.md ## Privacy). */
export function redactEmails(text) {
  return String(text).replace(/[A-Za-z0-9._%+-]+(@|%40)[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, '<redacted>');
}

function hostOf(url) {
  try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return null; }
}

function isOurHost(url) {
  return hostOf(url) === SITE_HOST;
}

/** Every href in an email body, entity-decoded, in document order, deduped. */
export function extractEmailLinks(html) {
  if (!html) return [];
  const seen = new Set();
  const out = [];
  for (const m of String(html).matchAll(/href\s*=\s*"([^"]*)"|href\s*=\s*'([^']*)'/g)) {
    const raw = decodeEntities(m[1] ?? m[2] ?? '').trim();
    if (!raw || seen.has(raw)) continue;
    seen.add(raw);
    out.push(raw);
  }
  return out;
}

/** Decode a provider click-tracking URL back to its destination without a
 * network call. The path segment is base64/base64url of a payload that
 * contains the destination URL (raw or inside JSON), so the destination is
 * recovered by decoding and taking the first http(s) URL found. Returns null
 * when `href` is not a tracker URL or the payload does not decode — the live
 * pass then falls back to actually following the redirect, which is the
 * authoritative answer either way. */
export function decodeTrackedUrl(href) {
  if (!isTrackedUrl(href)) return null;
  let segment;
  try {
    const u = new URL(href);
    segment = u.pathname.split('/').filter(Boolean).pop() || '';
  } catch { return null; }
  if (!segment) return null;
  let decoded;
  try {
    const normalized = segment.replace(/-/g, '+').replace(/_/g, '/');
    decoded = Buffer.from(normalized, 'base64').toString('utf8');
  } catch { return null; }
  const found = decoded.match(/https?:\/\/[^\s"'\\<>]+/);
  return found ? decodeEntities(found[0]) : null;
}

export function isTrackedUrl(href) {
  const h = hostOf(href);
  return !!h && CLICK_TRACKER_HOSTS.some((t) => h === t.replace(/^www\./, ''));
}

/**
 * What kind of link this is, and what the audit is allowed to conclude from
 * an HTTP response to it.
 *
 * kinds:
 *  - `tracker`             provider redirect; `destination` carries the decoded target
 *  - `one-click-unsubscribe` /disiscrivi-newsletter/ → Cloud Function, status IS meaningful
 *  - `spa-action`          site root with ?action=… → SPA-handled, status is NOT meaningful, needs `ac`
 *  - `preferences`         newsletter-preferences page → SPA fallthrough route, 404 is OK
 *  - `site`                any other page on our host
 *  - `asset`               /images/ or /icons/ on our host
 *  - `mailto` | `anchor`   never probed
 *  - `relative`            not absolute — broken in most mail clients
 *  - `external`            someone else's host
 */
export function classifyEmailLink(href) {
  const raw = String(href || '').trim();
  if (!raw) return { kind: 'anchor', url: raw };
  if (raw.startsWith('#')) return { kind: 'anchor', url: raw };
  if (/^(mailto|tel):/i.test(raw)) return { kind: 'mailto', url: raw };
  if (!/^https?:\/\//i.test(raw)) return { kind: 'relative', url: raw };

  if (isTrackedUrl(raw)) {
    return { kind: 'tracker', url: raw, destination: decodeTrackedUrl(raw) };
  }

  let u;
  try { u = new URL(raw); } catch { return { kind: 'relative', url: raw }; }
  if (!isOurHost(raw)) return { kind: 'external', url: raw };

  const path = u.pathname;
  const params = u.searchParams;

  if (isOneClickPath(path)) {
    // The four endpoints do NOT agree on the query-param name for the
    // signature: newsletter/job-alert/saved-jobs use `token`, outreach uses `t`
    // (scripts/lib/outreach-unsubscribe-token.mjs). Accepting only `token`
    // would have reported the cold-email channel's perfectly good opt-out link
    // as unsigned on every send.
    return {
      kind: 'one-click-unsubscribe',
      url: raw,
      action: params.get('action'),
      hasToken: params.has('token') || params.has('t'),
    };
  }
  if (path.startsWith('/images/') || path.startsWith('/icons/')) {
    return { kind: 'asset', url: raw };
  }
  if (params.has('action')) {
    return {
      kind: 'spa-action',
      url: raw,
      action: params.get('action'),
      hasAc: params.has('ac'),
      hasToken: params.has('token'),
    };
  }
  const lastSegment = path.replace(/\/+$/, '').split('/').pop();
  if (Object.values(PREFERENCES_SLUG).includes(lastSegment)) {
    return { kind: 'preferences', url: raw, hasToken: params.has('token') };
  }
  return { kind: 'site', url: raw, hasNe: params.has('ne'), hasAc: params.has('ac') };
}

function finding(severity, code, detail, url) {
  return { severity, code, detail, url: url ? redactEmails(url) : undefined };
}

/**
 * Everything that can be decided without touching the network. This is the
 * half that replaces the substring check, and it is the ONLY half that can
 * see trap 2 (an `action=` link with no `ac` answers 200 forever).
 *
 * @param {string} html the body ACTUALLY handed to the provider for one recipient
 * @param {{channel?: string, requireUnsubscribe?: boolean}} [opts]
 * @returns {{findings: object[], links: object[], counts: object}}
 */
export function auditEmailLinksStatic(html, opts = {}) {
  const { channel = 'unknown', requireUnsubscribe = true } = opts;
  const findings = [];
  const hrefs = extractEmailLinks(html);
  const links = hrefs.map((h) => {
    const c = classifyEmailLink(h);
    // A tracked link is judged on where it GOES, not on the tracker itself.
    if (c.kind === 'tracker' && c.destination) {
      return { ...classifyEmailLink(c.destination), url: c.destination, via: 'tracker', trackerUrl: c.url };
    }
    return c;
  });

  const counts = {};
  for (const l of links) counts[l.kind] = (counts[l.kind] || 0) + 1;

  if (!html || String(html).length < 200) {
    findings.push(finding('error', 'html_missing', `channel=${channel}: body is empty or truncated`));
    return { findings, links, counts };
  }

  const unsubscribeLinks = links.filter(
    (l) => l.kind === 'one-click-unsubscribe' || (l.kind === 'spa-action' && l.action === 'unsubscribe'),
  );
  if (requireUnsubscribe && unsubscribeLinks.length === 0) {
    findings.push(finding('error', 'unsubscribe_missing', `channel=${channel}: no unsubscribe link of either shape in the body`));
  }

  // `ne` identifies the recipient, `ac` authenticates them. A message where
  // NO link has `ac` is a legitimate state — the subscriber has
  // autologinEnabled:false and opted out of being signed in by a link. A
  // message where SOME links carry `ac` and others carry only `ne` is
  // half-wrapped: makeAuthenticatedUrl ran with a code for some hrefs and
  // without for others, and those recipients land signed out on pages that
  // assumed otherwise. Only the second is a defect, so the verdict is drawn
  // from the whole message rather than from each link alone.
  const anyAc = links.some((l) => l.hasAc);

  for (const l of links) {
    // Trap 2 — the #5672 shape. An `action=` link on the site root is decided
    // by App.tsx, which answers "Link non valido" without the `ac` autologin
    // code. The server returns 200 with the home page either way, so no live
    // check can ever report this: it has to be caught here or not at all.
    if (l.kind === 'spa-action' && !l.hasAc) {
      findings.push(finding(
        'error',
        'spa_action_without_ac',
        `channel=${channel}: ?action=${l.action} is SPA-handled and needs the ac autologin code — without it App.tsx shows "Link non valido". Use makeAuthenticatedActionUrl() or makeOneClickUnsubscribeUrl() instead of makeUnsubscribeUrl().`,
        l.url,
      ));
    }
    if (l.kind === 'site' && l.hasNe && !l.hasAc && anyAc) {
      findings.push(finding('error', 'authenticated_without_ac', `channel=${channel}: link carries ne= but no ac= while other links in the same message do — half-wrapped autologin`, l.url));
    }
    // An unsubscribe URL with no token is what newsletterUrls.js calls
    // "degrades gracefully to an unsigned URL" when NEWSLETTER_SECRET is
    // absent. Graceful for the builder, 400 for the recipient.
    if ((l.kind === 'one-click-unsubscribe' || l.kind === 'preferences') && !l.hasToken) {
      findings.push(finding('error', 'unsigned_link', `channel=${channel}: ${l.kind} link has no token= — NEWSLETTER_SECRET was unset at send time`, l.url));
    }
    if (l.kind === 'relative') {
      findings.push(finding('error', 'relative_href', `channel=${channel}: href is not absolute; mail clients cannot resolve it`, l.url));
    }
  }

  if (/\{\{[^}]+\}\}/.test(html)) {
    const sample = (html.match(/\{\{[^}]+\}\}/g) || []).slice(0, 3).join(', ');
    findings.push(finding('error', 'template_var_unresolved', `channel=${channel}: unresolved template variables: ${sample}`));
  }

  return { findings, links, counts };
}

// ── Live half ───────────────────────────────────────────────────────────────

async function requestOnce(url, { fetchImpl, timeoutMs, method = 'GET' }) {
  const res = await fetchImpl(url, {
    method,
    redirect: 'manual',
    headers: { 'User-Agent': AUDIT_USER_AGENT },
    signal: AbortSignal.timeout(timeoutMs),
  });
  return res;
}

/**
 * Walk a redirect chain by hand (`redirect: 'manual'`), so the audit can see
 * every hop — the provider tracker's 302 included — instead of only the
 * destination. Never throws: a network failure comes back as
 * `{ error: <message> }` so the caller can tell "dead link" from "our
 * outbound network is down" and fail open on the latter.
 *
 * @returns {Promise<{hops: {url:string,status:number,location?:string}[], finalUrl: string, status: number|null, error?: string}>}
 */
export async function resolveRedirectChain(url, opts = {}) {
  const {
    fetchImpl = globalThis.fetch,
    timeoutMs = DEFAULT_AUDIT_TIMEOUT_MS,
    maxHops = DEFAULT_MAX_HOPS,
  } = opts;
  const hops = [];
  let current = url;
  for (let i = 0; i <= maxHops; i++) {
    let res;
    try {
      res = await requestOnce(current, { fetchImpl, timeoutMs });
    } catch (e) {
      return { hops, finalUrl: current, status: null, error: e?.message || String(e) };
    }
    const location = res.status >= 300 && res.status < 400 ? res.headers?.get?.('location') : null;
    hops.push({ url: current, status: res.status, ...(location ? { location } : {}) });
    if (!location) return { hops, finalUrl: current, status: res.status, response: res };
    try {
      current = new URL(location, current).toString();
    } catch {
      return { hops, finalUrl: current, status: res.status, error: `unresolvable Location: ${location}` };
    }
  }
  return { hops, finalUrl: current, status: hops[hops.length - 1]?.status ?? null, error: 'too many redirects' };
}

/**
 * Probe the one-click unsubscribe route WITHOUT unsubscribing anyone: the
 * recipient's own URL with its token replaced by INVALID_TOKEN_PROBE, so the
 * Cloud Function refuses it at the signature check.
 *
 * Measured against production 2026-08-12:
 *   invalid token → 403,  no params → 400,  POST invalid token → 403.
 * So 4xx is the PASSING outcome — it proves the CF Worker still proxies the
 * path to the function and the function still verifies signatures. A 404 means
 * the route is gone; a 2xx/3xx means something else (the static site, a stray
 * redirect) is answering, i.e. RFC 8058 one-click is silently broken.
 */
export async function probeOneClickUnsubscribe(url, opts = {}) {
  let probeUrl;
  try {
    const u = new URL(url);
    // Invalidate BOTH spellings of the signature param — `token` for the
    // newsletter/job-alert/saved-jobs endpoints, `t` for outreach. Missing one
    // would leave a real signature intact and the probe could then actually
    // unsubscribe the recipient, which is the one thing this must never do.
    u.searchParams.set('token', INVALID_TOKEN_PROBE);
    if (u.searchParams.has('t')) u.searchParams.set('t', INVALID_TOKEN_PROBE);
    probeUrl = u.toString();
  } catch {
    return [finding('error', 'oneclick_url_invalid', 'one-click unsubscribe href is not a parsable URL', url)];
  }
  const chain = await resolveRedirectChain(probeUrl, opts);
  if (chain.error && chain.status === null) {
    return [finding('warn', 'oneclick_probe_network', `could not reach the one-click endpoint: ${chain.error}`, url)];
  }
  const status = chain.status;
  if (status === 404 || status === 410) {
    return [finding('error', 'oneclick_route_dead', `one-click unsubscribe endpoint answered ${status} — the route the List-Unsubscribe header points at is not served`, url)];
  }
  if (status >= 500) {
    return [finding('warn', 'oneclick_route_5xx', `one-click unsubscribe endpoint answered ${status}`, url)];
  }
  if (status >= 200 && status < 400) {
    return [finding('error', 'oneclick_route_unenforced', `one-click unsubscribe endpoint answered ${status} to a deliberately invalid token — the request is no longer reaching the Cloud Function (expected 4xx)`, url)];
  }
  return [];
}

async function auditOneSiteLink(link, opts) {
  const chain = await resolveRedirectChain(link.url, opts);
  if (chain.error && chain.status === null) {
    return [finding('warn', 'link_probe_network', `${chain.error}`, link.url)];
  }
  const status = chain.status;
  if (status >= 200 && status < 300) return [];
  if (status === 404 || status === 410) {
    // Trap 1 — a 404 whose body is the SPA bootstrap is a working link. Only a
    // 404 WITHOUT the fallthrough marker is a real dead end.
    let body = '';
    try {
      body = await chain.response.text();
    } catch { /* fall through to the strict verdict below */ }
    if (body.includes(SPA_FALLTHROUGH_MARKER)) {
      return [finding('info', 'spa_fallthrough_404', `${status} from the origin, but 404.html boots the SPA back onto this route — works for a human`, link.url)];
    }
    return [finding('error', 'dead_link', `${status} and the body does NOT carry the SPA fallthrough marker — the recipient sees a dead end`, link.url)];
  }
  if (status >= 500) return [finding('warn', 'link_5xx', `${status}`, link.url)];
  if (status >= 400) return [finding('error', 'dead_link', `${status}`, link.url)];
  return [finding('warn', 'link_unresolved', `redirect chain did not terminate (${chain.error || status})`, link.url)];
}

async function auditTrackerLink(link, opts) {
  const chain = await resolveRedirectChain(link.trackerUrl, opts);
  if (chain.error && chain.status === null) {
    return [finding('warn', 'tracker_probe_network', `${chain.error}`, link.trackerUrl)];
  }
  if (chain.hops.length === 1 && !chain.hops[0].location) {
    return [finding('error', 'tracker_no_redirect', `the provider click tracker answered ${chain.status} without a Location — the recipient's click goes nowhere`, link.trackerUrl)];
  }
  if (!isOurHost(chain.finalUrl)) {
    return [finding('warn', 'tracker_offsite', `tracker resolved to ${hostOf(chain.finalUrl)}, not ${SITE_HOST}`, link.trackerUrl)];
  }
  return [];
}

/**
 * The network half. Ordered by importance and budgeted, so one send never
 * turns into dozens of origin requests: unsubscribe / preferences / action
 * links are always probed, everything else is sampled up to `budget`.
 *
 * Fails OPEN on a systemic outage — when nearly every probe comes back as a
 * network error, that is our outbound connectivity, not dozens of
 * simultaneously dead links, and reporting it as such would train everyone to
 * ignore this check (same posture as filterLiveJobs in send-job-alerts.mjs).
 */
export async function auditEmailLinksLive(links, opts = {}) {
  const { budget = DEFAULT_LIVE_BUDGET } = opts;
  const priority = (l) => {
    if (l.kind === 'one-click-unsubscribe') return 0;
    if (l.kind === 'spa-action') return 1;
    if (l.kind === 'preferences') return 2;
    if (l.via === 'tracker') return 3;
    return 4;
  };
  const probeable = links
    .filter((l) => ['one-click-unsubscribe', 'preferences', 'site', 'spa-action'].includes(l.kind) || l.via === 'tracker')
    .sort((a, b) => priority(a) - priority(b))
    .slice(0, budget);

  const findings = [];
  let networkErrors = 0;
  for (const link of probeable) {
    let got = [];
    if (link.via === 'tracker') {
      got = await auditTrackerLink(link, opts);
    } else if (link.kind === 'one-click-unsubscribe') {
      got = await probeOneClickUnsubscribe(link.url, opts);
    } else if (link.kind === 'spa-action') {
      // Deliberately NOT probed for status: the server answers 200 with the
      // home page whatever the query says (trap 2). The `ac` requirement is
      // the only checkable property and auditEmailLinksStatic already has it.
      got = [];
    } else {
      got = await auditOneSiteLink(link, opts);
    }
    if (got.some((f) => /_probe_network$/.test(f.code))) networkErrors += 1;
    findings.push(...got);
  }

  if (probeable.length >= 3 && networkErrors >= Math.ceil(probeable.length * 0.8)) {
    return {
      findings: [finding('warn', 'live_check_failed_open', `${networkErrors}/${probeable.length} probes failed at the network layer — suspected transient network issue on our side, live verdicts discarded`)],
      probed: probeable.length,
      failedOpen: true,
    };
  }
  return { findings, probed: probeable.length, failedOpen: false };
}

/**
 * Full audit of one message we actually sent: static first (it needs no
 * network and catches the shape no HTTP response can report), then live.
 *
 * @param {string} html the body handed to the provider for ONE recipient
 * @param {object} [opts]
 * @param {string} [opts.channel] sender id, for the report
 * @param {boolean} [opts.live=true] run the network half
 * @param {number} [opts.budget]
 * @param {typeof fetch} [opts.fetchImpl]
 */
export async function auditSentEmail(html, opts = {}) {
  const { live = true, channel = 'unknown' } = opts;
  const stat = auditEmailLinksStatic(html, opts);
  const findings = [...stat.findings];
  let probed = 0;
  let failedOpen = false;
  if (live && stat.links.length) {
    const res = await auditEmailLinksLive(stat.links, opts);
    findings.push(...res.findings);
    probed = res.probed;
    failedOpen = res.failedOpen;
  }
  return {
    channel,
    findings,
    links: stat.links,
    counts: stat.counts,
    probed,
    failedOpen,
    ok: !findings.some((f) => f.severity === 'error'),
  };
}

/** Human-readable report. Recipient addresses are redacted — sender logs are
 * public CI artifacts. */
export function formatAuditReport(result) {
  const lines = [];
  const errors = result.findings.filter((f) => f.severity === 'error');
  const warns = result.findings.filter((f) => f.severity === 'warn');
  const infos = result.findings.filter((f) => f.severity === 'info');
  const head = `link audit [${result.channel}]: ${result.links.length} link(s), ${result.probed} probed`;
  lines.push(result.ok ? `\u2705 ${head} — no defect` : `\u274c ${head} — ${errors.length} error(s)`);
  for (const f of errors) lines.push(`  \u2717 ${f.code}: ${redactEmails(f.detail)}${f.url ? `\n      ${f.url}` : ''}`);
  for (const f of warns) lines.push(`  \u26a0\ufe0f ${f.code}: ${redactEmails(f.detail)}${f.url ? `\n      ${f.url}` : ''}`);
  for (const f of infos) lines.push(`  \u2139\ufe0f ${f.code}: ${redactEmails(f.detail)}${f.url ? `\n      ${f.url}` : ''}`);
  return lines.join('\n');
}
