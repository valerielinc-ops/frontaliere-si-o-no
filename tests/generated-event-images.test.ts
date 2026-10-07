import { describe, expect, it } from 'vitest';
import {
  buildGeneratedImagePrompt,
  GENERATED_IMAGE_PROMPT_VERSION,
  GENERATED_IMAGE_RESTRICTIONS,
  LICENSED_PHOTO_RESTRICTIONS,
  validateGeneratedImageRegistry,
  validateGeneratedImageRecord,
  verifyPublishedEventImages,
} from '../packages/articles/engine/shared/generatedImageRegistry.mjs';
import {
  assignEventImageAsset,
  eventImageLibrarySlots,
  eventImageSeason,
  normalizeEventImageArea,
  normalizeEventImageCategory,
  selectEventImageAsset,
  stableEventImageHash,
} from '../packages/articles/engine/shared/eventImageLibrary.mjs';

const RECORD = {
  schema: 1,
  assetId: 'event-musica-ticino-primavera',
  provider: 'openai-codex',
  model: 'gpt-image-2.5',
  executorModel: 'gpt-5.6-luna',
  promptVersion: GENERATED_IMAGE_PROMPT_VERSION,
  promptHash: '0'.repeat(64),
  license: 'generated-provider',
  licenseUrl: 'https://openai.com/policies/terms-of-use/',
  credit: 'frontaliereticino.ch',
  sha256: '1'.repeat(64),
  bytes: 1000,
  width: 1200,
  height: 675,
  format: 'webp',
  generatedAt: '2026-10-06T00:00:00.000Z',
  verifiedAt: '2026-10-06T00:00:00.000Z',
  restrictions: [...GENERATED_IMAGE_RESTRICTIONS],
  vision: {
    ok: true,
    contains_text: false,
    contains_logo: false,
    contains_recognizable_face: false,
    looks_like_specific_real_event: false,
    notes: 'safe fixture',
  },
  scope: 'event-library',
  imageUrl: '/images/events/library/event-musica-ticino-primavera.webp',
  category: 'musica',
  area: 'ticino-confine',
  season: 'primavera-estate',
  variant: '01',
};

const ARTICLE_RECORD = {
  ...RECORD,
  assetId: 'historical-article-hero',
  scope: 'article-hero',
  imageUrl: '/images/blog/historical-article-hero.webp',
};

const PHOTO_RECORD = {
  ...RECORD,
  assetId: 'event-lago-laghi-primavera-v02',
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
  copyrightNotice: '© Ada Wikimedia',
  acquireLicensePage: 'https://commons.wikimedia.org/wiki/File:Lago.jpg',
  restrictions: [...LICENSED_PHOTO_RESTRICTIONS],
  vision: {
    ok: true,
    contains_text: true,
    contains_logo: false,
    contains_recognizable_face: false,
    looks_like_specific_real_event: false,
    notes: 'safe licensed landscape fixture',
  },
  imageUrl: '/images/events/library/event-lago-laghi-primavera-v02.webp',
  category: 'generico',
  area: 'laghi',
  season: 'primavera-estate',
  variant: '02',
};

