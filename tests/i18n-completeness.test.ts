/**
 * Translation completeness test.
 * 
 * Scans all source files for t('key') calls and verifies every key
 * exists in all 4 locale sections (it, en, de, fr) of i18n.ts.
 * 
 * Also scans data/service layers for i18n keys used as labels,
 * descriptions, tips, regime names, notes, etc.
 */
import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

// Directories/files to scan for t() calls
const SCAN_DIRS = ['components', 'services'];
const SCAN_FILES = ['App.tsx'];
// Extra files with i18n keys used as data values (not via t() calls)
const DATA_LAYER_FILES = ['services/calculationService.ts', 'constants.ts', 'data/borderCrossings.ts'];
const PROJECT_ROOT = path.resolve(__dirname, '..');

function scanDirRecursive(dirPath: string, files: string[]): void {
  if (!fs.existsSync(dirPath)) return;
  for (const entry of fs.readdirSync(dirPath, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      scanDirRecursive(path.join(dirPath, entry.name), files);
    } else if ((entry.name.endsWith('.ts') || entry.name.endsWith('.tsx')) &&
               !entry.name.includes('.test.') && entry.name !== 'i18n.ts') {
      files.push(path.join(dirPath, entry.name));
    }
  }
}

function getAllSourceFiles(): string[] {
  const files: string[] = [];
  
  for (const dir of SCAN_DIRS) {
    scanDirRecursive(path.join(PROJECT_ROOT, dir), files);
  }
  
  for (const file of SCAN_FILES) {
    const filePath = path.join(PROJECT_ROOT, file);
    if (fs.existsSync(filePath)) {
      files.push(filePath);
    }
  }
  
  return files;
}

function extractTranslationKeys(files: string[]): Set<string> {
  const keys = new Set<string>();
  // Match t('key') and t("key") patterns
  const regex = /\bt\(\s*['"]([^'"]+)['"]\s*[,)]/g;
  
  for (const file of files) {
    const content = fs.readFileSync(file, 'utf8');
    let match;
    while ((match = regex.exec(content)) !== null) {
      const key = match[1];
      // Skip keys that look like template expressions or non-translation keys
      if (key.includes('${') || key.startsWith('http')) continue;
      keys.add(key);
    }
  }
  
  return keys;
}

/**
 * Extract dynamic translation keys from template literals like:
 *   t(`gamification.achievement.${id}`)
 *   t(`gamification.category.${cat}`)
 * 
 * Cross-references with known IDs from ACHIEVEMENTS array and category definitions
 * to generate the full set of expected keys.
 */
function extractDynamicTranslationKeys(files: string[]): Set<string> {
  const keys = new Set<string>();
  // Match t(`prefix.${expr}`) patterns — extract the prefix
  const templateRegex = /\bt\(\s*`([^`]*?)\$\{[^}]+\}[^`]*`\s*[,)]/g;
  const prefixes = new Set<string>();

  for (const file of files) {
    const content = fs.readFileSync(file, 'utf8');
    let match;
    while ((match = templateRegex.exec(content)) !== null) {
      const prefix = match[1]; // e.g., 'gamification.achievement.'
      if (prefix && !prefix.includes('http')) {
        prefixes.add(prefix);
      }
    }
  }

  // For known gamification prefixes, expand using ACHIEVEMENTS and categories
  const achievementIds = [
    'first_visit', 'guide_reader', 'comparator_curious', 'comparator_master',
    'map_explorer', 'school_finder', 'first_simulation', 'pension_planner',
    'what_if_dreamer', 'simulation_pro', 'currency_watcher',
    'tax_calendar_user', 'health_researcher', 'dark_mode_fan',
    'feedback_giver', 'stats_checker', 'newsletter_sub', 'app_shortcut',
    'social_login', 'profile_complete',
    'quiz_completed', 'quiz_perfect', 'survey_participant',
    'salary_quiz', 'social_sharer',
    'forum_first_question', 'forum_first_answer',
  ];
  const categoryIds = ['all', 'explorer', 'calculator', 'expert', 'social'];

  for (const prefix of prefixes) {
    if (prefix === 'gamification.achievement.' || prefix === 'gamification.achievementDesc.') {
      for (const id of achievementIds) {
        keys.add(`${prefix}${id}`);
      }
    } else if (prefix === 'gamification.category.') {
      for (const id of categoryIds) {
        keys.add(`${prefix}${id}`);
      }
    }
    // Other dynamic prefixes could be added here as needed
  }

  return keys;
}

