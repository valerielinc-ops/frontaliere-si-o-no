/**
 * #5725 — the PERIMETER of the `ac` autologin credential.
 *
 * #5719 gave `ac` a lifetime. It did not give it a perimeter: the rule deciding
 * which links carried it was a DENYLIST — "ours, and not mailto/tel/#/images" —
 * so every link in a message towards our own site got a code that mints a
 * Firebase session, whatever the destination did with one. Measured on a job
 * alert, up to eleven links of twelve.
 *
 * A TTL and an allowlist are not the same measure and neither replaces the
 * other. The TTL shortens how long one leaked copy is useful. The allowlist
 * reduces how many copies are minted into the provider's click log, the
 * recipient's anti-phishing scanner (25 fetches in 7 seconds from Microsoft IPs
 * on this domain, #5674), every forward and every corporate archive.
 *
 * ── What these tests are shaped against ─────────────────────────────────────
 *
 * The lesson of #5764 is that the recent defects were not hidden, they were
 * NOT SAMPLED: a green gate over a population that excludes the broken case is
 * indistinguishable from a gate that works. So the question here is never "does
 * the test pass" but "which shape has this test never seen":
 *
 *  - a destination NOBODY HAS ADDED YET. It must be born WITHOUT the credential.
 *    That is the one case that tells an allowlist apart from a denylist, and it
 *    is the first block below;
 *  - every link that is really in a message, built by IMPORTING THE REAL
 *    BUILDERS. Hand-written URL strings in a test are how this family of defect
 *    survives — #5767 found an opt-out regex that missed `action=unsubscribe_all`
 *    because `_` is a word character and `\b` never matched, and every fixture
 *    it had was written by hand;
 *  - the shapes a URL actually arrives in: a query string already populated, a
 *    `#` fragment, an absolute URL to somebody else's host (the worst one to get
 *    wrong), odd casing, a trailing slash or none.
 */
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

import {
  AUTOLOGIN_DESTINATIONS,
  autologinDestination,
  FOLLOWED_COMPANIES_SLUG,
  isOwnRewritableHref,
  makeAuthenticatedActionUrl,
  makeAuthenticatedUrl,
  makeOneClickUnsubscribeUrl,
  makePreferencesUrl,
  makeUnsubscribeUrl,
  PREFERENCES_SLUG,
  shouldWrapAuthenticatedHref,
  wrapAuthenticatedHrefs,
} from '../functions/src/lib/newsletterUrls.js';
// The REAL job-alert unsubscribe builders, imported and not re-implemented.
// (This module is also touched by #5767; nothing here modifies it.)
import {
  makeAlertUnsubscribeUrl,
  makeAllAlertsUnsubscribeUrl,
} from '../scripts/lib/job-alert-unsub-urls.mjs';
import { SLUG_TABLES } from '../services/routeSlugs.data';

const SECRET = 'test-newsletter-secret-key-2026';
const EMAIL = 'user@example.com';
const BASE = 'https://frontaliereticino.ch';

/** `ac`, and only `ac` — the credential this issue is about. */
const hasAc = (url: string) => new URL(url).searchParams.has('ac');
/** The recipient's address in the query string; it only ever travels with `ac`. */
const hasNe = (url: string) => new URL(url).searchParams.has('ne');

const wrap = (target: string, opts: Record<string, unknown> = {}) =>
  makeAuthenticatedUrl(target, EMAIL, { secret: SECRET, ...opts });