describe('generated event image policy', () => {
  it('keeps the forbidden-content policy in the canonical prompt', () => {
    const prompt = buildGeneratedImagePrompt({
      scope: 'event-library',
      subject: 'musica e concerto',
      area: 'Ticino e area di confine',
      season: 'primavera-estate',
    });
    expect(prompt).toContain('No logo, brand, trademark');
    expect(prompt).toContain('No real or recognizable person');
    expect(prompt).toContain('never a documentary or journalistic photograph');
  });

  it('validates a complete generated record and rejects a stale path', () => {
    expect(validateGeneratedImageRecord(RECORD).valid).toBe(true);
    expect(validateGeneratedImageRecord(ARTICLE_RECORD).valid).toBe(true);
    expect(validateGeneratedImageRecord({ ...ARTICLE_RECORD, imageUrl: '/images/generated/historical-article-hero.webp' }).valid).toBe(false);
    expect(validateGeneratedImageRecord({ ...RECORD, licenseUrl: 'https://example.com/terms' }).valid).toBe(false);
    expect(validateGeneratedImageRegistry({ schema: 1, libraryVersion: '2026-10-06', cdnPrefix: '/images/events/library/', assetCount: 1, assets: [RECORD] }, { scope: 'event-library' }).valid).toBe(true);
    expect(validateGeneratedImageRecord({ ...RECORD, imageUrl: '/images/events/myswitzerland-old.webp' }).valid).toBe(false);
  });

  it('validates licensed photo metadata and rejects a missing licence', () => {
    expect(validateGeneratedImageRecord(PHOTO_RECORD).valid).toBe(true);
    expect(validateGeneratedImageRecord({ ...PHOTO_RECORD, license: '' }).valid).toBe(false);
    expect(validateGeneratedImageRecord({ ...PHOTO_RECORD, author: undefined }).valid).toBe(false);
    expect(validateGeneratedImageRecord({
      ...PHOTO_RECORD,
      vision: { ...PHOTO_RECORD.vision, contains_recognizable_face: true },
    }).valid).toBe(false);
  });
});

describe('event image library taxonomy and assignment', () => {
  it('creates the 12 × 4 × 2 initial slot matrix', () => {
    const slots = eventImageLibrarySlots();
    expect(slots).toHaveLength(96);
    expect(new Set(slots.map((slot) => slot.assetId)).size).toBe(96);
    expect(eventImageLibrarySlots({ variants: 3 })).toHaveLength(288);
    expect(eventImageLibrarySlots({ variants: 3 })[1].assetId).toContain('-v02');
  });

  it('normalizes dirty categories and maps cantons to macro-areas', () => {
    expect(normalizeEventImageCategory('Pop generalmente')).toBe('musica');
    expect(normalizeEventImageCategory('Theater')).toBe('teatro-spettacolo');
    expect(normalizeEventImageCategory('Exhibition')).toBe('mostra-museo');
    expect(normalizeEventImageCategory('Food')).toBe('gastronomia');
    expect(normalizeEventImageCategory('Atelier')).toBe('famiglia-bambini');
    expect(normalizeEventImageCategory('Event')).toBe('generico');
    expect(normalizeEventImageArea({ canton: 'TI' })).toBe('ticino-confine');
    expect(normalizeEventImageArea({ canton: 'ZH' })).toBe('svizzera-urbana');
    expect(normalizeEventImageArea({ canton: 'GR' })).toBe('alpi-montagna');
    expect(normalizeEventImageArea({ canton: 'SZ' })).toBe('laghi');
  });

  it('hashes the event id deterministically when choosing variants', () => {
    const registry = {
      assets: [
        { ...RECORD, assetId: 'event-musica-ticino-01', imageUrl: '/images/events/library/event-musica-ticino-01.webp', variant: '01' },
        { ...RECORD, assetId: 'event-musica-ticino-02', imageUrl: '/images/events/library/event-musica-ticino-02.webp', variant: '02' },
      ],
    };
    const event = { id: 'openagenda:123', category: 'Music', canton: 'TI', startDate: '2026-06-01' };
    expect(stableEventImageHash(event.id)).toBe(stableEventImageHash(event.id));
    expect(selectEventImageAsset(event, registry)).toEqual(selectEventImageAsset(event, registry));
    expect(eventImageSeason(event.startDate)).toBe('primavera-estate');
  });

  it('preserves OpenAgenda evidence and removes an unauthorized stale URL', () => {
    const openAgenda = {
      id: 'openagenda:1',
      sourceKey: 'openagenda',
      imageUrl: '/images/events/openagenda-1.webp',
      imageCredit: 'Comune di Carouge',
      imageLicense: 'Licence Ouverte 2.0',
      imageLicenseUrl: 'https://doc.openagenda.com/fr/article/conditions-generales-dutilisation-xq325m/',
    };
    expect(assignEventImageAsset(openAgenda, { assets: [] })).toEqual(openAgenda);
    const stale = { id: 'myswitzerland:1', imageUrl: '/images/events/myswitzerland-1.webp' };
    expect(assignEventImageAsset(stale, { assets: [] })).not.toHaveProperty('imageUrl');
  });
});

