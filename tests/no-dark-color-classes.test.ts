/**
 * Enforces the semantic token design system.
 *
 * All colors must go through CSS custom properties in index.css
 * that auto-switch between light and dark mode. Hardcoded dark:
 * color prefixes (dark:bg-*, dark:text-*, dark:border-*, etc.)
 * are banned because they bypass the token system.
 *
 * Allowed exceptions:
 *   - dark:prose-invert  (Tailwind Typography plugin)
 *   - Comments and string literals explaining the rule
 *   - index.css itself (where the tokens are defined)
 *   - Migration scripts (scripts/migrate-*)
 */

import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

/** Recursively collect .ts/.tsx files, skipping node_modules, dist, .git */
function collectFiles(dir: string, files: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (['node_modules', 'dist', '.git', 'test-results', '.next', '.clarity-asset-cache', 'coverage'].includes(entry.name)) continue;
      collectFiles(full, files);
    } else if (/\.(tsx?|jsx?)$/.test(entry.name)) {
      files.push(full);
    }
  }
  return files;
}

const ROOT = path.resolve(__dirname, '..');

// Files that are allowed to mention dark: color patterns
const IGNORED_FILES = new Set([
  'index.css',
  'no-dark-color-classes.test.ts',
]);

// Patterns that are allowed even though they contain "dark:"
const ALLOWED_PATTERNS = [
  'dark:prose-invert',   // Tailwind Typography
  'dark:prose-dark',     // Tailwind Typography variant
];

/**
 * Matches dark: followed by a Tailwind color utility.
 * Catches: dark:bg-red-500, dark:text-slate-300, dark:border-emerald-100,
 *          dark:ring-amber-400, dark:from-blue-50, dark:shadow-black/20,
 *          dark:decoration-stripe-300, dark:marker:text-red-500,
 *          dark:hover:bg-red-500, dark:group-hover:text-blue-300,
 *          dark:focus-visible:ring-green-400, dark:active:bg-slate-100,
 *          dark:disabled:bg-slate-300, dark:placeholder:text-gray-400
 *
 * Does NOT match: dark:prose-invert, dark mode (prose text)
 */
const DARK_COLOR_REGEX = /dark:(?:[a-z-]+:)*(bg|text|border|ring|from|to|via|shadow|outline|decoration|fill|stroke|accent|caret|marker:text|divide|placeholder:text)-[a-z]+-\d/g;

describe('no hardcoded dark: color classes', () => {
  const files = collectFiles(ROOT).filter(f => {
    const base = path.basename(f);
    // Skip ignored files
    if (IGNORED_FILES.has(base)) return false;
    // Skip migration scripts
    if (f.includes('/scripts/migrate-')) return false;
    return true;
  });

  it('should find component files to scan', () => {
    expect(files.length).toBeGreaterThan(50);
  });

  it('no .tsx/.ts file contains dark: color utility classes', () => {
    const violations: { file: string; line: number; match: string }[] = [];

    for (const file of files) {
      const content = fs.readFileSync(file, 'utf8');
      const lines = content.split('\n');

      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];

        // Skip comments
        const trimmed = line.trim();
        if (trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*')) continue;

        // Find all dark: color matches
        const matches = line.match(DARK_COLOR_REGEX);
        if (!matches) continue;

        for (const match of matches) {
          // Check if it's an allowed pattern
          if (ALLOWED_PATTERNS.some(p => match.includes(p))) continue;
          violations.push({
            file: path.relative(ROOT, file),
            line: i + 1,
            match,
          });
        }
      }
    }

    if (violations.length > 0) {
      const report = violations
        .map(v => `  ${v.file}:${v.line} → ${v.match}`)
        .join('\n');
      expect.fail(
        `Found ${violations.length} hardcoded dark: color class(es).\n` +
        `Use semantic tokens from index.css instead.\n` +
        `See :root / html.dark / @theme blocks for available tokens.\n\n${report}`
      );
    }
  });
});
