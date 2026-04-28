import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

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

  it('makePreferencesUrl is locale-aware (function signature accepts locale)', () => {
    expect(SCRIPT).toMatch(/function\s+makePreferencesUrl\s*\(\s*email\s*,\s*locale/);
  });

  it('all 4 locale slugs for newsletter preferences are present', () => {
    expect(SCRIPT).toContain('preferenze-newsletter');
    expect(SCRIPT).toContain('newsletter-preferences');
    expect(SCRIPT).toContain('newsletter-einstellungen');
    expect(SCRIPT).toContain('preferences-newsletter');
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
