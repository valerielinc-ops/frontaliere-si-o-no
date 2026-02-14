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

function getAllSourceFiles(): string[] {
  const files: string[] = [];
  
  for (const dir of SCAN_DIRS) {
    const dirPath = path.join(PROJECT_ROOT, dir);
    if (!fs.existsSync(dirPath)) continue;
    for (const file of fs.readdirSync(dirPath)) {
      if (file.endsWith('.ts') || file.endsWith('.tsx')) {
        // Skip test files and i18n.ts itself
        if (file.includes('.test.') || file === 'i18n.ts') continue;
        files.push(path.join(dirPath, file));
      }
    }
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

function extractLocaleKeys(locale: string): Set<string> {
  const i18nPath = path.join(PROJECT_ROOT, 'services', 'i18n.ts');
  const content = fs.readFileSync(i18nPath, 'utf8');
  
  // Find the translations object first, then find the locale inside it
  const translationsStart = content.indexOf('const translations: AllTranslations = {');
  if (translationsStart === -1) throw new Error('translations object not found');
  
  const localeStart = content.indexOf(`  ${locale}: {`, translationsStart);
  if (localeStart === -1) throw new Error(`Locale '${locale}' not found`);
  
  // Find the matching closing brace (track depth)
  let depth = 0;
  let startIdx = -1;
  let endIdx = -1;
  for (let i = localeStart; i < content.length; i++) {
    if (content[i] === '{') {
      if (depth === 0) startIdx = i;
      depth++;
    } else if (content[i] === '}') {
      depth--;
      if (depth === 0) {
        endIdx = i;
        break;
      }
    }
  }
  
  if (startIdx === -1 || endIdx === -1) throw new Error(`Could not parse locale '${locale}'`);
  
  const section = content.slice(startIdx, endIdx + 1);
  const keys = new Set<string>();
  const keyRegex = /'([^']+)':\s*'/g;
  let match;
  while ((match = keyRegex.exec(section)) !== null) {
    keys.add(match[1]);
  }
  
  return keys;
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
  const dataLayerKeys = extractDataLayerKeys();
  const allUsedKeys = new Set([...usedKeys, ...dataLayerKeys]);
  const locales = ['it', 'en', 'de', 'fr'] as const;
  const localeKeys: Record<string, Set<string>> = {};
  
  for (const locale of locales) {
    localeKeys[locale] = extractLocaleKeys(locale);
  }

  it('should find translation keys in the codebase', () => {
    expect(usedKeys.size).toBeGreaterThan(0);
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
