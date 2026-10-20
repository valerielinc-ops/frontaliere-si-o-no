// @vitest-environment node

import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { generateImageFromSpec } from '../packages/articles/engine/shared/generatedImageEngine.mjs';

describe('generated image engine deadlines', () => {
  it('fails before invoking a provider when the deadline has expired', async () => {
    const outputDir = fs.mkdtempSync(path.join(os.tmpdir(), 'generated-image-deadline-'));
    const attempts: unknown[] = [];
    try {
      await expect(generateImageFromSpec({
        scope: 'article-hero',
        subject: 'an abstract illustrated border landscape',
        assetId: 'deadline-contract',
      }, {
        outputDir,
        deadlineAt: Date.now() - 1,
        onProviderAttempt: (attempt) => attempts.push(attempt),
      })).rejects.toMatchObject({ code: 'ETIMEDOUT' });

      expect(attempts).toEqual([]);
      expect(fs.readdirSync(outputDir)).toEqual([]);
    } finally {
      fs.rmSync(outputDir, { recursive: true, force: true });
    }
  });
});
