/**
 * JobBridgeView is the ONE job-detail surface of four that deliberately carries
 * neither «Segui questa azienda» (CompanyFollowCta) nor the employer-hub link.
 *
 * This is the kind of asymmetry that gets "fixed" by symmetry: three sibling
 * files have the CTA, the fourth does not, so the next pass adds it. The reason
 * it must not be added lives as a block comment above the company banner in
 * JobBridgeView.tsx; these assertions make deleting either the decision or the
 * reason a red test rather than a silent regression.
 *
 * The load-bearing fact is that a bridge page destroys itself: the countdown
 * effect runs `window.location.href = targetPath` unconditionally, with no
 * cancel path. An anonymous follow is click → capture field → type an address →
 * submit, which cannot complete in that window; a signed-in one lazy-loads a
 * chunk and fires a Firestore getUserAlerts() read into a tree that is
 * guaranteed to unmount. So the assertion on the redirect is not decoration —
 * it is the premise. If bridges ever stop auto-redirecting, this file is where
 * the decision gets revisited.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const read = (p: string) => readFileSync(resolve(p), 'utf8');

const BRIDGE = 'components/community/JobBridgeView.tsx';
// The three surfaces that DO offer it — listed so the asymmetry reads as a
// decision about the bridge, not as three files that happen to agree.
const CTA_SURFACES = [
  'components/community/JobExpiredView.tsx',
  'components/community/JobOrphanView.tsx',
  'components/community/JobBoard.tsx',
];

describe('JobBridgeView — no company-follow CTA, no employer-hub link', () => {
  const src = read(BRIDGE);

  // Asserted on IMPORTS and JSX, never on raw occurrence: the block comment
  // that records the decision necessarily names both symbols, so a substring
  // search would fail on the very prose it is protecting.
  it('does not mount CompanyFollowCta', () => {
    expect(src).not.toMatch(/^import .*CompanyFollowCta.*$/m);
    expect(src).not.toMatch(/<CompanyFollowCta\b/);
  });

  it('does not link the employer hub', () => {
    // useEmployerHub is the only sanctioned way to build that link (it is the
    // proof the page was emitted); its absence is what makes the omission
    // total rather than "the link exists but unproven".
    expect(src).not.toMatch(/^import .*from '@\/hooks\/useEmployerHub'/m);
    expect(src).not.toMatch(/\buseEmployerHub\(/);
    expect(src).not.toMatch(/\b(employerHubAnchor|employerHubPath|employerOpenRolesLabel)\(/);
  });

  it('keeps the recorded reason next to the decision', () => {
    // Asserted because the value here is the rationale, not the absence: an
    // undocumented omission is indistinguishable from an oversight, and the
    // next agent re-derives it from scratch or reverses it.
    expect(src).toContain('NO CompanyFollowCta');
    expect(src).toMatch(/bridgeThinShell/);
  });

  it('redirects unconditionally, which is the premise of the decision', () => {
    // A bridge unmounts itself a few seconds after paint. Any interactive CTA
    // added above would be destroyed mid-interaction.
    const countdown = /const COUNTDOWN_SECONDS = (\d+);/.exec(src)?.[1];
    expect(countdown, 'COUNTDOWN_SECONDS must exist for this file to still be a bridge').toBeDefined();
    expect(Number(countdown)).toBeLessThanOrEqual(5);
    expect(src).toMatch(/if \(countdown <= 0\) \{\s*\n\s*window\.location\.href = targetPath;/);
  });
});

describe('the three surfaces that DO carry the CTA still carry it', () => {
  // Guards the other half of the asymmetry: if the CTA disappeared from the
  // dead-end views, the bridge's omission would stop being a considered
  // exception and start being the (wrong) house style.
  it.each(CTA_SURFACES)('%s renders CompanyFollowCta', (file) => {
    expect(read(file)).toMatch(/CompanyFollowCta/);
  });
});