function extractLocaleKeys(locale: string): Set<string> {
  const keys = new Set<string>();
  // Chunk names map 1:1 to `services/locales/{locale}-{chunk}.ts`. Dash-separated
  // chunks (e.g. `seo-links`) are camelCased to build the exported variable name.
  const chunks = ['core', 'calculator', 'comparatori', 'fisco', 'guide', 'vita', 'stats', 'seo-links'];
  const toCamel = (s: string) => s.replace(/-([a-z])/g, (_m, c: string) => c.toUpperCase());

  // 1. Extract keys from all per-page chunk files
  for (const chunk of chunks) {
    const chunkFile = path.join(PROJECT_ROOT, 'services', 'locales', `${locale}-${chunk}.ts`);
    let varName: string;
    if (locale === 'it') {
      varName = 'translations';
    } else {
      const camel = toCamel(chunk);
      varName = `${locale}${camel.charAt(0).toUpperCase()}${camel.slice(1)}`;
    }
    const searchStart = `const ${varName}: Record<string, string> = {`;
    extractKeysFromObject(chunkFile, searchStart, keys);
  }

  // 2. Extract keys from the lazy-loaded blog meta file
  const blogMetaVarName = `blogMeta${locale.charAt(0).toUpperCase()}${locale.slice(1)}`;
  const blogMetaFilePath = path.join(PROJECT_ROOT, 'services', 'locales', `blog-meta-${locale}.ts`);
  if (fs.existsSync(blogMetaFilePath)) {
    const blogMetaSearchStart = `const ${blogMetaVarName}: Record<string, string> = {`;
    extractKeysFromObject(blogMetaFilePath, blogMetaSearchStart, keys);
  }

  // 3. Extract keys from per-article blog body files
  const blogBodyDir = path.join(PROJECT_ROOT, 'services', 'locales', 'blog-body', locale);
  if (fs.existsSync(blogBodyDir)) {
    const bodyFiles = fs.readdirSync(blogBodyDir).filter((f: string) => f.endsWith('.ts'));
    for (const file of bodyFiles) {
      const bodyFilePath = path.join(blogBodyDir, file);
      const bodyContent = fs.readFileSync(bodyFilePath, 'utf8');
      // Extract keys from the object — find the first const ... = { ... }
      const constMatch = bodyContent.match(/const\s+\w+:\s*Record<string,\s*string>\s*=\s*\{/);
      if (constMatch) {
        extractKeysFromObject(bodyFilePath, constMatch[0], keys);
      }
    }
  }

  return keys;
}

/**
 * Find the matching closing brace of an object literal, starting at `objStart`.
 *
 * This is a string-aware scanner: it correctly skips `{` and `}` characters that
 * appear inside string literals (`'...'`, `"..."`, `` `...` ``), line comments
 * (`// ...`), and block comments (`/* ... *\/`). Without this, a stray `}` inside
 * a translated string value would terminate parsing early and make subsequent
 * sibling keys invisible to the test — masking real missing translations.
 *
 * Template literals track `${...}` expression depth so that braces inside
 * interpolated expressions are counted as code, while braces in the literal
 * text portions are treated as string content.
 *
 * Returns `[startIdx, endIdx]` (both inclusive) or `[-1, -1]` if no matching
 * brace is found.
 */
function findObjectBounds(content: string, objStart: number): [number, number] {
  let depth = 0;
  let startIdx = -1;
  // Template literal expression stack: each entry is the depth at which the
  // current `${` was opened. When depth returns to that value at a `}`, the
  // expression is closing and we pop back into template-text mode.
  const templateExprStack: number[] = [];
  // Mode: 'code' | 'line-comment' | 'block-comment' | 'sq-string' | 'dq-string' | 'tpl-string'
  type Mode = 'code' | 'line-comment' | 'block-comment' | 'sq-string' | 'dq-string' | 'tpl-string';
  let mode: Mode = 'code';

  for (let i = objStart; i < content.length; i++) {
    const ch = content[i];
    const next = content[i + 1];

    if (mode === 'line-comment') {
      if (ch === '\n') mode = 'code';
      continue;
    }
    if (mode === 'block-comment') {
      if (ch === '*' && next === '/') {
        mode = 'code';
        i++;
      }
      continue;
    }
    if (mode === 'sq-string') {
      if (ch === '\\') { i++; continue; }
      if (ch === "'") mode = 'code';
      continue;
    }
    if (mode === 'dq-string') {
      if (ch === '\\') { i++; continue; }
      if (ch === '"') mode = 'code';
      continue;
    }
    if (mode === 'tpl-string') {
      if (ch === '\\') { i++; continue; }
      if (ch === '`') { mode = 'code'; continue; }
      if (ch === '$' && next === '{') {
        // Enter template expression: push current depth so we know when to pop.
        templateExprStack.push(depth);
        mode = 'code';
        i++; // skip the '{' — it's not an object brace, it's an expression delimiter
      }
      continue;
    }

    // mode === 'code'
    if (ch === '/' && next === '/') { mode = 'line-comment'; i++; continue; }
    if (ch === '/' && next === '*') { mode = 'block-comment'; i++; continue; }
    if (ch === "'") { mode = 'sq-string'; continue; }
    if (ch === '"') { mode = 'dq-string'; continue; }
    if (ch === '`') { mode = 'tpl-string'; continue; }

    if (ch === '{') {
      if (depth === 0) startIdx = i;
      depth++;
    } else if (ch === '}') {
      // If we're closing a template-literal expression, pop back into template string mode.
      if (templateExprStack.length > 0 && templateExprStack[templateExprStack.length - 1] === depth) {
        templateExprStack.pop();
        mode = 'tpl-string';
        continue;
      }
      depth--;
      if (depth === 0) {
        return [startIdx, i];
      }
    }
  }

  return [startIdx, -1];
}

function extractKeysFromObject(filePath: string, searchStart: string, keys: Set<string>): void {
  const content = fs.readFileSync(filePath, 'utf8');

  const objStart = content.indexOf(searchStart);
  if (objStart === -1) throw new Error(`Object starting with '${searchStart}' not found in ${filePath}`);

  const [startIdx, endIdx] = findObjectBounds(content, objStart);

  if (startIdx === -1 || endIdx === -1) throw new Error(`Could not parse object in ${filePath}`);

  const section = content.slice(startIdx, endIdx + 1);
  const keyRegex = /'([^']+)':\s*['"`]/g;
  let match;
  while ((match = keyRegex.exec(section)) !== null) {
    keys.add(match[1]);
  }
}

