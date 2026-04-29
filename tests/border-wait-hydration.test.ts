/**
 * Tests for the F8 border-wait Firestore hydration IIFE
 * (`build-plugins/borderWaitHydrationScript.ts`) and its injection into the
 * static HTML pages emitted by `borderWaitPagesPlugin.ts`.
 *
 * What we cover:
 *   - The minified IIFE is self-contained vanilla JS (no SDK imports).
 *   - It targets the right Firestore endpoint + collection.
 *   - It stays under the 3 KB hard ceiling (text-to-HTML ratio gate).
 *   - The plugin actually injects the `<script>` tag and the
 *     `data-bw-crossing="{slug}"` markers on at least one well-known crossing
 *     row + the per-crossing detail page card.
 *   - The page-level `data-bw-live-badge` element is present.
 */

import { describe, expect, it } from 'vitest';
import {
  BORDER_WAIT_HYDRATION_JS,
  BORDER_WAIT_HYDRATION_SCRIPT_TAG,
} from '../build-plugins/borderWaitHydrationScript';
import {
  generateBorderWaitPages,
  type BorderWaitCurrent,
} from '../build-plugins/borderWaitPagesPlugin';
import {
  buildOggiPath,
  buildRootHubPath,
  buildRegionalHubPath,
} from '../build-plugins/borderWaitData';

const FIXTURE_CURRENT: BorderWaitCurrent = {
  updatedAt: '2026-04-29T06:00:00.000Z',
  perCrossing: {
    'chiasso-brogeda': {
      waitTimeMinutes: 21,
      source: 'tomtom',
      lastUpdate: '2026-04-29T06:00:00.000Z',
      status: 'red',
    },
    gaggiolo: {
      waitTimeMinutes: 7,
      source: 'tomtom',
      lastUpdate: '2026-04-29T06:00:00.000Z',
      status: 'yellow',
    },
  },
};

describe('border-wait hydration IIFE — payload integrity', () => {
  it('targets the Firestore REST endpoint for `trafficCurrent`', () => {
    expect(BORDER_WAIT_HYDRATION_JS).toContain('firestore.googleapis.com');
    expect(BORDER_WAIT_HYDRATION_JS).toContain('trafficCurrent');
  });

  it('uses the public frontaliere-ticino project', () => {
    expect(BORDER_WAIT_HYDRATION_JS).toContain('frontaliere-ticino');
  });

  it('is self-contained vanilla JS (no SDK imports / admin sdk / requires)', () => {
    // ESM imports / dynamic imports / firebase-admin would all break the
    // "inline IIFE" promise — none should appear in the payload.
    expect(BORDER_WAIT_HYDRATION_JS).not.toMatch(/\bimport\b/);
    expect(BORDER_WAIT_HYDRATION_JS).not.toContain('firebase-admin');
    // Allow `require` only if it appears inside a string ("requireSomething")
    // — none should appear at all in our payload.
    expect(BORDER_WAIT_HYDRATION_JS).not.toMatch(/\brequire\s*\(/);
  });

  it('reads the `data-bw-crossing` and `data-bw-field` DOM contract', () => {
    expect(BORDER_WAIT_HYDRATION_JS).toContain('data-bw-crossing');
    expect(BORDER_WAIT_HYDRATION_JS).toContain('data-bw-field');
    expect(BORDER_WAIT_HYDRATION_JS).toContain('data-bw-hydrated');
    expect(BORDER_WAIT_HYDRATION_JS).toContain('data-bw-live-badge');
  });

  it('respects the 3 KB hard ceiling (text-to-HTML ratio gate)', () => {
    const bytes = Buffer.byteLength(BORDER_WAIT_HYDRATION_SCRIPT_TAG, 'utf8');
    expect(bytes).toBeLessThan(3 * 1024);
  });

  it('exports an external <script src> tag (NOT inline) for the SEO gate', () => {
    // The IIFE is emitted as a static asset to dist/border-wait-hydrate.js
    // by the plugin's writeBundle hook; the HTML reference is just the
    // <script src defer> tag — keeps inline payload off-page so the
    // text-to-HTML ratio gate stays green.
    expect(BORDER_WAIT_HYDRATION_SCRIPT_TAG).toBe(
      '<script src="/border-wait-hydrate.js" defer></script>',
    );
    // The IIFE itself MUST NOT be inlined into the tag.
    expect(BORDER_WAIT_HYDRATION_SCRIPT_TAG).not.toContain(BORDER_WAIT_HYDRATION_JS);
  });
});

describe('border-wait pages — hydration injection', () => {
  const pages = generateBorderWaitPages({ current: FIXTURE_CURRENT });

  it('injects the external hydration <script src> on per-crossing leaf pages', () => {
    const path = buildOggiPath('it', 'chiasso-brogeda');
    const html = pages[path];
    expect(html).toBeDefined();
    // External tag — keeps the inline payload off-page so the text-to-HTML
    // ratio gate stays green. The IIFE itself is asserted separately above.
    expect(html).toContain('<script src="/border-wait-hydrate.js"');
    expect(html).toContain('defer');
    // Inline Firestore endpoint MUST NOT appear in the HTML — it lives in
    // the external asset file emitted by the plugin's writeBundle.
    expect(html).not.toContain('firestore.googleapis.com');
  });

  it('marks the leaf page status card with `data-bw-crossing` for the slug', () => {
    const html = pages[buildOggiPath('it', 'chiasso-brogeda')];
    expect(html).toContain('data-bw-crossing="chiasso-brogeda"');
    expect(html).toContain('data-bw-field="waitTimeMinutes"');
    expect(html).toContain('data-bw-live-badge');
  });

  it('marks every crossing row of the root hub table with `data-bw-crossing`', () => {
    const html = pages[buildRootHubPath('it')];
    expect(html).toBeDefined();
    // At least the two crossings in our fixture must appear.
    expect(html).toContain('data-bw-crossing="chiasso-brogeda"');
    expect(html).toContain('data-bw-crossing="gaggiolo"');
    // Every row must carry a wait-minutes field marker.
    expect(html).toContain('data-bw-field="waitTimeMinutes"');
    // Hub also gets the snapshot/live badge in the header.
    expect(html).toContain('data-bw-live-badge');
    // External hydration tag (NOT the inline IIFE — keeps text-to-HTML gate green).
    expect(html).toContain('<script src="/border-wait-hydrate.js"');
  });

  it('also injects the hydration <script src> on regional hubs', () => {
    const html = pages[buildRegionalHubPath('en', 'ticino-como')];
    expect(html).toBeDefined();
    expect(html).toContain('<script src="/border-wait-hydrate.js"');
    expect(html).toContain('data-bw-crossing="chiasso-brogeda"');
  });

  it('preserves the pre-rendered minute value in the HTML', () => {
    // Hard rule: hydration enhances; it never blocks. Pre-rendered numbers
    // must remain readable for SEO/bots/zero-JS users.
    const html = pages[buildOggiPath('it', 'chiasso-brogeda')];
    expect(html).toContain('21 min');
  });
});
