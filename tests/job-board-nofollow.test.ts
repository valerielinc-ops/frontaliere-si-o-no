/**
 * Phase 4B — Outbound ATS link nofollow guard.
 *
 * Semrush flags 671 outbound links to ATS partners (umantis.com, ncoreplat.com,
 * recruitingapp-XXXX.umantis.com, login.org, tallyweijl.hire.trakstar.com, ...)
 * as "external broken links" because those endpoints return HTTP 403 to the
 * Semrush crawler user-agent. The 403s are false positives (real users get
 * served fine), but they still pollute Site Audit.
 *
 * Fix: every outbound `<a>` that points to an ATS / external host on
 * JobBoard.tsx and JobBridgeView.tsx must include `rel="nofollow noopener
 * noreferrer"`. The `nofollow` keyword tells crawlers to skip the link, so
 * Semrush stops fetching it and the issue clears.
 *
 * This test enforces the contract at the source level — any future outbound
 * `<a target="_blank">` added without `nofollow` will fail CI.
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const PROJECT_ROOT = process.cwd();
const REL_PATTERN = /rel="nofollow noopener noreferrer"/;

function readComponent(relativePath: string): string {
  return fs.readFileSync(path.resolve(PROJECT_ROOT, relativePath), 'utf-8');
}

/**
 * Extract every `<a ...>` opening tag from a TSX source. We only care about
 * the attributes between `<a` and the next `>` (we ignore the children).
 * This intentionally tolerates multi-line attribute lists.
 */
function extractAnchorOpeningTags(source: string): string[] {
  const tags: string[] = [];
  const re = /<a\b[^>]*>/gms;
  let match: RegExpExecArray | null;
  while ((match = re.exec(source)) !== null) {
    tags.push(match[0]);
  }
  return tags;
}

/**
 * An anchor is "outbound" when it can open in a new tab — either a literal
 * `target="_blank"` or a conditional `target={cond ? undefined : '_blank'}`
 * that resolves to `_blank` for the external case. Either way, if `_blank`
 * can appear the anchor must declare nofollow. Application actions are
 * buttons and expose no outbound href. Internal SPA navigations never use _blank.
 */
function isOutboundAnchor(tag: string): boolean {
  return /target="_blank"/.test(tag) || /target=\{[^}]*'_blank'[^}]*\}/.test(tag);
}

describe('JobBoard outbound ATS links carry nofollow', () => {
  const source = readComponent('components/community/JobBoard.tsx');
  const anchors = extractAnchorOpeningTags(source);
  const outbound = anchors.filter(isOutboundAnchor);

  it('has at least one outbound anchor (sanity check)', () => {
    // The concorsi.ti.ch official-source link remains an outbound anchor.
    // Application actions (including header logo/title) are buttons.
    expect(outbound.length).toBeGreaterThanOrEqual(1);
  });

  it('every outbound <a target="_blank"> has rel="nofollow noopener noreferrer"', () => {
    const offenders = outbound.filter((tag) => !REL_PATTERN.test(tag));
    expect(offenders, `Outbound anchors missing nofollow:\n${offenders.join('\n---\n')}`).toEqual([]);
  });

  it('the apply CTA exposes no crawlable applyUrl link', () => {
    // Hybrid A/B apply CTA — the most clicked outbound action on the site.
    // Until #8757 it was `<a className="hybrid-ab-cta" href={applyUrl}
    // target="_blank" rel="nofollow …">`. The assisted-application A/B made it
    // a `<button>` routed through handleApply, which may show the assisted
    // offer before handing off. A button has no href, so crawlers have nothing
    // to follow: the nofollow invariant now holds by construction. Guard both
    // halves: the CTA stays a hrefless button, and any anchor that ever takes
    // the class back must carry nofollow again.
    expect(source).toMatch(
      /<button\s+type="button"\s+className="hybrid-ab-cta"\s+onClick=\{\(\) => handleApply\(selectedJob\)\}/,
    );
    const ctaAnchors = anchors.filter((tag) => /className="hybrid-ab-cta"/.test(tag));
    for (const tag of ctaAnchors) expect(tag).toMatch(REL_PATTERN);
    // The programmatic hand-off opens the ATS without leaking the opener or
    // the referrer, like the rel the anchor used to carry.
    expect(source).toContain("window.open(applyDestination, '_blank', 'noopener,noreferrer')");
  });

  it('header application actions expose no crawlable external destination', () => {
    expect(source).not.toContain("href={isInHouseApply ? '#candidatura' : applyUrl}");
    expect(source).not.toContain('href={applyUrl}');
  });
});

describe('JobBridgeView outbound links carry nofollow', () => {
  const source = readComponent('components/community/JobBridgeView.tsx');
  const anchors = extractAnchorOpeningTags(source);
  const outbound = anchors.filter(isOutboundAnchor);

  it('every outbound <a target="_blank"> has rel="nofollow noopener noreferrer"', () => {
    // JobBridgeView currently has NO outbound anchors — every link is an
    // internal SPA navigation built from prefix + sectionSlug. The check
    // still runs so any future _blank link added to the bridge view inherits
    // the nofollow contract automatically.
    const offenders = outbound.filter((tag) => !REL_PATTERN.test(tag));
    expect(offenders, `Outbound anchors missing nofollow:\n${offenders.join('\n---\n')}`).toEqual([]);
  });
});
