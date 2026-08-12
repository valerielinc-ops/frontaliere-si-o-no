/**
 * Guard for issue #5682 — nothing verified that the links of an email we
 * actually sent work.
 *
 * The pre-existing presidio was a substring test in
 * scripts/send-newsletter.mjs: `sampleHtml.includes('action=unsubscribe')`.
 * It asserts the TEXT is present, never that the URL resolves, that the
 * endpoint answers, or that the click does anything — the #5672/#5673
 * unsubscribe defect lived for months behind exactly that green check.
 *
 * These tests pin the semantics of the audit that replaces it, and in
 * particular the two traps that make the "obvious" version of this check wrong
 * on this site (both measured against production on 2026-08-12):
 *
 *   - a 404 can be a WORKING link (the preferences page is not prerendered and
 *     404.html boots the SPA back onto the route), so the verdict is on the
 *     body marker, not the status;
 *   - a 200 can be a BROKEN link (the SPA-handled `?action=unsubscribe` URL
 *     always returns the home page, and App.tsx rejects it without `ac`), so
 *     that one is asserted statically and never probed at all.
 *
 * No test here touches the network: every live path runs against a stubbed
 * fetch. The real endpoints are probed by
 * `node scripts/check-sent-email-links.mjs --endpoints`.
 */
import { describe, expect, it, vi, afterEach, beforeEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import {
  extractEmailLinks,
  classifyEmailLink,
  decodeTrackedUrl,
  auditEmailLinksStatic,
  auditEmailLinksLive,
  auditSentEmail,
  probeOneClickUnsubscribe,
  resolveRedirectChain,
  formatAuditReport,
  redactEmails,
  preferencesPaths,
  ONE_CLICK_UNSUBSCRIBE_PATHS,
  INVALID_TOKEN_PROBE,
  SPA_FALLTHROUGH_MARKER,
  SITE_HOST,
} from '../scripts/lib/email-link-audit.mjs';
import {
  makeUnsubscribeUrl,
  makeOneClickUnsubscribeUrl,
  makeAuthenticatedActionUrl,
  makePreferencesUrl,
  PREFERENCES_SLUG,
} from '../services/newsletterUrls.mjs';
import { MASS_EMAIL_CHANNELS, resolveChannel } from '../scripts/lib/email-cascade.mjs';

const CANARY = 'link-audit-canary@example.com';
const REPO_ROOT = path.resolve(__dirname, '..');

/** Source-scanning guards must read CODE, not prose. Without this, the comment
 * that explains why a sender must wrap its hrefs contains the very identifier
 * the guard looks for, and the guard passes on a file that does nothing —
 * measured: reverting the drip fix left the class guard green until comments
 * were stripped. */
function stripComments(src: string) {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
}

function bodyWith(...hrefs: string[]) {
  const links = hrefs.map((h) => `<a href="${h.replace(/&/g, '&amp;')}">click</a>`).join('\n');
  return `<html><body><p>${'filler '.repeat(60)}</p>${links}</body></html>`;
}

function res(status: number, { location, body = '' }: { location?: string; body?: string } = {}) {
  return {
    status,
    ok: status >= 200 && status < 300,
    headers: { get: (h: string) => (h.toLowerCase() === 'location' ? location ?? null : null) },
    text: async () => body,
  };
}

describe('extractEmailLinks', () => {
  it('decodes HTML entities, dedupes, and keeps document order', () => {
    const html = '<a href="https://a.test/?x=1&amp;y=2">a</a><a href="https://b.test/">b</a><a href="https://a.test/?x=1&amp;y=2">dup</a>';
    expect(extractEmailLinks(html)).toEqual(['https://a.test/?x=1&y=2', 'https://b.test/']);
  });

  it('reads single-quoted hrefs too (templates are not consistent about it)', () => {
    expect(extractEmailLinks("<a href='https://a.test/'>a</a>")).toEqual(['https://a.test/']);
  });
});

describe('classifyEmailLink — the distinction issue #5682 point 2 says nothing tests today', () => {
  it('makeOneClickUnsubscribeUrl → one-click-unsubscribe (Cloud Function, works without ac)', () => {
    const c = classifyEmailLink(makeOneClickUnsubscribeUrl(CANARY));
    expect(c.kind).toBe('one-click-unsubscribe');
  });

  it('makeUnsubscribeUrl → spa-action (site root, SPA-handled, REQUIRES ac)', () => {
    const c = classifyEmailLink(makeUnsubscribeUrl(CANARY));
    expect(c.kind).toBe('spa-action');
    expect(c.action).toBe('unsubscribe');
    expect(c.hasAc).toBe(false);
  });

  it('makeAuthenticatedActionUrl → spa-action WITH ac (the shape that actually works)', () => {
    const prev = process.env.NEWSLETTER_SECRET;
    process.env.NEWSLETTER_SECRET = 'test-secret';
    try {
      const c = classifyEmailLink(makeAuthenticatedActionUrl('unsubscribe', CANARY));
      expect(c.kind).toBe('spa-action');
      expect(c.hasAc).toBe(true);
    } finally {
      if (prev === undefined) delete process.env.NEWSLETTER_SECRET;
      else process.env.NEWSLETTER_SECRET = prev;
    }
  });

  it('recognises all four Worker-proxied unsubscribe paths, bare and trailing-slash', () => {
    for (const base of ONE_CLICK_UNSUBSCRIBE_PATHS) {
      expect(classifyEmailLink(`https://${SITE_HOST}${base}?token=x`).kind).toBe('one-click-unsubscribe');
      expect(classifyEmailLink(`https://${SITE_HOST}${base}/?token=x`).kind).toBe('one-click-unsubscribe');
    }
  });

  it('classifies the rest: preferences, asset, external, mailto, anchor, relative', () => {
    expect(classifyEmailLink(`https://${SITE_HOST}/preferenze-newsletter/?email=a&token=b`).kind).toBe('preferences');
    expect(classifyEmailLink(`https://${SITE_HOST}/images/logo.png`).kind).toBe('asset');
    expect(classifyEmailLink('https://example.com/x').kind).toBe('external');
    expect(classifyEmailLink('mailto:a@example.com').kind).toBe('mailto');
    expect(classifyEmailLink('#footer').kind).toBe('anchor');
    expect(classifyEmailLink('/relative/path').kind).toBe('relative');
  });
});

describe('one-click unsubscribe path table — drift guard vs the Cloudflare Worker', () => {
  it('matches UNSUB_PROXIES in infra/cloudflare-worker/locale-router.js', () => {
    const src = fs.readFileSync(path.join(REPO_ROOT, 'infra/cloudflare-worker/locale-router.js'), 'utf8');
    const block = src.match(/const UNSUB_PROXIES = \{([\s\S]*?)\};/);
    expect(block, 'UNSUB_PROXIES table not found — did the Worker rename it?').toBeTruthy();
    const paths = [...block![1].matchAll(/'(\/[^']+)':/g)].map((m) => m[1]);
    expect(paths.length).toBeGreaterThan(0);
    expect([...ONE_CLICK_UNSUBSCRIBE_PATHS].sort()).toEqual([...paths].sort());
  });
});

describe('preferences paths are derived, not copied', () => {
  it('one entry per locale of PREFERENCES_SLUG, IT at the root and the rest prefixed', () => {
    const paths = preferencesPaths();
    expect(paths).toHaveLength(Object.keys(PREFERENCES_SLUG).length);
    expect(paths).toContain(`/${PREFERENCES_SLUG.it}/`);
    expect(paths).toContain(`/en/${PREFERENCES_SLUG.en}/`);
  });

  it('every derived path is what makePreferencesUrl actually builds', () => {
    const prev = process.env.NEWSLETTER_SECRET;
    process.env.NEWSLETTER_SECRET = 'test-secret';
    try {
      for (const locale of Object.keys(PREFERENCES_SLUG)) {
        const built = new URL(makePreferencesUrl(CANARY, locale)!);
        expect(preferencesPaths()).toContain(`${built.pathname.replace(/\/?$/, '/')}`);
      }
    } finally {
      if (prev === undefined) delete process.env.NEWSLETTER_SECRET;
      else process.env.NEWSLETTER_SECRET = prev;
    }
  });
});

describe('auditEmailLinksStatic — what no HTTP response can ever report', () => {
  const prev = process.env.NEWSLETTER_SECRET;
  beforeEach(() => { process.env.NEWSLETTER_SECRET = 'test-secret'; });
  afterEach(() => {
    if (prev === undefined) delete process.env.NEWSLETTER_SECRET;
    else process.env.NEWSLETTER_SECRET = prev;
  });

  it('reproduces the #5672 shape: a footer unsubscribe built with makeUnsubscribeUrl and never given ac', () => {
    const { findings } = auditEmailLinksStatic(bodyWith(makeUnsubscribeUrl(CANARY)), { channel: 'onboarding-drip' });
    const codes = findings.map((f) => f.code);
    expect(codes).toContain('spa_action_without_ac');
    expect(findings.find((f) => f.code === 'spa_action_without_ac')!.severity).toBe('error');
  });

  it('…and is clean once the same link is built with makeAuthenticatedActionUrl', () => {
    const { findings } = auditEmailLinksStatic(bodyWith(makeAuthenticatedActionUrl('unsubscribe', CANARY)), { channel: 'onboarding-drip' });
    expect(findings.filter((f) => f.severity === 'error')).toEqual([]);
  });

  it('…and is clean with the one-click endpoint, which needs no ac at all', () => {
    const { findings } = auditEmailLinksStatic(bodyWith(makeOneClickUnsubscribeUrl(CANARY)), { channel: 'newsletter-weekly' });
    expect(findings.filter((f) => f.severity === 'error')).toEqual([]);
  });

  it('flags an unsigned unsubscribe link — the "degrades gracefully" branch of newsletterUrls.js', () => {
    delete process.env.NEWSLETTER_SECRET;
    const { findings } = auditEmailLinksStatic(bodyWith(makeOneClickUnsubscribeUrl(CANARY)), { channel: 'newsletter-weekly' });
    expect(findings.map((f) => f.code)).toContain('unsigned_link');
  });

  it('does NOT call the outreach opt-out unsigned just because it signs with `t` instead of `token`', () => {
    // scripts/lib/outreach-unsubscribe-token.mjs builds
    // /disiscrivi-outreach/?c=<key>&t=<hmac>. Reading only `token` would have
    // reported the whole cold-email channel as unsigned on every single send.
    const { findings } = auditEmailLinksStatic(
      bodyWith(`https://${SITE_HOST}/disiscrivi-outreach/?c=acme&t=${'a'.repeat(64)}`),
      { channel: 'cold-email' },
    );
    expect(findings.map((f) => f.code)).not.toContain('unsigned_link');
    expect(findings.map((f) => f.code)).not.toContain('unsubscribe_missing');
  });

  it('accepts every channel\'s own one-click endpoint as a valid unsubscribe link', () => {
    for (const base of ONE_CLICK_UNSUBSCRIBE_PATHS) {
      const { findings } = auditEmailLinksStatic(
        bodyWith(`https://${SITE_HOST}${base}/?token=${'a'.repeat(64)}`),
        { channel: 'coverage-probe' },
      );
      expect(findings.map((f) => f.code), `${base} was not recognised`).not.toContain('unsubscribe_missing');
    }
  });

  it('flags a body with no unsubscribe link of either shape', () => {
    const { findings } = auditEmailLinksStatic(bodyWith(`https://${SITE_HOST}/blog/`), { channel: 'daily-brief' });
    expect(findings.map((f) => f.code)).toContain('unsubscribe_missing');
  });

  it('does not require one for a transactional channel that is not a subscription', () => {
    const { findings } = auditEmailLinksStatic(bodyWith(`https://${SITE_HOST}/blog/`), {
      channel: 'journalist-notify',
      requireUnsubscribe: false,
    });
    expect(findings.map((f) => f.code)).not.toContain('unsubscribe_missing');
  });

  it('half-wrapped autologin is an error; a uniformly un-wrapped message is not (autologinEnabled:false)', () => {
    const half = auditEmailLinksStatic(
      bodyWith(
        makeOneClickUnsubscribeUrl(CANARY),
        `https://${SITE_HOST}/a/?ne=x%40example.com&ac=abc`,
        `https://${SITE_HOST}/b/?ne=x%40example.com`,
      ),
      { channel: 'newsletter-weekly' },
    );
    expect(half.findings.map((f) => f.code)).toContain('authenticated_without_ac');

    const uniform = auditEmailLinksStatic(
      bodyWith(makeOneClickUnsubscribeUrl(CANARY), `https://${SITE_HOST}/b/?ne=x%40example.com`),
      { channel: 'newsletter-weekly' },
    );
    expect(uniform.findings.map((f) => f.code)).not.toContain('authenticated_without_ac');
  });

  it('flags relative hrefs and unresolved template variables', () => {
    const { findings } = auditEmailLinksStatic(
      `${bodyWith(makeOneClickUnsubscribeUrl(CANARY), '/gestisci/')} {{FIRST_NAME}}`,
      { channel: 'newsletter-weekly' },
    );
    const codes = findings.map((f) => f.code);
    expect(codes).toContain('relative_href');
    expect(codes).toContain('template_var_unresolved');
  });
});

describe('provider click tracking — the hop that exists only in the delivered copy', () => {
  const destination = `https://${SITE_HOST}/?action=unsubscribe&email=${encodeURIComponent(CANARY)}&token=abc`;
  const tracked = `https://click.${SITE_HOST}/v2/redirect/${Buffer.from(destination).toString('base64url')}`;

  it('decodeTrackedUrl recovers the destination from the base64 payload, no network', () => {
    expect(decodeTrackedUrl(tracked)).toBe(destination);
  });

  it('returns null for a non-tracker URL and for an undecodable payload', () => {
    expect(decodeTrackedUrl(`https://${SITE_HOST}/x`)).toBeNull();
    expect(decodeTrackedUrl(`https://click.${SITE_HOST}/v2/redirect/@@@`)).toBeNull();
  });

  it('a tracked link is judged on its DESTINATION: the missing ac is still reported through the wrapper', () => {
    const { findings, links } = auditEmailLinksStatic(bodyWith(tracked), { channel: 'newsletter-weekly' });
    expect(links[0].via).toBe('tracker');
    expect(links[0].kind).toBe('spa-action');
    expect(findings.map((f) => f.code)).toContain('spa_action_without_ac');
  });

  it('resolveRedirectChain follows the tracker 302 to the destination and records every hop', async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(res(302, { location: destination }))
      .mockResolvedValueOnce(res(200));
    const chain = await resolveRedirectChain(tracked, { fetchImpl });
    expect(chain.hops.map((h) => h.status)).toEqual([302, 200]);
    expect(chain.finalUrl).toBe(destination);
    // Manual redirect handling is the point: `redirect: 'follow'` would collapse
    // the tracker hop and the audit could not tell it apart from a direct link.
    expect(fetchImpl.mock.calls[0][1].redirect).toBe('manual');
  });

  it('stops at maxHops instead of looping forever', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(res(302, { location: `https://${SITE_HOST}/loop` }));
    const chain = await resolveRedirectChain(`https://${SITE_HOST}/loop`, { fetchImpl, maxHops: 3 });
    expect(chain.error).toBe('too many redirects');
    expect(fetchImpl).toHaveBeenCalledTimes(4);
  });
});

