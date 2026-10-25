import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const ROOT = resolve(import.meta.dirname, '..');

describe('LinkedIn auth requests', () => {
  it('bounds profile enrichment, OAuth exchange, and userinfo calls', () => {
    const source = readFileSync(resolve(ROOT, 'functions/src/linkedinAuthCallback.js'), 'utf8');
    expect(source).toContain('const LINKEDIN_FETCH_TIMEOUT_MS = 30_000;');
    expect(source).toContain('signal: AbortSignal.timeout(LINKEDIN_FETCH_TIMEOUT_MS)');
    expect(source.match(/fetchLinkedIn\(/g)).toHaveLength(4);
    expect(source.match(/await fetch\(/g) || []).toHaveLength(0);
  });
});
