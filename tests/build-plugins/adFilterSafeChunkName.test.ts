import { describe, it, expect } from 'vitest';
import { adFilterSafeChunkName } from '@/build-plugins/shared/adFilterSafeChunkName';

/**
 * Issue #2971: a first-party JS chunk whose STABLE filename contains an
 * ad-filter trigger word (`firebase`, `analytics`, …) gets network-blocked or
 * served as an empty surrogate by aggressive mobile content blockers. A chunk
 * that statically imports a binding from it then fails to LINK
 * ("Importing binding name 's' is not found"), white-screening the page — a
 * failure the reload self-heal can't fix (the block re-fires on reload).
 *
 * adFilterSafeChunkName rewrites those substrings so no emitted filename can
 * match a tracker rule, while staying a STABLE deterministic 1:1 mapping.
 */

// Tracker keywords that occur in real first-party names and must NOT survive.
const TRIGGER = /firebase|analytics|recaptcha/i;

// The real chunk/module names this build emits (vite.config manualChunks + the
// auto-named dynamic-import boundaries) that carry a tracker keyword.
const REAL_TRIGGER_CHUNKS = [
  'vendor-firebase-core',
  'vendor-firebase-firestore',
  'vendor-firebase-auth',
  'vendor-firebase-analytics',
  'vendor-firebase-performance',
  'vendor-firebase-remote-config',
  'vendor-firebase-appcheck',
  'analytics',
  'analyticsPageContext',
  'recaptchaService',
];

// Names with no trigger word — must pass through byte-identical.
const NEUTRAL_CHUNKS = [
  'index-entry',
  'early-boot',
  'App',
  'vendor-react',
  'vendor-icons',
  'vendor-charts',
  'vendor-maps',
  'vendor-pdf',
  'i18n',
  'shared-services',
  'trafficService', // 'traffic' must NOT be rewritten as 'tracking'
  'seoService',
  'it-core',
  'it-calculator',
  'blog-meta-it',
];

describe('adFilterSafeChunkName', () => {
  it('strips every ad-filter trigger word from real chunk names', () => {
    for (const name of REAL_TRIGGER_CHUNKS) {
      const safe = adFilterSafeChunkName(name);
      expect(safe, `${name} -> ${safe}`).not.toMatch(TRIGGER);
    }
  });

  it('maps the known names to their stable neutral aliases', () => {
    expect(adFilterSafeChunkName('vendor-firebase-firestore')).toBe('vendor-fdb-firestore');
    expect(adFilterSafeChunkName('vendor-firebase-analytics')).toBe('vendor-fdb-mx');
    expect(adFilterSafeChunkName('vendor-firebase-remote-config')).toBe('vendor-fdb-remote-config');
    expect(adFilterSafeChunkName('analytics')).toBe('mx');
    expect(adFilterSafeChunkName('analyticsPageContext')).toBe('mxPageContext');
    expect(adFilterSafeChunkName('recaptchaService')).toBe('rcpService');
  });

  it('is a no-op for names without a tracker keyword', () => {
    for (const name of NEUTRAL_CHUNKS) {
      expect(adFilterSafeChunkName(name)).toBe(name);
    }
  });

  it('is idempotent (the alias never reintroduces a trigger)', () => {
    for (const name of [...REAL_TRIGGER_CHUNKS, ...NEUTRAL_CHUNKS]) {
      const once = adFilterSafeChunkName(name);
      expect(adFilterSafeChunkName(once)).toBe(once);
    }
  });

  it('stays injective over the full chunk set (no stable-name collisions)', () => {
    const all = [...REAL_TRIGGER_CHUNKS, ...NEUTRAL_CHUNKS];
    const mapped = all.map(adFilterSafeChunkName);
    expect(new Set(mapped).size).toBe(mapped.length);
  });

  it('handles empty / undefined-ish input without throwing', () => {
    expect(adFilterSafeChunkName('')).toBe('');
  });
});
