import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const source = readFileSync(
  resolve(dirname(fileURLToPath(import.meta.url)), '../scripts/check-article-hub-landings.mjs'),
  'utf8',
);

describe('article hub network probe', () => {
  it('routes text, JSON, landing and archive requests through one deadline', () => {
    expect(source).toContain('HUB_LANDINGS_FETCH_TIMEOUT_MS');
    expect(source).toMatch(/function fetchHub[\s\S]*?AbortSignal\.timeout\(HUB_LANDINGS_FETCH_TIMEOUT_MS\)/);
    expect(source).not.toMatch(/await fetch\(/);
  });
});
