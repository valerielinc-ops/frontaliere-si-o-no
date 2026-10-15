import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { SLUG_TABLES } from '../services/routeSlugs.data.ts';
import { makePreferencesUrl } from '../functions/src/lib/newsletterUrls.js';

const SCRIPT = fs.readFileSync(
  path.resolve(__dirname, '../scripts/send-newsletter.mjs'),
  'utf8',
);

describe('newsletter URL helpers — locale-correct', () => {
  it('article URL adds /en/ prefix for non-IT locales', () => {
    // Exercise via mock or via raw source-grep — depending on what is exportable.
    // If the helper is non-exported, assert source contains the conditional prefix logic:
    expect(SCRIPT).toMatch(/locale\s*===\s*['"]it['"]\s*\?\s*['"]['"]?\s*:\s*['"`]\s*\/\s*\$?\{?locale|localePrefix/);
  });

  // #4299/#4315 sibling-pattern fix (AGENTS.md #6): send-newsletter.mjs no
  // longer defines its own makePreferencesUrl/PREFERENCES_SLUG — it imports
  // the shared builder (functions/src/lib/newsletterUrls.js, re-exported via
  // services/newsletterUrls.mjs) also used by send-job-alerts.mjs and the
  // welcome-email Cloud Function (tests/route-slugs-no-drift.test.ts guards
  // the import + absence of a local copy). Exercise the REAL shared
  // function's locale-awareness behaviorally instead of grepping for a local
  // function signature / literal slug table that no longer exist here.
  it('makePreferencesUrl (shared builder, imported by send-newsletter.mjs) is locale-aware', () => {
    expect(SCRIPT).toMatch(/makePreferencesUrl/);
    expect(SCRIPT).toMatch(/from '\.\.\/services\/newsletterUrls\.mjs'/);
    const itUrl = makePreferencesUrl('x@example.com', 'it', { secret: 'test-secret' });
    const enUrl = makePreferencesUrl('x@example.com', 'en', { secret: 'test-secret' });
    expect(itUrl).not.toBe(enUrl);
    expect(enUrl).toContain('/en/');
  });

  it('all 4 locale slugs for newsletter preferences resolve through the shared builder', () => {
    // Slug values now live once in functions/src/lib/newsletterUrls.js's
    // PREFERENCES_SLUG (drift-guarded against SLUG_TABLES in
    // tests/route-slugs-no-drift.test.ts) — exercise makePreferencesUrl for
    // all 4 locales instead of grepping send-newsletter.mjs's source for a
    // literal it no longer contains.
    for (const locale of ['it', 'en', 'de', 'fr'] as const) {
      const url = makePreferencesUrl('x@example.com', locale, { secret: 'test-secret' });
      expect(url).toContain(SLUG_TABLES[locale].newsletterPreferences);
    }
  });

  it('featuredTool is built per-locale (uses getFeaturedTools or equivalent)', () => {
    expect(SCRIPT).toMatch(/getFeaturedTools|getFeaturedToolForLocale/);
    // And the deprecated all-IT FEATURED_TOOLS[toolIndex] direct usage is gone in the assembly path
    // (allow the import to remain for backwards compat checks elsewhere)
    const lines = SCRIPT.split('\n');
    const assemblyContext = lines.slice(1380, 1700).join('\n');
    expect(assemblyContext).not.toMatch(/=\s*FEATURED_TOOLS\[toolIndex\]/);
  });
});