describe('probeOneClickUnsubscribe — read-only by construction', () => {
  it('the probe token can never verify: not 64-char hex, so signedEmailToken cannot match it', () => {
    expect(INVALID_TOKEN_PROBE).not.toMatch(/^[0-9a-f]{64}$/);
  });

  it('replaces the recipient token with the invalid probe and never POSTs', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(res(403));
    await probeOneClickUnsubscribe(makeOneClickUnsubscribeUrl(CANARY), { fetchImpl });
    const [url, init] = fetchImpl.mock.calls[0];
    expect(new URL(url).searchParams.get('token')).toBe(INVALID_TOKEN_PROBE);
    expect(init.method).toBe('GET');
  });

  it('invalidates BOTH spellings of the signature param (outreach signs with `t`, the rest with `token`)', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(res(403));
    await probeOneClickUnsubscribe(`https://${SITE_HOST}/disiscrivi-outreach/?c=acme&t=realsignature`, { fetchImpl });
    const probed = new URL(fetchImpl.mock.calls[0][0]);
    expect(probed.searchParams.get('t')).toBe(INVALID_TOKEN_PROBE);
    expect(probed.searchParams.get('t')).not.toBe('realsignature');
  });

  it('403 to an invalid token is the PASS — the route is alive AND enforcing', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(res(403));
    expect(await probeOneClickUnsubscribe(`https://${SITE_HOST}/disiscrivi-newsletter/?token=x`, { fetchImpl })).toEqual([]);
  });

  it('404 is oneclick_route_dead — the List-Unsubscribe target is not served', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(res(404));
    const out = await probeOneClickUnsubscribe(`https://${SITE_HOST}/disiscrivi-newsletter/?token=x`, { fetchImpl });
    expect(out[0].code).toBe('oneclick_route_dead');
    expect(out[0].severity).toBe('error');
  });

  it('200 is oneclick_route_unenforced — something other than the Cloud Function is answering', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(res(200, { body: '<html>home</html>' }));
    const out = await probeOneClickUnsubscribe(`https://${SITE_HOST}/disiscrivi-newsletter/?token=x`, { fetchImpl });
    expect(out[0].code).toBe('oneclick_route_unenforced');
    expect(out[0].severity).toBe('error');
  });

  it('a network failure is a warn, never a dead-route error', async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new Error('ECONNRESET'));
    const out = await probeOneClickUnsubscribe(`https://${SITE_HOST}/disiscrivi-newsletter/?token=x`, { fetchImpl });
    expect(out[0].severity).toBe('warn');
  });
});

