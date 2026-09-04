import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = path.resolve(import.meta.dirname, '..');
const FALSE_SPEC_PATHS = [
  'data/prospector/crawlers/albergo-gardenia.json',
  'data/prospector/crawlers/alpenhof-davos.json',
  'data/prospector/crawlers/weisskreuz.json',
];

describe('Albergo Gardenia live registry regression', () => {
  it('keeps the three proven inactive poisoned learned specs retired', () => {
    for (const relativePath of FALSE_SPEC_PATHS) {
      expect(fs.existsSync(path.join(ROOT, relativePath))).toBe(false);
    }
  });
});