/**
 * Extract i18n keys used as data values in service/data files.
 * These are string literals like 'calc.workIncome', 'expenses.ch.rent', 'border.tips.chiassoCentro'
 * used in label, description, tips, regime, hours, peak, notes, tooltip fields.
 */
function extractDataLayerKeys(): Set<string> {
  const keys = new Set<string>();
  const keyPatterns = [
    /(?:label|description|tips|regime|hours|peak|tooltip|source):\s*['"]([a-z]+\.[a-z.]+[a-zA-Z]+)(?:\|[^'"]*)?['"]/g,
    // Also match keys in array literals (notes)
    /["']([a-z]+\.[a-z.]+[a-zA-Z]+)(?:\|[^'"]*)?["']/g,
  ];
  
  for (const relPath of DATA_LAYER_FILES) {
    const filePath = path.join(PROJECT_ROOT, relPath);
    if (!fs.existsSync(filePath)) continue;
    const content = fs.readFileSync(filePath, 'utf8');
    
    for (const regex of keyPatterns) {
      let match;
      while ((match = regex.exec(content)) !== null) {
        const key = match[1];
        // Must look like an i18n key (has a dot, starts with known prefix)
        if (key.match(/^(calc|expenses|border)\./)) {
          keys.add(key);
        }
      }
    }
  }
  
  return keys;
}