// ─────────────────────────────────────────────────────────────────────────────
describe('fail-closed: a destination the allowlist has never seen', () => {
  // THE test of this PR. Under the old denylist every one of these was born
  // carrying a session-minting credential, and stayed that way until somebody
  // noticed. Under an allowlist a page that does not exist yet is born without
  // one, and giving it one is a deliberate edit to AUTOLOGIN_DESTINATIONS.
  const neverSeen = [
    `${BASE}/una-pagina-che-non-esiste-ancora/`,
    `${BASE}/en/a-page-nobody-has-written-yet/`,
    `${BASE}/2027/una-sezione-futura/con-un-sottopercorso/`,
    // Shapes that already exist and that #5725 names explicitly as not needing it.
    `${BASE}/`,
    `${BASE}/en/`,
    `${BASE}/blog/come-funziona-il-frontalierato/`,
    `${BASE}/cerca-lavoro-ticino/`,
    `${BASE}/ricerca-lavoro-infermiere-ticino/`,
    `${BASE}/calcola-stipendio/`,
  ];

  it.each(neverSeen)('%s is born WITHOUT the credential', (target) => {
    expect(autologinDestination(target)).toBeNull();
    expect(shouldWrapAuthenticatedHref(target)).toBe(false);
    const out = wrap(target);
    expect(hasAc(out)).toBe(false);
    expect(hasNe(out)).toBe(false);
  });

  it('…and still keeps its campaign attribution, so nothing moves into GA4 `direct`', () => {
    // The fix must not be paid for in analytics. utm_medium is what GA4's Email
    // channel grouping keys on; a perimeter that also stripped it would trade a
    // credential leak for a reporting outage.
    const out = wrap(`${BASE}/una-pagina-che-non-esiste-ancora/`, { utmCampaign: 'weekly_2026_33' });
    const params = new URL(out).searchParams;
    expect(params.get('utm_medium')).toBe('newsletter');
    expect(params.get('utm_campaign')).toBe('weekly_2026_33');
    expect(params.has('ac')).toBe(false);
  });

  it('the home page is out even though it is the most linked page of every send', () => {
    // The discriminator is `action`, not the path: `/` and `/?action=unsubscribe`
    // are the same page and only one of them identifies a person.
    expect(autologinDestination(`${BASE}/`)).toBeNull();
    expect(autologinDestination(`${BASE}/?utm_source=newsletter`)).toBeNull();
    expect(autologinDestination(`${BASE}/?action=unsubscribe&email=x`)?.id).toBe('spa-action');
  });

  it('every allowlist entry states WHY that destination needs a session', () => {
    // The list is data precisely so it can be enumerated. An entry whose reason
    // is a placeholder is an entry nobody had to justify.
    expect(AUTOLOGIN_DESTINATIONS.length).toBeGreaterThan(0);
    for (const entry of AUTOLOGIN_DESTINATIONS) {
      expect(entry.id).toMatch(/^[a-z][a-z0-9-]+$/);
      expect(entry.why.length).toBeGreaterThan(80);
      expect(typeof entry.matches).toBe('function');
    }
    expect(AUTOLOGIN_DESTINATIONS.map((d) => d.id).sort()).toEqual([
      'followed-companies',
      'newsletter-preferences',
      'spa-action',
    ]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('an absolute URL to somebody else’s host never receives it', () => {
  // Worst case in the whole issue: the credential leaving our domain entirely.
  // Every builder is checked, not just the body rewriter, because they are
  // reached from different senders.
  const foreign = [
    'https://wise.com/invite/abc',
    // Crafted to look like every allowlisted shape at once.
    'https://evil.example/?action=unsubscribe&email=x',
    'https://evil.example/preferenze-newsletter/?email=x',
    'https://evil.example/aziende-seguite/',
    // A host that merely ENDS with ours.
    'https://frontaliereticino.ch.evil.example/preferenze-newsletter/',
    // …and one that contains it as a subdomain label.
    'https://click.frontaliereticino.ch/v2/redirect/aHR0cHM6Ly9m',
  ];

  it.each(foreign)('%s', (target) => {
    expect(autologinDestination(target)).toBeNull();
    expect(shouldWrapAuthenticatedHref(target)).toBe(false);
    expect(isOwnRewritableHref(target)).toBe(false);
    expect(hasAc(wrap(target))).toBe(false);
  });

  it('and a body rewrite leaves a third-party href byte-identical', () => {
    const html = '<a href="https://wise.com/invite/abc">w</a><a href="mailto:x@y.it">m</a><a href="#top">a</a>';
    expect(wrapAuthenticatedHrefs(html, EMAIL, { secret: SECRET })).toBe(html);
  });

  it('an unparseable href is refused rather than guessed at', () => {
    for (const junk of ['', 'http://', 'https://[oops', 'javascript:alert(1)', 'tel:+41000000000']) {
      expect(autologinDestination(junk)).toBeNull();
      expect(shouldWrapAuthenticatedHref(junk)).toBe(false);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('inside the perimeter — built with the real builders, never by hand', () => {
  it('the SPA action links, which App.tsx refuses without the credential', () => {
    for (const action of ['unsubscribe', 'resubscribe'] as const) {
      const url = makeAuthenticatedActionUrl(action, EMAIL, { secret: SECRET });
      expect(autologinDestination(url)?.id).toBe('spa-action');
      // The builder already appends `ac` itself; the perimeter must agree with
      // it, or wrapAuthenticatedHrefs would strip a credential the SPA needs.
      expect(hasAc(url)).toBe(true);
    }
    // makeUnsubscribeUrl is the same shape carrying only the scoped token; it is
    // the link the body footer uses and the one the SPA autologin path reads.
    expect(autologinDestination(makeUnsubscribeUrl(EMAIL, { secret: SECRET }))?.id).toBe('spa-action');
  });

  it('the newsletter-preferences page, in all four locales', () => {
    for (const locale of Object.keys(PREFERENCES_SLUG)) {
      const url = makePreferencesUrl(EMAIL, locale, { secret: SECRET })!;
      expect(url).toBeTruthy();
      expect(autologinDestination(url)?.id).toBe('newsletter-preferences');
      expect(hasAc(wrap(url))).toBe(true);
    }
  });

  it('the followed-companies page, in all four locales', () => {
    for (const [locale, slug] of Object.entries(FOLLOWED_COMPANIES_SLUG)) {
      const url = `${BASE}${locale === 'it' ? '' : `/${locale}`}/${slug}/?utm_source=company_alert`;
      expect(autologinDestination(url)?.id).toBe('followed-companies');
      expect(hasAc(wrap(url))).toBe(true);
    }
  });

  it('the one-click unsubscribe endpoint stays OUT — it is a Cloud Function, not the SPA', () => {
    // /disiscrivi-newsletter/ is proxied straight to newsletterManageSubscription
    // by the Worker and verifies its own scoped token. An `ac` there would be a
    // second credential on a link that already has the only one it can use.
    const url = makeOneClickUnsubscribeUrl(EMAIL, { secret: SECRET });
    expect(autologinDestination(url)).toBeNull();
    expect(hasAc(wrap(url))).toBe(false);
    expect(url).toContain('token=');
  });

  it('the job-alert unsubscribe links stay OUT — pure HMAC, session-independent by design', () => {
    process.env.NEWSLETTER_SECRET = SECRET;
    try {
      const one = makeAlertUnsubscribeUrl('alert-123', EMAIL);
      const all = makeAllAlertsUnsubscribeUrl(EMAIL);
      for (const url of [one, all]) {
        expect(autologinDestination(url)).toBeNull();
        expect(hasAc(wrap(url))).toBe(false);
      }
      // The `action=unsubscribe_all` shape #5767 found a regex blind to — here
      // only to prove the perimeter reads the PATH, not a substring of the query.
      expect(all).toContain('action=unsubscribe_all');
      expect(autologinDestination(all)).toBeNull();
    } finally {
      delete process.env.NEWSLETTER_SECRET;
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('URL shapes that arrive in a real message', () => {
  it('a query string that is already populated keeps every parameter', () => {
    const target = `${BASE}/preferenze-newsletter/?email=u%40e.com&token=abc&utm_source=job_alert&utm_campaign=alert_7`;
    const params = new URL(wrap(target, { preserveExistingUtmMedium: true })).searchParams;
    expect(params.get('email')).toBe('u@e.com');
    expect(params.get('token')).toBe('abc');
    expect(params.get('utm_source')).toBe('job_alert');
    expect(params.get('utm_campaign')).toBe('alert_7');
    expect(params.has('ac')).toBe(true);
  });

  it('a fragment survives, and the credential goes before it — not inside it', () => {
    const out = wrap(`${BASE}/preferenze-newsletter/?email=x#avvisi`);
    expect(out.endsWith('#avvisi')).toBe(true);
    expect(new URL(out).hash).toBe('#avvisi');
    expect(new URL(out).searchParams.get('ac')).not.toContain('#');
    // …and a bare fragment is not a destination at all.
    expect(autologinDestination('#avvisi')).toBeNull();
  });

  it('a duplicated utm_medium is not appended twice when the caller preserves it', () => {
    const out = wrap(`${BASE}/preferenze-newsletter/?email=x&utm_medium=email`, {
      utmMedium: 'newsletter',
      preserveExistingUtmMedium: true,
    });
    expect(new URL(out).searchParams.getAll('utm_medium')).toEqual(['email']);
  });

  it('trailing slash, no slash, and mixed case all resolve to the same verdict', () => {
    const variants = [
      `${BASE}/preferenze-newsletter`,
      `${BASE}/preferenze-newsletter/`,
      `${BASE}/PREFERENZE-NEWSLETTER/`,
      `${BASE}/Preferenze-Newsletter`,
      `https://www.frontaliereticino.ch/preferenze-newsletter/`,
    ];
    for (const v of variants) expect(autologinDestination(v)?.id).toBe('newsletter-preferences');

    // The locale prefix is case-insensitive too — senders concatenate it.
    for (const v of [`${BASE}/EN/?action=unsubscribe`, `${BASE}/de?action=resubscribe`]) {
      expect(autologinDestination(v)?.id).toBe('spa-action');
    }
  });

  it('a site-relative href resolves against our own base, and is judged the same', () => {
    expect(autologinDestination('/preferenze-newsletter/?email=x')?.id).toBe('newsletter-preferences');
    expect(autologinDestination('/blog/qualcosa/')).toBeNull();
  });

  it('a lookalike path is not a member: only the LAST segment counts', () => {
    // `/blog/preferenze-newsletter-come-funziona/` is an article about the
    // preference centre, not the preference centre.
    expect(autologinDestination(`${BASE}/blog/preferenze-newsletter-come-funziona/`)).toBeNull();
    expect(autologinDestination(`${BASE}/aziende-seguite-guida/`)).toBeNull();
    // A real one nested under a locale prefix still is.
    expect(autologinDestination(`${BASE}/fr/preferences-newsletter/`)?.id).toBe('newsletter-preferences');
  });

  it('static assets are out, whatever their name suggests', () => {
    expect(autologinDestination(`${BASE}/images/aziende-seguite/logo.png`)).toBeNull();
    expect(autologinDestination(`${BASE}/icons/preferenze-newsletter.svg`)).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('the call-site opt-out is an argument, not a switch', () => {
  const JOB = `${BASE}/cerca-lavoro-ticino/infermiere-lugano-abc123`;
  const REASON = 'job detail page — JobBoard.tsx renders the sign-in gate when hasAccess is false';

  it('a stated reason lets ONE call site through', () => {
    // Job detail pages are the destination the path allowlist cannot recognise:
    // their URL is `<locale>/<canton board section>/<slug>` and the 26x4 section
    // table lives in data/canton-url-slugs.json, which functions/ cannot read.
    // They genuinely need the session — components/community/JobBoard.tsx gates
    // the detail view on `hasAccess` — so the sender that knows says so.
    expect(hasAc(wrap(JOB))).toBe(false);
    expect(hasAc(wrap(JOB, { sessionGated: REASON }))).toBe(true);
  });

  it('a boolean, an empty string or whitespace does NOT', () => {
    // `sessionGated: true` would be a switch someone flips; a reason is
    // something someone writes, and a reviewer reads.
    for (const bad of [true, 1, {}, [], '', '   ', null, undefined]) {
      expect(hasAc(wrap(JOB, { sessionGated: bad as never }))).toBe(false);
    }
  });

  it('a stated reason still cannot send the credential off our domain', () => {
    // The opt-out widens the perimeter by one destination, never past the host.
    expect(hasAc(wrap('https://evil.example/whatever', { sessionGated: REASON }))).toBe(false);
  });

  it('the body-level rewriter has no such argument, by construction', () => {
    // wrapAuthenticatedHrefs cannot know what any given href is for, and "cannot
    // know" has to resolve to "no credential". If an opt-out is ever added here,
    // it stops being fail-closed.
    const src = fs.readFileSync(
      path.join(__dirname, '..', 'functions', 'src', 'lib', 'newsletterUrls.js'),
      'utf8',
    );
    const signature = src.slice(
      src.indexOf('export function wrapAuthenticatedHrefs'),
      src.indexOf('export function wrapAuthenticatedHrefs') + 200,
    );
    expect(signature).toMatch(/\{ secret, utmCampaign, scheme \} = \{\}/);
    expect(signature).not.toMatch(/sessionGated/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('a whole message body, rewritten', () => {
  // The population that matters: one body carrying one of every link kind a real
  // send produces, each built by its own real builder.
  const body = () => {
    process.env.NEWSLETTER_SECRET = SECRET;
    try {
      const links = [
        makeAuthenticatedActionUrl('unsubscribe', EMAIL, { secret: SECRET }),
        makePreferencesUrl(EMAIL, 'it', { secret: SECRET })!,
        makeOneClickUnsubscribeUrl(EMAIL, { secret: SECRET }),
        makeAlertUnsubscribeUrl('alert-1', EMAIL),
        `${BASE}/aziende-seguite/`,
        `${BASE}/cerca-lavoro-ticino/`,
        `${BASE}/cerca-lavoro-ticino/infermiere-lugano-abc123`,
        `${BASE}/blog/frontalieri-2026/`,
        `${BASE}/`,
        `${BASE}/images/logo.png`,
        'https://wise.com/invite/abc',
        'mailto:info@frontaliereticino.ch',
      ];
      return {
        html: links.map((h) => `<a href="${h.replace(/&/g, '&amp;')}">x</a>`).join(''),
        links,
      };
    } finally {
      delete process.env.NEWSLETTER_SECRET;
    }
  };

  const hrefsOf = (html: string) =>
    [...html.matchAll(/href="([^"]+)"/g)].map((m) => m[1].replace(/&amp;/g, '&'));

  it('only the destinations that need a session come out carrying one', () => {
    const { html } = body();
    const out = hrefsOf(wrapAuthenticatedHrefs(html, EMAIL, { secret: SECRET }));
    const carrying = out.filter((h) => /[?&]ac=/.test(h));

    // Three of twelve, and each one identifies the reader: the SPA action link,
    // the preference centre, the followed-companies page. Everything else — the
    // job board, the job listing, the article, the home page, the asset, the
    // external host, the mailto, both HMAC unsubscribe endpoints — is out.
    expect(carrying).toHaveLength(3);
    expect(carrying.map((h) => autologinDestination(h)!.id).sort()).toEqual([
      'followed-companies',
      'newsletter-preferences',
      'spa-action',
    ]);
    for (const h of carrying) expect(autologinDestination(h)).not.toBeNull();
  });

  it('and no link that lost the credential kept the address either', () => {
    // `ne` is the recipient's address in a query string that Cloud Run's request
    // log keeps verbatim (#5746). Nothing reads it without a credential beside
    // it, so it leaves with the credential rather than lingering as a bare
    // identifier on every public page.
    const { html } = body();
    for (const h of hrefsOf(wrapAuthenticatedHrefs(html, EMAIL, { secret: SECRET }))) {
      if (/[?&]ac=/.test(h)) continue;
      expect(/[?&]ne=/.test(h)).toBe(false);
    }
  });

  it('every on-site link keeps its campaign attribution regardless', () => {
    const { html } = body();
    for (const h of hrefsOf(wrapAuthenticatedHrefs(html, EMAIL, { secret: SECRET, utmCampaign: 'welcome_job' }))) {
      if (!isOwnRewritableHref(h)) continue;
      expect(h).toContain('utm_medium=newsletter');
      expect(h).toContain('utm_campaign=welcome_job');
    }
  });

  it('one HMAC per recipient still covers the whole message', () => {
    const { html } = body();
    const codes = new Set(
      hrefsOf(wrapAuthenticatedHrefs(html, EMAIL, { secret: SECRET }))
        .map((h) => new URL(h, BASE).searchParams.get('ac'))
        .filter(Boolean),
    );
    expect(codes.size).toBe(1);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('the senders agree with the perimeter', () => {
  const read = (rel: string) => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');

  it('send-job-alerts wraps the job board WITHOUT a credential and the cards WITH one', () => {
    // A grep, deliberately: the alternative is importing send-job-alerts.mjs,
    // which does top-level fs.readFileSync of data/jobs.json and a Firebase
    // lazy-init — the reason services/companyAlertEmail.mjs refuses to import it
    // either. The names are the assertion.
    const src = read('scripts/send-job-alerts.mjs');
    expect(src).toMatch(/const allJobsUrl = wrapPublicUrl\(/);
    expect(src).toMatch(/const manageUrl = wrapPublicUrl\(/);
    expect(src.match(/const url = wrapJobUrl\(rawJobUrl\);/g) || []).toHaveLength(2);
    expect(src).not.toMatch(/\bwrapUrl\(/);
  });

  it('send-company-alerts hands the template two decorators, only one of them credentialed', () => {
    const src = read('scripts/send-company-alerts.mjs');
    expect(src).toMatch(/const wrapJobUrl = \(raw\) =>/);
    expect(src).toMatch(/sessionGated:/);
    // The public one must NOT declare a reason, or the split is decorative.
    const publicWrapper = src.slice(src.indexOf('const wrapUrl = (raw) =>'), src.indexOf('const wrapJobUrl'));
    expect(publicWrapper).not.toMatch(/sessionGated/);
  });

  it('the company-alert template sends the hub through the PUBLIC decorator', () => {
    const src = read('services/companyAlertEmail.mjs');
    expect(src).toMatch(/hubUrl: wrapUrl\(companyHubUrl\(/);
    expect(src).toMatch(/jobCardHtml\(job, section\.hubUrl, wrapJobUrl\)/);
  });

  it('the weekly newsletter filters on "may I rewrite", not on "does it need a session"', () => {
    const src = read('scripts/send-newsletter.mjs');
    expect(src).toMatch(/const shouldWrapNewsletterHref = isOwnRewritableHref;/);
    // It must not IMPORT the credential predicate either — the mention that
    // survives is the comment explaining which of the two this file wants.
    expect(src).not.toMatch(/^import .*shouldWrapAuthenticatedHref/m);
  });

  it('nothing outside the canonical module builds an `ac` parameter of its own', () => {
    // The perimeter is only worth anything if there is one place that attaches
    // the credential. Two would drift, and the second would not be reviewed.
    const offenders: string[] = [];
    const roots = ['scripts', 'services', 'functions/src'];
    const walk = (dir: string) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) { walk(full); continue; }
        if (!/\.(mjs|js|ts)$/.test(entry.name)) continue;
        if (full.endsWith(path.join('lib', 'newsletterUrls.js'))) continue;
        const src = fs.readFileSync(full, 'utf8');
        if (/searchParams\.set\(\s*['"]ac['"]/.test(src) || /[?&]ac=\$\{/.test(src)) {
          offenders.push(path.relative(path.join(__dirname, '..'), full));
        }
      }
    };
    for (const r of roots) walk(path.join(__dirname, '..', r));
    expect(offenders).toEqual([]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('followed-companies slug table', () => {
  it('agrees with services/routeSlugs.data.ts in all four locales', () => {
    // Same guard shape as "functions-side newsletter preferences slug table" in
    // tests/route-slugs-no-drift.test.ts, and it exists for a sharper reason
    // here: a rename in one place and not the other does NOT 404. The link keeps
    // working and silently drops out of the perimeter, so the page that needs a
    // session stops getting one — with nothing red anywhere.
    for (const [locale, slug] of Object.entries(FOLLOWED_COMPANIES_SLUG)) {
      expect(SLUG_TABLES[locale as keyof typeof SLUG_TABLES].followedCompanies).toBe(slug);
    }
    expect(Object.keys(FOLLOWED_COMPANIES_SLUG).sort()).toEqual(['de', 'en', 'fr', 'it']);
  });

  it('and so does the third copy inside scripts/send-company-alerts.mjs', () => {
    const src = fs.readFileSync(
      path.join(__dirname, '..', 'scripts', 'send-company-alerts.mjs'),
      'utf8',
    );
    const m = src.match(/const FOLLOWED_COMPANIES_SLUG = '([^']+)'/);
    expect(m?.[1]).toBe(FOLLOWED_COMPANIES_SLUG.it);
  });
});