describe('auditEmailLinksLive — the two traps', () => {
  const spaFallthrough404 = res(404, { body: `<script>sessionStorage.redirect = location.href; location.replace('/');</script>` });

  it('TRAP 1: a 404 carrying the SPA fallthrough marker is info, not an error (the preferences page)', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(spaFallthrough404);
    const links = [classifyEmailLink(`https://${SITE_HOST}/preferenze-newsletter/?email=a&token=b`)];
    const { findings } = await auditEmailLinksLive(links, { fetchImpl });
    expect(findings).toHaveLength(1);
    expect(findings[0].code).toBe('spa_fallthrough_404');
    expect(findings[0].severity).toBe('info');
    expect(spaFallthrough404.text.toString()).toBeTruthy();
  });

  it('…while a 404 WITHOUT the marker is a real dead end', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(res(404, { body: '<title>Page not found &middot; GitHub Pages</title>' }));
    const links = [classifyEmailLink(`https://${SITE_HOST}/en/newsletter-preferences/?email=a&token=b`)];
    const { findings } = await auditEmailLinksLive(links, { fetchImpl });
    expect(findings[0].code).toBe('dead_link');
    expect(findings[0].severity).toBe('error');
  });

  it('the marker is what separates them, and it is the string the built 404.html emits', () => {
    expect(SPA_FALLTHROUGH_MARKER).toBe('sessionStorage.redirect');
  });

  it('TRAP 2: an spa-action link is never probed — the origin answers 200 with the home page whatever the query says', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(res(200, { body: '<html>home</html>' }));
    const links = [classifyEmailLink(makeUnsubscribeUrl(CANARY))];
    const { findings } = await auditEmailLinksLive(links, { fetchImpl });
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(findings).toEqual([]);
  });

  it('fails open on a systemic network outage instead of reporting a wall of dead links', async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new Error('network unreachable'));
    const links = Array.from({ length: 6 }, (_, i) => classifyEmailLink(`https://${SITE_HOST}/p${i}/`));
    const out = await auditEmailLinksLive(links, { fetchImpl });
    expect(out.failedOpen).toBe(true);
    expect(out.findings).toHaveLength(1);
    expect(out.findings[0].code).toBe('live_check_failed_open');
    expect(out.findings.some((f) => f.severity === 'error')).toBe(false);
  });

  it('budgets the probes so a 60-card digest is not 60 origin requests, unsubscribe first', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(res(403));
    const links = [
      ...Array.from({ length: 40 }, (_, i) => classifyEmailLink(`https://${SITE_HOST}/job-${i}/`)),
      classifyEmailLink(`https://${SITE_HOST}/disiscrivi-newsletter/?token=x`),
    ];
    const out = await auditEmailLinksLive(links, { fetchImpl, budget: 5 });
    expect(out.probed).toBe(5);
    expect(fetchImpl.mock.calls[0][0]).toContain('/disiscrivi-newsletter/');
  });
});

