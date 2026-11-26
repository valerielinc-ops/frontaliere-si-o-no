import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const ROOT = resolve(__dirname, '..');
const UPLOADER = resolve(ROOT, 'scripts/upload-event-image-library-cdn.mjs');
const BASE_FIXTURE = resolve(ROOT, 'tests/__fixtures__/license-audit/event-image-library.json');
const tempDirs: string[] = [];

afterEach(() => {
  for (const directory of tempDirs.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe('event image library CDN uploader', () => {
  it('tolerates an unreferenced legacy photo but keeps its upload validation strict', () => {
    const directory = mkdtempSync(join(tmpdir(), 'event-image-library-upload-'));
    tempDirs.push(directory);

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
    const registryPath = join(directory, 'event-image-library.json');
    writeFileSync(registryPath, JSON.stringify(testRegistry));

    const result = spawnSync(process.execPath, [
      UPLOADER,
      '--registry',
      registryPath,
      '--asset-dir',
      join(directory, 'assets'),
    ], { encoding: 'utf8' });
    const output = `${result.stdout || ''}${result.stderr || ''}`;

    expect(result.status).toBe(1);
    expect(output).not.toContain('Invalid event image registry:');
    expect(output).toContain('legacy-event-photo: invalid registry record:');
  });
});
