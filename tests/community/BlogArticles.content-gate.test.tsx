/**
 * Source-level regression: the blog auth gate was removed on 2026-05-19.
 *
 * These assertions guard against accidental reintroduction. If you have a
 * legitimate reason to bring the gate back, delete this file in the same PR.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const SOURCE = readFileSync(
  resolve(__dirname, '../../components/community/BlogArticles.tsx'),
  'utf8',
);

describe('BlogArticles — auth gate removed (2026-05-19)', () => {
  it('does not declare a paywallable / contentGateApplies code path', () => {
    expect(SOURCE).not.toMatch(/contentGateApplies/);
    expect(SOURCE).not.toMatch(/\bpaywallable\b/);
    expect(SOURCE).not.toMatch(/visibleSegmentCount/);
  });

  it('does not render the gate UI (gateEmailInput / handleBlogEmailAccess)', () => {
    expect(SOURCE).not.toMatch(/gateEmailInput/);
    expect(SOURCE).not.toMatch(/handleBlogEmailAccess/);
    expect(SOURCE).not.toMatch(/handleBlogGoogleAuth/);
    expect(SOURCE).not.toMatch(/handleBlogLinkedInAuth/);
  });

  it('does not import gate-only auth helpers', () => {
    // signInWithGoogle / signInWithLinkedIn were only used by the blog gate;
    // JobBoard has its own auth flow. If a future need brings them back here,
    // delete this assertion.
    expect(SOURCE).not.toMatch(/signInWithGoogle.*BlogArticles/);
    expect(SOURCE).not.toMatch(/renderGoogleButtonWithReadiness/);
  });

  it('does not emit blog_content_gate analytics events', () => {
    expect(SOURCE).not.toMatch(/blog_content_gate/);
  });

  it('does not emit paywall-hidden-content DOM marker or hasPart schema', () => {
    expect(SOURCE).not.toMatch(/paywall-hidden-content/);
    expect(SOURCE).not.toMatch(/isAccessibleForFree:\s*!articlePaywallable/);
  });
});