describe('auditSentEmail + report', () => {
  it('ok=false as soon as one finding is an error, and the report names it', async () => {
    const result = await auditSentEmail(bodyWith(makeUnsubscribeUrl(CANARY)), { channel: 'onboarding-drip', live: false });
    expect(result.ok).toBe(false);
    expect(formatAuditReport(result)).toContain('spa_action_without_ac');
  });

  it('never leaks a recipient address into the report — sender logs are public CI artifacts', async () => {
    const result = await auditSentEmail(bodyWith(makeUnsubscribeUrl(CANARY)), { channel: 'onboarding-drip', live: false });
    const report = formatAuditReport(result);
    expect(report).not.toContain(CANARY);
    expect(report).toContain('<redacted>');
  });

  it('redactEmails covers the percent-encoded form too, which is how addresses appear in URLs', () => {
    expect(redactEmails('https://x/?email=a.b%40example.com&t=1')).not.toContain('example.com');
  });
});

describe('channel coverage — "la copertura, non il campione" (#5682 point 4)', () => {
  it('every scripts/ sender that pushes mail through the cascade is registered', () => {
    const dir = path.join(REPO_ROOT, 'scripts');
    // Importing the module is not enough — check-email-quotas.mjs pulls in the
    // quota helpers and probe-mailgun-scheduled.mjs pulls in toRfc2822Utc
    // without ever sending; only a file that also names sendEmailCascade
    // reaches an inbox. Both import forms count: most senders reach for the
    // cascade with a dynamic `await import(...)` inside the send function
    // rather than a static import at the top.
    const senders = fs.readdirSync(dir)
      .filter((f) => f.endsWith('.mjs'))
      .filter((f) => {
        const src = fs.readFileSync(path.join(dir, f), 'utf8');
        return src.includes('email-cascade.mjs') && /\bsendEmailCascade\b/.test(src);
      });
    expect(senders.length).toBeGreaterThan(5);
    const unregistered = senders.filter((f) => !(f in MASS_EMAIL_CHANNELS));
    expect(
      unregistered,
      `these senders reach real inboxes but are not in MASS_EMAIL_CHANNELS, so the post-send link audit would not name them: ${unregistered.join(', ')}`,
    ).toEqual([]);
  });

  it('covers every mass channel issue #5682 lists', () => {
    const ids = Object.values(MASS_EMAIL_CHANNELS).map((c) => c.id);
    for (const id of ['daily-brief', 'newsletter-weekly', 'job-alert', 'onboarding-drip', 'winback', 'saved-jobs-digest']) {
      expect(ids, `channel ${id} is not covered`).toContain(id);
    }
  });

  it('resolveChannel maps an entry script to its channel, and defaults to requiring an unsubscribe link', () => {
    expect(resolveChannel('/x/scripts/send-daily-brief.mjs').id).toBe('daily-brief');
    expect(resolveChannel('/x/scripts/brand-new-sender.mjs')).toEqual({ id: 'brand-new-sender', requireUnsubscribe: true });
  });

  it('only mail that is not a subscription may opt out of the unsubscribe requirement', () => {
    const exempt = Object.entries(MASS_EMAIL_CHANNELS).filter(([, c]) => c.requireUnsubscribe === false).map(([f]) => f).sort();
    expect(exempt).toEqual(['monitor-gsc-job-indexation.mjs', 'notify-journalist-article-live.mjs']);
  });
});