describe('Translation Completeness', () => {
  const sourceFiles = getAllSourceFiles();
  const usedKeys = extractTranslationKeys(sourceFiles);
  const dynamicKeys = extractDynamicTranslationKeys(sourceFiles);
  const dataLayerKeys = extractDataLayerKeys();
  const allUsedKeys = new Set([...usedKeys, ...dynamicKeys, ...dataLayerKeys]);
  const locales = ['it', 'en', 'de', 'fr'] as const;
  const localeKeys: Record<string, Set<string>> = {};
  
  for (const locale of locales) {
    localeKeys[locale] = extractLocaleKeys(locale);
  }

  it('should find translation keys in the codebase', () => {
    expect(usedKeys.size).toBeGreaterThan(0);
  });

  it('should find dynamic translation keys (template literals)', () => {
    expect(dynamicKeys.size).toBeGreaterThan(0);
  });

  it('should find data-layer i18n keys (calc, expenses, border)', () => {
    expect(dataLayerKeys.size).toBeGreaterThan(50);
  });

  for (const locale of locales) {
    it(`should have all used keys (t() calls) in the '${locale}' locale`, () => {
      const missing: string[] = [];
      for (const key of usedKeys) {
        if (!localeKeys[locale].has(key)) {
          missing.push(key);
        }
      }
      
      if (missing.length > 0) {
        console.log(`\n❌ Missing ${missing.length} t() keys in '${locale}' locale:`);
        missing.sort().forEach(k => console.log(`  - ${k}`));
      }
      
      expect(missing, `Missing keys in '${locale}': ${missing.join(', ')}`).toEqual([]);
    });

    it(`should have all dynamic keys (template literals) in the '${locale}' locale`, () => {
      const missing: string[] = [];
      for (const key of dynamicKeys) {
        if (!localeKeys[locale].has(key)) {
          missing.push(key);
        }
      }

      if (missing.length > 0) {
        console.log(`\n❌ Missing ${missing.length} dynamic keys in '${locale}' locale:`);
        missing.sort().forEach(k => console.log(`  - ${k}`));
      }

      expect(missing, `Missing dynamic keys in '${locale}': ${missing.join(', ')}`).toEqual([]);
    });

    it(`should have all data-layer keys in the '${locale}' locale`, () => {
      const missing: string[] = [];
      for (const key of dataLayerKeys) {
        if (!localeKeys[locale].has(key)) {
          missing.push(key);
        }
      }
      
      if (missing.length > 0) {
        console.log(`\n❌ Missing ${missing.length} data-layer keys in '${locale}' locale:`);
        missing.sort().forEach(k => console.log(`  - ${k}`));
      }
      
      expect(missing, `Missing data-layer keys in '${locale}': ${missing.join(', ')}`).toEqual([]);
    });
  }

  it('should have consistent keys across all locales', () => {
    const itKeys = localeKeys['it'];
    const inconsistencies: string[] = [];
    
    for (const locale of ['en', 'de', 'fr']) {
      const otherKeys = localeKeys[locale];
      
      for (const key of itKeys) {
        if (!otherKeys.has(key)) {
          inconsistencies.push(`'${key}' missing in '${locale}'`);
        }
      }
      
      for (const key of otherKeys) {
        if (!itKeys.has(key)) {
          inconsistencies.push(`'${key}' in '${locale}' but not in 'it'`);
        }
      }
    }
    
    if (inconsistencies.length > 0) {
      console.log(`\n❌ ${inconsistencies.length} inconsistencies found:`);
      inconsistencies.forEach(i => console.log(`  - ${i}`));
    }
    
    expect(inconsistencies).toEqual([]);
  });
});
