import { describe, expect, it } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import { crawlerScratchPathFor, normalizeCrawlerKey } from '../scripts/lib/crawler-scratch-path.mjs';

describe('crawler scratch path', () => {
  it('normalizes stable company keys without allowing path traversal', () => {
    expect(normalizeCrawlerKey('  Éxample  Jobs  ')).toBe('example-jobs');
    expect(crawlerScratchPathFor('Baronie')).toBe(
      path.join(os.tmpdir(), 'frontaliere-jobs-scratch-baronie.json'),
    );
    expect(() => normalizeCrawlerKey('../escape')).toThrow(TypeError);
    expect(() => normalizeCrawlerKey('')).toThrow(TypeError);
  });
});