describe('published event image gate', () => {
  it('accepts a recorded generated asset and a credited OpenAgenda mirror', () => {
    const result = verifyPublishedEventImages([
      {
        id: 'event:1',
        imageUrl: RECORD.imageUrl,
        imageAssetId: RECORD.assetId,
        imageLicense: RECORD.license,
        imageLicenseUrl: RECORD.licenseUrl,
        imageCredit: RECORD.credit,
        imageProvider: RECORD.provider,
      },
      {
        id: 'openagenda:1',
        sourceKey: 'openagenda',
        imageUrl: '/images/events/openagenda-1.webp',
        imageCredit: 'Comune di Carouge',
        imageLicense: 'Licence Ouverte 2.0',
        imageLicenseUrl: 'https://doc.openagenda.com/fr/article/conditions-generales-dutilisation-xq325m/',
      },
    ], [RECORD]);
    expect(result).toEqual({ valid: true, errors: [] });
  });

  it('accepts a registered licensed photo only when attribution is propagated', () => {
    const event = {
      id: 'event:photo',
      imageUrl: PHOTO_RECORD.imageUrl,
      imageAssetId: PHOTO_RECORD.assetId,
      imageLicense: PHOTO_RECORD.license,
      imageLicenseUrl: PHOTO_RECORD.licenseUrl,
      imageCredit: PHOTO_RECORD.credit,
      imageProvider: PHOTO_RECORD.provider,
      imageAuthor: PHOTO_RECORD.author,
      imageSourcePageUrl: PHOTO_RECORD.sourcePageUrl,
      imageCopyrightNotice: PHOTO_RECORD.copyrightNotice,
      imageAcquireLicensePage: PHOTO_RECORD.acquireLicensePage,
    };
    expect(verifyPublishedEventImages([event], [PHOTO_RECORD])).toEqual({ valid: true, errors: [] });
    expect(verifyPublishedEventImages([{ ...event, imageLicense: 'generated-provider' }], [PHOTO_RECORD]).valid).toBe(false);
  });

  it('rejects generated event fields that drift from the registry record', () => {
    const result = verifyPublishedEventImages([{
      id: 'event:drift',
      imageUrl: RECORD.imageUrl,
      imageAssetId: RECORD.assetId,
      imageLicense: RECORD.license,
      imageLicenseUrl: RECORD.licenseUrl,
      imageCredit: 'wrong-credit',
      imageProvider: RECORD.provider,
    }], [RECORD]);
    expect(result.valid).toBe(false);
    expect(result.errors.join('\n')).toContain('imageCredit does not match registry');
  });

  it('rejects an OpenAgenda image without per-image licence evidence', () => {
    const result = verifyPublishedEventImages([
      { id: 'openagenda:unlicensed', sourceKey: 'openagenda', imageUrl: '/images/events/openagenda-1.webp', imageCredit: 'Comune di Carouge' },
    ], []);
    expect(result.valid).toBe(false);
    expect(result.errors.join('\n')).toContain('outside the allowed source set');
  });

  it('rejects URLs from removed sources and unregistered generated assets', () => {
    const result = verifyPublishedEventImages([
      { id: 'bad:1', imageUrl: '/images/events/guidle-1.webp' },
      { id: 'bad:2', imageUrl: '/images/events/library/not-registered.webp' },
    ], []);
    expect(result.valid).toBe(false);
    expect(result.errors.join('\n')).toContain('removed source image URL');
    expect(result.errors.join('\n')).toContain('generated image has no valid record');
  });
});
