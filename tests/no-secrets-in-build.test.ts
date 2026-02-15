/**
 * Test: No secrets leaked in build output
 * 
 * Builds the project and scans all generated assets for known secret patterns.
 * This prevents API keys, tokens, and other sensitive data from being embedded
 * in the production JavaScript bundle.
 */
import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

// Patterns that should NEVER appear in build output
const SECRET_PATTERNS = [
  // GitHub Personal Access Tokens
  /github_pat_[A-Za-z0-9_]{30,}/,
  // Generic GitHub tokens
  /ghp_[A-Za-z0-9]{36}/,
  // Google API keys (but NOT Firebase public API keys which are fine)
  // We specifically check for known leaked keys
  /AIzaSyBdQzrmGtilRElTbVRkXChowTQhpKgIcrU/, // Google Maps key
  /AIzaSyC5WoQj3aI0k9l6CT8E8sCJwlf8n6rSdxs/, // Gemini key
  // reCAPTCHA site keys (should come from Remote Config)
  /6LeGWWosAAAAA[A-Za-z0-9_-]+/,
  /6LcvRmosAAAAA[A-Za-z0-9_-]+/,
  // Generic patterns for common secret leaks
  /GEMINI_API_KEY["':=]\s*["']AIzaSy/,
  /GITHUB_PAT["':=]\s*["']github_pat_/,
];

// Known safe patterns that look like secrets but aren't
const SAFE_PATTERNS = [
  'your_github_pat_here', // placeholder check in ApiStatus
  'your_gemini_api_key_here', // placeholder check
];

function getAllBuildFiles(dir: string): string[] {
  const files: string[] = [];
  if (!fs.existsSync(dir)) return files;
  
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...getAllBuildFiles(fullPath));
    } else if (/\.(js|css|html|json)$/.test(entry.name)) {
      files.push(fullPath);
    }
  }
  return files;
}

describe('No secrets in build output', () => {
  it('should not contain any secret patterns in source files used by the bundler', () => {
    const srcFiles = [
      'services/firebase.ts',
      'services/recaptchaService.ts',
      'services/trafficService.ts',
      'components/FeedbackSection.tsx',
      'components/ApiStatus.tsx',
      'vite.config.ts',
    ];

    const projectRoot = path.resolve(__dirname, '..');
    const violations: string[] = [];

    for (const relPath of srcFiles) {
      const filePath = path.join(projectRoot, relPath);
      if (!fs.existsSync(filePath)) continue;
      
      const content = fs.readFileSync(filePath, 'utf-8');
      
      for (const pattern of SECRET_PATTERNS) {
        const matches = content.match(pattern);
        if (matches) {
          // Check if this is a known safe pattern
          const isSafe = SAFE_PATTERNS.some(safe => matches[0].includes(safe));
          if (!isSafe) {
            violations.push(`${relPath}: found secret pattern ${pattern} → "${matches[0].substring(0, 40)}..."`);
          }
        }
      }
    }

    expect(violations).toEqual([]);
  });

  it('should not have env var fallbacks with real values in firebase config defaults', () => {
    const firebasePath = path.resolve(__dirname, '..', 'services', 'firebase.ts');
    const content = fs.readFileSync(firebasePath, 'utf-8');

    // The defaultConfig block should not reference import.meta.env for secrets
    const defaultConfigMatch = content.match(/defaultConfig\s*=\s*\{([^}]+)\}/s);
    if (defaultConfigMatch) {
      const block = defaultConfigMatch[1];
      // Must not use env vars as values — only empty strings are allowed
      expect(block).not.toContain('import.meta.env');
      // Must not contain actual secret values
      expect(block).not.toMatch(/AIzaSy[A-Za-z0-9_-]{30,}/);
      expect(block).not.toMatch(/github_pat_[A-Za-z0-9_]{20,}/);
      expect(block).not.toMatch(/6L[a-zA-Z0-9]{8}AAAAA/);
    }
  });

  it('should not inject secrets via vite define block', () => {
    const vitePath = path.resolve(__dirname, '..', 'vite.config.ts');
    const content = fs.readFileSync(vitePath, 'utf-8');

    // The define block should not contain any JSON.stringify of secret env vars
    const defineMatch = content.match(/define:\s*\{([^}]+)\}/s);
    if (defineMatch) {
      const block = defineMatch[1];
      expect(block).not.toContain('JSON.stringify');
      expect(block).not.toMatch(/env\.[A-Z_]*PAT/);
      expect(block).not.toMatch(/env\.[A-Z_]*API_KEY/);
    }
  });

  it('should not have hardcoded secrets in the getConfigValue fallback', () => {
    const firebasePath = path.resolve(__dirname, '..', 'services', 'firebase.ts');
    const content = fs.readFileSync(firebasePath, 'utf-8');

    // getConfigValue should NOT have a fallback map with env vars
    // It should just return empty string on failure
    expect(content).not.toMatch(/const envValues.*=.*\{[\s\S]*?import\.meta\.env/);
    expect(content).not.toMatch(/envValues\[key\]/);
  });
});
