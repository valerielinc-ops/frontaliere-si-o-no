import { describe, expect, it } from 'vitest';
import { AUTHORS } from '../data/authors';
import { verifyPublishedGeneratedSiteImages } from '../scripts/lib/generated-site-images.mjs';
import { isPrivateGrantImageRecord } from '../packages/articles/engine/shared/generatedImageRegistry.mjs';

describe('published editorial and place image registry', () => {
  it('covers every published author/place WebP and matches its bytes', async () => {
    const result = await verifyPublishedGeneratedSiteImages({ rootDir: process.cwd() });
    expect(result.valid, result.errors.join('\n')).toBe(true);
    expect(result.records).toHaveLength(36);

    const profiles = result.records.filter((record) => record.scope === 'editorial-profile');
    const places = result.records.filter((record) => record.scope === 'place');
    expect(profiles).toHaveLength(4);
    expect(places).toHaveLength(32);
    expect(new Set(result.records.map((record) => record.imageUrl)).size).toBe(36);

    for (const author of AUTHORS) {
      const record = profiles.find((candidate) => candidate.imageUrl === author.photoPath);
      expect(record, `missing registry record for ${author.slug}`).toBeTruthy();
      expect(record?.width).toBe(400);
      expect(record?.height).toBe(400);
      if (author.slug === 'samuele-valente') {
        expect(isPrivateGrantImageRecord(record)).toBe(true);
        expect(record?.license).toBe('private-grant');
        expect(record?.provider).toBe('site-owned');
        expect(record?.note).toBe('ritratto fornito dall\'autore; consenso da confermare dal proprietario');
      } else {
        expect(record?.license).toBe('generated-provider');
        expect(record?.provider).toBe('openai-codex');
      }
    }

    expect(places.filter((record) => record.width === 1200 && record.height === 675)).toHaveLength(16);
    expect(places.filter((record) => record.width === 480 && record.height === 270)).toHaveLength(16);
  });
});
