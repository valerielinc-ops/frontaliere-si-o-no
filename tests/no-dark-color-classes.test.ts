/**
 * Enforces the semantic token design system.
 *
 * All colors must go through CSS custom properties in index.css
 * that auto-switch between light and dark mode.
 *
 * TWO checks:
 * 1. No dark: color prefixes (dark:bg-*, dark:text-*, etc.)
 * 2. No hardcoded Tailwind color-scale classes (bg-red-500, text-emerald-600, etc.)
 *    — use semantic tokens: bg-danger, text-success, bg-accent-strong, etc.
 *
 * Allowed exceptions listed in ALLOWED_HARDCODED below.
 */

import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

const SKIP_DIRS = new Set([
  'node_modules', 'dist', 'dist-old-25912', '.git', 'test-results', '.next',
  '.clarity-asset-cache', 'coverage', 'scripts',
  // Generated / environment dirs that contain no app source
  'public', 'data', 'reports', 'log', 'test-results',
  '.cache', '.build-cache', '.tmp', '.venv', '.playwright-mcp',
  '.claude', '.cursor', '.idx', '.gitnexus', '.gstack', '.planning',
  '.agents', '.serena', '.superpowers', '.githooks', '.github',
  '.vscode', '_newsletter_variants', 'download', 'mcp-gsc-main',
  'functions', 'server',
]);

function collectFiles(dir: string, files: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      collectFiles(full, files);
    } else if (/\.(tsx?|jsx?)$/.test(entry.name)) {
      files.push(full);
    }
  }
  return files;
}

const ROOT = path.resolve(__dirname, '..');

const IGNORED_FILES = new Set([
  'index.css',
  'no-dark-color-classes.test.ts',
  // Decorative weather plugins: per-WMO-code icon hues (sun=amber, cloud=slate,
  // rain=sky, snow=indigo, storm=violet) carry their meaning through colour
  // and can't be remapped onto semantic tokens without losing the weather
  // signal. Same rationale as iconBgMap object-keys in ALLOWED_HARDCODED.
  'weatherCityPagesPlugin.ts',
  'weatherIconsHelper.ts',
]);

// ── dark: check ──
const ALLOWED_DARK = ['dark:prose-invert', 'dark:prose-dark'];
const DARK_COLOR_REGEX = /dark:(?:[a-z-]+:)*(bg|text|border|ring|from|to|via|shadow|outline|decoration|fill|stroke|accent|caret|marker:text|divide|placeholder:text)-[a-z]+-\d/g;

// ── hardcoded color check ──
// Color families that must use semantic tokens
const COLOR_FAMILIES = [
  'slate', 'gray', 'zinc', 'stone', 'neutral',
  'red', 'rose', 'pink',
  'orange', 'amber', 'yellow',
  'green', 'emerald', 'teal', 'cyan', 'sky', 'blue',
  'indigo', 'violet', 'purple', 'fuchsia',
  'stripe',
];
const COLOR_PATTERN = COLOR_FAMILIES.join('|');
// Matches: bg-red-500, text-emerald-600, border-slate-200, ring-amber-400,
//          from-stripe-600, to-green-500, via-teal-500, shadow-emerald-900/20,
//          hover:bg-red-500, focus-visible:ring-emerald-500, etc.
const HARDCODED_COLOR_REGEX = new RegExp(
  `(?:^|\\s|'|"|\`)(?:[a-z-]+:)*(bg|text|border|ring|from|to|via|shadow|outline|decoration|fill|stroke|divide|accent|caret)-(${COLOR_PATTERN})-\\d`,
  'g'
);

// Patterns allowed in hardcoded form (e.g., object keys used for mapping)
const ALLOWED_HARDCODED = [
  /['"]text-gray-500['"]/,  // Object key in iconBgMap
];

function isComment(line: string): boolean {
  const t = line.trim();
  return t.startsWith('//') || t.startsWith('*') || t.startsWith('/*');
}

describe('semantic token enforcement', () => {
  const files = collectFiles(ROOT).filter(f => {
    const base = path.basename(f);
    if (IGNORED_FILES.has(base)) return false;
    if (f.includes('/scripts/migrate-')) return false;
    if (base.endsWith('.test.ts') || base.endsWith('.test.tsx')) return false;
    return true;
  });

  it('should find component files to scan', () => {
    expect(files.length).toBeGreaterThan(50);
  });

  it('no dark: color utility classes', () => {
    const violations: { file: string; line: number; match: string }[] = [];

    for (const file of files) {
      const lines = fs.readFileSync(file, 'utf8').split('\n');
      for (let i = 0; i < lines.length; i++) {
        if (isComment(lines[i])) continue;
        const matches = lines[i].match(DARK_COLOR_REGEX);
        if (!matches) continue;
        for (const match of matches) {
          if (ALLOWED_DARK.some(p => match.includes(p))) continue;
          violations.push({ file: path.relative(ROOT, file), line: i + 1, match });
        }
      }
    }

    if (violations.length > 0) {
      const report = violations.map(v => `  ${v.file}:${v.line} → ${v.match}`).join('\n');
      expect.fail(
        `Found ${violations.length} hardcoded dark: color class(es).\n` +
        `Use semantic tokens from index.css instead.\n\n${report}`
      );
    }
  });

  it('no hardcoded Tailwind color-scale classes', () => {
    const violations: { file: string; line: number; match: string }[] = [];

    for (const file of files) {
      const lines = fs.readFileSync(file, 'utf8').split('\n');
      for (let i = 0; i < lines.length; i++) {
        if (isComment(lines[i])) continue;
        // Check if entire line is an allowed pattern
        if (ALLOWED_HARDCODED.some(re => re.test(lines[i]))) continue;
        const matches = lines[i].match(HARDCODED_COLOR_REGEX);
        if (!matches) continue;
        for (const match of matches) {
          violations.push({ file: path.relative(ROOT, file), line: i + 1, match: match.trim() });
        }
      }
    }

    if (violations.length > 0) {
      const report = violations.slice(0, 30).map(v => `  ${v.file}:${v.line} → ${v.match}`).join('\n');
      const suffix = violations.length > 30 ? `\n  ... and ${violations.length - 30} more` : '';
      expect.fail(
        `Found ${violations.length} hardcoded Tailwind color-scale class(es).\n` +
        `Use semantic tokens: bg-surface, text-heading, text-success, bg-danger-strong, etc.\n` +
        `See index.css @theme block for the full token inventory.\n\n${report}${suffix}`
      );
    }
  });
});
