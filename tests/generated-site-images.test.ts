import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { AUTHORS } from '../data/authors';
import { verifyPublishedGeneratedSiteImages } from '../scripts/lib/generated-site-images.mjs';
import {
  isPrivateGrantImageRecord,
  validateGeneratedImageRegistry,
} from '../packages/articles/engine/shared/generatedImageRegistry.mjs';

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
        expect(record?.note).toBe('ritratto, CV e LinkedIn forniti dall\'autore; consenso confermato dal proprietario il 2026-10-06');
      } else {
        expect(record?.license).toBe('generated-provider');
        expect(record?.provider).toBe('openai-codex');
      }
    }

    expect(places.filter((record) => record.width === 1200 && record.height === 675)).toHaveLength(16);
    expect(places.filter((record) => record.width === 480 && record.height === 270)).toHaveLength(16);
  });

  it('registers the six site-owned publisher logo variants as private assets', () => {
    const registry = JSON.parse(fs.readFileSync(
      path.join(process.cwd(), 'data', 'generated-image-registry.json'),
      'utf8',
    ));
    const validation = validateGeneratedImageRegistry(registry);
    expect(validation.valid, validation.errors.join('\n')).toBe(true);
    const publishers = registry.assets.filter((record: { scope?: string }) => record.scope === 'publisher');
    expect(publishers).toHaveLength(6);
    expect(publishers.every((record: { license: string; provider: string; note?: string; generatedAt?: string }) => (
      isPrivateGrantImageRecord(record)
      && record.note?.includes('scripts/generate-publisher-logos.mjs')
      && !record.generatedAt
    ))).toBe(true);
    expect(new Set(publishers.map((record: { imageUrl: string }) => record.imageUrl))).toEqual(new Set([
      '/images/publisher/logo-rect-400.png',
      '/images/publisher/logo-rect-400.webp',
      '/images/publisher/logo-square-1000.png',
      '/images/publisher/logo-square-1000.webp',
      '/images/publisher/logo-square-512.png',
      '/images/publisher/logo-square-512.webp',
    ]));
  });
});
