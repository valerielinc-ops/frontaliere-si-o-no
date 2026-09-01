import { describe, expect, it } from 'vitest';
import path from 'node:path';

import { processFiles } from '../scripts/decontaminate-prev-slugs.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');
const REGRESSED_SLICES = [
  'denner.json',
  'galenica.json',
  'ksbl.json',
  'mobiliar.json',
  'rituals-cosmetics.json',
  'stadt-zuerich.json',
].map((name) => path.join(ROOT, 'data', 'jobs', 'by-crawler', name));

describe('previousSlugs ownership regrowth observer (#6784)', () => {
  it('keeps the six repaired crawler slices at a zero-change dry run', () => {
    const result = processFiles(REGRESSED_SLICES, { apply: false });

    expect(result).toMatchObject({
      moved: 0,
      emptyLocaleBucketsPruned: 0,
      affected: [],
    });
  });
});
