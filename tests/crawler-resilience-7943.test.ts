import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { isInvokedDirectly } from '../scripts/lib/is-invoked-directly.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ADAPTER_RUNNERS = [
  'scripts/update-abb-jobs.mjs',
  'scripts/update-lidl-jobs.mjs',
  'scripts/update-migros-jobs.mjs',
  'scripts/update-vtg-jobs.mjs',
  'scripts/update-axa-jobs.mjs',
  'scripts/update-coop-jobs.mjs',
  'scripts/update-corner-jobs.mjs',
  'scripts/update-eoc-jobs.mjs',
  'scripts/update-fust-jobs.mjs',
  'scripts/update-swisscom-jobs.mjs',
] as const;

describe('crawler resilience continuation #7943', () => {
  it('keeps one shared direct-invocation guard across all named adapters', () => {
    for (const relativePath of ADAPTER_RUNNERS) {
      const source = fs.readFileSync(path.join(ROOT, relativePath), 'utf8');
      expect(source, relativePath).toContain("import { isInvokedDirectly } from './lib/is-invoked-directly.mjs';");
      expect(source, relativePath).toContain('if (isInvokedDirectly(import.meta.url))');
      expect(source, relativePath).not.toMatch(/(?:const|let|var)\s+isInvokedDirectly\s*=/);
    }
  });

  it('keeps the shared guard semantics for imports and direct execution', () => {
    expect(isInvokedDirectly(
      'file:///workspace/scripts/update-example-jobs.mjs',
      '/workspace/scripts/update-example-jobs.mjs',
    )).toBe(true);
    expect(isInvokedDirectly(
      'file:///workspace/scripts/update-example-jobs.mjs',
      '/workspace/scripts/other-jobs.mjs',
    )).toBe(false);
    expect(isInvokedDirectly('not-a-file-url', undefined)).toBe(false);
  });

  it('leaves Migros locale preference explicit rather than lexical-only', () => {
    const source = fs.readFileSync(path.join(ROOT, 'scripts/update-migros-jobs.mjs'), 'utf8');
    expect(source).toContain('MIGROS_LOCALE_PRIORITY');
    expect(source).toContain('compareMigrosDetailUrls');
    expect(source).not.toMatch(/url\.localeCompare\(/);
  });
});