describe('sender call sites — the class of the #5672 defect, not just the one file', () => {
  /** Senders that import the SPA-handled builder and therefore owe the reader
   * an `ac`. scripts/send-saved-jobs-digest.mjs defines its own unrelated local
   * makeUnsubscribeUrl(uid, email) against a different endpoint and token
   * scheme, so it is excluded by construction: only IMPORTERS of the shared
   * builder are in scope. */
  function importersOfSpaUnsubscribeBuilder() {
    const dir = path.join(REPO_ROOT, 'scripts');
    return fs.readdirSync(dir)
      .filter((f) => f.endsWith('.mjs'))
      .map((f) => ({ file: f, src: stripComments(fs.readFileSync(path.join(dir, f), 'utf8')) }))
      .filter(({ src }) => /import\s*\{[\s\S]*?\bmakeUnsubscribeUrl\b[\s\S]*?\}\s*from\s*'[^']*newsletterUrls\.mjs'/.test(src));
  }

  it('no sender hands makeUnsubscribeUrl to a template without also injecting the autologin code', () => {
    // makeUnsubscribeUrl targets the site root and is decided by App.tsx, which
    // answers "Link non valido" without `ac`. It is only safe in a body when the
    // same sender rewrites its hrefs with an autologin code afterwards.
    // scripts/send-onboarding-drip.mjs did neither — it built the link with
    // makeUnsubscribeUrl and had no wrapping anywhere in the file, so every drip
    // footer unsubscribe link shipped un-clickable.
    const offenders = importersOfSpaUnsubscribeBuilder()
      .filter(({ src }) => !/wrapAuthenticatedHrefs|makeAuthenticatedUrl|personalizeHtmlWithToken/.test(src))
      .map(({ file }) => file);
    expect(
      offenders,
      `these senders build the SPA-handled unsubscribe URL and never add the ac autologin code, so their footer link cannot work: ${offenders.join(', ')}`,
    ).toEqual([]);
  });

  it('the drip sender uses the builder that carries ac (regression guard for the fix in this PR)', () => {
    const src = fs.readFileSync(path.join(REPO_ROOT, 'scripts/send-onboarding-drip.mjs'), 'utf8');
    expect(src).toMatch(/unsubscribeUrl:\s*makeAuthenticatedActionUrl\('unsubscribe'/);
    expect(src).not.toMatch(/unsubscribeUrl:\s*makeUnsubscribeUrl\(/);
  });

  it('the weekly newsletter falls back to the one-click endpoint when the recipient has no autologin code', () => {
    // codeMap holds null for subscribers with autologinEnabled:false, and
    // makeAuthenticatedUrl with a null code adds `ne` and no `ac` — those
    // recipients were getting the un-clickable shape.
    const src = fs.readFileSync(path.join(REPO_ROOT, 'scripts/send-newsletter.mjs'), 'utf8');
    expect(src).toMatch(/codeMap\.get\(subscriber\.email\)[\s\S]{0,120}makeOneClickUnsubscribeUrl\(subscriber\.email\)/);
  });

  it('the weekly newsletter QA gate runs the real audit instead of the substring test', () => {
    const src = fs.readFileSync(path.join(REPO_ROOT, 'scripts/send-newsletter.mjs'), 'utf8');
    expect(src).toContain('auditEmailLinksStatic(sampleHtml');
    expect(src).not.toMatch(/if \(!sampleHtml\.includes\('action=unsubscribe'\)\)/);
  });
});

describe('the cascade wrapper — where the actually-sent HTML is audited', () => {
  afterEach(() => { vi.resetModules(); vi.unstubAllEnvs(); });

  async function loadCascadeWith(baseImpl: (...a: unknown[]) => unknown) {
    // resetModules FIRST: the top of this file already imported the shim for
    // MASS_EMAIL_CHANNELS, so without it the cached copy (bound to the real
    // cascade) would be returned and every assertion below would silently be
    // measuring the production sender instead of the wrapper.
    vi.resetModules();
    vi.doMock('../functions/src/emailCascade.js', () => ({
      sendEmailCascade: baseImpl,
      PROVIDERS: [],
      isProviderConfigured: () => false,
    }));
    return import('../scripts/lib/email-cascade.mjs');
  }

  it('returns the base cascade result untouched and audits the delivered body', async () => {
    const sentItem = { recipient: { email: CANARY }, payload: { html: bodyWith(makeUnsubscribeUrl(CANARY)) } };
    const base = vi.fn().mockResolvedValue({ sent: [sentItem], failed: [] });
    const mod = await loadCascadeWith(base);
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const prevExit = process.exitCode;

    const out = await mod.sendEmailCascade([sentItem]);

    expect(out).toEqual({ sent: [sentItem], failed: [] });
    expect(base).toHaveBeenCalledTimes(1);
    expect(logSpy.mock.calls.flat().join('\n')).toContain('spa_action_without_ac');
    process.exitCode = prevExit;
    errSpy.mockRestore();
    logSpy.mockRestore();
  });

  it('audits nothing when the send failed — there is no delivered message to audit', async () => {
    const base = vi.fn().mockResolvedValue({ sent: [], failed: [{ recipient: { email: CANARY } }] });
    const mod = await loadCascadeWith(base);
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    await mod.sendEmailCascade([{ recipient: { email: CANARY }, payload: { html: bodyWith('/broken') } }]);
    expect(logSpy.mock.calls.flat().join('\n')).not.toContain('link audit');
    logSpy.mockRestore();
  });

  it('runs the live probes only when the canary is in the batch (no probing of strangers\' messages)', async () => {
    vi.stubEnv('CANARY_OWNER_EMAIL', CANARY);
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const strangerItem = {
      recipient: { email: 'someone-else@example.com' },
      payload: { html: bodyWith(makeOneClickUnsubscribeUrl('someone-else@example.com')) },
    };
    const base = vi.fn().mockResolvedValue({ sent: [strangerItem], failed: [] });
    const mod = await loadCascadeWith(base);
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    await mod.sendEmailCascade([strangerItem]);

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(logSpy.mock.calls.flat().join('\n')).toContain('no canary recipient');
    logSpy.mockRestore();
    fetchSpy.mockRestore();
  });

  it('a throwing audit never looks like a broken send', async () => {
    const weird = { recipient: { email: CANARY }, get payload() { throw new Error('boom'); } };
    const base = vi.fn().mockResolvedValue({ sent: [weird], failed: [] });
    const mod = await loadCascadeWith(base);
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await expect(mod.sendEmailCascade([weird])).resolves.toEqual({ sent: [weird], failed: [] });
    expect(warnSpy.mock.calls.flat().join('\n')).toContain('link audit skipped');
    warnSpy.mockRestore();
  });

  it('EMAIL_LINK_AUDIT=off skips it entirely', async () => {
    vi.stubEnv('EMAIL_LINK_AUDIT', 'off');
    const item = { recipient: { email: CANARY }, payload: { html: bodyWith(makeUnsubscribeUrl(CANARY)) } };
    const base = vi.fn().mockResolvedValue({ sent: [item], failed: [] });
    const mod = await loadCascadeWith(base);
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    await mod.sendEmailCascade([item]);
    expect(logSpy.mock.calls.flat().join('\n')).not.toContain('link audit');
    logSpy.mockRestore();
  });
});
