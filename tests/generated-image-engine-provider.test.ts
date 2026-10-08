// @vitest-environment node

import { describe, expect, it } from 'vitest';

import {
  extractGeminiImageData,
  extractFalImageData,
  extractPexelsPhoto,
  extractPixabayPhoto,
  extractTogetherImageData,
  articleHeroPhotoSearchQueries,
  formatProviderHttpError,
  imageProviderSequence,
  isPhotoCandidateRelevantToSpec,
  isPhotographicMetadata,
  isSuitableArticlePhotoCandidate,
  isSuitablePhotoCandidate,
  photoQuery,
  photoRecordCollision,
  photoSearchQueries,
  pixabayAuthorProfileUrl,
  selectDeterministicPhotoCandidate,
  providerConfiguration,
  verifyWikimediaExtmetadata,
} from '../packages/articles/engine/shared/generatedImageEngine.mjs';

describe('generated image provider contracts', () => {
  it('reads the image block from a completed Gemini Interactions response', () => {
    const encoded = Buffer.from('fake-jpeg-bytes').toString('base64');

    expect(extractGeminiImageData({
      id: 'interaction-1',
      status: 'completed',
      output_image: {
        type: 'image',
        mime_type: 'image/jpeg',
        data: encoded,
      },
    })).toBe(encoded);
  });

  it('keeps the step-content image shape as a compatible fallback', () => {
    const encoded = Buffer.from('step-image').toString('base64');

    expect(extractGeminiImageData({
      status: 'completed',
      steps: [{
        type: 'model_output',
        content: [{ type: 'image', mime_type: 'image/jpeg', data: encoded }],
      }],
    })).toBe(encoded);
  });

  it('includes a bounded, redacted provider body in HTTP diagnostics', () => {
    const message = formatProviderHttpError(
      'Gemini',
      400,
      '{"error":{"message":"image/png is not supported","api_key":"AIza-secret-value"}}',
    );

    expect(message).toContain('Gemini image request failed with HTTP 400');
    expect(message).toContain('image/png is not supported');
    expect(message).not.toContain('AIza-secret-value');
    expect(message.length).toBeLessThanOrEqual(650);
  });

  it('uses the governed generation chain with Codex first', () => {
    expect(imageProviderSequence()).toEqual(['openai-codex', 'gemini', 'fal', 'together', 'pollinations']);
    expect(imageProviderSequence({ scope: 'event-library' })).toEqual([
      'openai-codex', 'gemini', 'fal', 'together', 'pollinations', 'wikimedia', 'pexels', 'pixabay',
    ]);
    expect(imageProviderSequence({ scope: 'article-hero' })).toEqual([
      'openai-codex', 'gemini', 'fal', 'together', 'pollinations', 'wikimedia', 'pexels', 'pixabay',
    ]);
    expect(imageProviderSequence({ scope: 'editorial-profile' })).toEqual([
      'openai-codex', 'gemini', 'fal', 'together', 'pollinations',
    ]);
    expect(imageProviderSequence({ kind: 'photo' })).toEqual([
      'wikimedia', 'pexels', 'pixabay', 'openai-codex', 'gemini', 'fal', 'together', 'pollinations',
    ]);
    expect(imageProviderSequence({ chain: 'together, pollinations' })).toEqual(['together', 'pollinations']);
  });

  it('adapts the legacy article provider response shapes', () => {
    const encoded = Buffer.from('fake-image').toString('base64');
    expect(extractTogetherImageData({ data: [{ b64_json: encoded }] })).toBe(encoded);
    expect(extractFalImageData({ images: [{ url: 'https://fal.example/image.png' }] })).toBe('https://fal.example/image.png');
    expect(extractFalImageData({ images: [{ url: `data:image/png;base64,${encoded}` }] })).toBe(encoded);
    expect(extractPexelsPhoto({
      photos: [{
        photographer: 'Ada Foto',
        photographer_url: 'https://pexels.com/@ada',
        url: 'https://www.pexels.com/photo/lake-123/',
        width: 1600,
        height: 900,
        src: { large2x: 'https://images.pexels.com/photo.jpg' },
      }],
    })?.license).toBe('Pexels License');
    const pixabayPhoto = extractPixabayPhoto({
      hits: [{
        user: 'Ada Pixabay',
        user_id: 42,
        userImageURL: 'https://cdn.pixabay.com/user/avatar.jpeg',
        pageURL: 'https://pixabay.com/photos/lake-123/',
        imageWidth: 1600,
        imageHeight: 900,
        largeImageURL: 'https://cdn.pixabay.com/photo.jpg',
      }],
    });
    expect(pixabayPhoto?.license).toBe('Pixabay Content License');
    expect(pixabayPhoto?.author).toEqual({
      name: 'Ada Pixabay',
      url: 'https://pixabay.com/users/Ada%20Pixabay-42/',
    });
  });

  it('builds a Pixabay profile URL only when both API identity fields exist', () => {
    expect(pixabayAuthorProfileUrl({ user: 'GPhotography', user_id: 19753942 })).toBe(
      'https://pixabay.com/users/GPhotography-19753942/',
    );
    expect(pixabayAuthorProfileUrl({ user: 'GPhotography' })).toBeUndefined();
    expect(pixabayAuthorProfileUrl({ user_id: 19753942 })).toBeUndefined();
  });

  it('accepts only a Wikimedia file with verified allowed extmetadata', () => {
    const page = {
      fullurl: 'https://commons.wikimedia.org/wiki/File:Lago.jpg',
      imageinfo: [{
        mime: 'image/jpeg',
        width: 1600,
        height: 900,
        thumburl: 'https://upload.wikimedia.org/lake.jpg',
        extmetadata: {
          LicenseShortName: { value: 'CC BY-SA 4.0' },
          LicenseUrl: { value: 'https://creativecommons.org/licenses/by-sa/4.0/' },
          Artist: { value: 'Ada Wikimedia' },
        },
      }],
    };
    expect(verifyWikimediaExtmetadata(page)?.licenseFamily).toBe('cc-by-sa');
    expect(verifyWikimediaExtmetadata({ ...page, imageinfo: [{ ...page.imageinfo[0], extmetadata: {} }] })).toBeNull();
    expect(verifyWikimediaExtmetadata({ ...page, imageinfo: [{ ...page.imageinfo[0], extmetadata: { LicenseShortName: { value: 'CC BY-NC' }, Artist: { value: 'Ada' } } }] })).toBeNull();
  });

  it('composes category, Swiss place and season queries from the slot taxonomy', () => {
    const queries = photoSearchQueries({
      category: 'musica',
      area: 'svizzera-urbana',
      season: 'autunno-inverno',
    });

    expect(queries[0]).toContain('live music concert');
    expect(queries[0]).toContain('Zurich Switzerland');
    expect(queries[0]).toContain('autumn winter');
    expect(queries.some((query) => query.includes('Bern Switzerland'))).toBe(true);
    expect(queries).not.toContain('Lugano city view');
    expect(photoQuery({ category: 'musica', area: 'svizzera-urbana', season: 'autunno-inverno' })).toBe(queries[0]);
  });

  it('builds article-hero queries from topic, place and keywords in English', () => {
    const spec = {
      scope: 'article-hero',
      title: 'Tasse e lavoro a Zurigo',
      topic: 'tassazione e occupazione',
      place: 'Zurigo, Svizzera',
      keywords: ['credito fiscale'],
    };
    const queries = articleHeroPhotoSearchQueries(spec);
    expect(queries[0]).toContain('taxation');
    expect(queries[0]).toContain('Zurich');
    expect(queries[0]).toContain('Switzerland');
    expect(queries.some((query) => query.includes('employment'))).toBe(true);
    expect(photoSearchQueries(spec)).toEqual(queries);
  });

  it('selects a stable candidate while excluding used source pages and hashes', () => {
    const spec = {
      scope: 'event-library',
      assetId: 'event-musica-laghi-primavera-estate-v02',
      category: 'musica',
      area: 'laghi',
      season: 'primavera-estate',
      variant: '02',
    };
    const candidates = [
      { type: 'photo', title: 'Lake Zurich', sourcePageUrl: 'https://photos.example/used-hash', width: 2400, height: 1600, sha256: 'a'.repeat(64) },
      { type: 'photo', title: 'Lake Zurich', sourcePageUrl: 'https://photos.example/used-page', width: 2400, height: 1600, sha256: 'b'.repeat(64) },
      { type: 'photo', title: 'Lake Zurich', sourcePageUrl: 'https://photos.example/keep-a', width: 2400, height: 1600, sha256: 'c'.repeat(64) },
      { type: 'photo', title: 'Lake Zurich', sourcePageUrl: 'https://photos.example/keep-b', width: 2400, height: 1600, sha256: 'd'.repeat(64) },
    ];
    const usedRecords = [{
      scope: 'event-library',
      sourcePageUrl: 'https://photos.example/used-page',
      sha256: 'a'.repeat(64),
      assetId: 'event-used',
    }];

    const first = selectDeterministicPhotoCandidate(spec, candidates, { usedRecords });
    const second = selectDeterministicPhotoCandidate(spec, [...candidates].reverse(), { usedRecords });
    expect(first).toEqual(second);
    expect(['https://photos.example/keep-a', 'https://photos.example/keep-b']).toContain(first?.sourcePageUrl);
    expect(isSuitablePhotoCandidate(first)).toBe(true);
  });

  it('rejects non-photographs and unsuitable source dimensions before download', () => {
    expect(isPhotographicMetadata('William Callow painting of Lake Lugano')).toBe(false);
    expect(isSuitablePhotoCandidate({ type: 'illustration', sourcePageUrl: 'https://example/illustration', width: 3000, height: 2000 })).toBe(false);
    expect(isSuitablePhotoCandidate({ type: 'photo', sourcePageUrl: 'https://example/small', width: 1599, height: 1200 })).toBe(false);
    expect(isSuitablePhotoCandidate({ type: 'photo', sourcePageUrl: 'https://example/portrait', width: 1600, height: 2000 })).toBe(false);
    expect(isSuitablePhotoCandidate({ type: 'photo', sourcePageUrl: 'https://example/painting', title: 'oil painting', width: 2400, height: 1600 })).toBe(false);
    expect(isSuitablePhotoCandidate({ type: 'photo', sourcePageUrl: 'https://example/photo', width: 2400, height: 1600 })).toBe(true);
  });

  it('keeps photo candidates geographically relevant to the slot area', () => {
    expect(isPhotoCandidateRelevantToSpec(
      { area: 'svizzera-urbana' },
      { title: 'Zurich live concert, Switzerland', width: 2400, height: 1600 },
    )).toBe(true);
    expect(isPhotoCandidateRelevantToSpec(
      { area: 'svizzera-urbana' },
      { title: 'Mykonos finale live set, Greece', width: 6240, height: 4160 },
    )).toBe(false);
    expect(isPhotoCandidateRelevantToSpec(
      { area: 'laghi' },
      { title: 'Lake Tahoe', width: 2400, height: 1600 },
    )).toBe(false);
    expect(isPhotoCandidateRelevantToSpec(
      { area: 'laghi' },
      { title: '', width: 2400, height: 1600 },
    )).toBe(false);
  });

  it('requires article photos to match the topic and rejects branded or written candidates', () => {
    const spec = {
      scope: 'article-hero',
      title: 'Tasse e lavoro a Zurigo',
      topic: 'tassazione e occupazione',
      place: 'Zurigo, Svizzera',
    };
    expect(isPhotoCandidateRelevantToSpec(spec, {
      title: 'Tax and employment office in Zurich Switzerland',
      width: 2400,
      height: 1600,
    })).toBe(true);
    expect(isPhotoCandidateRelevantToSpec(spec, {
      title: 'Swiss Alps landscape',
      width: 6240,
      height: 4160,
    })).toBe(false);
    expect(isPhotoCandidateRelevantToSpec({
      scope: 'article-hero',
      title: 'Guida per frontalieri in Ticino',
      place: 'Ticino, Svizzera',
      keywords: ['Ticino', 'Svizzera'],
    }, {
      title: 'Ticino mountain landscape Switzerland',
      width: 6240,
      height: 4160,
    })).toBe(false);
    expect(isPhotoCandidateRelevantToSpec({
      scope: 'article-hero',
      title: 'Turismo in Valposchiavo',
      topic: 'turismo',
      place: 'Valposchiavo, Svizzera',
    }, {
      title: 'Cevio village in Ticino Switzerland',
      width: 6240,
      height: 4160,
    })).toBe(false);
    expect(isSuitableArticlePhotoCandidate(spec, {
      type: 'photo',
      title: 'Zurich employment brand logo with text overlay',
      width: 2400,
      height: 1600,
    })).toBe(false);
  });

  it('exposes the persistence collision guard for an existing photo scope', () => {
    const record = { kind: 'photo', scope: 'event-library', sourcePageUrl: 'https://example/photo', sha256: 'c'.repeat(64) };
    expect(photoRecordCollision(record, [{ ...record, assetId: 'already-used' }])).toMatchObject({
      type: 'sourcePageUrl',
      assetId: 'already-used',
    });
    expect(photoRecordCollision({ ...record, sourcePageUrl: 'https://example/other' }, [{ ...record, assetId: 'already-used' }])).toMatchObject({
      type: 'sha256',
      assetId: 'already-used',
    });
  });

  it('rejects Wikimedia paintings and source images below the landscape floor', () => {
    const base = {
      fullurl: 'https://commons.wikimedia.org/wiki/File:Lago.jpg',
      imageinfo: [{
        mime: 'image/jpeg',
        width: 2400,
        height: 1600,
        thumburl: 'https://upload.wikimedia.org/lake.jpg',
        extmetadata: {
          LicenseShortName: { value: 'CC BY-SA 4.0' },
          LicenseUrl: { value: 'https://creativecommons.org/licenses/by-sa/4.0/' },
          Artist: { value: 'Ada Wikimedia' },
        },
      }],
    };
    expect(verifyWikimediaExtmetadata({ ...base, title: 'File:Lake painting.jpg' })).toBeNull();
    expect(verifyWikimediaExtmetadata({
      ...base,
      imageinfo: [{ ...base.imageinfo[0], width: 1200, height: 900 }],
    })).toBeNull();
  });

  it('derives the Commons file page URL when the search response omits fullurl', () => {
    const page = {
      title: 'File:Lugano panorama.jpg',
      imageinfo: [{
        width: 1600,
        height: 900,
        mime: 'image/jpeg',
        thumburl: 'https://upload.wikimedia.org/lugano.jpg',
        extmetadata: {
          LicenseShortName: { value: 'CC BY-SA 4.0' },
          Artist: { value: 'Ada Wikimedia' },
        },
      }],
    };

    expect(verifyWikimediaExtmetadata(page)?.sourcePageUrl).toBe(
      'https://commons.wikimedia.org/wiki/File:Lugano_panorama.jpg',
    );
  });

  it('reports missing credentials without exposing values', () => {
    expect(providerConfiguration('fal', {})).toEqual({ configured: false, reason: 'missing-key:FAL_KEY' });
    expect(providerConfiguration('pollinations', {})).toEqual({ configured: false, reason: 'missing-key:POLLINATIONS_API_KEY' });
  });
});
