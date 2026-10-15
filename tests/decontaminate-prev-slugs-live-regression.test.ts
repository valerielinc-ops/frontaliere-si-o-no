import { describe, expect, it } from 'vitest';
import path from 'node:path';

import { processFiles } from '../scripts/decontaminate-prev-slugs.mjs';
import { listSliceFileNames } from '../scripts/lib/crawler-slice-files.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');
const SLICES_DIR = path.join(ROOT, 'data', 'jobs', 'by-crawler');

describe('previousSlugs ownership regrowth observer (#6784)', () => {
  it('keeps the repaired crawler fleet at a zero-change dry run', () => {
    const sliceFiles = listSliceFileNames(SLICES_DIR)
      .map((name) => path.join(SLICES_DIR, name));
    const result = processFiles(sliceFiles, { apply: false });

    expect(result).toMatchObject({
      moved: 0,
      emptyLocaleBucketsPruned: 0,
      affected: [],
    });
  });
});
