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
 * An anchor is "outbound" when it has `target="_blank"`. Internal SPA
 * navigations never use _blank in this codebase — they use onClick handlers
 * that call `nav.navigateTo(...)` and `e.preventDefault()`.
 */
function isOutboundAnchor(tag: string): boolean {
  return /target="_blank"/.test(tag);
}

describe('JobBoard outbound ATS links carry nofollow', () => {
  const source = readComponent('components/community/JobBoard.tsx');
  const anchors = extractAnchorOpeningTags(source);
  const outbound = anchors.filter(isOutboundAnchor);

  it('has at least one outbound anchor (sanity check)', () => {
    // applyUrl on the apply CTA + header logo + header title +
    // concorsi.ti.ch official-source link = 4 known outbounds.
    expect(outbound.length).toBeGreaterThanOrEqual(4);
  });

  it('every outbound <a target="_blank"> has rel="nofollow noopener noreferrer"', () => {
    const offenders = outbound.filter((tag) => !REL_PATTERN.test(tag));
    expect(offenders, `Outbound anchors missing nofollow:\n${offenders.join('\n---\n')}`).toEqual([]);
  });

  it('the apply CTA points to applyUrl with nofollow', () => {
    // Hybrid A/B apply CTA — the most clicked outbound link on the site.
    expect(source).toMatch(
      /className="hybrid-ab-cta"\s+href=\{applyUrl\}\s+target="_blank"\s+rel="nofollow noopener noreferrer"/,
    );
  });

  it('the header logo and title apply links carry nofollow', () => {
    // Pull the two `applyUrl` blocks tagged with the header analytics events.
    const logoBlockMatch = source.match(
      /href=\{applyUrl\}\s+target="_blank"\s+rel="([^"]+)"\s+onClick=\{\(\) => Analytics\.trackSelectContent\('job_board_apply_header_logo'/,
    );
    const titleBlockMatch = source.match(
      /href=\{applyUrl\}\s+target="_blank"\s+rel="([^"]+)"\s+onClick=\{\(\) => Analytics\.trackSelectContent\('job_board_apply_header_title'/,
    );

    expect(logoBlockMatch?.[1]).toBe('nofollow noopener noreferrer');
    expect(titleBlockMatch?.[1]).toBe('nofollow noopener noreferrer');
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
