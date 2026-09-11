/**
 * /go/{partner}/ redirect — Partnerize `pubref` per placement (#7346).
 *
 * Every surface links the same `/go/{partner}/` page, so without a
 * per-position parameter Partnerize sees one undifferentiated click stream and
 * no slot can be optimised. The page turns `?pos=` (or, failing that, the
 * referring path) into `pubref` on the deeplink before redirecting.
 */
import { describe, it, expect } from 'vitest';
import { buildRedirectPage } from '../build-plugins/affiliateRedirectPlugin';
import { PARTNERS, isPartnerizeUrl, PUBREF_ALLOWED_RE, sanitizePubref } from '../services/affiliateService';

const wise = PARTNERS.find((p) => p.id === 'wise')!;

const SITE_ORIGIN = 'https://frontaliereticino.ch';

/**
 * Runs the inline pubref-rewrite block of the generated page and returns the
 * destination URL it leaves in `u`. Asserting on the substring alone can't tell
 * `ref-lavoro` from `ref-lavoro-infermiere-lugano-2026`, which is exactly the
 * distinction the bucket cardinality depends on.
 */
function rewrittenUrl(
  html: string,
  ctx: {
    search?: string;
    referrer?: string;
    readyState?: string;
    getElementById?: () => unknown;
    addEventListener?: (event: string, callback: () => void) => void;
  },
): string {
  const start = html.indexOf('var u=');
  const end = html.indexOf('var redirected=false;');
  expect(start).toBeGreaterThan(-1);
  expect(end).toBeGreaterThan(start);
  const block = html.slice(start, end);
  const doc = {
    referrer: ctx.referrer ?? '',
    readyState: ctx.readyState ?? 'loading',
    getElementById: ctx.getElementById ?? (() => null),
    addEventListener: ctx.addEventListener ?? (() => {}),
  };
  const location = { search: ctx.search ?? '', origin: SITE_ORIGIN };
  return new Function('document', 'location', 'setTimeout', `${block} return u;`)(
    doc,
    location,
    (callback: () => void) => callback(),
  ) as string;
}

const pubrefOf = (url: string) => new URL(url).searchParams.get('pubref');

describe('affiliate redirect pubref', () => {
  it('ships the pubref rewrite on Partnerize partners', () => {
    expect(isPartnerizeUrl(wise.url)).toBe(true);
    const html = buildRedirectPage(wise);
    expect(html).toContain("searchParams.set('pubref'");
    expect(html).toContain("q.get(\"pos\")");
    expect(html).toContain('document.referrer');
    // the visible fallback link is patched too, so a JS-blocked-then-clicked
    // click carries the same placement as the automatic redirect
    expect(html).toContain('id="go-link"');
  });

  it('omits the rewrite on non-Partnerize partners', () => {
    const plain = PARTNERS.find((p) => !isPartnerizeUrl(p.url));
    expect(plain).toBeDefined();
    expect(buildRedirectPage(plain!)).not.toContain("searchParams.set('pubref'");
  });

  it('keeps the referrer fallback to a bounded set of buckets', () => {
    const html = buildRedirectPage(wise);
    // same-origin: first path segment only, so every job slug under /lavoro/
    // lands in the SAME comparable bucket instead of minting one each
    expect(
      pubrefOf(rewrittenUrl(html, { referrer: `${SITE_ORIGIN}/lavoro/infermiere-lugano-2026/` })),
    ).toBe('ref-lavoro');
    expect(
      pubrefOf(rewrittenUrl(html, { referrer: `${SITE_ORIGIN}/lavoro/muratore-chiasso/` })),
    ).toBe('ref-lavoro');
    // ...and a path long enough to be cut by PUBREF_MAX_LEN can no longer
    // collide with a different one truncated to the same 48 characters
    expect(
      pubrefOf(
        rewrittenUrl(html, {
          referrer: `${SITE_ORIGIN}/notizie/${'a'.repeat(60)}/`,
        }),
      ),
    ).toBe('ref-notizie');
    // the home page is a segment of its own, not an empty bucket
    expect(pubrefOf(rewrittenUrl(html, { referrer: `${SITE_ORIGIN}/` }))).toBe('ref-home');
    // off-site referrers (SERP, social) collapse into one bucket
    expect(
      pubrefOf(rewrittenUrl(html, { referrer: 'https://www.google.com/search?q=frontaliere' })),
    ).toBe('ref-ext');
    expect(pubrefOf(rewrittenUrl(html, { referrer: 'https://l.facebook.com/l.php?u=x' }))).toBe(
      'ref-ext',
    );
    // an explicit ?pos= still wins over the fallback
    expect(
      pubrefOf(
        rewrittenUrl(html, { search: '?pos=nl-partner-2-wise', referrer: `${SITE_ORIGIN}/lavoro/x/` }),
      ),
    ).toBe('nl-partner-2-wise');
    // no referrer at all: the build-time default survives
    expect(pubrefOf(rewrittenUrl(html, {}))).toBe('go-redirect');
  });

  it('the build-time destination already carries a default pubref', () => {
    const html = buildRedirectPage(wise);
    expect(html).toContain('pubref=go-redirect');

    const ambiguous = {
      ...wise,
      url: 'https://wise.prf.hn/click/camref:1100l4Sfa/destination:https://wise.com/it/send-money/?ref=x',
    };
    const ambiguousHtml = buildRedirectPage(ambiguous);
    expect(ambiguousHtml).not.toContain("searchParams.set('pubref'");
    expect(ambiguousHtml).toContain(`href="${ambiguous.url}"`);
  });

  it('keeps the inline redirect sanitiser aligned on capped pubrefs', () => {
    const html = buildRedirectPage(wise);
    const slot2 = 'creditagricole-control-web-partner-page-banking-2-g4-contextual';
    const slot3 = 'creditagricole-control-web-partner-page-banking-3-g4-contextual';
    const rewrittenSlot2 = pubrefOf(rewrittenUrl(html, { search: `?pos=${slot2}` }));
    const rewrittenSlot3 = pubrefOf(rewrittenUrl(html, { search: `?pos=${slot3}` }));

    expect(rewrittenSlot2).toBe(sanitizePubref(slot2));
    expect(rewrittenSlot2).toMatch(/-[a-z0-9]{7}$/);
    expect(PUBREF_ALLOWED_RE.test(rewrittenSlot2!)).toBe(true);
    expect(html).toContain(JSON.stringify(PUBREF_ALLOWED_RE.source));
    expect(rewrittenSlot2).not.toBe(rewrittenSlot3);
  });

  it('retries the visible link when either readiness branch runs before #go-link exists', () => {
    const html = buildRedirectPage(wise);
    for (const readyState of ['complete', 'loading']) {
      let calls = 0;
      let href = '';
      const link = { setAttribute: (_name: string, value: string) => { href = value; } };
      rewrittenUrl(html, {
        readyState,
        search: '?pos=late-dom-slot',
        getElementById: () => (calls++ === 0 ? null : link),
        addEventListener: (_event, callback) => callback(),
      });
      expect(calls).toBe(2);
      expect(href).toContain('pubref=late-dom-slot');
    }
  });

  it('stops retrying when the visible link never appears', () => {
    const html = buildRedirectPage(wise);
    let calls = 0;
    rewrittenUrl(html, {
      readyState: 'complete',
      search: '?pos=missing-link-slot',
      getElementById: () => {
        calls += 1;
        return null;
      },
    });

    expect(calls).toBe(3);
    expect(html).toContain('patchAttempts<3');
  });
});
