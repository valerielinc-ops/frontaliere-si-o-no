import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  LICENSED_PHOTO_RESTRICTIONS,
  validateEventImageRegistryForPublishedEvents,
  validateGeneratedImageRecordWithRegistry,
} from '../packages/articles/engine/shared/generatedImageRegistry.mjs';

const ROOT = resolve(__dirname, '..');
const UPLOADER = resolve(ROOT, 'scripts/upload-event-image-library-cdn.mjs');
const BASE_FIXTURE = resolve(ROOT, 'tests/__fixtures__/license-audit/event-image-library.json');

describe('event image library CDN uploader', () => {
  it('tolerates an unreferenced legacy photo but keeps its upload validation strict', () => {
    const registry = JSON.parse(readFileSync(BASE_FIXTURE, 'utf8'));
    const generated = registry.assets[0];
    const legacyPhoto = {
      ...generated,
      assetId: 'legacy-event-photo',
      kind: 'photo',
      provider: 'wikimedia',
      model: 'Wikimedia Commons file mirror',
      license: 'CC BY-SA 4.0',
      licenseFamily: 'cc-by-sa',
      licenseUrl: 'https://creativecommons.org/licenses/by-sa/4.0/',
      credit: 'Ada Wikimedia · CC BY-SA 4.0',
      author: { name: 'Ada Wikimedia', url: 'https://commons.wikimedia.org/wiki/User:Ada' },
      sourcePageUrl: 'https://commons.wikimedia.org/wiki/File:Lago.jpg',
      sourceImageUrl: 'https://upload.wikimedia.org/lago.jpg',
      sourceWidth: 2400,
      sourceHeight: 1600,
      copyrightNotice: '© Ada Wikimedia',
      acquireLicensePage: 'https://commons.wikimedia.org/wiki/File:Lago.jpg',
      modifications: ['cropped', 'resized', 'converted-to-webp'],
      restrictions: [...LICENSED_PHOTO_RESTRICTIONS],
      sha256: '2'.repeat(64),
      imageUrl: '/images/events/library/legacy-event-photo.webp',
      vision: {
        ...generated.vision,
        contains_text: false,
        is_photograph: true,
      },
    };
    delete legacyPhoto.vision.contains_recognizable_foreground_person;

    const testRegistry = {
      ...registry,
      assetCount: 2,
      assets: [generated, legacyPhoto],
    };

    expect(validateEventImageRegistryForPublishedEvents([], testRegistry)).toEqual({ valid: true, errors: [] });
    expect(validateGeneratedImageRecordWithRegistry(legacyPhoto, testRegistry).errors)
      .toContain('licensed-photo vision gate verdict is missing or rejected');

    const uploaderSource = readFileSync(UPLOADER, 'utf8');
    expect(uploaderSource).toContain('validateEventImageRegistryForPublishedEvents([], registry)');
    expect(uploaderSource).toContain('validateGeneratedImageRecordWithRegistry(record, registry)');
  });
});
