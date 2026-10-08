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
    is_photograph: false,
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
  sourceWidth: 2400,
  sourceHeight: 1600,
  copyrightNotice: '© Ada Wikimedia',
  acquireLicensePage: 'https://commons.wikimedia.org/wiki/File:Lago.jpg',
  modifications: ['cropped', 'resized', 'converted-to-webp'],
  restrictions: [...LICENSED_PHOTO_RESTRICTIONS],
  vision: {
    ok: true,
    contains_text: true,
    contains_logo: false,
    contains_recognizable_face: false,
    looks_like_specific_real_event: false,
    is_photograph: true,
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
    const articlePhoto = {
      ...PHOTO_RECORD,
      assetId: 'article-hero-photo',
      scope: 'article-hero',
      imageUrl: '/images/blog/article-hero-photo.webp',
      vision: {
        ...PHOTO_RECORD.vision,
        contains_text: false,
        contains_recognizable_foreground_person: false,
        is_topic_relevant: true,
      },
    };
    expect(validateGeneratedImageRecord(articlePhoto)).toEqual({ valid: true, errors: [] });
    expect(validateGeneratedImageRecord({
      ...articlePhoto,
      vision: { ...articlePhoto.vision, contains_recognizable_foreground_person: true },
    }).valid).toBe(false);
    expect(validateGeneratedImageRecord({
      ...articlePhoto,
      vision: { ...articlePhoto.vision, is_topic_relevant: false },
    }).valid).toBe(false);
    expect(validateGeneratedImageRecord({ ...PHOTO_RECORD, license: '' }).valid).toBe(false);
    expect(validateGeneratedImageRecord({ ...PHOTO_RECORD, author: undefined }).valid).toBe(false);
    const imageAuthorUrl = validateGeneratedImageRecord({
      ...PHOTO_RECORD,
      author: { name: 'Ada Wikimedia', url: 'https://cdn.example.test/ada.jpeg' },
    });
    expect(imageAuthorUrl.valid).toBe(false);
    expect(imageAuthorUrl.errors).toContain('photo author.url must not point to an image file');
    expect(validateGeneratedImageRecord({
      ...PHOTO_RECORD,
      vision: { ...PHOTO_RECORD.vision, contains_recognizable_face: true },
    }).valid).toBe(false);

    const pexelsRecord = validateGeneratedImageRecord({
      ...PHOTO_RECORD,
      provider: 'pexels',
      license: 'Pexels License',
      licenseFamily: 'pexels',
      licenseUrl: 'https://www.pexels.com/license/',
      author: { name: 'Ada Pexels', url: 'https://www.pexels.com/@ada' },
      sourcePageUrl: 'https://www.pexels.com/photo/lago-123/',
    });
    expect(pexelsRecord.valid).toBe(true);
    expect(validateGeneratedImageRecord({
      ...PHOTO_RECORD,
      provider: 'pexels',
      license: 'Pexels License',
      licenseFamily: 'pexels',
      licenseUrl: 'https://www.pexels.com/license/',
      author: { name: 'Ada Pexels', url: 'https://example.test/@ada' },
      sourcePageUrl: 'https://www.pexels.com/photo/lago-123/',
    }).errors).toContain('pexels author.url must use the pexels domain');

    const pixabayRecord = validateGeneratedImageRecord({
      ...PHOTO_RECORD,
      provider: 'pixabay',
      license: 'Pixabay Content License',
      licenseFamily: 'pixabay',
      licenseUrl: 'https://pixabay.com/service/license-summary/',
      author: { name: 'Ada Pixabay', url: 'https://pixabay.com/users/Ada-42/' },
      sourcePageUrl: 'https://pixabay.com/photos/lago-123/',
    });
    expect(pixabayRecord.valid).toBe(true);
    expect(validateGeneratedImageRecord({
      ...PHOTO_RECORD,
      provider: 'pixabay',
      license: 'Pixabay Content License',
      licenseFamily: 'pixabay',
      licenseUrl: 'https://pixabay.com/service/license-summary/',
      author: { name: 'Ada Pixabay', url: 'https://cdn.pixabay.com/user/avatar' },
      sourcePageUrl: 'https://pixabay.com/photos/lago-123/',
    }).errors).toContain('pixabay author.url must use the pixabay domain');
    expect(validateGeneratedImageRecord({ ...PHOTO_RECORD, modifications: undefined }).valid).toBe(false);
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
      imageModifications: PHOTO_RECORD.modifications,
    };
    expect(verifyPublishedEventImages([event], [PHOTO_RECORD])).toEqual({ valid: true, errors: [] });
    expect(verifyPublishedEventImages([{ ...event, imageLicense: 'generated-provider' }], [PHOTO_RECORD]).valid).toBe(false);
    expect(verifyPublishedEventImages([{ ...event, imageModifications: undefined }], [PHOTO_RECORD]).valid).toBe(false);
  });

  it('fails the registry gate when a scope reuses a photo hash or source page', () => {
    const duplicateHash = {
      ...PHOTO_RECORD,
      assetId: 'event-lago-laghi-primavera-v03',
      imageUrl: '/images/events/library/event-lago-laghi-primavera-v03.webp',
      sourcePageUrl: 'https://commons.wikimedia.org/wiki/File:Another-Lago.jpg',
    };
    const duplicateSource = {
      ...PHOTO_RECORD,
      assetId: 'event-lago-laghi-primavera-v04',
      imageUrl: '/images/events/library/event-lago-laghi-primavera-v04.webp',
      sha256: '2'.repeat(64),
    };
    const result = validateGeneratedImageRegistry({
      schema: 1,
      libraryVersion: '2026-10-07',
      cdnPrefix: '/images/events/library/',
      assetCount: 3,
      assets: [PHOTO_RECORD, duplicateHash, duplicateSource],
    }, { scope: 'event-library' });
    expect(result.valid).toBe(false);
    expect(result.errors.join('\n')).toContain('duplicate sha256');
    expect(result.errors.join('\n')).toContain('duplicate sourcePageUrl');
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
